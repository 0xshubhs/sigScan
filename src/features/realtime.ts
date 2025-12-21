/**
 * Real-time Analysis - Live gas profiling and diagnostics during code editing
 * Two-tier analysis model:
 * - Tier 1: Instant heuristic analysis (<5ms)
 * - Tier 2: Full solc compilation after idle timeout (cancelable)
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { GasEstimator, GasEstimate } from './gas';
import { ContractSizeAnalyzer, ContractSizeInfo } from './size';
import { ComplexityAnalyzer, ComplexityMetrics } from './complexity';
import { SolidityParser } from '../core/parser';

export interface LiveAnalysis {
  gasEstimates: Map<string, GasEstimate>;
  sizeInfo: ContractSizeInfo | null;
  complexityMetrics: Map<string, ComplexityMetrics>;
  diagnostics: vscode.Diagnostic[];
}

export class RealtimeAnalyzer {
  private heuristicGasEstimator: GasEstimator; // Fast, always enabled
  private solcGasEstimator: GasEstimator; // Accurate, runs on idle
  private sizeAnalyzer: ContractSizeAnalyzer;
  private complexityAnalyzer: ComplexityAnalyzer;
  private parser: SolidityParser;
  private diagnosticCollection: vscode.DiagnosticCollection;
  private analysisCache: Map<string, { timestamp: number; analysis: LiveAnalysis }>;
  private contentHashCache: Map<string, LiveAnalysis>; // Hash-based cache for solc results
  private idleTimers: Map<string, NodeJS.Timeout>; // Per-document idle timers
  private activeSolcCompilations: Map<string, boolean>; // Track active compilations to cancel

  constructor(diagnosticCollection: vscode.DiagnosticCollection) {
    // Tier 1: Heuristic estimator (no solc, instant)
    this.heuristicGasEstimator = new GasEstimator(false);
    // Tier 2: Solc estimator (accurate, runs on idle)
    this.solcGasEstimator = new GasEstimator(true);
    this.sizeAnalyzer = new ContractSizeAnalyzer();
    this.complexityAnalyzer = new ComplexityAnalyzer();
    this.parser = new SolidityParser();
    this.diagnosticCollection = diagnosticCollection;
    this.analysisCache = new Map();
    this.contentHashCache = new Map();
    this.idleTimers = new Map();
    this.activeSolcCompilations = new Map();
  }

  /**
   * Analyze document on file open - immediately runs solc (no wait)
   */
  public async analyzeDocumentOnOpen(document: vscode.TextDocument): Promise<LiveAnalysis> {
    const content = document.getText();
    const uri = document.uri.toString();
    const contentHash = this.hashContent(content);

    // Clear old cache for this file
    this.analysisCache.delete(uri);

    // Check hash-based cache first (exact content match)
    const hashCached = this.contentHashCache.get(contentHash);
    if (hashCached) {
      return hashCached;
    }

    // Run instant heuristic analysis
    const heuristicAnalysis = await this.runHeuristicAnalysis(document);

    // Immediately trigger solc analysis (no wait on file open)
    this.runSolcAnalysisImmediate(document, contentHash);

    return heuristicAnalysis;
  }

  /**
   * Analyze document on change - waits 10s idle before solc
   */
  public async analyzeDocumentOnChange(document: vscode.TextDocument): Promise<LiveAnalysis> {
    const content = document.getText();
    const uri = document.uri.toString();
    const contentHash = this.hashContent(content);

    // Check hash-based cache first (exact content match)
    const hashCached = this.contentHashCache.get(contentHash);
    if (hashCached) {
      return hashCached;
    }

    // Run instant heuristic analysis
    const heuristicAnalysis = await this.runHeuristicAnalysis(document);

    // Schedule Tier 2 (solc) after idle timeout
    this.scheduleIdleSolcAnalysis(document, contentHash);

    return heuristicAnalysis;
  }

  /**
   * Tier 1: Instant heuristic analysis (runs on every keystroke)
   * @deprecated Use analyzeDocumentOnOpen or analyzeDocumentOnChange
   */
  public async analyzeDocument(document: vscode.TextDocument): Promise<LiveAnalysis> {
    // Default to onChange behavior for backward compatibility
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
    const idleMs = config.get<number>('realtime.solcIdleMs', 10000);

    // Cancel previous timer
    const existingTimer = this.idleTimers.get(uri);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Cancel any active compilation for this document
    if (this.activeSolcCompilations.get(uri)) {
      this.activeSolcCompilations.set(uri, false); // Signal cancellation
    }

    // Schedule new timer
    const timer = setTimeout(async () => {
      await this.runSolcAnalysis(document, contentHash);
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

    // Run solc analysis immediately
    await this.runSolcAnalysis(document, contentHash);
  }

  /**
   * Run fast heuristic analysis (Tier 1)
   */
  private async runHeuristicAnalysis(document: vscode.TextDocument): Promise<LiveAnalysis> {
    const content = document.getText();
    const uri = document.uri.toString();

    // Parse contract
    const contractInfo = this.parser.parseFile(document.uri.fsPath);
    if (!contractInfo) {
      return this.createEmptyAnalysis();
    }

    // Perform analyses
    const gasEstimates = new Map<string, GasEstimate>();
    const complexityMetrics = new Map<string, ComplexityMetrics>();
    const diagnostics: vscode.Diagnostic[] = [];

    // Analyze each function (including constructors)
    for (const func of contractInfo.functions) {
      // Match both regular functions and constructors
      const isConstructor = func.name === 'constructor';
      const funcPattern = isConstructor
        ? new RegExp(`constructor\\s*\\([^)]*\\)[^{]*{([^}]*(?:{[^}]*}[^}]*)*)}`, 's')
        : new RegExp(`function\\s+${func.name}\\s*\\([^)]*\\)[^{]*{([^}]*(?:{[^}]*}[^}]*)*)}`, 's');
      const match = content.match(funcPattern);

      if (match && match[1]) {
        const functionBody = match[1];
        const functionStart = content.indexOf(match[0]);
        const lines = content.substring(0, functionStart).split('\n').length - 1;

        // Tier 1: Fast heuristic gas estimation
        const gasEstimate = this.heuristicGasEstimator.estimateGasSync(
          functionBody,
          func.signature
        );

        gasEstimates.set(func.name, gasEstimate);

        // Add gas diagnostics
        const avgGas = gasEstimate.estimatedGas.average;
        const avgGasString = avgGas === 'infinite' ? '∞' : avgGas.toLocaleString();

        if (
          gasEstimate.complexity === 'high' ||
          gasEstimate.complexity === 'very-high' ||
          gasEstimate.complexity === 'unbounded'
        ) {
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(lines, 0, lines, 1000),
            `High gas cost (${avgGasString} gas): ${gasEstimate.warning || gasEstimate.factors.join(', ')}`,
            gasEstimate.complexity === 'very-high' || gasEstimate.complexity === 'unbounded'
              ? vscode.DiagnosticSeverity.Warning
              : vscode.DiagnosticSeverity.Information
          );
          diagnostic.source = `SigScan Gas (${gasEstimate.source})`;
          diagnostics.push(diagnostic);
        }

        // Complexity analysis
        const complexity = this.complexityAnalyzer.analyzeFunction(functionBody, func.name);
        complexityMetrics.set(func.name, complexity);

        // Add complexity diagnostics
        if (complexity.issues.length > 0) {
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(lines, 0, lines, 1000),
            `Complexity issues: ${complexity.issues.join(', ')} (Maintainability: ${complexity.rating})`,
            complexity.rating === 'F' || complexity.rating === 'D'
              ? vscode.DiagnosticSeverity.Warning
              : vscode.DiagnosticSeverity.Information
          );
          diagnostic.source = 'SigScan Complexity';
          diagnostics.push(diagnostic);
        }
      }
    }

    // Analyze modifiers
    const modifierRegex = /modifier\s+(\w+)\s*\([^)]*\)[^{]*{([^}]*(?:{[^}]*}[^}]*)*)}/gs;
    let modifierMatch;
    while ((modifierMatch = modifierRegex.exec(content)) !== null) {
      const [fullMatch, modifierName, modifierBody] = modifierMatch;
      const modifierStart = content.indexOf(fullMatch);
      const lines = content.substring(0, modifierStart).split('\n').length - 1;

      // Gas estimation for modifier (sync only as modifiers aren't compiled separately)
      const gasEstimate = this.heuristicGasEstimator.estimateGasSync(
        modifierBody,
        `modifier:${modifierName}`
      );
      gasEstimates.set(`modifier:${modifierName}`, gasEstimate);

      // Complexity for modifier
      const complexity = this.complexityAnalyzer.analyzeFunction(modifierBody, modifierName);
      complexityMetrics.set(`modifier:${modifierName}`, complexity);

      // Add gas diagnostics for high-cost modifiers
      const avgGas = gasEstimate.estimatedGas.average;
      const avgGasString = avgGas === 'infinite' ? '∞' : avgGas.toLocaleString();

      if (
        gasEstimate.complexity === 'high' ||
        gasEstimate.complexity === 'very-high' ||
        gasEstimate.complexity === 'unbounded'
      ) {
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(lines, 0, lines, 1000),
          `Modifier '${modifierName}' has high gas cost: ${avgGasString} gas. ${gasEstimate.warning || ''}`,
          vscode.DiagnosticSeverity.Warning
        );
        diagnostic.source = 'SigScan Gas';
        diagnostics.push(diagnostic);
      }
    }

    // Analyze events (emit statements)
    contractInfo.events.forEach((event) => {
      const eventPattern = new RegExp(`emit\\s+${event.name}\\s*\\([^)]*\\)`, 'g');
      const matches = content.match(eventPattern);
      if (matches && matches.length > 0) {
        // Base gas cost for emitting an event: ~375 gas per log + ~375 per topic + ~8 per byte
        const topicsCount = event.inputs.filter((i) => i.indexed).length;
        const baseGas = 375 + topicsCount * 375;
        const dataSize = event.inputs.filter((i) => !i.indexed).length * 32; // Estimate
        const totalGas = baseGas + dataSize * 8;

        // Use event signature and selector if available
        const signature = event.signature || `event:${event.name}`;
        const selector = event.selector || '0x00000000';

        gasEstimates.set(`event:${event.name}`, {
          function: `event:${event.name}`,
          signature,
          selector,
          estimatedGas: { min: totalGas, max: totalGas + 500, average: totalGas },
          complexity: 'low',
          factors: ['event emission', `${topicsCount} indexed topics`, `${matches.length} calls`],
          warning: undefined,
          source: 'heuristic',
        });
      }
    });

    // Analyze structs (storage operations)
    const structRegex = /struct\s+(\w+)\s*{([^}]*)}/gs;
    let structMatch;
    while ((structMatch = structRegex.exec(content)) !== null) {
      const [, structName, structBody] = structMatch;
      // Count fields in struct
      const fields = structBody.split(';').filter((f) => f.trim()).length;
      // Storage write: ~20,000 gas for first write, ~5,000 for updates per slot
      const storageGas = 20000 + (fields - 1) * 5000;

      gasEstimates.set(`struct:${structName}`, {
        function: `struct:${structName}`,
        signature: `struct:${structName}`,
        selector: '0x00000000', // Structs don't have selectors
        estimatedGas: {
          min: storageGas,
          max: storageGas * 2,
          average: Math.floor(storageGas * 1.5),
        },
        complexity: fields > 5 ? 'high' : 'medium',
        factors: ['struct storage', `${fields} fields`, 'cold storage access'],
        warning: fields > 10 ? 'Large struct may be expensive to store' : undefined,
        source: 'heuristic',
      });
    }

    // Contract size analysis
    const sizeInfo = this.sizeAnalyzer.analyzeContract(contractInfo.name, content);

    // Add size diagnostics
    if (sizeInfo.status === 'critical' || sizeInfo.status === 'too-large') {
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 1000),
        `Contract size ${sizeInfo.sizeInKB} KB (${sizeInfo.percentage}% of 24KB limit): ${sizeInfo.recommendations[0]}`,
        sizeInfo.status === 'too-large'
          ? vscode.DiagnosticSeverity.Error
          : vscode.DiagnosticSeverity.Warning
      );
      diagnostic.source = 'SigScan Size';
      diagnostics.push(diagnostic);
    } else if (sizeInfo.status === 'warning') {
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 1000),
        `Contract approaching size limit: ${sizeInfo.sizeInKB} KB (${sizeInfo.percentage}%)`,
        vscode.DiagnosticSeverity.Information
      );
      diagnostic.source = 'SigScan Size';
      diagnostics.push(diagnostic);
    }

    // Update diagnostics
    this.diagnosticCollection.set(document.uri, diagnostics);

    const analysis: LiveAnalysis = {
      gasEstimates,
      sizeInfo,
      complexityMetrics,
      diagnostics,
    };

    // Cache result (timestamp-based cache for heuristic results)
    this.analysisCache.set(uri, { timestamp: Date.now(), analysis });

    return analysis;
  }

  /**
   * Tier 2: Accurate solc analysis (runs after idle timeout)
   */
  private async runSolcAnalysis(document: vscode.TextDocument, contentHash: string): Promise<void> {
    const uri = document.uri.toString();
    const content = document.getText();

    // Mark as active
    this.activeSolcCompilations.set(uri, true);

    try {
      // Parse contract
      const contractInfo = this.parser.parseFile(document.uri.fsPath);
      if (!contractInfo) {
        return;
      }

      const gasEstimates = new Map<string, GasEstimate>();
      const diagnostics: vscode.Diagnostic[] = [];

      // Analyze each function with solc
      for (const func of contractInfo.functions) {
        // Check if cancelled
        if (!this.activeSolcCompilations.get(uri)) {
          console.log('Solc analysis cancelled for', uri);
          return;
        }

        const isConstructor = func.name === 'constructor';
        const funcPattern = isConstructor
          ? new RegExp(`constructor\\\\s*\\\\([^)]*\\\\)[^{]*{([^}]*(?:{[^}]*}[^}]*)*)}`, 's')
          : new RegExp(
              `function\\\\s+${func.name}\\\\s*\\\\([^)]*\\\\)[^{]*{([^}]*(?:{[^}]*}[^}]*)*)}`,
              's'
            );
        const match = content.match(funcPattern);

        if (match && match[1]) {
          const functionBody = match[1];
          const functionStart = content.indexOf(match[0]);
          const lines = content.substring(0, functionStart).split('\\n').length - 1;

          // Tier 2: Accurate solc gas estimation
          const gasEstimate = await this.solcGasEstimator.estimateGas(
            functionBody,
            func.signature,
            document.uri.fsPath,
            content
          );

          gasEstimates.set(func.name, gasEstimate);

          // Add diagnostics for high gas functions
          const avgGas = gasEstimate.estimatedGas.average;
          const avgGasString = avgGas === 'infinite' ? '∞' : avgGas.toLocaleString();

          if (
            gasEstimate.complexity === 'high' ||
            gasEstimate.complexity === 'very-high' ||
            gasEstimate.complexity === 'unbounded'
          ) {
            const diagnostic = new vscode.Diagnostic(
              new vscode.Range(lines, 0, lines, 1000),
              `High gas cost (${avgGasString} gas - solc): ${gasEstimate.warning || gasEstimate.factors.join(', ')}`,
              gasEstimate.complexity === 'very-high' || gasEstimate.complexity === 'unbounded'
                ? vscode.DiagnosticSeverity.Warning
                : vscode.DiagnosticSeverity.Information
            );
            diagnostic.source = 'SigScan Gas (solc)';
            diagnostics.push(diagnostic);
          }
        }
      }

      // Update diagnostics
      this.diagnosticCollection.set(document.uri, diagnostics);

      // Cache by content hash
      const analysis: LiveAnalysis = {
        gasEstimates,
        sizeInfo: null,
        complexityMetrics: new Map(),
        diagnostics,
      };

      this.contentHashCache.set(contentHash, analysis);
    } finally {
      // Mark as inactive
      this.activeSolcCompilations.set(uri, false);
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
    this.contentHashCache.clear();
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
          // For events, show after 'emit EventName('
          hintPos = document.positionAt(match.index + match[0].length);
        } else {
          // For functions, modifiers, structs, constructors - show after '{'
          const braceIndex = match[0].lastIndexOf('{');
          hintPos = document.positionAt(match.index + braceIndex + 1);
        }

        // Create inlay hint with colored gas amount and hash
        const gasAmount = estimate.estimatedGas.average;
        const gasAmountStr = gasAmount === 'infinite' ? '∞' : gasAmount.toLocaleString();
        const minGasStr =
          estimate.estimatedGas.min === 'infinite'
            ? '∞'
            : estimate.estimatedGas.min.toLocaleString();
        const maxGasStr =
          estimate.estimatedGas.max === 'infinite'
            ? '∞'
            : estimate.estimatedGas.max.toLocaleString();

        const hint = new vscode.InlayHint(
          hintPos,
          ` ⛽ ${gasAmountStr} gas | ${estimate.selector} `,
          vscode.InlayHintKind.Parameter
        );

        // Add tooltip with detailed info including signature
        hint.tooltip = new vscode.MarkdownString(
          `**⛽ Gas Estimate for ${displayName} \`${estimate.selector}\`**\n\n` +
            `**Source**: ${estimate.source === 'solc' ? 'Solidity Compiler' : 'Heuristic Analysis'}\n\n` +
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
   * Create gas decorations with gradient colors (green to red)
   */
  public createGasDecorations(
    analysis: LiveAnalysis,
    document: vscode.TextDocument
  ): vscode.DecorationOptions[] {
    const decorations: vscode.DecorationOptions[] = [];
    const content = document.getText();

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
          hintPos = document.positionAt(match.index + match[0].length);
        } else {
          const braceIndex = match[0].lastIndexOf('{');
          hintPos = document.positionAt(match.index + braceIndex + 1);
        }

        const gasAmount = estimate.estimatedGas.average;
        const gasAmountStr = gasAmount === 'infinite' ? '∞' : gasAmount.toLocaleString();
        const minGasStr =
          estimate.estimatedGas.min === 'infinite'
            ? '∞'
            : estimate.estimatedGas.min.toLocaleString();
        const maxGasStr =
          estimate.estimatedGas.max === 'infinite'
            ? '∞'
            : estimate.estimatedGas.max.toLocaleString();
        const color = this.getGasGradientColor(gasAmount);

        const decoration: vscode.DecorationOptions = {
          range: new vscode.Range(hintPos, hintPos),
          renderOptions: {
            after: {
              contentText: ` ⛽ ${gasAmountStr} gas | ${estimate.selector}`,
              color: color,
              fontStyle: 'normal',
              margin: '0 0 0 0.5em',
            },
          },
          hoverMessage: new vscode.MarkdownString(
            `**⛽ Gas Estimate for ${displayName} \`${estimate.selector}\`**\n\n` +
              `**Source**: ${estimate.source === 'solc' ? 'Solidity Compiler' : 'Heuristic Analysis'}\n\n` +
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
        `- **Source**: ${gasEstimate.source === 'solc' ? 'Solidity Compiler' : 'Heuristic'}\n`
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

  private createEmptyAnalysis(): LiveAnalysis {
    return {
      gasEstimates: new Map(),
      sizeInfo: null,
      complexityMetrics: new Map(),
      diagnostics: [],
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
