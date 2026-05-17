// Barrel for the Remix Deploy & Run port. Pure logic only — safe in extension host or webview.
//
// Provenance: ported from github.com/ethereum/remix-project
//   - tx-helper.ts        ← libs/remix-lib/src/execution/txHelper.ts
//   - tx-format.ts        ← libs/remix-lib/src/execution/txFormat.ts
//   - events-decoder.ts   ← libs/remix-lib/src/execution/eventsDecoder.ts

export {
  makeFullTypeDefinition,
  encodeFunctionId,
  getFunctionFragment,
  sortAbiFunction,
  getConstructorInterface,
  serializeInputs,
  extractSize,
  getFunctionLiner,
  getFunction,
  getFallbackInterface,
  getReceiveInterface,
  getContract,
  visitContracts,
  inputParametersDeclarationToString,
} from './tx-helper';
export type {
  AbiEntry,
  AbiParameter,
  CompiledContract,
  CompiledContractsMap,
} from './tx-helper';

// The low-level `encodeParams(funABI, args)` lives in tx-helper but tx-format
// re-exports its own higher-level `encodeParams(params, funAbi)` — import the
// low-level one directly from `./tx-helper` if you need it.

export {
  encodeData,
  encodeParams,
  encodeFunctionCall,
  encodeConstructorCallAndLinkLibraries,
  encodeConstructorCallAndDeployLibraries,
  buildData,
  linkBytecode,
  linkBytecodeStandard,
  linkBytecodeLegacy,
  linkLibraries,
  linkLibrary,
  linkLibraryStandard,
  linkLibraryStandardFromlinkReferences,
  setLibraryAddress,
  deployLibrary,
  decodeResponse,
  parseFunctionParams,
  normalizeParam,
  isArrayOrStringStart,
  atAddress,
  REGEX_SCIENTIFIC,
  REGEX_DECIMAL,
} from './tx-format';
export type {
  EncodedCall,
  EncodedParams,
  EncodedFunctionCall,
  EncodedConstructorCall,
  LinkLibrariesAddresses,
  LinkReferences,
  DeployLibraryCallback,
} from './tx-format';

export { EventsDecoder } from './events-decoder';
export type {
  RawLog,
  TxLike,
  ReceiptLike,
  ResolveReceipt,
  DecodedEvent,
  DecodedLogs,
} from './events-decoder';
