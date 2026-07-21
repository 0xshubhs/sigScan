/**
 * Deterministic contract-address calculators (eth.sh "Determine Address"):
 *  - CREATE:  keccak256(rlp([sender, nonce]))[12:]
 *  - CREATE2: keccak256(0xff ++ deployer ++ salt ++ keccak256(initCode))[12:]
 *
 * RLP here is a minimal encoder for the exact [address, nonce] shape CREATE
 * needs — not a general-purpose RLP implementation.
 */

import { keccak_256 } from 'js-sha3';
import { add0x, concatHex, hexToBytes, isHexString, padLeft } from './hex';
import { toChecksumAddress } from './hash';

/** RLP-encode a byte string (no list support needed beyond encodeRlpList). */
function rlpEncodeBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 1 && bytes[0] < 0x80) {
    return bytes;
  }
  if (bytes.length <= 55) {
    const out = new Uint8Array(bytes.length + 1);
    out[0] = 0x80 + bytes.length;
    out.set(bytes, 1);
    return out;
  }
  throw new Error('RLP payload longer than 55 bytes is not needed for CREATE');
}

/** Minimal big-endian byte representation of a non-negative bigint (empty for 0 — RLP's zero). */
function nonceToBytes(nonce: bigint): Uint8Array {
  if (nonce < 0n) {
    throw new Error('Nonce cannot be negative');
  }
  if (nonce === 0n) {
    return new Uint8Array(0);
  }
  let hexBody = nonce.toString(16);
  if (hexBody.length % 2 !== 0) {
    hexBody = `0${hexBody}`;
  }
  return hexToBytes(add0x(hexBody));
}

/** Address a contract will get when `deployer` CREATEs at `nonce`. */
export function computeCreateAddress(deployer: string, nonce: bigint): string {
  if (!isHexString(deployer, 20)) {
    throw new Error(`Deployer must be a 20-byte address: ${deployer}`);
  }
  const encodedAddress = rlpEncodeBytes(hexToBytes(deployer));
  const encodedNonce = rlpEncodeBytes(nonceToBytes(nonce));
  const payloadLength = encodedAddress.length + encodedNonce.length;
  const list = new Uint8Array(payloadLength + 1);
  list[0] = 0xc0 + payloadLength;
  list.set(encodedAddress, 1);
  list.set(encodedNonce, 1 + encodedAddress.length);
  return toChecksumAddress(add0x(keccak_256(list).slice(-40)));
}

/**
 * Address a contract will get from CREATE2. `salt` is left-padded to 32 bytes;
 * pass `initCodeHash` directly when you already have it (verifiers often do).
 */
export function computeCreate2Address(
  deployer: string,
  salt: string,
  initCodeHash: string
): string {
  if (!isHexString(deployer, 20)) {
    throw new Error(`Deployer must be a 20-byte address: ${deployer}`);
  }
  if (!isHexString(initCodeHash, 32)) {
    throw new Error(`initCodeHash must be 32 bytes: ${initCodeHash}`);
  }
  const blob = concatHex([add0x('ff'), deployer, padLeft(salt, 32), initCodeHash]);
  return toChecksumAddress(add0x(keccak_256(hexToBytes(blob)).slice(-40)));
}

/** CREATE2 convenience taking full init code (constructor bytecode + args). */
export function computeCreate2AddressFromInitCode(
  deployer: string,
  salt: string,
  initCode: string
): string {
  const initCodeHash = add0x(keccak_256(hexToBytes(initCode)));
  return computeCreate2Address(deployer, salt, initCodeHash);
}
