/**
 * Decoration Manager - VS Code decoration creation for gas/complexity analysis
 *
 * Extracted from realtime.ts for modularity.
 * All functions are pure: they take analysis data and return VS Code decoration objects.
 */

import * as vscode from 'vscode';
import { GasEstimate } from './gas';
import { ComplexityMetrics } from './complexity';
import { GasInfo } from './SolcManager';

/** Mirrors LiveAnalysis but only the fields decorations need */
export interface DecorationAnalysis {
  gasEstimates: Map<string, GasEstimate>;
  complexityMetrics: Map<string, ComplexityMetrics>;
  isPending?: boolean;
}

// ─── Color helpers ───────────────────────────────────────────────────────────

/**
 * Get color gradient from green to red based on gas amount
 */
export function getGasGradientColor(gasAmount: number | 'infinite'): string {
  if (gasAmount === 'infinite') {
    return '#FF6B7A';
  }
  if (gasAmount < 5_000) {
    return '#73E068';
  }
  if (gasAmount < 20_000) {
    return '#C8D85A';
  }
  if (gasAmount < 50_000) {
    return '#FFD454';
  }
  if (gasAmount < 100_000) {
    return '#FFA64D';
  }
  return '#FF6B7A';
}

export function getComplexityColor(rating: string): string {
  switch (rating) {
    case 'A':
      return '#4CAF50';
    case 'B':
      return '#8BC34A';
    case 'C':
      return '#FFC107';
    case 'D':
      return '#FF9800';
    case 'F':
      return '#F44336';
    default:
      return '#9E9E9E';
  }
}

// ─── Pattern matching helpers ────────────────────────────────────────────────

interface FuncMatch {
  pattern: RegExp;
  displayName: string;
  isEvent: boolean;
}

function buildFuncMatch(funcName: string): FuncMatch {
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

  return { pattern, displayName, isEvent };
}

// ─── Regex match cache (keyed by content hash + funcName) ────────────────────

interface CachedMatch {
  match: RegExpExecArray | null;
}

const regexMatchCache = new Map<string, Map<string, CachedMatch>>();
const MAX_REGEX_CACHE_ENTRIES = 2; // keep current + previous content version

function getContentHash(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

/**
 * Get or compute a regex match for funcName against content, cached by content hash.
 */
function getCachedMatch(
  content: string,
  contentHash: string,
  funcName: string
): RegExpExecArray | null {
  let hashMap = regexMatchCache.get(contentHash);
  if (hashMap) {
    const cached = hashMap.get(funcName);
    if (cached !== undefined) {
      return cached.match;
    }
  }

  // Evict old content hashes if cache grows too large
  if (!hashMap) {
    if (regexMatchCache.size >= MAX_REGEX_CACHE_ENTRIES) {
      const oldest = regexMatchCache.keys().next().value as string;
      regexMatchCache.delete(oldest);
    }
    hashMap = new Map();
    regexMatchCache.set(contentHash, hashMap);
  }

  const { pattern } = buildFuncMatch(funcName);
  const match = pattern.exec(content);
  hashMap.set(funcName, { match });
  return match;
}

/**
 * Invalidate the regex match cache (call when content changes are known).
 */
export function invalidateMatchCache(): void {
  regexMatchCache.clear();
}

function findHintPosition(
  content: string,
  match: RegExpExecArray,
  isEvent: boolean,
  document: vscode.TextDocument
): vscode.Position {
  if (isEvent) {
    const emitStart = match.index;
    const afterEmit = content.substring(emitStart);
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
      return document.positionAt(emitStart + closingParenIndex + 1);
    }
    return document.positionAt(match.index + match[0].length);
  }

  const braceIndex = match[0].lastIndexOf('{');
  return document.positionAt(match.index + braceIndex + 1);
}

// ─── Gas formatting helpers ──────────────────────────────────────────────────

function formatGas(value: number | 'infinite', isPending: boolean): string {
  if (isPending || value === 0) {
    return '...';
  }
  if (value === 'infinite') {
    return '∞';
  }
  return (value as number).toLocaleString();
}

// ─── Public decoration creators ──────────────────────────────────────────────

/**
 * Create gas decorations with gradient colors (green to red).
 * Shows selector immediately, gas when available.
 */
