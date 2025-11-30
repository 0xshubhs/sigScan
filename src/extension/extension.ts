import * as vscode from 'vscode';
import { SigScanManager } from './manager';
import { SignatureTreeProvider } from './providers/treeProvider';

let sigScanManager: SigScanManager;
let signatureTreeProvider: SignatureTreeProvider;

import { RealtimeAnalyzer } from '../features/realtime';

let realtimeAnalyzer: RealtimeAnalyzer;
let complexityDecorationType: vscode.TextEditorDecorationType;
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  console.log('SigScan extension is now active!');

  // Initialize manager
  sigScanManager = new SigScanManager(context);
  signatureTreeProvider = new SignatureTreeProvider(sigScanManager);

  // Initialize real-time analyzer
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('sigscan');
  realtimeAnalyzer = new RealtimeAnalyzer(diagnosticCollection);

  // Create decoration type for complexity hints only
  complexityDecorationType = vscode.window.createTextEditorDecorationType({});

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(flame) Gas Analysis';
  statusBarItem.tooltip = 'SigScan: Real-time gas analysis active';
  statusBarItem.command = 'sigscan.toggleRealtimeAnalysis';
  const initialConfig = vscode.workspace.getConfiguration('sigscan');
  if (initialConfig.get('realtimeAnalysis', true)) {
    statusBarItem.show();
  }

  // Register tree view
  const treeView = vscode.window.createTreeView('sigScanExplorer', {
    treeDataProvider: signatureTreeProvider,
    showCollapseAll: true,
  });

  // Register commands
  const commands = [
    vscode.commands.registerCommand('sigscan.scanProject', () => {
      sigScanManager.scanProject();
    }),

    vscode.commands.registerCommand('sigscan.startWatching', () => {
      sigScanManager.startWatching();
      vscode.window.showInformationMessage('SigScan: Started watching for file changes');
    }),

    vscode.commands.registerCommand('sigscan.stopWatching', () => {
      sigScanManager.stopWatching();
      vscode.window.showInformationMessage('SigScan: Stopped watching for file changes');
    }),

    vscode.commands.registerCommand('sigscan.exportSignatures', async () => {
      await sigScanManager.exportSignatures();
    }),

    vscode.commands.registerCommand('sigscan.refreshSignatures', () => {
      sigScanManager.refreshSignatures();
      signatureTreeProvider.refresh();
    }),

    vscode.commands.registerCommand('sigscan.copySignature', (signature: string) => {
      vscode.env.clipboard.writeText(signature);
      vscode.window.showInformationMessage(`Copied: ${signature}`);
    }),

    vscode.commands.registerCommand('sigscan.copySelector', (selector: string) => {
      vscode.env.clipboard.writeText(selector);
      vscode.window.showInformationMessage(`Copied: ${selector}`);
    }),

    vscode.commands.registerCommand('sigscan.generateABI', async () => {
      await sigScanManager.generateABI();
    }),

    vscode.commands.registerCommand('sigscan.estimateGas', async () => {
      await sigScanManager.estimateGas();
    }),

    vscode.commands.registerCommand('sigscan.checkContractSize', async () => {
      await sigScanManager.checkContractSize();
    }),

    vscode.commands.registerCommand('sigscan.analyzeComplexity', async () => {
      await sigScanManager.analyzeComplexity();
    }),

    vscode.commands.registerCommand('sigscan.verifyEtherscan', async () => {
      await sigScanManager.verifyEtherscan();
    }),

    vscode.commands.registerCommand('sigscan.searchDatabase', async () => {
      await sigScanManager.searchDatabase();
    }),

    vscode.commands.registerCommand('sigscan.generateAllReports', async () => {
      await sigScanManager.generateAllReports();
    }),

    vscode.commands.registerCommand('sigscan.toggleRealtimeAnalysis', () => {
      const config = vscode.workspace.getConfiguration('sigscan');
      const enabled = config.get('realtimeAnalysis', true);
      config.update('realtimeAnalysis', !enabled, vscode.ConfigurationTarget.Workspace);
      if (!enabled) {
        statusBarItem.show();
        // Trigger immediate analysis
        if (vscode.window.activeTextEditor) {
          updateDecorations(vscode.window.activeTextEditor);
        }
      } else {
        statusBarItem.hide();
      }
      vscode.window.showInformationMessage(
        `Real-time gas analysis ${!enabled ? 'enabled' : 'disabled'}`
      );
    }),

    vscode.commands.registerCommand('sigscan.showGasAnnotations', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
      }
      if (editor.document.languageId !== 'solidity') {
        vscode.window.showWarningMessage('Not a Solidity file');
        return;
      }
      await updateDecorations(editor);
      vscode.window.showInformationMessage('Gas annotations updated!');
    }),
  ];

  // Register providers
  const hoverProvider = vscode.languages.registerHoverProvider(
    { scheme: 'file', language: 'solidity' },
    {
      provideHover(document, position) {
        return sigScanManager.provideHover(document, position);
      },
    }
  );

  // Helper function to update decorations (now for complexity only, gas uses inlay hints)
  async function updateDecorations(editor: vscode.TextEditor) {
    const config = vscode.workspace.getConfiguration('sigscan');
    if (!config.get('realtimeAnalysis', true)) {
      return;
    }

    if (editor.document.languageId === 'solidity') {
      const analysis = await realtimeAnalyzer.analyzeDocument(editor.document);
      const complexityDecorations = realtimeAnalyzer.createComplexityDecorations(
        analysis,
        editor.document
      );

      editor.setDecorations(complexityDecorationType, complexityDecorations);
    }
  }

  // Register inlay hints provider for gas annotations (non-selectable)
  const gasInlayHintsProvider = vscode.languages.registerInlayHintsProvider(
    { scheme: 'file', language: 'solidity' },
    {
      async provideInlayHints(document: vscode.TextDocument): Promise<vscode.InlayHint[]> {
        const config = vscode.workspace.getConfiguration('sigscan');
        if (!config.get('realtimeAnalysis', true)) {
          return [];
        }

        const analysis = await realtimeAnalyzer.analyzeDocument(document);
        return realtimeAnalyzer.createGasInlayHints(analysis, document);
      },
    }
  );

  // Real-time analysis on text change
  const textChangeDisposable = vscode.workspace.onDidChangeTextDocument(async (event) => {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document === event.document) {
      await updateDecorations(editor);
    }
  });

  // Update decorations when switching editors
  const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
    if (editor) {
      await updateDecorations(editor);
    }
  });

  // Update decorations when opening a document
  const documentOpenDisposable = vscode.workspace.onDidOpenTextDocument(async (document) => {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document === document) {
      await updateDecorations(editor);
    }
  });

  // Trigger initial analysis for currently open editor
  if (vscode.window.activeTextEditor) {
    updateDecorations(vscode.window.activeTextEditor);
  }

  // Real-time hover provider
  const realtimeHoverProvider = vscode.languages.registerHoverProvider(
    { scheme: 'file', language: 'solidity' },
    {
      async provideHover(document, position) {
        const analysis = await realtimeAnalyzer.analyzeDocument(document);
        return realtimeAnalyzer.createHoverInfo(position, analysis, document);
      },
    }
  );

  // Add to context
  context.subscriptions.push(
    treeView,
    hoverProvider,
    realtimeHoverProvider,
    textChangeDisposable,
    editorChangeDisposable,
    documentOpenDisposable,
    diagnosticCollection,
    gasInlayHintsProvider,
    complexityDecorationType,
    statusBarItem,
    ...commands
  );

  // Auto-scan on activation if enabled
  const config = vscode.workspace.getConfiguration('sigscan');
  if (config.get('autoScan', true)) {
    sigScanManager.scanProject();
  }

  // Set context for when clauses
  vscode.commands.executeCommand('setContext', 'sigscan:hasContracts', true);
}

export function deactivate() {
  if (sigScanManager) {
    sigScanManager.dispose();
  }
}
