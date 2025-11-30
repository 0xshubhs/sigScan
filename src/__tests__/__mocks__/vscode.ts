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
  constructor(
    public range: Range,
    public message: string,
    public severity?: DiagnosticSeverity
  ) {}
}

export class Uri {
  static file(path: string) {
    return { fsPath: path, path, scheme: 'file' };
  }
}

export const window = {
  createTextEditorDecorationType: jest.fn(() => ({
    dispose: jest.fn(),
  })),
  showInformationMessage: jest.fn(),
  showErrorMessage: jest.fn(),
  showWarningMessage: jest.fn(),
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
};
