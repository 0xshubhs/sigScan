// Ported from Remix: libs/remix-lib/src/execution/txHelper.ts
// Pure ABI utilities for function selectors, fragment lookup, and tuple type expansion.

import { Interface, AbiCoder } from 'ethers';

export interface AbiParameter {
  name?: string;
  type: string;
  components?: AbiParameter[];
  indexed?: boolean;
}

export interface AbiEntry {
  type: 'function' | 'constructor' | 'event' | 'fallback' | 'receive' | 'error';
  name?: string;
  inputs?: AbiParameter[];
  outputs?: AbiParameter[];
  stateMutability?: 'pure' | 'view' | 'nonpayable' | 'payable';
  payable?: boolean;
  anonymous?: boolean;
}

export interface CompiledContract {
  abi: AbiEntry[];
  evm?: {
    bytecode?: { object: string; linkReferences?: Record<string, Record<string, unknown>> };
    deployedBytecode?: { object: string };
  };
  address?: string;
  [k: string]: unknown;
}

export type CompiledContractsMap = Record<string, Record<string, CompiledContract>>;

export function makeFullTypeDefinition(typeDef: AbiParameter): string {
  if (typeDef && typeDef.type.indexOf('tuple') === 0 && typeDef.components) {
    const innerTypes = typeDef.components.map((t) => makeFullTypeDefinition(t));
    return `tuple(${innerTypes.join(',')})${extractSize(typeDef.type)}`;
  }
  return typeDef.type;
}

export function encodeParams(funABI: AbiEntry, args: unknown[]): string {
  const types: string[] = [];
  if (funABI.inputs && funABI.inputs.length) {
    for (let i = 0; i < funABI.inputs.length; i++) {
      const type = funABI.inputs[i].type;
      if (type === 'bool') {
        const v = args[i];
        if (v === false || v === 'false' || v === '0' || v === 0) args[i] = false;
        else if (v === true || v === 'true' || v === '1' || v === 1) args[i] = true;
        else throw new Error(`provided value for boolean is invalid: ${String(v)}`);
      }
      types.push(type.indexOf('tuple') === 0 ? makeFullTypeDefinition(funABI.inputs[i]) : type);
      if (args.length < types.length) args.push('');
    }
  }
  const abiCoder = new AbiCoder();
  return abiCoder.encode(types, args);
}

export function encodeFunctionId(funABI: AbiEntry): string {
  if (funABI.type === 'fallback' || funABI.type === 'receive') return '0x';
  if (!funABI.name) throw new Error('function ABI missing name');
  const iface = new Interface([funABI as never]);
  const fn = iface.getFunction(funABI.name);
  if (!fn) throw new Error(`function ${funABI.name} not found in ABI`);
  return fn.selector;
}

export function getFunctionFragment(funABI: AbiEntry): Interface | null {
  if (funABI.type === 'fallback' || funABI.type === 'receive') return null;
  return new Interface([funABI as never]);
}

export function sortAbiFunction(contractabi: AbiEntry[]): AbiEntry[] {
  const isConstant = (e: AbiEntry): boolean =>
    e.stateMutability === 'view' || e.stateMutability === 'pure';
  return contractabi.sort((a, b) => {
    if (isConstant(a) && !isConstant(b)) return 1;
    if (isConstant(b) && !isConstant(a)) return -1;
    if (a.type === 'function' && typeof a.name !== 'undefined') {
      return (a.name || '').localeCompare(b.name || '');
    }
    if (a.type === 'constructor' || a.type === 'fallback' || a.type === 'receive') return 1;
    return 0;
  });
}

export function getConstructorInterface(abi: AbiEntry[] | string): AbiEntry {
  const funABI: AbiEntry = {
    name: '',
    inputs: [],
    type: 'constructor',
    payable: false,
    outputs: [],
    stateMutability: undefined,
  };
  let parsed: AbiEntry[];
  if (typeof abi === 'string') {
    try {
      parsed = JSON.parse(abi);
    } catch {
      return funABI;
    }
  } else {
    parsed = abi;
  }
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i].type === 'constructor') {
      funABI.inputs = parsed[i].inputs || [];
      funABI.payable = parsed[i].payable;
      funABI.stateMutability = parsed[i].stateMutability;
      break;
    }
  }
  return funABI;
}

export function serializeInputs(fnAbi: AbiEntry): string {
  let serialized = '(';
  if (fnAbi.inputs && fnAbi.inputs.length) {
    serialized += fnAbi.inputs.map((i) => i.type).join(',');
  }
  serialized += ')';
  return serialized;
}

export function extractSize(type: string): string {
  const size = type.match(/([a-zA-Z0-9])(\[.*\])/);
  return size ? size[2] : '';
}

export function getFunctionLiner(fn: AbiEntry, detailTuple = true): string {
  return (
    (fn.name || '') +
    '(' +
    (fn.inputs || [])
      .map((value) => {
        if (detailTuple && value.components) {
          // makeFullTypeDefinition may produce `tuple(...)`; method identifiers omit the word `tuple`
          return makeFullTypeDefinition(value).replace(/tuple/g, '');
        }
        return value.type;
      })
      .join(',') +
    ')'
  );
}

export function getFunction(abi: AbiEntry[], fnName: string): AbiEntry | null {
  for (let i = 0; i < abi.length; i++) {
    const fn = abi[i];
    if (
      fn.type === 'function' &&
      (fnName === getFunctionLiner(fn, true) || fnName === getFunctionLiner(fn, false))
    ) {
      return fn;
    }
  }
  return null;
}

export function getFallbackInterface(abi: AbiEntry[]): AbiEntry | undefined {
  return abi.find((e) => e.type === 'fallback');
}

export function getReceiveInterface(abi: AbiEntry[]): AbiEntry | undefined {
  return abi.find((e) => e.type === 'receive');
}

export function getContract(
  contractName: string,
  contracts: CompiledContractsMap
): { object: CompiledContract; file: string } | null {
  for (const file in contracts) {
    if (contracts[file][contractName]) {
      return { object: contracts[file][contractName], file };
    }
  }
  return null;
}

export function visitContracts(
  contracts: CompiledContractsMap,
  cb: (entry: { name: string; object: CompiledContract; file: string }) => boolean | void
): void {
  for (const file in contracts) {
    for (const name in contracts[file]) {
      if (cb({ name, object: contracts[file][name], file })) return;
    }
  }
}

export function inputParametersDeclarationToString(
  abiinputs: AbiParameter[] | undefined
): string {
  return (abiinputs || []).map((inp) => `${inp.type} ${inp.name ?? ''}`.trim()).join(', ');
}
