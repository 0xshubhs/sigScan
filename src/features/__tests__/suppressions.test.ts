/**
 * Tests for inline finding suppressions.
 */

import {
  parseSuppressions,
  isSuppressed,
  SuppressionScope,
} from '../suppressions';

describe('parseSuppressions', () => {
  describe('empty / trivial input', () => {
    it('returns [] for empty source', () => {
      expect(parseSuppressions('')).toEqual([]);
    });

    it('returns [] for source with no directives', () => {
      const src = `pragma solidity ^0.8.0;\n// just a normal comment\ncontract C {}`;
      expect(parseSuppressions(src)).toEqual([]);
    });
  });

  describe('disable-next-line', () => {
    it('targets the next 0-based line (N -> N+1)', () => {
      // line 0: directive, line 1: target
      const src = `// 0xtools-disable-next-line\nfoo();`;
      expect(parseSuppressions(src)).toEqual<SuppressionScope[]>([
        { rules: 'all', target: 1 },
      ]);
    });

    it('captures a single rule', () => {
      const src = `// 0xtools-disable-next-line reentrancy\nfoo();`;
      expect(parseSuppressions(src)).toEqual<SuppressionScope[]>([
        { rules: ['reentrancy'], target: 1 },
      ]);
    });

    it('captures multiple comma-separated rules, lowercased + trimmed', () => {
      const src = `code;\n//   0xtools-disable-next-line  Reentrancy,  Unchecked-Call \nfoo();`;
      const result = parseSuppressions(src);
      expect(result).toEqual<SuppressionScope[]>([
        { rules: ['reentrancy', 'unchecked-call'], target: 2 },
      ]);
    });

    it('captures space-separated rules', () => {
      const src = `// 0xtools-disable-next-line mev natspec\nfoo();`;
      expect(parseSuppressions(src)).toEqual<SuppressionScope[]>([
        { rules: ['mev', 'natspec'], target: 1 },
      ]);
    });
  });

  describe('disable-line (same line)', () => {
    it('targets the same 0-based line the comment is on', () => {
      const src = `line0;\nfoo(); // 0xtools-disable-line`;
      expect(parseSuppressions(src)).toEqual<SuppressionScope[]>([
        { rules: 'all', target: 1 },
      ]);
    });

    it('captures a rule on a trailing comment', () => {
      const src = `foo.call(""); // 0xtools-disable-line unchecked-call`;
      expect(parseSuppressions(src)).toEqual<SuppressionScope[]>([
        { rules: ['unchecked-call'], target: 0 },
      ]);
    });
  });

  describe('bare disable (whole file)', () => {
    it('targets the whole file', () => {
      const src = `// 0xtools-disable\ncontract C {}`;
      expect(parseSuppressions(src)).toEqual<SuppressionScope[]>([
        { rules: 'all', target: 'file' },
      ]);
    });

    it('captures rules for a whole-file scope', () => {
      const src = `// 0xtools-disable natspec, custom-error\ncontract C {}`;
      expect(parseSuppressions(src)).toEqual<SuppressionScope[]>([
        { rules: ['natspec', 'custom-error'], target: 'file' },
      ]);
    });
  });

  describe('case-insensitivity & aliases', () => {
    it('is case-insensitive on the directive text', () => {
      const src = `// 0XTOOLS-DISABLE-NEXT-LINE REENTRANCY\nfoo();`;
      expect(parseSuppressions(src)).toEqual<SuppressionScope[]>([
        { rules: ['reentrancy'], target: 1 },
      ]);
    });

    it('accepts the 0xtools:disable... alias', () => {
      const src = `// 0xtools:disable-next-line mev\nfoo();`;
      expect(parseSuppressions(src)).toEqual<SuppressionScope[]>([
        { rules: ['mev'], target: 1 },
      ]);
    });

    it('accepts the @0xtools-disable... alias', () => {
      const src = `// @0xtools-disable-line\nfoo(); // @0xtools-disable-line access-control`;
      // first line: standalone directive on line 0 (same-line target 0)
      // second line: trailing directive on line 1 (same-line target 1)
      expect(parseSuppressions(src)).toEqual<SuppressionScope[]>([
        { rules: 'all', target: 0 },
        { rules: ['access-control'], target: 1 },
      ]);
    });

    it('accepts the @0xtools:disable bare alias for whole file', () => {
      const src = `// @0xtools:disable\ncode;`;
      expect(parseSuppressions(src)).toEqual<SuppressionScope[]>([
        { rules: 'all', target: 'file' },
      ]);
    });
  });

  describe('multiple directives in one source', () => {
    it('collects every directive with correct targets', () => {
      const src = [
        '// 0xtools-disable natspec', // line 0 -> file
        'pragma solidity ^0.8.0;', // line 1
        'contract C {', // line 2
        '  // 0xtools-disable-next-line reentrancy', // line 3 -> target 4
        '  foo();', // line 4
        '  bar(); // 0xtools-disable-line mev', // line 5 -> target 5
        '}', // line 6
      ].join('\n');
      expect(parseSuppressions(src)).toEqual<SuppressionScope[]>([
        { rules: ['natspec'], target: 'file' },
        { rules: ['reentrancy'], target: 4 },
        { rules: ['mev'], target: 5 },
      ]);
    });
  });

  describe('robustness', () => {
    it('tolerates carriage returns (CRLF line endings)', () => {
      const src = `// 0xtools-disable-next-line reentrancy\r\nfoo();\r\n`;
      expect(parseSuppressions(src)).toEqual<SuppressionScope[]>([
        { rules: ['reentrancy'], target: 1 },
      ]);
    });

    it('ignores a similar-looking but non-matching word', () => {
      const src = `// please-0xtools-enable reentrancy\nfoo();`;
      // "0xtools-enable" does not match "0xtools-disable"
      expect(parseSuppressions(src)).toEqual([]);
    });

    it('does not treat -line as the bare form', () => {
      const src = `// 0xtools-disable-line\ncode;`;
      const result = parseSuppressions(src);
      expect(result[0].target).toBe(0); // same-line, not 'file'
    });
  });
});

