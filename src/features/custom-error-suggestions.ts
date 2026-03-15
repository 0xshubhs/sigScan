/**
 * Custom Error Suggestion Detector
 *
 * Finds require(condition, "string") patterns and suggests
 * converting to custom errors for gas savings (~100 gas each).
 * Available since Solidity 0.8.4.
 */

export interface CustomErrorSuggestion {
  line: number;
  functionName: string;
  currentMessage: string;
  suggestedErrorName: string;
  estimatedGasSaving: number;
  description: string;
}

export class CustomErrorDetector {
  detect(source: string): CustomErrorSuggestion[] {
    const suggestions: CustomErrorSuggestion[] = [];
    const lines = source.split('\n');

    // Check pragma — custom errors need >=0.8.4
    const pragmaMatch = source.match(/pragma\s+solidity\s+[\^>=]*\s*(0\.\d+\.\d+)/);
    if (pragmaMatch) {
      const [, version] = pragmaMatch;
      const parts = version.split('.').map(Number);
      if (parts[1] < 8 || (parts[1] === 8 && parts[2] < 4)) {
        return []; // Custom errors not supported
      }
    }

    // Track existing custom errors
    const existingErrors = new Set<string>();
    const errorPattern = /\berror\s+(\w+)\s*\(/g;
    let errorMatch;
    while ((errorMatch = errorPattern.exec(source)) !== null) {
      existingErrors.add(errorMatch[1]);
    }

    // Track current function
    let currentFunction = '(global)';
    const funcPattern = /function\s+(\w+)\s*\(/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Track function
      const fMatch = funcPattern.exec(line);
      if (fMatch) {
        currentFunction = fMatch[1];
      }

      // Skip comments
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
        continue;
      }

      // Match require with string message — use greedy match up to last ,"string")
      const requireMatch = trimmed.match(/require\s*\(.+,\s*"([^"]+)"\s*\)/);
      if (requireMatch) {
        const message = requireMatch[1];
        const errorName = this.suggestErrorName(message);

        // Skip if this error is already declared
        if (existingErrors.has(errorName)) {
          continue;
        }

        // Estimate gas saving: ~100 gas per require with string vs custom error
        // Longer strings save more (deployment cost of string storage)
        const gasSaving = 100 + Math.floor(message.length / 32) * 200;

        suggestions.push({
          line: i + 1,
          functionName: currentFunction,
          currentMessage: message,
          suggestedErrorName: errorName,
          estimatedGasSaving: gasSaving,
          description: `Replace \`require(..., "${message}")\` with custom error \`${errorName}\` to save ~${gasSaving} gas`,
        });
      }

      // Also catch revert("string")
      const revertMatch = trimmed.match(/revert\s*\(\s*"([^"]+)"\s*\)/);
      if (revertMatch) {
        const message = revertMatch[1];
        const errorName = this.suggestErrorName(message);
        const gasSaving = 100 + Math.floor(message.length / 32) * 200;

        suggestions.push({
          line: i + 1,
          functionName: currentFunction,
          currentMessage: message,
          suggestedErrorName: errorName,
          estimatedGasSaving: gasSaving,
          description: `Replace \`revert("${message}")\` with custom error \`${errorName}\``,
        });
      }
    }

    return suggestions;
  }

  /**
   * Find duplicate error message strings that should be consolidated
   * into shared custom errors.
   */
  findDuplicateMessages(
    suggestions: CustomErrorSuggestion[]
  ): Map<string, CustomErrorSuggestion[]> {
    const byMessage = new Map<string, CustomErrorSuggestion[]>();
    for (const s of suggestions) {
      const group = byMessage.get(s.currentMessage) || [];
      group.push(s);
      byMessage.set(s.currentMessage, group);
    }
    // Only return messages that appear more than once
    const duplicates = new Map<string, CustomErrorSuggestion[]>();
    for (const [msg, group] of byMessage) {
      if (group.length > 1) {
        duplicates.set(msg, group);
      }
    }
    return duplicates;
  }

  /**
   * Generate a PascalCase error name from an error message
   */
  private suggestErrorName(message: string): string {
    // Common patterns
    const replacements: [RegExp, string][] = [
      [/not\s+owner/i, 'NotOwner'],
      [/not\s+authorized/i, 'Unauthorized'],
      [/insufficient\s+balance/i, 'InsufficientBalance'],
      [/insufficient\s+allowance/i, 'InsufficientAllowance'],
      [/zero\s+address/i, 'ZeroAddress'],
      [/already\s+initialized/i, 'AlreadyInitialized'],
      [/not\s+initialized/i, 'NotInitialized'],
      [/transfer\s+failed/i, 'TransferFailed'],
      [/invalid\s+amount/i, 'InvalidAmount'],
      [/exceeds\s+balance/i, 'ExceedsBalance'],
      [/paused/i, 'ContractPaused'],
      [/deadline/i, 'DeadlineExpired'],
      [/expired/i, 'Expired'],
      [/overflow/i, 'Overflow'],
      [/underflow/i, 'Underflow'],
    ];

    for (const [pattern, name] of replacements) {
      if (pattern.test(message)) {
        return name;
      }
    }

    // Generic: convert message to PascalCase
    return (
      message
        .replace(/[^a-zA-Z0-9\s]/g, '')
        .split(/\s+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join('')
        .substring(0, 40) || 'CustomError'
    );
  }

  generateReport(suggestions: CustomErrorSuggestion[]): string {
    const lines = ['# Custom Error Suggestions\n'];

    if (suggestions.length === 0) {
      lines.push('No require/revert strings found to convert.\n');
      return lines.join('\n');
    }

    const totalSaving = suggestions.reduce((sum, s) => sum + s.estimatedGasSaving, 0);
    lines.push(
      `> **Total estimated gas savings: ~${totalSaving.toLocaleString()} gas** across ${suggestions.length} instance(s).\n`
    );
    lines.push(
      `Found **${suggestions.length}** string-based revert(s). Converting saves ~**${totalSaving.toLocaleString()} gas** total.\n`
    );

    // Detect duplicate messages that should be consolidated
    const duplicates = this.findDuplicateMessages(suggestions);
    if (duplicates.size > 0) {
      lines.push('### Duplicate Error Messages (Consolidation Opportunities)\n');
      lines.push(
        'The following error strings appear multiple times. Define a single custom error and reuse it:\n'
      );
      for (const [msg, group] of duplicates) {
        const errorName = this.suggestErrorName(msg);
        const lineNums = group.map((s) => `Line ${s.line}`).join(', ');
        lines.push(
          `- **\`"${msg}"\`** appears **${group.length}x** (${lineNums}) → consolidate into \`error ${errorName}();\``
        );
      }
      lines.push('');
    }

    // Group suggested error declarations
    const errorNames = new Map<string, string>();
    for (const s of suggestions) {
      errorNames.set(s.suggestedErrorName, s.currentMessage);
    }

    lines.push('### Suggested Error Declarations\n');
    lines.push('```solidity');
    for (const [name, msg] of errorNames) {
      lines.push(`error ${name}(); // was: "${msg}"`);
    }
    lines.push('```\n');

    lines.push('### Instances\n');
    for (const s of suggestions) {
      lines.push(
        `- **Line ${s.line}** (${s.functionName}): \`"${s.currentMessage}"\` → \`${s.suggestedErrorName}()\` (~${s.estimatedGasSaving} gas saved)`
      );
    }
    lines.push('');

    return lines.join('\n');
  }
}
