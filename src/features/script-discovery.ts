// Discovers deploy/maintenance scripts in the workspace.
//
//   Foundry:  script/*.s.sol  (or any *.s.sol under script/)
//   Hardhat:  scripts/*.{ts,js}  + deploy/*.{ts,js}  (hardhat-deploy plugin)
//
// We return a flat list of ScriptEntry. The Deploy & Run panel renders these
// in their own section so users can run them without dropping to a terminal.

import * as fs from 'fs';
import * as path from 'path';
import { ProjectScanner, type SubProject } from '../core/scanner';

export type ScriptKind = 'foundry' | 'hardhat-ts' | 'hardhat-js';

export interface ScriptEntry {
  key: string;             // unique id: `${projectRoot}::${relPath}`
  /** Display name — basename without extension. */
  name: string;
  /** Absolute path on disk. */
  absPath: string;
  /** Path relative to the project root. */
  relPath: string;
  /** Subproject root. */
  projectRoot: string;
  projectType: 'foundry' | 'hardhat' | 'solidity';
  kind: ScriptKind;
  /** Foundry only — the contract name to pass to `forge script` (path:Name).
   *  For Hardhat we just point at the file. */
  foundryTarget?: string;
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'cache',
  'out',
  'artifacts',
  'typechain-types',
  'broadcast',
  '.deps',
  'build-info',
  'lib',
]);

function* walkFiles(dir: string, filter: (n: string) => boolean, maxFiles = 5_000): Generator<string> {
  let count = 0;
  const stack: string[] = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (IGNORED_DIRS.has(ent.name)) continue;
        stack.push(full);
      } else if (ent.isFile() && filter(ent.name)) {
        if (++count > maxFiles) return;
        yield full;
      }
    }
  }
}

function detectSubProjectType(p: string): SubProject['type'] {
  if (fs.existsSync(path.join(p, 'foundry.toml'))) return 'foundry';
  if (
    fs.existsSync(path.join(p, 'hardhat.config.js')) ||
    fs.existsSync(path.join(p, 'hardhat.config.ts'))
  ) {
    return 'hardhat';
  }
  return 'solidity';
}

// Extract the primary contract name from a *.s.sol file so we can construct
// the `path:Contract` target forge script expects. We grep the source rather
// than parse — fast and accurate enough; the heuristic matches the first
// `contract|abstract contract X` declaration that isn't an interface/library.
const SCRIPT_CONTRACT_RE = /^\s*(?:abstract\s+)?contract\s+([A-Za-z_][A-Za-z0-9_]*)/m;

function extractFoundryScriptName(absPath: string): string | undefined {
  try {
    const src = fs.readFileSync(absPath, 'utf8');
    const m = SCRIPT_CONTRACT_RE.exec(src);
    return m?.[1];
  } catch {
    return undefined;
  }
}

function discoverFoundryScripts(projectRoot: string): ScriptEntry[] {
  const dir = path.join(projectRoot, 'script');
  if (!fs.existsSync(dir)) return [];
  const out: ScriptEntry[] = [];
  for (const file of walkFiles(dir, (n) => n.endsWith('.s.sol'))) {
    const relPath = path.relative(projectRoot, file);
    const baseName = path.basename(file).replace(/\.s\.sol$/, '');
    const contractName = extractFoundryScriptName(file) ?? baseName;
    out.push({
      key: `${projectRoot}::${relPath}`,
      name: baseName,
      absPath: file,
      relPath,
      projectRoot,
      projectType: 'foundry',
      kind: 'foundry',
      foundryTarget: `${relPath}:${contractName}`,
    });
  }
  return out;
}

function discoverHardhatScripts(projectRoot: string): ScriptEntry[] {
  const out: ScriptEntry[] = [];
  // Standard `scripts/` directory used with `npx hardhat run`.
  for (const sub of ['scripts', 'deploy']) {
    const dir = path.join(projectRoot, sub);
    if (!fs.existsSync(dir)) continue;
    for (const file of walkFiles(dir, (n) => n.endsWith('.ts') || n.endsWith('.js'))) {
      // Skip dotfiles and tests inside the same dirs
      const base = path.basename(file);
      if (base.startsWith('.')) continue;
      if (base.endsWith('.test.ts') || base.endsWith('.test.js')) continue;
      if (base.endsWith('.spec.ts') || base.endsWith('.spec.js')) continue;
      const relPath = path.relative(projectRoot, file);
      const kind: ScriptKind = file.endsWith('.ts') ? 'hardhat-ts' : 'hardhat-js';
      out.push({
        key: `${projectRoot}::${relPath}`,
        name: base.replace(/\.(ts|js)$/, ''),
        absPath: file,
        relPath,
        projectRoot,
        projectType: 'hardhat',
        kind,
      });
    }
  }
  return out;
}

/** Discover all deploy scripts in the workspace, mirroring how contract-discovery walks. */
export async function discoverScripts(workspaceRoot: string): Promise<ScriptEntry[]> {
  const scanner = new ProjectScanner();
  let subProjects: SubProject[];
  try {
    subProjects = await scanner.findAllSubProjects(workspaceRoot);
  } catch {
    subProjects = [];
  }
  if (subProjects.length === 0) {
    subProjects = [{ path: workspaceRoot, type: detectSubProjectType(workspaceRoot) }];
  }

  const out: ScriptEntry[] = [];
  for (const sub of subProjects) {
    const projectType = sub.type === 'solidity' ? detectSubProjectType(sub.path) : sub.type;
    if (projectType === 'foundry') {
      out.push(...discoverFoundryScripts(sub.path));
    } else if (projectType === 'hardhat') {
      out.push(...discoverHardhatScripts(sub.path));
    } else {
      // Loose Solidity layouts sometimes have both — surface either.
      out.push(...discoverFoundryScripts(sub.path));
      out.push(...discoverHardhatScripts(sub.path));
    }
  }
  return out;
}
