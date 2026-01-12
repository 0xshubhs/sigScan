/**
 * Real-time Analysis - Live gas profiling and diagnostics during code editing
 * Solc-only model: Shows signatures immediately, gas estimates when solc completes
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { GasEstimator, GasEstimate } from './gas';
import { ContractSizeAnalyzer, ContractSizeInfo } from './size';
import { ComplexityAnalyzer, ComplexityMetrics } from './complexity';
import { SolidityParser } from '../core/parser';
import { StorageLayoutAnalyzer, StorageLayout } from './storage-layout';
import { CallGraphAnalyzer, CallGraph } from './call-graph';
import { DeploymentCostEstimator, DeploymentCost } from './deployment';
import { GasRegressionTracker, RegressionReport } from './regression';
import { RuntimeProfiler, ProfilerReport } from './profiler';

export interface LiveAnalysis {
  gasEstimates: Map<string, GasEstimate>;
  sizeInfo: ContractSizeInfo | null;
  complexityMetrics: Map<string, ComplexityMetrics>;
  diagnostics: vscode.Diagnostic[];
  isPending?: boolean; // True if solc hasn't completed yet (showing signatures only)
  // Extended analysis (computed on-demand for performance)
  storageLayout?: StorageLayout;
  callGraph?: CallGraph;
  deploymentCost?: DeploymentCost;
  regressionReport?: RegressionReport;
  profilerReport?: ProfilerReport;
}

// Event emitted when solc analysis completes
export interface AnalysisReadyEvent {
  uri: string;
  analysis: LiveAnalysis;
}

export class RealtimeAnalyzer extends EventEmitter {
  private solcGasEstimator: GasEstimator; // Accurate, solc-based
  private sizeAnalyzer: ContractSizeAnalyzer;
  private complexityAnalyzer: ComplexityAnalyzer;
  private parser: SolidityParser;
  private diagnosticCollection: vscode.DiagnosticCollection;
  private analysisCache: Map<string, { timestamp: number; analysis: LiveAnalysis }>;
  private solcResultsCache: Map<string, LiveAnalysis>; // Hash-based cache for solc results
  private signatureCache: Map<string, LiveAnalysis>; // Signature-only cache (no gas)
  private idleTimers: Map<string, NodeJS.Timeout>; // Per-document idle timers
  private activeSolcCompilations: Map<string, boolean>; // Track active compilations to cancel
  private analysisInProgress = false; // Global flag to prevent parallel heavy operations
  private extendedAnalysisInProgress = false; // Track extended analysis

  // Resource thresholds for automatic extended analysis
  private readonly MEMORY_THRESHOLD_MB = 500; // Run extended analysis only if using < 500MB
  private readonly CPU_THRESHOLD_PERCENT = 50; // Run if CPU usage < 50%

  // Extended analyzers (lazy-loaded for performance)
  private storageAnalyzer: StorageLayoutAnalyzer;
  private callGraphAnalyzer: CallGraphAnalyzer;
  private deploymentAnalyzer: DeploymentCostEstimator;
  private regressionTracker: GasRegressionTracker;
  private runtimeProfiler: RuntimeProfiler;

  constructor(diagnosticCollection: vscode.DiagnosticCollection) {
    super(); // Initialize EventEmitter
    // Solc estimator (accurate, the ONLY estimator)
    this.solcGasEstimator = new GasEstimator(true);
    this.sizeAnalyzer = new ContractSizeAnalyzer();
    this.complexityAnalyzer = new ComplexityAnalyzer();
    this.parser = new SolidityParser();
    this.diagnosticCollection = diagnosticCollection;
    this.analysisCache = new Map();
    this.solcResultsCache = new Map();
    this.signatureCache = new Map();
    this.idleTimers = new Map();
    this.activeSolcCompilations = new Map();

    // Extended analyzers (lightweight initialization)
    this.storageAnalyzer = new StorageLayoutAnalyzer();
    this.callGraphAnalyzer = new CallGraphAnalyzer();
    this.deploymentAnalyzer = new DeploymentCostEstimator();
    this.regressionTracker = new GasRegressionTracker();
    this.runtimeProfiler = new RuntimeProfiler();
  }

  /**
   * Analyze document on file open - returns signatures immediately, runs solc in background
   */
  public async analyzeDocumentOnOpen(document: vscode.TextDocument): Promise<LiveAnalysis> {
    const content = document.getText();
    const uri = document.uri.toString();
    const contentHash = this.hashContent(content);

    // Clear old cache for this file
    this.analysisCache.delete(uri);

    // Check if we have cached solc results (from previous compilation)
    const solcCached = this.solcResultsCache.get(contentHash);
    if (solcCached && !solcCached.isPending) {
      return solcCached;
    }

    // Return immediate signature-only analysis (no gas yet)
    const signatureAnalysis = this.createSignatureOnlyAnalysis(document, contentHash);

    // Start solc compilation IMMEDIATELY in background (non-blocking)
    setImmediate(() => {
      this.runSolcAnalysis(document, contentHash).catch((err) => {
        console.error('Background solc compilation failed:', err);
      });
    });

    return signatureAnalysis;
  }

  /**
   * Analyze document on change - returns cached results or signatures, schedules solc
   */
  public async analyzeDocumentOnChange(document: vscode.TextDocument): Promise<LiveAnalysis> {
    const content = document.getText();
    const contentHash = this.hashContent(content);

    // Check if we have cached solc results
    const solcCached = this.solcResultsCache.get(contentHash);
    if (solcCached && !solcCached.isPending) {
      return solcCached;
    }

    // Return signature-only analysis
    const signatureAnalysis = this.createSignatureOnlyAnalysis(document, contentHash);

    // Schedule solc analysis after idle timeout
    this.scheduleIdleSolcAnalysis(document, contentHash);

    return signatureAnalysis;
  }

  /**
   * Get cached analysis without triggering new analysis - for hover provider
   * Returns null if no cached analysis exists
   */
  public getCachedAnalysis(document: vscode.TextDocument): LiveAnalysis | null {
    const content = document.getText();
    const contentHash = this.hashContent(content);

    // Check solc cache first (has gas data)
    const solcCached = this.solcResultsCache.get(contentHash);
    if (solcCached && !solcCached.isPending) {
      return solcCached;
    }

    // Fall back to signature cache (no gas, but has selectors)
    const sigCached = this.signatureCache.get(contentHash);
    if (sigCached) {
      return sigCached;
    }

    return null;
  }

  /**
   * Create signature-only analysis (instant, no solc needed)
   * Shows function signatures and selectors immediately
   */
  private createSignatureOnlyAnalysis(
    document: vscode.TextDocument,
    contentHash: string
  ): LiveAnalysis {
    // Check signature cache first
    const cached = this.signatureCache.get(contentHash);
    if (cached) {
      return cached;
    }

    const content = document.getText();
    const contractInfo = this.parser.parseContent(content, document.uri.fsPath);

    if (!contractInfo) {
      return this.createEmptyAnalysis(true);
    }

    const gasEstimates = new Map<string, GasEstimate>();

    // Create signature-only estimates (no gas yet - use 0 as placeholder)
    for (const func of contractInfo.functions) {
      const estimate: GasEstimate = {
        function: func.name,
        signature: func.signature,
        selector: func.selector,
        estimatedGas: { min: 0, max: 0, average: 0 },
        complexity: 'low',
        factors: ['Waiting for solc...'],
        source: 'heuristic',
      };
      gasEstimates.set(func.name, estimate);
    }

    const analysis: LiveAnalysis = {
      gasEstimates,
      sizeInfo: null,
      complexityMetrics: new Map(),
      diagnostics: [],
      isPending: true,
    };

    // Cache signature results
    this.signatureCache.set(contentHash, analysis);

    return analysis;
  }

  /**
   * Schedule solc analysis - deprecated, use scheduleIdleSolcAnalysis
   * @deprecated Use scheduleIdleSolcAnalysis instead for proper debouncing
   */
  private scheduleBackgroundSolcAnalysis(document: vscode.TextDocument, contentHash: string): void {
    this.scheduleIdleSolcAnalysis(document, contentHash);
  }

  /**
   * Run solc analysis in background - deprecated wrapper
   */
  private async runSolcAnalysisBackground(
    document: vscode.TextDocument,
    contentHash: string
  ): Promise<void> {
    await this.runSolcAnalysis(document, contentHash);
  }

  /**
   * Analyze document using solc only
   * @deprecated Use analyzeDocumentOnOpen or analyzeDocumentOnChange
   */
  public async analyzeDocument(document: vscode.TextDocument): Promise<LiveAnalysis> {
    return this.analyzeDocumentOnChange(document);
  }

  /**
   * Hash document content for cache key
   */
  private hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Schedule solc analysis after idle timeout (resets on each change)
   */
  private scheduleIdleSolcAnalysis(document: vscode.TextDocument, contentHash: string): void {
    const uri = document.uri.toString();
    const config = vscode.workspace.getConfiguration('sigscan');
    const idleMs = config.get<number>('realtime.solcIdleMs', 1000); // 1 second default

    // Cancel previous timer
    const existingTimer = this.idleTimers.get(uri);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Cancel any active compilation for this document
    if (this.activeSolcCompilations.get(uri)) {
      this.activeSolcCompilations.set(uri, false);
    }

    // Schedule new timer
    const timer = setTimeout(async () => {
      if (this.hashContent(document.getText()) === contentHash) {
        await this.runSolcAnalysis(document, contentHash);
      }
    }, idleMs);

    this.idleTimers.set(uri, timer);
  }

  /**
   * Run solc analysis immediately (for file open)
   */
  private async runSolcAnalysisImmediate(
    document: vscode.TextDocument,
    contentHash: string
  ): Promise<void> {
    const uri = document.uri.toString();

    // Cancel any existing timer or compilation
    const existingTimer = this.idleTimers.get(uri);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    if (this.activeSolcCompilations.get(uri)) {
      this.activeSolcCompilations.set(uri, false);
    }

    await this.runSolcAnalysis(document, contentHash);
  }

  /**
   * Run solc analysis synchronously and return results (legacy wrapper)
   */
  private async runSolcAnalysisSync(
    document: vscode.TextDocument,
    contentHash: string
  ): Promise<LiveAnalysis> {
    await this.runSolcAnalysis(document, contentHash);
    return this.solcResultsCache.get(contentHash) || this.createEmptyAnalysis();
  }

  /**
   * Check if heavy analysis (solc) is currently running
   */
  public isAnalysisInProgress(): boolean {
    return (
      this.analysisInProgress ||
      Array.from(this.activeSolcCompilations.values()).some((active) => active)
    );
  }

  /**
   * Check if system resources are available for extended analysis
   */
  private async checkResourcesAvailable(): Promise<boolean> {
    try {
      const memUsage = process.memoryUsage();
      const memUsedMB = memUsage.heapUsed / 1024 / 1024;

      // Check if memory usage is below threshold
      if (memUsedMB > this.MEMORY_THRESHOLD_MB) {
        return false;
      }

      // Check if any heavy analysis is running
      if (this.isAnalysisInProgress() || this.extendedAnalysisInProgress) {
        return false;
      }

      return true;
    } catch (error) {
      // If resource check fails, be conservative and don't run
      return false;
    }
  }

  /**
   * Run extended analysis automatically in background if resources available
   */
  private async runExtendedAnalysisIfAvailable(document: vscode.TextDocument): Promise<void> {
    // Don't run if already running or if main analysis is active
    if (this.extendedAnalysisInProgress || !(await this.checkResourcesAvailable())) {
      return;
    }

    this.extendedAnalysisInProgress = true;

    try {
      const content = document.getText();
      const contractName = this.extractContractName(content);

      if (!contractName) {
        return;
      }

      // Run extended features sequentially to avoid resource spike
      // Only run synchronous analyzers automatically (storage, callgraph, deployment)
      // Profiler and regression require external tools and are command-only
      try {
        if (await this.checkResourcesAvailable()) {
          this.storageAnalyzer.analyzeContract(content, contractName);
        }

        await new Promise((resolve) => setTimeout(resolve, 100));

        if (await this.checkResourcesAvailable()) {
          this.callGraphAnalyzer.analyzeContract(content);
        }

        await new Promise((resolve) => setTimeout(resolve, 100));

        if (await this.checkResourcesAvailable()) {
          this.deploymentAnalyzer.estimateContract(content, contractName);
        }
      } catch (error) {
        // Continue even if extended analysis fails
        console.error('Extended analysis feature failed:', error);
      }
    } finally {
      this.extendedAnalysisInProgress = false;
    }
  }

  /**
   * Solc analysis - compiles the contract ONCE and extracts all gas estimates
   * NEVER clears decorations - only updates them when we have new results
   */
  private async runSolcAnalysis(document: vscode.TextDocument, contentHash: string): Promise<void> {
    const uri = document.uri.toString();
    const content = document.getText();

    // Check if already cached with gas results
    const cached = this.solcResultsCache.get(contentHash);
    if (cached && !cached.isPending) {
      return; // Already have solc results
    }

    // Mark as active
    this.activeSolcCompilations.set(uri, true);
    this.analysisInProgress = true;

    try {
      // Parse contract using in-memory content
      const contractInfo = this.parser.parseContent(content, document.uri.fsPath);
      if (!contractInfo) {
        return;
      }

      // Check if cancelled before expensive operation
      if (!this.activeSolcCompilations.get(uri)) {
        console.log('Solc analysis cancelled before compilation for', uri);
        return;
      }

      console.log(`📊 Starting solc compilation for ${contractInfo.name}...`);

      // SINGLE compilation for the whole contract
      const gasEstimates = new Map<string, GasEstimate>();
      const diagnostics: vscode.Diagnostic[] = [];

      const compileResult = await this.solcGasEstimator.estimateContractGas(
        content,
        contractInfo.functions,
        document.uri.fsPath
      );

      // Check if cancelled after compilation
      if (!this.activeSolcCompilations.get(uri)) {
        console.log('Solc analysis cancelled after compilation for', uri);
        return;
      }

      // Process results
      for (const estimate of compileResult) {
        const funcName = estimate.signature.split('(')[0];
        gasEstimates.set(funcName, estimate);

        // Add diagnostics for high gas functions
        const avgGas = estimate.estimatedGas.average;
        const avgGasString = avgGas === 'infinite' ? '∞' : avgGas.toLocaleString();

        if (
          estimate.complexity === 'high' ||
          estimate.complexity === 'very-high' ||
          estimate.complexity === 'unbounded'
        ) {
          const funcPattern =
            funcName === 'constructor'
              ? /constructor\s*\([^)]*\)/s
              : new RegExp(`function\\s+${funcName}\\s*\\([^)]*\\)`, 's');
          const match = content.match(funcPattern);

          if (match) {
            const functionStart = content.indexOf(match[0]);
            const lines = content.substring(0, functionStart).split('\n').length - 1;

            const diagnostic = new vscode.Diagnostic(
              new vscode.Range(lines, 0, lines, 1000),
              `High gas cost (${avgGasString} gas): ${estimate.warning || estimate.factors.join(', ')}`,
              estimate.complexity === 'very-high' || estimate.complexity === 'unbounded'
                ? vscode.DiagnosticSeverity.Warning
                : vscode.DiagnosticSeverity.Information
            );
            diagnostic.source = 'SigScan Gas';
            diagnostics.push(diagnostic);
          }
        }
      }

      console.log(`✅ Solc compilation complete: ${gasEstimates.size} functions analyzed`);

      // Update diagnostics
      this.diagnosticCollection.set(document.uri, diagnostics);

      // Cache by content hash - this is the complete analysis with gas
      const analysis: LiveAnalysis = {
        gasEstimates,
        sizeInfo: null,
        complexityMetrics: new Map(),
        diagnostics,
        isPending: false,
      };

      this.solcResultsCache.set(contentHash, analysis);

      // Emit event so extension.ts can update decorations
      this.emit('analysisReady', {
        uri,
        analysis,
      } as AnalysisReadyEvent);
    } catch (error) {
      console.error('Solc analysis error:', error);
      // DON'T clear decorations on error - keep showing what we have
    } finally {
      this.activeSolcCompilations.set(uri, false);
      this.analysisInProgress = false;
    }
  }

  /**
   * Cancel all pending solc compilations and timers
   */
  public dispose(): void {
    // Cancel all idle timers
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();

    // Cancel active compilations
    for (const uri of this.activeSolcCompilations.keys()) {
      this.activeSolcCompilations.set(uri, false);
    }
    this.activeSolcCompilations.clear();

    // Clear caches
    this.analysisCache.clear();
    this.solcResultsCache.clear();
    this.signatureCache.clear();
  }

  /**
   * Get inline gas cost inlay hints (non-selectable, Remix-style - after opening brace)
   */
  public createGasInlayHints(
    analysis: LiveAnalysis,
    document: vscode.TextDocument
  ): vscode.InlayHint[] {
    const hints: vscode.InlayHint[] = [];
    const content = document.getText();
    const isPending = analysis.isPending === true;

    analysis.gasEstimates.forEach((estimate, funcName) => {
      // Handle different types: modifiers, events, structs, constructors, functions
      const isModifier = funcName.startsWith('modifier:');
      const isEvent = funcName.startsWith('event:');
      const isStruct = funcName.startsWith('struct:');
      const isConstructor = funcName === 'constructor';

      let pattern: RegExp;
      let displayName: string;

      if (isModifier) {
        const modName = funcName.replace('modifier:', '');
        pattern = new RegExp(`modifier\\s+${modName}\\s*\\([^)]*\\)[^{]*{`, 's');
        displayName = `modifier ${modName}`;
      } else if (isEvent) {
        const eventName = funcName.replace('event:', '');
        // Show hint on first emit statement
        pattern = new RegExp(`emit\\s+${eventName}\\s*\\(`, 's');
        displayName = `event ${eventName}`;
      } else if (isStruct) {
        const structName = funcName.replace('struct:', '');
        pattern = new RegExp(`struct\\s+${structName}\\s*{`, 's');
        displayName = `struct ${structName}`;
      } else if (isConstructor) {
        pattern = new RegExp(`constructor\\s*\\([^)]*\\)[^{]*{`, 's');
        displayName = 'constructor';
      } else {
        pattern = new RegExp(`function\\s+${funcName}\\s*\\([^)]*\\)[^{]*{`, 's');
        displayName = `${funcName}()`;
      }

      const match = pattern.exec(content);

      if (match) {
        // Find position right after the opening brace or relevant symbol
        let hintPos: vscode.Position;

        if (isEvent) {
          // For events, find the closing parenthesis after emit
          const emitStart = match.index;
          const afterEmit = content.substring(emitStart);
          // Find matching closing parenthesis
          let depth = 0;
          let closingParenIndex = -1;
          for (let i = 0; i < afterEmit.length; i++) {
            if (afterEmit[i] === '(') {
              depth++;
            }
            if (afterEmit[i] === ')') {
              depth--;
              if (depth === 0) {
                closingParenIndex = i;
                break;
              }
            }
          }
          if (closingParenIndex !== -1) {
            hintPos = document.positionAt(emitStart + closingParenIndex + 1);
          } else {
            // Fallback: after opening paren if we can't find closing
            hintPos = document.positionAt(match.index + match[0].length);
          }
        } else {
          // For functions, modifiers, structs, constructors - show after '{'
          const braceIndex = match[0].lastIndexOf('{');
          hintPos = document.positionAt(match.index + braceIndex + 1);
        }

        // Handle pending state
        const gasAmount = estimate.estimatedGas.average;
        const hasPendingGas = isPending || gasAmount === 0;
        const gasAmountStr = hasPendingGas
          ? '...'
          : gasAmount === 'infinite'
            ? '∞'
            : (gasAmount as number).toLocaleString();
        const minGasStr = hasPendingGas
          ? '...'
          : estimate.estimatedGas.min === 'infinite'
            ? '∞'
            : (estimate.estimatedGas.min as number).toLocaleString();
        const maxGasStr = hasPendingGas
          ? '...'
          : estimate.estimatedGas.max === 'infinite'
            ? '∞'
            : (estimate.estimatedGas.max as number).toLocaleString();

        const hintText = hasPendingGas
          ? ` ⏳ ${estimate.selector} | compiling... `
          : ` ⛽ ${gasAmountStr} gas | ${estimate.selector} `;

        const hint = new vscode.InlayHint(hintPos, hintText, vscode.InlayHintKind.Parameter);

        // Add tooltip with detailed info including signature
        hint.tooltip = new vscode.MarkdownString(
          hasPendingGas
            ? `**⏳ Compiling ${displayName}...**\n\n` +
                `**Selector**: \`${estimate.selector}\`\n\n` +
                `**Signature**: \`${estimate.signature}\`\n\n` +
                `*Gas estimate pending - solc is compiling...*`
            : `**⛽ Gas Estimate for ${displayName} \`${estimate.selector}\`**\n\n` +
                `**Source**: ${estimate.source === 'solc' ? 'solc compiler' : 'Analysis'}\n\n` +
                `**Signature**: \`${estimate.signature}\`\n\n` +
                `**Range**: ${minGasStr} - ${maxGasStr} gas\n\n` +
                `**Average**: ${gasAmountStr} gas\n\n` +
                `**Complexity**: ${estimate.complexity}\n\n` +
                `**Factors**: ${estimate.factors.join(', ')}` +
                (estimate.warning ? `\n\n⚠️ **Warning**: ${estimate.warning}` : '')
        );

        hints.push(hint);
      }
    });

    return hints;
  }

  /**
   * Extended Analysis - On-demand features (lightweight, cached)
   */

  /**
   * Analyze storage layout (on-demand)
   */
  public async analyzeStorageLayout(document: vscode.TextDocument): Promise<StorageLayout> {
    const content = document.getText();
    const contractName = this.extractContractName(content);
    return this.storageAnalyzer.analyzeContract(content, contractName);
  }

  /**
   * Analyze call graph (on-demand)
   */
  public async analyzeCallGraph(document: vscode.TextDocument): Promise<CallGraph> {
    const content = document.getText();
    return this.callGraphAnalyzer.analyzeContract(content);
  }

  /**
   * Estimate deployment cost (on-demand)
   */
  public async estimateDeploymentCost(document: vscode.TextDocument): Promise<DeploymentCost> {
    const content = document.getText();
    const contractName = this.extractContractName(content);
    return this.deploymentAnalyzer.estimateContract(content, contractName);
  }

  /**
   * Extract contract name from content
   */
  private extractContractName(content: string): string {
    const match = content.match(/(contract|library|interface)\s+(\w+)/);
    return match ? match[2] : 'Unknown';
  }

  /**
   * Compare with git branch (on-demand)
   */
  public async compareWithBranch(
    document: vscode.TextDocument,
    targetBranch = 'main'
  ): Promise<RegressionReport | null> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return null;
    }

    const isGit = await this.regressionTracker.isGitRepository(workspaceFolder.uri.fsPath);
    if (!isGit) {
      return null;
    }

    // Get current gas data
    const analysis = await this.analyzeDocumentOnChange(document);
    const gasData = new Map<
      string,
      { signature: string; gas: number; source: 'solc' | 'heuristic'; complexity: string }
    >();

    analysis.gasEstimates.forEach((estimate, funcName) => {
      gasData.set(funcName, {
        signature: estimate.signature,
        gas: typeof estimate.estimatedGas.average === 'number' ? estimate.estimatedGas.average : 0,
        source: estimate.source,
        complexity: estimate.complexity,
      });
    });

    return this.regressionTracker.compareWithCommit(
      gasData,
      workspaceFolder.uri.fsPath,
      targetBranch
    );
  }

  /**
   * Get runtime profiler report (on-demand)
   */
  public async getProfilerReport(document: vscode.TextDocument): Promise<ProfilerReport | null> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return null;
    }

    const forgeReports = await this.runtimeProfiler.parseForgeGasReport(workspaceFolder.uri.fsPath);
    if (forgeReports.length === 0) {
      return null;
    }

    // Get estimates
    const analysis = await this.analyzeDocumentOnChange(document);
    const estimates = new Map<string, { gas: number; signature: string }>();

    analysis.gasEstimates.forEach((estimate, funcName) => {
      estimates.set(funcName, {
        gas: typeof estimate.estimatedGas.average === 'number' ? estimate.estimatedGas.average : 0,
        signature: estimate.signature,
      });
    });

    return this.runtimeProfiler.compareEstimates(forgeReports, estimates);
  }

  /**
   * Get extended analyzers
   */
  public getExtendedAnalyzers() {
    return {
      storage: this.storageAnalyzer,
      callGraph: this.callGraphAnalyzer,
      deployment: this.deploymentAnalyzer,
      regression: this.regressionTracker,
      profiler: this.runtimeProfiler,
    };
  }

  /**
   * Create gas decorations with gradient colors (green to red)
   * Shows selector immediately, gas when available
   */
  public createGasDecorations(
    analysis: LiveAnalysis,
    document: vscode.TextDocument
  ): vscode.DecorationOptions[] {
    const decorations: vscode.DecorationOptions[] = [];
    const content = document.getText();
    const isPending = analysis.isPending === true;

    analysis.gasEstimates.forEach((estimate, funcName) => {
      // Handle different types: modifiers, events, structs, constructors, functions
      const isModifier = funcName.startsWith('modifier:');
      const isEvent = funcName.startsWith('event:');
      const isStruct = funcName.startsWith('struct:');
      const isConstructor = funcName === 'constructor';

      let pattern: RegExp;
      let displayName: string;

      if (isModifier) {
        const modName = funcName.replace('modifier:', '');
        pattern = new RegExp(`modifier\\s+${modName}\\s*\\([^)]*\\)[^{]*{`, 's');
        displayName = `modifier ${modName}`;
      } else if (isEvent) {
        const eventName = funcName.replace('event:', '');
        pattern = new RegExp(`emit\\s+${eventName}\\s*\\(`, 's');
        displayName = `event ${eventName}`;
      } else if (isStruct) {
        const structName = funcName.replace('struct:', '');
        pattern = new RegExp(`struct\\s+${structName}\\s*{`, 's');
        displayName = `struct ${structName}`;
      } else if (isConstructor) {
        pattern = new RegExp(`constructor\\s*\\([^)]*\\)[^{]*{`, 's');
        displayName = 'constructor';
      } else {
        pattern = new RegExp(`function\\s+${funcName}\\s*\\([^)]*\\)[^{]*{`, 's');
        displayName = `${funcName}()`;
      }

      const match = pattern.exec(content);

      if (match) {
        let hintPos: vscode.Position;

        if (isEvent) {
          // For events, find the closing parenthesis after emit
          const emitStart = match.index;
          const afterEmit = content.substring(emitStart);
          // Find matching closing parenthesis
          let depth = 0;
          let closingParenIndex = -1;
          for (let i = 0; i < afterEmit.length; i++) {
            if (afterEmit[i] === '(') {
              depth++;
            }
            if (afterEmit[i] === ')') {
              depth--;
              if (depth === 0) {
                closingParenIndex = i;
                break;
              }
            }
          }
          if (closingParenIndex !== -1) {
            hintPos = document.positionAt(emitStart + closingParenIndex + 1);
          } else {
            // Fallback: after opening paren if we can't find closing
            hintPos = document.positionAt(match.index + match[0].length);
          }
        } else {
          const braceIndex = match[0].lastIndexOf('{');
          hintPos = document.positionAt(match.index + braceIndex + 1);
        }

        const gasAmount = estimate.estimatedGas.average;
        // Handle pending state - show "..." instead of gas
        const hasPendingGas = isPending || gasAmount === 0;
        const gasAmountStr = hasPendingGas
          ? '...'
          : gasAmount === 'infinite'
            ? '∞'
            : (gasAmount as number).toLocaleString();
        const minGasStr = hasPendingGas
          ? '...'
          : estimate.estimatedGas.min === 'infinite'
            ? '∞'
            : (estimate.estimatedGas.min as number).toLocaleString();
        const maxGasStr = hasPendingGas
          ? '...'
          : estimate.estimatedGas.max === 'infinite'
            ? '∞'
            : (estimate.estimatedGas.max as number).toLocaleString();
        const color = hasPendingGas ? '#9E9E9E' : this.getGasGradientColor(gasAmount);

        // Calculate the start position for the hover range (function/constructor keyword)
        const startPos = document.positionAt(match.index);
        // The range should cover from function keyword to opening brace for hover to work
        const hoverRange = new vscode.Range(startPos, hintPos);

        // Build the decoration text - always show selector, gas when available
        const decorationText = hasPendingGas
          ? ` ⏳ ${estimate.selector} | compiling...`
          : ` ⛽ ${gasAmountStr} gas | ${estimate.selector}`;

        const decoration: vscode.DecorationOptions = {
          range: hoverRange,
          renderOptions: {
            after: {
              contentText: decorationText,
              color: color,
              fontStyle: 'normal',
              margin: '0 0 0 0.5em',
            },
          },
          hoverMessage: new vscode.MarkdownString(
            hasPendingGas
              ? `**⏳ Compiling ${displayName}...**\n\n` +
                  `**Selector**: \`${estimate.selector}\`\n\n` +
                  `**Signature**: \`${estimate.signature}\`\n\n` +
                  `*Gas estimate pending - solc is compiling...*`
              : `**⛽ Gas Estimate for ${displayName} \`${estimate.selector}\`**\n\n` +
                  `**Source**: ${estimate.source === 'solc' ? 'solc Compiler' : 'Analysis'}\n\n` +
                  `**Signature**: \`${estimate.signature}\`\n\n` +
                  `**Range**: ${minGasStr} - ${maxGasStr} gas\n\n` +
                  `**Average**: ${gasAmountStr} gas\n\n` +
                  `**Complexity**: ${estimate.complexity}\n\n` +
                  `**Factors**: ${estimate.factors.join(', ')}` +
                  (estimate.warning ? `\n\n⚠️ **Warning**: ${estimate.warning}` : '')
          ),
        };

        decorations.push(decoration);
      }
    });

    return decorations;
  }

  /**
   * Get inline complexity decoration
   */
  public createComplexityDecorations(
    analysis: LiveAnalysis,
    document: vscode.TextDocument
  ): vscode.DecorationOptions[] {
    const decorations: vscode.DecorationOptions[] = [];
    const content = document.getText();

    analysis.complexityMetrics.forEach((metrics, funcName) => {
      const pattern = new RegExp(`function\\s+${funcName}\\s*\\(`);
      const match = pattern.exec(content);

      if (match && metrics.rating !== 'A') {
        const position = document.positionAt(match.index);
        const lineEndPos = document.lineAt(position.line).range.end;
        const decoration: vscode.DecorationOptions = {
          range: new vscode.Range(position, lineEndPos),
          renderOptions: {
            after: {
              contentText: ` 🔧 ${metrics.rating} (CC: ${metrics.cyclomaticComplexity})`,
              color: this.getComplexityColor(metrics.rating),
              margin: '0 0 0 1em',
              fontStyle: 'italic',
            },
          },
        };
        decorations.push(decoration);
      }
    });

    return decorations;
  }

  /**
   * Generate hover information
   */
  public createHoverInfo(
    position: vscode.Position,
    analysis: LiveAnalysis,
    document: vscode.TextDocument
  ): vscode.Hover | null {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) {
      return null;
    }

    const word = document.getText(wordRange);

    // Check if hovering over a function
    const gasEstimate = analysis.gasEstimates.get(word);
    const complexity = analysis.complexityMetrics.get(word);

    if (!gasEstimate && !complexity) {
      return null;
    }

    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`### Function: \`${word}\`\n\n`);

    if (gasEstimate) {
      markdown.appendMarkdown(`#### ⛽ Gas Analysis\n\n`);
      markdown.appendMarkdown(
        `- **Source**: ${gasEstimate.source === 'solc' ? 'solc Compiler' : 'Heuristic'}\n`
      );
      markdown.appendMarkdown(`- **Signature**: \`${gasEstimate.signature}\`\n`);
      markdown.appendMarkdown(`- **Selector**: \`${gasEstimate.selector}\`\n`);

      const minGas =
        gasEstimate.estimatedGas.min === 'infinite'
          ? '∞'
          : gasEstimate.estimatedGas.min.toLocaleString();
      const maxGas =
        gasEstimate.estimatedGas.max === 'infinite'
          ? '∞'
          : gasEstimate.estimatedGas.max.toLocaleString();
      const avgGas =
        gasEstimate.estimatedGas.average === 'infinite'
          ? '∞'
          : gasEstimate.estimatedGas.average.toLocaleString();

      markdown.appendMarkdown(`- **Estimated Gas**: ${minGas} - ${maxGas} (avg: ${avgGas})\n`);
      markdown.appendMarkdown(`- **Complexity**: ${gasEstimate.complexity}\n`);
      markdown.appendMarkdown(`- **Factors**: ${gasEstimate.factors.join(', ')}\n`);
      if (gasEstimate.warning) {
        markdown.appendMarkdown(`- **⚠️ Warning**: ${gasEstimate.warning}\n`);
      }
      markdown.appendMarkdown(`\n`);
    }

    if (complexity) {
      markdown.appendMarkdown(`#### 🔧 Code Quality\n\n`);
      markdown.appendMarkdown(`- **Cyclomatic Complexity**: ${complexity.cyclomaticComplexity}\n`);
      markdown.appendMarkdown(`- **Cognitive Complexity**: ${complexity.cognitiveComplexity}\n`);
      markdown.appendMarkdown(`- **Lines of Code**: ${complexity.linesOfCode}\n`);
      markdown.appendMarkdown(
        `- **Maintainability Index**: ${complexity.maintainabilityIndex} (${complexity.rating})\n`
      );
      if (complexity.issues.length > 0) {
        markdown.appendMarkdown(`- **Issues**: ${complexity.issues.join(', ')}\n`);
      }
    }

    return new vscode.Hover(markdown, wordRange);
  }

  /**
   * Clear cache for document
   */
  public clearCache(uri: vscode.Uri): void {
    this.analysisCache.delete(uri.toString());
  }

  /**
   * Clear all caches
   */
  public clearAllCaches(): void {
    this.analysisCache.clear();
  }

  /**
   * Set up background compiler upgrade with re-compilation callback
   */
  private setupCompilerUpgrade(document: vscode.TextDocument): void {
    const uri = document.uri.toString();

    // This will trigger background download if needed
    // The onUpgrade callback will fire when download completes
    const onUpgrade = async (version: string) => {
      console.log(`🔄 Compiler ${version} ready, re-compiling ${document.fileName}...`);

      // Invalidate cache for this document
      this.analysisCache.delete(uri);
      const content = document.getText();
      const contentHash = this.hashContent(content);
      this.solcResultsCache.delete(contentHash);
      this.signatureCache.delete(contentHash);

      // Trigger re-analysis with new compiler
      await this.runSolcAnalysis(document, contentHash);

      // Notify user
      vscode.window.showInformationMessage(`Gas estimates updated with Solidity ${version}`);
    };

    // Pass the callback to the gas estimator (which passes it to solc integration)
    // This is already wired up in the version manager, just need to make sure it's called
    this.solcGasEstimator.triggerCompilerUpgrade(document.getText(), onUpgrade);
  }

  private createEmptyAnalysis(isPending = false): LiveAnalysis {
    return {
      gasEstimates: new Map(),
      sizeInfo: null,
      complexityMetrics: new Map(),
      diagnostics: [],
      isPending,
    };
  }

  private getGasColor(complexity: string): string {
    switch (complexity) {
      case 'low':
        return '#4CAF50'; // Green
      case 'medium':
        return '#FFC107'; // Amber
      case 'high':
        return '#FF9800'; // Orange
      case 'very-high':
        return '#F44336'; // Red
      default:
        return '#9E9E9E'; // Gray
    }
  }

  /**
   * Get color gradient from green to red based on gas amount
   */
  private getGasGradientColor(gasAmount: number | 'infinite'): string {
    // Infinite gas is always red
    if (gasAmount === 'infinite') {
      return '#FF0000'; // Red
    }

    // Gas thresholds for color gradient
    // 0-5K: Green
    // 5K-20K: Yellow-Green
    // 20K-50K: Yellow
    // 50K-100K: Orange
    // 100K+: Red

    if (gasAmount < 5000) {
      return '#00FF00'; // Bright Green
    } else if (gasAmount < 10000) {
      return '#7FFF00'; // Chartreuse
    } else if (gasAmount < 20000) {
      return '#BFFF00'; // Yellow-Green
    } else if (gasAmount < 35000) {
      return '#FFFF00'; // Yellow
    } else if (gasAmount < 50000) {
      return '#FFD700'; // Gold
    } else if (gasAmount < 75000) {
      return '#FFA500'; // Orange
    } else if (gasAmount < 100000) {
      return '#FF6347'; // Tomato
    } else {
      return '#FF0000'; // Red
    }
  }

  private getComplexityColor(rating: string): string {
    switch (rating) {
      case 'A':
        return '#4CAF50'; // Green
      case 'B':
        return '#8BC34A'; // Light Green
      case 'C':
        return '#FFC107'; // Amber
      case 'D':
        return '#FF9800'; // Orange
      case 'F':
        return '#F44336'; // Red
      default:
        return '#9E9E9E'; // Gray
    }
  }
}
