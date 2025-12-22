/**
 * Gas Estimation - Estimate gas costs for functions using solc compiler
 */

import { keccak256 } from 'js-sha3';
import { SolcIntegration, SolcGasEstimate } from './solc-integration';
import { FunctionSignature } from '../types';

export interface GasEstimate {
  function: string;
  signature: string;
  selector: string;
  estimatedGas: {
    min: number | 'infinite';
    max: number | 'infinite';
    average: number | 'infinite';
  };
  complexity: 'low' | 'medium' | 'high' | 'very-high' | 'unbounded';
  factors: string[];
  warning?: string;
  source: 'solc' | 'heuristic'; // Track whether estimate is from compiler or fallback
}

export class GasEstimator {
  // Base gas costs (approximate) - used only for heuristic fallback
  private readonly BASE_COST = 21000;
  private readonly FUNCTION_CALL = 2300;
  private readonly STORAGE_READ = 800;
  private readonly STORAGE_WRITE = 20000;
  private readonly LOOP_ITERATION = 500;
  private readonly EXTERNAL_CALL = 2600;

  private solcIntegration: SolcIntegration;
  private useSolc: boolean;

  constructor(useSolc = true, optimizerRuns = 200) {
    this.solcIntegration = new SolcIntegration(optimizerRuns);
    this.useSolc = useSolc && this.solcIntegration.isSolcAvailable();

    if (useSolc && !this.useSolc) {
      console.warn(
        'Solc not available, falling back to heuristic gas estimation. Install solc for accurate estimates.'
      );
    }
  }

  /**
   * Check if solc-based estimation is available
   */
  public isSolcAvailable(): boolean {
    return this.useSolc;
  }

  /**
   * Get solc version
   */
  public getSolcVersion(): string | null {
    return this.solcIntegration.getSolcVersion();
  }

  /**
   * Estimate gas using solc compiler (primary method)
   */
  public async estimateGasWithSolc(
    filePath: string,
    signature: string,
    content?: string
  ): Promise<GasEstimate | null> {
    if (!this.useSolc) {
      return null;
    }

    try {
      const result = await this.solcIntegration.compileAndGetGasEstimates(filePath, content);

      if (!result.success) {
        return null;
      }

      // Find the gas estimate for this signature
      let gasEstimate: SolcGasEstimate | null = null;

      // Try exact match
      if (result.gasEstimates[signature]) {
        gasEstimate = result.gasEstimates[signature];
      } else {
        // Try matching by function name
        const functionName = signature.split('(')[0];
        for (const [sig, estimate] of Object.entries(result.gasEstimates)) {
          if (sig.startsWith(functionName + '(')) {
            gasEstimate = estimate;
            break;
          }
        }
      }

      if (!gasEstimate) {
        return null;
      }

      // Calculate selector
      const hash = keccak256(signature);
      const selector = '0x' + hash.substring(0, 8);

      // Calculate average
      let average: number | 'infinite';
      if (gasEstimate.min === 'infinite' || gasEstimate.max === 'infinite') {
        average = 'infinite';
      } else {
        average = Math.round((Number(gasEstimate.min) + Number(gasEstimate.max)) / 2);
      }

      // Classify complexity
      const complexity = this.solcIntegration.classifyComplexity(gasEstimate);

      // Infer factors
      const factors = this.solcIntegration.inferFactors(signature, gasEstimate);

      // Generate warning
      const warning = this.solcIntegration.generateWarning(signature, gasEstimate);

      return {
        function: signature,
        signature,
        selector,
        estimatedGas: {
          min: gasEstimate.min,
          max: gasEstimate.max,
          average,
        },
        complexity: complexity as 'low' | 'medium' | 'high' | 'very-high' | 'unbounded',
        factors,
        warning,
        source: 'solc',
      };
    } catch (error) {
      console.error('Error getting solc gas estimate:', error);
      return null;
    }
  }

