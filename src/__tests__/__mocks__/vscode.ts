/**
 * Mock for VS Code API in tests
 */

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export enum EndOfLine {
  LF = 1,
  CRLF = 2,
}

export enum QuickPickItemKind {
  Separator = -1,
  Default = 0,
}

export class Range {
  constructor(
    public start: Position,
    public end: Position
  ) {}
}

export class Position {
  constructor(
    public line: number,
    public character: number
  ) {}
}

export class Diagnostic {
  public source?: string;
  public code?: string | number | { value: string | number; target: Uri };
  constructor(
    public range: Range,
    public message: string,
    public severity?: DiagnosticSeverity
  ) {}
}

export class Uri {
  private constructor(
    public scheme: string,
    public path: string,
    public fsPath: string
  ) {}

  static file(path: string): Uri {
    return new Uri('file', path, path);
  }

  static parse(value: string): Uri {
    const idx = value.indexOf(':');
    const scheme = idx >= 0 ? value.slice(0, idx) : 'file';
    const path = idx >= 0 ? value.slice(idx + 1) : value;
    return new Uri(scheme, path, path);
  }

  toString(): string {
    return `${this.scheme}:${this.path}`;
  }
}

/**
 * Mirror of vscode.CodeActionKind. Only the QuickFix value (and the helper
 * machinery to build it) is exercised by the provider under test.
 */
export class CodeActionKind {
  static readonly Empty = new CodeActionKind('');
  static readonly QuickFix = new CodeActionKind('quickfix');
  static readonly Refactor = new CodeActionKind('refactor');
  static readonly Source = new CodeActionKind('source');

  constructor(public value: string) {}
}

export class CodeAction {
  public edit?: WorkspaceEdit;
  public diagnostics?: Diagnostic[];
  public isPreferred?: boolean;
  constructor(
    public title: string,
    public kind?: CodeActionKind
  ) {}
}

/**
 * Records replace/insert operations so tests can assert on the resulting edits.
 * Each recorded entry captures the target Uri, the operation type, the range or
 * position, and the new text.
 */
export class WorkspaceEdit {
  public operations: Array<{
    type: 'replace' | 'insert';
    uri: Uri;
    range?: Range;
    position?: Position;
    newText: string;
  }> = [];

  replace(uri: Uri, range: Range, newText: string): void {
    this.operations.push({ type: 'replace', uri, range, newText });
  }

  insert(uri: Uri, position: Position, newText: string): void {
    this.operations.push({ type: 'insert', uri, position, newText });
  }
}

export const window = {
  createTextEditorDecorationType: jest.fn(() => ({
    dispose: jest.fn(),
  })),
  showInformationMessage: jest.fn(),
  showErrorMessage: jest.fn(),
  showWarningMessage: jest.fn(),
  showQuickPick: jest.fn(),
  createQuickPick: jest.fn(),
};

export const workspace = {
  getConfiguration: jest.fn(() => ({
    get: jest.fn(),
    update: jest.fn(),
  })),
};

export const languages = {
  createDiagnosticCollection: jest.fn(() => ({
    set: jest.fn(),
    delete: jest.fn(),
    clear: jest.fn(),
    dispose: jest.fn(),
    name: 'test',
    forEach: jest.fn(),
    get: jest.fn(),
    has: jest.fn(),
  })),
  registerCodeActionsProvider: jest.fn(() => ({ dispose: jest.fn() })),
};

export const commands = {
  registerCommand: jest.fn(() => ({ dispose: jest.fn() })),
  executeCommand: jest.fn(),
};
