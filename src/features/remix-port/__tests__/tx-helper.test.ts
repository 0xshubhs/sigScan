import {
  encodeFunctionId,
  encodeParams,
  getConstructorInterface,
  getFunction,
  getFunctionLiner,
  getFallbackInterface,
  getReceiveInterface,
  makeFullTypeDefinition,
  serializeInputs,
  sortAbiFunction,
  visitContracts,
  type AbiEntry,
  type CompiledContractsMap,
} from '../tx-helper';

describe('tx-helper · encodeFunctionId', () => {
  it('computes selector for transfer(address,uint256)', () => {
    const abi: AbiEntry = {
      type: 'function',
      name: 'transfer',
      inputs: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
      ],
      stateMutability: 'nonpayable',
      outputs: [{ name: '', type: 'bool' }],
    };
    expect(encodeFunctionId(abi)).toBe('0xa9059cbb');
  });

  it('computes selector for approve(address,uint256)', () => {
    const abi: AbiEntry = {
      type: 'function',
      name: 'approve',
      inputs: [
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
      ],
      stateMutability: 'nonpayable',
      outputs: [{ name: '', type: 'bool' }],
    };
    expect(encodeFunctionId(abi)).toBe('0x095ea7b3');
  });

  it('returns 0x for fallback and receive', () => {
    expect(encodeFunctionId({ type: 'fallback' })).toBe('0x');
    expect(encodeFunctionId({ type: 'receive' })).toBe('0x');
  });
});

describe('tx-helper · encodeParams (low-level)', () => {
  it('encodes a uint256 + address pair', () => {
    const abi: AbiEntry = {
      type: 'function',
      name: 'transfer',
      inputs: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
      ],
    };
    const out = encodeParams(abi, ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 1n]);
    expect(out).toMatch(/^0x[0-9a-fA-F]{128}$/);
    expect(out.toLowerCase()).toContain('70997970c51812dc3a010c7d01b50e0d17dc79c8');
    expect(out.endsWith('1'.padStart(64, '0'))).toBe(true);
  });

  it('coerces bool-ish args to booleans', () => {
    const abi: AbiEntry = {
      type: 'function',
      name: 'set',
      inputs: [{ name: 'flag', type: 'bool' }],
    };
    expect(() => encodeParams(abi, ['true'])).not.toThrow();
    expect(() => encodeParams(abi, ['1'])).not.toThrow();
    expect(() => encodeParams(abi, ['nope'])).toThrow(/boolean is invalid/);
  });
});

describe('tx-helper · type / fragment utilities', () => {
  it('makeFullTypeDefinition expands a tuple', () => {
    expect(
      makeFullTypeDefinition({
        type: 'tuple',
        components: [
          { name: 'a', type: 'uint256' },
          { name: 'b', type: 'address' },
        ],
      })
    ).toBe('tuple(uint256,address)');
  });

  it('makeFullTypeDefinition handles tuple arrays', () => {
    expect(
      makeFullTypeDefinition({
        type: 'tuple[]',
        components: [
          { name: 'a', type: 'uint256' },
          { name: 'b', type: 'address' },
        ],
      })
    ).toBe('tuple(uint256,address)[]');
  });

  it('serializeInputs returns a comma-joined type list in parens', () => {
    expect(
      serializeInputs({
        type: 'function',
        name: 'foo',
        inputs: [
          { name: 'x', type: 'uint256' },
          { name: 'y', type: 'bool' },
        ],
      })
    ).toBe('(uint256,bool)');
    expect(serializeInputs({ type: 'function', name: 'noargs', inputs: [] })).toBe('()');
  });

  it('getFunctionLiner produces the canonical signature', () => {
    expect(
      getFunctionLiner({
        type: 'function',
        name: 'transfer',
        inputs: [
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
        ],
      })
    ).toBe('transfer(address,uint256)');
  });
});

describe('tx-helper · ABI lookups', () => {
  const abi: AbiEntry[] = [
    { type: 'constructor', inputs: [{ name: 'x', type: 'uint256' }] },
    {
      type: 'function',
      name: 'foo',
      inputs: [{ name: 'a', type: 'uint256' }],
      stateMutability: 'view',
    },
    { type: 'function', name: 'bar', inputs: [], stateMutability: 'nonpayable' },
    { type: 'fallback' },
    { type: 'receive', stateMutability: 'payable' },
  ];

  it('getConstructorInterface returns the constructor entry', () => {
    const c = getConstructorInterface(abi);
    expect(c.type).toBe('constructor');
    expect(c.inputs).toEqual([{ name: 'x', type: 'uint256' }]);
  });

  it('getConstructorInterface accepts a JSON string', () => {
    const c = getConstructorInterface(JSON.stringify(abi));
    expect(c.inputs).toEqual([{ name: 'x', type: 'uint256' }]);
  });

  it('getFallbackInterface / getReceiveInterface find the right entries', () => {
    expect(getFallbackInterface(abi)?.type).toBe('fallback');
    expect(getReceiveInterface(abi)?.type).toBe('receive');
  });

  it('getFunction matches by canonical signature', () => {
    expect(getFunction(abi, 'foo(uint256)')?.name).toBe('foo');
    expect(getFunction(abi, 'bar()')?.name).toBe('bar');
    expect(getFunction(abi, 'missing()')).toBeNull();
  });

  it('sortAbiFunction puts non-constant before constant', () => {
    const sorted = sortAbiFunction([...abi]);
    const fns = sorted.filter((e) => e.type === 'function');
    expect(fns[0].name).toBe('bar');
    expect(fns[1].name).toBe('foo');
  });
});

describe('tx-helper · visitContracts', () => {
  it('iterates files × names and stops on truthy return', () => {
    const contracts: CompiledContractsMap = {
      'A.sol': { A: { abi: [] }, B: { abi: [] } },
      'C.sol': { C: { abi: [] } },
    };
    const seen: string[] = [];
    visitContracts(contracts, (e) => {
      seen.push(e.name);
      return e.name === 'B';
    });
    expect(seen).toEqual(['A', 'B']);
  });
});