export function createGasDecorations(
  analysis: DecorationAnalysis,
  document: vscode.TextDocument
): vscode.DecorationOptions[] {
  const decorations: vscode.DecorationOptions[] = [];
  const content = document.getText();
  const contentHash = getContentHash(content);
  const isPending = analysis.isPending === true;

  analysis.gasEstimates.forEach((estimate, funcName) => {
    const { displayName, isEvent } = buildFuncMatch(funcName);
    const match = getCachedMatch(content, contentHash, funcName);

    if (match) {
      const hintPos = findHintPosition(content, match, isEvent, document);
      const gasAmount = estimate.estimatedGas.average;
      const hasPendingGas = isPending || gasAmount === 0;

      const gasAmountStr = formatGas(gasAmount, hasPendingGas);
      const minGasStr = formatGas(estimate.estimatedGas.min, hasPendingGas);
      const maxGasStr = formatGas(estimate.estimatedGas.max, hasPendingGas);
      const color = hasPendingGas ? '#9E9E9E' : getGasGradientColor(gasAmount);

      const startPos = document.positionAt(match.index);
      const hoverRange = new vscode.Range(startPos, hintPos);

      const decorationText = hasPendingGas
        ? ` ⏳ ${estimate.selector} | compiling...`
        : ` ⛽ ${gasAmountStr} gas | ${estimate.selector}`;

      decorations.push({
        range: hoverRange,
        renderOptions: {
          after: {
            contentText: decorationText,
            color,
            fontStyle: 'normal',
            fontWeight: 'bold',
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
      });
    }
  });

  return decorations;
}

/**
 * Create Remix-style gas decorations from GasInfo (AST-based).
 * Uses precise source locations from AST for accurate inline display.
 */
export function createRemixStyleDecorations(
  gasInfo: GasInfo[],
  document: vscode.TextDocument
): vscode.DecorationOptions[] {
  const decorations: vscode.DecorationOptions[] = [];
  const content = document.getText();

  for (const info of gasInfo) {
    let line = info.loc.line - 1;

    // If loc.line is 0 (unresolved), try to find the function in source via regex
    if (line < 0 || line >= document.lineCount) {
      const isEvent = info.visibility === 'event';
      const escapedName = info.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = isEvent
        ? new RegExp(`event\\s+${escapedName}\\s*\\(`)
        : info.name === 'constructor'
          ? /constructor\s*\(/
          : new RegExp(`function\\s+${escapedName}\\s*\\(`);

      const match = pattern.exec(content);
      if (match) {
        line = document.positionAt(match.index).line;
      } else {
        continue; // Truly unfindable — skip
      }
    }

    const lineText = document.lineAt(line).text;
    const endPos = new vscode.Position(line, lineText.length);
    const startPos = new vscode.Position(line, 0);
    const range = new vscode.Range(startPos, endPos);

    const isEvent = info.visibility === 'event';
    const isReverted = info.warnings.some((w) => w.includes('reverted'));
    const noGas = info.gas === 0;

    let gasText = '';
    if (!noGas && !isEvent && info.gas !== 'infinite') {
      gasText =
        info.gas >= 1_000_000
          ? `${(info.gas / 1_000_000).toFixed(2)}M`
          : info.gas >= 1_000
            ? `${(info.gas / 1_000).toFixed(1)}k`
            : info.gas.toString();
    } else if (info.gas === 'infinite') {
      gasText = 'var';
    }

    // Reverted functions still get gradient color (the gas is real, just from a revert path)
    const color: string | vscode.ThemeColor = !gasText ? '#9E9E9E' : getGasGradientColor(info.gas);

    let decorationText: string;
    if (isEvent) {
      decorationText = ` event ${info.selector}`;
    } else if (!gasText) {
      decorationText = ` ${info.selector}`;
    } else if (isReverted) {
      decorationText = ` ~${gasText} gas | ${info.selector}`;
    } else {
      decorationText = ` ${gasText} gas | ${info.selector}`;
    }

    const hoverMd = new vscode.MarkdownString();
    hoverMd.isTrusted = true;
    hoverMd.appendMarkdown(`### \`${info.name}\` \`${info.selector}\`\n\n`);

    if (isEvent) {
      hoverMd.appendMarkdown(`**Type:** event\n\n**Topic:** \`${info.selector}\`\n\n`);
    } else if (!gasText) {
      hoverMd.appendMarkdown('**Gas:** unavailable\n\n');
    } else if (isReverted) {
      hoverMd.appendMarkdown(
        `**Gas:** ~${gasText} (estimated — function requires specific args)\n\n`
      );
    } else if (info.gas === 'infinite') {
      hoverMd.appendMarkdown('**Gas:** variable (depends on execution path)\n\n');
    } else {
      const complexity =
        info.gas < 50_000
          ? 'Low'
          : info.gas < 150_000
            ? 'Medium'
            : info.gas < 500_000
              ? 'High'
              : 'Very High';
      hoverMd.appendMarkdown(`**Gas:** ${info.gas.toLocaleString()} (${complexity})\n\n`);
    }

    hoverMd.appendMarkdown(`${info.visibility} | ${info.stateMutability}\n\n`);

    if (info.warnings.length > 0) {
      for (const w of info.warnings) {
        hoverMd.appendMarkdown(`> ${w}\n`);
      }
    }

    decorations.push({
      range,
      renderOptions: {
        after: {
          contentText: decorationText,
          color,
          fontStyle: 'normal',
          fontWeight: 'bold',
          margin: '0 0 0 0.5em',
        },
      },
      hoverMessage: hoverMd,
    });
  }

  return decorations;
}

/**
 * Create inline complexity decorations.
 */
export function createComplexityDecorations(
  analysis: DecorationAnalysis,
  document: vscode.TextDocument
): vscode.DecorationOptions[] {
  const decorations: vscode.DecorationOptions[] = [];
  const content = document.getText();
  const contentHash = getContentHash(content);

  analysis.complexityMetrics.forEach((metrics, funcName) => {
    const match = getCachedMatch(content, contentHash, funcName);

    if (match && metrics.rating !== 'A') {
      const position = document.positionAt(match.index);
      const lineEndPos = document.lineAt(position.line).range.end;
      decorations.push({
        range: new vscode.Range(position, lineEndPos),
        renderOptions: {
          after: {
            contentText: ` 🔧 ${metrics.rating} (CC: ${metrics.cyclomaticComplexity})`,
            color: getComplexityColor(metrics.rating),
            margin: '0 0 0 1em',
            fontStyle: 'italic',
          },
        },
      });
    }
  });

  return decorations;
}

/**
 * Get inline gas cost inlay hints (non-selectable, Remix-style — after opening brace).
 */
export function createGasInlayHints(
  analysis: DecorationAnalysis,
  document: vscode.TextDocument
): vscode.InlayHint[] {
  const hints: vscode.InlayHint[] = [];
  const content = document.getText();
  const contentHash = getContentHash(content);
  const isPending = analysis.isPending === true;

  analysis.gasEstimates.forEach((estimate, funcName) => {
    const { displayName, isEvent } = buildFuncMatch(funcName);
    const match = getCachedMatch(content, contentHash, funcName);

    if (match) {
      const hintPos = findHintPosition(content, match, isEvent, document);
      const gasAmount = estimate.estimatedGas.average;
      const hasPendingGas = isPending || gasAmount === 0;

      const gasAmountStr = formatGas(gasAmount, hasPendingGas);
      const minGasStr = formatGas(estimate.estimatedGas.min, hasPendingGas);
      const maxGasStr = formatGas(estimate.estimatedGas.max, hasPendingGas);

      const hintText = hasPendingGas
        ? ` ⏳ ${estimate.selector} | compiling... `
        : ` ⛽ ${gasAmountStr} gas | ${estimate.selector} `;

      const hint = new vscode.InlayHint(hintPos, hintText, vscode.InlayHintKind.Parameter);

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
 * Generate hover information for a function at a given position.
 */
export function createHoverInfo(
  position: vscode.Position,
  analysis: DecorationAnalysis,
  document: vscode.TextDocument
): vscode.Hover | null {
  const wordRange = document.getWordRangeAtPosition(position);
  if (!wordRange) {
    return null;
  }

  const word = document.getText(wordRange);
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
