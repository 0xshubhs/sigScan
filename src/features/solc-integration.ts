/**
 * Solidity Compiler Integration - Get accurate gas estimates from solc
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface SolcGasEstimate {
  min: number | 'infinite';
  max: number | 'infinite';
}

export interface SolcGasReport {
  creation: {
    codeDepositCost: string;
    executionCost: string;
    totalCost: string;
  };
  external: Record<string, SolcGasEstimate>;
  internal?: Record<string, SolcGasEstimate>;
}

export interface SolcCompilationResult {
  success: boolean;
  gasEstimates: Record<string, SolcGasEstimate>;
  errors?: string[];
}

interface SolcError {
  severity: string;
  message: string;
}

interface SolcOutput {
  contracts?: Record<string, Record<string, ContractData>>;
  errors?: SolcError[];
}

interface ContractData {
  evm?: {
    gasEstimates?: GasEstimatesData;
  };
}

interface GasEstimatesData {
  creation?: {
    executionCost: string | number;
  };
  external?: Record<string, GasValue>;
  internal?: Record<string, GasValue>;
}

interface GasValue {
  min?: string | number | 'infinite';
  max?: string | number | 'infinite';
}

export class SolcIntegration {
  private solcPath: string;
  private optimizerRuns: number;

  constructor(optimizerRuns = 200) {
    this.solcPath = this.findSolc();
    this.optimizerRuns = optimizerRuns;
  }

  /**
   * Find solc executable in system
   */
  private findSolc(): string {
    // First, try to find bundled solcjs in node_modules (for extension packaging)
    const bundledSolcPaths = [
      path.join(__dirname, '../../node_modules/.bin/solcjs'),
      path.join(__dirname, '../../../node_modules/.bin/solcjs'),
      path.join(process.cwd(), 'node_modules/.bin/solcjs'),
    ];

    for (const p of bundledSolcPaths) {
      try {
        if (fs.existsSync(p)) {
          execSync(`${p} --version`, { stdio: 'ignore' });
          return p;
        }
      } catch (error) {
        continue;
      }
    }

    try {
      // Try to find solcjs in PATH
      const result = execSync('which solcjs', { encoding: 'utf-8' }).trim();
      if (result) {
        return result;
      }
    } catch (error) {
      // Not found in PATH
    }

    try {
      // Try to find native solc in PATH
      const result = execSync('which solc', { encoding: 'utf-8' }).trim();
      if (result) {
        return result;
      }
    } catch (error) {
      // Not found in PATH
    }

    // Common installation paths for native solc
    const commonPaths = [
      '/usr/local/bin/solc',
      '/usr/bin/solc',
      'solcjs', // Global install
      'solc', // Will work if in PATH
    ];

    for (const p of commonPaths) {
      try {
        execSync(`${p} --version`, { stdio: 'ignore' });
        return p;
      } catch (error) {
        continue;
      }
    }

    return 'solcjs'; // Default to solcjs, will fail if not available
  }

  /**
   * Check if solc is available
   */
  public isSolcAvailable(): boolean {
    try {
      execSync(`${this.solcPath} --version`, { stdio: 'ignore' });
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get solc version
   */
  public getSolcVersion(): string | null {
    try {
      const output = execSync(`${this.solcPath} --version`, { encoding: 'utf-8' });
      const match = output.match(/Version: ([^\s]+)/);
      return match ? match[1] : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Compile contract and get gas estimates using standard JSON input
   */
  public async compileAndGetGasEstimates(
    filePath: string,
    content?: string
  ): Promise<SolcCompilationResult> {
    try {
      // Read file content if not provided
      const sourceCode = content || fs.readFileSync(filePath, 'utf-8');
      const fileName = path.basename(filePath);

      // Create standard JSON input
      const input = {
        language: 'Solidity',
        sources: {
          [fileName]: {
            content: sourceCode,
          },
        },
        settings: {
          optimizer: {
            enabled: true,
            runs: this.optimizerRuns,
          },
          outputSelection: {
            '*': {
              '*': ['abi', 'evm.gasEstimates', 'evm.bytecode.object'],
            },
          },
        },
      };

      // Write input to temp file
      const tempInputFile = path.join('/tmp', `solc-input-${Date.now()}.json`);
      fs.writeFileSync(tempInputFile, JSON.stringify(input));

      // Compile with solc
      const output = execSync(`${this.solcPath} --standard-json < ${tempInputFile}`, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });

      // Clean up temp file
      try {
        fs.unlinkSync(tempInputFile);
      } catch (error) {
        // File may not exist or already cleaned up
      }

      // Parse output
      const result: SolcOutput = JSON.parse(output);

      // Check for errors
      if (result.errors) {
        const errors = result.errors.filter((e) => e.severity === 'error');
        if (errors.length > 0) {
          return {
            success: false,
            gasEstimates: {},
            errors: errors.map((e) => e.message),
          };
        }
      }

      // Extract gas estimates
      const gasEstimates = this.parseGasEstimates(result);

      return {
        success: true,
        gasEstimates,
      };
    } catch (error) {
      return {
        success: false,
        gasEstimates: {},
        errors: [error instanceof Error ? error.message : 'Unknown compilation error'],
      };
    }
  }

  /**
   * Parse gas estimates from solc output
   */
  private parseGasEstimates(solcOutput: SolcOutput): Record<string, SolcGasEstimate> {
    const estimates: Record<string, SolcGasEstimate> = {};

    try {
      const contracts = solcOutput.contracts || {};

      for (const fileContracts of Object.values(contracts)) {
        for (const contractData of Object.values(fileContracts)) {
          const gasEstimates = contractData.evm?.gasEstimates;

          if (!gasEstimates) {
            continue;
          }

          // Parse external functions
          const external = gasEstimates.external || {};
          for (const [signature, gas] of Object.entries(external)) {
            const minVal = gas.min ?? 0;
            const maxVal = gas.max ?? 0;
            estimates[signature] = {
              min: minVal === 'infinite' ? 'infinite' : Number(minVal),
              max: maxVal === 'infinite' ? 'infinite' : Number(maxVal),
            };
          }

          // Parse internal functions (if available)
          const internal = gasEstimates.internal || {};
          for (const [signature, gas] of Object.entries(internal)) {
            const minVal = gas.min ?? 0;
            const maxVal = gas.max ?? 0;
            estimates[`internal:${signature}`] = {
              min: minVal === 'infinite' ? 'infinite' : Number(minVal),
              max: maxVal === 'infinite' ? 'infinite' : Number(maxVal),
            };
          }

          // Handle constructor
          if (gasEstimates.creation) {
            const creation = gasEstimates.creation;
            const executionCost =
              creation.executionCost === 'infinite' ? 'infinite' : Number(creation.executionCost);
            estimates['constructor()'] = {
              min: executionCost,
              max: executionCost,
            };
          }
        }
      }
    } catch (error) {
      console.error('Error parsing solc gas estimates:', error);
    }

    return estimates;
  }

  /**
   * Get gas estimate for a specific function signature
   */
  public async getFunctionGasEstimate(
    filePath: string,
    signature: string,
    content?: string
  ): Promise<SolcGasEstimate | null> {
    const result = await this.compileAndGetGasEstimates(filePath, content);

    if (!result.success) {
      return null;
    }

    // Try exact match first
    if (result.gasEstimates[signature]) {
      return result.gasEstimates[signature];
    }

    // Try matching by function name
    const functionName = signature.split('(')[0];
    for (const [sig, estimate] of Object.entries(result.gasEstimates)) {
      if (sig.startsWith(functionName + '(')) {
        return estimate;
      }
    }

    return null;
  }

  /**
   * Classify complexity based on gas values
   */
  public classifyComplexity(
    gas: SolcGasEstimate
  ): 'low' | 'medium' | 'high' | 'very-high' | 'unbounded' {
    if (gas.max === 'infinite' || gas.min === 'infinite') {
      return 'unbounded';
    }

    const avg = (Number(gas.min) + Number(gas.max)) / 2;

    if (avg < 50_000) {
      return 'low';
    }
    if (avg < 150_000) {
      return 'medium';
    }
    if (avg < 500_000) {
      return 'high';
    }
    return 'very-high';
  }

  /**
   * Get complexity factors from gas patterns
   */
  public inferFactors(signature: string, gas: SolcGasEstimate): string[] {
    const factors: string[] = [];
    const min = gas.min === 'infinite' ? Infinity : Number(gas.min);
    const max = gas.max === 'infinite' ? Infinity : Number(gas.max);

    // Unbounded
    if (gas.max === 'infinite' || gas.min === 'infinite') {
      factors.push('Unbounded execution (loops or recursion)');
    }

    // Wide gas range indicates branching
    if (max !== Infinity && min !== Infinity) {
      const range = max - min;
      if (range > 20_000) {
        factors.push('Complex control flow with branching');
      }
    }

    // High gas indicates expensive operations
    if (max !== Infinity && max > 100_000) {
      factors.push('Expensive operations (storage, external calls, or computation)');
    }

    // Storage operations (inferred from gas cost patterns)
    if (max !== Infinity && min !== Infinity) {
      const avg = (min + max) / 2;
      // SSTORE costs ~20k, SLOAD ~800
      if (avg > 20_000 && avg < 45_000) {
        factors.push('Likely contains storage writes');
      }
    }

    // Constructor special case
    if (signature.includes('constructor')) {
      factors.push('Contract initialization');
    }

    if (factors.length === 0) {
      factors.push('Standard EVM execution');
    }

    return factors;
  }

  /**
   * Generate warning based on gas estimate
   */
  public generateWarning(signature: string, gas: SolcGasEstimate): string | undefined {
    if (gas.max === 'infinite' || gas.min === 'infinite') {
      return 'Unbounded gas cost - contains loops or recursion';
    }

    const max = Number(gas.max);

    if (max > 500_000) {
      return 'Very high gas cost - may fail on mainnet or be expensive';
    }

    if (max > 300_000) {
      return 'High gas cost - consider optimization';
    }

    return undefined;
  }
}
