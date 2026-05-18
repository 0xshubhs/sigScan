import { useState } from 'react';
import type { TxLogEntry } from '../../../shared/deploy-run-protocol';
import type { Bus } from '../bus';
import { explorerUrlFor, openExplorerVia } from '../explorer';

interface Props {
  entries: TxLogEntry[];
  bus: Bus;
}

// ─── Formatters ─────────────────────────────────────────────────────────

function shorten(s: string | undefined, head = 6, tail = 4): string {
  if (!s) return '';
  if (s.length < head + tail + 3) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function timeAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 1000) return 'now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Terminal-style abbreviation for gas — 26532 → 26.5k, 1234567 → 1.23M */
function formatGas(g: string | number | undefined): string {
  if (g === undefined || g === null) return '';
  const n = typeof g === 'string' ? Number(g) : g;
  if (!Number.isFinite(n)) return String(g);
  if (n < 1_000) return n.toString();
  if (n < 1_000_000) {
    const v = n / 1_000;
    return `${v < 10 ? v.toFixed(2) : v.toFixed(1)}k`;
  }
  const v = n / 1_000_000;
  return `${v < 10 ? v.toFixed(2) : v.toFixed(1)}M`;
}

function formatValueWei(wei: string | undefined): string {
  if (!wei || wei === '0') return '0';
  try {
    const n = BigInt(wei);
    if (n === 0n) return '0';
    const eth = Number(n) / 1e18;
    if (eth >= 0.0001) return `${eth.toFixed(eth < 1 ? 6 : 4).replace(/\.?0+$/, '')} ETH`;
    return `${wei} wei`;
  } catch {
    return `${wei} wei`;
  }
}

function statusGlyph(s: TxLogEntry['status']): string {
  switch (s) {
    case 'success':  return '●';
    case 'reverted': return '✕';
    case 'error':    return '!';
    case 'pending':  return '◐';
  }
}

function statusLabel(s: TxLogEntry['status']): string {
  switch (s) {
    case 'success':  return 'OK';
    case 'reverted': return 'REVERTED';
    case 'error':    return 'ERROR';
    case 'pending':  return 'PENDING';
  }
}

function kindAbbr(k: TxLogEntry['kind']): string {
  return k === 'deploy' ? 'DEP' : k === 'send' ? 'TX' : 'CALL';
}

function renderLabel(tx: TxLogEntry): JSX.Element {
  if (tx.kind === 'deploy') {
    return (
      <>
        <span>{tx.contractName}</span>
        <span className="muted"> · </span>
        <span className="label-ctor">constructor</span>
      </>
    );
  }
  return (
    <>
      <span>{shorten(tx.contractName, 6, 4)}</span>
      <span className="muted">.</span>
      <span className="label-fn">{tx.funcName ?? '?'}</span>
      <span className="muted">()</span>
    </>
  );
}

function formatEventValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') {
    if (v.length > 22 && v.startsWith('0x')) return shorten(v, 8, 4);
    return v;
  }
  if (typeof v === 'bigint' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function formatReturn(v: unknown): string {
  if (v === null || v === undefined) return '(no return value)';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'bigint') return v.toString();
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// ─── Components ─────────────────────────────────────────────────────────

function CopyInline({ value }: { value: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-inline"
      title={copied ? 'Copied!' : 'Copy'}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1000);
      }}
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}

/**
 * Block-explorer link button. Renders nothing when the entry's chain has no
 * explorer URL configured (anvil, custom chains) — that way the markup stays
 * stable but invisible rather than showing a dead button.
 */
