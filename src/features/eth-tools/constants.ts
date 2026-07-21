/**
 * Curated Ethereum constants (eth.sh "Constants"): addresses, numeric bounds,
 * gas costs, and famous selectors/topics. Everything derivable is computed at
 * module load from its defining formula so values can never drift.
 */

import { selectorOfCanonicalSignature, topic0OfCanonicalSignature } from './hash';
import { bigIntToHex } from './hex';
import { wellKnownSlots } from './slots';

export interface EthConstant {
  group: 'Addresses' | 'Numbers' | 'Gas' | 'Selectors' | 'Event topics' | 'Storage slots';
  name: string;
  value: string;
  note?: string;
}

const MAX = (bits: bigint): bigint => (1n << bits) - 1n;

function numberConstant(name: string, value: bigint, note?: string): EthConstant[] {
  return [
    { group: 'Numbers', name, value: value.toString(10), note },
    { group: 'Numbers', name: `${name} (hex)`, value: bigIntToHex(value), note },
  ];
}

export function ethConstants(): EthConstant[] {
  const constants: EthConstant[] = [
    // -- Addresses (well-known, external — cannot be derived) --------------
    {
      group: 'Addresses',
      name: 'Zero address',
      value: '0x0000000000000000000000000000000000000000',
    },
    {
      group: 'Addresses',
      name: 'ETH pseudo-address',
      value: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
      note: 'Convention for native ETH in token lists',
    },
    {
      group: 'Addresses',
      name: 'Dead address',
      value: '0x000000000000000000000000000000000000dEaD',
      note: 'Common burn target',
    },
    {
      group: 'Addresses',
      name: 'CREATE2 deterministic deployer',
      value: '0x4e59b44847b379578588920cA78FbF26c0B4956C',
      note: 'Used by Foundry/Hardhat deterministic deployments',
    },
    {
      group: 'Addresses',
      name: 'Multicall3',
      value: '0xcA11bde05977b3631167028862bE2a173976CA11',
      note: 'Same address on 100+ chains',
    },
    {
      group: 'Addresses',
      name: 'Permit2',
      value: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      note: 'Uniswap Permit2',
    },
    {
      group: 'Addresses',
      name: 'WETH (mainnet)',
      value: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    },
    {
      group: 'Addresses',
      name: 'USDC (mainnet)',
      value: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    },
    {
      group: 'Addresses',
      name: 'ERC-4337 EntryPoint v0.6',
      value: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    },
    {
      group: 'Addresses',
      name: 'ERC-4337 EntryPoint v0.7',
      value: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    },

    // -- Numbers -----------------------------------------------------------
    ...numberConstant('max uint256', MAX(256n)),
    ...numberConstant('max uint128', MAX(128n)),
    ...numberConstant('max uint64', MAX(64n)),
    ...numberConstant('max uint32', MAX(32n)),
    ...numberConstant('max int256', MAX(255n)),
    { group: 'Numbers', name: 'min int256', value: (-(1n << 255n)).toString(10) },
    {
      group: 'Numbers',
      name: 'min int256 (hex, two’s complement)',
      value: bigIntToHex(1n << 255n),
    },
    {
      group: 'Numbers',
      name: 'secp256k1 curve order N',
      value: '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141',
      note: 's values above N/2 are malleable (EIP-2)',
    },
    { group: 'Numbers', name: '1 ether in wei', value: (10n ** 18n).toString(10) },
    { group: 'Numbers', name: '1 gwei in wei', value: (10n ** 9n).toString(10) },
    { group: 'Numbers', name: 'Seconds per year', value: '31536000', note: '365 days' },

    // -- Gas ---------------------------------------------------------------
    { group: 'Gas', name: 'Base transaction cost', value: '21000' },
    { group: 'Gas', name: 'Calldata byte (zero)', value: '4', note: 'Per zero byte of calldata' },
    {
      group: 'Gas',
      name: 'Calldata byte (non-zero)',
      value: '16',
      note: 'Per non-zero byte (EIP-2028)',
    },
    { group: 'Gas', name: 'SSTORE (0 → non-zero)', value: '20000' },
    {
      group: 'Gas',
      name: 'SSTORE (non-zero → non-zero)',
      value: '5000',
      note: 'Warm slot: 2900 + access costs',
    },
    { group: 'Gas', name: 'Cold SLOAD', value: '2100', note: 'EIP-2929; warm SLOAD is 100' },
    {
      group: 'Gas',
      name: 'Contract creation',
      value: '32000',
      note: 'Plus 200 gas per byte of deployed code',
    },
    { group: 'Gas', name: 'Max contract size', value: '24576', note: 'EIP-170 (24 KiB)' },
    { group: 'Gas', name: 'Max init code size', value: '49152', note: 'EIP-3860 (48 KiB)' },
  ];

  // -- Selectors & topics (computed from canonical signatures) -------------
  const selectorSigs = [
    'transfer(address,uint256)',
    'transferFrom(address,address,uint256)',
    'approve(address,uint256)',
    'balanceOf(address)',
    'allowance(address,address)',
    'totalSupply()',
    'supportsInterface(bytes4)',
    'safeTransferFrom(address,address,uint256)',
    'ownerOf(uint256)',
    'multicall(bytes[])',
    'execute(bytes,bytes[],uint256)',
  ];
  for (const sig of selectorSigs) {
    constants.push({ group: 'Selectors', name: sig, value: selectorOfCanonicalSignature(sig) });
  }

  const eventSigs = [
    'Transfer(address,address,uint256)',
    'Approval(address,address,uint256)',
    'ApprovalForAll(address,address,bool)',
    'TransferSingle(address,address,address,uint256,uint256)',
    'OwnershipTransferred(address,address)',
    'Upgraded(address)',
    'Deposit(address,uint256)',
    'Withdrawal(address,uint256)',
  ];
  for (const sig of eventSigs) {
    constants.push({ group: 'Event topics', name: sig, value: topic0OfCanonicalSignature(sig) });
  }

  for (const { name, formula, slot } of wellKnownSlots()) {
    constants.push({ group: 'Storage slots', name, value: slot, note: formula });
  }

  return constants;
}
