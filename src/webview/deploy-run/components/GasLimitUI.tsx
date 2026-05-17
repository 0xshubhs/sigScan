import { useEffect, useState } from 'react';

interface Props {
  // null = auto (don't set in tx); string = manual override
  value: string | null;
  onChange: (v: string | null) => void;
}

export function GasLimitUI({ value, onChange }: Props): JSX.Element {
  const auto = value === null;
  const [manualVal, setManualVal] = useState(value ?? '3000000');

  useEffect(() => {
    if (value !== null) setManualVal(value);
  }, [value]);

  return (
    <div className="row" style={{ flex: 1 }}>
      <label className="row-label">Gas Limit</label>
      <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <input
          type="radio"
          checked={auto}
          onChange={() => onChange(null)}
        />
        Auto
      </label>
      <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <input
          type="radio"
          checked={!auto}
          onChange={() => onChange(manualVal)}
        />
        Manual
      </label>
      <input
        type="text"
        inputMode="numeric"
        className="vsc-input mono"
        disabled={auto}
        value={manualVal}
        onChange={(e) => {
          setManualVal(e.target.value);
          if (!auto) onChange(e.target.value);
        }}
        style={{ flex: 1, minWidth: 60 }}
      />
    </div>
  );
}
