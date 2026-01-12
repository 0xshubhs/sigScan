import * as vscode from 'vscode';
import { SigScanManager } from './manager';
import { SignatureTreeProvider } from './providers/treeProvider';

let sigScanManager: SigScanManager;
let signatureTreeProvider: SignatureTreeProvider;

import { RealtimeAnalyzer, AnalysisReadyEvent } from '../features/realtime';

// New Remix-style compilation imports
import { compilationService } from '../features/compilation-service';
import { GasDecorationManager } from '../features/gas-decorations';

let realtimeAnalyzer: RealtimeAnalyzer;
let gasDecorationType: vscode.TextEditorDecorationType;
let complexityDecorationType: vscode.TextEditorDecorationType;
let remixGasDecorationType: vscode.TextEditorDecorationType;
let statusBarItem: vscode.StatusBarItem;
let gasDecorationManager: GasDecorationManager;

export function activate(context: vscode.ExtensionContext) {
  console.log('SigScan extension is now active!');

  // Initialize manager
  sigScanManager = new SigScanManager(context);
  signatureTreeProvider = new SignatureTreeProvider(sigScanManager);

  // Initialize real-time analyzer
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('sigscan');
  realtimeAnalyzer = new RealtimeAnalyzer(diagnosticCollection);

  // Initialize Remix-style gas decoration manager
  gasDecorationManager = GasDecorationManager.getInstance(300); // 300ms debounce

  // Create decoration types for gas and complexity hints
  gasDecorationType = vscode.window.createTextEditorDecorationType({});
  complexityDecorationType = vscode.window.createTextEditorDecorationType({});
  remixGasDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
      color: '#6A9955',
      margin: '0 0 0 1em',
    },
  });

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(flame) Gas Analysis';
  statusBarItem.tooltip = 'SigScan: Real-time gas analysis active';
  statusBarItem.command = 'sigscan.toggleRealtimeAnalysis';
  const initialConfig = vscode.workspace.getConfiguration('sigscan');
  if (initialConfig.get('realtimeAnalysis', true)) {
    statusBarItem.show();
  }

  // Listen for Remix-style compilation events
  compilationService.on('compilation:start', ({ uri, version }) => {
    console.log(`🔄 Compiling ${uri} with solc ${version}...`);
    statusBarItem.text = '$(sync~spin) Compiling...';
  });

  compilationService.on('compilation:success', ({ uri, output }) => {
    console.log(`✅ Compilation successful: ${output.gasInfo.length} functions analyzed`);
    statusBarItem.text = '$(flame) Gas Analysis';

    // Update decorations for the active editor
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri);
    if (editor && output.gasInfo.length > 0) {
      const decorations = realtimeAnalyzer.createRemixStyleDecorations(
        output.gasInfo,
        editor.document
      );
      editor.setDecorations(gasDecorationType, decorations);
    }
  });

  compilationService.on('compilation:error', ({ errors }) => {
    console.error(`❌ Compilation failed: ${errors[0]}`);
    statusBarItem.text = '$(flame) Gas Analysis';
  });

  compilationService.on('version:downloading', ({ version }) => {
    statusBarItem.text = `$(cloud-download) Downloading solc ${version}...`;
    vscode.window.setStatusBarMessage(`Downloading Solidity compiler ${version}...`, 5000);
  });

  compilationService.on('version:ready', ({ version }) => {
    statusBarItem.text = '$(flame) Gas Analysis';
    vscode.window.setStatusBarMessage(`Solidity compiler ${version} ready`, 3000);
  });

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

  // Register combined hover provider (uses cached analysis to prevent flickering)
  const hoverProvider = vscode.languages.registerHoverProvider(
    { scheme: 'file', language: 'solidity' },
    {
      provideHover(document, position) {
        // First try cached realtime analysis (doesn't trigger new analysis)
        const cachedAnalysis = realtimeAnalyzer.getCachedAnalysis(document);
        if (cachedAnalysis) {
          const realtimeHover = realtimeAnalyzer.createHoverInfo(
            position,
            cachedAnalysis,
            document
          );
          if (realtimeHover) {
            return realtimeHover;
          }
        }
        // Fall back to signature manager hover
        return sigScanManager.provideHover(document, position);
      },
    }
  );

  // Helper function to update decorations with colored gas hints
  // NEVER clears decorations unless we have new ones to show
  async function updateDecorations(editor: vscode.TextEditor, isFileOpenEvent = false) {
    const config = vscode.workspace.getConfiguration('sigscan');
    if (!config.get('realtimeAnalysis', true)) {
      return;
    }

    if (editor.document.languageId === 'solidity') {
      // Use appropriate analysis method based on event type
      const analysis = isFileOpenEvent
        ? await realtimeAnalyzer.analyzeDocumentOnOpen(editor.document)
        : await realtimeAnalyzer.analyzeDocumentOnChange(editor.document);

      // CRITICAL: Don't clear decorations if we have no new data
      if (analysis.gasEstimates.size === 0) {
        console.log('No gas estimates yet, keeping existing decorations');
        return;
      }

      const gasDecorations = realtimeAnalyzer.createGasDecorations(analysis, editor.document);
      const complexityDecorations = realtimeAnalyzer.createComplexityDecorations(
        analysis,
        editor.document
      );

      editor.setDecorations(gasDecorationType, gasDecorations);
      editor.setDecorations(complexityDecorationType, complexityDecorations);
    }
  }

  // Gas annotations now use colored decorations (gradient from green to red)

  // Listen for background solc analysis completion - update decorations when ready
  realtimeAnalyzer.on('analysisReady', (event: AnalysisReadyEvent) => {
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === event.uri
    );
    if (editor && editor.document.languageId === 'solidity') {
      // CRITICAL: Don't clear decorations if we have no new data
      if (event.analysis.gasEstimates.size === 0) {
        console.log('Solc returned empty results, keeping existing decorations');
        return;
      }

      const gasDecorations = realtimeAnalyzer.createGasDecorations(event.analysis, editor.document);
      const complexityDecorations = realtimeAnalyzer.createComplexityDecorations(
        event.analysis,
        editor.document
      );
      editor.setDecorations(gasDecorationType, gasDecorations);
      editor.setDecorations(complexityDecorationType, complexityDecorations);
      console.log('✨ Updated decorations with accurate solc analysis');
    }
  });

  // Real-time analysis on text change
  const textChangeDisposable = vscode.workspace.onDidChangeTextDocument(async (event) => {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document === event.document) {
      await updateDecorations(editor);
    }
  });

  // Update decorations when switching editors (treat as file open for immediate response)
  const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
    if (editor) {
      await updateDecorations(editor, true); // true = treat as file open
    }
  });

  // Update decorations when opening a document
  const documentOpenDisposable = vscode.workspace.onDidOpenTextDocument(async (document) => {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document === document) {
      await updateDecorations(editor, true); // true = file open event
    }
  });

  // Trigger initial analysis for currently open editor (treat as file open)
  if (vscode.window.activeTextEditor) {
    updateDecorations(vscode.window.activeTextEditor, true);
  }

  // Extended analysis commands (on-demand only, runs when idle - never parallel with solc)
  const storageLayoutCommand = vscode.commands.registerCommand(
    'sigscan.showStorageLayout',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'solidity') {
        vscode.window.showErrorMessage('Open a Solidity file to analyze storage layout');
        return;
      }

      // Check if heavy analysis is running
      if (realtimeAnalyzer.isAnalysisInProgress()) {
        vscode.window.showWarningMessage('Analysis in progress, please wait...');
        return;
      }

      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Analyzing storage layout...',
          cancellable: false,
        },
        async () => {
          const layout = await realtimeAnalyzer.analyzeStorageLayout(editor.document);
          const analyzers = realtimeAnalyzer.getExtendedAnalyzers();
          const report = analyzers.storage.generateReport(layout, editor.document.fileName);

          const doc = await vscode.workspace.openTextDocument({
            content: report,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        }
      );
    }
  );

  const callGraphCommand = vscode.commands.registerCommand('sigscan.showCallGraph', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'solidity') {
      vscode.window.showErrorMessage('Open a Solidity file to analyze call graph');
      return;
    }

    if (realtimeAnalyzer.isAnalysisInProgress()) {
      vscode.window.showWarningMessage('Analysis in progress, please wait...');
      return;
    }

    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Building call graph...',
        cancellable: false,
      },
      async () => {
        const callGraph = await realtimeAnalyzer.analyzeCallGraph(editor.document);
        const analyzers = realtimeAnalyzer.getExtendedAnalyzers();
        const report = analyzers.callGraph.generateReport(callGraph, editor.document.fileName);

        const doc = await vscode.workspace.openTextDocument({
          content: report,
          language: 'markdown',
        });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      }
    );
  });

  const deploymentCostCommand = vscode.commands.registerCommand(
    'sigscan.showDeploymentCost',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'solidity') {
        vscode.window.showErrorMessage('Open a Solidity file to estimate deployment cost');
        return;
      }

      if (realtimeAnalyzer.isAnalysisInProgress()) {
        vscode.window.showWarningMessage('Analysis in progress, please wait...');
        return;
      }

      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Estimating deployment cost...',
          cancellable: false,
        },
        async () => {
          const cost = await realtimeAnalyzer.estimateDeploymentCost(editor.document);
          const analyzers = realtimeAnalyzer.getExtendedAnalyzers();

          const analysis = {
            contracts: [cost],
            totalGas: cost.deploymentGas.total,
            totalCost: cost.costInEth,
            largestContract: cost.contractName,
            recommendations: [],
          };
          const report = analyzers.deployment.generateReport(analysis);

          const doc = await vscode.workspace.openTextDocument({
            content: report,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        }
      );
    }
  );

  const regressionCommand = vscode.commands.registerCommand(
    'sigscan.compareWithBranch',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'solidity') {
        vscode.window.showErrorMessage('Open a Solidity file to compare gas usage');
        return;
      }

      if (realtimeAnalyzer.isAnalysisInProgress()) {
        vscode.window.showWarningMessage('Analysis in progress, please wait...');
        return;
      }

      const branch = await vscode.window.showInputBox({
        prompt: 'Enter branch/commit to compare with',
        value: 'main',
      });

      if (!branch) {
        return;
      }

      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Comparing gas usage...',
          cancellable: false,
        },
        async () => {
          const regressionReport = await realtimeAnalyzer.compareWithBranch(
            editor.document,
            branch
          );

          if (!regressionReport) {
            vscode.window.showErrorMessage('Not a git repository or no data available');
            return;
          }

          const analyzers = realtimeAnalyzer.getExtendedAnalyzers();
          const report = analyzers.regression.generateReport(regressionReport);

          const doc = await vscode.workspace.openTextDocument({
            content: report,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        }
      );
    }
  );

  const profilerCommand = vscode.commands.registerCommand(
    'sigscan.showProfilerReport',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'solidity') {
        vscode.window.showErrorMessage('Open a Solidity file to see profiler report');
        return;
      }

      if (realtimeAnalyzer.isAnalysisInProgress()) {
        vscode.window.showWarningMessage('Analysis in progress, please wait...');
        return;
      }

      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Loading profiler data...',
          cancellable: false,
        },
        async () => {
          const profilerReport = await realtimeAnalyzer.getProfilerReport(editor.document);

          if (!profilerReport) {
            vscode.window.showInformationMessage(
              'No forge test data found. Run `forge test --gas-report` first.'
            );
            return;
          }

          const analyzers = realtimeAnalyzer.getExtendedAnalyzers();
          const report = analyzers.profiler.generateReport(profilerReport);

          const doc = await vscode.workspace.openTextDocument({
            content: report,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        }
      );
    }
  );

  // Add to context
  context.subscriptions.push(
    treeView,
    hoverProvider,
    textChangeDisposable,
    editorChangeDisposable,
    documentOpenDisposable,
    diagnosticCollection,
    gasDecorationType,
    complexityDecorationType,
    remixGasDecorationType,
    statusBarItem,
    storageLayoutCommand,
    callGraphCommand,
    deploymentCostCommand,
    regressionCommand,
    profilerCommand,
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
  if (realtimeAnalyzer) {
    realtimeAnalyzer.dispose();
  }
  if (gasDecorationManager) {
    gasDecorationManager.dispose();
  }
  compilationService.dispose();
}
