/**
 * DeFi Risk Detector - Detect DeFi-specific vulnerabilities
 *
 * Detects: stale oracle data, division-before-multiplication precision loss,
 * unsafe infinite approvals, missing zero-address checks, and ERC4626 vault
 * share inflation attacks.
 */

export interface DeFiRiskWarning {
  line: number;
  functionName: string;
  riskType:
    | 'stale-oracle'
    | 'precision-loss'
    | 'infinite-approval'
    | 'zero-address'
    | 'vault-inflation';
  severity: 'high' | 'medium' | 'info';
  description: string;
}

interface FunctionBlock {
  name: string;
  visibility: string;
  startLine: number;
  endLine: number;
  header: string;
  body: string;
  bodyStartLine: number;
  addressParams: string[];
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/**
 * Extract function blocks with visibility and address parameters
 */
function extractFunctions(source: string): FunctionBlock[] {
  const functions: FunctionBlock[] = [];
  const lines = source.split('\n');

  const funcPattern = /function\s+(\w+)\s*\(([^)]*)\)([^{]*)\{/;
  let i = 0;

  while (i < lines.length) {
    // Accumulate multi-line function signatures
    let combinedLine = lines[i];
    let peekEnd = i;
    // If the line has 'function' but no '{', keep appending
    if (/function\s+\w+/.test(combinedLine) && !combinedLine.includes('{')) {
      for (let k = i + 1; k < lines.length && k < i + 10; k++) {
        combinedLine += ' ' + lines[k];
        peekEnd = k;
        if (combinedLine.includes('{')) {
          break;
        }
      }
    }

    const match = funcPattern.exec(combinedLine);
    if (match) {
      const name = match[1];
      const params = match[2];
      const modifiers = match[3];

      // Determine visibility
      let visibility = 'internal'; // default
      if (/\bexternal\b/.test(modifiers)) {
        visibility = 'external';
      } else if (/\bpublic\b/.test(modifiers)) {
        visibility = 'public';
      } else if (/\bprivate\b/.test(modifiers)) {
        visibility = 'private';
      }

      // Extract address parameter names
      const addressParams: string[] = [];
      const paramRegex = /address(?:\s+(?:payable\s+)?)(\w+)/g;
      let pm;
      while ((pm = paramRegex.exec(params)) !== null) {
        addressParams.push(pm[1]);
      }

      const startLine = i + 1;
      let depth = 0;
      let foundOpen = false;
      const bodyLines: string[] = [];
      const scanStart = peekEnd > i ? peekEnd : i;

      // Count braces from the original lines starting at i
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
        if (j > scanStart) {
          bodyLines.push(lines[j]);
        } else if (j === scanStart && foundOpen) {
          // Include remainder after the opening brace on the same line
          bodyLines.push(lines[j]);
        }
        if (foundOpen && depth === 0) {
          functions.push({
            name,
            visibility,
            startLine,
            endLine: j + 1,
            header: combinedLine,
            body: bodyLines.join('\n'),
            bodyStartLine: scanStart + 1,
            addressParams,
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

export class DeFiRiskDetector {
  /**
   * Analyze source code for DeFi-specific vulnerabilities
   */
  detect(source: string): DeFiRiskWarning[] {
    const warnings: DeFiRiskWarning[] = [];
    const lines = source.split('\n');
    const functions = extractFunctions(source);

    this.detectStaleOracle(lines, functions, warnings);
    this.detectPrecisionLoss(lines, functions, warnings);
    this.detectInfiniteApproval(lines, functions, warnings);
    this.detectMissingZeroAddress(lines, functions, warnings);
    this.detectVaultInflation(source, lines, functions, warnings);

    return warnings;
  }

  // ─── 1. Oracle manipulation / stale price ─────────────────────────────────

  private detectStaleOracle(
    lines: string[],
    functions: FunctionBlock[],
    warnings: DeFiRiskWarning[]
  ): void {
    // Detect latestAnswer() — deprecated, no freshness data at all
    for (let i = 0; i < lines.length; i++) {
      if (isCommentLine(lines[i])) {
        continue;
      }
      if (/latestAnswer\s*\(/.test(lines[i])) {
        const fn = this.findEnclosingFunction(i + 1, functions);
        warnings.push({
          line: i + 1,
          functionName: fn?.name ?? '<top-level>',
          riskType: 'stale-oracle',
          severity: 'high',
          description:
            'Using deprecated latestAnswer() which provides no freshness data. Use latestRoundData() with staleness checks instead.',
        });
      }
    }

    // Detect latestRoundData() without checking updatedAt or answeredInRound
    for (const func of functions) {
      const bodyLines = func.body.split('\n');
      let hasLatestRoundData = false;
      let latestRoundDataLine = 0;
      let hasUpdatedAtCheck = false;
      let hasAnsweredInRoundCheck = false;

      for (let i = 0; i < bodyLines.length; i++) {
        if (isCommentLine(bodyLines[i])) {
          continue;
        }
        if (/latestRoundData\s*\(/.test(bodyLines[i])) {
          hasLatestRoundData = true;
          latestRoundDataLine = func.bodyStartLine + i;
        }
        if (/updatedAt/.test(bodyLines[i])) {
          hasUpdatedAtCheck = true;
        }
        if (/answeredInRound/.test(bodyLines[i])) {
          hasAnsweredInRoundCheck = true;
        }
      }

      if (hasLatestRoundData && !hasUpdatedAtCheck && !hasAnsweredInRoundCheck) {
        warnings.push({
          line: latestRoundDataLine,
          functionName: func.name,
          riskType: 'stale-oracle',
          severity: 'high',
          description:
            'latestRoundData() called without checking updatedAt or answeredInRound — oracle price may be stale.',
        });
      }
    }
  }

  // ─── 2. Division before multiplication ────────────────────────────────────

  private detectPrecisionLoss(
    lines: string[],
    functions: FunctionBlock[],
    warnings: DeFiRiskWarning[]
  ): void {
    // Pattern: expression containing / then * on the same line (e.g. a / b * c)
    // We look for   operand / operand * operand   but not inside comments
    const divThenMul = /\w+\s*\/\s*\w+\s*\*\s*\w+/;

    for (let i = 0; i < lines.length; i++) {
      if (isCommentLine(lines[i])) {
        continue;
      }
      const line = lines[i];

      if (divThenMul.test(line)) {
        // Exclude lines that are clearly just comments trailing code
        const codePart = line.split('//')[0];
        if (!divThenMul.test(codePart)) {
          continue;
        }

        const fn = this.findEnclosingFunction(i + 1, functions);
        warnings.push({
          line: i + 1,
          functionName: fn?.name ?? '<top-level>',
          riskType: 'precision-loss',
          severity: 'medium',
          description:
            'Division before multiplication causes precision loss in integer arithmetic. Multiply first, then divide.',
        });
        continue;
      }

      // Check consecutive lines: line ends with / and next line starts with *
      if (i + 1 < lines.length && !isCommentLine(lines[i + 1])) {
        const codePart = line.split('//')[0];
        const nextCodePart = lines[i + 1].split('//')[0];
        if (/\/\s*$/.test(codePart.trimEnd()) && /^\s*\*\s*\w/.test(nextCodePart)) {
          // Disambiguate from multiline comments
          if (!/^\s*\*\s*\//.test(nextCodePart) && !/^\s*\*\s*@/.test(nextCodePart)) {
            const fn = this.findEnclosingFunction(i + 1, functions);
            warnings.push({
              line: i + 1,
              functionName: fn?.name ?? '<top-level>',
              riskType: 'precision-loss',
              severity: 'medium',
              description:
                'Division before multiplication across lines causes precision loss. Multiply first, then divide.',
            });
          }
        }
      }
    }
  }

  // ─── 3. Unsafe infinite approval ──────────────────────────────────────────

  private detectInfiniteApproval(
    lines: string[],
    functions: FunctionBlock[],
    warnings: DeFiRiskWarning[]
  ): void {
    const infinitePatterns = [
      /\.approve\s*\([^,]+,\s*type\s*\(\s*uint256\s*\)\s*\.max\s*\)/,
      /\.approve\s*\([^,]+,\s*uint256\s*\(\s*-1\s*\)\s*\)/,
      /\.approve\s*\([^,]+,\s*2\s*\*\*\s*256\s*-\s*1\s*\)/,
    ];

    for (let i = 0; i < lines.length; i++) {
      if (isCommentLine(lines[i])) {
        continue;
      }
      const codePart = lines[i].split('//')[0];

      for (const pattern of infinitePatterns) {
        if (pattern.test(codePart)) {
          const fn = this.findEnclosingFunction(i + 1, functions);
          warnings.push({
            line: i + 1,
            functionName: fn?.name ?? '<top-level>',
            riskType: 'infinite-approval',
            severity: 'medium',
            description:
              'Infinite token approval detected. If the approved spender is compromised, all tokens can be drained. Consider approving only the needed amount.',
          });
          break; // one warning per line
        }
      }
    }
  }

  // ─── 4. Missing zero-address validation ───────────────────────────────────

  private detectMissingZeroAddress(
    _lines: string[],
    functions: FunctionBlock[],
    warnings: DeFiRiskWarning[]
  ): void {
    for (const func of functions) {
      // Only flag external/public functions
      if (func.visibility !== 'external' && func.visibility !== 'public') {
        continue;
      }

      if (func.addressParams.length === 0) {
        continue;
      }

      const bodyLines = func.body.split('\n');
      const bodyText = bodyLines.filter((l) => !isCommentLine(l)).join('\n');

      for (const param of func.addressParams) {
        // Check if the address is used in a transfer, assignment, or meaningful operation
        const usagePatterns = [
          new RegExp(`\\b${param}\\b\\s*\\.transfer\\s*\\(`),
          new RegExp(`\\b${param}\\b\\s*\\.send\\s*\\(`),
          new RegExp(`\\b${param}\\b\\s*\\.call\\s*[({]`),
          new RegExp(`=\\s*${param}\\b`),
          new RegExp(
            `\\b(safeTransfer|safeTransferFrom|transferFrom|transfer)\\s*\\([^)]*\\b${param}\\b`
          ),
        ];

        const isUsed = usagePatterns.some((p) => p.test(bodyText));
        if (!isUsed) {
          continue;
        }

        // Check if there is a zero-address check
        const zeroCheckPatterns = [
          new RegExp(`require\\s*\\([^)]*${param}\\s*!=\\s*address\\s*\\(\\s*0\\s*\\)`),
          new RegExp(`require\\s*\\([^)]*address\\s*\\(\\s*0\\s*\\)\\s*!=\\s*${param}`),
          new RegExp(`if\\s*\\(\\s*${param}\\s*==\\s*address\\s*\\(\\s*0\\s*\\)`),
          new RegExp(`revert\\b[^;]*${param}`),
          new RegExp(`${param}\\s*!=\\s*address\\s*\\(\\s*0\\s*\\)`),
          new RegExp(`address\\s*\\(\\s*0\\s*\\)\\s*!=\\s*${param}`),
        ];

        const hasCheck = zeroCheckPatterns.some((p) => p.test(bodyText));
        if (!hasCheck) {
          warnings.push({
            line: func.startLine,
            functionName: func.name,
            riskType: 'zero-address',
            severity: 'medium',
            description: `Address parameter '${param}' is used for transfers/assignments without a zero-address check. Add: require(${param} != address(0))`,
          });
        }
      }
    }
  }

  // ─── 5. Unchecked ERC4626 share inflation ─────────────────────────────────

  private detectVaultInflation(
    source: string,
    lines: string[],
    functions: FunctionBlock[],
    warnings: DeFiRiskWarning[]
  ): void {
    // Check if contract inherits from ERC4626
    const inheritsERC4626 = /\bcontract\s+\w+[^{]*\bERC4626\b/.test(source);
    if (!inheritsERC4626) {
      return;
    }

    // Look for convertToShares override
    let hasConvertToShares = false;
    let hasVirtualOffset = false;
    let convertLine = 0;
    let convertFuncName = '';

    for (const func of functions) {
      if (func.name === 'convertToShares') {
        hasConvertToShares = true;
        convertLine = func.startLine;
        convertFuncName = func.name;

        // Check for virtual offset / +1 protection patterns
        const body = func.body;
        if (
          /\+\s*1\b/.test(body) ||
          /\b1\s*\+/.test(body) ||
          /virtualAssets|virtualShares|_decimalsOffset/.test(body) ||
          /10\s*\*\*/.test(body)
        ) {
          hasVirtualOffset = true;
        }
        break;
      }
    }

    // Also check for _decimalsOffset or virtual share patterns at contract level
    if (/function\s+_decimalsOffset\b/.test(source)) {
      hasVirtualOffset = true;
    }
    // OpenZeppelin 4.9+ style: constructor passes decimals offset
    if (/_decimalsOffset|virtualAssets|virtualShares/.test(source)) {
      hasVirtualOffset = true;
    }

    if (!hasVirtualOffset) {
      // If convertToShares is overridden without protection
      if (hasConvertToShares) {
        warnings.push({
          line: convertLine,
          functionName: convertFuncName,
          riskType: 'vault-inflation',
          severity: 'high',
          description:
            'ERC4626 convertToShares override without virtual offset protection. Vulnerable to share inflation / donation attack. Add virtual shares (e.g., +1) to the calculation.',
        });
      } else {
        // Inherits ERC4626 but no override and no offset — still vulnerable if using default
        // Find the contract declaration line
        for (let i = 0; i < lines.length; i++) {
          if (/\bcontract\s+\w+[^{]*\bERC4626\b/.test(lines[i])) {
            warnings.push({
              line: i + 1,
              functionName: '<contract>',
              riskType: 'vault-inflation',
              severity: 'high',
              description:
                'ERC4626 vault without virtual offset protection (no _decimalsOffset override). Vulnerable to share inflation / first-depositor donation attack.',
            });
            break;
          }
        }
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private findEnclosingFunction(
    lineNumber: number,
    functions: FunctionBlock[]
  ): FunctionBlock | undefined {
    return functions.find((f) => lineNumber >= f.startLine && lineNumber <= f.endLine);
  }

  /**
   * Generate a markdown report from warnings
   */
  generateReport(warnings: DeFiRiskWarning[]): string {
    const lines = ['# DeFi Risk Analysis Report\n'];

    if (warnings.length === 0) {
      lines.push('No DeFi-specific vulnerabilities detected.\n');
      return lines.join('\n');
    }

    const high = warnings.filter((w) => w.severity === 'high');
    const medium = warnings.filter((w) => w.severity === 'medium');
    const info = warnings.filter((w) => w.severity === 'info');

    lines.push(`Found **${warnings.length}** potential DeFi risk(s):\n`);
    lines.push(`- High: ${high.length}`);
    lines.push(`- Medium: ${medium.length}`);
    lines.push(`- Info: ${info.length}\n`);

    const severityIcon: Record<string, string> = {
      high: '[HIGH]',
      medium: '[MEDIUM]',
      info: '[INFO]',
    };
    const riskLabels: Record<string, string> = {
      'stale-oracle': 'Stale Oracle Price',
      'precision-loss': 'Precision Loss',
      'infinite-approval': 'Infinite Approval',
      'zero-address': 'Missing Zero-Address Check',
      'vault-inflation': 'ERC4626 Share Inflation',
    };

    for (const w of warnings) {
      const icon = severityIcon[w.severity] ?? '[?]';
      const label = riskLabels[w.riskType] ?? w.riskType;
      lines.push(`## ${icon} ${label} -- ${w.functionName}() -- Line ${w.line}\n`);
      lines.push(`**Severity:** ${w.severity}`);
      lines.push(`**Issue:** ${w.description}\n`);
    }

    return lines.join('\n');
  }
}
