/**
 * Calldata / ABI encoders — the write-side of the toolbox.
 *
 * Signatures are accepted in human form (`transfer(address to, uint256 amount)`,
 * with or without the `function` keyword) and canonicalized by ethers.
 * Argument strings are parsed with the battle-tested Remix parser already in
 * this repo (quotes, nested arrays/tuples), and uint arguments additionally
 * accept `1.5 ether` / `9 gwei` style values.
 */

import { AbiCoder, FunctionFragment, ParamType, solidityPacked } from 'ethers';
import { parseFunctionParams } from '../remix-port';
import { ETH_UNITS, parseDecimal } from './units';

export interface ParsedSignature {
  fragment: FunctionFragment;
  /** Canonical signature, e.g. `transfer(address,uint256)`. */
  canonical: string;
  selector: string;
}

/** Parse a human-readable function signature into its canonical form + selector. */
export function parseHumanSignature(input: string): ParsedSignature {
  const trimmed = input.trim().replace(/;$/, '');
  const withKeyword = /^function\s/.test(trimmed) ? trimmed : `function ${trimmed}`;
  const fragment = FunctionFragment.from(withKeyword);
  return { fragment, canonical: fragment.format('sighash'), selector: fragment.selector };
}

/** Parse a Remix-style argument string (`0xabc…, [1, 2], "hi"`) into raw values. */
export function parseArgString(argsRaw: string): unknown[] {
  const trimmed = argsRaw.trim();
  if (trimmed === '') {
    return [];
  }
  return parseFunctionParams(trimmed);
}

/** `2 ether` / `3.5 gwei` / `100 wei` support for uint arguments. */
function parseUnitSuffixed(value: string): string | null {
  const match = /^([\d.]+)\s*([a-zA-Z]+)$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const decimals = ETH_UNITS[match[2].toLowerCase()];
  if (decimals === undefined) {
    return null;
  }
  try {
    return parseDecimal(match[1], decimals).toString(10);
  } catch {
    return null;
  }
}

/** Coerce string leaves into what the ABI coder expects for `param`. */
function coerceValue(param: ParamType, value: unknown): unknown {
  if (param.baseType === 'array' && Array.isArray(value)) {
    return value.map((v) => coerceValue(param.arrayChildren as ParamType, v));
  }
  if (param.baseType === 'tuple' && param.components && Array.isArray(value)) {
    return value.map((v, i) => coerceValue((param.components as readonly ParamType[])[i], v));
  }
  if (param.baseType === 'bool' && typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered !== 'true' && lowered !== 'false') {
      throw new Error(`bool argument must be true or false, got: ${value}`);
    }
    return lowered === 'true';
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^u?int\d*$/.test(param.type)) {
      const unitValue = parseUnitSuffixed(trimmed);
      if (unitValue !== null) {
        return unitValue;
      }
    }
    return trimmed;
  }
  return value;
}

function coerceAll(params: readonly ParamType[], values: unknown[]): unknown[] {
  if (values.length !== params.length) {
    throw new Error(
      `Expected ${params.length} argument${params.length === 1 ? '' : 's'}, got ${values.length}.`
    );
  }
  return values.map((v, i) => coerceValue(params[i], v));
}

export interface EncodedCalldata {
  canonical: string;
  selector: string;
  calldata: string;
  /** Bytes of the full calldata (selector + args). */
  byteLength: number;
}

/** Encode full calldata for a function call from a signature + argument string. */
export function encodeFunctionCallData(signatureInput: string, argsRaw: string): EncodedCalldata {
  const { fragment, canonical, selector } = parseHumanSignature(signatureInput);
  const args = coerceAll(fragment.inputs, parseArgString(argsRaw));
  const encodedArgs = AbiCoder.defaultAbiCoder().encode(fragment.inputs, args);
  const calldata = selector + encodedArgs.slice(2);
  return { canonical, selector, calldata, byteLength: (calldata.length - 2) / 2 };
}

/** Split a comma-separated type list at the top level (`uint256, (address,bytes)[]` → 2 entries). */
export function splitTopLevelTypes(typeList: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of typeList) {
    if (ch === '(' || ch === '[') {
      depth++;
    } else if (ch === ')' || ch === ']') {
      depth--;
    }
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') {
    out.push(current.trim());
  }
  return out.filter((t) => t.length > 0).map((t) => (t.startsWith('(') ? `tuple${t}` : t));
}

/** `abi.encode(...)` — standard ABI encoding of values against a type list. */
export function abiEncodeParams(typeList: string, argsRaw: string): string {
  const params = splitTopLevelTypes(typeList).map((t) => ParamType.from(t));
  const args = coerceAll(params, parseArgString(argsRaw));
  return AbiCoder.defaultAbiCoder().encode(params, args);
}

/** `abi.encodePacked(...)` — Solidity's non-standard packed encoding. */
export function encodePackedParams(typeList: string, argsRaw: string): string {
  const types = splitTopLevelTypes(typeList);
  const params = types.map((t) => ParamType.from(t));
  const args = coerceAll(params, parseArgString(argsRaw));
  return solidityPacked(types, args);
}
