/**
 * Gas Estimation - Estimate gas costs for functions based on complexity
 */

export interface GasEstimate {
  function: string;
  estimatedGas: {
    min: number;
    max: number;
    average: number;
  };
  complexity: 'low' | 'medium' | 'high' | 'very-high';
  factors: string[];
  warning?: string;
}

export class GasEstimator {
  // Base gas costs (approximate)
  private readonly BASE_COST = 21000;
  private readonly FUNCTION_CALL = 2300;
  private readonly STORAGE_READ = 800;
  private readonly STORAGE_WRITE = 20000;
  private readonly LOOP_ITERATION = 500;
  private readonly EXTERNAL_CALL = 2600;

  /**
   * Estimate gas for a function based on code analysis
   */
  public estimateGas(functionCode: string, signature: string): GasEstimate {
    const factors: string[] = [];
    let minGas = this.FUNCTION_CALL;
    let maxGas = this.FUNCTION_CALL;

    // Check for storage operations
    const storageReads = (functionCode.match(/\b\w+\s*\[/g) || []).length;
    const storageWrites = (functionCode.match(/\b\w+\s*\[.*?\]\s*=/g) || []).length;

    if (storageReads > 0) {
      minGas += storageReads * this.STORAGE_READ;
      maxGas += storageReads * this.STORAGE_READ;
      factors.push(`${storageReads} storage reads`);
    }

    if (storageWrites > 0) {
      minGas += storageWrites * this.STORAGE_WRITE;
      maxGas += storageWrites * this.STORAGE_WRITE;
      factors.push(`${storageWrites} storage writes`);
    }

    // Check for loops
    const loops = (functionCode.match(/\b(for|while)\s*\(/g) || []).length;
    if (loops > 0) {
      minGas += loops * this.LOOP_ITERATION * 10; // Min 10 iterations
      maxGas += loops * this.LOOP_ITERATION * 1000; // Max 1000 iterations
      factors.push(`${loops} loop(s) - unbounded gas`);
    }

    // Check for external calls
    const externalCalls = (functionCode.match(/\.\w+\(/g) || []).length;
    if (externalCalls > 0) {
      minGas += externalCalls * this.EXTERNAL_CALL;
      maxGas += externalCalls * this.EXTERNAL_CALL * 10;
      factors.push(`${externalCalls} external call(s)`);
    }

    // Check for complex operations
    if (functionCode.includes('require') || functionCode.includes('revert')) {
      factors.push('Conditional logic');
    }

    if (functionCode.includes('emit')) {
      const events = (functionCode.match(/emit\s+\w+/g) || []).length;
      minGas += events * 375; // Base event cost
      maxGas += events * 2000; // With indexed parameters
      factors.push(`${events} event emission(s)`);
    }

    // Determine complexity
    let complexity: 'low' | 'medium' | 'high' | 'very-high';
    const avgGas = (minGas + maxGas) / 2;

    if (avgGas < 50000) {
      complexity = 'low';
    } else if (avgGas < 150000) {
      complexity = 'medium';
    } else if (avgGas < 500000) {
      complexity = 'high';
    } else {
      complexity = 'very-high';
    }

    // Generate warnings
    let warning: string | undefined;
    if (loops > 0) {
      warning = 'Contains unbounded loops - gas cost depends on input size';
    } else if (avgGas > 500000) {
      warning = 'High gas cost - consider optimization';
    }

    return {
      function: signature,
      estimatedGas: {
        min: minGas,
        max: maxGas,
        average: Math.round(avgGas),
      },
      complexity,
      factors: factors.length > 0 ? factors : ['Simple computation'],
      warning,
    };
  }

  /**
   * Estimate gas for all functions in a contract
   */
  public estimateContractGas(contractCode: string, functions: any[]): GasEstimate[] {
    const estimates: GasEstimate[] = [];

    functions.forEach((func) => {
      // Extract function body from contract code
      const funcPattern = new RegExp(
        `function\\s+${func.name}\\s*\\([^)]*\\)[^{]*{([^}]*(?:{[^}]*}[^}]*)*)}`,
        's'
      );
      const match = contractCode.match(funcPattern);

      if (match && match[1]) {
        const functionBody = match[1];
        estimates.push(this.estimateGas(functionBody, func.signature));
      }
    });

    return estimates;
  }

  /**
   * Generate gas report
   */
  public generateGasReport(estimates: GasEstimate[]): string {
    let report = '# Gas Estimation Report\n\n';
    report += '| Function | Min Gas | Max Gas | Avg Gas | Complexity | Notes |\n';
    report += '|----------|---------|---------|---------|------------|-------|\n';

    estimates.forEach((est) => {
      const warning = est.warning ? ` ⚠️ ${est.warning}` : '';
      report += `| ${est.function} | ${est.estimatedGas.min.toLocaleString()} | ${est.estimatedGas.max.toLocaleString()} | ${est.estimatedGas.average.toLocaleString()} | ${est.complexity} | ${est.factors.join(', ')}${warning} |\n`;
    });

    report += '\n## Summary\n\n';
    const totalAvg = estimates.reduce((sum, est) => sum + est.estimatedGas.average, 0);
    report += `- **Total Functions**: ${estimates.length}\n`;
    report += `- **Average Gas per Function**: ${Math.round(totalAvg / estimates.length).toLocaleString()}\n`;
    report += `- **High Complexity Functions**: ${estimates.filter((e) => e.complexity === 'high' || e.complexity === 'very-high').length}\n`;

    return report;
  }
}