  /**
   * Estimate gas for a function based on code analysis (heuristic fallback)
   */
  public estimateGasHeuristic(functionCode: string, signature: string): GasEstimate {
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

    // Calculate selector (first 4 bytes of keccak256 hash)
    const hash = keccak256(signature);
    const selector = '0x' + hash.substring(0, 8);

    return {
      function: signature,
      signature,
      selector,
      estimatedGas: {
        min: minGas,
        max: maxGas,
        average: Math.round(avgGas),
      },
      complexity,
      factors: factors.length > 0 ? factors : ['Simple computation'],
      warning,
      source: 'heuristic',
    };
  }

  /**
   * Estimate gas for a function - uses solc only, no heuristic fallback
   */
  public async estimateGas(
    functionCode: string,
    signature: string,
    filePath?: string,
    fileContent?: string
  ): Promise<GasEstimate> {
    // Always use solc-based estimation
    if (!this.useSolc || !filePath) {
      // Return error estimate if solc not available
      const hash = keccak256(signature);
      const selector = '0x' + hash.substring(0, 8);
      return {
        function: signature,
        signature,
        selector,
        estimatedGas: { min: 0, max: 0, average: 0 },
        complexity: 'low',
        factors: ['⚠️ Solc unavailable - cannot estimate'],
        warning: 'Install solc for gas estimation',
        source: 'solc',
      };
    }

    const solcEstimate = await this.estimateGasWithSolc(filePath, signature, fileContent);
    if (solcEstimate) {
      return solcEstimate;
    }

    // If solc failed, return error estimate
    const hash = keccak256(signature);
    const selector = '0x' + hash.substring(0, 8);
    return {
      function: signature,
      signature,
      selector,
      estimatedGas: { min: 0, max: 0, average: 0 },
      complexity: 'low',
      factors: ['⚠️ Compilation failed'],
      warning: 'Could not compile contract - check for errors',
      source: 'solc',
    };
  }

  /**
   * Synchronous version for backward compatibility (uses heuristic only)
   */
  public estimateGasSync(functionCode: string, signature: string): GasEstimate {
    return this.estimateGasHeuristic(functionCode, signature);
  }

  /**
   * Estimate gas for all functions in a contract
   */
  public async estimateContractGas(
    contractCode: string,
    functions: FunctionSignature[],
    filePath?: string
  ): Promise<GasEstimate[]> {
    const estimates: GasEstimate[] = [];

    // If solc is available and we have a file path, try to get all estimates at once
    if (this.useSolc && filePath) {
      try {
        const result = await this.solcIntegration.compileAndGetGasEstimates(filePath, contractCode);

        if (result.success) {
          // Match functions with solc estimates
          for (const func of functions) {
            const signature = func.signature;
            const funcName = func.name;
            let gasEstimate: SolcGasEstimate | null = null;

            // Check if this is an internal function or modifier
            const isInternal = func.visibility === 'internal' || funcName.startsWith('modifier:');

            // For internal functions, check the internal gas estimates
            if (isInternal) {
              const internalKey = `internal:${signature}`;
              if (result.gasEstimates[internalKey]) {
                gasEstimate = result.gasEstimates[internalKey];
              }
            }

            // If not found or not internal, try exact match in external
            if (!gasEstimate && result.gasEstimates[signature]) {
              gasEstimate = result.gasEstimates[signature];
            }

            // Try matching by function name
            if (!gasEstimate) {
              const functionName = signature.split('(')[0];

              // Try internal functions first for internal/modifier
              if (isInternal) {
                for (const [sig, estimate] of Object.entries(result.gasEstimates)) {
                  if (sig.startsWith('internal:') && sig.includes(functionName + '(')) {
                    gasEstimate = estimate;
                    break;
                  }
                }
              }

              // Fallback to external
              if (!gasEstimate) {
                for (const [sig, estimate] of Object.entries(result.gasEstimates)) {
                  if (sig.startsWith(functionName + '(')) {
                    gasEstimate = estimate;
                    break;
                  }
                }
              }
            }

            if (gasEstimate) {
              const hash = keccak256(signature);
              const selector = '0x' + hash.substring(0, 8);

              let average: number | 'infinite';
              if (gasEstimate.min === 'infinite' || gasEstimate.max === 'infinite') {
                average = 'infinite';
              } else {
                average = Math.round((Number(gasEstimate.min) + Number(gasEstimate.max)) / 2);
              }

              estimates.push({
                function: signature,
                signature,
                selector,
                estimatedGas: {
                  min: gasEstimate.min,
                  max: gasEstimate.max,
                  average,
                },
                complexity: this.solcIntegration.classifyComplexity(gasEstimate) as
                  | 'low'
                  | 'medium'
                  | 'high'
                  | 'very-high'
                  | 'unbounded',
                factors: this.solcIntegration.inferFactors(signature, gasEstimate),
                warning: this.solcIntegration.generateWarning(signature, gasEstimate),
                source: 'solc',
              });
              continue;
            }
          }
        }
      } catch (error) {
        console.error('Error getting solc estimates for contract:', error);
        // Log error but don't fallback - we want solc-only estimates
        console.warn('Solc compilation failed - no heuristic fallback will be used');
      }
    }

    // Log any functions that didn't get solc estimates
    for (const func of functions) {
      if (!estimates.find((e) => e.signature === func.signature)) {
        console.warn(
          `⚠️  No solc estimate available for ${func.signature} - skipping heuristic fallback`
        );
      }
    }

    return estimates;
  }

