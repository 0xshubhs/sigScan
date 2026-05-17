import { parseBuildDiagnostics, groupByFile } from '../build-diagnostics';
import * as path from 'path';

const ROOT = '/home/dev/proj';

describe('parseBuildDiagnostics · legacy one-line format', () => {
  it('parses a single error', () => {
    const out = `src/Counter.sol:12:9: Error: Identifier not found.`;
    const ds = parseBuildDiagnostics(out, ROOT);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({
      filePath: path.join(ROOT, 'src/Counter.sol'),
      line: 12,
      column: 9,
      severity: 'error',
      message: 'Identifier not found.',
    });
  });

  it('parses a warning', () => {
    const out = `src/Bar.sol:5:1: Warning: Unused local variable.`;
    const ds = parseBuildDiagnostics(out, ROOT);
    expect(ds).toHaveLength(1);
    expect(ds[0].severity).toBe('warning');
  });

  it('handles TypeError / ParserError as errors', () => {
    const out = `src/X.sol:1:2: TypeError: Cannot convert.\nsrc/X.sol:3:4: ParserError: Expected ';'.`;
    const ds = parseBuildDiagnostics(out, ROOT);
    expect(ds).toHaveLength(2);
    expect(ds.every((d) => d.severity === 'error')).toBe(true);
  });
});

describe('parseBuildDiagnostics · rich multi-line format', () => {
  it('pairs a header line with its --> location', () => {
    const out = [
      `Error (1234): Cannot find import "missing.sol".`,
      ` --> src/Foo.sol:42:7:`,
      `   |`,
      `42 |     import "missing.sol";`,
      `   |       ^^^^^^^^^^^^^^^^^^`,
    ].join('\n');
    const ds = parseBuildDiagnostics(out, ROOT);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({
      filePath: path.join(ROOT, 'src/Foo.sol'),
      line: 42,
      column: 7,
      severity: 'error',
      code: '1234',
    });
    expect(ds[0].message).toContain('Cannot find import');
  });

  it('handles a header without an error code', () => {
    const out = [
      `Warning: Function visibility not specified.`,
      ` --> src/Foo.sol:10:1:`,
    ].join('\n');
    const ds = parseBuildDiagnostics(out, ROOT);
    expect(ds).toHaveLength(1);
    expect(ds[0].severity).toBe('warning');
    expect(ds[0].code).toBeUndefined();
  });
});

describe('parseBuildDiagnostics · mixed output', () => {
  it('coexists with informational lines and ANSI color codes', () => {
    const out = [
      `\x1B[31mCompiler run failed:\x1B[0m`,
      ``,
      `Error (5667): Unused function parameter.`,
      ` --> src/A.sol:7:14:`,
      ``,
      `src/B.sol:99:1: Warning: blah blah.`,
      ``,
      `random unrelated text`,
    ].join('\n');
    const ds = parseBuildDiagnostics(out, ROOT);
    expect(ds).toHaveLength(2);
    expect(ds[0].code).toBe('5667');
    expect(ds[1].filePath).toBe(path.join(ROOT, 'src/B.sol'));
  });

  it('deduplicates identical diagnostics that appear twice', () => {
    const out = [
      `src/X.sol:1:1: Error: oops.`,
      `src/X.sol:1:1: Error: oops.`,
    ].join('\n');
    const ds = parseBuildDiagnostics(out, ROOT);
    expect(ds).toHaveLength(1);
  });

  it('returns [] when no diagnostics found', () => {
    expect(parseBuildDiagnostics('Compiling 1 file\nDone in 0.3s', ROOT)).toEqual([]);
  });

  it('respects absolute paths in the compiler output', () => {
    const out = `/tmp/abs/Foo.sol:5:5: Error: oops.`;
    const ds = parseBuildDiagnostics(out, ROOT);
    expect(ds[0].filePath).toBe('/tmp/abs/Foo.sol');
  });
});

describe('groupByFile', () => {
  it('buckets diagnostics by file path', () => {
    const out = [
      `src/A.sol:1:1: Error: x.`,
      `src/B.sol:2:2: Error: y.`,
      `src/A.sol:3:3: Warning: z.`,
    ].join('\n');
    const ds = parseBuildDiagnostics(out, ROOT);
    const grouped = groupByFile(ds);
    expect(grouped.size).toBe(2);
    expect(grouped.get(path.join(ROOT, 'src/A.sol'))).toHaveLength(2);
    expect(grouped.get(path.join(ROOT, 'src/B.sol'))).toHaveLength(1);
  });
});
