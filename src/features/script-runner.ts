// Runs a discovered deploy script and streams its output.
//
//   Foundry  → `forge script <relPath>:<Contract> --broadcast --rpc-url <url>
//                --private-key <pk>` (or --account <name> --password-file <f>)
//   Hardhat  → `npx hardhat run <relPath> --network <name>` (or default network)
//
// We parse stdout for newly-deployed contract addresses so the panel can
// surface them in the tx log just like a manual deploy.

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ScriptEntry } from './script-discovery';

export interface RunScriptOptions {
  script: ScriptEntry;
  /** RPC URL of the network we're running against. */
  rpcUrl: string;
  /** Display name of the network for logging. */
  networkLabel: string;
  /** Hardhat-only — the --network flag value (e.g. "sepolia"). Optional. */
  hardhatNetwork?: string;
  /** Signer source — used to choose the right CLI flag. */
  signer:
    | { kind: 'privateKey'; privateKey: string }
    | { kind: 'keystore'; name: string; password: string }
    | { kind: 'none' }; // hardhat scripts may use the hardhat config's own accounts
  /** Stream each output line back to the caller. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Wall-clock cap, defaults to 10 minutes. */
  timeoutMs?: number;
}

export interface RunScriptResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  errorMessage?: string;
  /** Parsed `Contract Deployed` / `Deployed to` matches from output. */
  deployedContracts: Array<{ name?: string; address: string }>;
  /** Parsed transaction hashes from output. */
  txHashes: string[];
}

const DEFAULT_TIMEOUT = 10 * 60 * 1000;
const PER_RPC_TIMEOUT_MS = 60_000;
void PER_RPC_TIMEOUT_MS;

// Regexes for parsing forge/hardhat output.
//   forge script: "Contract Address: 0x..." and "Hash: 0x..."
//   forge create: "Deployed to: 0x..."
//   hardhat:      "deployed to: 0x..." (varies by script — we accept any 0x40hex
//                 prefixed by phrases like "deployed", "address", "contract")
const ADDR_RE = /(?:deployed(?:\s+to)?|contract\s+address|address)\s*[:=]\s*(0x[a-fA-F0-9]{40})\b/gi;
const HASH_RE = /(?:hash|tx\s+hash|transaction\s+hash)\s*[:=]\s*(0x[a-fA-F0-9]{64})\b/gi;

function parseDeployedContracts(line: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  ADDR_RE.lastIndex = 0;
  while ((m = ADDR_RE.exec(line)) !== null) out.push(m[1]);
  return out;
}

function parseTxHashes(line: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  HASH_RE.lastIndex = 0;
  while ((m = HASH_RE.exec(line)) !== null) out.push(m[1]);
  return out;
}

/** Write the keystore password to a tempfile with mode 0600 so we can pass
 *  `--password-file` to forge without leaking via argv. Caller is responsible
 *  for deleting it; we wrap the spawn in a try/finally below. */
function writePasswordFile(pwd: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '0xtools-pw-'));
  const file = path.join(dir, 'pw');
  fs.writeFileSync(file, pwd, { mode: 0o600 });
  return file;
}

function cleanupPasswordFile(p: string | undefined): void {
  if (!p) return;
  try {
    fs.unlinkSync(p);
    fs.rmdirSync(path.dirname(p));
  } catch {
    /* best-effort */
  }
}

interface CommandSpec {
  cmd: string;
  args: string[];
  passwordFile?: string;
}

function buildCommand(opts: RunScriptOptions): CommandSpec {
  const { script, rpcUrl, signer } = opts;
  if (script.kind === 'foundry') {
    if (!script.foundryTarget) {
      throw new Error('foundry script is missing its target — re-discover scripts');
    }
    const args = ['script', script.foundryTarget, '--rpc-url', rpcUrl, '--broadcast'];
    if (signer.kind === 'privateKey') {
      args.push('--private-key', signer.privateKey);
      return { cmd: 'forge', args };
    }
    if (signer.kind === 'keystore') {
      const passwordFile = writePasswordFile(signer.password);
      args.push('--account', signer.name, '--password-file', passwordFile);
      return { cmd: 'forge', args, passwordFile };
    }
    throw new Error('foundry scripts require a private key or keystore — select an account');
  }
  // Hardhat
  const args = ['hardhat', 'run', script.relPath];
  if (opts.hardhatNetwork) args.push('--network', opts.hardhatNetwork);
  return { cmd: 'npx', args };
}

export async function runScript(opts: RunScriptOptions): Promise<RunScriptResult> {
  const result: RunScriptResult = {
    ok: false,
    exitCode: null,
    durationMs: 0,
    deployedContracts: [],
    txHashes: [],
  };

  let spec: CommandSpec;
  try {
    spec = buildCommand(opts);
  } catch (err) {
    result.errorMessage = err instanceof Error ? err.message : String(err);
    return result;
  }

  const started = Date.now();

  return new Promise<RunScriptResult>((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(spec.cmd, spec.args, {
        cwd: opts.script.projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      });
    } catch (err) {
      cleanupPasswordFile(spec.passwordFile);
      result.errorMessage = `failed to spawn ${spec.cmd}: ${err instanceof Error ? err.message : err}`;
      result.durationMs = Date.now() - started;
      resolve(result);
      return;
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }, 5000);
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT);

    function emitLines(buf: string, stream: 'stdout' | 'stderr'): string {
      const lines = buf.split('\n');
      const remainder = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length === 0) continue;
        opts.onLine?.(line, stream);
        for (const addr of parseDeployedContracts(line)) {
          if (!result.deployedContracts.find((c) => c.address.toLowerCase() === addr.toLowerCase())) {
            result.deployedContracts.push({ address: addr });
          }
        }
        for (const h of parseTxHashes(line)) {
          if (!result.txHashes.includes(h)) result.txHashes.push(h);
        }
      }
      return remainder;
    }

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      stdoutBuf = emitLines(stdoutBuf, 'stdout');
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      stderrBuf = emitLines(stderrBuf, 'stderr');
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      cleanupPasswordFile(spec.passwordFile);
      result.errorMessage = `process error: ${err.message}`;
      result.durationMs = Date.now() - started;
      resolve(result);
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      cleanupPasswordFile(spec.passwordFile);
      if (stdoutBuf.length > 0) opts.onLine?.(stdoutBuf, 'stdout');
      if (stderrBuf.length > 0) opts.onLine?.(stderrBuf, 'stderr');
      result.exitCode = code;
      result.durationMs = Date.now() - started;
      if (timedOut) {
        result.errorMessage = 'script timed out';
        resolve(result);
        return;
      }
      result.ok = code === 0;
      if (!result.ok) {
        result.errorMessage = `${spec.cmd} ${spec.args[0]} exited with code ${code}`;
      }
      void opts.networkLabel; // currently unused but kept in API for logging
      resolve(result);
    });
  });
}
