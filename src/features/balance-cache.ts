// Native-token balance fetcher with RPC fallback ladder + short TTL cache.
// Used by the Deploy & Run panel to show "0.1234 ETH" next to a keystore on
// the currently active network. Falls through RPC URLs in order, caches the
// first success for a short window so rapid UI re-renders don't hammer the RPC.

import { JsonRpcProvider, formatUnits, isAddress } from 'ethers';
import { getRpcLadder } from './rpc-registry';
import type { KeystoreBalance, NetworkConfig } from '../shared/deploy-run-protocol';

const TTL_MS = 30_000;
const PER_RPC_TIMEOUT_MS = 5_000;

interface CacheEntry {
  balance: KeystoreBalance;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(address: string, chainId: number): string {
  return `${address.toLowerCase()}::${chainId}`;
}

function formatBalance(weiStr: string, symbol: string): string {
  try {
    const eth = formatUnits(BigInt(weiStr), 18);
    // Trim trailing zeros while preserving precision up to 4 fractional digits for display
    const num = Number(eth);
    if (!Number.isFinite(num)) return `${eth} ${symbol}`;
    if (num === 0) return `0 ${symbol}`;
    if (num < 0.0001) return `<0.0001 ${symbol}`;
    if (num < 1) return `${num.toFixed(4)} ${symbol}`;
    if (num < 1000) return `${num.toFixed(4).replace(/\.?0+$/, '')} ${symbol}`;
    return `${num.toFixed(2)} ${symbol}`;
  } catch {
    return `${weiStr} wei`;
  }
}

/** Cancels a JsonRpcProvider call after `ms`, rejecting the surrounding race. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

async function tryRpc(rpcUrl: string, address: string): Promise<bigint> {
  const provider = new JsonRpcProvider(rpcUrl);
  try {
    return await withTimeout(provider.getBalance(address), PER_RPC_TIMEOUT_MS);
  } finally {
    provider.destroy();
  }
}

export interface FetchOptions {
  /** Skip cache and force a network round-trip. */
  force?: boolean;
}

export interface FetchResult {
  ok: boolean;
  balance?: KeystoreBalance;
  error?: string;
  rpcUsed?: string;
  fromCache?: boolean;
}

/**
 * Fetch the native balance for an address on a given network. Walks the RPC
 * ladder (bundled fallbacks + chainlist-sourced entries) until one responds.
 * Returns the first success or a structured error if everything timed out.
 */
export async function fetchBalance(
  address: string,
  network: NetworkConfig,
  opts: FetchOptions = {}
): Promise<FetchResult> {
  if (!isAddress(address)) return { ok: false, error: `invalid address: ${address}` };
  const chainId = network.chainId;
  if (chainId === undefined) return { ok: false, error: `network ${network.name} has no chainId` };

  const key = cacheKey(address, chainId);
  if (!opts.force) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      return { ok: true, balance: hit.balance, fromCache: true };
    }
  }

  const symbol = network.nativeSymbol ?? 'ETH';
  const ladder = getRpcLadder(chainId);
  // Chainlist may not be loaded yet OR may not know about this chain — fall
  // back to whatever the network config has on it directly so we still try
  // *something*.
  if (ladder.length === 0 && network.rpcUrl) ladder.push(network.rpcUrl);

  if (ladder.length === 0) {
    return { ok: false, error: `no RPC URLs available for chain ${chainId}` };
  }

  const errors: string[] = [];
  for (const rpc of ladder) {
    try {
      const wei = await tryRpc(rpc, address);
      const weiStr = wei.toString();
      const balance: KeystoreBalance = {
        wei: weiStr,
        formatted: formatBalance(weiStr, symbol),
        symbol,
        chainId,
        fetchedAt: Date.now(),
      };
      cache.set(key, { balance, expiresAt: Date.now() + TTL_MS });
      return { ok: true, balance, rpcUsed: rpc };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${rpc}: ${msg}`);
    }
  }
  return {
    ok: false,
    error: `all ${ladder.length} RPC(s) failed:\n${errors.slice(0, 3).join('\n')}`,
  };
}

export function invalidateBalance(address: string, chainId?: number): void {
  if (chainId !== undefined) {
    cache.delete(cacheKey(address, chainId));
    return;
  }
  // Clear all entries for that address (any chain)
  const prefix = `${address.toLowerCase()}::`;
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}

export function clearBalanceCache(): void {
  cache.clear();
}