  /**
   * Generate gas report
   */
  public generateGasReport(estimates: GasEstimate[]): string {
    let report = '# Gas Estimation Report\n\n';

    // Add source information
    const solcCount = estimates.filter((e) => e.source === 'solc').length;
    const heuristicCount = estimates.filter((e) => e.source === 'heuristic').length;

    if (solcCount > 0) {
      const version = this.getSolcVersion();
      report += `**Compiler**: Solidity ${version || 'unknown'} (${solcCount} functions)\n`;
    }
    if (heuristicCount > 0) {
      report += `**Heuristic**: ${heuristicCount} functions\n`;
    }
    report += '\n';

    report +=
      '| Function | Selector | Min Gas | Max Gas | Avg Gas | Complexity | Source | Notes |\n';
    report +=
      '|----------|----------|---------|---------|---------|------------|--------|-------|\n';

    estimates.forEach((est) => {
      const warning = est.warning ? ` ⚠️ ${est.warning}` : '';
      const minGas =
        est.estimatedGas.min === 'infinite' ? '∞' : est.estimatedGas.min.toLocaleString();
      const maxGas =
        est.estimatedGas.max === 'infinite' ? '∞' : est.estimatedGas.max.toLocaleString();
      const avgGas =
        est.estimatedGas.average === 'infinite' ? '∞' : est.estimatedGas.average.toLocaleString();

      report += `| ${est.function} | \`${est.selector}\` | ${minGas} | ${maxGas} | ${avgGas} | ${est.complexity} | ${est.source} | ${est.factors.join(', ')}${warning} |\n`;
    });

    report += '\n## Summary\n\n';
    report += `- **Total Functions**: ${estimates.length}\n`;

    // Calculate average only for finite values
    const finiteEstimates = estimates.filter((e) => e.estimatedGas.average !== 'infinite');
    if (finiteEstimates.length > 0) {
      const totalAvg = finiteEstimates.reduce(
        (sum, est) => sum + Number(est.estimatedGas.average),
        0
      );
      report += `- **Average Gas per Function**: ${Math.round(totalAvg / finiteEstimates.length).toLocaleString()}\n`;
    }

    report += `- **High Complexity Functions**: ${estimates.filter((e) => e.complexity === 'high' || e.complexity === 'very-high' || e.complexity === 'unbounded').length}\n`;
    report += `- **Unbounded Functions**: ${estimates.filter((e) => e.complexity === 'unbounded').length}\n`;

    return report;
  }

  /**
   * Trigger compiler upgrade check and download if needed
   */
  public triggerCompilerUpgrade(source: string, onUpgrade?: (version: string) => void): void {
    // Delegate to solc integration which handles version manager
    this.solcIntegration.triggerCompilerUpgrade(source, onUpgrade);
  }
}
