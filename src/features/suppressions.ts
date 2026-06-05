/**
 * Inline suppression comments for security findings.
 *
 * Lets users mute false-positive diagnostics directly in their Solidity source
 * using `0xtools`-style directive comments. This module is PURE (no vscode, no
 * fs) so it can be shared between the VS Code extension and the CLI.
 *
 * Supported directives (case-insensitive on the directive text):
 *   - `// 0xtools-disable-next-line [rule[, rule2]]` — suppress the NEXT line.
 *   - `// 0xtools-disable-line [rule[, rule2]]`      — suppress the SAME line.
 *   - `// 0xtools-disable [rule[, rule2]]`           — suppress the WHOLE file.
 *
 * The prefixes `0xtools:disable...` and `@0xtools-disable...` are accepted as
 * lenient aliases. When no rule list follows the directive, every rule is
 * suppressed (`rules: 'all'`); otherwise the comma/space separated rule ids are
 * captured (trimmed and lowercased).
 */

/** A single parsed suppression directive. */
export interface SuppressionScope {
  /** Rules suppressed: 'all' means every rule id; otherwise the listed rule/code ids. */
  rules: 'all' | string[];
  /** 0-based line the suppression applies to, or 'file' for a whole-file suppression. */
  target: number | 'file';
}

/**
 * Matches a 0xtools suppression directive inside a comment.
 *
 * Group 1: the directive variant (`-next-line`, `-line`, or empty for bare).
 * Group 2: the trailing rule list (may be empty / undefined).
 *
 * The leading prefix accepts `0xtools-`, `0xtools:`, `@0xtools-`, `@0xtools:`.
 */
const DIRECTIVE_RE =
  /@?0xtools[-:]disable(-next-line|-line)?\b[ \t]*([^\r\n]*)/i;

/** Matches a `//` line comment (possibly trailing) and captures its content. */
const LINE_COMMENT_RE = /\/\/(.*)$/;

/**
 * Split a captured rule list into normalized rule ids.
 * Returns 'all' when the list is empty.
 */
function parseRuleList(raw: string | undefined): 'all' | string[] {
  if (!raw) {
    return 'all';
  }
  // Stop at the start of a block-comment terminator if one leaked in.
  const cleaned = raw.replace(/\*\/.*$/, '').trim();
  if (cleaned.length === 0) {
    return 'all';
  }
  const rules = cleaned
    .split(/[\s,]+/)
    .map((r) => r.trim().toLowerCase())
    .filter((r) => r.length > 0);
  return rules.length > 0 ? rules : 'all';
}

/**
 * Parse a Solidity source string for 0xtools suppression comments.
 *
 * Lines are split on `\n` (a trailing `\r` is tolerated). Only `//` line
 * comments — standalone or trailing on a code line — are inspected.
 */
export function parseSuppressions(source: string): SuppressionScope[] {
  const scopes: SuppressionScope[] = [];
  if (!source) {
    return scopes;
  }

  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');

    const commentMatch = LINE_COMMENT_RE.exec(line);
    if (!commentMatch) {
      continue;
    }
    const commentBody = commentMatch[1];

    const directiveMatch = DIRECTIVE_RE.exec(commentBody);
    if (!directiveMatch) {
      continue;
    }

    const variant = (directiveMatch[1] || '').toLowerCase();
    const rules = parseRuleList(directiveMatch[2]);

    let target: number | 'file';
    if (variant === '-next-line') {
      target = i + 1;
    } else if (variant === '-line') {
      target = i;
    } else {
      target = 'file';
    }

    scopes.push({ rules, target });
  }

  return scopes;
}

/**
 * True if a finding with rule `code` at 0-based `line` is suppressed by any of
 * the given scopes. Rule ids are compared case-insensitively.
 */
export function isSuppressed(
  code: string,
  line: number,
  suppressions: SuppressionScope[]
): boolean {
  const normalizedCode = (code || '').toLowerCase();

  for (const scope of suppressions) {
    const lineMatches = scope.target === 'file' || scope.target === line;
    if (!lineMatches) {
      continue;
    }
    if (scope.rules === 'all' || scope.rules.includes(normalizedCode)) {
      return true;
    }
  }

  return false;
}
