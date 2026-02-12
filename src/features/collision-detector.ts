/**
 * Selector Collision Detector
 *
 * Detects 4-byte function selector collisions across contracts in a project.
 * This is critical for proxy contracts and the EIP-2535 Diamond pattern, where
 * multiple facets/implementation contracts share the same proxy address and
 * selector collisions can cause unexpected delegatecall routing.
 */

import { ContractInfo, CollisionResult } from '../types';

export class CollisionDetector {
  /**
   * Detect function selector collisions across all contracts in a project.
   *
   * Builds an index of selector -> function entries across every contract,
   * then returns entries where two or more distinct function signatures
   * share the same 4-byte selector.
   *
   * @param contracts - Map of contract file paths to ContractInfo objects
   * @returns Array of CollisionResult, one per colliding selector
   */
  public detectCollisions(contracts: Map<string, ContractInfo>): CollisionResult[] {
    // Build a map of selector -> all functions that produce that selector
    const selectorIndex = new Map<
      string,
      Array<{
        name: string;
        signature: string;
        contractName: string;
        filePath: string;
      }>
    >();

    for (const [, contractInfo] of contracts) {
      for (const func of contractInfo.functions) {
        // Skip internal/private functions -- they don't have on-chain selectors
        if (func.visibility === 'internal' || func.visibility === 'private') {
          continue;
        }

        // Skip constructors and modifiers -- they don't participate in selector dispatch
        if (func.name === 'constructor' || func.name.startsWith('modifier:')) {
          continue;
        }

        const selector = func.selector.toLowerCase();

        if (!selectorIndex.has(selector)) {
          selectorIndex.set(selector, []);
        }

        const entry = selectorIndex.get(selector);
        if (entry) {
          entry.push({
            name: func.name,
            signature: func.signature,
            contractName: func.contractName,
            filePath: func.filePath,
          });
        }
      }
    }

    // Filter to only selectors with multiple entries
    const collisions: CollisionResult[] = [];

    for (const [selector, functions] of selectorIndex) {
      if (functions.length < 2) {
        continue;
      }

      // Deduplicate: the same signature appearing in multiple contracts is expected
      // (e.g. interface + implementation). Only flag when the actual canonical
      // signatures differ but produce the same 4-byte selector.
      const uniqueSignatures = new Set(functions.map((f) => f.signature));

      if (uniqueSignatures.size >= 2) {
        collisions.push({
          selector,
          functions,
        });
      }
    }

    // Sort by selector for deterministic output
    collisions.sort((a, b) => a.selector.localeCompare(b.selector));

    return collisions;
  }

  /**
   * Detect collisions within a single contract (e.g. inherited function clashes).
   *
   * @param contractInfo - A single contract's parsed information
   * @returns Array of CollisionResult for intra-contract collisions
   */
  public detectIntraContractCollisions(contractInfo: ContractInfo): CollisionResult[] {
    const singleContractMap = new Map<string, ContractInfo>();
    singleContractMap.set(contractInfo.filePath, contractInfo);

    // For intra-contract, we flag even same-signature duplicates
    const selectorIndex = new Map<
      string,
      Array<{
        name: string;
        signature: string;
        contractName: string;
        filePath: string;
      }>
    >();

    for (const func of contractInfo.functions) {
      if (func.visibility === 'internal' || func.visibility === 'private') {
        continue;
      }
      if (func.name === 'constructor' || func.name.startsWith('modifier:')) {
        continue;
      }

      const selector = func.selector.toLowerCase();

      if (!selectorIndex.has(selector)) {
        selectorIndex.set(selector, []);
      }

      const entry = selectorIndex.get(selector);
      if (entry) {
        entry.push({
          name: func.name,
          signature: func.signature,
          contractName: func.contractName,
          filePath: func.filePath,
        });
      }
    }

    const collisions: CollisionResult[] = [];

    for (const [selector, functions] of selectorIndex) {
      if (functions.length >= 2) {
        collisions.push({ selector, functions });
      }
    }

    collisions.sort((a, b) => a.selector.localeCompare(b.selector));

    return collisions;
  }

  /**
   * Generate a human-readable collision report.
   *
   * @param collisions - Array of detected collisions
   * @returns Markdown-formatted report string
   */
  public generateReport(collisions: CollisionResult[]): string {
    if (collisions.length === 0) {
      return '# Selector Collision Report\n\nNo selector collisions detected.\n';
    }

    let report = '# Selector Collision Report\n\n';
    report += `**${collisions.length} collision(s) detected**\n\n`;
    report +=
      'Selector collisions can cause critical issues in proxy contracts and the Diamond pattern (EIP-2535). ';
    report +=
      'When two functions share the same 4-byte selector, the proxy cannot distinguish between them.\n\n';

    for (const collision of collisions) {
      report += `## Selector: \`${collision.selector}\`\n\n`;
      report += '| Function | Signature | Contract | File |\n';
      report += '|----------|-----------|----------|------|\n';

      for (const func of collision.functions) {
        report += `| ${func.name} | \`${func.signature}\` | ${func.contractName} | ${func.filePath} |\n`;
      }

      report += '\n';
    }

    return report;
  }
}
