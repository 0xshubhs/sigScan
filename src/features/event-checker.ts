/**
 * Event Emission Checker
 *
 * Detects state-changing functions that don't emit any events.
 * Events are critical for off-chain indexing and debugging.
 */

export interface MissingEventWarning {
  line: number;
  functionName: string;
  description: string;
  stateChanges: string[];
}

export class EventEmissionChecker {
  // State-modifying patterns
  private stateChangePatterns = [
    { pattern: /\b\w+\s*\[.*\]\s*=[^=]/, label: 'mapping/array write' },
    { pattern: /\b\w+\s*(\+=|-=|\*=|\/=)/, label: 'compound assignment' },
    { pattern: /\bdelete\s+\w+/, label: 'delete' },
    { pattern: /\.transfer\s*\(/, label: 'ETH transfer' },
    { pattern: /\.call\s*\{.*value/, label: 'ETH send' },
    { pattern: /\.safeTransfer\s*\(/, label: 'token transfer' },
    { pattern: /\.safeTransferFrom\s*\(/, label: 'token transferFrom' },
  ];

  detect(source: string): MissingEventWarning[] {
    const warnings: MissingEventWarning[] = [];
    const lines = source.split('\n');

    const funcPattern = /function\s+(\w+)\s*\([^)]*\)([^{]*)\{/;
    let i = 0;

    while (i < lines.length) {
      const funcMatch = funcPattern.exec(lines[i]);
      if (!funcMatch) {
        i++;
        continue;
      }

      const funcName = funcMatch[1];
      const modifiers = funcMatch[2];
      const funcLine = i + 1;

      // Skip view/pure functions
      if (/\b(view|pure)\b/.test(modifiers)) {
        i++;
        continue;
      }

      // Skip internal/private functions (less critical)
      if (/\b(internal|private)\b/.test(modifiers)) {
        i++;
        continue;
      }

      // Skip constructors, fallback, receive
      if (/\b(constructor|fallback|receive)\b/.test(lines[i])) {
        i++;
        continue;
      }

      // Find function body
      let depth = 0;
      let foundOpen = false;
      let hasEmit = false;
      const detectedChanges: string[] = [];
      const bodyStart = i;

      for (let j = i; j < lines.length; j++) {
        const line = lines[j];

        for (const ch of line) {
          if (ch === '{') {
            depth++;
            foundOpen = true;
          }
          if (ch === '}') {
            depth--;
          }
        }

        // Only check body lines (after function header)
        if (j > bodyStart) {
          const trimmed = line.trim();
          const isComment = trimmed.startsWith('//') || trimmed.startsWith('*');

          if (!isComment) {
            // Check for emit
            if (/\bemit\s+\w+/.test(line)) {
              hasEmit = true;
            }

            // Check for state changes
            for (const { pattern, label } of this.stateChangePatterns) {
              if (pattern.test(line) && !detectedChanges.includes(label)) {
                // Filter out local variables
                if (
                  !/\b(uint|int|bool|address|bytes|string)\d*\s+/.test(line) &&
                  !/\bmemory\b/.test(line)
                ) {
                  detectedChanges.push(label);
                }
              }
            }
          }
        }

        if (foundOpen && depth === 0) {
          i = j + 1;
          break;
        }
        if (j === lines.length - 1) {
          i = j + 1;
        }
      }

      if (!hasEmit && detectedChanges.length > 0) {
        warnings.push({
          line: funcLine,
          functionName: funcName,
          description: `State-changing function does not emit any events. This makes off-chain tracking and debugging difficult.`,
          stateChanges: detectedChanges,
        });
      }
    }

    return warnings;
  }

  generateReport(warnings: MissingEventWarning[]): string {
    const lines = ['# Missing Event Emission Report\n'];

    if (warnings.length === 0) {
      lines.push('All state-changing functions emit events.\n');
      return lines.join('\n');
    }

    lines.push(`Found **${warnings.length}** function(s) missing event emissions:\n`);

    for (const w of warnings) {
      lines.push(`## ${w.functionName}() — Line ${w.line}\n`);
      lines.push(`**State changes:** ${w.stateChanges.join(', ')}`);
      lines.push(`**Issue:** ${w.description}\n`);
    }

    return lines.join('\n');
  }
}
