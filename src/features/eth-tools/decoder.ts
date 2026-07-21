/**
 * Calldata / event-log / raw-transaction decoders (eth.sh "Calldata Decoder").
 *
 * Decoding works without an ABI: candidate signatures come from the workspace
 * signature scan, then 4byte.directory, and finally heuristic type-guessing
 * (@openchainxyz/abi-guesser — the same engine eth.sh / openchain.xyz use).
 * Nested `bytes` arguments that themselves look like calldata are decoded
 * recursively, so multicalls and Safe/timelock execution payloads unfold.
 */

import {
  AbiCoder,
  EventFragment,
  FunctionFragment,
  Interface,
  ParamType,
  Transaction,
  getAddress,
} from 'ethers';
import { guessAbiEncodedData, guessFragment } from '@openchainxyz/abi-guesser';
import { formatUnits } from './units';
import { isHexString, normalizeHex, strip0x } from './hex';

/** One decoded value node — arrays/tuples/nested calldata carry children. */
export interface DecodedValue {
  type: string;
  name?: string;
  value: string;
  /** Human hint, e.g. "≈ 1.5 ether" or "2021-01-01T00:00:00Z". */
  hint?: string;
  /** When a bytes value was itself decodable as calldata: the matched signature. */
  decodedAs?: string;
  children?: DecodedValue[];
}

export type SignatureSource = 'workspace' | '4byte.directory' | 'guessed';

export interface DecodeCandidate {
  signature: string;
  source: SignatureSource;
  selector: string;
  ok: boolean;
  error?: string;
  params: DecodedValue[];
}

export interface CalldataDecoded {
  raw: string;
  selector: string;
  /** Length of the argument payload in bytes (calldata minus selector). */
  argBytes: number;
  note?: string;
  candidates: DecodeCandidate[];
}

/** Selector → candidate signature providers. Both are optional. */
export interface SignatureLookups {
  /** Signatures from the local workspace scan (exact, includes private ABIs). */
  workspace?: (selector: string) => string[];
  /** Online directory lookup (4byte.directory). */
  online?: (selector: string) => Promise<string[]>;
}

const MAX_NESTED_DEPTH = 2;

