/**
 * NatSpec Completeness Checker
 *
 * Warns on public/external functions missing @notice, @param, @return.
 * Complete NatSpec is required for Etherscan verification and good docs.
 */

export interface NatspecWarning {
  line: number;
  functionName: string;
  missing: string[];
  description: string;
}

export class NatspecChecker {
  detect(source: string): NatspecWarning[] {
    const warnings: NatspecWarning[] = [];
    const lines = source.split('\n');

    const funcPattern = /function\s+(\w+)\s*\(([^)]*)\)([^{]*)\{/;

    for (let i = 0; i < lines.length; i++) {
      const funcMatch = funcPattern.exec(lines[i]);
      if (!funcMatch) {
        continue;
      }

      const funcName = funcMatch[1];
      const params = funcMatch[2].trim();
      const modifiers = funcMatch[3];

      // Only check public/external functions
      if (!/\b(public|external)\b/.test(modifiers)) {
        continue;
      }

      // Parse parameters
      const paramNames: string[] = [];
      if (params) {
        const paramParts = params.split(',');
        for (const p of paramParts) {
          const nameMatch = p.trim().match(/\s+(\w+)\s*$/);
          if (nameMatch) {
            paramNames.push(nameMatch[1]);
          }
        }
      }

      // Parse return values
      const returnsMatch = modifiers.match(/returns\s*\(([^)]+)\)/);
      const hasReturns = !!returnsMatch;

      // Look backwards for NatSpec comment block
      const natspec = this.findNatspec(lines, i);

      const missing: string[] = [];

      if (!natspec) {
        missing.push('@notice');
        if (paramNames.length > 0) {
          missing.push(...paramNames.map((p) => `@param ${p}`));
        }
        if (hasReturns) {
          missing.push('@return');
        }
      } else {
        // Check for @notice or @dev
        if (!/@(notice|dev)\s/.test(natspec)) {
          missing.push('@notice');
        }

        // Check each param
        for (const param of paramNames) {
          if (!new RegExp(`@param\\s+${param}\\b`).test(natspec)) {
            missing.push(`@param ${param}`);
          }
        }

        // Check @return
        if (hasReturns && !/@return\b/.test(natspec)) {
          missing.push('@return');
        }
      }

      if (missing.length > 0) {
        warnings.push({
          line: i + 1,
          functionName: funcName,
          missing,
          description: `Missing NatSpec: ${missing.join(', ')}`,
        });
      }
    }

    return warnings;
  }

  /**
   * Find the NatSpec comment block above a function declaration
   */
  private findNatspec(lines: string[], funcLine: number): string | null {
    let j = funcLine - 1;

    // Skip blank lines
    while (j >= 0 && lines[j].trim() === '') {
      j--;
    }

    if (j < 0) {
      return null;
    }

    // Check for single-line /// comments
    if (lines[j].trim().startsWith('///')) {
      const commentLines: string[] = [];
      while (j >= 0 && lines[j].trim().startsWith('///')) {
        commentLines.unshift(lines[j]);
        j--;
      }
      return commentLines.join('\n');
    }

    // Check for multi-line /** ... */ NatSpec comment (must start with /**)
    if (lines[j].trim().endsWith('*/') || lines[j].trim() === '*/') {
      const commentLines: string[] = [];
      let isNatspec = false;
      while (j >= 0) {
        commentLines.unshift(lines[j]);
        if (lines[j].trim().startsWith('/**')) {
          isNatspec = true;
          break;
        }
        if (lines[j].trim().startsWith('/*')) {
          break; // Regular block comment, not NatSpec
        }
        j--;
      }
      if (isNatspec) {
        return commentLines.join('\n');
      }
      return null; // Regular /* */ comment — not NatSpec
    }

    return null;
  }

  generateReport(warnings: NatspecWarning[]): string {
    const lines = ['# NatSpec Completeness Report\n'];

    if (warnings.length === 0) {
      lines.push('All public/external functions have complete NatSpec documentation.\n');
      return lines.join('\n');
    }

    lines.push(`Found **${warnings.length}** function(s) with incomplete NatSpec:\n`);

    for (const w of warnings) {
      lines.push(`## ${w.functionName}() — Line ${w.line}\n`);
      lines.push(`**Missing:** ${w.missing.join(', ')}\n`);
    }

    return lines.join('\n');
  }
}
