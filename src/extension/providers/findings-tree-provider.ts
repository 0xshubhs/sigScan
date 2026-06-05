/**
 * Findings Tree Provider
 *
 * Surfaces every diagnostic the extension publishes under the `0xTools`
 * source in a single, unified VS Code tree view. Diagnostics are read from
 * `vscode.languages.getDiagnostics()` and filtered to `source === '0xTools'`
 * (codes such as 'reentrancy', 'unchecked-call', 'missing-event',
 * 'access-control', 'tx-origin', 'mev', 'eip170-size', the various defi risk
 * types, and so on).
 *
 * The tree is two levels deep:
 *   - Level 1: file-group nodes (one per Uri that has findings), labeled by
 *     the file's basename with a count and the relative path as description.
 *   - Level 2: individual finding leaves, each opening the file at the
 *     finding's range when clicked and showing a severity-based icon.
 *
 * When no findings exist, a single non-clickable informational node is shown.
 *
 * The view refreshes automatically whenever
 * `vscode.languages.onDidChangeDiagnostics` fires. Only the public VS Code API
 * is used.
 */

import * as vscode from 'vscode';

/** Exact view id the package.json contribution must match. */
export const FINDINGS_VIEW_ID = 'zeroXTools.findings';

/** Diagnostic source this view surfaces. */
const FINDINGS_SOURCE = '0xTools';

/** A file-group node holding the findings for a single document. */
interface FileNode {
  kind: 'file';
  uri: vscode.Uri;
  diagnostics: vscode.Diagnostic[];
}

/** A single finding leaf node. */
interface FindingNode {
  kind: 'finding';
  uri: vscode.Uri;
  diagnostic: vscode.Diagnostic;
}

/** A placeholder node shown when there are no findings. */
interface EmptyNode {
  kind: 'empty';
}

/** Union of every node type rendered by the provider. */
type TreeNode = FileNode | FindingNode | EmptyNode;

/** Renders the `code` field (string | number | object) as a short string. */
function formatCode(code: vscode.Diagnostic['code']): string {
  if (code === undefined || code === null) {
    return '';
  }
  if (typeof code === 'string' || typeof code === 'number') {
    return String(code);
  }
  // { value, target } form.
  return String(code.value);
}

/** Maps a diagnostic severity to a ThemeIcon name. */
function iconForSeverity(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    default:
      return 'info';
  }
}

class FindingsTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    TreeNode | undefined | null | void
  >();
  readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined | null | void> =
    this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === 'empty') {
      const item = new vscode.TreeItem(
        'No findings — contracts look clean ✓',
        vscode.TreeItemCollapsibleState.None
      );
      item.iconPath = new vscode.ThemeIcon('check');
      item.contextValue = 'empty';
      return item;
    }

    if (element.kind === 'file') {
      const count = element.diagnostics.length;
      const item = new vscode.TreeItem(
        `${this.basename(element.uri)} (${count})`,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.resourceUri = element.uri;
      item.description = vscode.workspace.asRelativePath(element.uri);
      item.tooltip = `${element.uri.fsPath} — ${count} finding${count === 1 ? '' : 's'}`;
      item.iconPath = new vscode.ThemeIcon('file-code');
      item.contextValue = 'findingsFile';
      return item;
    }

    // Finding leaf.
    const diag = element.diagnostic;
    const item = new vscode.TreeItem(diag.message, vscode.TreeItemCollapsibleState.None);
    item.description = formatCode(diag.code);
    item.tooltip = diag.message;
    item.iconPath = new vscode.ThemeIcon(iconForSeverity(diag.severity));
    item.contextValue = 'finding';
    item.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [element.uri, { selection: diag.range }],
    };
    return item;
  }

  getChildren(element?: TreeNode): vscode.ProviderResult<TreeNode[]> {
    if (!element) {
      return this.rootNodes();
    }
    if (element.kind === 'file') {
      return element.diagnostics.map<FindingNode>((diagnostic) => ({
        kind: 'finding',
        uri: element.uri,
        diagnostic,
      }));
    }
    return [];
  }

  /** Builds the top-level file groups (or the empty placeholder). */
  private rootNodes(): TreeNode[] {
    const files: FileNode[] = [];

    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      const findings = diagnostics.filter((d) => d.source === FINDINGS_SOURCE);
      if (findings.length === 0) {
        continue;
      }
      findings.sort((a, b) => a.range.start.compareTo(b.range.start));
      files.push({ kind: 'file', uri, diagnostics: findings });
    }

    if (files.length === 0) {
      return [{ kind: 'empty' }];
    }

    files.sort((a, b) => this.basename(a.uri).localeCompare(this.basename(b.uri)));
    return files;
  }

  private basename(uri: vscode.Uri): string {
    const path = uri.path;
    const idx = path.lastIndexOf('/');
    return idx >= 0 ? path.slice(idx + 1) : path;
  }
}

/**
 * Registers the unified Findings tree view and wires it to live diagnostic
 * updates. Both the tree view and the change subscription are pushed onto
 * `context.subscriptions` for disposal on deactivation.
 */
export function registerFindingsTree(context: vscode.ExtensionContext): void {
  const provider = new FindingsTreeProvider();

  const treeView = vscode.window.createTreeView(FINDINGS_VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  const diagnosticsSub = vscode.languages.onDidChangeDiagnostics(() => {
    provider.refresh();
  });

  context.subscriptions.push(treeView, diagnosticsSub, provider);
}
