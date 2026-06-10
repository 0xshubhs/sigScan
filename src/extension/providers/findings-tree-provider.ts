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

/** Sort rank for a severity — lower sorts first (Error before Hint). */
function severityRank(severity: vscode.DiagnosticSeverity | undefined): number {
  return severity ?? 4;
}

/** Human label for a severity, used in the per-file breakdown tooltip. */
function severityLabel(severity: vscode.DiagnosticSeverity | undefined): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'errors';
    case vscode.DiagnosticSeverity.Warning:
      return 'warnings';
    case vscode.DiagnosticSeverity.Information:
      return 'info';
    default:
      return 'hints';
  }
}

/** Builds a "2 warnings, 1 info" style breakdown for a file's findings. */
function severityBreakdown(diagnostics: vscode.Diagnostic[]): string {
  const counts = new Map<string, number>();
  for (const d of diagnostics) {
    const key = severityLabel(d.severity);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return ['errors', 'warnings', 'info', 'hints']
    .filter((k) => counts.has(k))
    .map((k) => `${counts.get(k)} ${k}`)
    .join(', ');
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
      const breakdown = severityBreakdown(element.diagnostics);
      item.tooltip = `${element.uri.fsPath} — ${count} finding${count === 1 ? '' : 's'}${
        breakdown ? ` (${breakdown})` : ''
      }`;
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
      // Most severe first, then by position so a file's worst issues lead.
      findings.sort((a, b) => {
        const bySeverity = severityRank(a.severity) - severityRank(b.severity);
        return bySeverity !== 0 ? bySeverity : a.range.start.compareTo(b.range.start);
      });
      files.push({ kind: 'file', uri, diagnostics: findings });
    }

    // Return nothing when clean so the view's `viewsWelcome` onboarding (scan /
    // browse commands / open walkthrough) renders instead of a dead placeholder.
    if (files.length === 0) {
      return [];
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

  // Debounce refreshes: a single user edit can fan out into many diagnostic
  // change events, and each refresh re-scans + re-sorts ALL workspace
  // diagnostics in rootNodes(). Coalesce them into one refresh.
  const REFRESH_DEBOUNCE_MS = 250;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = (): void => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      provider.refresh();
    }, REFRESH_DEBOUNCE_MS);
  };

  // Track which Uris currently contribute findings so we still refresh when the
  // last 0xTools diagnostic is *cleared* from a file (the new diagnostic list no
  // longer matches FINDINGS_SOURCE, but the tree must drop that file group).
  const urisWithFindings = new Set<string>();

  const diagnosticsSub = vscode.languages.onDidChangeDiagnostics((e) => {
    // Skip refreshes triggered purely by other diagnostic sources (compiler
    // errors, linters, etc.). Only refresh if an affected Uri now has — or
    // previously had — a diagnostic from this view's source.
    let affectsFindings = false;
    for (const uri of e.uris) {
      const key = uri.toString();
      const hasFindings = vscode.languages
        .getDiagnostics(uri)
        .some((d) => d.source === FINDINGS_SOURCE);
      if (hasFindings) {
        if (!urisWithFindings.has(key)) {
          urisWithFindings.add(key);
        }
        affectsFindings = true;
      } else if (urisWithFindings.delete(key)) {
        // Last finding for this file was cleared — the tree must update.
        affectsFindings = true;
      }
    }
    if (!affectsFindings) {
      return;
    }
    scheduleRefresh();
  });

  const refreshDisposable = new vscode.Disposable(() => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
  });

  context.subscriptions.push(treeView, diagnosticsSub, refreshDisposable, provider);
}
