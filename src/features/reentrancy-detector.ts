/**
 * Reentrancy Detector - Detect CEI pattern violations
 *
 * Flags external calls that happen before state changes,
 * which is the root cause of reentrancy vulnerabilities.
 */

export interface ReentrancyWarning {
  line: number;
  functionName: string;
  severity: 'high' | 'medium' | 'low';
  description: string;
  callLine: number;
  stateChangeLine: number;
}

interface FunctionBlock {
  name: string;
  startLine: number;
  endLine: number;
  body: string;
  bodyStartLine: number;
  header: string;
  isView: boolean;
  isPure: boolean;
  isPublicOrExternal: boolean;
  hasGuard: boolean;
}

/**
 * Extract function blocks from source code
 */
function extractFunctions(source: string): FunctionBlock[] {
  const functions: FunctionBlock[] = [];
  const lines = source.split('\n');

  const funcPattern = /function\s+(\w+)\s*\([^)]*\)[^{]*\{/;
  let i = 0;

  while (i < lines.length) {
    const match = funcPattern.exec(lines[i]);
    if (match) {
      const name = match[1];
      const startLine = i + 1;
      let depth = 0;
      let foundOpen = false;

      // Find the full function body
      const bodyLines: string[] = [];
      for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === '{') {
            depth++;
            foundOpen = true;
          }
          if (ch === '}') {
            depth--;
          }
        }
        if (j > i) {
          bodyLines.push(lines[j]);
        }
        if (foundOpen && depth === 0) {
          // Build the header from function signature line(s) up to the opening brace
          const headerLines = lines.slice(i, Math.min(j + 1, i + 5));
          const header = headerLines.join(' ');
          const isView = /\b(view)\b/.test(header);
          const isPure = /\b(pure)\b/.test(header);
          const isPublicOrExternal =
            /\b(public|external)\b/.test(header) || !/\b(private|internal)\b/.test(header);
          const guardPatterns = [
            /nonReentrant/,
            /noReentrant/,
            /reentrancyGuard/,
            /ReentrancyGuard/,
            /mutex/i,
            /_reentrancyGuardEntered\s*\(/,
          ];
          const hasGuard = guardPatterns.some((p) => p.test(header));

          functions.push({
            name,
            startLine,
            endLine: j + 1,
            body: bodyLines.join('\n'),
            bodyStartLine: i + 2,
            header,
            isView,
            isPure,
            isPublicOrExternal,
            hasGuard,
          });
          i = j + 1;
          break;
        }
        if (j === lines.length - 1) {
          i = j + 1;
        }
      }
    } else {
      i++;
    }
  }

  return functions;
}

