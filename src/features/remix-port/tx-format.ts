// Ported from Remix: libs/remix-lib/src/execution/txFormat.ts
// Encodes constructor/function calls, parses Remix-style argument strings, links libraries.

import { AbiCoder, isAddress } from 'ethers';
import {
  encodeParams as encodeParamsHelper,
  encodeFunctionId,
  makeFullTypeDefinition,
  type AbiEntry,
  type CompiledContract,
  type CompiledContractsMap,
} from './tx-helper';

// solc/linker is CJS; require to avoid TS module resolution noise
// eslint-disable-next-line @typescript-eslint/no-var-requires
const solcLinker: { linkBytecode: (bytecode: string, libraries: Record<string, string>) => string } =
  require('solc/linker');

const addHexPrefix = (s: string): string => (s.startsWith('0x') ? s : '0x' + s);
const stripHexPrefix = (s: string): string => (s.startsWith('0x') ? s.slice(2) : s);

export type LinkLibrariesAddresses = Record<string, Record<string, string>>;
export type LinkReferences = Record<string, Record<string, Array<{ start: number; length: number }>>>;

export interface EncodedCall {
  data?: string;
  error?: string;
}

export interface EncodedParams {
  data: string;
  dataHex: string;
  funArgs: unknown[];
}

export interface EncodedFunctionCall {
  dataHex: string;
  funAbi: AbiEntry;
  funArgs: unknown[];
}

export interface EncodedConstructorCall extends EncodedFunctionCall {
  contractBytecode: string;
  contractDeployedBytecode?: string;
  contractName?: string;
}

export type DeployLibraryCallback = (
  ctx: { data: { dataHex: string; funAbi: AbiEntry; funArgs: unknown[]; contractBytecode: string; contractName: string; contractABI: AbiEntry[] }; useCall: boolean },
  cb: (err: Error | null, txResult?: { receipt: { contractAddress: string } }) => void
) => void;

export function encodeData(
  funABI: AbiEntry,
  values: unknown[],
  contractbyteCode?: string
): EncodedCall {
  let encoded: string;
  let encodedHex: string;
  try {
    encoded = encodeParamsHelper(funABI, values);
    encodedHex = stripHexPrefix(encoded);
  } catch {
    return { error: 'cannot encode arguments' };
  }
  if (contractbyteCode) {
    return { data: '0x' + stripHexPrefix(contractbyteCode) + encodedHex };
  }
  return { data: encodeFunctionId(funABI) + encodedHex };
}

export function encodeParams(params: unknown, funAbi: AbiEntry): EncodedParams {
  let data = '';
  let dataHex = '';
  let funArgs: unknown[] = [];

  if (Array.isArray(params)) {
    funArgs = params;
    if (funArgs.length > 0) {
      try {
        data = encodeParamsHelper(funAbi, funArgs);
      } catch (e) {
        throw new Error('Error encoding arguments: ' + (e as Error).message);
      }
    }
  } else if (typeof params === 'string' && params.indexOf('raw:0x') === 0) {
    // input is already encoded calldata payload (no selector)
    dataHex = params.replace('raw:0x', '');
    data = '0x' + dataHex;
  } else if (typeof params === 'string') {
    try {
      funArgs = parseFunctionParams(params);
    } catch (e) {
      throw new Error('Error encoding arguments: ' + (e as Error).message);
    }
    try {
      if (funArgs.length > 0) {
        data = encodeParamsHelper(funAbi, funArgs);
      }
    } catch (e) {
      throw new Error('Error encoding arguments: ' + (e as Error).message);
    }
  } else {
    throw new Error('Error encoding arguments: params must be an array or a string');
  }

  dataHex = stripHexPrefix(data);
  return { data, dataHex, funArgs };
}

export function encodeFunctionCall(params: unknown, funAbi: AbiEntry): EncodedFunctionCall {
  const encodedParam = encodeParams(params, funAbi);
  return {
    dataHex: encodeFunctionId(funAbi) + encodedParam.dataHex,
    funAbi,
    funArgs: encodedParam.funArgs,
  };
}

