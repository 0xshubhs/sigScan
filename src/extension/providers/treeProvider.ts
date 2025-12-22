import * as vscode from 'vscode';
import * as path from 'path';
import { SigScanManager } from '../manager';

export class SignatureTreeProvider implements vscode.TreeDataProvider<SignatureTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<SignatureTreeItem | undefined | null | void> =
    new vscode.EventEmitter<SignatureTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<SignatureTreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  constructor(private manager: SigScanManager) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
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
      // Return function categories for a contract
      const contract = Array.from(scanResult.projectInfo.contracts.values()).find(
        (c) => c.name === element.label
      );

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
            contract
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
            contract
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
            contract
          )
        );
      }

      return Promise.resolve(items);
    }

    if (element.type === 'functions' && element.contract) {
      // Return individual functions
      const functions = element.contract.functions.map(
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

    if (element.type === 'events' && element.contract) {
      // Return individual events
      const events = element.contract.events.map(
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

    if (element.type === 'errors' && element.contract) {
      // Return individual errors
      const errors = element.contract.errors.map(
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
    public readonly contract?: any,
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