export class ReentrancyDetector {
  // External call patterns — only high-confidence patterns to avoid false positives.
  // Generic contract.method() is intentionally excluded as it matches array.push(), etc.
  private externalCallPatterns = [
    /\.call\s*[({]/,
    /\.delegatecall\s*[({]/,
    /\.send\s*\(/,
    /\.transfer\s*\(/,
    /IERC\w+\(.*\)\.\w+\s*\(/,
    /safeTransfer\w*\s*\(/,
    /safeApprove\s*\(/,
  ];

  // Subset that is always an external call (never a false positive)
  private highConfidenceCallPatterns = [
    /\.call\s*[({]/,
    /\.delegatecall\s*[({]/,
    /\.send\s*\(/,
    /\.transfer\s*\(/,
    /IERC\w+\(.*\)\.\w+\s*\(/,
    /safeTransfer\w*\s*\(/,
  ];

  // State change patterns
  private stateChangePatterns = [
    /\b\w+\s*\[.*\]\s*=[^=]/, // mapping/array assignment
    /\b\w+\s*\.\w+\s*=[^=]/, // struct field assignment
    /\b(balances|totalSupply|_balances|_totalSupply|allowances|_allowances)\s*[[.]/,
    /\b\w+\s*=[^=]/, // simple assignment (less specific)
    /\bdelete\s+\w+/, // delete statement
    /\b\w+\s*(\+=|-=|\*=|\/=)/, // compound assignment
  ];

  // Reentrancy guard patterns
  private guardPatterns = [
    /nonReentrant/,
    /noReentrant/,
    /reentrancyGuard/,
    /ReentrancyGuard/,
    /locked\s*=/,
    /_status\s*=/,
    /mutex/i,
    /_reentrancyGuardEntered\s*\(/,
    /require\s*\(\s*!locked\s*\)/,
    /require\s*\(\s*!_locked\s*\)/,
    /require\s*\(\s*_status\s*!=\s*_ENTERED\s*\)/,
    /if\s*\(\s*locked\s*\)\s*revert/,
    /if\s*\(\s*_locked\s*\)\s*revert/,
  ];

  // SafeERC20 call patterns — external but lower risk (no reentrant callback)
  private safeERC20Patterns = [
    /safeTransfer\s*\(/,
    /safeTransferFrom\s*\(/,
    /safeApprove\s*\(/,
    /safeIncreaseAllowance\s*\(/,
    /safeDecreaseAllowance\s*\(/,
  ];

  /**
   * Analyze source code for reentrancy vulnerabilities
   */
  detect(source: string): ReentrancyWarning[] {
    const warnings: ReentrancyWarning[] = [];
    const functions = extractFunctions(source);

    // Check if the contract body has a reentrancy guard anywhere (for cross-function checks)
    const contractHasGuard = this.guardPatterns.some((p) => p.test(source));

    // Check for custom lock patterns in the full source
    const hasCustomLockPattern =
      /require\s*\(\s*!_?locked\s*\)/.test(source) ||
      /require\s*\(\s*_status\s*!=\s*_ENTERED\s*\)/.test(source) ||
      /if\s*\(\s*_?locked\s*\)\s*revert/.test(source);

    // Pre-analyze each function: collect external calls, state changes, and state reads
    interface FunctionAnalysis {
      func: FunctionBlock;
      externalCalls: {
        line: number;
        text: string;
        highConfidence: boolean;
        isSafeERC20: boolean;
      }[];
      stateChanges: { line: number; text: string; varName: string }[];
      stateReads: { line: number; text: string; varName: string }[];
    }

    const analyses: FunctionAnalysis[] = [];

    for (const func of functions) {
      const bodyLines = func.body.split('\n');
      const externalCalls: FunctionAnalysis['externalCalls'] = [];
      const stateChanges: FunctionAnalysis['stateChanges'] = [];
      const stateReads: FunctionAnalysis['stateReads'] = [];

      for (let i = 0; i < bodyLines.length; i++) {
        const line = bodyLines[i];
        const absoluteLine = func.bodyStartLine + i;

        // Skip comments
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) {
          continue;
        }

        // Check for external calls
        const isHighConfidence = this.highConfidenceCallPatterns.some((p) => p.test(line));
        const isCall = isHighConfidence || this.externalCallPatterns.some((p) => p.test(line));
        const isSafeERC20 = this.safeERC20Patterns.some((p) => p.test(line));

        if (isCall) {
          // Filter out common false positives
          if (
            !/require\s*\(/.test(line) &&
            !/emit\s+/.test(line) &&
            !/\/\//.test(line.split('.call')[0] || '')
          ) {
            externalCalls.push({
              line: absoluteLine,
              text: line.trim(),
              highConfidence: isHighConfidence,
              isSafeERC20,
            });
          }
        }

        // Check for state changes
        if (this.stateChangePatterns.some((p) => p.test(line))) {
          // Filter out local variable declarations
          if (
            !/\b(uint|int|bool|address|bytes|string|mapping)\d*\s+/.test(line) &&
            !/memory\s+/.test(line) &&
            !/require\s*\(/.test(line) &&
            !/emit\s+/.test(line)
          ) {
            const varName = this.extractStateVarName(line);
            stateChanges.push({ line: absoluteLine, text: line.trim(), varName });
          }
        }

        // Collect state variable reads (for read-only reentrancy)
        const readMatch = line.match(/\b(\w+)\s*[[.]/);
        if (
          readMatch &&
          !/\b(uint|int|bool|address|bytes|string|mapping|memory|require|emit|msg|block|tx)\b/.test(
            readMatch[1]
          )
        ) {
          stateReads.push({ line: absoluteLine, text: line.trim(), varName: readMatch[1] });
        }
      }

      analyses.push({ func, externalCalls, stateChanges, stateReads });
    }

    // ──────────────────────────────────────────────────
    // 1. Standard CEI violation detection (existing logic, with SafeERC20 awareness)
    // ──────────────────────────────────────────────────
    for (const { func, externalCalls, stateChanges } of analyses) {
      // Skip view/pure functions
      if (func.isView || func.isPure) {
        continue;
      }
      // Skip functions with reentrancy guards
      if (func.hasGuard || this.guardPatterns.some((p) => p.test(func.body))) {
        continue;
      }
      // Also skip if function body contains custom lock pattern
      if (
        /require\s*\(\s*!_?locked\s*\)/.test(func.body) ||
        /if\s*\(\s*_?locked\s*\)\s*revert/.test(func.body)
      ) {
        continue;
      }

      // Check for CEI violations: external call BEFORE state change
      for (const call of externalCalls) {
        for (const change of stateChanges) {
          if (call.line < change.line) {
            // SafeERC20 calls are lower risk — downgrade to medium
            let severity: ReentrancyWarning['severity'];
            if (call.isSafeERC20) {
              severity = 'medium';
            } else {
              severity = call.highConfidence ? 'high' : 'medium';
            }
            warnings.push({
              line: call.line,
              functionName: func.name,
              severity,
              description: call.isSafeERC20
                ? `SafeERC20 external call before state change — lower risk but still violates CEI pattern. Move state changes before "${call.text.substring(0, 60)}"`
                : `External call before state change — potential reentrancy. Move state changes before "${call.text.substring(0, 60)}"`,
              callLine: call.line,
              stateChangeLine: change.line,
            });
            break; // One warning per call is enough
          }
        }
      }
    }

    // ──────────────────────────────────────────────────
    // 2. Cross-function reentrancy detection
    //    Pattern: function A has external calls, function B modifies shared
    //    state variables, both are public/external non-view, no guard on either.
    // ──────────────────────────────────────────────────
    if (!contractHasGuard && !hasCustomLockPattern) {
      const callerFuncs = analyses.filter(
        (a) =>
          a.externalCalls.length > 0 &&
          !a.func.isView &&
          !a.func.isPure &&
          a.func.isPublicOrExternal &&
          !a.func.hasGuard
      );
      const mutatorFuncs = analyses.filter(
        (a) =>
          a.stateChanges.length > 0 &&
          !a.func.isView &&
          !a.func.isPure &&
          a.func.isPublicOrExternal &&
          !a.func.hasGuard
      );

      for (const caller of callerFuncs) {
        for (const mutator of mutatorFuncs) {
          if (caller.func.name === mutator.func.name) {
            continue; // Same function — already handled by CEI check
          }
          // Find shared state variables
          const callerStateVars = new Set([
            ...caller.stateChanges.map((s) => s.varName),
            ...caller.stateReads.map((s) => s.varName),
          ]);
          const sharedVars = mutator.stateChanges
            .filter((s) => s.varName && callerStateVars.has(s.varName))
            .map((s) => s.varName);

          if (sharedVars.length > 0) {
            const uniqueVars = Array.from(new Set(sharedVars));
            const firstCall = caller.externalCalls[0];
            const firstChange = mutator.stateChanges[0];
            warnings.push({
              line: firstCall.line,
              functionName: caller.func.name,
              severity: 'high',
              description: `Cross-function reentrancy: ${caller.func.name}() makes an external call and ${mutator.func.name}() modifies shared state [${uniqueVars.join(', ')}] without a reentrancy guard`,
              callLine: firstCall.line,
              stateChangeLine: firstChange.line,
            });
          }
        }
      }
    }

    // ──────────────────────────────────────────────────
    // 3. Read-only reentrancy detection
    //    Pattern: contract has external calls AND view functions reading the
    //    same state variables that non-view functions modify. The view function
    //    could return stale data during a reentrant callback.
    // ──────────────────────────────────────────────────
    const functionsWithCalls = analyses.filter(
      (a) => a.externalCalls.length > 0 && !a.func.isView && !a.func.isPure
    );
    const viewFunctions = analyses.filter((a) => a.func.isView && a.stateReads.length > 0);
    const mutatingFunctions = analyses.filter(
      (a) => !a.func.isView && !a.func.isPure && a.stateChanges.length > 0
    );

    if (functionsWithCalls.length > 0 && viewFunctions.length > 0) {
      // Collect all state vars modified by non-view functions that also do external calls
      const modifiedVars = new Set<string>();
      for (const a of mutatingFunctions) {
        for (const sc of a.stateChanges) {
          if (sc.varName) {
            modifiedVars.add(sc.varName);
          }
        }
      }

      for (const viewFn of viewFunctions) {
        const readVarsThatAreMutated = viewFn.stateReads
          .filter((r) => r.varName && modifiedVars.has(r.varName))
          .map((r) => r.varName);

        if (readVarsThatAreMutated.length > 0) {
          const uniqueVars = Array.from(new Set(readVarsThatAreMutated));
          const firstRead = viewFn.stateReads[0];
          const firstCallerCall = functionsWithCalls[0].externalCalls[0];
          warnings.push({
            line: firstRead.line,
            functionName: viewFn.func.name,
            severity: 'low',
            description: `Read-only reentrancy: view function ${viewFn.func.name}() reads state [${uniqueVars.join(', ')}] that could be stale during a reentrant callback from an external call`,
            callLine: firstCallerCall.line,
            stateChangeLine: firstRead.line,
          });
        }
      }
    }

    return warnings;
  }

  /**
   * Extract the likely state variable name from an assignment line.
   */
  private extractStateVarName(line: string): string {
    // mapping/array: balances[x] = ...
    const mappingMatch = line.match(/\b(\w+)\s*\[/);
    if (mappingMatch) {
      return mappingMatch[1];
    }
    // struct field: foo.bar = ...
    const structMatch = line.match(/\b(\w+)\s*\.\w+\s*=[^=]/);
    if (structMatch) {
      return structMatch[1];
    }
    // simple assignment: foo = ...
    const simpleMatch = line.match(/\b(\w+)\s*(?:\+|-|\*|\/)?=[^=]/);
    if (simpleMatch) {
      return simpleMatch[1];
    }
    // delete: delete foo
    const deleteMatch = line.match(/\bdelete\s+(\w+)/);
    if (deleteMatch) {
      return deleteMatch[1];
    }
    return '';
  }

  /**
   * Generate a report
   */
  generateReport(warnings: ReentrancyWarning[]): string {
    const lines = ['# Reentrancy Analysis Report\n'];

    if (warnings.length === 0) {
      lines.push('No reentrancy vulnerabilities detected.\n');
      return lines.join('\n');
    }

    const high = warnings.filter((w) => w.severity === 'high');
    const medium = warnings.filter((w) => w.severity === 'medium');
    const low = warnings.filter((w) => w.severity === 'low');

    lines.push(`Found **${warnings.length}** potential reentrancy issue(s):\n`);
    lines.push(`- High: ${high.length}`);
    lines.push(`- Medium: ${medium.length}`);
    lines.push(`- Low: ${low.length}\n`);

    for (const w of warnings) {
      const icon = w.severity === 'high' ? '🔴' : w.severity === 'medium' ? '🟡' : '🔵';
      lines.push(`## ${icon} ${w.functionName}() — Line ${w.line}\n`);
      lines.push(`**Severity:** ${w.severity}`);
      lines.push(`**Issue:** ${w.description}`);
      lines.push(`**External call:** line ${w.callLine}`);
      lines.push(`**State change after:** line ${w.stateChangeLine}\n`);
      if (w.severity === 'low') {
        lines.push(
          `**Fix:** If this view function is called by external protocols during a callback, the stale state could cause accounting errors. Consider adding reentrancy guards to the mutating functions or documenting the risk.\n`
        );
      } else {
        lines.push(
          `**Fix:** Apply Checks-Effects-Interactions pattern — move state changes before external calls, or add a \`nonReentrant\` modifier.\n`
        );
      }
    }

    return lines.join('\n');
  }
}
