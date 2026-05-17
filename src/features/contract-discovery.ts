// Discovers Solidity contracts across the workspace, mirroring how
// ProjectScanner does it for signatures and gas analysis.
//
// Returns *every* source contract (recursively under src/, contracts/, lib/),
// paired with its build artifact when one exists. Source-only contracts are
// returned with buildState='not-built' so the panel can offer a Build action.

import * as fs from 'fs';
import * as path from 'path';
import { ProjectScanner, type SubProject } from '../core/scanner';
import type { AbiEntry } from './remix-port/tx-helper';

export type BuildState = 'not-built' | 'building' | 'built' | 'failed';

export interface DiscoveredContract {
  key: string;                 // unique id: `${projectRoot}::${sourcePath}:${name}`
  name: string;                // contract name
  file: string;                // source basename
  sourcePath: string;          // relative to projectRoot, e.g. "src/Counter.sol"
  projectRoot: string;         // absolute path of the (sub)project root
  projectType: 'foundry' | 'hardhat' | 'solidity';
  artifactPath?: string;       // absolute path of the JSON artifact when built
  abi?: AbiEntry[];
  bytecode?: string;           // 0x-prefixed
  deployedBytecode?: string;
  buildState: BuildState;
  lastError?: string;
}

interface ArtifactInfo {
  name: string;
  sourcePath: string;          // relative to projectRoot
  artifactPath: string;
  abi: AbiEntry[];
  bytecode: string;
  deployedBytecode?: string;
}

interface SourceEntry {
  name: string;
  sourcePath: string;
}

interface FoundryArtifact {
  abi: AbiEntry[];
  bytecode?: { object?: string };
  deployedBytecode?: { object?: string };
  metadata?: { settings?: { compilationTarget?: Record<string, string> } };
  ast?: { absolutePath?: string };
}

interface HardhatArtifact {
  contractName: string;
  sourceName: string;
  abi: AbiEntry[];
  bytecode: string;
  deployedBytecode?: string;
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
]);

function ensureHex(bc: string | undefined): string {
  if (!bc) return '0x';
  return bc.startsWith('0x') ? bc : '0x' + bc;
}