export function encodeConstructorCallAndLinkLibraries(
  contract: CompiledContract,
  params: unknown,
  funAbi: AbiEntry,
  linkLibrariesAddresses: LinkLibrariesAddresses,
  linkReferences: LinkReferences
): EncodedConstructorCall {
  const encodedParam = encodeParams(params, funAbi);
  const bytecodeToDeploy = linkLibraries(contract, linkLibrariesAddresses, linkReferences);
  return {
    dataHex: bytecodeToDeploy + encodedParam.dataHex,
    funAbi,
    funArgs: encodedParam.funArgs,
    contractBytecode: contract.evm?.bytecode?.object ?? '',
  };
}

export function linkLibraries(
  contract: CompiledContract,
  linkLibrariesAddresses: LinkLibrariesAddresses | undefined,
  linkReferences: LinkReferences | undefined
): string {
  let bytecodeToDeploy = contract.evm?.bytecode?.object ?? '';
  if (bytecodeToDeploy.indexOf('_') >= 0 && linkLibrariesAddresses && linkReferences) {
    for (const libFile in linkLibrariesAddresses) {
      for (const lib in linkLibrariesAddresses[libFile]) {
        const address = linkLibrariesAddresses[libFile][lib];
        if (!isAddress(address)) {
          throw new Error(address + ' is not a valid address. Please check the provided address is valid.');
        }
        bytecodeToDeploy = linkLibraryStandardFromlinkReferences(
          lib,
          stripHexPrefix(address),
          bytecodeToDeploy,
          linkReferences
        );
      }
    }
  }
  if (bytecodeToDeploy.indexOf('_') >= 0) {
    throw new Error('Failed to link some libraries');
  }
  return bytecodeToDeploy;
}

export async function encodeConstructorCallAndDeployLibraries(
  contractName: string,
  contract: CompiledContract,
  contracts: CompiledContractsMap,
  params: unknown,
  funAbi: AbiEntry,
  callbackDeployLibrary?: DeployLibraryCallback
): Promise<EncodedConstructorCall> {
  const encodedParam = encodeParams(params, funAbi);
  const contractBytecode = contract.evm?.bytecode?.object ?? '';
  let bytecodeToDeploy = contractBytecode;
  if (bytecodeToDeploy.indexOf('_') >= 0) {
    try {
      bytecodeToDeploy = await linkBytecode(contract, contracts, callbackDeployLibrary);
      return {
        dataHex: bytecodeToDeploy,
        funAbi,
        funArgs: encodedParam.funArgs,
        contractBytecode,
        contractName,
      };
    } catch (err) {
      throw new Error('Error deploying required libraries: ' + (err as Error).message);
    }
  }
  return {
    dataHex: bytecodeToDeploy + encodedParam.dataHex,
    funAbi,
    funArgs: encodedParam.funArgs,
    contractBytecode,
    contractName,
  };
}

