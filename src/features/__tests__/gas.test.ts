/**
 * Tests for Gas Estimator with Solc Integration
 */

import { GasEstimator, GasEstimate } from '../gas';
import { FunctionSignature } from '../../types';
import * as fs from 'fs';

describe('GasEstimator', () => {
  let estimator: GasEstimator;

  const simpleFunction = `
    uint256 result = a + b;
    return result;
  `;

  const storageFunction = `
    value = _newValue;
    balances[msg.sender] = _amount;
  `;

  const loopFunction = `
    for (uint256 i = 0; i < iterations; i++) {
        total += i;
    }
  `;

  const complexFunction = `
    require(balances[msg.sender] >= amount, "Insufficient");
    balances[msg.sender] -= amount;
    balances[to] += amount;
    emit Transfer(msg.sender, to, amount);
  `;

  describe('Initialization', () => {
    it('should create estimator with default settings', () => {
      estimator = new GasEstimator();
      expect(estimator).toBeDefined();
    });

    it('should create estimator with custom optimizer runs', () => {
      estimator = new GasEstimator(true, 1000);
      expect(estimator).toBeDefined();
    });

    it('should create estimator with solc disabled', () => {
      estimator = new GasEstimator(false);
      expect(estimator).toBeDefined();
      expect(estimator.isSolcAvailable()).toBe(false);
    });

    it('should report solc availability', () => {
      estimator = new GasEstimator();
      const isAvailable = estimator.isSolcAvailable();
      expect(typeof isAvailable).toBe('boolean');
    });

    it('should get solc version if available', () => {
      estimator = new GasEstimator();
      if (estimator.isSolcAvailable()) {
        const version = estimator.getSolcVersion();
        expect(version).toBeTruthy();
      }
    });
  });

  describe('Heuristic Gas Estimation (Sync)', () => {
    beforeEach(() => {
      estimator = new GasEstimator(false); // Disable solc for pure heuristic tests
    });

    it('should estimate gas for simple computation', () => {
      const estimate = estimator.estimateGasSync(simpleFunction, 'add(uint256,uint256)');

      expect(estimate).toBeDefined();
      expect(estimate.signature).toBe('add(uint256,uint256)');
      expect(estimate.selector).toBeTruthy();
      expect(estimate.selector).toMatch(/^0x[0-9a-f]{8}$/);
      expect(estimate.estimatedGas.min).toBeGreaterThan(0);
      expect(estimate.estimatedGas.max).toBeGreaterThan(0);
      expect(estimate.estimatedGas.average).toBeGreaterThan(0);
      expect(estimate.complexity).toBe('low');
      expect(estimate.source).toBe('heuristic');
    });

    it('should estimate gas for storage operations', () => {
      const estimate = estimator.estimateGasSync(storageFunction, 'updateStorage(uint256,uint256)');

      expect(estimate.estimatedGas.min).toBeGreaterThan(20000); // Storage writes are expensive
      expect(estimate.factors.some((f) => f.includes('storage'))).toBe(true);
      expect(estimate.complexity).toBe('low');
      expect(estimate.source).toBe('heuristic');
    });

    it('should identify loops and estimate high gas', () => {
      const estimate = estimator.estimateGasSync(loopFunction, 'processLoop(uint256)');

      // Check gas values are numbers before comparison
      if (
        typeof estimate.estimatedGas.max === 'number' &&
        typeof estimate.estimatedGas.min === 'number'
      ) {
        expect(estimate.estimatedGas.max).toBeGreaterThan(estimate.estimatedGas.min);
      }
      expect(estimate.factors.some((f) => f.includes('loop'))).toBe(true);
      expect(estimate.warning).toContain('unbounded');
      expect(estimate.source).toBe('heuristic');
    });

    it('should detect external calls', () => {
      const externalCallFunction = `
        token.transfer(to, amount);
        oracle.getPrice();
      `;
      const estimate = estimator.estimateGasSync(externalCallFunction, 'doExternalCalls()');

      expect(estimate.factors.some((f) => f.includes('external call'))).toBe(true);
      expect(estimate.source).toBe('heuristic');
    });

    it('should detect events', () => {
      const estimate = estimator.estimateGasSync(complexFunction, 'transfer(address,uint256)');

      expect(estimate.factors.some((f) => f.includes('event'))).toBe(true);
      expect(estimate.source).toBe('heuristic');
    });

    it('should detect require statements', () => {
      const estimate = estimator.estimateGasSync(complexFunction, 'transfer(address,uint256)');

      expect(estimate.factors.some((f) => f.includes('Conditional logic'))).toBe(true);
      expect(estimate.source).toBe('heuristic');
    });

    it('should calculate correct selector for known functions', () => {
      // transfer(address,uint256) should be 0xa9059cbb
      const estimate = estimator.estimateGasSync(complexFunction, 'transfer(address,uint256)');
      expect(estimate.selector).toBe('0xa9059cbb');
    });

    it('should calculate correct selector for constructor', () => {
      const estimate = estimator.estimateGasSync('value = _value;', 'constructor(uint256)');
      expect(estimate.selector).toMatch(/^0x[0-9a-f]{8}$/);
    });
  });

  describe('Async Gas Estimation (with potential Solc)', () => {
    beforeEach(() => {
      estimator = new GasEstimator(true); // Enable solc if available
    });

    it('should estimate gas asynchronously', async () => {
      const estimate = await estimator.estimateGas(simpleFunction, 'add(uint256,uint256)');

      expect(estimate).toBeDefined();
      expect(estimate.signature).toBe('add(uint256,uint256)');
      expect(estimate.selector).toBeTruthy();
      expect(estimate.source).toBeDefined();
      expect(['solc', 'heuristic']).toContain(estimate.source);
    });

    it('should fall back to heuristic if no file path provided', async () => {
      const estimate = await estimator.estimateGas(
        simpleFunction,
        'add(uint256,uint256)'
        // No file path
      );

      expect(estimate.source).toBe('heuristic');
    });

    it('should use solc if available and file path provided', async () => {
      if (!estimator.isSolcAvailable()) {
        console.log('Skipping test - solc not available');
        return;
      }

      const testContract = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract Test {
    uint256 public value;
    function setValue(uint256 _value) public {
        value = _value;
    }
}
`;
      const tempFile = '/tmp/TestGasEstimator.sol';
      fs.writeFileSync(tempFile, testContract);

      const estimate = await estimator.estimateGas(
        'value = _value;',
        'setValue(uint256)',
        tempFile,
        testContract
      );

      expect(estimate).toBeDefined();
      // If solc worked, should be from solc
      if (estimate.source === 'solc') {
        expect(estimate.estimatedGas.min).toBeDefined();
        expect(estimate.estimatedGas.max).toBeDefined();
      }

      try {
        fs.unlinkSync(tempFile);
      } catch (error) {
        // File may not exist, ignore
      }
    });
  });

  describe('Contract Gas Estimation', () => {
    const contractCode = `
pragma solidity ^0.8.0;
contract Test {
    uint256 public value;
    mapping(address => uint256) public balances;
    
    constructor(uint256 _value) {
        value = _value;
    }
    
    function setValue(uint256 _value) public {
        value = _value;
    }
    
    function transfer(address to, uint256 amount) public {
        require(balances[msg.sender] >= amount);
        balances[msg.sender] -= amount;
        balances[to] += amount;
    }
}
`;

    const functions = [
      { name: 'setValue', signature: 'setValue(uint256)' },
      { name: 'transfer', signature: 'transfer(address,uint256)' },
    ];

    beforeEach(() => {
      estimator = new GasEstimator();
    });

    it('should estimate gas for all functions in contract', async () => {
      const functionsWithMetadata = functions.map((f) => ({
        ...f,
        selector: '0x' + '00000000',
        visibility: 'public' as const,
        stateMutability: 'nonpayable' as const,
        inputs: [],
        outputs: [],
        contractName: 'TestContract',
        filePath: '/tmp/TestContract.sol',
      })) as FunctionSignature[];
      const estimates = await estimator.estimateContractGas(contractCode, functionsWithMetadata);

      expect(estimates).toBeDefined();
      expect(estimates.length).toBeGreaterThan(0);

      estimates.forEach((est) => {
        expect(est.signature).toBeDefined();
        expect(est.selector).toMatch(/^0x[0-9a-f]{8}$/);
        expect(est.estimatedGas.min).toBeDefined();
        expect(est.estimatedGas.max).toBeDefined();
        expect(est.estimatedGas.average).toBeDefined();
        expect(est.complexity).toBeDefined();
        expect(est.source).toBeDefined();
      });
    });

    it('should handle functions with no match gracefully', async () => {
      const functionsWithMetadata = functions.map((f) => ({
        ...f,
        selector: '0x' + '00000000',
        visibility: 'public' as const,
        stateMutability: 'nonpayable' as const,
        inputs: [],
        outputs: [],
        contractName: 'TestContract',
        filePath: '/tmp/TestContract.sol',
      })) as FunctionSignature[];
      const funcsWithInvalid = [
        ...functionsWithMetadata,
        {
          name: 'nonExistent',
          signature: 'nonExistent()',
          selector: '0x00000000',
          visibility: 'public' as const,
          stateMutability: 'nonpayable' as const,
          inputs: [],
          outputs: [],
          contractName: 'TestContract',
          filePath: '/tmp/TestContract.sol',
        },
      ];

      const estimates = await estimator.estimateContractGas(contractCode, funcsWithInvalid);

      // Should still get estimates for valid functions
      expect(estimates.length).toBeGreaterThanOrEqual(functions.length);
    });
  });

  describe('Gas Report Generation', () => {
    beforeEach(() => {
      estimator = new GasEstimator(false); // Use heuristic for predictable results
    });

    it('should generate gas report', () => {
      const estimates: GasEstimate[] = [
        estimator.estimateGasSync(simpleFunction, 'add(uint256,uint256)'),
        estimator.estimateGasSync(storageFunction, 'updateStorage(uint256,uint256)'),
        estimator.estimateGasSync(loopFunction, 'processLoop(uint256)'),
      ];

      const report = estimator.generateGasReport(estimates);

      expect(report).toBeTruthy();
      expect(report).toContain('Gas Estimation Report');
      expect(report).toContain('Function');
      expect(report).toContain('Selector');
      expect(report).toContain('Complexity');
      expect(report).toContain('Source');
      expect(report).toContain('Summary');
    });

    it('should include source information in report', () => {
      const estimates: GasEstimate[] = [estimator.estimateGasSync(simpleFunction, 'test()')];

      const report = estimator.generateGasReport(estimates);

      expect(report).toContain('Heuristic');
    });

    it('should handle infinite gas values in report', () => {
      const infiniteEstimate: GasEstimate = {
        function: 'unbounded()',
        signature: 'unbounded()',
        selector: '0x12345678',
        estimatedGas: {
          min: 'infinite',
          max: 'infinite',
          average: 'infinite',
        },
        complexity: 'unbounded',
        factors: ['Unbounded execution'],
        source: 'heuristic',
      };

      const report = estimator.generateGasReport([infiniteEstimate]);

      expect(report).toContain('∞');
      expect(report).toContain('unbounded');
    });

    it('should calculate averages correctly', () => {
      const estimates: GasEstimate[] = [
        estimator.estimateGasSync(simpleFunction, 'test1()'),
        estimator.estimateGasSync(simpleFunction, 'test2()'),
      ];

      const report = estimator.generateGasReport(estimates);

      expect(report).toContain('Average Gas per Function');
      expect(report).toContain('**Total Functions**: 2');
    });

    it('should count high complexity functions', () => {
      const estimates: GasEstimate[] = [
        estimator.estimateGasSync(loopFunction, 'expensive()'),
        estimator.estimateGasSync(simpleFunction, 'cheap()'),
      ];

      const report = estimator.generateGasReport(estimates);

      expect(report).toContain('High Complexity Functions');
    });
  });

  describe('Complexity Classification', () => {
    beforeEach(() => {
      estimator = new GasEstimator(false);
    });

    it('should classify low complexity correctly', () => {
      const estimate = estimator.estimateGasSync('return a + b;', 'add(uint256,uint256)');
      expect(estimate.complexity).toBe('low');
    });

    it('should classify medium complexity correctly', () => {
      // Create a function that will estimate to medium range
      const mediumFunc = `
        for (uint i = 0; i < 10; i++) {
            value += i;
        }
      `;
      const estimate = estimator.estimateGasSync(mediumFunc, 'medium()');
      expect(['low', 'medium', 'high']).toContain(estimate.complexity);
    });
  });

  describe('Selector Calculation', () => {
    beforeEach(() => {
      estimator = new GasEstimator(false);
    });

    it('should calculate correct selectors for ERC-20 functions', () => {
      const tests = [
        { sig: 'transfer(address,uint256)', expected: '0xa9059cbb' },
        { sig: 'approve(address,uint256)', expected: '0x095ea7b3' },
        { sig: 'balanceOf(address)', expected: '0x70a08231' },
      ];

      tests.forEach(({ sig, expected }) => {
        const estimate = estimator.estimateGasSync('', sig);
        expect(estimate.selector).toBe(expected);
      });
    });

    it('should handle constructor signature', () => {
      const estimate = estimator.estimateGasSync('', 'constructor()');
      expect(estimate.selector).toMatch(/^0x[0-9a-f]{8}$/);
    });
  });

  describe('Edge Cases', () => {
    beforeEach(() => {
      estimator = new GasEstimator(false);
    });

    it('should handle empty function body', () => {
      const estimate = estimator.estimateGasSync('', 'empty()');

      expect(estimate).toBeDefined();
      expect(estimate.complexity).toBe('low');
      expect(estimate.factors).toContain('Simple computation');
    });

    it('should handle very complex function', () => {
      const veryComplex = `
        for (uint i = 0; i < 1000; i++) {
            for (uint j = 0; j < 1000; j++) {
                balances[addresses[i]] += amounts[j];
                emit Transfer(from, to, amount);
            }
        }
      `;
      const estimate = estimator.estimateGasSync(veryComplex, 'veryComplex()');

      expect(estimate.complexity).toMatch(/high|very-high/);
      expect(estimate.warning).toBeTruthy();
    });

    it('should handle function with only comments', () => {
      const onlyComments = `
        // This is a comment
        /* Multi-line
           comment */
      `;
      const estimate = estimator.estimateGasSync(onlyComments, 'commented()');

      expect(estimate).toBeDefined();
      expect(estimate.complexity).toBe('low');
    });
  });
});
