/**
 * Gas Regression Tracker - Git-aware gas analysis
 * Compare gas costs across branches and commits (lightweight)
 */

import * as vscode from 'vscode';
import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import { promisify } from 'util';

const exec = promisify(childProcess.exec);

export interface GasSnapshot {
  commitHash: string;
  commitMessage: string;
  timestamp: number;
  branch: string;
  functions: Map<string, FunctionGasData>;
  totalGas: number;
}

export interface FunctionGasData {
  signature: string;
  gas: number;
  source: 'solc' | 'heuristic';
  complexity: string;
}

export interface GasRegression {
  function: string;
  oldGas: number;
  newGas: number;
  change: number;
  percentChange: number;
  severity: 'improvement' | 'minor' | 'major' | 'critical';
}

export interface RegressionReport {
  comparing: {
    from: string; // commit/branch
    to: string;
  };
  regressions: GasRegression[];
  improvements: GasRegression[];
  totalGasChange: number;
  totalPercentChange: number;
  summary: {
    improved: number;
    regressed: number;
    unchanged: number;
  };
}

export class GasRegressionTracker {
  private snapshotCache: Map<string, GasSnapshot> = new Map();
  private readonly CACHE_DIR = '.sigscan-cache';

  /**
   * Create gas snapshot for current state
   */
  public createSnapshot(
    gasData: Map<
      string,
      { signature: string; gas: number; source: 'solc' | 'heuristic'; complexity: string }
    >,
    workspaceRoot: string
  ): Promise<GasSnapshot> {
    return this.createSnapshotForCommit(gasData, workspaceRoot, 'HEAD');
  }

  /**
   * Create gas snapshot for specific commit
   */
  public async createSnapshotForCommit(
    gasData: Map<
      string,
      { signature: string; gas: number; source: 'solc' | 'heuristic'; complexity: string }
    >,
    workspaceRoot: string,
    commit: string
  ): Promise<GasSnapshot> {
    const gitInfo = await this.getGitInfo(workspaceRoot, commit);

    const snapshot: GasSnapshot = {
      commitHash: gitInfo.hash,
      commitMessage: gitInfo.message,
      timestamp: Date.now(),
      branch: gitInfo.branch,
      functions: new Map(gasData),
      totalGas: Array.from(gasData.values()).reduce((sum, fn) => sum + fn.gas, 0),
    };

    // Cache snapshot
    const cacheKey = this.getCacheKey(gitInfo.hash);
    this.snapshotCache.set(cacheKey, snapshot);

    return snapshot;
  }

  /**
   * Compare current state with another commit/branch
   */
  public async compareWithCommit(
    currentGasData: Map<
      string,
      { signature: string; gas: number; source: 'solc' | 'heuristic'; complexity: string }
    >,
    workspaceRoot: string,
    targetCommit = 'main'
  ): Promise<RegressionReport> {
    const currentSnapshot = await this.createSnapshotForCommit(
      currentGasData,
      workspaceRoot,
      'HEAD'
    );
    const targetSnapshot = await this.getOrFetchSnapshot(workspaceRoot, targetCommit);

    return this.generateRegressionReport(currentSnapshot, targetSnapshot);
  }

  /**
   * Compare two snapshots
   */
  private generateRegressionReport(
    newSnapshot: GasSnapshot,
    oldSnapshot: GasSnapshot
  ): RegressionReport {
    const regressions: GasRegression[] = [];
    const improvements: GasRegression[] = [];

    let improved = 0;
    let regressed = 0;
    let unchanged = 0;

    // Compare each function
    newSnapshot.functions.forEach((newData, funcName) => {
      const oldData = oldSnapshot.functions.get(funcName);

      if (!oldData) {
        // New function added
        return;
      }

      const change = newData.gas - oldData.gas;
      const percentChange = (change / oldData.gas) * 100;

      if (Math.abs(change) < 100) {
        // Less than 100 gas change - consider unchanged
        unchanged++;
        return;
      }

      const regression: GasRegression = {
        function: funcName,
        oldGas: oldData.gas,
        newGas: newData.gas,
        change,
        percentChange,
        severity: this.calculateSeverity(percentChange, change),
      };

      if (change > 0) {
        regressions.push(regression);
        regressed++;
      } else {
        improvements.push(regression);
        improved++;
      }
    });

    // Sort by absolute change
    regressions.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
    improvements.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

    const totalGasChange = newSnapshot.totalGas - oldSnapshot.totalGas;
    const totalPercentChange = (totalGasChange / oldSnapshot.totalGas) * 100;

    return {
      comparing: {
        from: `${oldSnapshot.branch}@${oldSnapshot.commitHash.substring(0, 7)}`,
        to: `${newSnapshot.branch}@${newSnapshot.commitHash.substring(0, 7)}`,
      },
      regressions,
      improvements,
      totalGasChange,
      totalPercentChange,
      summary: {
        improved,
        regressed,
        unchanged,
      },
    };
  }

