/**
 * EVM Toolbox — pure-logic tests. Where possible, results are cross-checked
 * against ethers' own implementations so the suite does not rely on memorized
 * vectors. No network access anywhere.
 */

import {
  AbiCoder,
  Interface,
  Transaction,
  getCreateAddress,
  getCreate2Address,
  keccak256 as ethersKeccak,
} from 'ethers';

import {
  bigIntToHex,
  hexToBigInt,
  hexToUtf8,
  isHexString,
  normalizeHex,
  padLeft,
  utf8ToHex,
} from '../hex';
import { buildConversions, formatUnits, parseDecimal } from '../units';
import {
  isValidAddress,
  keccakUtf8,
  selectorOfCanonicalSignature,
  toChecksumAddress,
  topic0OfCanonicalSignature,
} from '../hash';
import {
  computeCreate2Address,
  computeCreate2AddressFromInitCode,
  computeCreateAddress,
} from '../address';
import { dynamicArrayDataSlot, erc7201Slot, mappingEntrySlot, wellKnownSlots } from '../slots';
import { ethConstants } from '../constants';
import { describeEpoch, parseEpochInput, relativeTime } from '../epoch';
import {
  abiEncodeParams,
  encodeFunctionCallData,
  encodePackedParams,
  parseHumanSignature,
  splitTopLevelTypes,
} from '../encoder';
import {
  decodeAbiBlob,
  decodeCalldata,
  decodeEventLog,
  decodeRawTransaction,
  indexedLayouts,
  looksLikeCalldata,
  sanitizeCalldataInput,
} from '../decoder';

const HOLDER = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
const RECIPIENT = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

describe('hex utilities', () => {
  it('normalizes and validates hex', () => {
    expect(normalizeHex('ABCD')).toBe('0xabcd');
    expect(normalizeHex('0xf')).toBe('0x0f');
    expect(isHexString('0x1234', 2)).toBe(true);
    expect(isHexString('0x1234', 3)).toBe(false);
    expect(isHexString('xyz')).toBe(false);
  });

  it('round-trips bigint and utf8', () => {
    expect(hexToBigInt(bigIntToHex(123456789n))).toBe(123456789n);
    expect(hexToUtf8(utf8ToHex('hello Ω'))).toBe('hello Ω');
    expect(hexToUtf8('0x00ff')).toBeNull();
  });

  it('pads to EVM words', () => {
    expect(padLeft('0x1', 32)).toBe(`0x${'1'.padStart(64, '0')}`);
    expect(() => padLeft(`0x${'11'.repeat(33)}`, 32)).toThrow();
  });
});

describe('unit conversion', () => {
  it('parses exact decimals', () => {
    expect(parseDecimal('1.5', 18)).toBe(1_500_000_000_000_000_000n);
    expect(parseDecimal('0.000000001', 9)).toBe(1n);
    expect(() => parseDecimal('1.5', 0)).toThrow(); // fractional wei
  });

  it('formats without precision loss', () => {
    expect(formatUnits(1_500_000_000_000_000_000n, 18)).toBe('1.5');
    expect(formatUnits(1n, 18)).toBe('0.000000000000000001');
    expect(formatUnits(-25n, 1)).toBe('-2.5');
  });

  it('builds interpretations for plain, suffixed, and hex input', () => {
    const plain = buildConversions('1.5');
    expect(plain.map((r) => r.interpretation)).toEqual(['1.5 gwei', '1.5 ether']); // fractional wei impossible
    const suffixed = buildConversions('2 gwei');
    expect(suffixed[0].values.find((v) => v.unit === 'wei')?.value).toBe('2000000000');
    const hex = buildConversions('0xde0b6b3a7640000');
    expect(hex[0].values.find((v) => v.unit === 'ether')?.value).toBe('1');
  });
});