function* walkFiles(
  dir: string,
  filter: (filename: string) => boolean,
  maxFiles = 10_000
): Generator<string> {
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

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

function isLikelyContractAbi(abi: AbiEntry[] | undefined): boolean {
  if (!abi || !Array.isArray(abi)) return false;
  return abi.some((e) => e.type === 'function' || e.type === 'event' || e.type === 'error');
}

// ─── Source-side discovery (mirrors ProjectScanner) ──────────────────────

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

function contractDirsFor(projectRoot: string, projectType: SubProject['type']): string[] {
  // Mirror Remix's behaviour: only show *user* contracts.
  //   - Foundry → `src/` (deliberately exclude `lib/` — that's `forge install` deps)
  //   - Hardhat → `contracts/`
  //   - Loose-Solidity → both, whichever exists
  // A user with non-standard layout can drop their sources under one of these and
  // it'll be picked up; everything else is treated as a dependency.
  const candidates =
    projectType === 'foundry'
      ? ['src', 'contracts']
      : projectType === 'hardhat'
        ? ['contracts']
        : ['src', 'contracts'];
  return candidates.filter((d) => fs.existsSync(path.join(projectRoot, d)));
}

/**
 * Returns true if a sourcePath belongs to user code (vs an installed dependency
 * like `lib/forge-std/...` or `node_modules/@openzeppelin/...`).
 *
 *   foundry → must start with `src/` (or `contracts/` for the rare hybrid layout)
 *   hardhat → must start with `contracts/`
 *   loose   → must start with `src/` or `contracts/`
 *
 * Anything under `lib/`, `node_modules/`, `test/`, `script/`, `forge-std/`, etc.
 * is excluded.
 */
function isUserContractPath(projectType: SubProject['type'], sourcePath: string): boolean {
  if (!sourcePath) return false;
  const norm = sourcePath.replace(/\\/g, '/');
  if (norm.startsWith('lib/') || norm.includes('/lib/')) return false;
  if (norm.startsWith('node_modules/')) return false;
  if (norm.startsWith('test/') || norm.includes('/test/')) return false;
  if (norm.startsWith('script/') || norm.includes('/script/')) return false;
  if (/\.t\.sol$/.test(norm) || /\.s\.sol$/.test(norm)) return false;
  const allowed = projectType === 'hardhat'
    ? ['contracts/']
    : projectType === 'foundry'
      ? ['src/', 'contracts/']
      : ['src/', 'contracts/'];
  return allowed.some((prefix) => norm.startsWith(prefix));
}

// Lightweight per-file Solidity contract-name extractor. We don't need the full
// parser here — just the `contract X` / `library X` / `interface X` declarations.
// Matches identifiers but ignores anything inside string literals or comments.
const CONTRACT_NAME_RE = /^\s*(?:abstract\s+)?(?:contract|library|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /\/\/[^\n]*/g;
const STRING_LIT_RE = /(["'])(?:\\.|(?!\1).)*\1/g;

function extractContractNamesFromSource(source: string): string[] {
  const sanitized = source
    .replace(BLOCK_COMMENT_RE, ' ')
    .replace(LINE_COMMENT_RE, ' ')
    .replace(STRING_LIT_RE, ' ');
  const names: string[] = [];
  let m: RegExpExecArray | null;
  CONTRACT_NAME_RE.lastIndex = 0;
  while ((m = CONTRACT_NAME_RE.exec(sanitized)) !== null) {
    names.push(m[1]);
  }
  return names;
}

function isContractCategoryPath(rel: string): boolean {
  // Mirror ProjectScanner.categorizeContract: tests under test/ are excluded.
  const lower = rel.replace(/\\/g, '/').toLowerCase();
  if (lower.includes('/test/') || lower.startsWith('test/')) return false;
  if (/\.t\.sol$/.test(lower)) return false;
  if (/\.s\.sol$/.test(lower)) return false; // foundry scripts
  return true;
}

function discoverSourceContracts(
  projectRoot: string,
  projectType: SubProject['type']
): SourceEntry[] {
  const dirs = contractDirsFor(projectRoot, projectType);
  const seen = new Set<string>();
  const out: SourceEntry[] = [];
  for (const dir of dirs) {
    const fullDir = path.join(projectRoot, dir);
    for (const file of walkFiles(fullDir, (n) => n.endsWith('.sol'))) {
      const rel = path.relative(projectRoot, file);
      if (!isContractCategoryPath(rel)) continue;
      let src: string;
      try {
        src = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const names = extractContractNamesFromSource(src);
      for (const name of names) {
        const k = `${rel}:${name}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ name, sourcePath: rel });
      }
    }
  }
  return out;
}

// ─── Artifact-side discovery ─────────────────────────────────────────────

function discoverFoundryArtifacts(projectRoot: string): ArtifactInfo[] {
  const outDir = path.join(projectRoot, 'out');
  if (!fs.existsSync(outDir)) return [];
  const results: ArtifactInfo[] = [];
  for (const file of walkFiles(
    outDir,
    (n) => n.endsWith('.json') && !n.endsWith('.metadata.json'),
    20_000
  )) {
    const art = readJson<FoundryArtifact>(file);
    if (!art || !isLikelyContractAbi(art.abi)) continue;

    let name = path.basename(file, '.json');
    let sourcePath = '';
    const compileTarget = art.metadata?.settings?.compilationTarget;
    if (compileTarget) {
      const entry = Object.entries(compileTarget)[0];
      if (entry) {
        sourcePath = entry[0];
        name = entry[1];
      }
    } else if (art.ast?.absolutePath) {
      sourcePath = path.relative(projectRoot, art.ast.absolutePath);
    } else {
      const parent = path.basename(path.dirname(file));
      if (parent.endsWith('.sol')) sourcePath = parent;
    }
    results.push({
      name,
      sourcePath,
      artifactPath: file,
      abi: art.abi,
      bytecode: ensureHex(art.bytecode?.object),
      deployedBytecode: art.deployedBytecode?.object
        ? ensureHex(art.deployedBytecode.object)
        : undefined,
    });
  }
  return results;
}

function discoverHardhatArtifacts(projectRoot: string): ArtifactInfo[] {
  const artifactsDir = path.join(projectRoot, 'artifacts', 'contracts');
  if (!fs.existsSync(artifactsDir)) return [];
  const results: ArtifactInfo[] = [];
  for (const file of walkFiles(
    artifactsDir,
    (n) => n.endsWith('.json') && !n.endsWith('.dbg.json'),
    20_000
  )) {
    const art = readJson<HardhatArtifact>(file);
    if (!art || !art.contractName || !isLikelyContractAbi(art.abi)) continue;
    results.push({
      name: art.contractName,
      sourcePath: art.sourceName || '',
      artifactPath: file,
      abi: art.abi,
      bytecode: ensureHex(art.bytecode),
      deployedBytecode: art.deployedBytecode ? ensureHex(art.deployedBytecode) : undefined,
    });
  }
  return results;
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Discover all contracts in the workspace, walking subprojects recursively
 * the way ProjectScanner does for signature analysis. Source contracts are
 * always returned; build artifacts are merged in when available.
 */
export async function discoverWorkspace(workspaceRoot: string): Promise<DiscoveredContract[]> {
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

  const all: DiscoveredContract[] = [];
  const seenKeys = new Set<string>();

  for (const sub of subProjects) {
    const projectType = sub.type === 'solidity' ? detectSubProjectType(sub.path) : sub.type;
    const sources = discoverSourceContracts(sub.path, projectType);
    const artifacts: ArtifactInfo[] = [
      ...discoverFoundryArtifacts(sub.path),
      ...discoverHardhatArtifacts(sub.path),
    ];

    // Build an index of artifacts keyed by `${sourcePath}:${name}`. The byName
    // fallback only considers user-contract artifacts so a `src/Foo` source
    // doesn't accidentally match a `lib/forge-std/Foo` artifact.
    const byFullKey = new Map<string, ArtifactInfo>();
    const byName = new Map<string, ArtifactInfo>();
    for (const a of artifacts) {
      if (a.sourcePath) byFullKey.set(`${a.sourcePath}:${a.name}`, a);
      if (isUserContractPath(projectType, a.sourcePath)) byName.set(a.name, a);
    }

    for (const src of sources) {
      const fullKey = `${src.sourcePath}:${src.name}`;
      const artifact = byFullKey.get(fullKey) ?? byName.get(src.name);
      const key = `${sub.path}::${fullKey}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      all.push({
        key,
        name: src.name,
        file: path.basename(src.sourcePath),
        sourcePath: src.sourcePath,
        projectRoot: sub.path,
        projectType,
        artifactPath: artifact?.artifactPath,
        abi: artifact?.abi,
        bytecode: artifact?.bytecode,
        deployedBytecode: artifact?.deployedBytecode,
        buildState: artifact ? 'built' : 'not-built',
      });
    }

    // Orphan artifacts: only surface ones that look like user contracts (so we
    // skip lib/forge-std/Test.json, lib/openzeppelin/*.json, console.sol, etc.).
    for (const a of artifacts) {
      if (!isUserContractPath(projectType, a.sourcePath)) continue;
      const fullKey = `${a.sourcePath}:${a.name}`;
      const key = `${sub.path}::${fullKey}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      all.push({
        key,
        name: a.name,
        file: path.basename(a.sourcePath),
        sourcePath: a.sourcePath,
        projectRoot: sub.path,
        projectType,
        artifactPath: a.artifactPath,
        abi: a.abi,
        bytecode: a.bytecode,
        deployedBytecode: a.deployedBytecode,
        buildState: 'built',
      });
    }
  }

  return all;
}

// Backwards-compatible wrapper for existing tests / call sites.
export function discoverContracts(workspaceRoot: string): DiscoveredContract[] {
  // Synchronous facade — the heavy lifting in discoverWorkspace is mostly fs-sync,
  // and findAllSubProjects is async only for its dir-walking. For test parity we
  // reproduce the artifact-only discovery synchronously here.
  const projectType = detectSubProjectType(workspaceRoot);
  const artifacts: ArtifactInfo[] = [
    ...discoverFoundryArtifacts(workspaceRoot),
    ...discoverHardhatArtifacts(workspaceRoot),
  ];
  const out: DiscoveredContract[] = [];
  const seen = new Set<string>();
  for (const a of artifacts) {
    const key = `${workspaceRoot}::${a.sourcePath}:${a.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      name: a.name,
      file: a.sourcePath ? path.basename(a.sourcePath) : a.name,
      sourcePath: a.sourcePath,
      projectRoot: workspaceRoot,
      projectType,
      artifactPath: a.artifactPath,
      abi: a.abi,
      bytecode: a.bytecode,
      deployedBytecode: a.deployedBytecode,
      buildState: 'built',
    });
  }
  return out;
}