export async function buildData(
  contractName: string,
  contract: CompiledContract,
  contracts: CompiledContractsMap,
  isConstructor: boolean,
  funAbi: AbiEntry,
  params: unknown,
  callbackDeployLibrary?: DeployLibraryCallback
): Promise<EncodedConstructorCall> {
  let funArgs: unknown[] = [];
  let dataHex = '';

  if (typeof params === 'string' && params.indexOf('raw:0x') === 0) {
    dataHex = params.replace('raw:0x', '');
  } else {
    try {
      if (Array.isArray(params)) funArgs = params;
      else if (typeof params === 'string' && params.length > 0) funArgs = parseFunctionParams(params);
    } catch (e) {
      throw new Error('Error encoding arguments: ' + (e as Error).message);
    }
    try {
      const encoded = encodeParamsHelper(funAbi, funArgs);
      dataHex = stripHexPrefix(encoded);
    } catch (e) {
      throw new Error('Error encoding arguments: ' + (e as Error).message);
    }
  }

  let contractBytecode = '';
  let contractDeployedBytecode: string | undefined;
  if (isConstructor) {
    contractBytecode = contract.evm?.bytecode?.object ?? '';
    contractDeployedBytecode = contract.evm?.deployedBytecode?.object;
    let bytecodeToDeploy = contractBytecode;
    if (bytecodeToDeploy.indexOf('_') >= 0) {
      try {
        const linked = await linkBytecode(contract, contracts, callbackDeployLibrary);
        bytecodeToDeploy = linked + dataHex;
        return {
          dataHex: bytecodeToDeploy,
          funAbi,
          funArgs,
          contractBytecode,
          contractName,
        };
      } catch (err) {
        throw new Error('Error deploying required libraries: ' + (err as Error).message);
      }
    } else {
      dataHex = bytecodeToDeploy + dataHex;
    }
  } else {
    dataHex = encodeFunctionId(funAbi) + dataHex;
  }
  return { dataHex, funAbi, funArgs, contractBytecode, contractDeployedBytecode, contractName };
}

export async function linkBytecodeStandard(
  contract: CompiledContract,
  contracts: CompiledContractsMap,
  callbackDeployLibrary?: DeployLibraryCallback
): Promise<string> {
  let contractBytecode = contract.evm?.bytecode?.object ?? '';
  const linkReferences = (contract.evm?.bytecode?.linkReferences as LinkReferences | undefined) || {};

  for (const file of Object.keys(linkReferences)) {
    const libs = linkReferences[file];
    for (const libName of Object.keys(libs)) {
      const library = contracts?.[file]?.[libName];
      if (!library) throw new Error('Cannot find compilation data of library ' + libName);

      const address = await deployLibrary(file + ':' + libName, libName, library, contracts, callbackDeployLibrary);
      const hexAddress = stripHexPrefix(String(address));
      contractBytecode = linkLibraryStandard(libName, hexAddress, contractBytecode, contract);
    }
  }
  return contractBytecode;
}

export async function linkBytecodeLegacy(
  contract: CompiledContract,
  contracts: CompiledContractsMap,
  callbackDeployLibrary?: DeployLibraryCallback
): Promise<string> {
  const bytecode = contract.evm?.bytecode?.object ?? '';
  const libraryRefMatch = bytecode.match(/__([^_]{1,36})__/);
  if (!libraryRefMatch) throw new Error('Invalid bytecode format.');
  const libraryName = libraryRefMatch[1];
  const libRef = libraryName.match(/(.*):(.*)/);
  if (!libRef) throw new Error('Cannot extract library reference ' + libraryName);
  if (!contracts[libRef[1]] || !contracts[libRef[1]][libRef[2]]) {
    throw new Error('Cannot find library reference ' + libraryName);
  }
  const libraryShortName = libRef[2];
  const library = contracts[libRef[1]][libraryShortName];
  const address = await deployLibrary(libraryName, libraryShortName, library, contracts, callbackDeployLibrary);
  const hexAddress = stripHexPrefix(String(address));
  if (contract.evm?.bytecode) {
    contract.evm.bytecode.object = linkLibrary(libraryName, hexAddress, contract.evm.bytecode.object);
  }
  return await linkBytecode(contract, contracts, callbackDeployLibrary);
}

export async function linkBytecode(
  contract: CompiledContract,
  contracts: CompiledContractsMap,
  callbackDeployLibrary?: DeployLibraryCallback
): Promise<string> {
  const bytecode = contract.evm?.bytecode?.object ?? '';
  if (bytecode.indexOf('_') < 0) return bytecode;
  const linkRefs = contract.evm?.bytecode?.linkReferences;
  if (linkRefs && Object.keys(linkRefs).length) {
    return await linkBytecodeStandard(contract, contracts, callbackDeployLibrary);
  }
  return await linkBytecodeLegacy(contract, contracts, callbackDeployLibrary);
}

