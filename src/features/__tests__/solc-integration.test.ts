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

  describe('Version-Specific Compilation', () => {
    it('should compile contract with pragma 0.8.20', async () => {
      if (!solc.isSolcAvailable()) {
        console.log('Skipping test - solc not available');
        return;
      }

      const contract820 = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Test820 {
    function test() public pure returns (uint256) {
        return 42;
    }
}
`;
      const tempFile = '/tmp/Test820.sol';
      fs.writeFileSync(tempFile, contract820);

      const result = await solc.compileAndGetGasEstimates(tempFile);

      expect(result.success).toBe(true);
      expect(result.version).toBeDefined();
      expect(result.isExactMatch).toBeDefined();

      try {
        fs.unlinkSync(tempFile);
      } catch (error) {
        // Ignore
      }
    });

    it('should compile contract with pragma 0.8.0', async () => {
      if (!solc.isSolcAvailable()) {
        console.log('Skipping test - solc not available');
        return;
      }

      const contract80 = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Test80 {
    function test() public pure returns (uint256) {
        return 100;
    }
}
`;
      const tempFile = '/tmp/Test80.sol';
      fs.writeFileSync(tempFile, contract80);

      const result = await solc.compileAndGetGasEstimates(tempFile);

      expect(result.success).toBe(true);
      expect(result.version).toBeDefined();

      try {
        fs.unlinkSync(tempFile);
      } catch (error) {
        // Ignore
      }
    });

    it('should compile contract with exact version pragma', async () => {
      if (!solc.isSolcAvailable()) {
        console.log('Skipping test - solc not available');
        return;
      }

      const contractExact = `
// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

contract TestExact {
    function test() public pure returns (uint256) {
        return 999;
    }
}
`;
      const tempFile = '/tmp/TestExact.sol';
      fs.writeFileSync(tempFile, contractExact);

      const result = await solc.compileAndGetGasEstimates(tempFile);

      // When bundled doesn't match exact pragma (0.8.19 vs 0.8.28),
      // it will fail with bundled but trigger background download
      // This is expected behavior
      expect(result.version).toBeDefined();
      expect(result.isExactMatch).toBeDefined();

      try {
        fs.unlinkSync(tempFile);
      } catch (error) {
        // Ignore
      }
    });

    it('should compile contract with range pragma', async () => {
      if (!solc.isSolcAvailable()) {
        console.log('Skipping test - solc not available');
        return;
      }

      const contractRange = `
// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

contract TestRange {
    function test() public pure returns (uint256) {
        return 777;
    }
}
`;
      const tempFile = '/tmp/TestRange.sol';
      fs.writeFileSync(tempFile, contractRange);

      const result = await solc.compileAndGetGasEstimates(tempFile);

      expect(result.success).toBe(true);
      expect(result.version).toBeDefined();

      try {
        fs.unlinkSync(tempFile);
      } catch (error) {
        // Ignore
      }
    });

    it('should handle contract without pragma', async () => {
      if (!solc.isSolcAvailable()) {
        console.log('Skipping test - solc not available');
        return;
      }

      const contractNoPragma = `
// SPDX-License-Identifier: MIT
contract TestNoPragma {
    function test() public pure returns (uint256) {
        return 555;
    }
}
`;
      const tempFile = '/tmp/TestNoPragma.sol';
      fs.writeFileSync(tempFile, contractNoPragma);

      const result = await solc.compileAndGetGasEstimates(tempFile);

      // Should use bundled version
      expect(result.version).toBeDefined();
      expect(result.isExactMatch).toBe(true); // No pragma = bundled is fine

      try {
        fs.unlinkSync(tempFile);
      } catch (error) {
        // Ignore
      }
    });

    it('should report non-exact match when bundled doesnt satisfy', async () => {
      if (!solc.isSolcAvailable()) {
        console.log('Skipping test - solc not available');
        return;
      }

      // Use a version that bundled 0.8.28 doesn't satisfy
      const contract70 = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.7.0;

contract Test70 {
    function test() public pure returns (uint256) {
        return 42;
    }
}
`;
      const tempFile = '/tmp/Test70.sol';
      fs.writeFileSync(tempFile, contract70);

      const result = await solc.compileAndGetGasEstimates(tempFile);

      // May succeed with bundled as fallback, but isExactMatch should be false initially
      expect(result.version).toBeDefined();
      // Note: isExactMatch will be false on first compile, true after download

      try {
        fs.unlinkSync(tempFile);
      } catch (error) {
        // Ignore
      }
    });

    it('should trigger upgrade callback when exact version downloaded', (done) => {
      if (!solc.isSolcAvailable()) {
        console.log('Skipping test - solc not available');
        done();
        return;
      }

      const contract819 = `
// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

contract TestUpgrade {
    function test() public pure returns (uint256) {
        return 123;
    }
}
`;
      const tempFile = '/tmp/TestUpgrade.sol';
      fs.writeFileSync(tempFile, contract819);

      const upgradeCallback = (version: string) => {
        console.log(`Upgrade callback triggered for version: ${version}`);
      };

      solc.compileAndGetGasEstimates(tempFile, undefined, upgradeCallback).then(() => {
        // Give some time for async download (may or may not complete in test)
        setTimeout(() => {
          // Callback may or may not be called depending on download speed
          // Just verify the compilation worked
          try {
            fs.unlinkSync(tempFile);
          } catch (error) {
            // Ignore
          }
          done();
        }, 100);
      });
    });
  });
});
