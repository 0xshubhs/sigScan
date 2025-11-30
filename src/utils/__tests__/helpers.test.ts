import {
  generateFunctionSelector,
  generateEventSignature,
  normalizeFunctionSignature,
  normalizeType,
  shouldIncludeFunction,
} from '../helpers';

describe('helpers', () => {
  describe('generateFunctionSelector', () => {
    it('should generate correct function selector for transfer(address,uint256)', () => {
      const selector = generateFunctionSelector('transfer(address,uint256)');
      expect(selector).toBe('0xa9059cbb');
    });

    it('should generate correct function selector for approve(address,uint256)', () => {
      const selector = generateFunctionSelector('approve(address,uint256)');
      expect(selector).toBe('0x095ea7b3');
    });

    it('should generate correct selector for balanceOf(address)', () => {
      const selector = generateFunctionSelector('balanceOf(address)');
      expect(selector).toBe('0x70a08231');
    });
  });

  describe('generateEventSignature', () => {
    it('should generate correct event signature for Transfer(address,address,uint256)', () => {
      const signature = generateEventSignature('Transfer(address,address,uint256)');
      expect(signature).toBe('0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
    });

    it('should generate correct event signature for Approval(address,address,uint256)', () => {
      const signature = generateEventSignature('Approval(address,address,uint256)');
      expect(signature).toBe('0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925');
    });
  });

  describe('normalizeFunctionSignature', () => {
    it('should normalize function with single parameter', () => {
      const inputs = [{ name: 'account', type: 'address' }];
      const signature = normalizeFunctionSignature('balanceOf', inputs);
      expect(signature).toBe('balanceOf(address)');
    });

    it('should normalize function with multiple parameters', () => {
      const inputs = [
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ];
      const signature = normalizeFunctionSignature('transfer', inputs);
      expect(signature).toBe('transfer(address,uint256)');
    });

    it('should normalize function with no parameters', () => {
      const signature = normalizeFunctionSignature('totalSupply', []);
      expect(signature).toBe('totalSupply()');
    });

    it('should normalize array types correctly', () => {
      const inputs = [{ name: 'values', type: 'uint256[]' }];
      const signature = normalizeFunctionSignature('setValues', inputs);
      expect(signature).toBe('setValues(uint256[])');
    });
  });

  describe('normalizeType', () => {
    it('should remove spaces from types', () => {
      expect(normalizeType('uint256 ')).toBe('uint256');
      expect(normalizeType(' address')).toBe('address');
      expect(normalizeType('uint 256')).toBe('uint256');
    });

    it('should normalize array notation', () => {
      expect(normalizeType('uint256[ ]')).toBe('uint256[]');
      expect(normalizeType('address []')).toBe('address[]');
    });

    it('should handle nested arrays', () => {
      expect(normalizeType('uint256[][]')).toBe('uint256[][]');
    });
  });

  describe('shouldIncludeFunction', () => {
    it('should always include public functions', () => {
      expect(shouldIncludeFunction('public')).toBe(true);
      expect(shouldIncludeFunction('public', false, false)).toBe(true);
    });

    it('should always include external functions', () => {
      expect(shouldIncludeFunction('external')).toBe(true);
      expect(shouldIncludeFunction('external', false, false)).toBe(true);
    });

    it('should include internal functions only when flag is set', () => {
      expect(shouldIncludeFunction('internal')).toBe(false);
      expect(shouldIncludeFunction('internal', true)).toBe(true);
      expect(shouldIncludeFunction('internal', true, false)).toBe(true);
    });

    it('should include private functions only when flag is set', () => {
      expect(shouldIncludeFunction('private')).toBe(false);
      expect(shouldIncludeFunction('private', false, true)).toBe(true);
      expect(shouldIncludeFunction('private', true, true)).toBe(true);
    });

    it('should handle default visibility (public)', () => {
      expect(shouldIncludeFunction('')).toBe(false);
    });
  });
});