export async function deployLibrary(
  libraryName: string,
  libraryShortName: string,
  library: CompiledContract,
  contracts: CompiledContractsMap,
  callbackDeployLibrary?: DeployLibraryCallback
): Promise<string> {
  if (library.address) return library.address;
  const bytecode = library.evm?.bytecode?.object ?? '';
  if (bytecode.indexOf('_') >= 0) {
    const linkedBytecode = await linkBytecode(library, contracts, callbackDeployLibrary);
    if (library.evm?.bytecode) library.evm.bytecode.object = linkedBytecode;
    return await deployLibrary(libraryName, libraryShortName, library, contracts, callbackDeployLibrary);
  }
  if (!callbackDeployLibrary) {
    throw new Error('callbackDeployLibrary is required to deploy library ' + libraryName);
  }
  const data = {
    dataHex: bytecode,
    funAbi: { type: 'constructor' as const },
    funArgs: [],
    contractBytecode: bytecode,
    contractName: libraryShortName,
    contractABI: library.abi,
  };
  return new Promise<string>((resolve, reject) => {
    callbackDeployLibrary({ data, useCall: false }, (err, txResult) => {
      if (err) return reject(err);
      const address = txResult!.receipt.contractAddress;
      library.address = address;
      resolve(address);
    });
  });
}

export function linkLibraryStandardFromlinkReferences(
  libraryName: string,
  address: string,
  bytecode: string,
  linkReferences: LinkReferences
): string {
  for (const file in linkReferences) {
    for (const libName in linkReferences[file]) {
      if (libraryName === libName) {
        bytecode = setLibraryAddress(address, bytecode, linkReferences[file][libName]);
      }
    }
  }
  return bytecode;
}

export function linkLibraryStandard(
  libraryName: string,
  address: string,
  bytecode: string,
  contract: CompiledContract
): string {
  const refs = (contract.evm?.bytecode?.linkReferences as LinkReferences | undefined) || {};
  return linkLibraryStandardFromlinkReferences(libraryName, address, bytecode, refs);
}

export function setLibraryAddress(
  address: string,
  bytecodeToLink: string,
  positions: Array<{ start: number; length: number }> | undefined
): string {
  if (positions) {
    for (const pos of positions) {
      const re = new RegExp(`(.{${2 * pos.start}})(.{${2 * pos.length}})(.*)`);
      const regpos = bytecodeToLink.match(re);
      if (regpos) bytecodeToLink = regpos[1] + address + regpos[3];
    }
  }
  return bytecodeToLink;
}

export function linkLibrary(libraryName: string, address: string, bytecodeToLink: string): string {
  return solcLinker.linkBytecode(bytecodeToLink, { [libraryName]: addHexPrefix(address) });
}

export function decodeResponse(
  response: string | Uint8Array,
  fnabi: AbiEntry
): Record<string, string> | { error: string } {
  if (!fnabi.outputs || fnabi.outputs.length === 0) return {};
  try {
    const outputTypes: string[] = [];
    for (let i = 0; i < fnabi.outputs.length; i++) {
      const type = fnabi.outputs[i].type;
      outputTypes.push(type.indexOf('tuple') === 0 ? makeFullTypeDefinition(fnabi.outputs[i]) : type);
    }
    // pad with zeros if empty so AbiCoder doesn't throw
    const payload = !response || (typeof response !== 'string' && response.length === 0)
      ? new Uint8Array(32 * fnabi.outputs.length)
      : response;
    const abiCoder = new AbiCoder();
    const decoded = abiCoder.decode(outputTypes, payload);
    const json: Record<string, string> = {};
    for (let i = 0; i < outputTypes.length; i++) {
      const name = fnabi.outputs[i].name;
      const v = decoded[i];
      const valStr = typeof v === 'bigint' ? v.toString() : String(v);
      json[i] = outputTypes[i] + ': ' + (name ? name + ' ' + valStr : valStr);
    }
    return json;
  } catch (e) {
    return { error: 'Failed to decode output: ' + (e as Error).message };
  }
}

