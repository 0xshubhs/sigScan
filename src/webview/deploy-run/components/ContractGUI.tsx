import { useState } from 'react';
import type { AbiEntry } from '../../../shared/deploy-run-protocol';

type ButtonClass = 'view' | 'send' | 'payable';

export interface ContractGUIProps {
  funcAbi: AbiEntry;
  isDeploy?: boolean;
  busy?: boolean;
  buttonLabel?: string;       // override (e.g. "Deploy", "Transact")
  onSubmit: (rawValues: string[]) => void | Promise<unknown>;
  // Optional "show last result" hook from the parent (decoded return for view calls etc.)
  result?: { kind: 'success' | 'error'; text: string } | null;
}

function classify(funcAbi: AbiEntry, isDeploy: boolean | undefined): ButtonClass {
  if (isDeploy) {
    return funcAbi.stateMutability === 'payable' || funcAbi.payable ? 'payable' : 'send';
  }
  const mut = funcAbi.stateMutability;
  if (mut === 'view' || mut === 'pure') return 'view';
  if (mut === 'payable' || funcAbi.payable) return 'payable';
  return 'send';
}

function buttonText(funcAbi: AbiEntry, kind: ButtonClass, isDeploy: boolean | undefined, override?: string): string {
  if (override) return override;
  if (isDeploy) return 'Deploy';
  if (kind === 'view') return funcAbi.name ?? 'call';
  if (kind === 'payable') return funcAbi.name ?? 'transact';
  return funcAbi.name ?? 'transact';
}

function inputPlaceholder(inputs: { name?: string; type: string }[]): string {
  return inputs
    .map((i) => (i.name ? `${i.type} ${i.name}` : i.type))
    .join(', ');
}

export function ContractGUI(props: ContractGUIProps): JSX.Element {
  const { funcAbi, isDeploy, busy, result } = props;
  const inputs = funcAbi.inputs ?? [];
  const hasArgs = inputs.length > 0;
  const kind = classify(funcAbi, isDeploy);
  const label = buttonText(funcAbi, kind, isDeploy, props.buttonLabel);
  const cls = `vsc-button fn-btn ${kind}`;

  const [expanded, setExpanded] = useState(false);
  const [inline, setInline] = useState('');
  const [perArg, setPerArg] = useState<string[]>(() => inputs.map(() => ''));

  function readValues(): string[] {
    if (!hasArgs) return [];
    if (expanded) return perArg;
    // From a comma-separated inline string. Parsing happens host-side via parseFunctionParams.
    // We still need to pass an *array* — so split shallow: respect quotes & brackets.
    return [inline];
  }

  async function onClick(): Promise<void> {
    await props.onSubmit(readValues());
  }

  return (
    <div>
      <div className="fn-row">
        <button type="button" className={cls} disabled={busy} onClick={onClick} title={funcAbi.name ?? ''}>
          {busy ? '…' : label}
        </button>
        {hasArgs && !expanded && (
          <input
            type="text"
            className="vsc-input fn-inline mono"
            placeholder={inputPlaceholder(inputs)}
            value={inline}
            onChange={(e) => setInline(e.target.value)}
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onClick();
            }}
          />
        )}
        {hasArgs && (
          <button
            type="button"
            className="caret-toggle small"
            onClick={() => {
              if (!expanded && inline.trim()) {
                // crude split — host-side parseFunctionParams handles full parsing,
                // but on toggle-to-expanded we just seed the first field with the inline value
                setPerArg((prev) => {
                  const next = [...prev];
                  next[0] = inline;
                  return next;
                });
              }
              setExpanded((v) => !v);
            }}
            title={expanded ? 'Collapse' : 'Expand per-arg'}
          >
            {expanded ? '▴' : '▾'}
          </button>
        )}
      </div>

      {hasArgs && expanded && (
        <div className="fn-expanded">
          {inputs.map((inp: { name?: string; type: string }, idx: number) => (
            <div className="arg-row" key={idx}>
              <span className="arg-label">{inp.type}{inp.name ? ` ${inp.name}` : ''}</span>
              <input
                type="text"
                className="vsc-input mono"
                placeholder={inp.type}
                value={perArg[idx] ?? ''}
                onChange={(e) =>
                  setPerArg((prev) => {
                    const next = [...prev];
                    next[idx] = e.target.value;
                    return next;
                  })
                }
                disabled={busy}
                style={{ flex: 1 }}
              />
            </div>
          ))}
        </div>
      )}

      {result && (
        <div className={`fn-result ${result.kind}`}>{result.text}</div>
      )}
    </div>
  );
}
