/**
 * Hex utilities for the EVM toolbox — zero-dependency helpers shared by the
 * converter, hasher, address calculators, and calldata codecs.
 *
 * All functions accept hex with or without a `0x` prefix and return
 * lowercase `0x`-prefixed hex unless stated otherwise.
 */

/** True if `value` is a hex string (optionally `0x`-prefixed). `byteLength` pins the exact size. */
export function isHexString(value: string, byteLength?: number): boolean {
  const body = strip0x(value.trim());
  if (body.length === 0 || body.length % 2 !== 0) {
    return false;
  }
  if (!/^[0-9a-fA-F]+$/.test(body)) {
    return false;
  }
  return byteLength === undefined || body.length === byteLength * 2;
}

/** Loose check used to decide whether user input "looks like" hex (odd lengths allowed). */
export function looksLikeHex(value: string): boolean {
  const trimmed = value.trim();
  return /^0x[0-9a-fA-F]*$/.test(trimmed) || /^[0-9a-fA-F]{6,}$/.test(trimmed);
}

export function strip0x(value: string): string {
  return value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
}

export function add0x(value: string): string {
  return value.startsWith('0x') || value.startsWith('0X') ? `0x${strip0x(value)}` : `0x${value}`;
}

/** Normalize to lowercase, `0x`-prefixed, even-length hex. Throws on non-hex input. */
export function normalizeHex(value: string): string {
  let body = strip0x(value.trim()).toLowerCase();
  if (body.length % 2 !== 0) {
    body = `0${body}`;
  }
  if (body.length > 0 && !/^[0-9a-f]+$/.test(body)) {
    throw new Error(`Not a hex string: ${value}`);
  }
  return `0x${body}`;
}

export function hexToBytes(hex: string): Uint8Array {
  const body = strip0x(normalizeHex(hex));
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array | number[]): string {
  let out = '0x';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

export function utf8ToHex(text: string): string {
  return bytesToHex(new TextEncoder().encode(text));
}

/** Decode hex as UTF-8. Returns null when the bytes are not valid UTF-8 text. */
export function hexToUtf8(hex: string): string | null {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(hexToBytes(hex));
    // Reject strings with control characters (other than tab/newline) — they
    // decode "successfully" but are almost never intended as text.
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

export function hexToBigInt(hex: string): bigint {
  const body = strip0x(hex.trim());
  if (body.length === 0) {
    return 0n;
  }
  return BigInt(add0x(body));
}

/** Minimal (no leading zero) hex representation of a non-negative bigint. */
export function bigIntToHex(value: bigint): string {
  if (value < 0n) {
    throw new Error('Negative values have no canonical hex representation');
  }
  return `0x${value.toString(16)}`;
}

/** Left-pad hex to `bytes` (default 32) — the EVM word padding for value types. */
export function padLeft(hex: string, bytes = 32): string {
  const body = strip0x(normalizeHex(hex));
  if (body.length > bytes * 2) {
    throw new Error(`Value longer than ${bytes} bytes: ${hex}`);
  }
  return `0x${body.padStart(bytes * 2, '0')}`;
}

/** Right-pad hex to `bytes` (default 32) — the EVM padding for bytesN literals. */
export function padRight(hex: string, bytes = 32): string {
  const body = strip0x(normalizeHex(hex));
  if (body.length > bytes * 2) {
    throw new Error(`Value longer than ${bytes} bytes: ${hex}`);
  }
  return `0x${body.padEnd(bytes * 2, '0')}`;
}

/** Concatenate hex strings into one `0x` blob. */
export function concatHex(parts: string[]): string {
  return `0x${parts.map((p) => strip0x(normalizeHex(p))).join('')}`;
}
