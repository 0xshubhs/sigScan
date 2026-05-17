import { useState } from 'react';
import type {
  AbiEntry,
  DeployedInstance,
  ValueUnit,
} from '../../../shared/deploy-run-protocol';
import { valueToWei } from '../../../shared/deploy-run-protocol';
import { ContractGUI } from './ContractGUI';
import { ValueUI } from './ValueUI';
import type { Bus } from '../bus';

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
  const [llValue, setLlValue] = useState('0');
  const [llUnit, setLlUnit] = useState<ValueUnit>('wei');
  const [llData, setLlData] = useState('');
  const [llBusy, setLlBusy] = useState(false);
  const [llResult, setLlResult] = useState<RowResult>(null);

  const functions = instance.abi.filter((e) => e.type === 'function');
  const fallback = instance.abi.find((e) => e.type === 'fallback');
  const receive = instance.abi.find((e) => e.type === 'receive');

  async function runFn(fn: AbiEntry, rawValues: string[]): Promise<void> {
    if (!fn.name) return;
    setPerFnBusy((b) => ({ ...b, [fn.name!]: true }));
    setPerFnResult((r) => ({ ...r, [fn.name!]: null }));
    try {
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
        <span style={{ marginLeft: 'auto' }} />
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
          {functions.length === 0 && (
            <div className="muted small">This contract exposes no functions.</div>
          )}
          {functions.map((fn) => (
            <ContractGUI
              key={fn.name + '/' + (fn.inputs?.length ?? 0)}
              funcAbi={fn}
              busy={!!perFnBusy[fn.name ?? '']}
              result={perFnResult[fn.name ?? ''] ?? null}
              onSubmit={(raw) => runFn(fn, raw)}
            />
          ))}

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
