/**
 * Solidity AST helpers
 *
 * Produces a real Solidity AST (compact format) from source via an AST-only
 * solc compile, plus a set of pure walker/extractor helpers that the security
 * analyzers use for high-precision, low-false-positive analysis.
 *
 * The compile path is best-effort: on ANY failure (unresolved imports, compile
 * error, solc not installed) it returns `undefined`, and callers fall back to
 * their existing regex heuristics. The pure helpers below operate on plain AST
 * JSON and are unit-tested with hand-written fixtures (no compile required).
 */

import { createHash } from 'crypto';
import {
  SolcManager,
  resolveSolcVersion,
  parsePragmaFromSource,
} from '../SolcManager';

/**
 * Compact-AST node shape, compatible with SolcManager's private `ASTNode`.
 * Solc's compact AST uses `nodeType`, `src` ("start:len:fileIdx"), and nests
 * children under `nodes`, `body`, `statements`, `expression`, etc.
 */
export interface SolidityAstNode {
  id?: number;
  nodeType: string;
  src?: string;
  nodes?: SolidityAstNode[];
  body?: SolidityAstNode;
  name?: string;
  [k: string]: unknown;
}

const STABLE_FILENAME = 'Contract.sol';

// ──────────────────────────────────────────────────────────────────────────
// Small content-hash LRU cache so repeated calls on the same source are instant
// ──────────────────────────────────────────────────────────────────────────
const AST_CACHE_MAX = 8;
const astCache = new Map<string, SolidityAstNode | undefined>();

function hashSource(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function cacheGet(key: string): { hit: boolean; value: SolidityAstNode | undefined } {
  if (astCache.has(key)) {
    const value = astCache.get(key);
    // Refresh LRU recency
    astCache.delete(key);
    astCache.set(key, value);
    return { hit: true, value };
  }
  return { hit: false, value: undefined };
}

function cacheSet(key: string, value: SolidityAstNode | undefined): void {
  if (astCache.has(key)) {
    astCache.delete(key);
  }
  astCache.set(key, value);
  while (astCache.size > AST_CACHE_MAX) {
    const oldest = astCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    astCache.delete(oldest);
  }
}

/**
 * Resolve the appropriate solc compiler instance for the given source's pragma.
 * Mirrors SolcManager.getCompilerForPragma but forces a fresh load of the exact
 * resolved version (we only need the `.compile` entry point).
 */
async function resolveCompiler(source: string): Promise<{ compile: (input: string, opts?: unknown) => string } | null> {
  const pragma = parsePragmaFromSource(source);

  // No pragma → use whatever solc is bundled.
  if (!pragma) {
    const bundled = SolcManager.getBundled();
    return bundled ?? null;
  }

  try {
    const availableVersions = await SolcManager.getAvailableVersions();
    const targetVersion = resolveSolcVersion(pragma, availableVersions);

    const bundledVersion = SolcManager.getBundledVersion();
    const bundledSemver = bundledVersion.match(/(\d+\.\d+\.\d+)/)?.[1] || '';
    if (targetVersion === bundledSemver) {
      const bundled = SolcManager.getBundled();
      if (bundled) {
        return bundled;
      }
    }

    if (SolcManager.isCached(targetVersion)) {
      const cached = SolcManager.getCached(targetVersion);
      if (cached) {
        return cached;
      }
    }

    return await SolcManager.load(targetVersion);
  } catch {
    // Fall back to bundled compiler if version resolution/loading fails.
    return SolcManager.getBundled() ?? null;
  }
}

/**
 * Permissive import callback — we never resolve imports for AST extraction.
 * Self-contained files still parse fine; files that depend on imports will
 * produce compile errors → `getAst` returns undefined → caller uses regex.
 */
function notFoundImport(): { error: string } {
  return { error: 'not found' };
}

/**
 * Produce the top-level SourceUnit AST for a Solidity source string.
 *
 * Does a minimal AST-ONLY compile (no bytecode, no optimizer — cheap). Returns
 * the SourceUnit node, or `undefined` on any error so callers fall back to regex.
 * Results are LRU-cached by content hash.
 */
export async function getAst(source: string): Promise<SolidityAstNode | undefined> {
  if (!source || typeof source !== 'string') {
    return undefined;
  }

  const key = hashSource(source);
  const cached = cacheGet(key);
  if (cached.hit) {
    return cached.value;
  }

  let result: SolidityAstNode | undefined;
  try {
    const compiler = await resolveCompiler(source);
    if (!compiler || typeof compiler.compile !== 'function') {
      cacheSet(key, undefined);
      return undefined;
    }

    const input = JSON.stringify({
      language: 'Solidity',
      sources: {
        [STABLE_FILENAME]: { content: source },
      },
      settings: {
        // AST only — no bytecode, no gas, no optimizer.
        outputSelection: {
          '*': {
            '': ['ast'],
          },
        },
      },
    });

    const outputJson = compiler.compile(input, { import: notFoundImport });
    const output = JSON.parse(outputJson);

    // Hard compile errors (severity 'error') mean we can't trust the AST.
    if (Array.isArray(output?.errors)) {
      const hasFatal = output.errors.some(
        (e: { severity?: string }) => e && e.severity === 'error'
      );
      if (hasFatal) {
        cacheSet(key, undefined);
        return undefined;
      }
    }

    const ast = output?.sources?.[STABLE_FILENAME]?.ast as SolidityAstNode | undefined;
    if (ast && typeof ast === 'object' && ast.nodeType === 'SourceUnit') {
      result = ast;
    } else {
      result = undefined;
    }
  } catch {
    result = undefined;
  }

  cacheSet(key, result);
  return result;
}

// ──────────────────────────────────────────────────────────────────────────
// Pure helpers (unit-tested with inline AST fixtures — no compile needed)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Generic depth-first AST walker. Visits `node` then recurses into every
 * SolidityAstNode-shaped value reachable through object/array properties.
 */
export function walkAst(
  node: SolidityAstNode | null | undefined,
  visitor: (node: SolidityAstNode) => void
): void {
  if (!node || typeof node !== 'object') {
    return;
  }
  visitor(node);
  for (const key of Object.keys(node)) {
    const value = (node as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && typeof (item as SolidityAstNode).nodeType === 'string') {
          walkAst(item as SolidityAstNode, visitor);
        }
      }
    } else if (value && typeof value === 'object' && typeof (value as SolidityAstNode).nodeType === 'string') {
      walkAst(value as SolidityAstNode, visitor);
    }
  }
}