/** Clean pasted calldata: strip quotes, whitespace, and line breaks. */
export function sanitizeCalldataInput(raw: string): string {
  return raw.replace(/["'`\s]/g, '');
}

/** True when a hex blob plausibly is ABI calldata (selector + 32-byte words). */
export function looksLikeCalldata(hex: string): boolean {
  if (!isHexString(hex)) {
    return false;
  }
  const byteLength = strip0x(hex).length / 2;
  return byteLength >= 4 && (byteLength - 4) % 32 === 0;
}

/** Decode `raw` calldata against every candidate signature we can find. */
export async function decodeCalldata(
  raw: string,
  lookups: SignatureLookups,
  depth = 0
): Promise<CalldataDecoded> {
  const calldata = normalizeHex(sanitizeCalldataInput(raw));
  const byteLength = strip0x(calldata).length / 2;

  if (byteLength === 0) {
    return {
      raw: calldata,
      selector: '0x',
      argBytes: 0,
      note: 'Empty calldata (plain ETH transfer).',
      candidates: [],
    };
  }
  if (byteLength < 4) {
    return {
      raw: calldata,
      selector: calldata,
      argBytes: 0,
      note: 'Shorter than a 4-byte selector.',
      candidates: [],
    };
  }

  const selector = calldata.slice(0, 10);
  const argBytes = byteLength - 4;
  const note =
    argBytes % 32 !== 0
      ? 'Argument payload is not a multiple of 32 bytes — may be packed or truncated.'
      : undefined;

  const candidates: DecodeCandidate[] = [];
  const seen = new Set<string>();

  const tryCandidates = async (signatures: string[], source: SignatureSource) => {
    for (const signature of signatures) {
      const candidate = await decodeWithSignature(
        calldata,
        selector,
        signature,
        source,
        lookups,
        depth
      );
      if (candidate && !seen.has(candidate.signature)) {
        seen.add(candidate.signature);
        candidates.push(candidate);
      }
    }
  };

  await tryCandidates(lookups.workspace?.(selector) ?? [], 'workspace');
  if (lookups.online) {
    try {
      await tryCandidates(await lookups.online(selector), '4byte.directory');
    } catch {
      /* offline — guesser still runs */
    }
  }

  // Heuristic fallback: guess parameter types straight from the bytes.
  if (!candidates.some((c) => c.ok) && argBytes > 0) {
    try {
      const fragment = guessFragment(calldata);
      if (fragment) {
        // Decode only the argument payload — the guessed fragment's placeholder
        // name gives it a different selector, so Interface would reject the data.
        const decoded = AbiCoder.defaultAbiCoder().decode(
          fragment.inputs,
          `0x${strip0x(calldata).slice(8)}`
        );
        const params = await formatParams(fragment.inputs, decoded, lookups, depth);
        candidates.push({
          signature: `${selector}(${fragment.inputs.map((p) => p.format()).join(',')})`,
          source: 'guessed',
          selector,
          ok: true,
          params,
        });
      }
    } catch {
      /* guesser could not make sense of the bytes */
    }
  }

  // Successful decodes first, workspace before online before guessed.
  const rank: Record<SignatureSource, number> = { workspace: 0, '4byte.directory': 1, guessed: 2 };
  candidates.sort((a, b) => Number(b.ok) - Number(a.ok) || rank[a.source] - rank[b.source]);

  return { raw: calldata, selector, argBytes, note, candidates };
}

async function decodeWithSignature(
  calldata: string,
  selector: string,
  signature: string,
  source: SignatureSource,
  lookups: SignatureLookups,
  depth: number
): Promise<DecodeCandidate | null> {
  let fragment: FunctionFragment;
  try {
    fragment = FunctionFragment.from(
      signature.startsWith('function') ? signature : `function ${signature}`
    );
  } catch {
    return null; // unparseable directory entry
  }
  if (fragment.selector !== selector) {
    return null;
  } // wrong/poisoned directory entry

  const canonical = fragment.format('sighash');
  try {
    const decoded = new Interface([fragment]).decodeFunctionData(fragment, calldata);
    return {
      signature: canonical,
      source,
      selector,
      ok: true,
      params: await formatParams(fragment.inputs, decoded, lookups, depth),
    };
  } catch (error) {
    return {
      signature: canonical,
      source,
      selector,
      ok: false,
      error: `Signature matches the selector but the arguments do not decode: ${(error as Error).message.split('\n')[0]}`,
      params: [],
    };
  }
}

async function formatParams(
  params: readonly ParamType[],
  values: ArrayLike<unknown>,
  lookups: SignatureLookups,
  depth: number
): Promise<DecodedValue[]> {
  const out: DecodedValue[] = [];
  for (let i = 0; i < params.length; i++) {
    out.push(await formatValue(params[i], values[i], lookups, depth, `arg${i}`));
  }
  return out;
}

async function formatValue(
  param: ParamType,
  value: unknown,
  lookups: SignatureLookups,
  depth: number,
  fallbackName: string
): Promise<DecodedValue> {
  const name = param.name && param.name.length > 0 ? param.name : fallbackName;

  if (param.baseType === 'array' && Array.isArray(value)) {
    const children: DecodedValue[] = [];
    for (let i = 0; i < value.length; i++) {
      children.push(
        await formatValue(param.arrayChildren as ParamType, value[i], lookups, depth, `[${i}]`)
      );
    }
    return {
      type: param.type,
      name,
      value: `${value.length} element${value.length === 1 ? '' : 's'}`,
      children,
    };
  }

  if (param.baseType === 'tuple' && param.components) {
    const values = value as ArrayLike<unknown>;
    const children: DecodedValue[] = [];
    for (let i = 0; i < param.components.length; i++) {
      children.push(await formatValue(param.components[i], values[i], lookups, depth, `field${i}`));
    }
    return {
      type: param.type,
      name,
      value: `(${param.components.map((c) => c.type).join(', ')})`,
      children,
    };
  }

  if (param.baseType === 'address') {
    return { type: param.type, name, value: getAddress(String(value)) };
  }

  if (typeof value === 'bigint') {
    return {
      type: param.type,
      name,
      value: value.toString(10),
      hint: numericHint(param.type, value),
    };
  }

  if (param.baseType === 'bytes' && typeof value === 'string') {
    const node: DecodedValue = { type: param.type, name, value };
    if (depth < MAX_NESTED_DEPTH && looksLikeCalldata(value) && strip0x(value).length / 2 >= 4) {
      const nested = await decodeCalldata(value, lookups, depth + 1);
      const best = nested.candidates.find((c) => c.ok);
      if (best) {
        node.decodedAs = best.signature;
        node.children = best.params;
      }
    }
    return node;
  }

  return { type: param.type, name, value: String(value) };
}

/** Ether-scale and unix-timestamp hints that make big uints readable at a glance. */
function numericHint(type: string, value: bigint): string | undefined {
  if (!type.startsWith('uint')) {
    return undefined;
  }
  if (value >= 10n ** 15n && value <= 10n ** 27n) {
    return `≈ ${formatUnits(value, 18)} ether`;
  }
  if (value >= 1_000_000_000n && value <= 10_000_000_000n) {
    const date = new Date(Number(value) * 1000);
    return `unix time ${date.toISOString().replace('.000', '')}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Raw ABI blob (no selector) — "abi.decode" with known or guessed types
// ---------------------------------------------------------------------------

/** Decode an ABI blob. When `typeList` is omitted the types are guessed. */
export async function decodeAbiBlob(
  raw: string,
  typeList: string[] | undefined,
  lookups: SignatureLookups
): Promise<{ types: string[]; guessed: boolean; params: DecodedValue[] }> {
  const data = normalizeHex(sanitizeCalldataInput(raw));
  let params: ParamType[];
  let guessed = false;
  if (typeList && typeList.length > 0) {
    params = typeList.map((t) => ParamType.from(t));
  } else {
    const guessedParams = guessAbiEncodedData(data);
    if (!guessedParams) {
      throw new Error('Could not guess the ABI types of this data.');
    }
    params = guessedParams;
    guessed = true;
  }
  const decoded = AbiCoder.defaultAbiCoder().decode(params, data);
  return {
    types: params.map((p) => p.format()),
    guessed,
    params: await formatParams(params, decoded, lookups, 0),
  };
}

// ---------------------------------------------------------------------------
// Event logs
// ---------------------------------------------------------------------------

export interface WorkspaceEvent {
  /** Canonical signature, e.g. `Transfer(address,address,uint256)`. */
  signature: string;
  inputs: Array<{ name: string; type: string; indexed?: boolean }>;
}

export interface EventDecoded {
  topic0: string;
  signature?: string;
  source?: SignatureSource;
  /** Set when indexed positions had to be assumed (directory sigs carry no `indexed` info). */
  assumption?: string;
  params: DecodedValue[];
}

export interface EventLookups {
  workspace?: (topic0: string) => WorkspaceEvent[];
  online?: (topic0: string) => Promise<string[]>;
}

/** Decode one event log given its topics + data, trying workspace events, then the directory. */
export async function decodeEventLog(
  topics: string[],
  data: string,
  lookups: EventLookups
): Promise<EventDecoded> {
  if (topics.length === 0) {
    throw new Error('Anonymous events (no topics) cannot be matched to a signature.');
  }
  const topic0 = normalizeHex(topics[0]);
  const normalizedTopics = topics.map((t) => normalizeHex(t));
  const payload = data && data !== '0x' ? normalizeHex(sanitizeCalldataInput(data)) : '0x';

  // 1. Workspace events carry exact indexed flags.
  for (const event of lookups.workspace?.(topic0) ?? []) {
    const fragment = eventFragmentFrom(
      event.signature,
      event.inputs.map((p) => Boolean(p.indexed)),
      event.inputs.map((p) => p.name)
    );
    const decoded = tryDecodeEvent(fragment, normalizedTopics, payload);
    if (decoded) {
      return { topic0, signature: event.signature, source: 'workspace', params: decoded };
    }
  }

  // 2. Directory signatures: indexed positions are unknown — try likely layouts.
  let onlineSignatures: string[] = [];
  if (lookups.online) {
    try {
      onlineSignatures = await lookups.online(topic0);
    } catch {
      /* offline */
    }
  }
  const indexedCount = normalizedTopics.length - 1;
  for (const signature of onlineSignatures) {
    let types: string[];
    try {
      types = EventFragment.from(`event ${signature}`).inputs.map((p) => p.format());
    } catch {
      continue;
    }
    for (const layout of indexedLayouts(types.length, indexedCount)) {
      const fragment = eventFragmentFrom(signature, layout);
      if (!fragment) {
        continue;
      }
      const decoded = tryDecodeEvent(fragment, normalizedTopics, payload);
      if (decoded) {
        const assumed = layout
          .map((idx, i) => (idx ? `#${i + 1}` : null))
          .filter(Boolean)
          .join(', ');
        return {
          topic0,
          signature,
          source: '4byte.directory',
          assumption:
            indexedCount > 0
              ? `assumed indexed parameter${indexedCount === 1 ? '' : 's'}: ${assumed}`
              : undefined,
          params: decoded,
        };
      }
    }
  }

  // 3. Nothing matched — show raw topics/data words.
  const params: DecodedValue[] = normalizedTopics
    .slice(1)
    .map((topic, i) => ({ type: 'bytes32', name: `topic${i + 1}`, value: topic }));
  if (payload !== '0x') {
    params.push({ type: 'bytes', name: 'data', value: payload });
  }
  return { topic0, params };
}

