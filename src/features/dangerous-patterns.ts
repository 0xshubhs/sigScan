/**
 * Dangerous Pattern Detector - Detect critical security vulnerabilities
 *
 * Detects: tx.origin auth, selfdestruct, unsafe delegatecall,
 * uninitialized proxy, and hardcoded token decimals.
 */

export interface DangerousPatternWarning {
  line: number;
  functionName: string;
  patternType:
    | 'tx-origin'
    | 'selfdestruct'
    | 'unsafe-delegatecall'
    | 'uninitialized-proxy'
    | 'hardcoded-decimals';
  severity: 'critical' | 'high' | 'medium';
  description: string;
}

interface FunctionInfo {
  name: string;
  startLine: number;
  endLine: number;
}

function isComment(trimmed: string): boolean {
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/**
 * Track the current function name by watching for function declarations
 * and brace depth.
 */
function extractFunctions(source: string): FunctionInfo[] {
  const lines = source.split('\n');
  const functions: FunctionInfo[] = [];
  const funcPattern = /function\s+(\w+)\s*\(/;
  let i = 0;

  while (i < lines.length) {
    const match = funcPattern.exec(lines[i]);
    if (match) {
      const name = match[1];
      const startLine = i + 1; // 1-indexed
      let depth = 0;
      let foundOpen = false;

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
        if (foundOpen && depth === 0) {
          functions.push({ name, startLine, endLine: j + 1 });
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

function getFunctionAt(functions: FunctionInfo[], line: number): string {
  for (const fn of functions) {
    if (line >= fn.startLine && line <= fn.endLine) {
      return fn.name;
    }
  }
  return '<top-level>';
}

export class DangerousPatternDetector {
  detect(source: string): DangerousPatternWarning[] {
    const warnings: DangerousPatternWarning[] = [];
    const lines = source.split('\n');
    const functions = extractFunctions(source);

    // Check for uninitialized proxy at contract level
    this.detectUninitializedProxy(source, lines, warnings);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1; // 1-indexed

      if (isComment(trimmed)) {
        continue;
      }

      const fnName = getFunctionAt(functions, lineNum);

      // 1. tx.origin authentication
      this.detectTxOrigin(trimmed, lineNum, fnName, warnings);

      // 2. selfdestruct usage
      this.detectSelfdestruct(trimmed, lineNum, fnName, warnings);

      // 3. unsafe delegatecall
      this.detectUnsafeDelegatecall(trimmed, lineNum, fnName, warnings);

      // 5. hardcoded decimals
      this.detectHardcodedDecimals(trimmed, lineNum, fnName, warnings);
    }

    return warnings;
  }

  private detectTxOrigin(
    trimmed: string,
    line: number,
    fnName: string,
    warnings: DangerousPatternWarning[]
  ): void {
    // require(tx.origin == ...) or if (tx.origin == ...) or tx.origin ==
    if (/tx\.origin\s*==/.test(trimmed) || /==\s*tx\.origin/.test(trimmed)) {
      warnings.push({
        line,
        functionName: fnName,
        patternType: 'tx-origin',
        severity: 'critical',
        description:
          'tx.origin used for authentication — vulnerable to phishing via intermediary contracts. Use msg.sender instead.',
      });
    }
  }

  private detectSelfdestruct(
    trimmed: string,
    line: number,
    fnName: string,
    warnings: DangerousPatternWarning[]
  ): void {
    if (/\bselfdestruct\s*\(/.test(trimmed) || /\bSELFDESTRUCT\b/.test(trimmed)) {
      warnings.push({
        line,
        functionName: fnName,
        patternType: 'selfdestruct',
        severity: 'critical',
        description:
          'selfdestruct can destroy the contract and drain all ETH. Deprecated since EIP-6049.',
      });
    }
  }

  private detectUnsafeDelegatecall(
    trimmed: string,
    line: number,
    fnName: string,
    warnings: DangerousPatternWarning[]
  ): void {
    // Match .delegatecall( usage
    const dcMatch = /(\w+)\.delegatecall\s*\(/.exec(trimmed);
    if (!dcMatch) {
      return;
    }

    const target = dcMatch[1];

    // Safe if target is a hardcoded address literal, a constant-like name (ALL_CAPS), or `this`/`address(this)`
    if (target === 'this' || /^0x[0-9a-fA-F]+$/.test(target) || /^[A-Z][A-Z0-9_]+$/.test(target)) {
      return;
    }

    // Also check if the line has address(this).delegatecall
    if (/address\s*\(\s*this\s*\)\s*\.delegatecall/.test(trimmed)) {
      return;
    }

    warnings.push({
      line,
      functionName: fnName,
      patternType: 'unsafe-delegatecall',
      severity: 'critical',
      description: `delegatecall to variable target "${target}" — attacker-controlled implementation can hijack storage. Use a constant or immutable address.`,
    });
  }

  private detectUninitializedProxy(
    source: string,
    lines: string[],
    warnings: DangerousPatternWarning[]
  ): void {
    // Check if contract inherits Initializable or uses initializer modifier
    const isUpgradeable = /\bInitializable\b/.test(source) || /\binitializer\b/.test(source);

    if (!isUpgradeable) {
      return;
    }

    // Find constructor
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (isComment(trimmed)) {
        continue;
      }

      if (/\bconstructor\s*\(/.test(trimmed)) {
        // Scan constructor body for _disableInitializers()
        let depth = 0;
        let foundOpen = false;
        let hasDisable = false;
        let constructorEnd = i;

        for (let j = i; j < lines.length; j++) {
          const cLine = lines[j];
          for (const ch of cLine) {
            if (ch === '{') {
              depth++;
              foundOpen = true;
            }
            if (ch === '}') {
              depth--;
            }
          }
          if (/_disableInitializers\s*\(\s*\)/.test(cLine)) {
            hasDisable = true;
          }
          if (foundOpen && depth === 0) {
            constructorEnd = j;
            break;
          }
        }

        if (!hasDisable && constructorEnd > i) {
          // Constructor has a body but no _disableInitializers()
          warnings.push({
            line: i + 1,
            functionName: 'constructor',
            patternType: 'uninitialized-proxy',
            severity: 'high',
            description:
              'Upgradeable contract constructor missing _disableInitializers() — implementation can be initialized by attacker.',
          });
        }
        break; // only one constructor
      }
    }
  }

  private detectHardcodedDecimals(
    trimmed: string,
    line: number,
    fnName: string,
    warnings: DangerousPatternWarning[]
  ): void {
    // Match * 1e18, / 1e18, * 10**18, / 10**18, and similar decimal variations
    if (/[*/]\s*1e18\b/.test(trimmed) || /[*/]\s*10\s*\*\*\s*18\b/.test(trimmed)) {
      // Skip if it looks like ETH-native (msg.value, ether keyword)
      if (/\bether\b/.test(trimmed) || /msg\.value/.test(trimmed)) {
        return;
      }
      warnings.push({
        line,
        functionName: fnName,
        patternType: 'hardcoded-decimals',
        severity: 'medium',
        description:
          'Hardcoded 1e18 decimals — not all ERC20 tokens use 18 decimals (e.g. USDC uses 6). Use IERC20Metadata.decimals().',
      });
    }
  }

  generateReport(warnings: DangerousPatternWarning[]): string {
    if (warnings.length === 0) {
      return '# Dangerous Pattern Analysis\n\nNo dangerous patterns detected.';
    }

    const lines: string[] = [
      '# Dangerous Pattern Analysis',
      '',
      `Found **${warnings.length}** dangerous pattern(s):`,
      '',
    ];

    const severityOrder = { critical: 0, high: 1, medium: 2 };
    const sorted = [...warnings].sort(
      (a, b) => severityOrder[a.severity] - severityOrder[b.severity]
    );

    for (const w of sorted) {
      const icon =
        w.severity === 'critical' ? '[CRITICAL]' : w.severity === 'high' ? '[HIGH]' : '[MEDIUM]';
      lines.push(`### ${icon} ${w.patternType} (line ${w.line})`);
      lines.push(`- **Function**: \`${w.functionName}()\``);
      lines.push(`- **Severity**: ${w.severity}`);
      lines.push(`- ${w.description}`);
      lines.push('');
    }

    return lines.join('\n');
  }
}