  /**
   * Calculate regression severity
   */
  private calculateSeverity(
    percentChange: number,
    absoluteChange: number
  ): 'improvement' | 'minor' | 'major' | 'critical' {
    const absPercent = Math.abs(percentChange);
    const absChange = Math.abs(absoluteChange);

    if (percentChange < 0) {
      return 'improvement';
    }

    if (absPercent > 50 || absChange > 100000) {
      return 'critical';
    }

    if (absPercent > 20 || absChange > 50000) {
      return 'major';
    }

    if (absPercent > 5 || absChange > 10000) {
      return 'minor';
    }

    return 'minor';
  }

  /**
   * Get or fetch snapshot for commit
   */
  private async getOrFetchSnapshot(workspaceRoot: string, commit: string): Promise<GasSnapshot> {
    const gitInfo = await this.getGitInfo(workspaceRoot, commit);
    const cacheKey = this.getCacheKey(gitInfo.hash);

    // Check cache
    if (this.snapshotCache.has(cacheKey)) {
      return this.snapshotCache.get(cacheKey)!;
    }

    // For now, return empty snapshot (in full implementation, would checkout and analyze)
    // This keeps it lightweight - real analysis would be expensive
    return {
      commitHash: gitInfo.hash,
      commitMessage: gitInfo.message,
      timestamp: Date.now(),
      branch: gitInfo.branch,
      functions: new Map(),
      totalGas: 0,
    };
  }

  /**
   * Get git information
   */
  private async getGitInfo(
    workspaceRoot: string,
    commit: string
  ): Promise<{ hash: string; message: string; branch: string }> {
    try {
      const { stdout: hash } = await exec(`git rev-parse ${commit}`, { cwd: workspaceRoot });
      const { stdout: message } = await exec(`git log -1 --pretty=%B ${commit}`, {
        cwd: workspaceRoot,
      });
      const { stdout: branch } = await exec(`git rev-parse --abbrev-ref HEAD`, {
        cwd: workspaceRoot,
      });

      return {
        hash: hash.trim(),
        message: message.trim(),
        branch: branch.trim(),
      };
    } catch (error) {
      throw new Error(`Failed to get git info: ${error}`);
    }
  }

  /**
   * Get cache key for snapshot
   */
  private getCacheKey(commitHash: string): string {
    return crypto.createHash('sha256').update(commitHash).digest('hex');
  }

  /**
   * Track gas trends over time (last N commits)
   */
  public async trackTrends(
    workspaceRoot: string,
    functionName: string,
    commits = 10
  ): Promise<Array<{ commit: string; message: string; gas: number; date: Date }>> {
    try {
      const { stdout } = await exec(`git log -${commits} --pretty=format:"%H|%s|%at"`, {
        cwd: workspaceRoot,
      });

      const commitData = stdout
        .trim()
        .split('\n')
        .map((line) => {
          const [hash, message, timestamp] = line.split('|');
          return {
            commit: hash.substring(0, 7),
            message,
            date: new Date(parseInt(timestamp) * 1000),
            gas: 0, // Would need to analyze each commit
          };
        });

      return commitData;
    } catch (error) {
      return [];
    }
  }

