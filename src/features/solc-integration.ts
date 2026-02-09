/**
 * Solidity Compiler Integration - Get accurate gas estimates from solc
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  parsePragma,
  getCompilerForSource,
  bundledCompilerSatisfies,
  resolveBestVersion,
} from './solc-version-manager';

// Try to import solc wrapper (bundled in extension)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let solcWrapper: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  solcWrapper = require('solc');
} catch (error) {
  console.log('solc wrapper not available, will try CLI fallback');
}

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
  version?: string; // Version of solc used
  isExactMatch?: boolean; // Whether the version exactly matches pragma
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
    codeDepositCost?: string | number;
    totalCost?: string | number;
  };
  external?: Record<string, GasValue | string>;
  internal?: Record<string, GasValue | string>;
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
   * Check if solc is available (either wrapper or CLI)
   */
  public isSolcAvailable(): boolean {
    // First check if we have the JavaScript wrapper (bundled)
    if (solcWrapper) {
      return true;
    }

    // Fallback to CLI check
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
    // Try wrapper first
    if (solcWrapper) {
      try {
        return solcWrapper.version();
      } catch (error) {
        // Fall through to CLI
      }
    }

    // Fallback to CLI
    try {
      const output = execSync(`${this.solcPath} --version`, { encoding: 'utf-8' });
      const match = output.match(/Version: ([^\s]+)/);
      return match ? match[1] : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Compile using CLI (fallback method)
   */
  private compileWithCLI(input: Record<string, unknown>): string {
    // Write input to temp file
    const tempInputFile = path.join('/tmp', `solc-input-${Date.now()}.json`);
    fs.writeFileSync(tempInputFile, JSON.stringify(input));

    try {
      // Compile with solc
      const rawOutput = execSync(`${this.solcPath} --standard-json < ${tempInputFile}`, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });

      // Strip out SMT warning that appears before JSON
      // Remove lines starting with >>> (SMT solver warnings)
      const lines = rawOutput.split('\n');
      const jsonLines = lines.filter((line) => !line.startsWith('>>>'));
      const output = jsonLines.join('\n');

      return output;
    } finally {
      // Clean up temp file
      try {
        fs.unlinkSync(tempInputFile);
      } catch (error) {
        // File may not exist or already cleaned up
      }
    }
  }

  /**
   * Find imports in source file
   */
  private findImports(
    importPath: string,
    filePath: string
  ): { contents: string } | { error: string } {
    try {
      // Try relative to source file
      const dir = path.dirname(filePath);
      let fullPath = path.resolve(dir, importPath);

      if (fs.existsSync(fullPath)) {
        return { contents: fs.readFileSync(fullPath, 'utf-8') };
      }

      // Try node_modules
      fullPath = path.resolve(dir, 'node_modules', importPath);
      if (fs.existsSync(fullPath)) {
        return { contents: fs.readFileSync(fullPath, 'utf-8') };
      }

      // Try common library paths
      const libPaths = [
        path.resolve(dir, 'lib', importPath),
        path.resolve(dir, '..', 'lib', importPath),
        path.resolve(dir, 'contracts', importPath),
      ];

      for (const libPath of libPaths) {
        if (fs.existsSync(libPath)) {
          return { contents: fs.readFileSync(libPath, 'utf-8') };
        }
      }

      // Return empty stub to allow compilation to continue
      console.warn(`Import not found: ${importPath}, using stub`);
      return { contents: '' };
    } catch (error) {
      return { error: `Failed to read import: ${importPath}` };
    }
  }

  /**
   * Compile contract and get gas estimates using standard JSON input
   * Uses version manager for lazy compiler selection
   * Downloads and uses pragma-specific version for each file
   */
  public async compileAndGetGasEstimates(
    filePath: string,
    content?: string,
    onUpgrade?: (version: string) => void
  ): Promise<SolcCompilationResult> {
    try {
      // Read file content if not provided
      const sourceCode = content || fs.readFileSync(filePath, 'utf-8');
      const fileName = path.basename(filePath);

      // Parse pragma and get appropriate compiler
      const pragma = parsePragma(sourceCode);
      const isExactMatch = bundledCompilerSatisfies(pragma);

      // Enhanced logging with pragma information
      if (pragma) {
        if (pragma.exactVersion) {
          console.log(
            `📝 File: ${fileName}, Pragma: ${pragma.range} → Version: ${pragma.exactVersion}`
          );
        } else {
          console.log(`📝 File: ${fileName}, Pragma: ${pragma.range}`);
        }
      } else {
        console.log(`📝 File: ${fileName}, No pragma found (using bundled)`);
      }

      if (!isExactMatch && pragma) {
        const resolvedVersion = resolveBestVersion(pragma);
        console.log(
          `ℹ️  Pragma ${pragma.range} needs ${resolvedVersion || 'unresolved'}, compiling with bundled 0.8.28 initially...`
        );
      }

      // Get compiler (returns bundled immediately, triggers background download if needed)
      const { compiler, version } = getCompilerForSource(sourceCode, (downloadedVersion) => {
        console.log(
          `🔄 Exact compiler ${downloadedVersion} ready for ${fileName}, re-compilation available`
        );
        if (onUpgrade) {
          onUpgrade(downloadedVersion);
        }
      });

      // Create standard JSON input with import callback
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

      let output: string;

      // Use the selected compiler (could be bundled or cached exact version)
      if (compiler && typeof compiler.compile === 'function') {
        try {
          // Use import callback for better dependency resolution
          const importCallback = (importPath: string) => this.findImports(importPath, filePath);

          // Compile with the wrapper (supports import callbacks)
          const result = compiler.compile(JSON.stringify(input), { import: importCallback });
          output = result;

          // Strip SMT warnings
          const lines = output.split('\n');
          const jsonLines = lines.filter((line: string) => !line.startsWith('>>>'));
          output = jsonLines.join('\n');

          console.log(`✅ Solc ${version} compilation successful for ${fileName}`);
        } catch (error) {
          console.error(`❌ Solc ${version} compile error for ${fileName}:`, error);
          throw error; // Don't fall back to CLI for wrapper errors
        }
      } else {
        // Use CLI compilation as fallback (doesn't support imports well)
        console.log('⚠️  Using CLI compilation (limited import support)');
        output = this.compileWithCLI(input);
      }

      // Parse output
      const result: SolcOutput = JSON.parse(output);

      // Check for errors
      if (result.errors) {
        const errors = result.errors.filter((e) => e.severity === 'error');
        const warnings = result.errors.filter((e) => e.severity === 'warning');

        if (warnings.length > 0) {
          console.log(
            `⚠️  Solc warnings (${warnings.length}) for ${fileName}:`,
            warnings.slice(0, 2).map((w) => w.message.substring(0, 100))
          );
        }

        if (errors.length > 0) {
          console.error(`❌ Solc compilation errors (${errors.length}) for ${fileName}:`);
          errors.forEach((e, i) => {
            if (i < 3) {
              // Show first 3 errors
              console.error(`  ${i + 1}. ${e.message.substring(0, 150)}`);
            }
          });
          return {
            success: false,
            gasEstimates: {},
            errors: errors.map((e) => e.message),
            version,
            isExactMatch,
          };
        }
      }

      // Extract gas estimates
      const gasEstimates = this.parseGasEstimates(result);

      console.log(
        `💡 Extracted ${Object.keys(gasEstimates).length} gas estimates from ${fileName}`
      );

      return {
        success: true,
        gasEstimates,
        version,
        isExactMatch,
      };
    } catch (error) {
      const fileName = path.basename(filePath);
      console.error(
        `❌ Compilation failed for ${fileName}:`,
        error instanceof Error ? error.message : error
      );
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
            let minVal: string | number | 'infinite';
            let maxVal: string | number | 'infinite';

            // Handle both string format (single value) and object format (min/max)
            if (typeof gas === 'string' || typeof gas === 'number') {
              // Single value format: "22309" or 22309
              minVal = maxVal = gas;
            } else {
              // Object format: { min: ..., max: ... }
              minVal = gas.min ?? 0;
              maxVal = gas.max ?? 0;
            }

            estimates[signature] = {
              min: minVal === 'infinite' ? 'infinite' : Number(minVal),
              max: maxVal === 'infinite' ? 'infinite' : Number(maxVal),
            };
          }

          // Parse internal functions (if available)
          const internal = gasEstimates.internal || {};
          for (const [signature, gas] of Object.entries(internal)) {
            let minVal: string | number | 'infinite';
            let maxVal: string | number | 'infinite';

            // Handle both string format and object format
            if (typeof gas === 'string' || typeof gas === 'number') {
              minVal = maxVal = gas;
            } else {
              minVal = gas.min ?? 0;
              maxVal = gas.max ?? 0;
            }

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

  /**
   * Trigger compiler upgrade check and download if needed
   */
  public triggerCompilerUpgrade(source: string, onUpgrade?: (version: string) => void): void {
    // This triggers the version manager to check for exact version
    // If not cached, it will download in background and call onUpgrade when ready
    getCompilerForSource(source, onUpgrade);
  }
}
