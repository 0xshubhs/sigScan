/**
 * Tests for the findings baseline.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  fingerprint,
  loadBaseline,
  saveBaseline,
  isBaselined,
  BaselineFinding,
} from '../finding-baseline';

const BASELINE_REL = path.join('.0xtools', 'findings-baseline.json');

function mkTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), '0xtools-baseline-'));
}

function rmTmpRoot(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('fingerprint', () => {
  it('is deterministic for the same finding', () => {
    const f: BaselineFinding = {
      file: 'src/A.sol',
      code: 'reentrancy',
      message: 'External call before state update',
    };
    expect(fingerprint(f)).toBe(fingerprint(f));
  });

  it('is a 64-char hex sha256 digest', () => {
    const fp = fingerprint({ file: 'A.sol', code: 'mev', message: 'sandwich' });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores the line number (stable across line moves)', () => {
    const a: BaselineFinding = { file: 'A.sol', code: 'mev', message: 'm', line: 1 };
    const b: BaselineFinding = { file: 'A.sol', code: 'mev', message: 'm', line: 999 };
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('uses the basename only — directory does not affect it', () => {
    const a = fingerprint({ file: 'src/deep/A.sol', code: 'mev', message: 'm' });
    const b = fingerprint({ file: 'A.sol', code: 'mev', message: 'm' });
    expect(a).toBe(b);
  });

  it('normalizes windows backslash separators', () => {
    const win = fingerprint({ file: 'src\\deep\\A.sol', code: 'mev', message: 'm' });
    const unix = fingerprint({ file: 'src/deep/A.sol', code: 'mev', message: 'm' });
    expect(win).toBe(unix);
  });

  it('is case-insensitive on the code', () => {
    const a = fingerprint({ file: 'A.sol', code: 'Reentrancy', message: 'm' });
    const b = fingerprint({ file: 'A.sol', code: 'reentrancy', message: 'm' });
    expect(a).toBe(b);
  });

  it('differs when code, message, or basename differ', () => {
    const base = fingerprint({ file: 'A.sol', code: 'mev', message: 'm' });
    expect(fingerprint({ file: 'A.sol', code: 'natspec', message: 'm' })).not.toBe(base);
    expect(fingerprint({ file: 'A.sol', code: 'mev', message: 'other' })).not.toBe(base);
    expect(fingerprint({ file: 'B.sol', code: 'mev', message: 'm' })).not.toBe(base);
  });
});

describe('loadBaseline', () => {
  let root: string;
  beforeEach(() => {
    root = mkTmpRoot();
  });
  afterEach(() => {
    rmTmpRoot(root);
  });

  it('returns an empty set when no baseline file exists', () => {
    expect(loadBaseline(root).size).toBe(0);
  });

  it('returns an empty set for corrupt JSON (never throws)', () => {
    const p = path.join(root, BASELINE_REL);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{ this is not json ', 'utf8');
    expect(() => loadBaseline(root)).not.toThrow();
    expect(loadBaseline(root).size).toBe(0);
  });

  it('returns an empty set when fingerprints is missing or wrong type', () => {
    const p = path.join(root, BASELINE_REL);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ version: 1 }), 'utf8');
    expect(loadBaseline(root).size).toBe(0);

    fs.writeFileSync(p, JSON.stringify({ version: 1, fingerprints: 'nope' }), 'utf8');
    expect(loadBaseline(root).size).toBe(0);
  });

  it('skips non-string / empty entries in fingerprints', () => {
    const p = path.join(root, BASELINE_REL);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({ version: 1, fingerprints: ['abc', 123, '', null, 'def'] }),
      'utf8'
    );
    const set = loadBaseline(root);
    expect(set.has('abc')).toBe(true);
    expect(set.has('def')).toBe(true);
    expect(set.size).toBe(2);
  });
});

describe('saveBaseline', () => {
  let root: string;
  beforeEach(() => {
    root = mkTmpRoot();
  });
  afterEach(() => {
    rmTmpRoot(root);
  });

  it('creates the .0xtools dir and writes the expected JSON shape', () => {
    const findings: BaselineFinding[] = [
      { file: 'A.sol', code: 'mev', message: 'sandwich' },
    ];
    saveBaseline(root, findings);

    const p = path.join(root, BASELINE_REL);
    expect(fs.existsSync(p)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(parsed.version).toBe(1);
    expect(Array.isArray(parsed.fingerprints)).toBe(true);
    expect(parsed.fingerprints).toEqual([fingerprint(findings[0])]);
  });

  it('de-duplicates and sorts fingerprints', () => {
    const dup: BaselineFinding = { file: 'A.sol', code: 'mev', message: 'm' };
    const other: BaselineFinding = { file: 'B.sol', code: 'natspec', message: 'n' };
    saveBaseline(root, [dup, dup, other]);

    const parsed = JSON.parse(
      fs.readFileSync(path.join(root, BASELINE_REL), 'utf8')
    );
    const expected = [fingerprint(dup), fingerprint(other)].sort();
    expect(parsed.fingerprints).toEqual(expected);
    // de-dup: only 2 unique entries despite 3 findings
    expect(parsed.fingerprints.length).toBe(2);
  });

  it('overwrites an existing baseline', () => {
    saveBaseline(root, [{ file: 'A.sol', code: 'mev', message: 'm1' }]);
    saveBaseline(root, [{ file: 'A.sol', code: 'mev', message: 'm2' }]);
    const set = loadBaseline(root);
    expect(set.has(fingerprint({ file: 'A.sol', code: 'mev', message: 'm2' }))).toBe(true);
    expect(set.has(fingerprint({ file: 'A.sol', code: 'mev', message: 'm1' }))).toBe(false);
    expect(set.size).toBe(1);
  });
});

describe('round-trip + isBaselined', () => {
  let root: string;
  beforeEach(() => {
    root = mkTmpRoot();
  });
  afterEach(() => {
    rmTmpRoot(root);
  });

  it('saveBaseline then loadBaseline recovers every fingerprint', () => {
    const findings: BaselineFinding[] = [
      { file: 'src/A.sol', code: 'reentrancy', message: 'external call', line: 10 },
      { file: 'src/B.sol', code: 'unchecked-call', message: 'ignored return', line: 22 },
      { file: 'lib/C.sol', code: 'natspec', message: 'missing @param' },
    ];
    saveBaseline(root, findings);
    const set = loadBaseline(root);

    expect(set.size).toBe(3);
    for (const f of findings) {
      expect(set.has(fingerprint(f))).toBe(true);
      expect(isBaselined(f, set)).toBe(true);
    }
  });

  it('isBaselined matches regardless of line number changes', () => {
    const original: BaselineFinding = {
      file: 'A.sol',
      code: 'mev',
      message: 'sandwich',
      line: 5,
    };
    saveBaseline(root, [original]);
    const set = loadBaseline(root);

    const moved: BaselineFinding = { ...original, line: 500 };
    expect(isBaselined(moved, set)).toBe(true);
  });

  it('isBaselined is false for a brand-new finding', () => {
    saveBaseline(root, [{ file: 'A.sol', code: 'mev', message: 'm' }]);
    const set = loadBaseline(root);
    expect(isBaselined({ file: 'A.sol', code: 'reentrancy', message: 'new' }, set)).toBe(false);
  });

  it('isBaselined is false against an empty baseline', () => {
    const empty = new Set<string>();
    expect(isBaselined({ file: 'A.sol', code: 'mev', message: 'm' }, empty)).toBe(false);
  });
});