function eventFragmentFrom(
  signature: string,
  indexed: boolean[],
  names?: string[]
): EventFragment | null {
  try {
    const base = EventFragment.from(`event ${signature}`);
    const declaration = base.inputs
      .map(
        (p, i) => `${p.format()}${indexed[i] ? ' indexed' : ''}${names?.[i] ? ` ${names[i]}` : ''}`
      )
      .join(', ');
    return EventFragment.from(`event ${base.name}(${declaration})`);
  } catch {
    return null;
  }
}

function tryDecodeEvent(
  fragment: EventFragment | null,
  topics: string[],
  data: string
): DecodedValue[] | null {
  if (!fragment) {
    return null;
  }
  try {
    const decoded = new Interface([fragment]).decodeEventLog(fragment, data, topics);
    const out: DecodedValue[] = [];
    for (let i = 0; i < fragment.inputs.length; i++) {
      const param = fragment.inputs[i];
      const isHashedDynamic =
        param.indexed &&
        (param.baseType === 'string' ||
          param.baseType === 'bytes' ||
          param.baseType === 'array' ||
          param.baseType === 'tuple');
      const node: DecodedValue = isHashedDynamic
        ? {
            type: param.type,
            name: param.name || `arg${i}`,
            value: String(decoded[i]),
            hint: 'indexed dynamic value — only its keccak256 hash is in the log',
          }
        : formatEventValue(param, decoded[i], i);
      if (param.indexed) {
        node.name = `${node.name} (indexed)`;
      }
      out.push(node);
    }
    return out;
  } catch {
    return null;
  }
}

