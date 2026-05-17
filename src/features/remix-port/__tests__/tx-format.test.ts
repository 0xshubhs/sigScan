import {
  decodeResponse,
  encodeData,
  encodeFunctionCall,
  encodeParams,
  normalizeParam,
  parseFunctionParams,
} from '../tx-format';
import type { AbiEntry } from '../tx-helper';
import { AbiCoder } from 'ethers';

const transferAbi: AbiEntry = {
  type: 'function',
  name: 'transfer',
  inputs: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
  ],
  outputs: [{ name: '', type: 'bool' }],
  stateMutability: 'nonpayable',
};

const tupleAbi: AbiEntry = {
  type: 'function',
  name: 'submit',
  inputs: [
    {
      name: 'order',
      type: 'tuple',
      components: [
        { name: 'amount', type: 'uint256' },
        { name: 'taker', type: 'address' },
      ],
    },
  ],
  outputs: [],
  stateMutability: 'nonpayable',
};

describe('tx-format · encodeData', () => {
  it('encodes a function call (selector + args)', () => {
    const out = encodeData(transferAbi, ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 100n]);
    expect(out.data).toBeDefined();
    // selector(transfer(address,uint256)) = 0xa9059cbb
    expect(out.data!.startsWith('0xa9059cbb')).toBe(true);
    // 0x + 4-byte selector + 2*32 bytes args
    expect(out.data!.length).toBe(2 + 8 + 128);
  });

  it('encodes a constructor with bytecode prefix', () => {
    const ctorAbi: AbiEntry = {
      type: 'constructor',
      inputs: [{ name: 'x', type: 'uint256' }],
    };
    const bytecode = '6080604052';
    const out = encodeData(ctorAbi, [42n], bytecode);
    expect(out.data).toBeDefined();
    expect(out.data!.startsWith('0x' + bytecode)).toBe(true);
    expect(out.data!.endsWith('2a'.padStart(64, '0'))).toBe(true);
  });

  it('returns an error for unencodable args', () => {
    const out = encodeData(transferAbi, ['not-an-address', 'not-a-number']);
    expect(out.error).toMatch(/cannot encode/);
  });
});

describe('tx-format · encodeParams', () => {
  it('encodes from an array of values', () => {
    const out = encodeParams(['0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 7n], transferAbi);
    expect(out.dataHex.length).toBe(128);
    expect(out.funArgs).toEqual(['0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 7n]);
  });

  it('encodes from a Remix-style string', () => {
    const out = encodeParams('"0x70997970C51812dc3A010C7d01b50e0d17dc79C8", 7', transferAbi);
    expect(out.dataHex.length).toBe(128);
  });

  it('accepts raw:0x calldata payload (no selector)', () => {
    const payload = '00'.repeat(64);
    const out = encodeParams('raw:0x' + payload, transferAbi);
    expect(out.dataHex).toBe(payload);
    expect(out.data).toBe('0x' + payload);
  });

  it('encodes a tuple via Remix-string syntax', () => {
    const out = encodeParams('[100, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"]', tupleAbi);
    expect(out.dataHex.length).toBe(128);
  });
});

describe('tx-format · encodeFunctionCall', () => {
  it('produces selector + encoded args', () => {
    const out = encodeFunctionCall(['0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 1n], transferAbi);
    expect(out.dataHex.startsWith('0xa9059cbb')).toBe(true);
    expect(out.dataHex.length).toBe(2 + 8 + 128);
  });
});

describe('tx-format · decodeResponse', () => {
  it('decodes a uint256 + address tuple return', () => {
    const fnAbi: AbiEntry = {
      type: 'function',
      name: 'foo',
      inputs: [],
      outputs: [
        { name: 'value', type: 'uint256' },
        { name: 'owner', type: 'address' },
      ],
    };
    const encoded = new AbiCoder().encode(
      ['uint256', 'address'],
      [42n, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8']
    );
    const decoded = decodeResponse(encoded, fnAbi);
    expect((decoded as Record<string, string>)[0]).toContain('uint256');
    expect((decoded as Record<string, string>)[0]).toContain('42');
    expect((decoded as Record<string, string>)[1]).toContain('address');
    expect((decoded as Record<string, string>)[1].toLowerCase()).toContain(
      '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'
    );
  });

  it('returns {} when the function has no outputs', () => {
    const fnAbi: AbiEntry = { type: 'function', name: 'foo', inputs: [], outputs: [] };
    expect(decodeResponse('0x', fnAbi)).toEqual({});
  });
});

describe('tx-format · parseFunctionParams', () => {
  it('parses positional scalars', () => {
    expect(parseFunctionParams('1, 2, 3')).toEqual(['1', '2', '3']);
  });

  it('parses quoted strings (including commas inside)', () => {
    expect(parseFunctionParams('"hello, world", 42')).toEqual(['hello, world', '42']);
  });

  it('parses nested arrays', () => {
    expect(parseFunctionParams('[1, 2, [3, 4]], "x"')).toEqual([['1', '2', ['3', '4']], 'x']);
  });

  it('throws on unterminated string', () => {
    expect(() => parseFunctionParams('"oops')).toThrow(/invalid params/);
  });

  it('throws on unbalanced bracket', () => {
    expect(() => parseFunctionParams('[1, 2')).toThrow(/invalid tuple/);
  });
});

describe('tx-format · normalizeParam', () => {
  it('converts scientific notation to decimal', () => {
    expect(normalizeParam('1e18')).toBe('1000000000000000000');
    expect(normalizeParam('5e3')).toBe('5000');
  });

  it('coerces boolean literals', () => {
    expect(normalizeParam('true')).toBe(true);
    expect(normalizeParam('false')).toBe(false);
  });

  it('passes hex through unchanged', () => {
    expect(normalizeParam('0xdeadbeef')).toBe('0xdeadbeef');
  });
});
