/**
 * Code Action Provider
 *
 * A VS Code CodeActionProvider that offers quick-fixes for the diagnostics
 * published by 0xTools (those whose `source === '0xTools'`). Each diagnostic
 * carries a `code` string (e.g. `tx-origin`, `natspec`) describing the issue.
 * This provider maps a subset of those codes to concrete, compile-safe
 * Solidity edits surfaced as QuickFix actions in the editor's lightbulb menu.
 *
 * The design is intentionally extensible: fixes are keyed by diagnostic code
 * in {@link QUICK_FIX_BUILDERS}, so adding support for a new code is a matter
 * of registering another builder — no changes to the provider plumbing.
 */

import * as vscode from 'vscode';

/** Marker identifying diagnostics emitted by this extension. */
const DIAGNOSTIC_SOURCE = '0xTools';

/**
 * A builder turns a single 0xTools diagnostic into a quick-fix CodeAction.
 *
 * Builders may return `undefined` when they cannot safely construct a fix for
 * the given diagnostic (e.g. the offending line is out of bounds), in which
 * case no action is offered for that diagnostic.
 */
type QuickFixBuilder = (
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic
) => vscode.CodeAction | undefined;

/**
 * Registry mapping a diagnostic `code` to the builder that produces its fix.
 *
 * To support a new diagnostic code, add an entry here. The provider stays
 * untouched.
 */
const QUICK_FIX_BUILDERS: Record<string, QuickFixBuilder> = {
  'tx-origin': buildTxOriginFix,
  natspec: buildNatSpecFix,
};

/**
 * VS Code CodeActionProvider that surfaces quick-fixes for 0xTools diagnostics.
 */
export class ZeroXToolsCodeActionProvider implements vscode.CodeActionProvider {
  /** Only QuickFix actions are produced by this provider. */
  public static readonly providedCodeActionKinds: vscode.CodeActionKind[] = [
    vscode.CodeActionKind.QuickFix,
  ];

  /**
   * Provide quick-fix actions for any 0xTools diagnostics in scope.
   *
   * Iterates the diagnostics supplied in {@link context}, skips anything not
   * authored by 0xTools, and delegates to the registered builder for each
   * recognised diagnostic code.
   *
   * @param document - The document the actions apply to
   * @param _range - The selection/cursor range (unused; we key off diagnostics)
   * @param context - Carries the diagnostics overlapping the range
   * @returns An array of QuickFix CodeActions (possibly empty)
   */
  public provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    const diagnostics = context?.diagnostics ?? [];
    for (const diagnostic of diagnostics) {
      if (diagnostic.source !== DIAGNOSTIC_SOURCE) {
        continue;
      }

      const code = normalizeCode(diagnostic.code);
      if (!code) {
        continue;
      }

      const builder = QUICK_FIX_BUILDERS[code];
      if (!builder) {
        continue;
      }

      const action = builder(document, diagnostic);
      if (action) {
        actions.push(action);
      }
    }

    return actions;
  }
}

/**
 * Register the 0xTools CodeActionProvider for Solidity documents.
 *
 * Wires up a {@link ZeroXToolsCodeActionProvider} for `{ language: 'solidity' }`
 * advertising only the QuickFix kind, and tracks the resulting disposable on
 * the extension context so VS Code can tear it down on deactivation.
 *
 * @param context - The activating extension's context
 */
export function registerCodeActionProvider(context: vscode.ExtensionContext): void {
  const disposable = vscode.languages.registerCodeActionsProvider(
    { language: 'solidity' },
    new ZeroXToolsCodeActionProvider(),
    {
      providedCodeActionKinds: ZeroXToolsCodeActionProvider.providedCodeActionKinds,
    }
  );

  context.subscriptions.push(disposable);
}

// ─── Fix builders ──────────────────────────────────────────────────────────

/**
 * Build the `tx-origin` fix: replace `tx.origin` with `msg.sender`.
 *
 * Reads the offending line and rewrites every `tx.origin` occurrence on it via
 * a single WorkspaceEdit replacement. Marked preferred since it is the
 * canonical remediation.
 */
function buildTxOriginFix(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic
): vscode.CodeAction | undefined {
  const line = getDiagnosticLine(document, diagnostic);
  if (line === undefined) {
    return undefined;
  }

  const { lineNumber, text } = line;
  if (!text.includes('tx.origin')) {
    return undefined;
  }

  const fixedText = text.split('tx.origin').join('msg.sender');

  const action = new vscode.CodeAction(
    'Replace tx.origin with msg.sender',
    vscode.CodeActionKind.QuickFix
  );
  action.diagnostics = [diagnostic];
  action.isPreferred = true;

  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, fullLineRange(lineNumber, text), fixedText);
  action.edit = edit;

  return action;
}

