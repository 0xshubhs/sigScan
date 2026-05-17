import { valueToWei } from '../deploy-run-protocol';

describe('valueToWei', () => {
  it('returns 0n for empty', () => {
    expect(valueToWei('', 'wei')).toBe(0n);
    expect(valueToWei('   ', 'ether')).toBe(0n);
  });

  it('handles wei (no conversion)', () => {
    expect(valueToWei('1234567890', 'wei')).toBe(1234567890n);
    expect(valueToWei('0', 'wei')).toBe(0n);
  });

  it('handles gwei (×10^9)', () => {
    expect(valueToWei('1', 'gwei')).toBe(1_000_000_000n);
    expect(valueToWei('1.5', 'gwei')).toBe(1_500_000_000n);
  });

  it('handles ether (×10^18)', () => {
    expect(valueToWei('1', 'ether')).toBe(1_000_000_000_000_000_000n);
    expect(valueToWei('0.5', 'ether')).toBe(500_000_000_000_000_000n);
    expect(valueToWei('2.123', 'ether')).toBe(2_123_000_000_000_000_000n);
  });

  it('truncates fractional digits past the unit precision', () => {
    // 1 wei worth of "ether" fractional precision = 1e-18 ether; anything beyond
    // 18 fractional digits is truncated, not rounded
    expect(valueToWei('1.0000000000000000005', 'ether')).toBe(1_000_000_000_000_000_000n);
  });

  it('rejects non-numeric values', () => {
    expect(() => valueToWei('abc', 'wei')).toThrow(/invalid numeric/);
    expect(() => valueToWei('1.2.3', 'ether')).toThrow(/invalid numeric/);
  });

  it('handles negative values (signed)', () => {
    expect(valueToWei('-1', 'gwei')).toBe(-1_000_000_000n);
  });
});
