/**
 * Keccak-256 hashing helpers — selectors, event topics, EIP-55 checksums.
 *
 * Uses js-sha3 directly (already a production dependency) so these helpers
 * stay decoupled from ethers and cheap to load.
 */

import { keccak_256 } from 'js-sha3';
import { add0x, hexToBytes, isHexString, strip0x } from './hex';

/** keccak256 of raw bytes, `0x`-prefixed. */
export function keccakBytes(bytes: Uint8Array): string {
  return add0x(keccak_256(bytes));
}

/** keccak256 of a UTF-8 string (the `keccak256(bytes(s))` most tools mean). */
export function keccakUtf8(text: string): string {
  return add0x(keccak_256(text));
}

/** keccak256 of a hex blob's bytes. */
export function keccakHex(hex: string): string {
  return keccakBytes(hexToBytes(hex));
}

/**
 * 4-byte function selector for an already-canonical signature like
 * `transfer(address,uint256)`. (Alias expansion — `uint` → `uint256` — is the
 * signature parser's job; see sig.ts.)
 */
export function selectorOfCanonicalSignature(signature: string): string {
  return keccakUtf8(signature).slice(0, 10);
}

/** 32-byte topic0 for an already-canonical event signature. */
export function topic0OfCanonicalSignature(signature: string): string {
  return keccakUtf8(signature);
}

/** EIP-55 mixed-case checksum encoding of a 20-byte address. */
export function toChecksumAddress(address: string): string {
  if (!isHexString(address, 20)) {
    throw new Error(`Not a 20-byte address: ${address}`);
  }
  const body = strip0x(address).toLowerCase();
  const hash = keccak_256(body);
  let out = '0x';
  for (let i = 0; i < body.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? body[i].toUpperCase() : body[i];
  }
  return out;
}

/** True when `address` is 20-byte hex; if mixed-case, the EIP-55 checksum must be valid. */
export function isValidAddress(address: string): boolean {
  if (!isHexString(address, 20)) {
    return false;
  }
  const body = strip0x(address);
  const hasUpper = /[A-F]/.test(body);
  const hasLower = /[a-f]/.test(body);
  if (!(hasUpper && hasLower)) {
    return true;
  } // all one case — no checksum encoded
  return toChecksumAddress(address).slice(2) === body;
}