export function parseFunctionParams(params: string): unknown[] {
  const args: unknown[] = [];
  let startIndex = isArrayOrStringStart(params, 0) ? -1 : 0;
  for (let i = 0; i < params.length; i++) {
    if (params.charAt(i) === '"') {
      startIndex = -1;
      let endQuoteIndex = false;
      for (let j = i + 1; !endQuoteIndex; j++) {
        if (params.charAt(j) === '"') {
          args.push(normalizeParam(params.substring(i + 1, j)));
          endQuoteIndex = true;
          i = j;
        }
        if (!endQuoteIndex && j === params.length - 1) {
          throw new Error('invalid params');
        }
      }
    } else if (params.charAt(i) === '[') {
      startIndex = -1;
      let bracketCount = 1;
      let j: number;
      for (j = i + 1; bracketCount !== 0; j++) {
        if (params.charAt(j) === '[') bracketCount++;
        else if (params.charAt(j) === ']') bracketCount--;
        if (bracketCount !== 0 && j === params.length - 1) {
          throw new Error('invalid tuple params');
        }
        if (bracketCount === 0) break;
      }
      args.push(parseFunctionParams(params.substring(i + 1, j)));
      i = j - 1;
    } else if (params.charAt(i) === ',' || i === params.length - 1) {
      if (startIndex >= 0) {
        let param = params.substring(startIndex, i === params.length - 1 ? undefined : i);
        param = normalizeParam(param) as string;
        args.push(param);
      }
      startIndex = isArrayOrStringStart(params, i + 1) ? -1 : i + 1;
    }
  }
  return args;
}

export const REGEX_SCIENTIFIC = /^-?(\d+\.?\d*)e\d*(\d+)$/;
export const REGEX_DECIMAL = /^\d*/;

// Inlined replacement for `from-exponential`: converts "1e18" → "1000000000000000000".
function fromExponential(str: string): string {
  if (!/e/i.test(str)) return str;
  const [base, expStr] = str.toLowerCase().split('e');
  const exp = parseInt(expStr, 10);
  if (Number.isNaN(exp)) return str;
  const negative = base.startsWith('-');
  const unsigned = negative ? base.slice(1) : base;
  const [intPart, fracPart = ''] = unsigned.split('.');
  const digits = intPart + fracPart;
  const decimalPos = intPart.length + exp;
  let result: string;
  if (decimalPos <= 0) {
    result = '0.' + '0'.repeat(-decimalPos) + digits;
  } else if (decimalPos >= digits.length) {
    result = digits + '0'.repeat(decimalPos - digits.length);
  } else {
    result = digits.slice(0, decimalPos) + '.' + digits.slice(decimalPos);
  }
  if (result.includes('.')) result = result.replace(/\.?0+$/, '');
  return negative ? '-' + result : result;
}

export const normalizeParam = (param: string): string | boolean => {
  param = param.trim();

  if (!param.startsWith('0x')) {
    const regSci = REGEX_SCIENTIFIC.exec(param);
    const exponents = regSci ? regSci[2] : null;
    if (regSci && exponents && REGEX_DECIMAL.exec(exponents)) {
      try {
        let paramTrimmed = param.replace(/^'/g, '').replace(/'$/g, '');
        paramTrimmed = paramTrimmed.replace(/^"/g, '').replace(/"$/g, '');
        param = fromExponential(paramTrimmed);
      } catch {
        /* fall through */
      }
    }
  }

  if (param === 'true') return true;
  if (param === 'false') return false;
  return param;
};

export function isArrayOrStringStart(str: string, index: number): boolean {
  return str.charAt(index) === '"' || str.charAt(index) === '[';
}

// no-op kept for API parity with Remix
export function atAddress(): void {
  /* intentionally empty */
}