/**
 * Convert a compact-AST `src` ("start:len:fileIdx") to a 1-based line number.
 * Returns 1 when src is missing or malformed.
 */
export function srcToLine(src: string | undefined, source: string): number {
  if (!src) {
    return 1;
  }
  const start = parseInt(src.split(':')[0], 10);
  if (!Number.isFinite(start) || start < 0) {
    return 1;
  }
  let line = 1;
  const limit = Math.min(start, source.length);
  for (let i = 0; i < limit; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) {
      line++;
    }
  }
  return line;
}

/** All `ContractDefinition` nodes anywhere under the given AST. */
export function getContracts(ast: SolidityAstNode): SolidityAstNode[] {
  const contracts: SolidityAstNode[] = [];
  walkAst(ast, (n) => {
    if (n.nodeType === 'ContractDefinition') {
      contracts.push(n);
    }
  });
  return contracts;
}

/** Direct `FunctionDefinition` nodes of a contract. */
export function getFunctions(contract: SolidityAstNode): SolidityAstNode[] {
  const fns: SolidityAstNode[] = [];
  const children = (contract.nodes as SolidityAstNode[] | undefined) ?? [];
  for (const child of children) {
    if (child && child.nodeType === 'FunctionDefinition') {
      fns.push(child);
    }
  }
  return fns;
}

/**
 * Names of contract-level state variables (VariableDeclaration with
 * `stateVariable === true`).
 */
export function getStateVariableNames(contract: SolidityAstNode): Set<string> {
  const names = new Set<string>();
  const children = (contract.nodes as SolidityAstNode[] | undefined) ?? [];
  for (const child of children) {
    if (
      child &&
      child.nodeType === 'VariableDeclaration' &&
      child.stateVariable === true &&
      typeof child.name === 'string' &&
      child.name.length > 0
    ) {
      names.add(child.name);
    }
  }
  return names;
}

const LOW_LEVEL_MEMBERS = new Set(['call', 'transfer', 'send', 'delegatecall', 'staticcall']);

/**
 * True if a MemberAccess base expression is plainly `this` (so the member call
 * is an internal self-call, not an external interaction).
 */
function isThisBase(expression: unknown): boolean {
  if (!expression || typeof expression !== 'object') {
    return false;
  }
  const expr = expression as SolidityAstNode;
  // `this` is a Identifier with name 'this', or a FunctionCall wrapping it.
  if (expr.nodeType === 'Identifier' && expr.name === 'this') {
    return true;
  }
  return false;
}

