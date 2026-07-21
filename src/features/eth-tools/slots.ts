/**
 * Storage-slot calculators (eth.sh "Storage Slots"):
 *  - Solidity mapping / dynamic-array slot derivation
 *  - EIP-1967 / EIP-1822 proxy slots (computed from their defining formulas)
 *  - ERC-7201 namespaced storage roots
 */

import { keccak_256 } from 'js-sha3';
import {
  add0x,
  bigIntToHex,
  hexToBigInt,
  hexToBytes,
  isHexString,
  padLeft,
  utf8ToHex,
  concatHex,
} from './hex';

const MASK_256 = (1n << 256n) - 1n;

function keccakHexBlob(hex: string): string {
  return add0x(keccak_256(hexToBytes(hex)));
}

/** Key types supported by the mapping-slot calculator. */
export type MappingKeyType =
  'address' | 'uint256' | 'int256' | 'bytes32' | 'bool' | 'string' | 'bytes';

/** ABI-encode a mapping key per Solidity storage rules (value types pad to 32; string/bytes stay raw). */
export function encodeMappingKey(keyType: MappingKeyType, key: string): string {
  const trimmed = key.trim();
  switch (keyType) {
    case 'address': {
      if (!isHexString(trimmed, 20)) {
        throw new Error(`Not a 20-byte address: ${key}`);
      }
      return padLeft(trimmed, 32);
    }
    case 'uint256': {
      const value = trimmed.startsWith('0x') ? hexToBigInt(trimmed) : BigInt(trimmed);
      if (value < 0n) {
        throw new Error('uint256 key cannot be negative');
      }
      return padLeft(bigIntToHex(value), 32);
    }
    case 'int256': {
      const value = trimmed.startsWith('0x') ? hexToBigInt(trimmed) : BigInt(trimmed);
      return padLeft(bigIntToHex(value < 0n ? (value + (1n << 256n)) & MASK_256 : value), 32);
    }
    case 'bytes32': {
      if (!isHexString(trimmed) || hexToBytes(trimmed).length > 32) {
        throw new Error(`Not a bytes32 value: ${key}`);
      }
      return padLeft(trimmed, 32);
    }
    case 'bool': {
      if (trimmed !== 'true' && trimmed !== 'false') {
        throw new Error('bool key must be "true" or "false"');
      }
      return padLeft(trimmed === 'true' ? '0x01' : '0x00', 32);
    }
    case 'string':
      return utf8ToHex(key); // NOT padded — string keys hash their raw bytes
    case 'bytes': {
      if (!isHexString(trimmed)) {
        throw new Error(`Not a hex byte string: ${key}`);
      }
      return add0x(trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed); // NOT padded
    }
  }
}

/** Slot of `mapping(keyType => v)` entry: keccak256(encodedKey ++ pad32(baseSlot)). */
export function mappingEntrySlot(keyType: MappingKeyType, key: string, baseSlot: bigint): string {
  const encodedKey = encodeMappingKey(keyType, key);
  return keccakHexBlob(concatHex([encodedKey, padLeft(bigIntToHex(baseSlot), 32)]));
}

/** First data slot of a dynamic array at `baseSlot`: keccak256(pad32(baseSlot)). */
export function dynamicArrayDataSlot(baseSlot: bigint): string {
  return keccakHexBlob(padLeft(bigIntToHex(baseSlot), 32));
}

/** Slot of element `index` given `slotsPerElement` (1 for word-sized elements). */
export function dynamicArrayElementSlot(
  baseSlot: bigint,
  index: bigint,
  slotsPerElement = 1n
): string {
  const dataSlot = hexToBigInt(dynamicArrayDataSlot(baseSlot));
  return padLeft(bigIntToHex((dataSlot + index * slotsPerElement) & MASK_256), 32);
}

/** ERC-7201: keccak256(abi.encode(uint256(keccak256(id)) - 1)) & ~bytes32(uint256(0xff)). */
export function erc7201Slot(namespaceId: string): string {
  const inner = (hexToBigInt(add0x(keccak_256(namespaceId))) - 1n) & MASK_256;
  const outer = hexToBigInt(keccakHexBlob(padLeft(bigIntToHex(inner), 32)));
  return padLeft(bigIntToHex(outer & ~0xffn), 32);
}

/** keccak256(label) - 1 — the EIP-1967 slot-derivation formula. */
function eip1967Slot(label: string): string {
  return padLeft(bigIntToHex((hexToBigInt(add0x(keccak_256(label))) - 1n) & MASK_256), 32);
}

/** Well-known proxy storage slots, computed from their defining strings. */
export function wellKnownSlots(): Array<{ name: string; formula: string; slot: string }> {
  return [
    {
      name: 'EIP-1967 implementation',
      formula: "keccak256('eip1967.proxy.implementation') - 1",
      slot: eip1967Slot('eip1967.proxy.implementation'),
    },
    {
      name: 'EIP-1967 admin',
      formula: "keccak256('eip1967.proxy.admin') - 1",
      slot: eip1967Slot('eip1967.proxy.admin'),
    },
    {
      name: 'EIP-1967 beacon',
      formula: "keccak256('eip1967.proxy.beacon') - 1",
      slot: eip1967Slot('eip1967.proxy.beacon'),
    },
    {
      name: 'EIP-1822 (UUPS) proxiable',
      formula: "keccak256('PROXIABLE')",
      slot: add0x(keccak_256('PROXIABLE')),
    },
    {
      name: 'OpenZeppelin Initializable (ERC-7201)',
      formula: "erc7201('openzeppelin.storage.Initializable')",
      slot: erc7201Slot('openzeppelin.storage.Initializable'),
    },
  ];
}
