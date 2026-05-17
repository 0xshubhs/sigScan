// Parses forge / hardhat / solc compile output into VS Code diagnostics.
//
// solc (used under the hood by both Foundry and Hardhat) emits two error
// formats:
//
//   1. Multi-line "rich" format:
//        Error (XXXX): semantic message
//         --> src/Foo.sol:42:7:
//          |
//        42 |     foo bar
//          |       ^^^^^^
//
//   2. Single-line legacy format:
//        src/Foo.sol:42:7: Error: Identifier not found.
//
// Forge sometimes prepends its own framing ("Compiler run failed:", color
// escapes if NO_COLOR is unset, etc.). We strip ANSI and walk lines looking
// for either format, accumulating an ordered list of diagnostics.

import * as path from 'path';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface ParsedDiagnostic {
  /** Absolute path on disk. */
  filePath: string;
  /** 1-based line number from the compiler. */
  line: number;
  /** 1-based column number from the compiler. */
  column: number;
  severity: DiagnosticSeverity;
  message: string;
  /** Optional solc error code, e.g. "5667". */
  code?: string;
}

// Strip ANSI escape sequences so the regex below doesn't have to know about colors.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;

// Matches the location line for both formats:
//   "src/Foo.sol:42:7" (legacy) and "  --> src/Foo.sol:42:7:" (rich).
// We allow an optional leading "-->" plus whitespace.
const LOCATION_RE = /(?:^|\s)(?:-->\s+)?([^\s:]+\.sol):(\d+):(\d+):?/;

// Matches the standalone "Error (1234): message" or "Warning (1234): message" line
// emitted *before* the location line in the rich format.
const SEVERITY_HEADER_RE = /^\s*(Error|Warning|Info|TypeError|ParserError|DeclarationError|SyntaxError|UnimplementedFeatureError|InternalCompilerError)\b(?:\s*\((\d+)\))?:\s*(.*)$/i;

// One-line legacy format: "src/Foo.sol:42:7: Error: message" — already has location.
const LEGACY_INLINE_RE = /^\s*([^\s:]+\.sol):(\d+):(\d+):\s*(Error|Warning|Info|TypeError|ParserError|DeclarationError|SyntaxError|UnimplementedFeatureError|InternalCompilerError)\b\s*:\s*(.*)$/i;

function normalizeSeverity(label: string | undefined): DiagnosticSeverity {
  if (!label) return 'error';
  const l = label.toLowerCase();
  if (l.startsWith('warn')) return 'warning';
  if (l === 'info') return 'info';
  return 'error';
}

function resolveFilePath(projectRoot: string, raw: string): string {
  // Forge / solc paths are usually project-relative; normalize either form.
  if (path.isAbsolute(raw)) return raw;
  return path.normalize(path.join(projectRoot, raw));
}

interface PendingHeader {
  severity: DiagnosticSeverity;
  code?: string;
  message: string;
}

/**
 * Parse forge / hardhat output into structured diagnostics.
 *
 * @param output  Combined stdout+stderr from the build process.
 * @param projectRoot  Root of the (sub)project — used to resolve relative paths.
 */
export function parseBuildDiagnostics(output: string, projectRoot: string): ParsedDiagnostic[] {
  const clean = output.replace(ANSI_RE, '');
  const lines = clean.split(/\r?\n/);
  const diagnostics: ParsedDiagnostic[] = [];
  const seen = new Set<string>();
  let pendingHeader: PendingHeader | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Legacy one-line form takes priority — it carries everything we need.
    const legacy = LEGACY_INLINE_RE.exec(line);
    if (legacy) {
      const filePath = resolveFilePath(projectRoot, legacy[1]);
      const d: ParsedDiagnostic = {
        filePath,
        line: parseInt(legacy[2], 10),
        column: parseInt(legacy[3], 10),
        severity: normalizeSeverity(legacy[4]),
        message: legacy[5].trim() || 'compilation issue',
      };
      const key = `${d.filePath}:${d.line}:${d.column}:${d.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        diagnostics.push(d);
      }
      pendingHeader = null;
      continue;
    }

    // Rich format: a "Error (1234): msg" line followed by a "--> path:line:col:" line.
    const header = SEVERITY_HEADER_RE.exec(line);
    if (header) {
      pendingHeader = {
        severity: normalizeSeverity(header[1]),
        code: header[2],
        message: (header[3] || '').trim(),
      };
      continue;
    }

    // Look for a location anywhere in the line — pairs with the pending header
    // if there is one, otherwise we still produce a generic diagnostic.
    const loc = LOCATION_RE.exec(line);
    if (loc) {
      const filePath = resolveFilePath(projectRoot, loc[1]);
      // Collect a couple of follow-up context lines (the carat arrow + source
      // snippet) for hover text — only if they look like part of the message.
      let extra = '';
      let probe = i + 1;
      while (probe < lines.length && probe < i + 4) {
        const next = lines[probe];
        // Stop if we hit a new header / location / blank.
        if (
          !next.trim() ||
          SEVERITY_HEADER_RE.test(next) ||
          LOCATION_RE.test(next) ||
          LEGACY_INLINE_RE.test(next)
        ) {
          break;
        }
        extra += '\n' + next.trimEnd();
        probe++;
      }

      const d: ParsedDiagnostic = {
        filePath,
        line: parseInt(loc[2], 10),
        column: parseInt(loc[3], 10),
        severity: pendingHeader?.severity ?? 'error',
        code: pendingHeader?.code,
        message: (pendingHeader?.message ?? 'compilation error') + (extra ? extra : ''),
      };
      const key = `${d.filePath}:${d.line}:${d.column}:${d.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        diagnostics.push(d);
      }
      pendingHeader = null;
    }
  }

  return diagnostics;
}

/**
 * Group diagnostics by absolute file path so a single `collection.set(uri, [])`
 * call can publish them — VS Code expects per-URI batching.
 */
export function groupByFile(diagnostics: ParsedDiagnostic[]): Map<string, ParsedDiagnostic[]> {
  const out = new Map<string, ParsedDiagnostic[]>();
  for (const d of diagnostics) {
    const list = out.get(d.filePath) ?? [];
    list.push(d);
    out.set(d.filePath, list);
  }
  return out;
}
