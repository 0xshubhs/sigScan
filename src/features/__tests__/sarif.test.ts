import { toSarif, severityToLevel, SarifFinding } from '../sarif';

describe('severityToLevel', () => {
  it('maps critical and high to error', () => {
    expect(severityToLevel('critical')).toBe('error');
    expect(severityToLevel('high')).toBe('error');
  });

  it('maps medium to warning', () => {
    expect(severityToLevel('medium')).toBe('warning');
  });

  it('maps low to note', () => {
    expect(severityToLevel('low')).toBe('note');
  });
});

describe('toSarif', () => {
  const findings: SarifFinding[] = [
    {
      file: '/repo/contracts/A.sol',
      line: 10,
      column: 5,
      code: 'reentrancy',
      severity: 'high',
      message: 'withdraw: external call before state change',
    },
    {
      file: '/repo/contracts/A.sol',
      line: 20,
      code: 'tx-origin',
      severity: 'critical',
      message: 'auth: tx.origin used for authorization',
    },
    {
      file: '/repo/contracts/B.sol',
      line: 3,
      code: 'reentrancy',
      severity: 'high',
      message: 'foo: duplicate rule code',
    },
    {
      file: '/repo/contracts/C.sol',
      line: 7,
      code: 'natspec',
      severity: 'low',
      message: 'bar: missing @notice',
    },
  ];

  it('produces a valid SARIF 2.1.0 top-level shape', () => {
    const log = toSarif(findings, { repoRoot: '/repo', toolVersion: '9.9.9' }) as any;
    expect(log.version).toBe('2.1.0');
    expect(typeof log.$schema).toBe('string');
    expect(Array.isArray(log.runs)).toBe(true);
    expect(log.runs).toHaveLength(1);

    const driver = log.runs[0].tool.driver;
    expect(driver.name).toBe('0xtools');
    expect(driver.version).toBe('9.9.9');
    expect(typeof driver.informationUri).toBe('string');
  });

  it('de-duplicates rules by code in first-seen order', () => {
    const log = toSarif(findings, { repoRoot: '/repo' }) as any;
    const ruleIds = log.runs[0].tool.driver.rules.map((r: any) => r.id);
    expect(ruleIds).toEqual(['reentrancy', 'tx-origin', 'natspec']);
    // each rule has id + name
    for (const rule of log.runs[0].tool.driver.rules) {
      expect(typeof rule.id).toBe('string');
      expect(typeof rule.name).toBe('string');
      expect(rule.name.length).toBeGreaterThan(0);
    }
  });

  it('maps result levels by severity', () => {
    const log = toSarif(findings, { repoRoot: '/repo' }) as any;
    const results = log.runs[0].results;
    expect(results[0].level).toBe('error'); // high
    expect(results[1].level).toBe('error'); // critical
    expect(results[3].level).toBe('note'); // low
  });

  it('emits repo-root-relative forward-slash uris', () => {
    const log = toSarif(findings, { repoRoot: '/repo' }) as any;
    const uris = log.runs[0].results.map(
      (r: any) => r.locations[0].physicalLocation.artifactLocation.uri
    );
    expect(uris[0]).toBe('contracts/A.sol');
    expect(uris[1]).toBe('contracts/A.sol');
    expect(uris[2]).toBe('contracts/B.sol');
  });

  it('handles windows-style separators and trailing slash on repoRoot', () => {
    const log = toSarif(
      [
        {
          file: 'C:\\repo\\src\\X.sol',
          line: 1,
          code: 'mev',
          severity: 'medium',
          message: 'm',
        },
      ],
      { repoRoot: 'C:\\repo\\' }
    ) as any;
    const uri = log.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
    expect(uri).toBe('src/X.sol');
  });

  it('includes startColumn only when a positive column is present', () => {
    const log = toSarif(findings, { repoRoot: '/repo' }) as any;
    const r0 = log.runs[0].results[0].locations[0].physicalLocation.region;
    const r1 = log.runs[0].results[1].locations[0].physicalLocation.region;
    expect(r0.startLine).toBe(10);
    expect(r0.startColumn).toBe(5);
    expect(r1.startColumn).toBeUndefined();
  });

  it('is JSON serializable', () => {
    const log = toSarif(findings, { repoRoot: '/repo' });
    expect(() => JSON.stringify(log)).not.toThrow();
  });

  it('produces empty results/rules for no findings', () => {
    const log = toSarif([], { repoRoot: '/repo' }) as any;
    expect(log.runs[0].results).toEqual([]);
    expect(log.runs[0].tool.driver.rules).toEqual([]);
  });
});