describe('isSuppressed', () => {
  it('returns false with no suppressions', () => {
    expect(isSuppressed('reentrancy', 5, [])).toBe(false);
  });

  it('file scope with rules=all suppresses any code on any line', () => {
    const sup: SuppressionScope[] = [{ rules: 'all', target: 'file' }];
    expect(isSuppressed('reentrancy', 0, sup)).toBe(true);
    expect(isSuppressed('mev', 99, sup)).toBe(true);
  });

  it('file scope with specific rules only suppresses those codes', () => {
    const sup: SuppressionScope[] = [{ rules: ['mev'], target: 'file' }];
    expect(isSuppressed('mev', 3, sup)).toBe(true);
    expect(isSuppressed('reentrancy', 3, sup)).toBe(false);
  });

  it('line scope with rules=all suppresses any code on that exact line', () => {
    const sup: SuppressionScope[] = [{ rules: 'all', target: 7 }];
    expect(isSuppressed('reentrancy', 7, sup)).toBe(true);
    expect(isSuppressed('reentrancy', 8, sup)).toBe(false);
  });

  it('line scope with specific rule matches code + line together', () => {
    const sup: SuppressionScope[] = [{ rules: ['unchecked-call'], target: 4 }];
    expect(isSuppressed('unchecked-call', 4, sup)).toBe(true);
    expect(isSuppressed('unchecked-call', 5, sup)).toBe(false); // wrong line
    expect(isSuppressed('reentrancy', 4, sup)).toBe(false); // wrong rule
  });

  it('compares codes case-insensitively', () => {
    const sup: SuppressionScope[] = [{ rules: ['reentrancy'], target: 2 }];
    expect(isSuppressed('REENTRANCY', 2, sup)).toBe(true);
  });

  it('matches if ANY scope matches', () => {
    const sup: SuppressionScope[] = [
      { rules: ['mev'], target: 1 },
      { rules: ['reentrancy'], target: 2 },
    ];
    expect(isSuppressed('reentrancy', 2, sup)).toBe(true);
    expect(isSuppressed('mev', 1, sup)).toBe(true);
    expect(isSuppressed('mev', 2, sup)).toBe(false);
  });

  it('integrates with parseSuppressions output', () => {
    const src = [
      'contract C {', // 0
      '  // 0xtools-disable-next-line reentrancy', // 1 -> target 2
      '  external.call(); // unsafe', // 2
      '  foo(); // 0xtools-disable-line', // 3 -> target 3, all
    ].join('\n');
    const sup = parseSuppressions(src);
    expect(isSuppressed('reentrancy', 2, sup)).toBe(true);
    expect(isSuppressed('mev', 2, sup)).toBe(false); // only reentrancy suppressed
    expect(isSuppressed('anything', 3, sup)).toBe(true); // disable-line all
  });
});