describe('hashing and checksums', () => {
  it('computes famous selectors and topics', () => {
    expect(selectorOfCanonicalSignature('transfer(address,uint256)')).toBe('0xa9059cbb');
    expect(topic0OfCanonicalSignature('Transfer(address,address,uint256)')).toBe(
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
    );
  });

  it('matches ethers keccak on utf8 payloads', () => {
    expect(keccakUtf8('hello')).toBe(ethersKeccak(Buffer.from('hello', 'utf8')));
  });

  it('EIP-55 checksums (spec vectors)', () => {
    expect(toChecksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')).toBe(
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
    );
    expect(toChecksumAddress('0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359')).toBe(
      '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359'
    );
    expect(isValidAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toBe(true);
    expect(isValidAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1Beaed')).toBe(false); // bad case
    expect(isValidAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')).toBe(true); // no checksum encoded
  });
});

describe('deterministic addresses', () => {
  it('CREATE matches ethers for a range of nonces', () => {
    for (const nonce of [0n, 1n, 127n, 128n, 256n, 1_000_000n]) {
      expect(computeCreateAddress(HOLDER, nonce)).toBe(getCreateAddress({ from: HOLDER, nonce }));
    }
  });

  it('CREATE2 matches ethers and the EIP-1014 example', () => {
    const salt = padLeft('0x1234', 32);
    const initCodeHash = keccakUtf8('init');
    expect(computeCreate2Address(HOLDER, salt, initCodeHash)).toBe(
      getCreate2Address(HOLDER, salt, initCodeHash)
    );
    // EIP-1014 example 0: deployer 0x0, salt 0x0, init code 0x00.
    expect(
      computeCreate2AddressFromInitCode(
        '0x0000000000000000000000000000000000000000',
        padLeft('0x00', 32),
        '0x00'
      )
    ).toBe('0x4D1A2e2bB4F88F0250f26Ffff098B0b30B26BF38');
  });
});

describe('storage slots', () => {
  it('mapping slots match abi.encode + keccak', () => {
    const expected = ethersKeccak(
      AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [HOLDER, 3n])
    );
    expect(mappingEntrySlot('address', HOLDER, 3n)).toBe(expected);
  });

  it('string keys hash raw bytes (not padded)', () => {
    const expected = ethersKeccak(
      Buffer.concat([Buffer.from('alice', 'utf8'), Buffer.from(padLeft('0x2', 32).slice(2), 'hex')])
    );
    expect(mappingEntrySlot('string', 'alice', 2n)).toBe(expected);
  });

  it('array data slot is keccak(pad32(slot))', () => {
    expect(dynamicArrayDataSlot(5n)).toBe(ethersKeccak(padLeft('0x05', 32)));
  });

  it('EIP-1967 implementation slot derives to the famous constant', () => {
    const impl = wellKnownSlots().find((s) => s.name.includes('implementation'));
    expect(impl?.slot).toBe('0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc');
  });

  it('ERC-7201 formula ends 00 and matches the spec example', () => {
    const slot = erc7201Slot('example.main');
    expect(slot.endsWith('00')).toBe(true);
    expect(slot).toBe('0x183a6125c38840424c4a85fa12bab2ab606c4b6d0e7cc73c0c06ba5300eab500');
  });
});

describe('constants catalog', () => {
  it('contains computed selectors that agree with the hasher', () => {
    const constants = ethConstants();
    const transfer = constants.find(
      (c) => c.group === 'Selectors' && c.name === 'transfer(address,uint256)'
    );
    expect(transfer?.value).toBe('0xa9059cbb');
    expect(constants.find((c) => c.name === 'max uint256')?.value).toBe(
      (2n ** 256n - 1n).toString()
    );
  });
});

describe('epoch converter', () => {
  const NOW = 1_750_000_000_000; // fixed "now" for determinism

  it('parses seconds, milliseconds, hex, and dates', () => {
    expect(parseEpochInput('1700000000', NOW)?.seconds).toBe(1_700_000_000);
    expect(parseEpochInput('1700000000000', NOW)?.interpretedAs).toBe('unix milliseconds');
    expect(parseEpochInput('0x6553f100', NOW)?.seconds).toBe(0x6553f100);
    expect(parseEpochInput('2023-11-14T22:13:20Z', NOW)?.seconds).toBe(1_700_000_000);
    expect(parseEpochInput('garbage', NOW)).toBeNull();
  });

  it('describes and relativizes', () => {
    const info = parseEpochInput('1700000000', NOW)!;
    const rows = describeEpoch(info, NOW);
    expect(rows.find((r) => r.label === 'ISO 8601')?.value).toBe('2023-11-14T22:13:20.000Z');
    expect(relativeTime(Math.floor(NOW / 1000) - 90, NOW)).toBe('1 minute ago');
    expect(relativeTime(Math.floor(NOW / 1000) + 3 * 86400, NOW)).toBe('in 3 days');
  });
});

describe('encoder', () => {
  it('canonicalizes human signatures', () => {
    const parsed = parseHumanSignature('function transfer(address to, uint amount)');
    expect(parsed.canonical).toBe('transfer(address,uint256)');
    expect(parsed.selector).toBe('0xa9059cbb');
  });

  it('encodes calldata identically to ethers, with ether-suffix support', () => {
    const iface = new Interface(['function transfer(address,uint256)']);
    const expected = iface.encodeFunctionData('transfer', [RECIPIENT, 1_500_000_000_000_000_000n]);
    const { calldata } = encodeFunctionCallData(
      'transfer(address,uint256)',
      `${RECIPIENT}, 1.5 ether`
    );
    expect(calldata).toBe(expected);
  });

  it('handles arrays, tuples, bools, and strings', () => {
    const { calldata, selector } = encodeFunctionCallData(
      'submit((address,uint256)[] orders, bool active, string note)',
      `[[${RECIPIENT}, 7]], true, "hi there"`
    );
    expect(selector).toHaveLength(10);
    const iface = new Interface([
      'function submit((address,uint256)[] orders, bool active, string note)',
    ]);
    expect(calldata).toBe(
      iface.encodeFunctionData('submit', [[[RECIPIENT, 7n]], true, 'hi there'])
    );
  });

  it('abi.encode and encodePacked match ethers', () => {
    expect(abiEncodeParams('address, uint256', `${RECIPIENT}, 42`)).toBe(
      AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [RECIPIENT, 42n])
    );
    expect(encodePackedParams('address, uint16', `${RECIPIENT}, 513`)).toBe(
      `${RECIPIENT.toLowerCase()}0201`
    );
  });

  it('splits nested type lists at the top level', () => {
    expect(splitTopLevelTypes('uint256, (address, bytes)[], bool')).toEqual([
      'uint256',
      'tuple(address, bytes)[]',
      'bool',
    ]);
  });

  it('rejects wrong arity with a readable error', () => {
    expect(() => encodeFunctionCallData('transfer(address,uint256)', RECIPIENT)).toThrow(
      /Expected 2 arguments, got 1/
    );
  });
});

describe('calldata decoder', () => {
  const transferData = new Interface(['function transfer(address,uint256)']).encodeFunctionData(
    'transfer',
    [RECIPIENT, 1_500_000_000_000_000_000n]
  );

  it('sanitizes pasted input and detects calldata shape', () => {
    expect(sanitizeCalldataInput(` "0xdead beef"\n`)).toBe('0xdeadbeef');
    expect(looksLikeCalldata(transferData)).toBe(true);
    expect(looksLikeCalldata('0xa9059cbb11')).toBe(false);
  });

  it('decodes via a workspace signature with hints', async () => {
    const result = await decodeCalldata(transferData, {
      workspace: (selector) => (selector === '0xa9059cbb' ? ['transfer(address,uint256)'] : []),
    });
    expect(result.candidates[0].ok).toBe(true);
    expect(result.candidates[0].source).toBe('workspace');
    expect(result.candidates[0].params[0].value).toBe(RECIPIENT);
    expect(result.candidates[0].params[1].value).toBe('1500000000000000000');
    expect(result.candidates[0].params[1].hint).toContain('1.5 ether');
  });

  it('skips signatures whose selector does not match', async () => {
    const result = await decodeCalldata(transferData, {
      workspace: () => ['approve(address,uint256)'],
    });
    expect(result.candidates.filter((c) => c.source === 'workspace')).toHaveLength(0);
  });

  it('falls back to type-guessing with no lookups at all', async () => {
    const result = await decodeCalldata(transferData, {});
    const guessed = result.candidates.find((c) => c.source === 'guessed');
    expect(guessed?.ok).toBe(true);
    expect(guessed?.params).toHaveLength(2);
  });

  it('recursively decodes nested multicall payloads', async () => {
    const inner = new Interface(['function transfer(address,uint256)']).encodeFunctionData(
      'transfer',
      [RECIPIENT, 5n]
    );
    const outer = new Interface(['function multicall(bytes[])']).encodeFunctionData('multicall', [
      [inner],
    ]);
    const result = await decodeCalldata(outer, {
      workspace: (selector) =>
        ({ '0xac9650d8': ['multicall(bytes[])'], '0xa9059cbb': ['transfer(address,uint256)'] })[
          selector
        ] ?? [],
    });
    const call = result.candidates[0].params[0].children?.[0];
    expect(call?.decodedAs).toBe('transfer(address,uint256)');
    expect(call?.children?.[0].value).toBe(RECIPIENT);
  });

  it('decodes raw ABI blobs with explicit and guessed types', async () => {
    const blob = AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [RECIPIENT, 9n]);
    const explicit = await decodeAbiBlob(blob, ['address', 'uint256'], {});
    expect(explicit.params[0].value).toBe(RECIPIENT);
    const guessed = await decodeAbiBlob(blob, undefined, {});
    expect(guessed.guessed).toBe(true);
    expect(guessed.params.length).toBeGreaterThan(0);
  });
});

