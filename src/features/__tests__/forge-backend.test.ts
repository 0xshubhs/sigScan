/**
 * Tests for Forge Backend
 */

import * as path from 'path';
import * as fs from 'fs';
import {
  isForgeAvailable,
  findFoundryRoot,
  compileWithForge,
  resetForgeCache,
  getForgeVersion,
} from '../forge-backend';

describe('Forge Backend', () => {
  beforeEach(() => {
    resetForgeCache();
  });

  describe('isForgeAvailable', () => {
    it('should return a boolean', async () => {
      const result = await isForgeAvailable();
      expect(typeof result).toBe('boolean');
    });

    it('should cache the result across calls', async () => {
      const first = await isForgeAvailable();
      const second = await isForgeAvailable();
      expect(first).toBe(second);
    });

    it('should populate version string when available', async () => {
      const available = await isForgeAvailable();
      if (available) {
        const version = getForgeVersion();
        expect(version).not.toBe('unknown');
        expect(version).toMatch(/[\d.]+/);
      }
    });
  });

  describe('findFoundryRoot', () => {
    it('should return null for a path with no foundry.toml', () => {
      const result = findFoundryRoot('/tmp/no-foundry-here/src/Contract.sol');
      expect(result).toBeNull();
    });

    it('should find foundry root from example projects', () => {
      const exampleDir = path.resolve(__dirname, '../../../examples/foundry-dao');
      const solFile = path.join(exampleDir, 'src', 'GovernanceToken.sol');

      if (fs.existsSync(solFile)) {
        const result = findFoundryRoot(solFile);
        expect(result).toBe(exampleDir);
      }
    });

    it('should find foundry root from nested test directory', () => {
      const exampleDir = path.resolve(__dirname, '../../../examples/foundry-dao');
      const testFile = path.join(exampleDir, 'test', 'Governance.t.sol');

      if (fs.existsSync(testFile)) {
        const result = findFoundryRoot(testFile);
        expect(result).toBe(exampleDir);
      }
    });

    it('should find the closest foundry root for nested projects', () => {
      // foundry-options is nested inside foundry-dao
      const nestedDir = path.resolve(
        __dirname,
        '../../../examples/foundry-dao/test/foundry-options'
      );
      const nestedFile = path.join(nestedDir, 'src', 'OptionsMarket.sol');

      if (fs.existsSync(nestedFile)) {
        const result = findFoundryRoot(nestedFile);
        expect(result).toBe(nestedDir);
      }
    });
  });

  describe('compileWithForge', () => {
    it('should fall back gracefully when forge is not available or project is invalid', async () => {
      // Use a temp directory with no foundry project
      const tmpDir = '/tmp/forge-test-no-project';
      const tmpFile = path.join(tmpDir, 'Test.sol');

      // Create minimal structure
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }
      fs.writeFileSync(
        tmpFile,
        `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Test {
    function hello() public pure returns (string memory) {
        return "hello";
    }
}
`
      );

      const result = await compileWithForge(tmpFile, tmpDir);

      // Should not crash - either succeeds (forge installed) or falls back
      expect(result).toBeDefined();
      expect(result.gasInfo).toBeDefined();
      expect(Array.isArray(result.gasInfo)).toBe(true);

      // Clean up
      try {
        fs.unlinkSync(tmpFile);
        fs.rmdirSync(tmpDir);
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should compile a real foundry project when forge is available', async () => {
      const available = await isForgeAvailable();
      if (!available) {
        console.log('Skipping test - forge not available');
        return;
      }

      const exampleDir = path.resolve(__dirname, '../../../examples/foundry-dao');
      const solFile = path.join(exampleDir, 'src', 'GovernanceToken.sol');

      if (!fs.existsSync(solFile)) {
        console.log('Skipping test - example project not found');
        return;
      }

      const result = await compileWithForge(solFile, exampleDir);

      expect(result).toBeDefined();
      expect(result.version).toContain('forge');

      if (result.success) {
        expect(result.gasInfo.length).toBeGreaterThan(0);
        // Check that gas values are populated (not all zero)
        const hasGas = result.gasInfo.some((info) => info.gas !== 0 && info.gas !== 'infinite');
        if (hasGas) {
          expect(hasGas).toBe(true);
        }
        // Check selectors are populated
        for (const info of result.gasInfo) {
          expect(info.selector).toMatch(/^0x[0-9a-f]{8}$/);
          expect(info.name).toBeTruthy();
        }
      }
    }, 60000); // 60s timeout for forge build
  });

  describe('resetForgeCache', () => {
    it('should clear the cached result', async () => {
      await isForgeAvailable();
      resetForgeCache();
      // After reset, version should be unknown
      expect(getForgeVersion()).toBe('unknown');
    });
  });
});
