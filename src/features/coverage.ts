/**
 * Forge Test Coverage Integration
 *
 * Runs `forge coverage --report lcov` and parses the resulting LCOV output
 * to provide per-file and aggregate coverage metrics. Integrates with Foundry
 * projects to show line, branch, and function coverage data.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { CoverageReport, CoverageEntry } from '../types';

export class CoverageAnalyzer {
  /**
   * Run forge coverage and parse the resulting LCOV report.
   *
   * Executes `forge coverage --report lcov` in the given project root,
   * then parses the generated lcov.info file into a structured report.
   *
   * @param projectRoot - Path to the Foundry project root (must contain foundry.toml)
   * @returns Parsed coverage report, or null if coverage could not be generated
   */
  public async parseForgeCoverage(projectRoot: string): Promise<CoverageReport | null> {
    try {
      // Run forge coverage to generate lcov report
      execSync('forge coverage --report lcov', {
        cwd: projectRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120000, // 2 minute timeout for large projects
        encoding: 'utf-8',
      });

      // Look for the lcov.info file
      const lcovPath = path.join(projectRoot, 'lcov.info');

      if (!fs.existsSync(lcovPath)) {
        console.error('forge coverage did not produce lcov.info');
        return null;
      }

      const lcovContent = fs.readFileSync(lcovPath, 'utf-8');
      return this.parseLcov(lcovContent, projectRoot);
    } catch (error) {
      const err = error as Error;
      console.error(`Failed to run forge coverage: ${err.message}`);
      return null;
    }
  }

  /**
   * Parse raw LCOV content into a CoverageReport.
   *
   * LCOV format records:
   * - SF:<file>         - Source file path
   * - FN:<line>,<name>  - Function definition at line
   * - FNDA:<hits>,<name> - Function call count
   * - FNF:<count>       - Functions found (total)
   * - FNH:<count>       - Functions hit
   * - DA:<line>,<hits>  - Line execution count
   * - LF:<count>        - Lines found (total)
   * - LH:<count>        - Lines hit
   * - BRF:<count>       - Branches found (total)
   * - BRH:<count>       - Branches hit
   * - BRDA:<line>,<block>,<branch>,<hits> - Branch data
   * - end_of_record     - Marks end of a file's data
   *
   * @param lcovContent - Raw LCOV file contents
   * @param projectRoot - Project root to resolve relative paths
   * @returns Structured coverage report
   */
  public parseLcov(lcovContent: string, projectRoot: string): CoverageReport {
    const entries: CoverageEntry[] = [];
    const lines = lcovContent.split('\n');

    let currentEntry: CoverageEntry | null = null;

    // Aggregate counters for the summary
    let totalLinesFound = 0;
    let totalLinesHit = 0;
    let totalBranchesFound = 0;
    let totalBranchesHit = 0;
    let totalFunctionsFound = 0;
    let totalFunctionsHit = 0;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('SF:')) {
        // Start of a new source file record
        const filePath = trimmed.substring(3);
        const resolvedPath = path.isAbsolute(filePath)
          ? filePath
          : path.resolve(projectRoot, filePath);

        currentEntry = {
          filePath: resolvedPath,
          lines: new Map<number, number>(),
          branches: new Map<number, boolean[]>(),
          functions: new Map<string, number>(),
        };
      } else if (trimmed.startsWith('FN:') && currentEntry) {
        // Function definition: FN:<line>,<name>
        const parts = trimmed.substring(3).split(',');
        if (parts.length >= 2) {
          const funcName = parts.slice(1).join(','); // Name may contain commas (unlikely but safe)
          // Initialize with 0 hits; FNDA will update
          currentEntry.functions.set(funcName, 0);
        }
      } else if (trimmed.startsWith('FNDA:') && currentEntry) {
        // Function hits: FNDA:<hits>,<name>
        const parts = trimmed.substring(5).split(',');
        if (parts.length >= 2) {
          const hits = parseInt(parts[0], 10);
          const funcName = parts.slice(1).join(',');
          if (!isNaN(hits)) {
            currentEntry.functions.set(funcName, hits);
          }
        }
      } else if (trimmed.startsWith('DA:') && currentEntry) {
        // Line data: DA:<line>,<hits>
        const parts = trimmed.substring(3).split(',');
        if (parts.length >= 2) {
          const lineNum = parseInt(parts[0], 10);
          const hits = parseInt(parts[1], 10);
          if (!isNaN(lineNum) && !isNaN(hits)) {
            currentEntry.lines.set(lineNum, hits);
          }
        }
      } else if (trimmed.startsWith('BRDA:') && currentEntry) {
        // Branch data: BRDA:<line>,<block>,<branch>,<hits>
        const parts = trimmed.substring(5).split(',');
        if (parts.length >= 4) {
          const lineNum = parseInt(parts[0], 10);
          const hitsStr = parts[3];
          const taken = hitsStr !== '-' && parseInt(hitsStr, 10) > 0;

          if (!isNaN(lineNum)) {
            if (!currentEntry.branches.has(lineNum)) {
              currentEntry.branches.set(lineNum, []);
            }
            const branchArr = currentEntry.branches.get(lineNum);
            if (branchArr) {
              branchArr.push(taken);
            }
          }
        }
      } else if (trimmed.startsWith('LF:')) {
        const count = parseInt(trimmed.substring(3), 10);
        if (!isNaN(count)) {
          totalLinesFound += count;
        }
      } else if (trimmed.startsWith('LH:')) {
        const count = parseInt(trimmed.substring(3), 10);
        if (!isNaN(count)) {
          totalLinesHit += count;
        }
      } else if (trimmed.startsWith('BRF:')) {
        const count = parseInt(trimmed.substring(4), 10);
        if (!isNaN(count)) {
          totalBranchesFound += count;
        }
      } else if (trimmed.startsWith('BRH:')) {
        const count = parseInt(trimmed.substring(4), 10);
        if (!isNaN(count)) {
          totalBranchesHit += count;
        }
      } else if (trimmed.startsWith('FNF:')) {
        const count = parseInt(trimmed.substring(4), 10);
        if (!isNaN(count)) {
          totalFunctionsFound += count;
        }
      } else if (trimmed.startsWith('FNH:')) {
        const count = parseInt(trimmed.substring(4), 10);
        if (!isNaN(count)) {
          totalFunctionsHit += count;
        }
      } else if (trimmed === 'end_of_record') {
        if (currentEntry) {
          entries.push(currentEntry);
          currentEntry = null;
        }
      }
    }

    // Handle edge case: last entry without end_of_record
    if (currentEntry) {
      entries.push(currentEntry);
    }

    return {
      entries,
      summary: {
        linePercent:
          totalLinesFound > 0 ? Math.round((totalLinesHit / totalLinesFound) * 10000) / 100 : 0,
        branchPercent:
          totalBranchesFound > 0
            ? Math.round((totalBranchesHit / totalBranchesFound) * 10000) / 100
            : 0,
        functionPercent:
          totalFunctionsFound > 0
            ? Math.round((totalFunctionsHit / totalFunctionsFound) * 10000) / 100
            : 0,
      },
    };
  }

  /**
   * Get coverage data for a specific file from a parsed report.
   *
   * Matches by normalized absolute path. Returns null if the file is not
   * present in the coverage report.
   *
   * @param report - Parsed coverage report
   * @param filePath - Absolute or relative path to the source file
   * @returns Coverage entry for the file, or null if not found
   */
  public getCoverageForFile(report: CoverageReport, filePath: string): CoverageEntry | null {
    const normalizedPath = path.resolve(filePath);

    for (const entry of report.entries) {
      if (path.resolve(entry.filePath) === normalizedPath) {
        return entry;
      }
    }

    return null;
  }

  /**
   * Compute per-file coverage summary statistics.
   *
   * @param entry - Coverage entry for a single file
   * @returns Summary with line, branch, and function percentages
   */
  public computeFileSummary(entry: CoverageEntry): {
    linePercent: number;
    branchPercent: number;
    functionPercent: number;
    totalLines: number;
    coveredLines: number;
    totalBranches: number;
    coveredBranches: number;
    totalFunctions: number;
    coveredFunctions: number;
  } {
    const totalLines = entry.lines.size;
    let coveredLines = 0;
    for (const [, hits] of entry.lines) {
      if (hits > 0) {
        coveredLines++;
      }
    }

    let totalBranches = 0;
    let coveredBranches = 0;
    for (const [, branchArray] of entry.branches) {
      for (const taken of branchArray) {
        totalBranches++;
        if (taken) {
          coveredBranches++;
        }
      }
    }

    const totalFunctions = entry.functions.size;
    let coveredFunctions = 0;
    for (const [, hits] of entry.functions) {
      if (hits > 0) {
        coveredFunctions++;
      }
    }

    return {
      linePercent: totalLines > 0 ? Math.round((coveredLines / totalLines) * 10000) / 100 : 0,
      branchPercent:
        totalBranches > 0 ? Math.round((coveredBranches / totalBranches) * 10000) / 100 : 0,
      functionPercent:
        totalFunctions > 0 ? Math.round((coveredFunctions / totalFunctions) * 10000) / 100 : 0,
      totalLines,
      coveredLines,
      totalBranches,
      coveredBranches,
      totalFunctions,
      coveredFunctions,
    };
  }

  /**
   * Generate a human-readable coverage report.
   *
   * @param report - Parsed coverage report
   * @returns Markdown-formatted report string
   */
  public generateReport(report: CoverageReport): string {
    let output = '# Test Coverage Report\n\n';

    output += '## Summary\n\n';
    output += `| Metric | Coverage |\n`;
    output += `|--------|----------|\n`;
    output += `| Lines | ${report.summary.linePercent}% |\n`;
    output += `| Branches | ${report.summary.branchPercent}% |\n`;
    output += `| Functions | ${report.summary.functionPercent}% |\n\n`;

    output += '## Per-File Coverage\n\n';
    output += '| File | Lines | Branches | Functions |\n';
    output += '|------|-------|----------|-----------|\n';

    for (const entry of report.entries) {
      const summary = this.computeFileSummary(entry);
      const shortPath = path.basename(entry.filePath);
      output += `| ${shortPath} | ${summary.linePercent}% (${summary.coveredLines}/${summary.totalLines}) `;
      output += `| ${summary.branchPercent}% (${summary.coveredBranches}/${summary.totalBranches}) `;
      output += `| ${summary.functionPercent}% (${summary.coveredFunctions}/${summary.totalFunctions}) |\n`;
    }

    output += '\n';

    // Highlight uncovered functions
    const uncoveredFunctions: Array<{ file: string; name: string }> = [];
    for (const entry of report.entries) {
      for (const [funcName, hits] of entry.functions) {
        if (hits === 0) {
          uncoveredFunctions.push({
            file: path.basename(entry.filePath),
            name: funcName,
          });
        }
      }
    }

    if (uncoveredFunctions.length > 0) {
      output += '## Uncovered Functions\n\n';
      for (const { file, name } of uncoveredFunctions) {
        output += `- ${file}: \`${name}\`\n`;
      }
      output += '\n';
    }

    return output;
  }
}