function ExplorerLink({
  url,
  bus,
  label,
}: {
  url: string | null;
  bus: Bus;
  label: string;
}): JSX.Element | null {
  if (!url) return null;
  return (
    <button
      className="explorer-link"
      title={`Open on explorer · ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        openExplorerVia(bus, url);
      }}
    >
      ↗
    </button>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div className="tx-empty">
      <svg className="empty-glyph" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1">
        <rect x="6" y="6" width="36" height="36" />
        <line x1="6" y1="16" x2="42" y2="16" />
        <line x1="6" y1="26" x2="42" y2="26" />
        <line x1="6" y1="36" x2="42" y2="36" />
        <line x1="16" y1="6" x2="16" y2="42" strokeDasharray="2 3" opacity="0.5" />
      </svg>
      <div className="empty-title">AWAITING SIGNAL</div>
      <div className="empty-hint">Transactions stream here in real time.</div>
    </div>
  );
}

interface EntryProps {
  tx: TxLogEntry;
  defaultOpen: boolean;
  bus: Bus;
}

function TxEntry({ tx, defaultOpen, bus }: EntryProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const hasMeta = tx.gasUsed || tx.blockNumber !== undefined || tx.txHash;
  const explorerCtx = { chainId: tx.chainId };

  return (
    <div className={`tx-entry ${tx.status}`}>
      <div
        className="tx-head"
        onClick={() => setOpen((o) => !o)}
        title={open ? 'Collapse' : 'Expand'}
      >
        <span className={`tx-kind kind-${tx.kind}`}>{kindAbbr(tx.kind)}</span>
        <span className={`tx-status-icon s-${tx.status}`}>{statusGlyph(tx.status)}</span>
        <span className="tx-label">{renderLabel(tx)}</span>
        <span className="tx-time">{timeAgo(tx.at)}</span>
        <span className="tx-expand-caret">{open ? '▾' : '▸'}</span>
      </div>

      {open && (
        <div className="tx-body">
          {/* STATUS */}
          <div className="dt">Status</div>
          <div className={`dd dd-status s-${tx.status}`}>{statusLabel(tx.status)}</div>

          {/* CONTRACT NAME (deploy & send/call) */}
          {tx.kind === 'deploy' ? (
            <>
              <div className="dt">Contract</div>
              <div className="dd"><span className="mono">{tx.contractName}</span></div>
            </>
          ) : (
            <>
              <div className="dt">Function</div>
              <div className="dd">
                <span className="label-fn mono">{tx.funcName}()</span>
              </div>
            </>
          )}

          {/* DEPLOYED ADDRESS — centrepiece for deploy entries */}
          {tx.kind === 'deploy' && tx.deployedAddress && (
            <>
              <div className="dt">Deployed</div>
              <div className="dd dd-address-deploy">
                <span className="mono">{tx.deployedAddress}</span>
                <CopyInline value={tx.deployedAddress} />
                <ExplorerLink
                  url={explorerUrlFor(explorerCtx, 'address', tx.deployedAddress)}
                  bus={bus}
                  label="contract address"
                />
              </div>
            </>
          )}

          {/* TARGET ADDRESS for send/call */}
          {tx.kind !== 'deploy' && tx.toAddress && (
            <>
              <div className="dt">To</div>
              <div className="dd">
                <span className="mono">{shorten(tx.toAddress, 8, 6)}</span>
                <CopyInline value={tx.toAddress} />
                <ExplorerLink
                  url={explorerUrlFor(explorerCtx, 'address', tx.toAddress)}
                  bus={bus}
                  label="target contract"
                />
              </div>
            </>
          )}

          {/* FROM ADDRESS */}
          {tx.fromAddress && (
            <>
              <div className="dt">From</div>
              <div className="dd">
                <span className="mono">{shorten(tx.fromAddress, 8, 6)}</span>
                <CopyInline value={tx.fromAddress} />
                <ExplorerLink
                  url={explorerUrlFor(explorerCtx, 'address', tx.fromAddress)}
                  bus={bus}
                  label="sender"
                />
              </div>
            </>
          )}

          {/* VALUE — only when non-zero, since most calls send 0 */}
          {tx.valueWei && tx.valueWei !== '0' && (
            <>
              <div className="dt">Value</div>
              <div className="dd">{formatValueWei(tx.valueWei)}</div>
            </>
          )}

          {/* TX META */}
          {hasMeta && (
            <>
              {tx.txHash && (
                <>
                  <div className="dt">Tx</div>
                  <div className="dd">
                    <span className="mono">{shorten(tx.txHash, 8, 6)}</span>
                    <CopyInline value={tx.txHash} />
                    <ExplorerLink
                      url={explorerUrlFor(explorerCtx, 'tx', tx.txHash)}
                      bus={bus}
                      label="transaction"
                    />
                  </div>
                </>
              )}
              {tx.blockNumber !== undefined && (
                <>
                  <div className="dt">Block</div>
                  <div className="dd"><span className="mono">#{tx.blockNumber}</span></div>
                </>
              )}
              {tx.gasUsed && (
                <>
                  <div className="dt">Gas</div>
                  <div className="dd dd-gas"><span className="mono">{formatGas(tx.gasUsed)}</span></div>
                </>
              )}
            </>
          )}

          {/* NETWORK */}
          {tx.networkLabel && (
            <>
              <div className="dt">Network</div>
              <div className="dd"><span className="mono">{tx.networkLabel}</span></div>
            </>
          )}

          {/* EVENTS — full-row span sub-section */}
          {tx.decodedEvents && tx.decodedEvents.length > 0 && (
            <>
              <div className="tx-section section-events">Events · {tx.decodedEvents.length}</div>
              {tx.decodedEvents.map((e, i) => (
                <div key={`${e.name}-${i}`} className="tx-event-line">
                  <span className="ev-name">{e.name}</span>
                  <span className="ev-args">
                    {' ('}
                    {Object.entries(e.args).map(([k, v], idx) => (
                      <span key={k}>
                        {idx > 0 && ', '}
                        <span className="ev-arg-key">{k}</span>={formatEventValue(v)}
                      </span>
                    ))}
                    {')'}
                  </span>
                </div>
              ))}
            </>
          )}

          {/* RETURN VALUE for view/pure calls */}
          {tx.returnValue !== undefined && tx.kind === 'call' && tx.status === 'success' && (
            <>
              <div className="tx-section section-return">Return</div>
              <div className="tx-return-block">{formatReturn(tx.returnValue)}</div>
            </>
          )}

          {/* REVERT block */}
          {tx.errorMessage && (
            <>
              <div className="tx-section section-revert">Revert</div>
              <div className="tx-revert-block">{tx.errorMessage}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main ────────────────────────────────────────────────────────────────

export function TxLogPanel({ entries, bus }: Props): JSX.Element {
  return (
    <section className="section">
      <h3 className="section-title">
        Tx Log
        {entries.length > 0 && <span className="count">· {entries.length}</span>}
        <span className="right">
          <button
            className="vsc-button small"
            disabled={entries.length === 0}
            onClick={() => void bus.request({ kind: 'clearTxLog' })}
            title="Clear the transaction log"
          >
            clear
          </button>
        </span>
      </h3>

      {entries.length === 0 && <EmptyState />}

      {entries.length > 0 && (
        <div className="tx-log">
          {entries.map((tx, i) => (
            // Auto-expand the newest entry so the user sees the full receipt
            // (deployed address, events, etc.) without clicking. Older entries
            // collapse to the one-line header.
            <TxEntry key={tx.id} tx={tx} defaultOpen={i === 0} bus={bus} />
          ))}
        </div>
      )}
    </section>
  );
}
