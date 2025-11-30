/**
 * Runtime Gas Profiler - Capture actual gas costs during test execution
 *
 * This module integrates with Foundry's gas reporting to provide
 * REAL execution-time gas profiling, not just static estimates.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';

export interface RuntimeGasMetric {
  functionName: string;
  contractName: string;
  actualGas: number;
  estimatedGas?: number;
  difference?: number;
  callCount: number;
  testName: string;
  timestamp: Date;
}

export interface GasReportSummary {
  totalTests: number;
  totalFunctions: number;
  averageGas: number;
  highestGas: RuntimeGasMetric;
  lowestGas: RuntimeGasMetric;
  metrics: RuntimeGasMetric[];
}

/**
 * RuntimeGasProfiler - Monitors test execution and captures gas usage
 */
export class RuntimeGasProfiler {
  private metrics: Map<string, RuntimeGasMetric[]> = new Map();
  private isMonitoring = false;
  private terminalWatcher: vscode.Disposable | null = null;
  private eventHandlers: Map<string, Array<(...args: unknown[]) => void>> = new Map();

  constructor(private context: vscode.ExtensionContext) {}

  /**
   * Start monitoring gas usage during test execution
   */
  public startMonitoring(): void {
    if (this.isMonitoring) {
      return;
    }

    this.isMonitoring = true;
    this.metrics.clear();

    // Watch for terminal output
    this.setupTerminalWatcher();

    vscode.window.showInformationMessage('Runtime gas profiling started');
  }

  /**
   * Stop monitoring
   */
  public stopMonitoring(): void {
    this.isMonitoring = false;

    if (this.terminalWatcher) {
      this.terminalWatcher.dispose();
      this.terminalWatcher = null;
    }

    vscode.window.showInformationMessage('Runtime gas profiling stopped');
  }

