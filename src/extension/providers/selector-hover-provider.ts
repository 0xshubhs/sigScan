/**
 * Selector Hover Provider
 *
 * A VS Code HoverProvider that activates when the cursor hovers over a
 * 4-byte function selector pattern (0x[a-fA-F0-9]{8}). Performs reverse
 * lookup against known selectors discovered during project scanning and
 * displays the matching function signature in a hover tooltip.
 */

import * as vscode from 'vscode';

/**
 * Regex matching a 4-byte (8 hex character) selector, with or without the 0x prefix.
 * Captures the full selector including the 0x prefix.
 */
const SELECTOR_PATTERN = /0x[a-fA-F0-9]{8}\b/;

export class SelectorHoverProvider implements vscode.HoverProvider {
  /**
   * Map of lowercase 4-byte selector (e.g. "0xa9059cbb") to its canonical
   * function signature (e.g. "transfer(address,uint256)").
   */
  private knownSelectors: Map<string, string> = new Map();

  /**
   * Optional extended metadata: selector -> { contractName, filePath, visibility }
   */
  private selectorMetadata: Map<
    string,
    Array<{ contractName: string; filePath: string; visibility: string }>
  > = new Map();

  /**
   * Update the selector lookup table.
   *
   * Call this after each project scan to keep the hover data in sync
   * with the latest parsed contracts.
   *
   * @param selectors - Map of selector (e.g. "0xa9059cbb") to function signature
   */
  public updateSelectors(selectors: Map<string, string>): void {
    this.knownSelectors = new Map();
    for (const [selector, signature] of selectors) {
      this.knownSelectors.set(selector.toLowerCase(), signature);
    }
  }

  /**
   * Update the extended metadata for selectors.
   *
   * Provides additional context (contract name, file path) shown in the hover.
   *
   * @param metadata - Map of selector to array of contract locations
   */
  public updateSelectorMetadata(
    metadata: Map<string, Array<{ contractName: string; filePath: string; visibility: string }>>
  ): void {
    this.selectorMetadata = new Map();
    for (const [selector, entries] of metadata) {
      this.selectorMetadata.set(selector.toLowerCase(), entries);
    }
  }

  /**
   * Provide a hover for a 4-byte selector at the given position.
   *
   * Scans the text around the cursor for a pattern matching `0x[a-fA-F0-9]{8}`.
   * If found and the selector is in the known lookup table, returns a
   * MarkdownString hover with the function signature and metadata.
   *
   * @param document - The document in which the hover was triggered
   * @param position - The position at which the hover was triggered
   * @returns A Hover object if a known selector is found, or null
   */
  public provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | null {
    // Get a range around the cursor that could contain a selector
    // A selector like 0xa9059cbb is 10 characters wide
    const range = document.getWordRangeAtPosition(position, /0x[a-fA-F0-9]{8}\b/);

    if (!range) {
      return null;
    }

    const word = document.getText(range);

    // Validate it matches the selector pattern
    if (!SELECTOR_PATTERN.test(word)) {
      return null;
    }

    const selector = word.toLowerCase();
    const signature = this.knownSelectors.get(selector);

    if (!signature) {
      // Selector not found in our database -- provide a minimal hover
      return new vscode.Hover(
        new vscode.MarkdownString(
          `**Selector:** \`${selector}\`\n\n_Unknown -- not found in scanned contracts_`
        ),
        range
      );
    }

    // Build rich hover content
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportHtml = true;

    md.appendMarkdown(`### Function Selector Lookup\n\n`);
    md.appendMarkdown(`**Selector:** \`${selector}\`\n\n`);
    md.appendMarkdown(`**Signature:** \`${signature}\`\n\n`);

    // Add metadata if available
    const metadata = this.selectorMetadata.get(selector);
    if (metadata && metadata.length > 0) {
      md.appendMarkdown(`**Found in:**\n\n`);

      for (const entry of metadata) {
        md.appendMarkdown(
          `- \`${entry.contractName}\` (${entry.visibility}) — ${entry.filePath}\n`
        );
      }

      md.appendMarkdown('\n');
    }

    // Add a note about collision risk if multiple contracts define this selector
    if (metadata && metadata.length > 1) {
      const uniqueSignatures = new Set<string>();
      for (const entry of metadata) {
        // We only have the canonical signature here, but note multi-contract usage
        uniqueSignatures.add(entry.contractName);
      }
      if (uniqueSignatures.size > 1) {
        md.appendMarkdown(
          `> **Note:** This selector is defined in ${uniqueSignatures.size} contracts. ` +
            `Verify there are no collisions in proxy/diamond patterns.\n\n`
        );
      }
    }

    return new vscode.Hover(md, range);
  }

  /**
   * Get the number of known selectors currently registered.
   *
   * @returns Count of known selectors
   */
  public getSelectorCount(): number {
    return this.knownSelectors.size;
  }

  /**
   * Look up a selector without the hover context.
   *
   * @param selector - 4-byte selector string (e.g. "0xa9059cbb")
   * @returns The function signature if known, or undefined
   */
  public lookupSelector(selector: string): string | undefined {
    return this.knownSelectors.get(selector.toLowerCase());
  }
}
