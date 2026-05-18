// Webview-side helpers for composing block-explorer URLs and triggering the
// host to open them. Centralising the URL composition + click handler here
// keeps the components themselves lean.

import type { Bus } from './bus';
import type { NetworkKind } from '../../shared/deploy-run-protocol';
import {
  buildExplorerUrl,
  explorerUrlForChainId,
  explorerUrlForKind,
} from '../../shared/deploy-run-protocol';

export type ExplorerKind = 'tx' | 'address';

/**
 * Resolve a block-explorer URL using either a chainId (preferred — set by the
 * host on every TxLogEntry) or a NetworkKind fallback (for DeployedInstance
 * which only records the kind). Returns null when we don't have an explorer
 * for that chain (anvil, or a chain we don't ship in BUILT_IN_NETWORKS).
 */
export function explorerUrlFor(
  ctx: { chainId?: number; networkKind?: NetworkKind },
  kind: ExplorerKind,
  value: string
): string | null {
  const base =
    explorerUrlForChainId(ctx.chainId) ??
    (ctx.networkKind ? explorerUrlForKind(ctx.networkKind) : undefined);
  return buildExplorerUrl(base, kind, value);
}

export function openExplorerVia(bus: Bus, url: string): void {
  void bus.request({ kind: 'openExplorer', url });
}