function formatEventValue(param: ParamType, value: unknown, index: number): DecodedValue {
  const name = param.name && param.name.length > 0 ? param.name : `arg${index}`;
  if (param.baseType === 'address') {
    return { type: param.type, name, value: getAddress(String(value)) };
  }
  if (typeof value === 'bigint') {
    return {
      type: param.type,
      name,
      value: value.toString(10),
      hint: numericHint(param.type, value),
    };
  }
  return { type: param.type, name, value: String(value) };
}

/**
 * Enumerate which parameter positions could be the indexed ones, most likely
 * layouts first (Solidity convention puts indexed params first). Capped so
 * pathological signatures don't explode.
 */
export function indexedLayouts(paramCount: number, indexedCount: number): boolean[][] {
  if (indexedCount > paramCount) {
    return [];
  }
  if (indexedCount === 0) {
    return [new Array(paramCount).fill(false)];
  }
  const layouts: boolean[][] = [];
  const positions = Array.from({ length: paramCount }, (_, i) => i);
  const choose = (start: number, chosen: number[]) => {
    if (layouts.length >= 30) {
      return;
    }
    if (chosen.length === indexedCount) {
      const layout = new Array<boolean>(paramCount).fill(false);
      for (const c of chosen) {
        layout[c] = true;
      }
      layouts.push(layout);
      return;
    }
    for (let i = start; i < positions.length; i++) {
      choose(i + 1, [...chosen, positions[i]]);
    }
  };
  choose(0, []);
  // "first N indexed" is generated first by construction (lexicographic order).
  return layouts;
}

