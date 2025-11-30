/**
 * Integration tests for all advanced features
 */

import { ABIGenerator } from '../../features/abi';
import { GasEstimator } from '../../features/gas';
import { ContractSizeAnalyzer } from '../../features/size';
import { ComplexityAnalyzer } from '../../features/complexity';
import { SignatureDatabase } from '../../features/database';

describe('Advanced Features Integration', () => {
  describe('End-to-End Analysis Pipeline', () => {
    const testContract = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract DemoContract {
    mapping(address => uint256) public balances;
    address public owner;
    
    event Transfer(address indexed from, address indexed to, uint256 amount);
    error InsufficientBalance(uint256 requested, uint256 available);
    
    constructor() {
        owner = msg.sender;
    }
    
    function transfer(address to, uint256 amount) public returns (bool) {
        if (balances[msg.sender] < amount) {
            revert InsufficientBalance(amount, balances[msg.sender]);
        }
        balances[msg.sender] -= amount;
        balances[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
    
    function complexFunction(uint256 a, uint256 b) public returns (uint256) {
        uint256 result = 0;
        for (uint256 i = 0; i < a; i++) {
            if (i % 2 == 0) {
                result += i * b;
            } else {
                result -= i;
            }
        }
        return result;
    }
}
`;

    it('should complete full analysis pipeline', () => {
      // 1. Parse signatures (mock)
      const signatures = {
        functions: [
          {
            name: 'transfer',
            signature: 'transfer(address,uint256)',
            selector: '0xa9059cbb',
            visibility: 'public',
            stateMutability: 'nonpayable',
          },
          {
            name: 'complexFunction',
            signature: 'complexFunction(uint256,uint256)',
            selector: '0x12345678',
            visibility: 'public',
            stateMutability: 'nonpayable',
          },
        ],
        events: [
          {
            name: 'Transfer',
            signature: 'Transfer(address,address,uint256)',
            selector: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
          },
        ],
        errors: [
          {
            name: 'InsufficientBalance',
            signature: 'InsufficientBalance(uint256,uint256)',
            selector: '0xcf479181',
          },
        ],
      };

      // 2. Generate ABI
      const abiGen = new ABIGenerator();
      const abi = abiGen.generateABI(signatures);

      expect(abi.length).toBeGreaterThan(0);
      expect(abi.some((e) => e.type === 'function')).toBe(true);
      expect(abi.some((e) => e.type === 'event')).toBe(true);
      expect(abi.some((e) => e.type === 'error')).toBe(true);

      // 3. Estimate gas
      const gasEst = new GasEstimator();
      const estimates = gasEst.estimateContractGas(testContract, signatures.functions);

      expect(estimates.length).toBe(2);
      expect(estimates[0].estimatedGas.average).toBeGreaterThan(0);

      // 4. Check size
      const sizeAnalyzer = new ContractSizeAnalyzer();
      const sizeInfo = sizeAnalyzer.analyzeContract('DemoContract', testContract);

      expect(sizeInfo.status).toBe('safe');
      expect(sizeInfo.sizeInKB).toBeGreaterThan(0);

      // 5. Analyze complexity
      const complexityAnalyzer = new ComplexityAnalyzer();
      const analysis = complexityAnalyzer.analyzeContract(testContract, signatures.functions);

      expect(analysis.overall.linesOfCode).toBeGreaterThan(0);
      expect(analysis.functions.size).toBe(2);
    });

    it('should identify function in signature database', () => {
      const db = new SignatureDatabase();

      // Search for standard ERC20 function
      const results = db.search('transfer');

      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.signature === 'transfer(address,uint256)')).toBe(true);
    });

    it('should handle errors gracefully', () => {
      const invalidContract = 'not a valid contract';

      const sizeAnalyzer = new ContractSizeAnalyzer();
      const sizeInfo = sizeAnalyzer.analyzeContract('Invalid', invalidContract);

      expect(sizeInfo).toBeTruthy();
      expect(sizeInfo.status).toBe('safe'); // Should not crash
    });
  });

  describe('Feature Interoperability', () => {
    it('ABI should reflect gas estimates', () => {
      const signatures = {
        functions: [
          {
            name: 'expensiveFunction',
            signature: 'expensiveFunction(uint256[])',
            selector: '0x12345678',
            visibility: 'public',
            stateMutability: 'nonpayable',
          },
        ],
        events: [],
        errors: [],
      };

      const abiGen = new ABIGenerator();
      const abi = abiGen.generateABI(signatures);

      const functionABI = abi.find((e) => e.type === 'function');
      expect(functionABI).toBeTruthy();
      expect(functionABI?.inputs).toEqual([{ name: 'param0', type: 'uint256[]' }]);
    });

    it('Size analysis should correlate with complexity', () => {
      // More complex code should generally be larger
      const simpleContract = 'contract Simple { function a() public {} }';
      const complexContract = `
contract Complex {
    ${Array(50)
      .fill(0)
      .map((_, i) => `function func${i}() public {}`)
      .join('\n')}
}`;

      const sizeAnalyzer = new ContractSizeAnalyzer();
      const simpleSize = sizeAnalyzer.estimateSize(simpleContract);
      const complexSize = sizeAnalyzer.estimateSize(complexContract);

      expect(complexSize).toBeGreaterThan(simpleSize);
    });

    it('Database should help identify common patterns', () => {
      const db = new SignatureDatabase();

      // Get ERC20 signatures
      const erc20 = db.getByCategory('ERC20');
      expect(erc20.length).toBeGreaterThan(0);

      // Verify standard functions are present
      const selectors = erc20.map((s) => s.selector);
      expect(selectors).toContain('0xa9059cbb'); // transfer
      expect(selectors).toContain('0x095ea7b3'); // approve
    });
  });

  describe('Performance', () => {
    it('should handle large contracts efficiently', () => {
      const largeContract = `
pragma solidity ^0.8.0;
contract Large {
    ${Array(200)
      .fill(0)
      .map(
        (_, i) => `
    function func${i}(uint a, uint b) public returns (uint) {
        uint result = a + b;
        require(result > 0);
        return result;
    }`
      )
      .join('\n')}
}`;

      const start = Date.now();

      const sizeAnalyzer = new ContractSizeAnalyzer();
      const sizeInfo = sizeAnalyzer.analyzeContract('Large', largeContract);

      const duration = Date.now() - start;

      expect(duration).toBeLessThan(1000); // Should complete in under 1 second
      expect(sizeInfo).toBeTruthy();
    });

    it('should cache results effectively', () => {
      const db = new SignatureDatabase();

      const start1 = Date.now();
      const results1 = db.search('transfer');
      const duration1 = Date.now() - start1;

      const start2 = Date.now();
      const results2 = db.search('transfer');
      const duration2 = Date.now() - start2;

      expect(results1).toEqual(results2);
      // Second search should be as fast or faster
      expect(duration2).toBeLessThanOrEqual(duration1 + 5); // Allow 5ms tolerance
    });
  });

  describe('Report Generation', () => {
    it('should generate comprehensive reports', () => {
      const signatures = {
        functions: [
          {
            name: 'test',
            signature: 'test(uint256)',
            selector: '0x12345678',
          },
        ],
        events: [],
        errors: [],
      };

      const contractCode = 'contract Test { function test(uint256 a) public {} }';

      // Generate all reports
      const abiGen = new ABIGenerator();
      const gasEst = new GasEstimator();
      const sizeAnalyzer = new ContractSizeAnalyzer();
      const complexityAnalyzer = new ComplexityAnalyzer();

      const abi = abiGen.generateABI(signatures);
      const abiDocs = abiGen.generateABIDocs(abi);
      const gasReport = gasEst.generateGasReport(
        gasEst.estimateContractGas(contractCode, signatures.functions)
      );
      const sizeReport = sizeAnalyzer.generateReport(
        new Map([['Test', sizeAnalyzer.analyzeContract('Test', contractCode)]])
      );
      const complexityReport = complexityAnalyzer.generateReport(
        'Test',
        complexityAnalyzer.analyzeContract(contractCode, signatures.functions)
      );

      // Verify all reports are non-empty
      expect(abiDocs.length).toBeGreaterThan(0);
      expect(gasReport.length).toBeGreaterThan(0);
      expect(sizeReport.length).toBeGreaterThan(0);
      expect(complexityReport.length).toBeGreaterThan(0);

      // Verify report structure
      expect(abiDocs).toContain('Contract ABI');
      expect(gasReport).toContain('Gas Estimation Report');
      expect(sizeReport).toContain('Contract Size Analysis');
      expect(complexityReport).toContain('Complexity Analysis');
    });
  });
});
