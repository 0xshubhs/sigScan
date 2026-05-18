import { useEffect, useState } from 'react';
import type {
  AbiEntry,
  DeployedInstance,
  DeployRunEvent,
  ValueUnit,
  VerifyStatus,
} from '../../../shared/deploy-run-protocol';
import { valueToWei } from '../../../shared/deploy-run-protocol';
import { ContractGUI } from './ContractGUI';
import { ValueUI } from './ValueUI';
import type { Bus } from '../bus';
import { explorerUrlFor, openExplorerVia } from '../explorer';

interface Props {
  instance: DeployedInstance;
  bus: Bus;
  onRemove: () => void;
}

function shorten(addr: string): string {
  return addr.length < 14 ? addr : `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function isViewLike(fn: AbiEntry): boolean {
  return fn.stateMutability === 'view' || fn.stateMutability === 'pure';
}

function isPayable(fn: AbiEntry): boolean {
  return fn.stateMutability === 'payable' || !!fn.payable;
}

type RowResult = { kind: 'success' | 'error'; text: string } | null;

function formatResult(value: unknown): string {
  if (value === null || value === undefined) return '(no return value)';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function InstanceCard({ instance, bus, onRemove }: Props): JSX.Element {
  const [open, setOpen] = useState(true);
  const [perFnResult, setPerFnResult] = useState<Record<string, RowResult>>({});
  const [perFnBusy, setPerFnBusy] = useState<Record<string, boolean>>({});
  // Per-function payable value. Each payable fn keeps its own (value, unit)
  // since they're independent inputs — sharing one across the card would
  // silently send the wrong amount on the next click.
  const [perFnValue, setPerFnValue] = useState<Record<string, { value: string; unit: ValueUnit }>>({});
  const [llValue, setLlValue] = useState('0');
  const [llUnit, setLlUnit] = useState<ValueUnit>('wei');
  const [llData, setLlData] = useState('');
  const [llBusy, setLlBusy] = useState(false);
  const [llResult, setLlResult] = useState<RowResult>(null);

  // Verify status mirrors the persisted instance state but also reacts to live
  // verifyStarted/Log/Finished events so the user sees progress in real time
  // without waiting for the next status push.
  const [verifyState, setVerifyState] = useState<VerifyStatus>(instance.verifyStatus ?? 'idle');
  const [verifyError, setVerifyError] = useState<string | undefined>(instance.verifyError);
  const [verifyUrl, setVerifyUrl] = useState<string | undefined>(instance.verifyUrl);
  const [verifyLog, setVerifyLog] = useState<string[]>([]);
  const [verifyLogOpen, setVerifyLogOpen] = useState(false);

  useEffect(() => {
    setVerifyState(instance.verifyStatus ?? 'idle');
    setVerifyError(instance.verifyError);
    setVerifyUrl(instance.verifyUrl);
  }, [instance.verifyStatus, instance.verifyError, instance.verifyUrl]);

  useEffect(() => {
    const off = bus.on((evt: DeployRunEvent) => {
      if (
        (evt.kind === 'verifyStarted' ||
          evt.kind === 'verifyLog' ||
          evt.kind === 'verifyFinished') &&
        evt.instanceId !== instance.id
      ) {
        return;
      }
      if (evt.kind === 'verifyStarted') {
        setVerifyState('verifying');
        setVerifyError(undefined);
        setVerifyUrl(undefined);
        setVerifyLog([]);
      } else if (evt.kind === 'verifyLog') {
        setVerifyLog((prev) => prev.concat(evt.line).slice(-200));
      } else if (evt.kind === 'verifyFinished') {
        setVerifyState(evt.status);
        setVerifyError(evt.error);
        setVerifyUrl(evt.explorerUrl);
      }
    });
    return off;
  }, [bus, instance.id]);

  const functions = instance.abi.filter((e) => e.type === 'function');
  const fallback = instance.abi.find((e) => e.type === 'fallback');
  const receive = instance.abi.find((e) => e.type === 'receive');

  const explorerCtx = { chainId: instance.chainId, networkKind: instance.network };
  const explorerUrl = explorerUrlFor(explorerCtx, 'address', instance.address);
  const canVerify =
    !!explorerUrl &&
    !!instance.sourcePath &&
    !!instance.projectRoot &&
    instance.projectType === 'foundry';

  async function runFn(fn: AbiEntry, rawValues: string[]): Promise<void> {
    if (!fn.name) return;
    setPerFnBusy((b) => ({ ...b, [fn.name!]: true }));
    setPerFnResult((r) => ({ ...r, [fn.name!]: null }));
    try {
      // Resolve the payable value, if any. We compute it here (host-side
      // unit math) and convert before the request so the host receives a
      // canonical wei string and doesn't have to know about unit selection.
      let valueWei: string | undefined;
      if (isPayable(fn)) {
        const v = perFnValue[fn.name] ?? { value: '0', unit: 'wei' as ValueUnit };
        try {
          valueWei = valueToWei(v.value || '0', v.unit).toString();
        } catch {
          setPerFnResult((r) => ({
            ...r,
            [fn.name!]: { kind: 'error', text: `invalid value: ${v.value} ${v.unit}` },
          }));
          return;
        }
      }
      if (isViewLike(fn)) {
        const res = await bus.request({
          kind: 'callFunction',
          address: instance.address,
          abi: instance.abi,
          funcName: fn.name,
          argsRaw: rawValues,
        });
        if (res.kind === 'callResult') {
          setPerFnResult((r) => ({
            ...r,
            [fn.name!]: { kind: 'success', text: formatResult(res.payload.decoded) },
          }));
        } else if (res.kind === 'error') {
          setPerFnResult((r) => ({ ...r, [fn.name!]: { kind: 'error', text: res.message } }));
        }
      } else {
        const res = await bus.request({
          kind: 'sendTransaction',
          address: instance.address,
          abi: instance.abi,
          funcName: fn.name,
          argsRaw: rawValues,
          valueWei,
        });
        if (res.kind === 'sendResult') {
          const tx = res.payload.txEntry;
          const lines = [
            `status: ${tx.status}`,
            tx.txHash ? `tx: ${tx.txHash}` : '',
            tx.gasUsed ? `gas: ${tx.gasUsed}` : '',
            tx.decodedEvents && tx.decodedEvents.length
              ? `events: ${tx.decodedEvents.map((e) => e.name).join(', ')}`
              : '',
          ].filter(Boolean);
          setPerFnResult((r) => ({
            ...r,
            [fn.name!]: { kind: tx.status === 'success' ? 'success' : 'error', text: lines.join('\n') },
          }));
        } else if (res.kind === 'error') {
          setPerFnResult((r) => ({ ...r, [fn.name!]: { kind: 'error', text: res.message } }));
        }
      }
    } finally {
      setPerFnBusy((b) => ({ ...b, [fn.name!]: false }));
    }
  }

  async function runLowLevel(): Promise<void> {
    setLlBusy(true);
    setLlResult(null);
    try {
      const valueWei = valueToWei(llValue, llUnit).toString();
      const data = llData.trim();
      const isReceive = data === '' || data === '0x';
      const targetAbi = isReceive ? receive : fallback;
      if (!targetAbi) {
        setLlResult({
          kind: 'error',
          text: isReceive
            ? 'no receive() function — cannot accept ETH without calldata'
            : 'no fallback() function — cannot accept calldata',
        });
        return;
      }
      // We send via the fallback/receive name (which is missing) so we route through send.
      // Use a synthetic ABI entry to drive ethers — but ethers Contract requires a name.
      // Easiest path: build raw tx via sendTransaction with name="" — but ethers won't find it.
      // For V1, only support receive() (data = '0x', value > 0).
      // TODO: extend send path to accept raw calldata.
      setLlResult({
        kind: 'error',
        text:
          'low-level send is not implemented in V1 — use receive() by sending value with empty data is supported in V2',
      });
      void valueWei;
    } finally {
      setLlBusy(false);
    }
  }

  return (
    <div className="instance-card">
      <div className="instance-header" onClick={() => setOpen((o) => !o)}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className="name">{instance.name}</span>
        <span className="at-divider">@</span>
        <span className="addr" title={instance.address}>{shorten(instance.address)}</span>
        <span
          className="instance-net-tag"
          title={`Deployed on ${instance.network}`}
        >
          {instance.network}
        </span>
        <span style={{ marginLeft: 'auto' }} />
        {explorerUrl && (
          <button
            className="icon-btn"
            title="Open on block explorer"
            onClick={(e) => {
              e.stopPropagation();
              openExplorerVia(bus, explorerUrl);
            }}
          >
            ↗
          </button>
        )}
        <button
          className="icon-btn"
          title="Copy address"
          onClick={(e) => {
            e.stopPropagation();
            void navigator.clipboard.writeText(instance.address);
          }}
        >
          ⧉
        </button>
        <button
          className="icon-btn"
          title="Remove from list"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          ✕
        </button>
      </div>

      {open && (
        <div className="instance-body">
          {(canVerify || verifyState !== 'idle') && (
            <VerifySection
              status={verifyState}
              error={verifyError}
              url={verifyUrl}
              canVerify={canVerify}
              busy={verifyState === 'verifying'}
              onVerify={() =>
                void bus.request({ kind: 'verifyInstance', instanceId: instance.id })
              }
              onOpenUrl={(u) => openExplorerVia(bus, u)}
              logOpen={verifyLogOpen}
              onToggleLog={() => setVerifyLogOpen((v) => !v)}
              logLines={verifyLog}
            />
          )}
          {functions.length === 0 && (
            <div className="muted small">This contract exposes no functions.</div>
          )}
          {functions.map((fn) => {
            const fname = fn.name ?? '';
            const payable = isPayable(fn);
            const valueState = perFnValue[fname] ?? { value: '0', unit: 'wei' as ValueUnit };
            return (
              <ContractGUI
                key={fname + '/' + (fn.inputs?.length ?? 0)}
                funcAbi={fn}
                busy={!!perFnBusy[fname]}
                result={perFnResult[fname] ?? null}
                onSubmit={(raw) => runFn(fn, raw)}
                payableValue={
                  payable
                    ? {
                        value: valueState.value,
                        unit: valueState.unit,
                        onChange: (value, unit) =>
                          setPerFnValue((prev) => ({ ...prev, [fname]: { value, unit } })),
                      }
                    : undefined
                }
              />
            );
          })}

          <div className="lowlevel">
            <div className="ll-title">Low-level interactions</div>
            <ValueUI compact value={llValue} unit={llUnit} onChange={(v, u) => { setLlValue(v); setLlUnit(u); }} />
            <div className="fn-row" style={{ marginTop: 4 }}>
              <input
                type="text"
                className="vsc-input mono"
                placeholder="calldata (0x…)"
                value={llData}
                onChange={(e) => setLlData(e.target.value)}
                disabled={llBusy}
                style={{ flex: 1 }}
              />
              <button
                className="vsc-button send fn-btn"
                disabled={llBusy}
                onClick={() => void runLowLevel()}
              >
                Transact
              </button>
            </div>
            {llResult && <div className={`fn-result ${llResult.kind}`}>{llResult.text}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Verify subcomponent ───────────────────────────────────────────────

function statusLabelOf(s: VerifyStatus): string {
  switch (s) {
    case 'idle':             return 'not verified';
    case 'verifying':        return 'verifying…';
    case 'verified':         return 'verified';
    case 'already-verified': return 'already verified';
    case 'failed':           return 'failed';
  }
}

interface VerifySectionProps {
  status: VerifyStatus;
  error?: string;
  url?: string;
  canVerify: boolean;
  busy: boolean;
  onVerify: () => void;
  onOpenUrl: (url: string) => void;
  logOpen: boolean;
  onToggleLog: () => void;
  logLines: string[];
}

function VerifySection(props: VerifySectionProps): JSX.Element {
  const { status, error, url, canVerify, busy, onVerify, onOpenUrl, logOpen, onToggleLog, logLines } = props;
  const verified = status === 'verified' || status === 'already-verified';
  return (
    <div className={`verify-row v-${status}`}>
      <span className={`verify-pill v-${status}`}>{statusLabelOf(status)}</span>
      <span className="verify-spacer" />
      {logLines.length > 0 && (
        <button
          className="vsc-button small ghost"
          onClick={onToggleLog}
          title="Show verify output"
        >
          {logOpen ? 'hide log' : `log · ${logLines.length}`}
        </button>
      )}
      {verified && url && (
        <button
          className="vsc-button small ghost"
          onClick={() => onOpenUrl(url)}
          title="Open verified source on explorer"
        >
          view source ↗
        </button>
      )}
      <button
        className="vsc-button small"
        onClick={onVerify}
        disabled={busy || !canVerify}
        title={
          !canVerify
            ? 'Verification needs a foundry source path and a chain with an explorer.'
            : busy
              ? 'Already verifying…'
              : 'Verify source on the block explorer'
        }
      >
        {busy ? 'verifying…' : verified ? 're-verify' : 'verify'}
      </button>
      {error && !busy && (
        <div className="verify-error" title={error}>
          {error}
        </div>
      )}
      {logOpen && logLines.length > 0 && (
        <pre className="verify-log">{logLines.join('\n')}</pre>
      )}
    </div>
  );
}