  /**
   * Generate markdown report
   */
  public generateReport(report: RegressionReport): string {
    let md = `# 📈 Gas Regression Report\n\n`;

    md += `## Comparison\n\n`;
    md += `- **From**: ${report.comparing.from}\n`;
    md += `- **To**: ${report.comparing.to}\n`;
    md += `- **Total Change**: ${report.totalGasChange > 0 ? '+' : ''}${report.totalGasChange.toLocaleString()} gas (${report.totalPercentChange > 0 ? '+' : ''}${report.totalPercentChange.toFixed(2)}%)\n\n`;

    // Summary
    md += `## Summary\n\n`;
    md += `| Status | Count |\n`;
    md += `|--------|-------|\n`;
    md += `| ✅ Improved | ${report.summary.improved} |\n`;
    md += `| ⚠️ Regressed | ${report.summary.regressed} |\n`;
    md += `| ➖ Unchanged | ${report.summary.unchanged} |\n\n`;

    // Regressions
    if (report.regressions.length > 0) {
      md += `## ⚠️ Regressions (${report.regressions.length})\n\n`;
      md += `| Function | Old Gas | New Gas | Change | % | Severity |\n`;
      md += `|----------|---------|---------|--------|---|----------|\n`;

      report.regressions.forEach((reg) => {
        const icon = reg.severity === 'critical' ? '🔴' : reg.severity === 'major' ? '🟠' : '🟡';
        md += `| ${icon} ${reg.function} | ${reg.oldGas.toLocaleString()} | ${reg.newGas.toLocaleString()} | +${reg.change.toLocaleString()} | +${reg.percentChange.toFixed(1)}% | ${reg.severity} |\n`;
      });
      md += '\n';
    }

    // Improvements
    if (report.improvements.length > 0) {
      md += `## ✅ Improvements (${report.improvements.length})\n\n`;
      md += `| Function | Old Gas | New Gas | Change | % |\n`;
      md += `|----------|---------|---------|--------|---|\n`;

      report.improvements.forEach((imp) => {
        md += `| 🟢 ${imp.function} | ${imp.oldGas.toLocaleString()} | ${imp.newGas.toLocaleString()} | ${imp.change.toLocaleString()} | ${imp.percentChange.toFixed(1)}% |\n`;
      });
      md += '\n';
    }

    // Recommendations
    if (report.regressions.length > 0) {
      md += `## 🎯 Recommendations\n\n`;

      const critical = report.regressions.filter((r) => r.severity === 'critical');
      if (critical.length > 0) {
        md += `### Critical Issues (${critical.length})\n\n`;
        critical.forEach((reg) => {
          md += `- **${reg.function}**: +${reg.change.toLocaleString()} gas (+${reg.percentChange.toFixed(1)}%) - Review implementation changes\n`;
        });
        md += '\n';
      }

      const major = report.regressions.filter((r) => r.severity === 'major');
      if (major.length > 0) {
        md += `### Major Issues (${major.length})\n\n`;
        major.forEach((reg) => {
          md += `- **${reg.function}**: +${reg.change.toLocaleString()} gas (+${reg.percentChange.toFixed(1)}%)\n`;
        });
        md += '\n';
      }
    }

    return md;
  }

  /**
   * Create inline decorations for regressions
   */
  public createRegressionDecorations(
    regressions: GasRegression[],
    improvements: GasRegression[],
    document: vscode.TextDocument
  ): vscode.DecorationOptions[] {
    const decorations: vscode.DecorationOptions[] = [];
    const content = document.getText();

    // Mark regressions
    regressions.forEach((reg) => {
      const pattern = new RegExp(`function\\s+${reg.function}\\s*\\(`);
      const match = pattern.exec(content);

      if (match) {
        const position = document.positionAt(match.index + match[0].length);

        const icon = reg.severity === 'critical' ? '🔴' : reg.severity === 'major' ? '🟠' : '🟡';

        const decoration: vscode.DecorationOptions = {
          range: new vscode.Range(position, position),
          renderOptions: {
            after: {
              contentText: ` ${icon} +${reg.change.toLocaleString()} gas (${reg.percentChange > 0 ? '+' : ''}${reg.percentChange.toFixed(1)}%)`,
              color: '#ef4444',
              fontStyle: 'italic',
              margin: '0 0 0 1em',
            },
          },
          hoverMessage: new vscode.MarkdownString(
            `**Gas Regression**\n\n` +
              `- Old: ${reg.oldGas.toLocaleString()} gas\n` +
              `- New: ${reg.newGas.toLocaleString()} gas\n` +
              `- Change: +${reg.change.toLocaleString()} gas (+${reg.percentChange.toFixed(1)}%)\n` +
              `- Severity: **${reg.severity.toUpperCase()}**`
          ),
        };

        decorations.push(decoration);
      }
    });

    // Mark improvements
    improvements.forEach((imp) => {
      const pattern = new RegExp(`function\\s+${imp.function}\\s*\\(`);
      const match = pattern.exec(content);

      if (match) {
        const position = document.positionAt(match.index + match[0].length);

        const decoration: vscode.DecorationOptions = {
          range: new vscode.Range(position, position),
          renderOptions: {
            after: {
              contentText: ` 🟢 ${imp.change.toLocaleString()} gas (${imp.percentChange.toFixed(1)}%)`,
              color: '#4ade80',
              fontStyle: 'italic',
              margin: '0 0 0 1em',
            },
          },
          hoverMessage: new vscode.MarkdownString(
            `**Gas Improvement**\n\n` +
              `- Old: ${imp.oldGas.toLocaleString()} gas\n` +
              `- New: ${imp.newGas.toLocaleString()} gas\n` +
              `- Saved: ${Math.abs(imp.change).toLocaleString()} gas (${Math.abs(imp.percentChange).toFixed(1)}%)`
          ),
        };

        decorations.push(decoration);
      }
    });

    return decorations;
  }

  /**
   * Check if workspace is a git repository
   */
  public async isGitRepository(workspaceRoot: string): Promise<boolean> {
    try {
      await exec('git rev-parse --git-dir', { cwd: workspaceRoot });
      return true;
    } catch {
      return false;
    }
  }
}
