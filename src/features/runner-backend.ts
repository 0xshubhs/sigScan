/**
 * Runner Backend - Uses `sigscan-runner` Rust binary for gas estimation
 *
 * Spawns the sigscan-runner binary which compiles the .sol file, deploys it
 * in an in-memory EVM (revm), executes every function, and returns real
 * gas numbers as JSON. The extension then merges this with regex-parsed
 * source locations to produce GasInfo[] for inline decorations.
 *
 * This is the primary backend — fastest and most accurate since it uses
 * actual EVM execution rather than compiler estimates.
 */

import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { keccak256 } from 'js-sha3';
import { GasInfo, CompilationOutput } from './SolcManager';

// ---------------------------------------------------------------------------
// Runner JSON types (matches runner/src/types.rs)
// ---------------------------------------------------------------------------

interface RunnerFunctionReport {
  name: string;
  selector: string;
  signature: string;
  gas: number;
  status: 'success' | 'revert' | 'halt';
}

interface RunnerContractReport {
  contract: string;
  functions: RunnerFunctionReport[];
}

// ---------------------------------------------------------------------------
// Session-level cache for runner availability
// ---------------------------------------------------------------------------

let runnerAvailableCache: boolean | null = null;
let runnerPathCache: string | null = null;

/**
 * Check if `sigscan-runner` is available.
 * Result is cached for the lifetime of the process.
 */
export async function isRunnerAvailable(): Promise<boolean> {
  if (runnerAvailableCache !== null) {
    return runnerAvailableCache;
  }

  const runnerPath = discoverRunnerPath();
  if (!runnerPath) {
    runnerAvailableCache = false;
    return false;
  }

  return new Promise((resolve) => {
    execFile(runnerPath, ['--help'], { timeout: 5000 }, (err) => {
      if (err) {
        runnerAvailableCache = false;
        resolve(false);
        return;
      }
      runnerAvailableCache = true;
      runnerPathCache = runnerPath;
      resolve(true);
    });
  });
}

/**
 * Reset the runner availability cache (useful for testing).
 */
export function resetRunnerCache(): void {
  runnerAvailableCache = null;
  runnerPathCache = null;
}

// ---------------------------------------------------------------------------
// Binary discovery
// ---------------------------------------------------------------------------

/**
 * Discover the sigscan-runner binary path.
 *
 * Search order:
 * 1. VS Code setting sigscan.runnerBinaryPath (if set)
 * 2. Extension bundled binary (bin/sigscan-runner)
 * 3. System PATH (sigscan-runner)
 * 4. Development fallback (runner/target/release/sigscan-runner)
 */
function discoverRunnerPath(): string | null {
  const binName = process.platform === 'win32' ? 'sigscan-runner.exe' : 'sigscan-runner';

  // 1. User-configured path + 2. Extension bundled binary
  try {
    // Try to load vscode — may not be available in CLI/test context
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode');
    const configPath: string = vscode.workspace
      .getConfiguration('sigscan')
      .get('runnerBinaryPath', '');
    if (configPath && fs.existsSync(configPath)) {
      return configPath;
    }

    const ext = vscode.extensions.getExtension('sigscan.sigscan');
    if (ext) {
      const bundledPath = path.join(ext.extensionPath, 'bin', binName);
      if (fs.existsSync(bundledPath)) {
        return bundledPath;
      }
    }
  } catch {
    // vscode not available (CLI/test context) — skip
  }

  // 3. System PATH — check with `which` / `where`
  const pathBinary = findOnPath(binName);
  if (pathBinary) {
    return pathBinary;
  }

  // 4. Development fallback — look relative to this file's location
  // Walk up from src/features/ to project root, then check runner/target/release/
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'runner', 'target', 'release', binName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    dir = path.dirname(dir);
  }

  return null;
}

/**
 * Look for a binary on the system PATH.
 */
