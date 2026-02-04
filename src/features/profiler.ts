/**
 * Runtime Profiler Enhancement - Parse forge test reports and compare with estimates
 * Actual vs estimated gas analysis (lightweight)
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface ForgeGasReport {
  contract: string;
  tests: Map<string, TestGasData>;
  deploymentCost: number;
}

export interface TestGasData {
  testName: string;
  functionsCalled: FunctionCallData[];
  totalGas: number;
  avgGas: number;
  calls: number;
}

export interface FunctionCallData {
  name: string;
  actualGas: number;
  estimatedGas?: number;
  accuracy?: number; // Percentage accuracy
  deviation?: number; // Difference
}

export interface GasComparison {
  function: string;
  estimated: number;
  actual: number;
  deviation: number;
  accuracy: number;
  status: 'accurate' | 'underestimated' | 'overestimated';
}

export interface ProfilerReport {
  totalTests: number;
  functionsAnalyzed: number;
  comparisons: GasComparison[];
  overallAccuracy: number;
  avgDeviation: number;
  mostExpensiveTests: TestGasData[];
}

export class RuntimeProfiler {
  /**
   * Parse forge test gas report (lightweight - no test execution)
   */
  public async parseForgeGasReport(workspaceRoot: string): Promise<ForgeGasReport[]> {
    const reports: ForgeGasReport[] = [];

    try {
      // Look for .gas-snapshot file (forge-std gas reporting)
      const snapshotPath = path.join(workspaceRoot, '.gas-snapshot');
      if (fs.existsSync(snapshotPath)) {
        const content = fs.readFileSync(snapshotPath, 'utf-8');
        reports.push(...this.parseGasSnapshot(content));
      }

      // Also look for forge test output
      const testOutputPath = path.join(workspaceRoot, 'forge-test-output.txt');
      if (fs.existsSync(testOutputPath)) {
        const content = fs.readFileSync(testOutputPath, 'utf-8');
        reports.push(...this.parseForgeTestOutput(content));
      }
    } catch (error) {
      // Fail silently - user might not have run tests yet
    }

    return reports;
  }

  /**
   * Parse .gas-snapshot file
   */
  private parseGasSnapshot(content: string): ForgeGasReport[] {
    const reports: ForgeGasReport[] = [];
    const lines = content.split('\n');

    let currentContract = '';
    const tests = new Map<string, TestGasData>();

    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }

      // Format: ContractTest:testFunction() (gas: 123456)
      const match = line.match(/^(\w+):(\w+)\(\)\s+\(gas:\s+(\d+)\)$/);
      if (match) {
        const [, contract, testName, gas] = match;

        if (contract !== currentContract) {
          if (currentContract && tests.size > 0) {
            reports.push({
              contract: currentContract,
              tests: new Map(tests),
              deploymentCost: 0,
            });
            tests.clear();
          }
          currentContract = contract;
        }

        tests.set(testName, {
          testName,
          functionsCalled: [],
          totalGas: parseInt(gas),
          avgGas: parseInt(gas),
          calls: 1,
        });
      }
    }

    // Add last contract
    if (currentContract && tests.size > 0) {
      reports.push({
        contract: currentContract,
        tests: new Map(tests),
        deploymentCost: 0,
      });
    }

    return reports;
  }

  /**
   * Parse forge test --gas-report output
   */
  private parseForgeTestOutput(content: string): ForgeGasReport[] {
    const reports: ForgeGasReport[] = [];

    // Extract gas report tables
    const gasReportPattern = /\|\s+Contract\s+\|\s+Function.*?\n([\s\S]*?)(?:\n\n|\n\|)/g;
    let match;

    while ((match = gasReportPattern.exec(content)) !== null) {
      const tableContent = match[1];
      const lines = tableContent.split('\n');

      const tests = new Map<string, TestGasData>();

      for (const line of lines) {
        if (line.includes('|')) {
          // Parse: | ContractName | functionName | 123 | 456 | 789 | 10 |
          const parts = line
            .split('|')
            .map((p) => p.trim())
            .filter((p) => p.length > 0);

          if (parts.length >= 4 && !parts[0].includes('Contract')) {
            const [contract, funcName, min, avg, max, calls] = parts;

            tests.set(funcName, {
              testName: funcName,
              functionsCalled: [
                {
                  name: funcName,
                  actualGas: parseInt(avg) || 0,
                },
              ],
              totalGas: parseInt(avg) || 0,
              avgGas: parseInt(avg) || 0,
              calls: parseInt(calls) || 1,
            });

            if (reports.length === 0 || reports[reports.length - 1].contract !== contract) {
              reports.push({
                contract,
                tests,
                deploymentCost: 0,
              });
            }
          }
        }
      }
    }

    return reports;
  }

  /**
   * Compare estimates with actual gas usage
   */
  public compareEstimates(
    forgeReports: ForgeGasReport[],
    estimates: Map<string, { gas: number; signature: string }>
  ): ProfilerReport {
    const comparisons: GasComparison[] = [];
    let totalDeviation = 0;
    let totalAccuracy = 0;
    let count = 0;

    forgeReports.forEach((report) => {
      report.tests.forEach((test) => {
        test.functionsCalled.forEach((call) => {
          const estimate = estimates.get(call.name);

          if (estimate) {
            const deviation = call.actualGas - estimate.gas;
            const accuracy = estimate.gas > 0 ? (1 - Math.abs(deviation) / estimate.gas) * 100 : 0;

            let status: 'accurate' | 'underestimated' | 'overestimated';
            if (Math.abs(accuracy - 100) < 10) {
              status = 'accurate';
            } else if (deviation > 0) {
              status = 'underestimated';
            } else {
              status = 'overestimated';
            }

            comparisons.push({
              function: call.name,
              estimated: estimate.gas,
              actual: call.actualGas,
              deviation,
              accuracy,
              status,
            });

            totalDeviation += Math.abs(deviation);
            totalAccuracy += accuracy;
            count++;
          }
        });
      });
    });

    // Sort by deviation
    comparisons.sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation));

    // Find most expensive tests
    const allTests: TestGasData[] = [];
    forgeReports.forEach((report) => {
      report.tests.forEach((test) => allTests.push(test));
    });
    allTests.sort((a, b) => b.totalGas - a.totalGas);
    const mostExpensiveTests = allTests.slice(0, 10);

    return {
      totalTests: allTests.length,
      functionsAnalyzed: count,
      comparisons,
      overallAccuracy: count > 0 ? totalAccuracy / count : 0,
      avgDeviation: count > 0 ? totalDeviation / count : 0,
      mostExpensiveTests,
    };
  }

  /**
   * Generate markdown report
   */
  public generateReport(profilerReport: ProfilerReport): string {
    let md = `# 🧪 Runtime Profiler Report\n\n`;

    md += `## Summary\n\n`;
    md += `- **Total Tests**: ${profilerReport.totalTests}\n`;
    md += `- **Functions Analyzed**: ${profilerReport.functionsAnalyzed}\n`;
    md += `- **Overall Accuracy**: ${profilerReport.overallAccuracy.toFixed(1)}%\n`;
    md += `- **Average Deviation**: ${profilerReport.avgDeviation.toLocaleString()} gas\n\n`;

    // Accuracy breakdown
    const accurate = profilerReport.comparisons.filter((c) => c.status === 'accurate').length;
    const under = profilerReport.comparisons.filter((c) => c.status === 'underestimated').length;
    const over = profilerReport.comparisons.filter((c) => c.status === 'overestimated').length;

    md += `### Estimation Quality\n\n`;
    md += `| Status | Count | % |\n`;
    md += `|--------|-------|---|\n`;
    const total = profilerReport.comparisons.length || 1;
    md += `| ✅ Accurate (±10%) | ${accurate} | ${((accurate / total) * 100).toFixed(1)}% |\n`;
    md += `| ⚠️ Underestimated | ${under} | ${((under / total) * 100).toFixed(1)}% |\n`;
    md += `| 📉 Overestimated | ${over} | ${((over / total) * 100).toFixed(1)}% |\n\n`;

    // Top deviations
    if (profilerReport.comparisons.length > 0) {
      md += `## 🎯 Top Deviations (Actual vs Estimated)\n\n`;
      md += `| Function | Estimated | Actual | Deviation | Accuracy | Status |\n`;
      md += `|----------|-----------|--------|-----------|----------|--------|\n`;

      profilerReport.comparisons.slice(0, 15).forEach((comp) => {
        const icon =
          comp.status === 'accurate' ? '✅' : comp.status === 'underestimated' ? '⚠️' : '📉';
        const devSign = comp.deviation > 0 ? '+' : '';
        md += `| ${icon} ${comp.function} | ${comp.estimated.toLocaleString()} | ${comp.actual.toLocaleString()} | ${devSign}${comp.deviation.toLocaleString()} | ${comp.accuracy.toFixed(1)}% | ${comp.status} |\n`;
      });
      md += '\n';
    }

    // Most expensive tests
    if (profilerReport.mostExpensiveTests.length > 0) {
      md += `## 💸 Most Expensive Tests\n\n`;
      md += `| Test | Total Gas | Avg Gas | Calls |\n`;
      md += `|------|-----------|---------|-------|\n`;

      profilerReport.mostExpensiveTests.forEach((test) => {
        md += `| ${test.testName} | ${test.totalGas.toLocaleString()} | ${test.avgGas.toLocaleString()} | ${test.calls} |\n`;
      });
      md += '\n';
    }

    // Recommendations
    md += `## 🎯 Recommendations\n\n`;

    const criticalUnderestimates = profilerReport.comparisons.filter(
      (c) => c.status === 'underestimated' && Math.abs(c.deviation) > 50000
    );

    if (criticalUnderestimates.length > 0) {
      md += `### Critical Underestimates\n\n`;
      criticalUnderestimates.forEach((comp) => {
        md += `- **${comp.function}**: Estimated ${comp.estimated.toLocaleString()} but actual ${comp.actual.toLocaleString()} (+${comp.deviation.toLocaleString()} gas)\n`;
      });
      md += '\n';
    }

    const optimizationTargets = profilerReport.mostExpensiveTests.slice(0, 5);
    if (optimizationTargets.length > 0) {
      md += `### Optimization Targets\n\n`;
      md += `Focus optimization efforts on these high-gas tests:\n\n`;
      optimizationTargets.forEach((test) => {
        md += `- **${test.testName}**: ${test.totalGas.toLocaleString()} gas\n`;
      });
      md += '\n';
    }

    return md;
  }

  /**
   * Create inline decorations for actual vs estimated
   */
  public createComparisonDecorations(
    comparisons: GasComparison[],
    document: vscode.TextDocument
  ): vscode.DecorationOptions[] {
    const decorations: vscode.DecorationOptions[] = [];
    const content = document.getText();

    comparisons.forEach((comp) => {
      const pattern = new RegExp(`function\\s+${comp.function}\\s*\\(`);
      const match = pattern.exec(content);

      if (match) {
        const position = document.positionAt(match.index + match[0].length);

        const icon =
          comp.status === 'accurate' ? '✅' : comp.status === 'underestimated' ? '⚠️' : '📉';
        const devSign = comp.deviation > 0 ? '+' : '';

        const decoration: vscode.DecorationOptions = {
          range: new vscode.Range(position, position),
          renderOptions: {
            after: {
              contentText: ` ${icon} Actual: ${comp.actual.toLocaleString()} (${devSign}${comp.deviation.toLocaleString()})`,
              color:
                comp.status === 'accurate'
                  ? '#4ade80'
                  : comp.status === 'underestimated'
                    ? '#fb923c'
                    : '#94a3b8',
              fontStyle: 'italic',
              margin: '0 0 0 1em',
            },
          },
          hoverMessage: new vscode.MarkdownString(
            `**Actual vs Estimated Gas**\n\n` +
              `- Estimated: ${comp.estimated.toLocaleString()} gas\n` +
              `- Actual: ${comp.actual.toLocaleString()} gas\n` +
              `- Deviation: ${devSign}${comp.deviation.toLocaleString()} gas\n` +
              `- Accuracy: ${comp.accuracy.toFixed(1)}%\n` +
              `- Status: **${comp.status.toUpperCase()}**`
          ),
        };

        decorations.push(decoration);
      }
    });

    return decorations;
  }

  /**
   * Watch for .gas-snapshot changes
   */
  public watchGasSnapshot(
    workspaceRoot: string,
    onChange: (reports: ForgeGasReport[]) => void
  ): vscode.FileSystemWatcher {
    const snapshotPath = path.join(workspaceRoot, '.gas-snapshot');
    const watcher = vscode.workspace.createFileSystemWatcher(snapshotPath);

    watcher.onDidChange(async () => {
      const reports = await this.parseForgeGasReport(workspaceRoot);
      onChange(reports);
    });

    watcher.onDidCreate(async () => {
      const reports = await this.parseForgeGasReport(workspaceRoot);
      onChange(reports);
    });

    return watcher;
  }

  /**
   * Generate test coverage gas report
   */
  public generateCoverageGasReport(
    forgeReports: ForgeGasReport[]
  ): Map<string, { totalGas: number; testCount: number; avgGasPerTest: number }> {
    const coverage = new Map<
      string,
      { totalGas: number; testCount: number; avgGasPerTest: number }
    >();

    forgeReports.forEach((report) => {
      report.tests.forEach((test) => {
        test.functionsCalled.forEach((call) => {
          const existing = coverage.get(call.name) || {
            totalGas: 0,
            testCount: 0,
            avgGasPerTest: 0,
          };
          existing.totalGas += call.actualGas;
          existing.testCount += 1;
          existing.avgGasPerTest = existing.totalGas / existing.testCount;
          coverage.set(call.name, existing);
        });
      });
    });

    return coverage;
  }
}
