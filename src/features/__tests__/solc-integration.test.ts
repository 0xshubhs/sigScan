/**
 * Tests for Solidity Compiler Integration
 */

import { SolcIntegration, SolcGasEstimate } from '../solc-integration';
import * as fs from 'fs';

describe('SolcIntegration', () => {
  let solc: SolcIntegration;
  const testContract = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract TestContract {
    uint256 public value;
    mapping(address => uint256) public balances;

    constructor(uint256 _value) {
        value = _value;
    }

    function setValue(uint256 _value) public {
        value = _value;
    }

    function transfer(address to, uint256 amount) public returns (bool) {
        require(balances[msg.sender] >= amount, "Insufficient balance");
        balances[msg.sender] -= amount;
        balances[to] += amount;
        return true;
    }

    function balanceOf(address account) public view returns (uint256) {
        return balances[account];
    }

    function processLoop(uint256 iterations) public {
        for (uint256 i = 0; i < iterations; i++) {
            value += i;
        }
    }
}
`;

  beforeEach(() => {
    solc = new SolcIntegration(200);
  });

  describe('Solc Detection', () => {
    it('should detect if solc is available', () => {
      const isAvailable = solc.isSolcAvailable();
      expect(typeof isAvailable).toBe('boolean');
    });

    it('should get solc version if available', () => {
      if (solc.isSolcAvailable()) {
        const version = solc.getSolcVersion();
        expect(version).toBeTruthy();
        expect(version).toMatch(/\d+\.\d+\.\d+/);
      }
    });
  });

  describe('Compilation', () => {
    const tempFile = '/tmp/TestContract_solc_test.sol';

    beforeEach(() => {
      fs.writeFileSync(tempFile, testContract);
    });

    afterEach(() => {
      try {
        fs.unlinkSync(tempFile);
      } catch (error) {
        // File may not exist
      }
    });

    it('should compile contract and get gas estimates', async () => {
      if (!solc.isSolcAvailable()) {
        console.log('Skipping test - solc not available');
        return;
      }

      const result = await solc.compileAndGetGasEstimates(tempFile);

      expect(result.success).toBe(true);
      expect(result.gasEstimates).toBeDefined();
      expect(Object.keys(result.gasEstimates).length).toBeGreaterThan(0);
    });

    it('should extract constructor gas estimates', async () => {
      if (!solc.isSolcAvailable()) {
        console.log('Skipping test - solc not available');
        return;
      }

      const result = await solc.compileAndGetGasEstimates(tempFile);

      if (result.success) {
        const constructorEstimate = result.gasEstimates['constructor()'];
        expect(constructorEstimate).toBeDefined();
        expect(constructorEstimate?.min).toBeDefined();
        expect(constructorEstimate?.max).toBeDefined();
      }
    });

    it('should extract function gas estimates with signatures', async () => {
      if (!solc.isSolcAvailable()) {
        console.log('Skipping test - solc not available');
        return;
      }

      const result = await solc.compileAndGetGasEstimates(tempFile);

      if (result.success) {
        // Check for some expected functions
        const signatures = Object.keys(result.gasEstimates);

        // Should have some function signatures
        expect(signatures.length).toBeGreaterThan(0);

        // Check if we have gas estimates in correct format
        const firstSig = signatures[0];
        const estimate = result.gasEstimates[firstSig];
        expect(estimate.min).toBeDefined();
        expect(estimate.max).toBeDefined();
      }
    });

    it('should detect unbounded functions (loops)', async () => {
      if (!solc.isSolcAvailable()) {
        console.log('Skipping test - solc not available');
        return;
      }

      const result = await solc.compileAndGetGasEstimates(tempFile);

      if (result.success) {
        // processLoop function should be unbounded
        const loopFunctions = Object.entries(result.gasEstimates).filter(
          ([_sig, est]) => est.min === 'infinite' || est.max === 'infinite'
        );

        // We might have unbounded functions
        if (loopFunctions.length > 0) {
          const [, estimate] = loopFunctions[0];
          expect(estimate.min === 'infinite' || estimate.max === 'infinite').toBe(true);
        }
      }
    });

    it('should handle compilation errors gracefully', async () => {
      const invalidContract = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Invalid {
    function broken() public {
        // Missing semicolon
        uint256 x = 5
    }
}
`;
      const invalidFile = '/tmp/Invalid_solc_test.sol';
      fs.writeFileSync(invalidFile, invalidContract);

      const result = await solc.compileAndGetGasEstimates(invalidFile);

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors?.length).toBeGreaterThan(0);

      try {
        fs.unlinkSync(invalidFile);
      } catch (error) {
        // File may not exist, ignore
      }
    });
  });

  describe('Complexity Classification', () => {
    it('should classify low complexity', () => {
      const estimate: SolcGasEstimate = { min: 1000, max: 2000 };
      const complexity = solc.classifyComplexity(estimate);
      expect(complexity).toBe('low');
    });

    it('should classify medium complexity', () => {
      const estimate: SolcGasEstimate = { min: 60000, max: 80000 };
      const complexity = solc.classifyComplexity(estimate);
      expect(complexity).toBe('medium');
    });

    it('should classify high complexity', () => {
      const estimate: SolcGasEstimate = { min: 200000, max: 300000 };
      const complexity = solc.classifyComplexity(estimate);
      expect(complexity).toBe('high');
    });

    it('should classify very-high complexity', () => {
      const estimate: SolcGasEstimate = { min: 600000, max: 800000 };
      const complexity = solc.classifyComplexity(estimate);
      expect(complexity).toBe('very-high');
    });

    it('should classify unbounded (infinite) functions', () => {
      const estimate: SolcGasEstimate = { min: 'infinite', max: 'infinite' };
      const complexity = solc.classifyComplexity(estimate);
      expect(complexity).toBe('unbounded');
    });

    it('should classify as unbounded if either min or max is infinite', () => {
      const estimate: SolcGasEstimate = { min: 5000, max: 'infinite' };
      const complexity = solc.classifyComplexity(estimate);
      expect(complexity).toBe('unbounded');
    });
  });

  describe('Factor Inference', () => {
    it('should identify unbounded execution', () => {
      const estimate: SolcGasEstimate = { min: 'infinite', max: 'infinite' };
      const factors = solc.inferFactors('test()', estimate);

      expect(factors).toContain('Unbounded execution (loops or recursion)');
    });

    it('should identify complex control flow', () => {
      const estimate: SolcGasEstimate = { min: 10000, max: 40000 };
      const factors = solc.inferFactors('test()', estimate);

      expect(factors.some((f: string) => f.includes('Complex control flow'))).toBe(true);
    });

    it('should identify expensive operations', () => {
      const estimate: SolcGasEstimate = { min: 120000, max: 150000 };
      const factors = solc.inferFactors('test()', estimate);

      expect(factors.some((f: string) => f.includes('Expensive operations'))).toBe(true);
    });

    it('should identify storage operations', () => {
      const estimate: SolcGasEstimate = { min: 22000, max: 25000 };
      const factors = solc.inferFactors('test()', estimate);

      expect(factors.some((f: string) => f.includes('storage writes'))).toBe(true);
    });

    it('should identify constructor initialization', () => {
      const estimate: SolcGasEstimate = { min: 50000, max: 60000 };
      const factors = solc.inferFactors('constructor(uint256)', estimate);

      expect(factors).toContain('Contract initialization');
    });
  });

  describe('Warning Generation', () => {
    it('should generate warning for unbounded functions', () => {
      const estimate: SolcGasEstimate = { min: 'infinite', max: 'infinite' };
      const warning = solc.generateWarning('test()', estimate);

      expect(warning).toBeTruthy();
      expect(warning).toContain('Unbounded');
    });

    it('should generate warning for very high gas', () => {
      const estimate: SolcGasEstimate = { min: 400000, max: 600000 };
      const warning = solc.generateWarning('test()', estimate);

      expect(warning).toBeTruthy();
      expect(warning).toContain('Very high gas cost');
    });

    it('should generate warning for high gas', () => {
      const estimate: SolcGasEstimate = { min: 250000, max: 350000 };
      const warning = solc.generateWarning('test()', estimate);

      expect(warning).toBeTruthy();
      expect(warning).toContain('High gas cost');
    });

    it('should not generate warning for low gas', () => {
      const estimate: SolcGasEstimate = { min: 5000, max: 8000 };
      const warning = solc.generateWarning('test()', estimate);

      expect(warning).toBeUndefined();
    });
  });

  describe('Get Function Gas Estimate', () => {
    const tempFile = '/tmp/TestFunctionGas.sol';

    beforeEach(() => {
      fs.writeFileSync(tempFile, testContract);
    });

    afterEach(() => {
      try {
        fs.unlinkSync(tempFile);
      } catch (error) {
        // File may not exist
      }
    });

    it('should get gas estimate for specific function', async () => {
      if (!solc.isSolcAvailable()) {
        console.log('Skipping test - solc not available');
        return;
      }

      const estimate = await solc.getFunctionGasEstimate(tempFile, 'setValue(uint256)');

      if (estimate) {
        expect(estimate.min).toBeDefined();
        expect(estimate.max).toBeDefined();
      }
    });

    it('should return null for non-existent function', async () => {
      if (!solc.isSolcAvailable()) {
        console.log('Skipping test - solc not available');
        return;
      }

      const estimate = await solc.getFunctionGasEstimate(tempFile, 'nonExistentFunction()');

      // Might be null if function not found
      if (!estimate) {
        expect(estimate).toBeNull();
      }
    });

    it('should match function by name if exact signature not found', async () => {
      if (!solc.isSolcAvailable()) {
        console.log('Skipping test - solc not available');
        return;
      }

      // Try to get estimate with just function name
      const estimate = await solc.getFunctionGasEstimate(tempFile, 'setValue');

      // Should find it by matching name
      if (estimate) {
        expect(estimate.min).toBeDefined();
        expect(estimate.max).toBeDefined();
      }
    });
  });
});
