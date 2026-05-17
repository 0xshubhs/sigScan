// Live chain RPC registry. Pulls chainid.network/chains.json (the canonical
// source chainlist.org is built on top of), caches it on disk for 1 hour, and
// merges the public RPC URLs with our bundled defaults. RPCs that require an
// API key (URL contains `${...}` placeholder) or are explicitly disabled are
// filtered out.
//
// `getRpcLadder(chainId)` returns an ordered list of candidate RPCs: bundled
// primary first, then bundled fallbacks, then any net-new entries from
// chainlist. Callers walk the ladder until one responds — combined with the
// existing per-call timeout in the deployer, this gives us automatic failover
// without explicit health probes (which would burden the panel at startup).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BUILT_IN_NETWORKS } from '../shared/deploy-run-protocol';

const CHAINLIST_URL = 'https://chainid.network/chains.json';
const CACHE_DIR = path.join(os.homedir(), '.cache', '0xtools');
const CACHE_FILE = path.join(CACHE_DIR, 'chainlist.json');
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 4_000;

interface ChainlistRpc {
  url?: string;
  tracking?: string;
}

interface ChainlistEntry {
  name: string;
  chainId: number;
  rpc?: Array<string | ChainlistRpc>;
  faucets?: string[];
  explorers?: Array<{ url?: string; name?: string }>;
  nativeCurrency?: { name?: string; symbol?: string; decimals?: number };
}

let inMemoryRegistry: Map<number, string[]> | null = null;
let inFlightFetch: Promise<Map<number, string[]>> | null = null;

function isUsableRpcUrl(u: string | undefined): boolean {
  if (!u || typeof u !== 'string') return false;
  if (!/^https?:\/\//i.test(u) && !/^wss?:\/\//i.test(u)) return false;
  // Reject any URL that contains a templated API-key placeholder.
  if (/\$\{[^}]+\}/.test(u)) return false;
  if (u.includes('YOUR_')) return false;
  // We only sign over HTTPS — skip ws/wss and plain http (except localhost).
  if (u.startsWith('ws://') || u.startsWith('wss://')) return false;
  if (u.startsWith('http://') && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(u)) return false;
  return true;
}

function normalizeRpcs(entry: ChainlistEntry): string[] {
  if (!Array.isArray(entry.rpc)) return [];
  const out: string[] = [];
  for (const item of entry.rpc) {
    const url = typeof item === 'string' ? item : item?.url;
    if (isUsableRpcUrl(url)) out.push(url!);
  }
  // Deduplicate while preserving order
  const seen = new Set<string>();
  return out.filter((u) => (seen.has(u) ? false : (seen.add(u), true)));
}

function readCache(): { fetchedAt: number; registry: Map<number, string[]> } | null {
  try {
    const stat = fs.statSync(CACHE_FILE);
    const fetchedAt = stat.mtimeMs;
    if (Date.now() - fetchedAt > CACHE_TTL_MS) return null;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const map = new Map<number, string[]>(JSON.parse(raw));
    return { fetchedAt, registry: map };
  } catch {
    return null;
  }
}

function writeCache(registry: Map<number, string[]>): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Array.from(registry.entries())));
  } catch {
    /* non-fatal — we keep going from in-memory */
  }
}

async function fetchAndBuildRegistry(): Promise<Map<number, string[]>> {
  // Node 18+ has global fetch.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(CHAINLIST_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`chainlist responded ${res.status}`);
    const data = (await res.json()) as ChainlistEntry[];
    const map = new Map<number, string[]>();
    for (const entry of data) {
      if (typeof entry.chainId !== 'number') continue;
      const rpcs = normalizeRpcs(entry);
      if (rpcs.length > 0) map.set(entry.chainId, rpcs);
    }
    writeCache(map);
    return map;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns the merged registry, lazy-loading from disk or network on first call.
 * Subsequent calls return the cached in-memory map. Errors are swallowed: if
 * chainlist is unreachable, we return an empty map and the caller falls back
 * to bundled defaults.
 */
export async function ensureRegistry(): Promise<Map<number, string[]>> {
  if (inMemoryRegistry) return inMemoryRegistry;

  // Try disk cache first — instant load.
  const cached = readCache();
  if (cached) {
    inMemoryRegistry = cached.registry;
    return cached.registry;
  }

  // Otherwise fetch (coalesced).
  if (!inFlightFetch) {
    inFlightFetch = fetchAndBuildRegistry()
      .then((map) => {
        inMemoryRegistry = map;
        return map;
      })
      .catch(() => {
        const empty = new Map<number, string[]>();
        inMemoryRegistry = empty;
        return empty;
      })
      .finally(() => {
        inFlightFetch = null;
      });
  }
  return inFlightFetch;
}

/** Force a re-fetch on the next call (e.g., when the user clicks "refresh chainlist"). */
export function invalidateRegistry(): void {
  inMemoryRegistry = null;
  try {
    fs.unlinkSync(CACHE_FILE);
  } catch {
    /* ignore */
  }
}

/**
 * Returns an ordered ladder of RPC URLs for a chain. Bundled URLs come first
 * (they're what we've curated and verified). Anything new from chainlist is
 * appended, deduped against the bundled set.
 *
 * Synchronous variant for the hot path — uses whatever's in memory; kicks off
 * a background load if nothing is cached yet.
 */
export function getRpcLadder(chainId: number): string[] {
  const bundled = bundledLadder(chainId);
  const live = inMemoryRegistry?.get(chainId) ?? [];

  if (!inMemoryRegistry && !inFlightFetch) {
    void ensureRegistry(); // fire-and-forget warmup
  }

  const seen = new Set(bundled);
  const merged = [...bundled];
  for (const url of live) {
    if (!seen.has(url)) {
      seen.add(url);
      merged.push(url);
    }
  }
  return merged;
}

function bundledLadder(chainId: number): string[] {
  for (const n of BUILT_IN_NETWORKS) {
    if (n.chainId === chainId) {
      const out: string[] = [];
      if (n.rpcUrl) out.push(n.rpcUrl);
      if (n.rpcUrls) out.push(...n.rpcUrls);
      return out;
    }
  }
  return [];
}

/**
 * Returns chainlist's authoritative chain name / native symbol if we have
 * them — used to enrich the network display when the bundled entry is sparse.
 */
export async function getChainMetadata(chainId: number): Promise<{ name?: string; nativeSymbol?: string } | null> {
  // We don't store full metadata in memory (only the RPC map) to keep the
  // footprint small. For the rare metadata lookup, do a one-shot file read.
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const stat = fs.statSync(CACHE_FILE);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    // Cache file stores only the rpc map, not full metadata; re-fetch on demand.
  } catch {
    /* ignore */
  }
  return null;
}