/**
 * External / low-level `FunctionCall` nodes inside a function.
 *
 * Conservative: a call is considered external when its callee is a MemberAccess
 * whose `memberName` is a low-level primitive (call/transfer/send/delegatecall/
 * staticcall) on a non-`this` base, OR a member call on an
 * address/contract-typed base expression (e.g. `token.transferFrom(...)`).
 */
export function getExternalCalls(fn: SolidityAstNode): SolidityAstNode[] {
  const calls: SolidityAstNode[] = [];
  walkAst(fn, (n) => {
    if (n.nodeType !== 'FunctionCall') {
      return;
    }
    // Only ordinary calls (skip typeConversion / structConstructorCall).
    if (n.kind && n.kind !== 'functionCall') {
      return;
    }
    // `addr.call{value: x}(...)` wraps the MemberAccess in a FunctionCallOptions
    // node — unwrap it so the callee resolution below sees the MemberAccess.
    let callee = n.expression as SolidityAstNode | undefined;
    if (callee && callee.nodeType === 'FunctionCallOptions') {
      callee = callee.expression as SolidityAstNode | undefined;
    }
    if (!callee || callee.nodeType !== 'MemberAccess') {
      return;
    }
    const memberName = typeof callee.memberName === 'string' ? callee.memberName : '';
    const base = callee.expression;

    // 1) Low-level primitives: x.call / x.transfer / x.send / x.delegatecall / x.staticcall
    if (LOW_LEVEL_MEMBERS.has(memberName) && !isThisBase(base)) {
      calls.push(n);
      return;
    }

    // 2) Member call on an address/contract-typed base that is not `this`.
    if (!isThisBase(base) && base && typeof base === 'object') {
      const baseNode = base as SolidityAstNode;
      const typeStr =
        ((baseNode.typeDescriptions as { typeString?: string } | undefined)?.typeString) || '';
      const isExternalType =
        /\baddress\b/.test(typeStr) || /\bcontract\b/.test(typeStr) || /^contract /.test(typeStr);
      // Require an external/public-typed callee to avoid library/internal noise.
      const calleeType =
        ((callee.typeDescriptions as { typeString?: string } | undefined)?.typeString) || '';
      const looksExternalFn = /\bexternal\b/.test(calleeType);
      if (isExternalType && looksExternalFn) {
        calls.push(n);
      }
    }
  });
  return calls;
}

/**
 * Walk down an LHS expression to its base Identifier name (handles
 * `x`, `x[i]`, `x.field`, `x[i].field` etc.). Returns '' if none found.
 */
function baseIdentifierName(node: unknown): string {
  let current: unknown = node;
  // Guard against pathological cycles.
  for (let guard = 0; guard < 64 && current && typeof current === 'object'; guard++) {
    const n = current as SolidityAstNode;
    if (n.nodeType === 'Identifier') {
      return typeof n.name === 'string' ? n.name : '';
    }
    if (n.nodeType === 'IndexAccess') {
      current = n.baseExpression;
      continue;
    }
    if (n.nodeType === 'MemberAccess') {
      current = n.expression;
      continue;
    }
    break;
  }
  return '';
}

/**
 * State-write nodes inside a function: `Assignment` and `UnaryOperation`
 * (++ / -- / delete) whose LHS base Identifier is a known state variable.
 */
export function getStateWrites(fn: SolidityAstNode, stateVars: Set<string>): SolidityAstNode[] {
  const writes: SolidityAstNode[] = [];
  walkAst(fn, (n) => {
    if (n.nodeType === 'Assignment') {
      const name = baseIdentifierName(n.leftHandSide);
      if (name && stateVars.has(name)) {
        writes.push(n);
      }
    } else if (n.nodeType === 'UnaryOperation') {
      const op = typeof n.operator === 'string' ? n.operator : '';
      if (op === '++' || op === '--' || op === 'delete') {
        const name = baseIdentifierName(n.subExpression);
        if (name && stateVars.has(name)) {
          writes.push(n);
        }
      }
    }
  });
  return writes;
}

/** Modifier invocation names applied to a function. */
export function getModifierNames(fn: SolidityAstNode): string[] {
  const names: string[] = [];
  const modifiers = fn.modifiers as SolidityAstNode[] | undefined;
  if (!Array.isArray(modifiers)) {
    return names;
  }
  for (const m of modifiers) {
    if (!m || m.nodeType !== 'ModifierInvocation') {
      continue;
    }
    const modName = m.modifierName as SolidityAstNode | undefined;
    if (modName && typeof modName.name === 'string') {
      names.push(modName.name);
    } else if (typeof m.name === 'string') {
      names.push(m.name);
    }
  }
  return names;
}
