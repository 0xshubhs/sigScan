/**
 * Gas Optimization Analyzer
 *
 * Static analysis of Solidity source code to detect common gas optimization
 * opportunities. Uses regex-based pattern matching to identify anti-patterns
 * and suggest improvements without requiring compilation.
 */

import { GasOptimizationSuggestion } from '../types';

export class GasOptimizer {
  /**
   * Analyze Solidity source code for gas optimization opportunities.
   *
   * Scans for common patterns that waste gas and returns actionable
   * suggestions with line numbers, severity, and estimated savings.
   *
   * @param source - Raw Solidity source code
   * @returns Array of optimization suggestions sorted by line number
   */
  public analyze(source: string): GasOptimizationSuggestion[] {
    const suggestions: GasOptimizationSuggestion[] = [];
    const lines = source.split('\n');

    suggestions.push(...this.detectCalldataOpportunities(lines));
    suggestions.push(...this.detectImmutableCandidates(source, lines));
    suggestions.push(...this.detectConstantCandidates(source, lines));
    suggestions.push(...this.detectRequireStringErrors(lines));
    suggestions.push(...this.detectUncheckedIncrement(lines));
    suggestions.push(...this.detectRepeatedStorageReads(source, lines));
    suggestions.push(...this.detectLongRequireMessages(lines));

    // Sort by line number for consistent output
    suggestions.sort((a, b) => a.line - b.line);

    return suggestions;
  }

