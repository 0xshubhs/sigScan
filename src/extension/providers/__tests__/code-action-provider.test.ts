/**
 * Tests for ZeroXToolsCodeActionProvider — quick-fixes for 0xTools diagnostics.
 */

import * as vscode from 'vscode';
import {
  ZeroXToolsCodeActionProvider,
  registerCodeActionProvider,
} from '../code-action-provider';

/**
 * Build a minimal fake TextDocument backed by an array of source lines.
 * Implements only the surface the provider touches: `uri`, `lineCount`, and
 * `lineAt(n).text`.
 */
function makeDocument(lines: string[]): vscode.TextDocument {
  const uri = vscode.Uri.parse('file:///Test.sol');
  return {
    uri,
    lineCount: lines.length,
    lineAt: (line: number) => ({ text: lines[line] }),
  } as unknown as vscode.TextDocument;
}

/** Build a 0xTools diagnostic on a single line with the given code. */
function makeDiagnostic(line: number, code: string, source = '0xTools'): vscode.Diagnostic {
  const range = new vscode.Range(
    new vscode.Position(line, 0),
    new vscode.Position(line, 0)
  );
  const diag = new vscode.Diagnostic(range, 'message');
  diag.source = source;
  diag.code = code;
  return diag;
}

/** Build a CodeActionContext carrying the given diagnostics. */
function makeContext(diagnostics: vscode.Diagnostic[]): vscode.CodeActionContext {
  return { diagnostics } as unknown as vscode.CodeActionContext;
}

