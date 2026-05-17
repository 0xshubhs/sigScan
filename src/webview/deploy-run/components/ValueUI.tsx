import type { ValueUnit } from '../../../shared/deploy-run-protocol';

interface Props {
  value: string;
  unit: ValueUnit;
  onChange: (value: string, unit: ValueUnit) => void;
  compact?: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

export function ValueUI({ value, unit, onChange, compact = false, disabled = false, disabledReason }: Props): JSX.Element {
  return (
    <div className="row" style={{ flex: 1, opacity: disabled ? 0.55 : 1 }} title={disabled ? disabledReason : undefined}>
      {!compact && <label className="row-label">Value</label>}
      <input
        type="text"
        inputMode="decimal"
        className="vsc-input mono"
        placeholder={disabled ? 'non-payable' : '0'}
        value={value}
        onChange={(e) => !disabled && onChange(e.target.value, unit)}
        disabled={disabled}
        style={{ minWidth: 0 }}
      />
      <select
        className="vsc-select"
        value={unit}
        onChange={(e) => !disabled && onChange(value, e.target.value as ValueUnit)}
        disabled={disabled}
        style={{ maxWidth: 84, flex: '0 0 auto' }}
      >
        <option value="wei">Wei</option>
        <option value="gwei">Gwei</option>
        <option value="ether">Ether</option>
      </select>
    </div>
  );
}