  /**
   * Rule 1: External functions using `memory` for array/struct params where
   * `calldata` would save gas.
   *
   * When an external function receives a dynamic type (bytes, string, arrays)
   * as `memory`, Solidity copies the data from calldata to memory. Using
   * `calldata` avoids this copy and saves ~60 gas per parameter plus memory
   * expansion costs.
   */
  private detectCalldataOpportunities(lines: string[]): GasOptimizationSuggestion[] {
    const suggestions: GasOptimizationSuggestion[] = [];

    // Match function declarations that span potentially multiple lines
    const source = lines.join('\n');
    const funcRegex = /function\s+\w+\s*\(([^)]*)\)\s*(?:external)[^{;]*[{;]/gs;

    let match;
    while ((match = funcRegex.exec(source)) !== null) {
      const params = match[1];
      if (!params) {
        continue;
      }

      // Check if any parameter uses memory where calldata would work
      const memoryParamRegex =
        /(?:bytes|string|uint\d*\[\]|int\d*\[\]|address\[\]|bool\[\]|\w+\[\])\s+memory\b/g;

      let paramMatch;
      while ((paramMatch = memoryParamRegex.exec(params)) !== null) {
        // Calculate the line number of the match
        const matchOffset = match.index + match[0].indexOf(params) + paramMatch.index;
        const lineNum = source.substring(0, matchOffset).split('\n').length;

        suggestions.push({
          line: lineNum,
          endLine: lineNum,
          rule: 'calldata-instead-of-memory',
          message:
            'Use `calldata` instead of `memory` for external function parameters. ' +
            'Calldata avoids an unnecessary memory copy.',
          severity: 'warning',
          savings: '~60+ gas per parameter',
        });
      }
    }

    return suggestions;
  }

  /**
   * Rule 2: State variables assigned only in the constructor could be `immutable`.
   *
   * Immutable variables are embedded directly in the deployed bytecode,
   * eliminating SLOAD costs entirely (saving 2100 gas per cold read).
   */
  private detectImmutableCandidates(source: string, _lines: string[]): GasOptimizationSuggestion[] {
    const suggestions: GasOptimizationSuggestion[] = [];

    // Remove comments to avoid false positives
    const cleanSource = this.stripComments(source);
    const cleanLines = cleanSource.split('\n');

    // Find state variable declarations (not already constant or immutable)
    const stateVarRegex =
      /^\s*(?:(?:public|private|internal)\s+)?(address|uint\d*|int\d*|bool|bytes\d*)\s+(?:public|private|internal\s+)?(\w+)\s*;/;

    // Find constructor body
    const constructorMatch = cleanSource.match(/constructor\s*\([^)]*\)[^{]*\{/);
    if (!constructorMatch) {
      return suggestions;
    }

    const constructorStart = cleanSource.indexOf(constructorMatch[0]);
    const constructorBody = this.extractBracedBlock(
      cleanSource,
      constructorStart + constructorMatch[0].length - 1
    );

    for (let i = 0; i < cleanLines.length; i++) {
      const line = cleanLines[i];

      // Skip if already constant or immutable
      if (/\b(constant|immutable)\b/.test(line)) {
        continue;
      }

      const varMatch = stateVarRegex.exec(line);
      if (!varMatch) {
        continue;
      }

      const varName = varMatch[2];

      // Check if variable is assigned in the constructor
      const constructorAssignRegex = new RegExp(`\\b${this.escapeRegex(varName)}\\s*=`, 'g');
      const assignedInConstructor = constructorAssignRegex.test(constructorBody);

      if (!assignedInConstructor) {
        continue;
      }

      // Check if variable is assigned anywhere else in the code (outside constructor)
      const sourceWithoutConstructor =
        cleanSource.substring(0, constructorStart) +
        cleanSource.substring(
          constructorStart + constructorMatch[0].length + constructorBody.length
        );

      // Look for assignments to this variable outside constructor and declaration
      const outsideAssignRegex = new RegExp(`\\b${this.escapeRegex(varName)}\\s*=`, 'g');
      const _outsideAssignments = sourceWithoutConstructor.match(outsideAssignRegex);

      // The declaration itself may have an assignment (which we should ignore)
      // Filter to only look at assignments in function bodies
      const funcBodyAssignRegex = new RegExp(
        `function\\s+\\w+[^}]*\\b${this.escapeRegex(varName)}\\s*=`,
        'gs'
      );
      const assignedInFunctions = funcBodyAssignRegex.test(sourceWithoutConstructor);

      if (!assignedInFunctions) {
        suggestions.push({
          line: i + 1,
          endLine: i + 1,
          rule: 'immutable-candidate',
          message:
            `State variable \`${varName}\` is only assigned in the constructor. ` +
            'Mark it as `immutable` to save ~2100 gas per read (eliminates SLOAD).',
          severity: 'warning',
          savings: '~2100 gas per cold SLOAD',
        });
      }
    }

    return suggestions;
  }

  /**
   * Rule 3: State variables assigned a literal at declaration and never reassigned
   * could be `constant`.
   *
   * Constants are replaced at compile time and cost zero gas to read.
   */
  private detectConstantCandidates(source: string, _lines: string[]): GasOptimizationSuggestion[] {
    const suggestions: GasOptimizationSuggestion[] = [];

    const cleanSource = this.stripComments(source);
    const cleanLines = cleanSource.split('\n');

    // Match state variables initialized with a literal value
    const literalInitRegex =
      /^\s*(?:(?:public|private|internal)\s+)?(address|uint\d*|int\d*|bool|bytes\d*|string)\s+(?:public|private|internal\s+)?(\w+)\s*=\s*([^;]+);/;

    for (let i = 0; i < cleanLines.length; i++) {
      const line = cleanLines[i];

      // Skip if already constant or immutable
      if (/\b(constant|immutable)\b/.test(line)) {
        continue;
      }

      const varMatch = literalInitRegex.exec(line);
      if (!varMatch) {
        continue;
      }

      const varName = varMatch[2];
      const initValue = varMatch[3].trim();

      // Check if initialization is a literal (number, hex, string, bool, address)
      const isLiteral =
        /^\d+$/.test(initValue) || // decimal number
        /^0x[0-9a-fA-F]+$/.test(initValue) || // hex literal
        /^"[^"]*"$/.test(initValue) || // string literal
        /^(true|false)$/.test(initValue) || // boolean
        /^address\(0\)$/.test(initValue) || // address(0)
        /^type\(\w+\)\.\w+$/.test(initValue); // type(...).max etc.

      if (!isLiteral) {
        continue;
      }

      // Check if variable is ever reassigned anywhere in the source
      const assignRegex = new RegExp(`(?<!\\w)${this.escapeRegex(varName)}\\s*=[^=]`, 'g');
      const allAssignments = cleanSource.match(assignRegex);

      // Should have exactly 1 assignment (the declaration itself)
      if (allAssignments && allAssignments.length === 1) {
        suggestions.push({
          line: i + 1,
          endLine: i + 1,
          rule: 'constant-candidate',
          message:
            `State variable \`${varName}\` is initialized with a literal and never reassigned. ` +
            'Mark it as `constant` to save ~2100 gas per read (replaced at compile time).',
          severity: 'warning',
          savings: '~2100 gas per cold SLOAD',
        });
      }
    }

    return suggestions;
  }

  /**
   * Rule 4: `require(condition, "string")` should use custom errors (Solidity >=0.8.4).
   *
   * Custom errors save ~50 gas per revert compared to require with a string
   * message because the string is not stored in the deployed bytecode.
   */
  private detectRequireStringErrors(lines: string[]): GasOptimizationSuggestion[] {
    const suggestions: GasOptimizationSuggestion[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Match require statements with string messages
      const requireMatch = /\brequire\s*\([^,]+,\s*"[^"]*"\s*\)/.exec(line);
      if (requireMatch) {
        suggestions.push({
          line: i + 1,
          endLine: i + 1,
          rule: 'custom-errors',
          message:
            'Use custom errors instead of `require` with string messages (Solidity >=0.8.4). ' +
            'Custom errors are ABI-encoded and save ~50 gas per revert.',
          severity: 'info',
          savings: '~50 gas per revert + deployment size reduction',
        });
      }
    }

    return suggestions;
  }

  /**
   * Rule 5: Missing `unchecked` for safe arithmetic in for-loop increments.
   *
   * Post-increment (`i++`) in for loops includes overflow checks since
   * Solidity 0.8.x. Since the loop condition already bounds the variable,
   * wrapping the increment in `unchecked { ++i }` saves ~30-50 gas per iteration.
   */
  private detectUncheckedIncrement(lines: string[]): GasOptimizationSuggestion[] {
    const suggestions: GasOptimizationSuggestion[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Match for loops with i++ or i += 1 or ++i that are NOT inside unchecked blocks
      const forLoopMatch = /\bfor\s*\([^;]*;[^;]*;\s*(\w+\+\+|\+\+\w+|\w+\s*\+=\s*1)\s*\)/.exec(
        line
      );
      if (forLoopMatch) {
        // Check if already wrapped in unchecked (crude check: look for unchecked on nearby lines)
        const contextStart = Math.max(0, i - 2);
        const contextEnd = Math.min(lines.length - 1, i + 2);
        let hasUnchecked = false;

        for (let j = contextStart; j <= contextEnd; j++) {
          if (/\bunchecked\b/.test(lines[j])) {
            hasUnchecked = true;
            break;
          }
        }

        if (!hasUnchecked) {
          suggestions.push({
            line: i + 1,
            endLine: i + 1,
            rule: 'unchecked-loop-increment',
            message:
              'Use `unchecked { ++i; }` for the loop increment. The loop condition already prevents ' +
              "overflow, so the compiler's built-in overflow check wastes gas.",
            severity: 'info',
            savings: '~30-50 gas per iteration',
          });
        }
      }
    }

    return suggestions;
  }

  /**
   * Rule 6: Storage variable read multiple times in a function.
   *
   * Each SLOAD costs 2100 gas (cold) or 100 gas (warm). Caching a storage
   * variable in a local variable avoids repeated SLOADs.
   */
  private detectRepeatedStorageReads(
    source: string,
    _lines: string[]
  ): GasOptimizationSuggestion[] {
    const suggestions: GasOptimizationSuggestion[] = [];

    const cleanSource = this.stripComments(source);

    // Extract state variable names
    const stateVarNames = new Set<string>();
    const stateVarRegex =
      /^\s*(?:mapping\([^)]+\)\s+|(?:address|uint\d*|int\d*|bool|bytes\d*|string)\s+)(?:public|private|internal\s+)?(\w+)\s*[;=]/gm;

    let stateVarMatch;
    while ((stateVarMatch = stateVarRegex.exec(cleanSource)) !== null) {
      const name = stateVarMatch[1];
      // Filter out common false positives
      if (name && name.length > 1 && !/^(constant|immutable)$/.test(name)) {
        stateVarNames.add(name);
      }
    }

    if (stateVarNames.size === 0) {
      return suggestions;
    }

    // Find function bodies and check for repeated reads
    const funcBodyRegex = /function\s+(\w+)\s*\([^)]*\)[^{]*\{/g;

    let funcMatch;
    while ((funcMatch = funcBodyRegex.exec(cleanSource)) !== null) {
      const funcName = funcMatch[1];
      const bodyStart = funcMatch.index + funcMatch[0].length - 1;
      const funcBody = this.extractBracedBlock(cleanSource, bodyStart);

      if (!funcBody) {
        continue;
      }

      const funcStartLine = cleanSource.substring(0, funcMatch.index).split('\n').length;
      const funcEndLine = funcStartLine + funcBody.split('\n').length - 1;

      // Count how many times each state variable appears in the function body
      for (const varName of stateVarNames) {
        const varReadRegex = new RegExp(`\\b${this.escapeRegex(varName)}\\b`, 'g');
        const readMatches = funcBody.match(varReadRegex);

        if (readMatches && readMatches.length >= 3) {
          // Check it's not already cached (look for local assignment like `uint256 _varName = varName`)
          const cachePattern = new RegExp(
            `\\w+\\s+\\w*${this.escapeRegex(varName)}\\w*\\s*=\\s*${this.escapeRegex(varName)}\\b`
          );
          const alreadyCached = cachePattern.test(funcBody);

          if (!alreadyCached) {
            suggestions.push({
              line: funcStartLine,
              endLine: funcEndLine,
              rule: 'cache-storage-variable',
              message:
                `State variable \`${varName}\` is read ${readMatches.length} times in \`${funcName}()\`. ` +
                'Cache it in a local variable to save ~100 gas per additional warm SLOAD.',
              severity: 'info',
              savings: `~${(readMatches.length - 1) * 100} gas (warm SLOADs)`,
            });
          }
        }
      }
    }

    return suggestions;
  }

  /**
   * Rule 7: String error messages in require longer than 32 bytes.
   *
   * Require messages are stored as bytes in the contract bytecode. Strings
   * longer than 32 bytes use an additional storage word, increasing both
   * deployment and runtime costs.
   */
  private detectLongRequireMessages(lines: string[]): GasOptimizationSuggestion[] {
    const suggestions: GasOptimizationSuggestion[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Match require/revert with string message
      const messageMatch = /\b(?:require|revert)\s*\([^"]*"([^"]+)"/.exec(line);
      if (messageMatch) {
        const message = messageMatch[1];

        // Check if message exceeds 32 bytes (1 EVM word)
        if (Buffer.byteLength(message, 'utf8') > 32) {
          suggestions.push({
            line: i + 1,
            endLine: i + 1,
            rule: 'long-revert-string',
            message:
              `Revert string "${message.substring(0, 30)}..." is longer than 32 bytes ` +
              `(${Buffer.byteLength(message, 'utf8')} bytes). Use a shorter message or custom errors ` +
              'to reduce deployment cost and runtime gas.',
            severity: 'warning',
            savings: '~deployment cost + additional memory word per revert',
          });
        }
      }
    }

    return suggestions;
  }

  /**
   * Strip single-line and multi-line comments from source code.
   */
  private stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, (match) => {
        // Preserve line count by replacing with newlines
        return match.replace(/[^\n]/g, ' ');
      })
      .replace(/\/\/.*/g, '');
  }

  /**
   * Extract the contents of a braced block starting at the given position
   * (the position should point to the opening `{`).
   */
  private extractBracedBlock(source: string, openBraceIndex: number): string {
    if (source[openBraceIndex] !== '{') {
      return '';
    }

    let depth = 1;
    let i = openBraceIndex + 1;

    while (i < source.length && depth > 0) {
      if (source[i] === '{') {
        depth++;
      } else if (source[i] === '}') {
        depth--;
      }
      i++;
    }

    return source.substring(openBraceIndex + 1, i - 1);
  }

  /**
   * Escape a string for safe use in a regular expression.
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Generate a human-readable optimization report.
   *
   * @param suggestions - Array of optimization suggestions
   * @param fileName - Name of the analyzed file
   * @returns Markdown-formatted report string
   */
  public generateReport(suggestions: GasOptimizationSuggestion[], fileName: string): string {
    if (suggestions.length === 0) {
      return `# Gas Optimization Report: ${fileName}\n\nNo optimization opportunities detected.\n`;
    }

    let report = `# Gas Optimization Report: ${fileName}\n\n`;
    report += `**${suggestions.length} optimization(s) found**\n\n`;

    const warnings = suggestions.filter((s) => s.severity === 'warning');
    const infos = suggestions.filter((s) => s.severity === 'info');

    if (warnings.length > 0) {
      report += '## Warnings\n\n';
      report += '| Line | Rule | Message | Estimated Savings |\n';
      report += '|------|------|---------|-------------------|\n';

      for (const s of warnings) {
        const savings = s.savings || 'N/A';
        report += `| ${s.line} | ${s.rule} | ${s.message} | ${savings} |\n`;
      }
      report += '\n';
    }

    if (infos.length > 0) {
      report += '## Suggestions\n\n';
      report += '| Line | Rule | Message | Estimated Savings |\n';
      report += '|------|------|---------|-------------------|\n';

      for (const s of infos) {
        const savings = s.savings || 'N/A';
        report += `| ${s.line} | ${s.rule} | ${s.message} | ${savings} |\n`;
      }
      report += '\n';
    }

    return report;
  }
}
