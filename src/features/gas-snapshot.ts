/**
 * Gas Snapshot Manager - Export/import gas snapshots for CI integration
 *
 * Provides snapshot-based gas regression testing:
 * - Create snapshots from gas analysis results with git metadata
 * - Export/import snapshots as JSON files
 * - Compare snapshots to detect gas regressions or improvements
 *
 * Designed for integration into CI pipelines (e.g., GitHub Actions) where
 * a baseline snapshot is committed and new snapshots are compared on each PR.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { SnapshotData, SnapshotDiff } from '../types';

/** Current snapshot format version for forward compatibility. */
const SNAPSHOT_VERSION = '1.0.0';

export class GasSnapshotManager {
  /**
   * Create a gas snapshot from gas analysis data.
   *
   * Enriches the snapshot with the current git commit hash and branch name
   * when available. If git information cannot be retrieved (e.g., not a git
   * repository or git is not installed), the snapshot is created without it.
   *
   * @param gasData - Array of gas analysis results per function
   * @param workspaceRoot - Optional workspace root path for running git commands
   * @returns A SnapshotData object containing gas data and metadata
   */
  public async createSnapshot(
    gasData: Array<{
      contractName: string;
      functionName: string;
      selector: string;
      gas: number;
    }>,
    workspaceRoot?: string
  ): Promise<SnapshotData> {
    let commitHash: string | undefined;
    let branch: string | undefined;

    try {
      const execOptions = workspaceRoot ? { cwd: workspaceRoot } : undefined;

      commitHash = execSync('git rev-parse HEAD', {
        ...execOptions,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      branch = execSync('git rev-parse --abbrev-ref HEAD', {
        ...execOptions,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      // Git is not available or not a git repository - continue without git info
    }

    const snapshot: SnapshotData = {
      version: SNAPSHOT_VERSION,
      timestamp: Date.now(),
      functions: gasData.map((entry) => ({
        contractName: entry.contractName,
        functionName: entry.functionName,
        selector: entry.selector,
        gas: entry.gas,
      })),
    };

    if (commitHash) {
      snapshot.commitHash = commitHash;
    }
    if (branch) {
      snapshot.branch = branch;
    }

    return snapshot;
  }

  /**
   * Export a snapshot to a JSON file.
   *
   * Creates any necessary parent directories before writing. The output
   * is formatted with 2-space indentation for human readability and
   * clean git diffs.
   *
   * @param snapshot - The snapshot data to export
   * @param filePath - Absolute or relative path for the output JSON file
   */
  public exportSnapshot(snapshot: SnapshotData, filePath: string): void {
    const resolvedPath = path.resolve(filePath);
    const dir = path.dirname(resolvedPath);

    // Ensure the output directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const json = JSON.stringify(snapshot, null, 2) + '\n';
    fs.writeFileSync(resolvedPath, json, 'utf-8');
  }

  /**
   * Import a snapshot from a JSON file.
   *
   * Validates that the file exists and contains valid snapshot data.
   * Throws an error if the file is missing or contains invalid JSON.
   *
   * @param filePath - Path to the snapshot JSON file
   * @returns The parsed SnapshotData
   * @throws Error if the file does not exist or contains invalid data
   */
  public importSnapshot(filePath: string): SnapshotData {
    const resolvedPath = path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Snapshot file not found: ${resolvedPath}`);
    }

    const raw = fs.readFileSync(resolvedPath, 'utf-8');

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Invalid JSON in snapshot file: ${resolvedPath}. ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Validate basic structure
    const snapshot = parsed as SnapshotData;
    if (!snapshot.version || !Array.isArray(snapshot.functions)) {
      throw new Error(
        `Invalid snapshot format in ${resolvedPath}: missing 'version' or 'functions' field.`
      );
    }

    return snapshot;
  }

  /**
   * Compare two snapshots and produce a diff report.
   *
   * Identifies functions that were added (present in current but not baseline),
   * removed (present in baseline but not current), and changed (present in both
   * but with different gas values exceeding the threshold).
   *
   * Functions are matched by the composite key of contractName + functionName + selector.
   *
   * @param baseline - The baseline (older) snapshot to compare against
   * @param current - The current (newer) snapshot
   * @param threshold - Percentage change threshold to flag as "changed" (default: 5%)
   * @returns A SnapshotDiff describing added, removed, and changed functions
   */
  public compareSnapshots(
    baseline: SnapshotData,
    current: SnapshotData,
    threshold = 5
  ): SnapshotDiff {
    // Build lookup maps keyed by "contractName::functionName::selector"
    const baselineMap = new Map<string, SnapshotData['functions'][number]>();
    for (const entry of baseline.functions) {
      const key = this.makeKey(entry.contractName, entry.functionName, entry.selector);
      baselineMap.set(key, entry);
    }

    const currentMap = new Map<string, SnapshotData['functions'][number]>();
    for (const entry of current.functions) {
      const key = this.makeKey(entry.contractName, entry.functionName, entry.selector);
      currentMap.set(key, entry);
    }

    const added: SnapshotDiff['added'] = [];
    const removed: SnapshotDiff['removed'] = [];
    const changed: SnapshotDiff['changed'] = [];

    // Find added and changed entries
    for (const [key, currentEntry] of currentMap.entries()) {
      const baselineEntry = baselineMap.get(key);

      if (!baselineEntry) {
        added.push(currentEntry);
      } else {
        // Compute percentage change
        const oldGas = baselineEntry.gas;
        const newGas = currentEntry.gas;

        // Avoid division by zero
        let changePercent: number;
        if (oldGas === 0 && newGas === 0) {
          changePercent = 0;
        } else if (oldGas === 0) {
          changePercent = 100; // Went from 0 to non-zero
        } else {
          changePercent = ((newGas - oldGas) / oldGas) * 100;
        }

        // Only include if change exceeds threshold
        if (Math.abs(changePercent) >= threshold) {
          changed.push({
            contractName: currentEntry.contractName,
            functionName: currentEntry.functionName,
            selector: currentEntry.selector,
            oldGas,
            newGas,
            changePercent: parseFloat(changePercent.toFixed(2)),
          });
        }
      }
    }

    // Find removed entries
    for (const [key, baselineEntry] of baselineMap.entries()) {
      if (!currentMap.has(key)) {
        removed.push(baselineEntry);
      }
    }

    // Sort changed entries by absolute change percent (largest regressions first)
    changed.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));

    return { added, removed, changed };
  }

  /**
   * Generate a human-readable markdown report from a snapshot diff.
   *
   * Useful for posting as a PR comment in CI pipelines.
   *
   * @param diff - The snapshot diff to format
   * @param baseline - The baseline snapshot (for metadata)
   * @param current - The current snapshot (for metadata)
   * @returns Markdown-formatted report string
   */
  public generateDiffReport(
    diff: SnapshotDiff,
    baseline: SnapshotData,
    current: SnapshotData
  ): string {
    let report = '# Gas Snapshot Comparison\n\n';

    // Metadata
    if (baseline.commitHash || current.commitHash) {
      report += '| | Baseline | Current |\n';
      report += '|---|---|---|\n';
      if (baseline.commitHash || current.commitHash) {
        report += `| Commit | ${baseline.commitHash?.substring(0, 8) ?? 'N/A'} | ${current.commitHash?.substring(0, 8) ?? 'N/A'} |\n`;
      }
      if (baseline.branch || current.branch) {
        report += `| Branch | ${baseline.branch ?? 'N/A'} | ${current.branch ?? 'N/A'} |\n`;
      }
      report += '\n';
    }

    // Summary
    const regressions = diff.changed.filter((c) => c.changePercent > 0);
    const improvements = diff.changed.filter((c) => c.changePercent < 0);

    report += '## Summary\n\n';
    report += `- **Added**: ${diff.added.length} function(s)\n`;
    report += `- **Removed**: ${diff.removed.length} function(s)\n`;
    report += `- **Regressions**: ${regressions.length} function(s) (gas increased)\n`;
    report += `- **Improvements**: ${improvements.length} function(s) (gas decreased)\n\n`;

    // Changed (regressions first, then improvements)
    if (diff.changed.length > 0) {
      report += '## Gas Changes\n\n';
      report += '| Contract | Function | Selector | Old Gas | New Gas | Change |\n';
      report += '|----------|----------|----------|---------|---------|--------|\n';

      for (const entry of diff.changed) {
        const sign = entry.changePercent > 0 ? '+' : '';
        const indicator = entry.changePercent > 0 ? 'regression' : 'improvement';
        report += `| ${entry.contractName} | ${entry.functionName} | \`${entry.selector}\` | ${entry.oldGas.toLocaleString()} | ${entry.newGas.toLocaleString()} | ${sign}${entry.changePercent}% (${indicator}) |\n`;
      }
      report += '\n';
    }

    // Added
    if (diff.added.length > 0) {
      report += '## New Functions\n\n';
      report += '| Contract | Function | Selector | Gas |\n';
      report += '|----------|----------|----------|-----|\n';
      for (const entry of diff.added) {
        report += `| ${entry.contractName} | ${entry.functionName} | \`${entry.selector}\` | ${entry.gas.toLocaleString()} |\n`;
      }
      report += '\n';
    }

    // Removed
    if (diff.removed.length > 0) {
      report += '## Removed Functions\n\n';
      report += '| Contract | Function | Selector | Gas |\n';
      report += '|----------|----------|----------|-----|\n';
      for (const entry of diff.removed) {
        report += `| ${entry.contractName} | ${entry.functionName} | \`${entry.selector}\` | ${entry.gas.toLocaleString()} |\n`;
      }
      report += '\n';
    }

    if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
      report += 'No significant gas changes detected.\n';
    }

    return report;
  }

  /**
   * Create a composite key for matching functions across snapshots.
   */
  private makeKey(contractName: string, functionName: string, selector: string): string {
    return `${contractName}::${functionName}::${selector}`;
  }
}
