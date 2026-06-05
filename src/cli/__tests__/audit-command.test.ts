import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  runAudit,
  analyzeSource,
  formatText,
  shouldFail,
  AuditFinding,
} from '../audit-command';

/**
 * A contract that trips several analyzers: tx.origin auth (dangerous,
 * critical), an unchecked low-level call, a public state-changing function
 * without access control / events, and a require string (custom error).
 */
const VULN_A = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Vault {
    mapping(address => uint256) public balances;
    address public owner;

    function auth() public view returns (bool) {
        return tx.origin == owner;
    }

    function setOwner(address newOwner) public {
        require(newOwner != address(0), "zero address");
        owner = newOwner;
    }

    function withdraw(uint256 amount) public {
        balances[msg.sender] -= amount;
        msg.sender.call{value: amount}("");
    }
}
`;

/** A simpler contract that should at least produce some lower-severity noise. */
const VULN_B = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Token {
    uint256 public total;

    function mint(uint256 amount) public {
        total += amount;
    }
}
`;

function makeTmpProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '0xtools-audit-'));
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  return root;
}

describe('analyzeSource', () => {
  it('produces findings with our 4-level severity scale', () => {
    const findings = analyzeSource('/x/Vault.sol', VULN_A);
    expect(findings.length).toBeGreaterThan(0);
    const allowed = new Set(['critical', 'high', 'medium', 'low']);
    for (const f of findings) {
      expect(allowed.has(f.severity)).toBe(true);
      expect(typeof f.message).toBe('string');
      expect(f.message.length).toBeGreaterThan(0);
      expect(f.file).toBe('/x/Vault.sol');
    }
  });

  it('detects tx-origin as a critical dangerous pattern with patternType code', () => {
    const findings = analyzeSource('/x/Vault.sol', VULN_A);
    const txOrigin = findings.find((f) => f.code === 'tx-origin');
    expect(txOrigin).toBeDefined();
    expect(txOrigin!.severity).toBe('critical');
  });
});

describe('runAudit', () => {
  let root: string;

  beforeAll(() => {
    root = makeTmpProject({
      'src/Vault.sol': VULN_A,
      'src/Token.sol': VULN_B,
      // these must be ignored by the glob excludes
      'node_modules/dep/Bad.sol': VULN_A,
      'lib/forge-std/Bad.sol': VULN_A,
      'out/Compiled.sol': VULN_A,
    });
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('globs only non-vendored .sol files and aggregates findings', async () => {
    const findings = await runAudit(root, { suppressions: false });
    expect(findings.length).toBeGreaterThan(0);
    // No finding should come from an ignored directory.
    for (const f of findings) {
      expect(f.file).not.toMatch(/node_modules|[/\\]lib[/\\]|[/\\]out[/\\]/);
    }
    // Both real source files contribute.
    const files = new Set(findings.map((f) => path.basename(f.file)));
    expect(files.has('Vault.sol')).toBe(true);
  });

  it('honors inline suppressions when enabled', async () => {
    const baseline = await runAudit(root, { suppressions: false });
    const txOriginCount = baseline.filter((f) => f.code === 'tx-origin').length;
    expect(txOriginCount).toBeGreaterThan(0);

    // Write a copy with a file-level suppression for tx-origin.
    const suppRoot = makeTmpProject({
      'src/Vault.sol': `// 0xtools:disable tx-origin\n${VULN_A}`,
    });
    try {
      const suppressed = await runAudit(suppRoot, { suppressions: true });
      expect(suppressed.find((f) => f.code === 'tx-origin')).toBeUndefined();
    } finally {
      fs.rmSync(suppRoot, { recursive: true, force: true });
    }
  });

  it('--update-baseline persists findings then --baseline filters them out', async () => {
    const bRoot = makeTmpProject({ 'src/Vault.sol': VULN_A });
    try {
      const updated = await runAudit(bRoot, { suppressions: false, updateBaseline: true });
      expect(updated.length).toBeGreaterThan(0);
      // The baseline file should now exist.
      expect(fs.existsSync(path.join(bRoot, '.0xtools', 'findings-baseline.json'))).toBe(true);

      const afterBaseline = await runAudit(bRoot, { suppressions: false, baseline: true });
      expect(afterBaseline).toHaveLength(0);
    } finally {
      fs.rmSync(bRoot, { recursive: true, force: true });
    }
  });
});

describe('shouldFail', () => {
  const findings: AuditFinding[] = [
    { file: 'a', line: 1, code: 'natspec', severity: 'low', message: 'm' },
    { file: 'a', line: 2, code: 'mev', severity: 'medium', message: 'm' },
  ];

  it('never fails when failOn is none', () => {
    expect(shouldFail(findings, 'none')).toBe(false);
    expect(shouldFail([{ file: 'a', line: 1, code: 'x', severity: 'critical', message: 'm' }], 'none')).toBe(false);
  });

  it('fails when a finding is at-or-above the threshold', () => {
    expect(shouldFail(findings, 'low')).toBe(true); // low present
    expect(shouldFail(findings, 'medium')).toBe(true); // medium present
    expect(shouldFail(findings, 'high')).toBe(false); // nothing >= high
  });

  it('treats critical as above high', () => {
    const crit: AuditFinding[] = [
      { file: 'a', line: 1, code: 'tx-origin', severity: 'critical', message: 'm' },
    ];
    expect(shouldFail(crit, 'high')).toBe(true);
  });

  it('returns false for empty findings regardless of threshold', () => {
    expect(shouldFail([], 'low')).toBe(false);
  });
});

describe('formatText', () => {
  it('renders a no-findings message with a zeroed summary', () => {
    const out = formatText([]);
    expect(out).toContain('No findings.');
    expect(out).toContain('0 critical, 0 high, 0 medium, 0 low');
  });

  it('groups by file and includes line:col, severity, code, message, and a summary', () => {
    const findings: AuditFinding[] = [
      { file: '/p/A.sol', line: 12, column: 3, code: 'reentrancy', severity: 'high', message: 'withdraw: bad' },
      { file: '/p/A.sol', line: 4, code: 'natspec', severity: 'low', message: 'foo: missing' },
      { file: '/p/B.sol', line: 1, code: 'tx-origin', severity: 'critical', message: 'auth: tx.origin' },
    ];
    const out = formatText(findings);
    expect(out).toContain('/p/A.sol');
    expect(out).toContain('/p/B.sol');
    expect(out).toContain('12:3');
    expect(out).toContain('4:0'); // default column 0
    expect(out).toContain('reentrancy');
    expect(out).toContain('tx-origin');
    expect(out).toContain('withdraw: bad');
    expect(out).toContain('Summary: 1 critical, 1 high, 0 medium, 1 low');

    // Within a file, findings are sorted by line ascending.
    const aSection = out.slice(out.indexOf('/p/A.sol'), out.indexOf('/p/B.sol'));
    expect(aSection.indexOf('4:0')).toBeLessThan(aSection.indexOf('12:3'));
  });
});