  /**
   * Run Foundry tests with gas reporting
   */
  public async runFoundryTests(): Promise<GasReportSummary | null> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage('No workspace folder found');
      return null;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;

    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Running tests with gas profiling...',
        cancellable: true,
      },
      async (_progress, _token) => {
        // Create terminal to run forge test
        const terminal = vscode.window.createTerminal({
          name: 'Foundry Gas Report',
          cwd: rootPath,
        });

        terminal.show();

        // Run forge test with gas report
        const command = 'forge test --gas-report';
        terminal.sendText(command);

        // Parse output (this is a simplified version)
        // In production, we'd need to capture terminal output
        await this.waitForTestCompletion(5000);

        // Try to read gas report from file if available
        return await this.parseGasReport(rootPath);
      }
    );
  }

  /**
   * Run Hardhat tests with gas reporting
   */
  public async runHardhatTests(): Promise<GasReportSummary | null> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage('No workspace folder found');
      return null;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;

    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Running Hardhat tests with gas profiling...',
        cancellable: true,
      },
      async (_progress, _token) => {
        const terminal = vscode.window.createTerminal({
          name: 'Hardhat Gas Report',
          cwd: rootPath,
        });

        terminal.show();
        terminal.sendText('npx hardhat test');

        await this.waitForTestCompletion(10000);
        return await this.parseGasReport(rootPath);
      }
    );
  }

  /**
   * Parse gas report from Foundry output
   */
  private async parseGasReport(_rootPath: string): Promise<GasReportSummary | null> {
    // Foundry gas reports are printed to stdout
    // We need to parse output like:
    // | Function Name | min | avg | median | max | # calls |
    // | transfer      | 51123 | 51123 | 51123 | 51123 | 1 |

    // TODO: Implement actual parsing from terminal output or .gas-snapshot file
    // For now, return a mock summary
    const mockMetrics: RuntimeGasMetric[] = [];

    return {
      totalTests: 0,
      totalFunctions: 0,
      averageGas: 0,
      highestGas: mockMetrics[0],
      lowestGas: mockMetrics[0],
      metrics: mockMetrics,
    };
  }

  /**
   * Setup terminal watcher to capture output
   */
  private setupTerminalWatcher(): void {
    // VS Code doesn't provide direct terminal output capture
    // We need to use alternative approaches:
    // 1. Parse .gas-snapshot file (Foundry)
    // 2. Parse gas-report.txt (Hardhat)
    // 3. Use workspace file watcher for report files

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;

    // Watch for .gas-snapshot file changes
    const gasSnapshotPattern = new vscode.RelativePattern(rootPath, '**/.gas-snapshot');

    const watcher = vscode.workspace.createFileSystemWatcher(gasSnapshotPattern);

    watcher.onDidChange(async (uri) => {
      await this.parseGasSnapshot(uri.fsPath);
    });

    watcher.onDidCreate(async (uri) => {
      await this.parseGasSnapshot(uri.fsPath);
    });

    this.terminalWatcher = watcher;
  }

  /**
   * Parse Foundry .gas-snapshot file
   */
  private async parseGasSnapshot(filePath: string): Promise<void> {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      const newMetrics: RuntimeGasMetric[] = [];

      lines.forEach((line) => {
        // Format: TestName:test_function() (gas: 12345)
        const match = line.match(/(.+):(.+)\s+\(gas:\s+(\d+)\)/);
        if (match) {
          const [, testName, functionName, gas] = match;
          newMetrics.push({
            functionName: functionName.trim(),
            contractName: testName.split(':')[0],
            actualGas: parseInt(gas),
            callCount: 1,
            testName,
            timestamp: new Date(),
          });
        }
      });

      // Store metrics
      this.metrics.set(filePath, newMetrics);

      // Trigger event handlers
      const handlers = this.eventHandlers.get('gasMetricsUpdated') || [];
      handlers.forEach((handler) => handler(newMetrics));

      // Update decorations
      await this.updateRuntimeDecorations(newMetrics);
    } catch (error) {
      console.error('Failed to parse gas snapshot:', error);
    }
  }

  /**
   * Update VS Code decorations with runtime gas data
   */
  private async updateRuntimeDecorations(metrics: RuntimeGasMetric[]): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const document = editor.document;
    if (!document.fileName.endsWith('.sol')) {
      return;
    }

    // Create decoration type for runtime gas
    const decorationType = vscode.window.createTextEditorDecorationType({
      after: {
        margin: '0 0 0 3em',
        fontStyle: 'italic',
      },
    });

    const decorations: vscode.DecorationOptions[] = [];
    const content = document.getText();

    metrics.forEach((metric) => {
      // Find function in current file
      const regex = new RegExp(`function\\s+${metric.functionName}\\s*\\(`, 'g');
      let match;

      while ((match = regex.exec(content)) !== null) {
        const position = document.positionAt(match.index);
        const decoration: vscode.DecorationOptions = {
          range: new vscode.Range(position, position),
          renderOptions: {
            after: {
              contentText: ` ⚡ ${metric.actualGas.toLocaleString()} gas (runtime)`,
              color: this.getGasColor(metric.actualGas),
            },
          },
        };
        decorations.push(decoration);
      }
    });

    editor.setDecorations(decorationType, decorations);
  }

  /**
   * Get color based on gas cost
   */
  private getGasColor(gas: number): string {
    if (gas < 5000) {
      return '#00ff00'; // Green
    }
    if (gas < 20000) {
      return '#ffff00'; // Yellow
    }
    if (gas < 50000) {
      return '#ff8800'; // Orange
    }
    return '#ff0000'; // Red
  }

  /**
   * Compare static estimates with runtime actuals
   */
  public compareWithEstimates(
    staticEstimate: number,
    runtimeActual: number
  ): {
    difference: number;
    percentDifference: number;
    accuracy: 'excellent' | 'good' | 'fair' | 'poor';
  } {
    const difference = Math.abs(runtimeActual - staticEstimate);
    const percentDifference = (difference / runtimeActual) * 100;

    let accuracy: 'excellent' | 'good' | 'fair' | 'poor';
    if (percentDifference < 10) {
      accuracy = 'excellent';
    } else if (percentDifference < 25) {
      accuracy = 'good';
    } else if (percentDifference < 50) {
      accuracy = 'fair';
    } else {
      accuracy = 'poor';
    }

    return {
      difference,
      percentDifference,
      accuracy,
    };
  }

  /**
   * Wait for test completion
   */
  private async waitForTestCompletion(timeout: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, timeout);
    });
  }

  /**
   * Get all collected metrics
   */
  public getAllMetrics(): RuntimeGasMetric[] {
    const allMetrics: RuntimeGasMetric[] = [];
    this.metrics.forEach((metrics) => {
      allMetrics.push(...metrics);
    });
    return allMetrics;
  }

  /**
   * Export runtime gas report
   */
  public async exportReport(outputPath: string): Promise<void> {
    const metrics = this.getAllMetrics();
    const report = {
      timestamp: new Date().toISOString(),
      totalFunctions: metrics.length,
      metrics: metrics.map((m) => ({
        function: m.functionName,
        contract: m.contractName,
        gas: m.actualGas,
        test: m.testName,
      })),
    };

    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.stopMonitoring();
  }
}
