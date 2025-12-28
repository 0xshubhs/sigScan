/**
 * Tests for Solc Version Manager
 */

import {
  parsePragma,
  resolveBestVersion,
  bundledCompilerSatisfies,
  getCompilerStatus,
  clearCompilerCache,
  isDownloading,
} from '../solc-version-manager';

describe('SolcVersionManager', () => {
  beforeEach(() => {
    clearCompilerCache();
  });

  describe('parsePragma', () => {
    it('should parse simple caret pragma', () => {
      const source = 'pragma solidity ^0.8.20;';
      const result = parsePragma(source);

      expect(result).not.toBeNull();
      expect(result?.range).toBe('^0.8.20');
      expect(result?.exactVersion).toBe('0.8.20');
    });

    it('should parse tilde pragma', () => {
      const source = 'pragma solidity ~0.8.20;';
      const result = parsePragma(source);

      expect(result).not.toBeNull();
      expect(result?.range).toBe('~0.8.20');
      expect(result?.exactVersion).toBe('0.8.20');
    });

    it('should parse exact version pragma', () => {
      const source = 'pragma solidity 0.8.20;';
      const result = parsePragma(source);

      expect(result).not.toBeNull();
      expect(result?.range).toBe('0.8.20');
      expect(result?.exactVersion).toBe('0.8.20');
    });

    it('should parse range pragma with >=', () => {
      const source = 'pragma solidity >=0.8.0 <0.9.0;';
      const result = parsePragma(source);

      expect(result).not.toBeNull();
      expect(result?.range).toBe('>=0.8.0 <0.9.0');
      expect(result?.exactVersion).toBe('0.8.0');
    });

    it('should parse range pragma with multiple conditions', () => {
      const source = 'pragma solidity >=0.7.0 <0.8.0;';
      const result = parsePragma(source);

      expect(result).not.toBeNull();
      expect(result?.exactVersion).toBe('0.7.0');
    });

    it('should handle pragma with extra whitespace', () => {
      const source = 'pragma   solidity   ^0.8.20  ;';
      const result = parsePragma(source);

      expect(result).not.toBeNull();
      expect(result?.exactVersion).toBe('0.8.20');
    });

    it('should return null for missing pragma', () => {
      const source = 'contract Test {}';
      const result = parsePragma(source);

      expect(result).toBeNull();
    });

    it('should parse pragma with case insensitivity', () => {
      const source = 'PRAGMA SOLIDITY ^0.8.20;';
      const result = parsePragma(source);

      expect(result).not.toBeNull();
      expect(result?.exactVersion).toBe('0.8.20');
    });

    it('should parse complex pragma from real contract', () => {
      const source = `
        // SPDX-License-Identifier: MIT
        pragma solidity ^0.8.19;
        
        contract MyContract {
          // ...
        }
      `;
      const result = parsePragma(source);

      expect(result).not.toBeNull();
      expect(result?.exactVersion).toBe('0.8.19');
    });

    it('should handle older version pragmas', () => {
      const testCases = [
        { pragma: 'pragma solidity ^0.6.12;', expected: '0.6.12' },
        { pragma: 'pragma solidity ^0.7.6;', expected: '0.7.6' },
        { pragma: 'pragma solidity ^0.5.17;', expected: '0.5.17' },
      ];

      testCases.forEach(({ pragma, expected }) => {
        const result = parsePragma(pragma);
        expect(result?.exactVersion).toBe(expected);
      });
    });
  });

  describe('resolveBestVersion', () => {
    it('should resolve simple caret version', () => {
      const pragma = parsePragma('pragma solidity ^0.8.20;');
      const version = resolveBestVersion(pragma);
      expect(version).toBe('v0.8.20+commit.a1b79de6');
    });

    it('should resolve exact version', () => {
      const pragma = parsePragma('pragma solidity 0.8.19;');
      const version = resolveBestVersion(pragma);
      expect(version).toBe('v0.8.19+commit.7dd6d404');
    });

    it('should resolve range with lower bound', () => {
      const pragma = parsePragma('pragma solidity >=0.8.15 <0.9.0;');
      const version = resolveBestVersion(pragma);
      expect(version).toBe('v0.8.15+commit.e14f2714');
    });

    it('should return null for null pragma', () => {
      const version = resolveBestVersion(null);
      expect(version).toBeNull();
    });

    it('should handle pragma without range', () => {
      const pragma = { raw: 'pragma solidity;', range: undefined };
      const version = resolveBestVersion(pragma);
      expect(version).toBeNull();
    });

    it('should resolve complex range patterns', () => {
      const testCases = [
        { range: '^0.8.0', expected: 'v0.8.0+commit.c7dfd78e' },
        { range: '^0.7.0', expected: 'v0.7.0+commit.9e61f92b' },
        { range: '^0.6.0', expected: 'v0.6.12+commit.27d51765' }, // Falls back to latest 0.6.x
      ];

      testCases.forEach(({ range, expected }) => {
        const pragma = { raw: `pragma solidity ${range};`, range };
        const version = resolveBestVersion(pragma);
        expect(version).toBe(expected);
      });
    });
  });

  describe('bundledCompilerSatisfies', () => {
    it('should return true for compatible pragma', () => {
      const pragma = parsePragma('pragma solidity ^0.8.0;');
      const satisfies = bundledCompilerSatisfies(pragma);
      // 0.8.33 satisfies ^0.8.0
      expect(satisfies).toBe(true);
    });

    it('should return false for incompatible pragma', () => {
      const pragma = parsePragma('pragma solidity ^0.7.0;');
      const satisfies = bundledCompilerSatisfies(pragma);
      // 0.8.33 does not satisfy ^0.7.0
      expect(satisfies).toBe(false);
    });

    it('should return true for null pragma', () => {
      const satisfies = bundledCompilerSatisfies(null);
      expect(satisfies).toBe(true);
    });

    it('should handle exact version that matches', () => {
      const pragma = parsePragma('pragma solidity 0.8.33;');
      const satisfies = bundledCompilerSatisfies(pragma);
      expect(satisfies).toBe(true);
    });

    it('should handle range pragmas', () => {
      const testCases = [
        { pragma: '>=0.8.0 <0.9.0', expected: true }, // 0.8.33 is in range
        { pragma: '>=0.8.20 <0.9.0', expected: true }, // 0.8.33 is in range
        { pragma: '>=0.9.0 <1.0.0', expected: false }, // 0.8.33 is not in range
        { pragma: '>=0.6.0 <0.8.0', expected: false }, // 0.8.33 is not in range
      ];

      testCases.forEach(({ pragma, expected }) => {
        const pragmaInfo = parsePragma(`pragma solidity ${pragma};`);
        const satisfies = bundledCompilerSatisfies(pragmaInfo);
        expect(satisfies).toBe(expected);
      });
    });
  });

  describe('getCompilerStatus', () => {
    it('should return initial status with bundled version', () => {
      const status = getCompilerStatus();

      expect(status.bundled).toBe('0.8.33');
      expect(status.cached).toEqual([]);
      expect(status.downloading).toEqual([]);
    });

    it('should reflect cache state', () => {
      clearCompilerCache();
      const status = getCompilerStatus();

      expect(status.cached).toEqual([]);
    });
  });

  describe('isDownloading', () => {
    it('should return false for non-downloading version', () => {
      const result = isDownloading('v0.8.20');
      expect(result).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle malformed pragma gracefully', () => {
      const malformedPragmas = [
        'pragma solidity;',
        'pragma solidity ^;',
        'pragma solidity ^^0.8.0;',
        'pragma solidity invalid;',
      ];

      malformedPragmas.forEach((pragma) => {
        const result = parsePragma(pragma);
        // Should not crash
        expect(result).toBeDefined();
      });
    });

    it('should handle very old versions', () => {
      const oldPragmas = ['pragma solidity ^0.4.24;', 'pragma solidity ^0.5.0;'];

      oldPragmas.forEach((pragma) => {
        const result = parsePragma(pragma);
        expect(result).not.toBeNull();
        expect(result?.exactVersion).toBeTruthy();
      });
    });

    it('should handle multiple pragmas (use first)', () => {
      const source = `
        pragma solidity ^0.8.20;
        pragma solidity ^0.8.19;
      `;
      const result = parsePragma(source);

      // Should match first pragma
      expect(result?.exactVersion).toBe('0.8.20');
    });
  });

  describe('Version Format Edge Cases', () => {
    it('should handle versions with patch number zero', () => {
      const source = 'pragma solidity ^0.8.0;';
      const result = parsePragma(source);

      expect(result?.exactVersion).toBe('0.8.0');
    });

    it('should handle complex version constraints', () => {
      const testCases = [
        { pragma: '>=0.8.0 <=0.8.20', expected: '0.8.0' },
        { pragma: '>0.7.0 <0.9.0', expected: undefined }, // > without = doesn't match simple pattern
        { pragma: '>=0.8.10', expected: '0.8.10' },
      ];

      testCases.forEach(({ pragma, expected }) => {
        const result = parsePragma(`pragma solidity ${pragma};`);
        if (expected) {
          expect(result?.exactVersion).toBe(expected);
        } else {
          // Complex ranges may not extract exact version
          expect(result).toBeTruthy();
        }
      });
    });

    it('should handle ABIEncoderV2 pragma separately', () => {
      const source = `
        pragma solidity ^0.8.20;
        pragma experimental ABIEncoderV2;
      `;
      const result = parsePragma(source);

      // Should only parse solidity pragma
      expect(result?.exactVersion).toBe('0.8.20');
    });
  });
});
