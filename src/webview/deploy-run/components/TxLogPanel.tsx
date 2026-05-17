import type { TxLogEntry } from '../../../shared/deploy-run-protocol';
import type { Bus } from '../bus';

interface Props {
  entries: TxLogEntry[];
  bus: Bus;
}

function shorten(s: string | undefined, head = 6, tail = 4): string {
  if (!s) return '';
  if (s.length < head + tail + 3) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function timeAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 1000) return 'just now';
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

function statusGlyph(s: TxLogEntry['status']): string {
  switch (s) {
    case 'success':  return '●';
    case 'reverted': return '✕';
    case 'error':    return '!';
    case 'pending':  return '◐';
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

function EmptyState(): JSX.Element {
  return (
    <div className="tx-empty">
      <svg className="empty-glyph" viewBox="0 0 56 56" fill="none" stroke="currentColor" strokeWidth="1.2">
        <circle className="outer" cx="28" cy="28" r="22" strokeDasharray="2 4" strokeLinecap="round" opacity="0.5" />
        <circle className="mid"   cx="28" cy="28" r="14" strokeDasharray="2 3" strokeLinecap="round" opacity="0.7" />
        <circle className="inner" cx="28" cy="28" r="6"  fill="currentColor" stroke="none" opacity="0.4" />
        <line x1="28" y1="6" x2="28" y2="2" strokeLinecap="round" opacity="0.6" />
        <line x1="28" y1="54" x2="28" y2="50" strokeLinecap="round" opacity="0.6" />
        <line x1="6" y1="28" x2="2" y2="28" strokeLinecap="round" opacity="0.6" />
        <line x1="54" y1="28" x2="50" y2="28" strokeLinecap="round" opacity="0.6" />
      </svg>
      <div className="empty-title">Awaiting signal</div>
      <div className="empty-hint">
        Transactions flow through this panel in real time once you deploy or call a contract.
      </div>
    </div>
  );
}

export function TxLogPanel({ entries, bus }: Props): JSX.Element {
  return (
    <section className="section">
      <h3 className="section-title">
        Tx Log
        {entries.length > 0 && <span className="count">· {entries.length}</span>}
        <span className="rule" />
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
          {entries.map((tx) => (
            <div
              key={tx.id}
              className={`tx-entry ${tx.status}`}
              title={tx.txHash ? `Tx hash: ${tx.txHash}` : undefined}
            >
              <div className="tx-head">
                <span className={`tx-kind kind-${tx.kind}`}>{kindAbbr(tx.kind)}</span>
                <span className={`tx-status-icon s-${tx.status}`}>{statusGlyph(tx.status)}</span>
                <span className="tx-label">{renderLabel(tx)}</span>
                <span className="tx-time">{timeAgo(tx.at)}</span>
              </div>

              {(tx.gasUsed || tx.blockNumber !== undefined || tx.txHash) && (
                <div className="tx-meta">
                  {tx.gasUsed && (
                    <span className="meta-item">
                      <span className="meta-key">gas</span>
                      <span className="meta-val">{formatGas(tx.gasUsed)}</span>
                    </span>
                  )}
                  {tx.blockNumber !== undefined && (
                    <span className="meta-item">
                      <span className="meta-key">blk</span>
                      <span className="meta-val">#{tx.blockNumber}</span>
                    </span>
                  )}
                  {tx.txHash && (
                    <span className="meta-item meta-hash" title={tx.txHash}>
                      <span className="meta-key">tx</span>
                      <span className="meta-val">{shorten(tx.txHash, 6, 4)}</span>
                    </span>
                  )}
                </div>
              )}

              {tx.decodedEvents && tx.decodedEvents.length > 0 && (
                <div className="tx-events">
                  {tx.decodedEvents.map((e, i) => (
                    <span
                      key={`${e.name}-${i}`}
                      className="tx-event"
                      title={Object.entries(e.args)
                        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
                        .join('\n')}
                    >
                      {e.name}
                    </span>
                  ))}
                </div>
              )}

              {tx.returnValue !== undefined && tx.status === 'success' && tx.kind === 'call' && (
                <div className="tx-return">
                  {typeof tx.returnValue === 'object'
                    ? JSON.stringify(tx.returnValue, null, 2)
                    : String(tx.returnValue)}
                </div>
              )}

              {tx.errorMessage && (
                <div className="tx-error">{tx.errorMessage}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