function findOnPath(binName: string): string | null {
  const pathEnv = process.env.PATH || '';
  const separator = process.platform === 'win32' ? ';' : ':';
  const dirs = pathEnv.split(separator);

  for (const dir of dirs) {
    const candidate = path.join(dir, binName);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not found or not executable
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main compilation entry point
// ---------------------------------------------------------------------------

/**
 * Compile and execute a .sol file using sigscan-runner.
 *
 * Spawns the runner binary, parses its JSON output, merges with
 * regex-parsed source locations, and returns a CompilationOutput.
 */
export async function compileWithRunner(
  filePath: string,
  source: string
): Promise<CompilationOutput> {
  const runnerPath = runnerPathCache || discoverRunnerPath();
  if (!runnerPath) {
    throw new Error('sigscan-runner binary not found');
  }

  try {
    const { stdout, stderr } = await spawnRunner(runnerPath, filePath);

    // Parse runner JSON output
    const reports: RunnerContractReport[] = JSON.parse(stdout);

    // Regex-parse the source for line locations, visibility, state mutability
    const sourceMeta = extractFunctionMetadata(source);

    // Merge runner gas data with source metadata
    const gasInfo: GasInfo[] = [];

    for (const report of reports) {
      for (const func of report.functions) {
        const meta = sourceMeta.get(func.name);

        const warnings: string[] = [];
        let gas: number | 'infinite' = func.gas;

        if (func.status === 'revert') {
          warnings.push('Function reverted with default arguments');
        } else if (func.status === 'halt') {
          gas = 'infinite';
          warnings.push('Execution halted - possible unbounded gas');
        }

        gasInfo.push({
          name: func.name,
          selector: func.selector,
          gas,
          loc: meta?.loc || { line: 0, endLine: 0 },
          visibility: meta?.visibility || 'external',
          stateMutability: meta?.stateMutability || 'nonpayable',
          warnings,
        });
      }
    }

    // Log any runner stderr warnings
    if (stderr.trim()) {
      // stderr has diagnostic info — not an error
    }

    return {
      success: true,
      version: 'runner',
      gasInfo,
      errors: [],
      warnings: stderr.trim() ? [stderr.trim()] : [],
    };
  } catch (error) {
    // Runner failed — return fallback with regex-only extraction
    const errorMsg = error instanceof Error ? error.message : 'runner failed';
    return fallbackResult(filePath, source, errorMsg);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the sigscan-runner binary and capture its output.
 */
function spawnRunner(
  runnerPath: string,
  filePath: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      runnerPath,
      [filePath],
      { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`sigscan-runner failed: ${stderr || err.message}`));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

/**
 * Extract function metadata from Solidity source using regex.
 *
 * Returns a map of functionName → { loc, visibility, stateMutability, selector }.
 */
function extractFunctionMetadata(source: string): Map<
  string,
  {
    loc: { line: number; endLine: number };
    visibility: string;
    stateMutability: string;
    selector: string;
  }
> {
  const result = new Map<
    string,
    {
      loc: { line: number; endLine: number };
      visibility: string;
      stateMutability: string;
      selector: string;
    }
  >();

  const lines = source.split('\n');
  const lineOffsets: number[] = [0];
  for (let i = 0; i < lines.length; i++) {
    lineOffsets.push(lineOffsets[i] + lines[i].length + 1);
  }

  function offsetToLine(offset: number): number {
    for (let i = 0; i < lineOffsets.length - 1; i++) {
      if (offset >= lineOffsets[i] && offset < lineOffsets[i + 1]) {
        return i + 1;
      }
    }
    return lines.length;
  }

  const fnRegex =
    /function\s+(\w+)\s*\(([^)]*)\)\s*(public|external|internal|private)?\s*(pure|view|payable|nonpayable)?\s*(?:virtual)?\s*(?:override(?:\([^)]*\))?)?\s*(?:returns\s*\([^)]*\))?\s*[{;]/gs;

  let match;
  while ((match = fnRegex.exec(source)) !== null) {
    const [, name, paramsStr, visibility = 'internal', stateMutability = 'nonpayable'] = match;
    const startOffset = match.index;
    let endOffset = startOffset + match[0].length;

    // Track brace-matched end for functions with bodies
    if (match[0].endsWith('{')) {
      let braceCount = 1;
      let i = endOffset;
      while (i < source.length && braceCount > 0) {
        if (source[i] === '{') {
          braceCount++;
        } else if (source[i] === '}') {
          braceCount--;
        }
        i++;
      }
      endOffset = i;
    }

    // Compute selector from signature
    const params = paramsStr
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((param) => {
        const parts = param.split(/\s+/).filter((p) => p.length > 0);
        return parts[0] || 'unknown';
      });

    const signature = `${name}(${params.join(',')})`;
    const hash = keccak256(signature);
    const selector = '0x' + hash.substring(0, 8);

    // Only store the first occurrence (don't overwrite overloads)
    if (!result.has(name)) {
      result.set(name, {
        loc: {
          line: offsetToLine(startOffset),
          endLine: offsetToLine(endOffset),
        },
        visibility: visibility || 'internal',
        stateMutability: stateMutability || 'nonpayable',
        selector,
      });
    }
  }

  return result;
}

/**
 * Build a fallback CompilationOutput using regex extraction (selectors only, gas: 0).
 */
function fallbackResult(filePath: string, source: string, errorMessage: string): CompilationOutput {
  const src = source || (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '');
  const meta = extractFunctionMetadata(src);
  const gasInfo: GasInfo[] = [];

  for (const [name, data] of meta) {
    gasInfo.push({
      name,
      selector: data.selector,
      gas: 0,
      loc: data.loc,
      visibility: data.visibility,
      stateMutability: data.stateMutability,
      warnings: [`Gas unavailable - runner failed (${errorMessage})`],
    });
  }

  return {
    success: false,
    version: 'runner (fallback)',
    gasInfo,
    errors: [errorMessage],
    warnings: [],
  };
}