describe('ZeroXToolsCodeActionProvider', () => {
  let provider: ZeroXToolsCodeActionProvider;

  beforeEach(() => {
    provider = new ZeroXToolsCodeActionProvider();
  });

  it('advertises only the QuickFix kind', () => {
    expect(ZeroXToolsCodeActionProvider.providedCodeActionKinds).toEqual([
      vscode.CodeActionKind.QuickFix,
    ]);
  });

  describe('non-0xTools diagnostics', () => {
    it('returns no actions for a foreign diagnostic source', () => {
      const doc = makeDocument(['    require(tx.origin == owner);']);
      const diag = makeDiagnostic(0, 'tx-origin', 'solidity');

      const actions = provider.provideCodeActions(
        doc,
        diag.range,
        makeContext([diag])
      );

      expect(actions).toEqual([]);
    });

    it('returns no actions for an empty diagnostics list', () => {
      const doc = makeDocument(['contract C {}']);
      const actions = provider.provideCodeActions(
        doc,
        new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)),
        makeContext([])
      );
      expect(actions).toEqual([]);
    });
  });

  describe('tx-origin quick-fix', () => {
    it('replaces every tx.origin with msg.sender on the line', () => {
      const lineText = '    require(tx.origin == owner || tx.origin == admin);';
      const doc = makeDocument([lineText]);
      const diag = makeDiagnostic(0, 'tx-origin');

      const actions = provider.provideCodeActions(
        doc,
        diag.range,
        makeContext([diag])
      );

      expect(actions).toHaveLength(1);
      const action = actions[0];
      expect(action.title).toBe('Replace tx.origin with msg.sender');
      expect(action.kind).toBe(vscode.CodeActionKind.QuickFix);
      expect(action.isPreferred).toBe(true);
      expect(action.diagnostics).toEqual([diag]);

      const edit = action.edit as unknown as {
        operations: Array<{ type: string; newText: string }>;
      };
      expect(edit.operations).toHaveLength(1);
      const op = edit.operations[0];
      expect(op.type).toBe('replace');
      expect(op.newText).toBe(
        '    require(msg.sender == owner || msg.sender == admin);'
      );
      expect(op.newText).not.toContain('tx.origin');
    });

    it('does not offer a fix when the line has no tx.origin', () => {
      const doc = makeDocument(['    require(msg.sender == owner);']);
      const diag = makeDiagnostic(0, 'tx-origin');
      const actions = provider.provideCodeActions(
        doc,
        diag.range,
        makeContext([diag])
      );
      expect(actions).toEqual([]);
    });
  });

  describe('natspec quick-fix', () => {
    it('inserts a NatSpec block with @param and @return for the signature', () => {
      const lineText =
        '    function transfer(address to, uint256 amount) public returns (bool) {';
      const doc = makeDocument([lineText]);
      const diag = makeDiagnostic(0, 'natspec');

      const actions = provider.provideCodeActions(
        doc,
        diag.range,
        makeContext([diag])
      );

      expect(actions).toHaveLength(1);
      const action = actions[0];
      expect(action.title).toBe('Insert NatSpec doc comment');
      expect(action.kind).toBe(vscode.CodeActionKind.QuickFix);
      expect(action.diagnostics).toEqual([diag]);

      const edit = action.edit as unknown as {
        operations: Array<{
          type: string;
          position: { line: number; character: number };
          newText: string;
        }>;
      };
      expect(edit.operations).toHaveLength(1);
      const op = edit.operations[0];
      expect(op.type).toBe('insert');
      expect(op.position.line).toBe(0);
      expect(op.position.character).toBe(0);

      // Matches the function's 4-space indentation.
      expect(op.newText).toContain('    /// @notice ');
      expect(op.newText).toContain('    /// @param to ');
      expect(op.newText).toContain('    /// @param amount ');
      expect(op.newText).toContain('    /// @return ');
      // Inserted above the function, so it ends with a newline.
      expect(op.newText.endsWith('\n')).toBe(true);
    });

    it('omits @return when the function returns nothing', () => {
      const lineText = 'function setOwner(address newOwner) external {';
      const doc = makeDocument([lineText]);
      const diag = makeDiagnostic(0, 'natspec');

      const actions = provider.provideCodeActions(
        doc,
        diag.range,
        makeContext([diag])
      );

      const op = (
        actions[0].edit as unknown as {
          operations: Array<{ newText: string }>;
        }
      ).operations[0];
      expect(op.newText).toContain('/// @param newOwner ');
      expect(op.newText).not.toContain('/// @return');
    });

    it('falls back to a bare @notice for a paramless function', () => {
      const lineText = '  function pause() public {';
      const doc = makeDocument([lineText]);
      const diag = makeDiagnostic(0, 'natspec');

      const op = (
        provider.provideCodeActions(doc, diag.range, makeContext([diag]))[0]
          .edit as unknown as { operations: Array<{ newText: string }> }
      ).operations[0];
      expect(op.newText).toContain('  /// @notice ');
      expect(op.newText).not.toContain('/// @param');
      expect(op.newText).not.toContain('/// @return');
    });
  });

  describe('defensiveness', () => {
    it('ignores a diagnostic whose line is out of bounds', () => {
      const doc = makeDocument(['contract C {}']);
      const diag = makeDiagnostic(5, 'tx-origin');
      const actions = provider.provideCodeActions(
        doc,
        diag.range,
        makeContext([diag])
      );
      expect(actions).toEqual([]);
    });

    it('ignores an unknown diagnostic code', () => {
      const doc = makeDocument(['    selfdestruct(payable(owner));']);
      const diag = makeDiagnostic(0, 'selfdestruct');
      const actions = provider.provideCodeActions(
        doc,
        diag.range,
        makeContext([diag])
      );
      expect(actions).toEqual([]);
    });
  });
});

describe('registerCodeActionProvider', () => {
  it('registers a Solidity provider and tracks the disposable', () => {
    const subscriptions: { dispose(): void }[] = [];
    const context = { subscriptions } as unknown as vscode.ExtensionContext;

    registerCodeActionProvider(context);

    expect(vscode.languages.registerCodeActionsProvider).toHaveBeenCalledTimes(1);
    const [selector, providerArg, metadata] = (
      vscode.languages.registerCodeActionsProvider as jest.Mock
    ).mock.calls[0];
    expect(selector).toEqual({ language: 'solidity' });
    expect(providerArg).toBeInstanceOf(ZeroXToolsCodeActionProvider);
    expect(metadata.providedCodeActionKinds).toEqual([vscode.CodeActionKind.QuickFix]);
    expect(subscriptions).toHaveLength(1);
  });
});
