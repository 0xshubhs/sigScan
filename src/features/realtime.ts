/**
 * Real-time Analysis - Live gas profiling and diagnostics during code editing
 */

import * as vscode from 'vscode';
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
  private gasEstimator: GasEstimator;
  private sizeAnalyzer: ContractSizeAnalyzer;
  private complexityAnalyzer: ComplexityAnalyzer;
  private parser: SolidityParser;
  private diagnosticCollection: vscode.DiagnosticCollection;
  private analysisCache: Map<string, { timestamp: number; analysis: LiveAnalysis }>;

  constructor(diagnosticCollection: vscode.DiagnosticCollection) {
    this.gasEstimator = new GasEstimator();
    this.sizeAnalyzer = new ContractSizeAnalyzer();
    this.complexityAnalyzer = new ComplexityAnalyzer();
    this.parser = new SolidityParser();
    this.diagnosticCollection = diagnosticCollection;
    this.analysisCache = new Map();
  }

  /**
   * Analyze document in real-time as user types
   */
  public async analyzeDocument(document: vscode.TextDocument): Promise<LiveAnalysis> {
    const content = document.getText();
    const uri = document.uri.toString();

    // Check cache (5 second TTL)
    const cached = this.analysisCache.get(uri);
    if (cached && Date.now() - cached.timestamp < 5000) {
      return cached.analysis;
    }

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
    contractInfo.functions.forEach((func) => {
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

        // Gas estimation
        const gasEstimate = this.gasEstimator.estimateGas(functionBody, func.signature);
        gasEstimates.set(func.name, gasEstimate);

        // Add gas diagnostics
        if (gasEstimate.complexity === 'high' || gasEstimate.complexity === 'very-high') {
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(lines, 0, lines, 1000),
            `High gas cost (${gasEstimate.estimatedGas.average.toLocaleString()} gas): ${gasEstimate.warning || gasEstimate.factors.join(', ')}`,
            gasEstimate.complexity === 'very-high'
              ? vscode.DiagnosticSeverity.Warning
              : vscode.DiagnosticSeverity.Information
          );
          diagnostic.source = 'SigScan Gas';
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
    });

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

    // Cache result
    this.analysisCache.set(uri, { timestamp: Date.now(), analysis });

    return analysis;
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
      // Match entire function/constructor including opening brace
      const isConstructor = funcName === 'constructor';
      const pattern = isConstructor
        ? new RegExp(`constructor\\s*\\([^)]*\\)[^{]*{`, 's')
        : new RegExp(`function\\s+${funcName}\\s*\\([^)]*\\)[^{]*{`, 's');
      const match = pattern.exec(content);

      if (match) {
        // Find position right after the opening brace
        const braceIndex = match[0].lastIndexOf('{');
        const afterBracePos = document.positionAt(match.index + braceIndex + 1);

        // Create inlay hint right after the opening brace
        const hint = new vscode.InlayHint(
          afterBracePos,
          ` ⛽ ${estimate.estimatedGas.average.toLocaleString()} gas `,
          vscode.InlayHintKind.Parameter
        );

        // Add tooltip with detailed info
        hint.tooltip = new vscode.MarkdownString(
          `**⛽ Gas Estimate for \`${funcName}${isConstructor ? '' : '()'}\`**\n\n` +
            `**Range**: ${estimate.estimatedGas.min.toLocaleString()} - ${estimate.estimatedGas.max.toLocaleString()} gas\n\n` +
            `**Average**: ${estimate.estimatedGas.average.toLocaleString()} gas\n\n` +
            `**Complexity**: ${estimate.complexity}\n\n` +
            `**Factors**: ${estimate.factors.join(', ')}` +
            (estimate.warning ? `\n\n⚠️ **Warning**: ${estimate.warning}` : '')
        );

        // Set color based on complexity (using padding to simulate badge)
        hint.paddingLeft = true;
        hint.paddingRight = true;

        hints.push(hint);
      }
    });

    return hints;
  }

  /**
   * Legacy decoration method (kept for compatibility)
   */
  public createGasDecorations(
    _analysis: LiveAnalysis,
    _document: vscode.TextDocument
  ): vscode.DecorationOptions[] {
    // Return empty array - we use inlay hints now
    return [];
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
        `- **Estimated Gas**: ${gasEstimate.estimatedGas.min.toLocaleString()} - ${gasEstimate.estimatedGas.max.toLocaleString()} (avg: ${gasEstimate.estimatedGas.average.toLocaleString()})\n`
      );
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