// ---------------------------------------------------------------------------
// Raw signed transactions
// ---------------------------------------------------------------------------

export interface RawTxDecoded {
  fields: Array<{ label: string; value: string; hint?: string }>;
  /** The tx's calldata, for follow-up decoding (undefined when empty). */
  calldata?: string;
}

/** Parse a raw (RLP-encoded, usually signed) transaction into readable fields. */
export function decodeRawTransaction(raw: string): RawTxDecoded {
  const tx = Transaction.from(normalizeHex(sanitizeCalldataInput(raw)));
  const typeNames: Record<number, string> = {
    0: 'legacy',
    1: 'EIP-2930',
    2: 'EIP-1559',
    3: 'EIP-4844 (blob)',
    4: 'EIP-7702 (setCode)',
  };
  const fields: Array<{ label: string; value: string; hint?: string }> = [];
  const push = (label: string, value: string | null | undefined, hint?: string) => {
    if (value !== null && value !== undefined && value !== '') {
      fields.push({ label, value, hint });
    }
  };

  push('type', tx.type !== null ? `${tx.type} (${typeNames[tx.type] ?? 'unknown'})` : 'unknown');
  push('chainId', tx.chainId.toString());
  push('from', tx.from ?? undefined, tx.from ? undefined : 'unsigned — no signature to recover');
  push('to', tx.to ?? undefined, tx.to ? undefined : 'contract creation');
  push('nonce', String(tx.nonce));
  push(
    'value',
    `${tx.value.toString()} wei`,
    tx.value > 0n ? `= ${formatUnits(tx.value, 18)} ether` : undefined
  );
  push('gasLimit', tx.gasLimit.toString());
  if (tx.gasPrice !== null && tx.type === 0) {
    push('gasPrice', `${formatUnits(tx.gasPrice, 9)} gwei`);
  }
  if (tx.maxFeePerGas !== null) {
    push('maxFeePerGas', `${formatUnits(tx.maxFeePerGas, 9)} gwei`);
  }
  if (tx.maxPriorityFeePerGas !== null) {
    push('maxPriorityFeePerGas', `${formatUnits(tx.maxPriorityFeePerGas, 9)} gwei`);
  }
  push('hash', tx.hash ?? undefined);
  const dataBytes = strip0x(tx.data).length / 2;
  push('data', dataBytes === 0 ? '0x (none)' : `${dataBytes} bytes`);
  return { fields, calldata: dataBytes > 0 ? tx.data : undefined };
}