/**
 * Build the `natspec` fix: insert a NatSpec doc comment above the function.
 *
 * The diagnostic line is a function declaration. We best-effort parse the
 * parameter names and detect a `returns (...)` clause, then insert a NatSpec
 * block (matching the function's leading indentation) immediately above it. On
 * any parse trouble we degrade gracefully to a bare `/// @notice` line so the
 * emitted comment is always valid Solidity.
 */
function buildNatSpecFix(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic
): vscode.CodeAction | undefined {
  const line = getDiagnosticLine(document, diagnostic);
  if (line === undefined) {
    return undefined;
  }

  const { lineNumber, text } = line;
  const indent = leadingIndent(text);
  const signature = parseFunctionSignature(text);

  const lines: string[] = [`${indent}/// @notice `];
  for (const param of signature.params) {
    lines.push(`${indent}/// @param ${param} `);
  }
  if (signature.hasReturns) {
    lines.push(`${indent}/// @return `);
  }

  // Trailing newline so the block sits on its own line(s) above the function.
  const insertText = lines.join('\n') + '\n';

  const action = new vscode.CodeAction(
    'Insert NatSpec doc comment',
    vscode.CodeActionKind.QuickFix
  );
  action.diagnostics = [diagnostic];

  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, new vscode.Position(lineNumber, 0), insertText);
  action.edit = edit;

  return action;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalize a diagnostic `code` (which may be a string, number, or
 * `{ value, target }`) into a plain string code, or `undefined` if none.
 */
function normalizeCode(
  code: vscode.Diagnostic['code']
): string | undefined {
  if (typeof code === 'string') {
    return code;
  }
  if (typeof code === 'number') {
    return String(code);
  }
  if (code && typeof code === 'object' && 'value' in code) {
    const value = (code as { value: string | number }).value;
    return typeof value === 'number' ? String(value) : value;
  }
  return undefined;
}

/**
 * Resolve the line targeted by a diagnostic, defensively clamping to the
 * document bounds. Returns the line number and its text, or `undefined` when
 * the diagnostic points outside the document.
 */
function getDiagnosticLine(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic
): { lineNumber: number; text: string } | undefined {
  const range = diagnostic.range;
  if (!range || !range.start) {
    return undefined;
  }

  const lineNumber = range.start.line;
  if (
    typeof lineNumber !== 'number' ||
    lineNumber < 0 ||
    lineNumber >= document.lineCount
  ) {
    return undefined;
  }

  const text = document.lineAt(lineNumber).text;
  return { lineNumber, text };
}

/** Build a Range spanning an entire line given its number and text. */
function fullLineRange(lineNumber: number, text: string): vscode.Range {
  return new vscode.Range(
    new vscode.Position(lineNumber, 0),
    new vscode.Position(lineNumber, text.length)
  );
}

/** Extract the leading whitespace (indentation) of a line. */
function leadingIndent(text: string): string {
  const match = text.match(/^[\t ]*/);
  return match ? match[0] : '';
}

/**
 * Best-effort parse of a Solidity function declaration line.
 *
 * Pulls the parameter names from the first `(...)` group (last identifier of
 * each comma-separated part, which is the param name in Solidity) and detects
 * whether the signature declares a `returns (...)` clause. Never throws —
 * unparseable input yields no params and no returns.
 */
function parseFunctionSignature(text: string): {
  params: string[];
  hasReturns: boolean;
} {
  const empty = { params: [] as string[], hasReturns: false };

  try {
    const openParen = text.indexOf('(');
    if (openParen === -1) {
      return empty;
    }

    // Find the matching close paren for the parameter list.
    let depth = 0;
    let closeParen = -1;
    for (let i = openParen; i < text.length; i++) {
      const ch = text[i];
      if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
        if (depth === 0) {
          closeParen = i;
          break;
        }
      }
    }
    if (closeParen === -1) {
      return empty;
    }

    const paramsBlob = text.slice(openParen + 1, closeParen).trim();
    const params: string[] = [];
    if (paramsBlob.length > 0) {
      for (const part of paramsBlob.split(',')) {
        const name = lastIdentifier(part);
        if (name) {
          params.push(name);
        }
      }
    }

    // A `returns` keyword after the parameter list indicates return values.
    const tail = text.slice(closeParen + 1);
    const hasReturns = /\breturns\b/.test(tail);

    return { params, hasReturns };
  } catch {
    return empty;
  }
}

/**
 * Return the last identifier token in a parameter fragment (e.g.
 * `uint256 amount` -> `amount`, `address` -> `address`). Returns `undefined`
 * when the fragment contains no identifier.
 */
function lastIdentifier(part: string): string | undefined {
  const tokens = part.trim().match(/[A-Za-z_$][A-Za-z0-9_$]*/g);
  if (!tokens || tokens.length === 0) {
    return undefined;
  }
  return tokens[tokens.length - 1];
}