describe('event log decoder', () => {
  const iface = new Interface([
    'event Transfer(address indexed from, address indexed to, uint256 value)',
  ]);
  const encoded = iface.encodeEventLog('Transfer', [HOLDER, RECIPIENT, 42n]);

  it('decodes with exact workspace indexed flags', async () => {
    const result = await decodeEventLog(encoded.topics as string[], encoded.data, {
      workspace: () => [
        {
          signature: 'Transfer(address,address,uint256)',
          inputs: [
            { name: 'from', type: 'address', indexed: true },
            { name: 'to', type: 'address', indexed: true },
            { name: 'value', type: 'uint256', indexed: false },
          ],
        },
      ],
    });
    expect(result.source).toBe('workspace');
    expect(result.params[0].value).toBe(HOLDER);
    expect(result.params[1].name).toContain('(indexed)');
    expect(result.params[2].value).toBe('42');
  });

  it('assumes indexed layout for directory signatures', async () => {
    const result = await decodeEventLog(encoded.topics as string[], encoded.data, {
      online: async () => ['Transfer(address,address,uint256)'],
    });
    expect(result.signature).toBe('Transfer(address,address,uint256)');
    expect(result.assumption).toContain('#1, #2');
    expect(result.params[2].value).toBe('42');
  });

  it('enumerates indexed layouts, most conventional first', () => {
    const layouts = indexedLayouts(3, 2);
    expect(layouts[0]).toEqual([true, true, false]);
    expect(layouts).toHaveLength(3);
    expect(indexedLayouts(10, 5).length).toBeLessThanOrEqual(30);
  });
});

describe('raw transaction decoder', () => {
  it('parses an unsigned EIP-1559 transaction', () => {
    const tx = Transaction.from({
      to: RECIPIENT,
      value: 1_000_000_000_000_000_000n,
      chainId: 8453n,
      nonce: 7,
      gasLimit: 21000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 100_000_000n,
      type: 2,
    });
    const decoded = decodeRawTransaction(tx.unsignedSerialized);
    const field = (label: string) => decoded.fields.find((f) => f.label === label)?.value;
    expect(field('type')).toContain('EIP-1559');
    expect(field('to')).toBe(RECIPIENT);
    expect(field('chainId')).toBe('8453');
    expect(field('maxFeePerGas')).toBe('2 gwei');
    expect(decoded.calldata).toBeUndefined();
  });
});
