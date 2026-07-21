/**
 * Ether unit conversion — exact decimal math on bigint, no floating point.
 *
 * Backs the "Convert Value" toolbox command (eth.sh-converter-style): the user
 * types a number once and every plausible interpretation (wei / gwei / ether /
 * hex) is offered with its full conversion set.
 */

import { bigIntToHex, hexToBigInt, looksLikeHex } from './hex';

/** Unit name → decimal places relative to wei. */
export const ETH_UNITS: Record<string, number> = {
  wei: 0,
  kwei: 3,
  babbage: 3,
  mwei: 6,
  lovelace: 6,
  gwei: 9,
  shannon: 9,
  szabo: 12,
  microether: 12,
  finney: 15,
  milliether: 15,
  ether: 18,
  eth: 18,
};

/** The units worth displaying in conversion output (aliases collapsed). */
const DISPLAY_UNITS: Array<{ name: string; decimals: number }> = [
  { name: 'wei', decimals: 0 },
  { name: 'gwei', decimals: 9 },
  { name: 'ether', decimals: 18 },
];

/**
 * Parse an exact decimal string (e.g. "1.5") into an integer scaled by
 * 10^decimals. Throws when the fractional part is longer than `decimals`
 * (the value would not be representable exactly).
 */
export function parseDecimal(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match || (match[2] === '' && (match[3] === undefined || match[3] === ''))) {
    throw new Error(`Not a decimal number: ${value}`);
  }
  const [, sign, wholeRaw, fractionRaw = ''] = match;
  const fraction = fractionRaw.replace(/0+$/, '');
  if (fraction.length > decimals) {
    throw new Error(`Too many decimal places for a ${decimals}-decimal unit: ${value}`);
  }
  const whole = wholeRaw === '' ? '0' : wholeRaw;
  const scaled =
    BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  return sign === '-' ? -scaled : scaled;
}

/** Format a wei-scaled integer as an exact decimal string in the given unit. */
export function formatUnits(wei: bigint, decimals: number): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  const body = fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
  return negative ? `-${body}` : body;
}

/** One row of conversion output. */
export interface ConversionRow {
  /** e.g. "1.5 ether" — what the input was interpreted as. */
  interpretation: string;
  /** Unit name → exact value string, plus `hex` for the wei value. */
  values: Array<{ unit: string; value: string }>;
}

/**
 * Build every sensible interpretation of a raw user input:
 *  - hex input → wei (plus decimal, gwei, ether)
 *  - integer input → interpreted as wei, gwei, and ether
 *  - fractional input → interpreted as gwei and ether (fractional wei is meaningless)
 * Returns an empty array when the input parses as nothing numeric.
 */
export function buildConversions(raw: string): ConversionRow[] {
  const input = raw.trim();
  if (input === '') {
    return [];
  }

  const rows: ConversionRow[] = [];

  if (looksLikeHex(input) && input.toLowerCase().startsWith('0x')) {
    try {
      const wei = hexToBigInt(input);
      rows.push(conversionRow(`${input} (hex) as wei`, wei));
    } catch {
      /* not hex after all */
    }
    return rows;
  }

  // Optional "<number> <unit>" form: "1.5 eth", "2000gwei".
  const unitMatch = /^(-?[\d.]+)\s*([a-zA-Z]+)$/.exec(input);
  if (unitMatch) {
    const decimals = ETH_UNITS[unitMatch[2].toLowerCase()];
    if (decimals === undefined) {
      return [];
    }
    try {
      const wei = parseDecimal(unitMatch[1], decimals);
      rows.push(conversionRow(`${unitMatch[1]} ${unitMatch[2].toLowerCase()}`, wei));
    } catch {
      /* unrepresentable */
    }
    return rows;
  }

  for (const { name, decimals } of DISPLAY_UNITS) {
    try {
      const wei = parseDecimal(input, decimals);
      rows.push(conversionRow(`${input} ${name}`, wei));
    } catch {
      /* skip units that can't represent the input exactly */
    }
  }
  return rows;
}

function conversionRow(interpretation: string, wei: bigint): ConversionRow {
  const values: Array<{ unit: string; value: string }> = DISPLAY_UNITS.map(
    ({ name, decimals }) => ({
      unit: name,
      value: formatUnits(wei, decimals),
    })
  );
  if (wei >= 0n) {
    values.push({ unit: 'hex', value: bigIntToHex(wei) });
  }
  return { interpretation, values };
}
