/**
 * Epoch/timestamp conversions (eth.sh "Epoch Converter") — Unix seconds and
 * milliseconds, ISO/UTC/local rendering, relative time, and Solidity-friendly
 * duration constants.
 */

export interface EpochInfo {
  /** Unix timestamp in seconds. */
  seconds: number;
  /** How the raw input was understood (e.g. "unix seconds", "ISO date"). */
  interpretedAs: string;
}

/**
 * Parse user input into an epoch. Accepts unix seconds, unix milliseconds
 * (heuristic: ≥ 10^12), hex timestamps (common in RPC block responses),
 * "now", and anything `Date.parse` understands (ISO 8601 etc.).
 */
export function parseEpochInput(raw: string, nowMs: number): EpochInfo | null {
  const input = raw.trim();
  if (input === '') {
    return null;
  }

  if (/^now$/i.test(input)) {
    return { seconds: Math.floor(nowMs / 1000), interpretedAs: 'current time' };
  }
  if (/^0x[0-9a-fA-F]+$/.test(input)) {
    const value = Number(BigInt(input));
    if (!Number.isSafeInteger(value)) {
      return null;
    }
    return {
      seconds: value >= 1e12 ? Math.floor(value / 1000) : value,
      interpretedAs: 'hex timestamp',
    };
  }
  if (/^\d+$/.test(input)) {
    const value = Number(input);
    if (!Number.isSafeInteger(value)) {
      return null;
    }
    return value >= 1e12
      ? { seconds: Math.floor(value / 1000), interpretedAs: 'unix milliseconds' }
      : { seconds: value, interpretedAs: 'unix seconds' };
  }
  const parsed = Date.parse(input);
  if (!Number.isNaN(parsed)) {
    return { seconds: Math.floor(parsed / 1000), interpretedAs: 'date string' };
  }
  return null;
}

/** Human-readable "in 3 days" / "5 minutes ago" relative to `nowMs`. */
export function relativeTime(seconds: number, nowMs: number): string {
  const deltaSeconds = seconds - Math.floor(nowMs / 1000);
  const abs = Math.abs(deltaSeconds);
  const units: Array<[limit: number, divisor: number, unit: string]> = [
    [60, 1, 'second'],
    [3600, 60, 'minute'],
    [86400, 3600, 'hour'],
    [86400 * 30, 86400, 'day'],
    [86400 * 365, 86400 * 30, 'month'],
    [Infinity, 86400 * 365, 'year'],
  ];
  for (const [limit, divisor, unit] of units) {
    if (abs < limit) {
      const count = Math.max(1, Math.floor(abs / divisor));
      const noun = count === 1 ? unit : `${unit}s`;
      if (abs < 2) {
        return 'now';
      }
      return deltaSeconds > 0 ? `in ${count} ${noun}` : `${count} ${noun} ago`;
    }
  }
  return 'never';
}

/** All the renderings of one epoch worth offering in the picker. */
export function describeEpoch(
  info: EpochInfo,
  nowMs: number
): Array<{ label: string; value: string }> {
  const date = new Date(info.seconds * 1000);
  return [
    { label: 'Unix seconds', value: String(info.seconds) },
    { label: 'Unix milliseconds', value: String(info.seconds * 1000) },
    { label: 'Hex (block.timestamp)', value: `0x${info.seconds.toString(16)}` },
    { label: 'UTC', value: date.toUTCString() },
    { label: 'ISO 8601', value: date.toISOString() },
    { label: 'Local', value: date.toString() },
    { label: 'Relative', value: relativeTime(info.seconds, nowMs) },
  ];
}

/** Solidity duration literals — handy when writing timelocks/vesting. */
export function durationConstants(): Array<{ name: string; seconds: number }> {
  return [
    { name: '1 minutes', seconds: 60 },
    { name: '1 hours', seconds: 3600 },
    { name: '1 days', seconds: 86400 },
    { name: '1 weeks', seconds: 604800 },
    { name: '30 days', seconds: 2592000 },
    { name: '365 days', seconds: 31536000 },
  ];
}
