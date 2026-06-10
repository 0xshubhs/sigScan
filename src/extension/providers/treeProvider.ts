import * as vscode from 'vscode';
import { SigScanManager } from '../manager';
import { ContractInfo, ScanResult } from '../../types';

export class SignatureTreeProvider
  implements vscode.TreeDataProvider<SignatureTreeItem>, vscode.Disposable
{
  private _onDidChangeTreeData: vscode.EventEmitter<SignatureTreeItem | undefined | null | void> =
    new vscode.EventEmitter<SignatureTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<SignatureTreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  /**
   * Cached name -> ContractInfo index for the current scan result, built lazily
   * so expanding a contract node is O(1) instead of an O(n) linear scan. The
   * `for...of` build order matches the previous `Array#find` semantics: the
   * FIRST contract with a given name wins when duplicates exist.
   */
  private contractsByName: Map<string, ContractInfo> | null = null;
  private indexedScanResult: ScanResult | null = null;

  constructor(private manager: SigScanManager) {}

  refresh(): void {
    // Invalidate the cached name index; the next lookup rebuilds it.
    this.contractsByName = null;
    this.indexedScanResult = null;
    this._onDidChangeTreeData.fire();
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }

  /**
   * Return (building if necessary) the name -> ContractInfo index for the given
   * scan result. Rebuilt if the scan result identity changed since last call so
   * the cache can't go stale even without an explicit refresh().
   */
  private getContractsByName(scanResult: ScanResult): Map<string, ContractInfo> {
    if (this.contractsByName && this.indexedScanResult === scanResult) {
      return this.contractsByName;
    }
    const index = new Map<string, ContractInfo>();
    scanResult.projectInfo.contracts.forEach((contract) => {
      // First-seen wins, matching the prior Array#find behavior on duplicates.
      if (!index.has(contract.name)) {
        index.set(contract.name, contract);
      }
    });
    this.contractsByName = index;
    this.indexedScanResult = scanResult;
    return index;
  }

  getTreeItem(element: SignatureTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SignatureTreeItem): Thenable<SignatureTreeItem[]> {
    const scanResult = this.manager.getLastScanResult();

    if (!scanResult) {
      return Promise.resolve([]);
    }

    if (!element) {
      // Return contract nodes
      const contracts: SignatureTreeItem[] = [];
      scanResult.projectInfo.contracts.forEach((contract) => {
        contracts.push(
          new SignatureTreeItem(
            contract.name,
            vscode.TreeItemCollapsibleState.Collapsed,
            'contract',
            contract.filePath,
            `${contract.functions.length} functions, ${contract.events.length} events`
          )
        );
      });
      return Promise.resolve(contracts);
    }

    if (element.type === 'contract') {
      // Return function categories for a contract (O(1) name lookup).
      const contract = this.getContractsByName(scanResult).get(element.label);

      if (!contract) {
        return Promise.resolve([]);
      }

      const items: SignatureTreeItem[] = [];

      if (contract.functions.length > 0) {
        items.push(
          new SignatureTreeItem(
            `Functions (${contract.functions.length})`,
            vscode.TreeItemCollapsibleState.Collapsed,
            'functions',
            element.filePath,
            undefined,
            contract.functions
          )
        );
      }

      if (contract.events.length > 0) {
        items.push(
          new SignatureTreeItem(
            `Events (${contract.events.length})`,
            vscode.TreeItemCollapsibleState.Collapsed,
            'events',
            element.filePath,
            undefined,
            contract.events
          )
        );
      }

      if (contract.errors.length > 0) {
        items.push(
          new SignatureTreeItem(
            `Errors (${contract.errors.length})`,
            vscode.TreeItemCollapsibleState.Collapsed,
            'errors',
            element.filePath,
            undefined,
            contract.errors
          )
        );
      }

      return Promise.resolve(items);
    }

    if (element.type === 'functions' && element.items) {
      const functions = element.items.map(
        (func: any) =>
          new SignatureTreeItem(
            func.name,
            vscode.TreeItemCollapsibleState.None,
            'function',
            element.filePath,
            `${func.signature} → ${func.selector}`,
            undefined,
            func
          )
      );
      return Promise.resolve(functions);
    }

    if (element.type === 'events' && element.items) {
      const events = element.items.map(
        (event: any) =>
          new SignatureTreeItem(
            event.name,
            vscode.TreeItemCollapsibleState.None,
            'event',
            element.filePath,
            `${event.signature} → ${event.selector}`,
            undefined,
            undefined,
            event
          )
      );
      return Promise.resolve(events);
    }

    if (element.type === 'errors' && element.items) {
      const errors = element.items.map(
        (error: any) =>
          new SignatureTreeItem(
            error.name,
            vscode.TreeItemCollapsibleState.None,
            'error',
            element.filePath,
            `${error.signature} → ${error.selector}`,
            undefined,
            undefined,
            undefined,
            error
          )
      );
      return Promise.resolve(errors);
    }

    return Promise.resolve([]);
  }
}

export class SignatureTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly type: string,
    public readonly filePath?: string,
    public readonly description?: string,
    public readonly items?: any[],
    public readonly functionSig?: any,
    public readonly eventSig?: any,
    public readonly errorSig?: any
  ) {
    super(label, collapsibleState);

    this.tooltip = this.description || this.label;
    this.description = description;

    // Set context values for menus
    if (type === 'function' || type === 'event' || type === 'error') {
      this.contextValue = 'signature';

      // Add command to copy signature
      this.command = {
        command: 'sigscan.copySignature',
        title: 'Copy Signature',
        arguments: [this.getSignature()],
      };
    }

    // Set icons
    switch (type) {
      case 'contract':
        this.iconPath = new vscode.ThemeIcon('file-code');
        break;
      case 'functions':
        this.iconPath = new vscode.ThemeIcon('symbol-method');
        break;
      case 'events':
        this.iconPath = new vscode.ThemeIcon('bell');
        break;
      case 'errors':
        this.iconPath = new vscode.ThemeIcon('error');
        break;
      case 'function':
        this.iconPath = new vscode.ThemeIcon('symbol-function');
        break;
      case 'event':
        this.iconPath = new vscode.ThemeIcon('symbol-event');
        break;
      case 'error':
        this.iconPath = new vscode.ThemeIcon('warning');
        break;
    }
  }

  private getSignature(): string {
    if (this.functionSig) {
      return this.functionSig.signature;
    }
    if (this.eventSig) {
      return this.eventSig.signature;
    }
    if (this.errorSig) {
      return this.errorSig.signature;
    }
    return '';
  }
}
