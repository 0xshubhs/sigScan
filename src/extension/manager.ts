import * as vscode from 'vscode';
import * as path from 'path';
import { ProjectScanner } from '../core/scanner';
import { SignatureExporter } from '../core/exporter';
import { FileWatcher } from '../core/watcher';
import { ScanResult, ExportOptions } from '../types';

export class SigScanManager {
  private scanner: ProjectScanner;
  private exporter: SignatureExporter;
  private watcher: FileWatcher;
  private context: vscode.ExtensionContext;
  private lastScanResult: ScanResult | null = null;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.scanner = new ProjectScanner();
    this.exporter = new SignatureExporter();
    this.watcher = new FileWatcher();

    this.setupWatcherEvents();
  }

  /**
   * Scan the current workspace for contracts
   */
  public async scanProject(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('No workspace folder found');
      return;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;

    try {
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Scanning contracts...',
          cancellable: false,
        },
        async (progress) => {
          progress.report({ increment: 0, message: 'Initializing scan...' });

          this.lastScanResult = await this.scanner.scanProject(rootPath);

          if (this.lastScanResult.totalContracts === 0) {
            vscode.window.showWarningMessage('No Solidity contracts found in the workspace.');
            return;
          }

          progress.report({ increment: 50, message: 'Exporting signatures...' });

          // Auto-export signatures after scanning
          await this.autoExportSignatures();

          progress.report({ increment: 100, message: 'Scan completed' });

          vscode.window.showInformationMessage(
            `Scan completed: ${this.lastScanResult.totalContracts} contracts, ${this.lastScanResult.totalFunctions} functions. Signatures saved to 'signatures' folder.`
          );

          // Auto-start watching if configured
          const config = vscode.workspace.getConfiguration('sigscan');
          if (config.get('autoScan', true)) {
            this.startWatching();
          }
        }
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Error scanning project: ${errorMessage}`);
    }
  }

  /**
   * Start watching for file changes
   */
  public startWatching(): void {
    if (!this.lastScanResult) {
      vscode.window.showWarningMessage('Please scan the project first');
      return;
    }

    this.watcher.startWatching(this.lastScanResult.projectInfo);
  }

  /**
   * Stop watching for file changes
   */
  public stopWatching(): void {
    this.watcher.stopWatching();
  }

  /**
   * Auto-export signatures with default settings
   */
  private async autoExportSignatures(): Promise<void> {
    if (!this.lastScanResult) {
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return;
    }

    const config = vscode.workspace.getConfiguration('sigscan');
    const formats = config.get('outputFormats', ['txt', 'json']) as string[];
    const includeInternal = !config.get('excludeInternal', true);
    const includePrivate = config.get('includePrivate', false) as boolean;

    // Use the project root path from scan result (where foundry.toml or hardhat.config.js exists)
    const outputDir = path.join(this.lastScanResult.projectInfo.rootPath, 'signatures');

    const exportOptions: ExportOptions = {
      formats: formats as any,
      outputDir,
      includeInternal,
      includePrivate,
      includeEvents: true,
      includeErrors: true,
      separateByCategory: true,
      updateExisting: true,
      deduplicateSignatures: true,
    };

    try {
      await this.exporter.exportSignatures(this.lastScanResult, exportOptions);
    } catch (error) {
      console.error('Auto-export error:', error);
    }
  }

  /**
   * Export signatures to files
   */
  public async exportSignatures(): Promise<void> {
    if (!this.lastScanResult) {
      vscode.window.showWarningMessage('Please scan the project first');
      return;
    }

    if (this.lastScanResult.totalContracts === 0) {
      vscode.window.showWarningMessage('No Solidity contracts found in the workspace.');
      return;
    }

    const config = vscode.workspace.getConfiguration('sigscan');
    const formats = config.get<string[]>('outputFormats', ['txt', 'json']);
    const includeInternal = !config.get<boolean>('excludeInternal', true);
    const includePrivate = !config.get<boolean>('excludePrivate', true);

    // Use the project root path from scan result (where foundry.toml or hardhat.config.js exists)
    const outputDir = path.join(this.lastScanResult.projectInfo.rootPath, 'signatures');

    const exportOptions: ExportOptions = {
      formats: formats as any,
      outputDir,
      includeInternal,
      includePrivate,
      includeEvents: true,
      includeErrors: true,
      separateByCategory: true,
      updateExisting: true,
      deduplicateSignatures: true,
    };

    try {
      await this.exporter.exportSignatures(this.lastScanResult, exportOptions);

      const openFolder = await vscode.window.showInformationMessage(
        'Signatures exported successfully!',
        'Open Folder'
      );

      if (openFolder) {
        vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(outputDir));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Error exporting signatures: ${errorMessage}`);
    }
  }

  /**
   * Refresh signatures (re-scan)
   */
  public async refreshSignatures(): Promise<void> {
    await this.scanProject();
  }

  /**
   * Provide hover information for Solidity functions
   */
  public provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    if (!this.lastScanResult || !document.fileName.endsWith('.sol')) {
      return null;
    }

    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) {
      return null;
    }

    const word = document.getText(wordRange);

    // Find matching function signatures
    const matches: string[] = [];
    this.lastScanResult.projectInfo.contracts.forEach((contract) => {
      contract.functions.forEach((func) => {
        if (func.name === word) {
          matches.push(`**${func.signature}** → \`${func.selector}\``);
        }
      });
    });

    if (matches.length > 0) {
      const content = new vscode.MarkdownString();
      content.appendMarkdown('**Function Signatures:**\n\n');
      content.appendMarkdown(matches.join('\n\n'));
      return new vscode.Hover(content);
    }

    return null;
  }

  /**
   * Get last scan result
   */
  public getLastScanResult(): ScanResult | null {
    return this.lastScanResult;
  }

  /**
   * Setup watcher event handlers
   */
  private setupWatcherEvents(): void {
    this.watcher.on('fileChanged', async (filePath, contractInfo) => {
      if (contractInfo && this.lastScanResult) {
        this.lastScanResult.projectInfo.contracts.set(filePath, contractInfo);
        vscode.window.showInformationMessage(`Contract updated: ${path.basename(filePath)}`);

        // Auto-update signatures when file changes
        await this.autoExportSignatures();
      }
    });

    this.watcher.on('fileAdded', async (filePath, contractInfo) => {
      if (contractInfo && this.lastScanResult) {
        this.lastScanResult.projectInfo.contracts.set(filePath, contractInfo);
        vscode.window.showInformationMessage(`New contract detected: ${path.basename(filePath)}`);

        // Auto-update signatures when file is added
        await this.autoExportSignatures();
      }
    });

    this.watcher.on('fileRemoved', async (filePath) => {
      if (this.lastScanResult) {
        this.lastScanResult.projectInfo.contracts.delete(filePath);
        vscode.window.showInformationMessage(`Contract removed: ${path.basename(filePath)}`);

        // Auto-update signatures when file is removed
        await this.autoExportSignatures();
      }
    });

    this.watcher.on('error', (error) => {
      vscode.window.showErrorMessage(`File watcher error: ${error.message}`);
    });
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.watcher.stopWatching();
  }
}
