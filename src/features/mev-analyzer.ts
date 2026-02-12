/**
 * MEV Analyzer - Detect front-running and MEV vulnerability patterns in Solidity source
 *
 * Analyzes smart contract source code for patterns that may expose the contract
 * or its users to Miner Extractable Value (MEV) attacks including:
 * - Sandwich attacks on unprotected swaps
 * - Oracle manipulation via spot price reads
 * - Timestamp dependence in critical logic
 * - State-dependent return values without access control
 */

import { MEVRisk } from '../types';

/**
 * Represents a parsed function with its declaration, body, and metadata.
 */
interface ParsedFunction {
  name: string;
  line: number;
  visibility: string;
  body: string;
  fullDeclaration: string;
  modifiers: string[];
}

export class MEVAnalyzer {
  /**
   * Analyze Solidity source code for MEV and front-running risks.
   *
   * Scans for known vulnerability patterns and returns an array of MEVRisk
   * objects describing each identified risk, its severity, and recommended
   * mitigations.
   *
   * @param source - The Solidity source code to analyze
   * @returns Array of detected MEV risks
   */
  public analyze(source: string): MEVRisk[] {
    const risks: MEVRisk[] = [];
    const functions = this.extractFunctions(source);

    for (const func of functions) {
      const stateDependentRisks = this.detectStateDependentReturn(func, source);
      risks.push(...stateDependentRisks);

      const swapRisks = this.detectUnprotectedSwap(func);
      risks.push(...swapRisks);

      const oracleRisks = this.detectOracleManipulation(func, source);
      risks.push(...oracleRisks);

      const sandwichRisks = this.detectSandwichAttack(func, source);
      risks.push(...sandwichRisks);

      const timestampRisks = this.detectTimestampDependency(func);
      risks.push(...timestampRisks);
    }

    return risks;
  }

  /**
   * Extract function blocks with visibility and modifier information.
   */
  private extractFunctions(source: string): ParsedFunction[] {
    const functions: ParsedFunction[] = [];
    // Match function declarations with their visibility and modifiers
    const funcRegex =
      /function\s+(\w+)\s*\(([^)]*)\)\s+((?:(?:public|external|internal|private|pure|view|payable|virtual|override|\w+)\s*)*)\s*(?:returns\s*\([^)]*\))?\s*\{/g;

    let match: RegExpExecArray | null;

    while ((match = funcRegex.exec(source)) !== null) {
      const name = match[1];
      const modifierString = match[3] || '';
      const startOffset = match.index;
      const line = this.offsetToLine(source, startOffset);

      // Extract visibility
      let visibility = 'internal'; // default
      const visMatch = modifierString.match(/\b(public|external|internal|private)\b/);
      if (visMatch) {
        visibility = visMatch[1];
      }

      // Extract modifiers (custom modifiers following visibility/mutability keywords)
      const knownKeywords = new Set([
        'public',
        'external',
        'internal',
        'private',
        'pure',
        'view',
        'payable',
        'nonpayable',
        'virtual',
        'override',
      ]);
      const modifiers = modifierString
        .split(/\s+/)
        .filter((m) => m.length > 0 && !knownKeywords.has(m));

      // Extract function body
      const body = this.extractBraceBlock(source, match.index + match[0].length - 1);

      functions.push({
        name,
        line,
        visibility,
        body,
        fullDeclaration: match[0],
        modifiers,
      });
    }

    return functions;
  }

  /**
   * Convert a character offset to a 1-based line number.
   */
  private offsetToLine(source: string, offset: number): number {
    let line = 1;
    for (let i = 0; i < offset && i < source.length; i++) {
      if (source[i] === '\n') {
        line++;
      }
    }
    return line;
  }

  /**
   * Extract content of a brace-delimited block starting at the open brace.
   */
  private extractBraceBlock(source: string, openBraceIndex: number): string {
    let depth = 0;
    for (let i = openBraceIndex; i < source.length; i++) {
      if (source[i] === '{') {
        depth++;
      } else if (source[i] === '}') {
        depth--;
        if (depth === 0) {
          return source.substring(openBraceIndex, i + 1);
        }
      }
    }
    return source.substring(openBraceIndex);
  }

  /**
   * Check if a function has access control modifiers or checks.
   */
  private hasAccessControl(func: ParsedFunction): boolean {
    // Check for common access control modifiers
    const accessModifiers = [
      'onlyOwner',
      'onlyRole',
      'onlyAdmin',
      'onlyMinter',
      'onlyGovernance',
      'onlyAuthorized',
      'whenNotPaused',
    ];

    for (const mod of accessModifiers) {
      if (func.modifiers.includes(mod) || func.fullDeclaration.includes(mod)) {
        return true;
      }
    }

    // Check for require(msg.sender == ...) in the body
    if (/require\s*\(\s*msg\.sender\s*==/.test(func.body)) {
      return true;
    }

    // Check for hasRole check
    if (/hasRole\s*\(/.test(func.body)) {
      return true;
    }

    return false;
  }

  /**
   * Detect state-dependent return values without access control.
   *
   * External/public view functions that read state variables and return values
   * can be exploited in sandwich attacks if the state they read can be
   * manipulated in the same block.
   */
  private detectStateDependentReturn(func: ParsedFunction, source: string): MEVRisk[] {
    const risks: MEVRisk[] = [];

    // Only check external/public functions
    if (func.visibility !== 'external' && func.visibility !== 'public') {
      return risks;
    }

    // Must be a view/pure-like function that returns something
    const hasReturn = /returns?\s*\(/.test(func.fullDeclaration);
    if (!hasReturn) {
      return risks;
    }

    // Skip if it has access control
    if (this.hasAccessControl(func)) {
      return risks;
    }

    // Check if it reads state variables (not just pure computation)
    // Look for state variable reads: accessing mappings, arrays, or direct state vars
    const readsState =
      /\b\w+\s*\[/.test(func.body) || // mapping/array read
      /\btotalSupply\b/.test(func.body) ||
      /\bbalance[sS]?\b/.test(func.body) ||
      /\breserve[s01]?\b/.test(func.body);

    // Must be a view function (reads state, does not modify)
    const isView = /\bview\b/.test(func.fullDeclaration);

    if (isView && readsState) {
      // Check if any state the function reads is modified by other non-view functions
      // This is a simplified check: if the contract has any state-modifying function
      // that touches similar state, flag it
      const stateVarPattern = func.body.match(/\b(\w+)\s*\[/);
      if (stateVarPattern) {
        const stateVar = stateVarPattern[1];
        const modifiesPattern = new RegExp(`\\b${this.escapeRegex(stateVar)}\\s*\\[.*?\\]\\s*=`);
        if (modifiesPattern.test(source)) {
          risks.push({
            functionName: func.name,
            riskType: 'state_dependent_return',
            severity: 'medium',
            description:
              `Function '${func.name}' reads state variable '${stateVar}' and returns a value without access control. ` +
              'A searcher could sandwich a transaction that modifies this state to extract value.',
            line: func.line,
            mitigation:
              'Add access control, use commit-reveal schemes, or add a deadline/slippage parameter to callers that depend on this value.',
          });
        }
      }
    }

    return risks;
  }

  /**
   * Detect unprotected swap functions.
   *
   * Functions named swap/exchange that lack slippage protection parameters
   * (minAmountOut, amountOutMin, deadline) are vulnerable to sandwich attacks.
   */
  private detectUnprotectedSwap(func: ParsedFunction): MEVRisk[] {
    const risks: MEVRisk[] = [];

    // Only check external/public functions
    if (func.visibility !== 'external' && func.visibility !== 'public') {
      return risks;
    }

    // Check if function name suggests a swap
    const swapNames = /^(swap|exchange|trade|convert|buy|sell)\w*/i;
    if (!swapNames.test(func.name)) {
      return risks;
    }

    // Check for slippage protection parameters in the declaration
    const slippageParams = [
      'minAmountOut',
      'amountOutMin',
      'minAmount',
      'minimumAmount',
      'amountOutMinimum',
      'minReturn',
      'minOutput',
      'sqrtPriceLimitX96',
    ];

    const hasSlippageProtection = slippageParams.some((param) =>
      func.fullDeclaration.toLowerCase().includes(param.toLowerCase())
    );

    // Check for deadline parameter
    const deadlineParams = ['deadline', 'expiry', 'validUntil', 'expiration'];
    const hasDeadline = deadlineParams.some((param) =>
      func.fullDeclaration.toLowerCase().includes(param.toLowerCase())
    );

    if (!hasSlippageProtection) {
      risks.push({
        functionName: func.name,
        riskType: 'unprotected_swap',
        severity: 'high',
        description:
          `Swap function '${func.name}' lacks slippage protection parameters (e.g., minAmountOut). ` +
          'Users can lose funds to sandwich attacks where an attacker front-runs to move the price.',
        line: func.line,
        mitigation:
          'Add a minAmountOut (or equivalent) parameter and validate the output amount. ' +
          (hasDeadline
            ? 'A deadline parameter is present, which helps but does not prevent sandwich attacks.'
            : 'Also add a deadline parameter to prevent stale transactions from executing.'),
      });
    } else if (!hasDeadline) {
      risks.push({
        functionName: func.name,
        riskType: 'unprotected_swap',
        severity: 'low',
        description:
          `Swap function '${func.name}' has slippage protection but no deadline parameter. ` +
          'Without a deadline, a pending transaction could be held and executed later at an unfavorable price.',
        line: func.line,
        mitigation:
          'Add a deadline parameter and check block.timestamp <= deadline to prevent stale execution.',
      });
    }

    return risks;
  }

  /**
   * Detect oracle manipulation risks.
   *
   * Functions reading from price oracles (latestRoundData, getPrice, latestAnswer)
   * without TWAP or multi-oracle validation are susceptible to flash-loan
   * powered oracle manipulation.
   */
  private detectOracleManipulation(func: ParsedFunction, _source: string): MEVRisk[] {
    const risks: MEVRisk[] = [];

    // Check for oracle reads in the function body
    const oraclePatterns = [
      { pattern: /\blatestRoundData\s*\(/, name: 'Chainlink latestRoundData' },
      { pattern: /\blatestAnswer\s*\(/, name: 'Chainlink latestAnswer' },
      { pattern: /\bgetPrice\s*\(/, name: 'getPrice' },
      { pattern: /\bgetLatestPrice\s*\(/, name: 'getLatestPrice' },
      { pattern: /\bgetReserves\s*\(/, name: 'getReserves (spot price)' },
      { pattern: /\bspot[Pp]rice/, name: 'spot price read' },
    ];

    const matchedOracles: string[] = [];
    for (const { pattern, name } of oraclePatterns) {
      if (pattern.test(func.body)) {
        matchedOracles.push(name);
      }
    }

    if (matchedOracles.length === 0) {
      return risks;
    }

    // Check if TWAP or time-weighted average is used
    const hasTWAP =
      /\btwap\b/i.test(func.body) ||
      /\btimeWeightedAverage/i.test(func.body) ||
      /\bobserve\s*\(/.test(func.body) || // Uniswap V3 TWAP
      /\bconsult\s*\(/.test(func.body); // TWAP oracle consult

    // Check for multi-oracle validation
    const hasMultiOracle = /\bmedian\b/i.test(func.body) || /\baggregat/i.test(func.body);

    // Check for staleness validation (latestRoundData)
    const hasStalenessCheck =
      /updatedAt\s*[+><!]/.test(func.body) ||
      /block\.timestamp\s*-\s*updatedAt/.test(func.body) ||
      /answeredInRound\s*>=\s*roundId/.test(func.body);

    if (!hasTWAP && !hasMultiOracle) {
      const severity: 'high' | 'medium' | 'low' = matchedOracles.some(
        (o) => o.includes('getReserves') || o.includes('spot')
      )
        ? 'high'
        : hasStalenessCheck
          ? 'medium'
          : 'high';

      let description = `Function '${func.name}' reads from ${matchedOracles.join(', ')} without TWAP protection. `;

      if (matchedOracles.some((o) => o.includes('getReserves') || o.includes('spot'))) {
        description +=
          'Using spot prices from AMM reserves is especially dangerous as they can be manipulated within a single transaction via flash loans.';
      } else {
        description +=
          'An attacker could manipulate the oracle price within a single block to extract value.';
      }

      if (!hasStalenessCheck && matchedOracles.some((o) => o.includes('Chainlink'))) {
        description += ' Additionally, there is no staleness check on the oracle response.';
      }

      risks.push({
        functionName: func.name,
        riskType: 'oracle_manipulation',
        severity,
        description,
        line: func.line,
        mitigation:
          'Use a TWAP oracle (e.g., Uniswap V3 observe()) or aggregate prices from multiple independent oracles. ' +
          'For Chainlink, validate updatedAt for staleness and answeredInRound >= roundId. ' +
          'Never use AMM spot prices (getReserves) for critical pricing logic.',
      });
    }

    return risks;
  }

  /**
   * Detect sandwich attack vulnerability.
   *
   * Functions that both read and modify a price-related state variable within
   * the same transaction can be sandwiched: an attacker manipulates the price
   * before the victim's transaction and reverses it after.
   */
  private detectSandwichAttack(func: ParsedFunction, _source: string): MEVRisk[] {
    const risks: MEVRisk[] = [];

    // Only check external/public non-view functions
    if (func.visibility !== 'external' && func.visibility !== 'public') {
      return risks;
    }

    // Skip view/pure functions
    if (/\b(view|pure)\b/.test(func.fullDeclaration)) {
      return risks;
    }

    // Price-related state variable patterns
    const priceVarPatterns = [
      /\b(price|rate|reserve|liquidity|totalSupply|k)\s*[=[]/i,
      /\b(price|rate|reserve)\w*\s*=/i,
    ];

    // Check if function both reads and writes a price-related variable
    const priceReadPatterns = [/\b(price|rate|reserve[s01]?|liquidity|totalSupply)\b/i];

    let readsPrice = false;
    let writesPrice = false;
    let priceVarName = '';

    for (const pattern of priceReadPatterns) {
      const readMatch = func.body.match(pattern);
      if (readMatch) {
        readsPrice = true;
        priceVarName = readMatch[1];
        break;
      }
    }

    for (const pattern of priceVarPatterns) {
      if (pattern.test(func.body)) {
        writesPrice = true;
        break;
      }
    }

    if (readsPrice && writesPrice) {
      // Additional check: does the function also transfer tokens or ETH?
      const hasTransfer =
        /\.transfer\s*\(/.test(func.body) ||
        /\.call\s*\{/.test(func.body) ||
        /\btransferFrom\s*\(/.test(func.body) ||
        /\bsafeTransfer(From)?\s*\(/.test(func.body);

      if (hasTransfer) {
        risks.push({
          functionName: func.name,
          riskType: 'sandwich_attack',
          severity: 'high',
          description:
            `Function '${func.name}' reads and modifies price-related state ('${priceVarName}') and performs token transfers. ` +
            'An attacker can sandwich this transaction: front-run to skew the price, let the victim execute at a worse price, then back-run to profit.',
          line: func.line,
          mitigation:
            'Implement slippage checks (require amountOut >= minAmountOut). Use commit-reveal patterns for large trades. ' +
            'Consider using a batch auction mechanism or private mempools (Flashbots Protect).',
        });
      } else {
        risks.push({
          functionName: func.name,
          riskType: 'sandwich_attack',
          severity: 'medium',
          description:
            `Function '${func.name}' both reads and modifies price-related state ('${priceVarName}'). ` +
            'This pattern can be exploited if external actors can influence the price state before this function executes.',
          line: func.line,
          mitigation:
            'Add slippage protection parameters. Consider using block-level price caching or TWAP for price reads within the function.',
        });
      }
    }

    return risks;
  }

  /**
   * Detect timestamp dependency.
   *
   * Functions using block.timestamp or block.number in conditionals can be
   * manipulated by miners/validators within certain bounds (typically ~15 seconds
   * for timestamp, 1 block for block number).
   */
  private detectTimestampDependency(func: ParsedFunction): MEVRisk[] {
    const risks: MEVRisk[] = [];

    // Check for block.timestamp in conditionals
    const timestampInConditional =
      /if\s*\(.*\bblock\.timestamp\b/.test(func.body) ||
      /require\s*\(.*\bblock\.timestamp\b/.test(func.body) ||
      /\bblock\.timestamp\b.*[<>=!]+/.test(func.body) ||
      /[<>=!]+.*\bblock\.timestamp\b/.test(func.body);

    // Check for block.number in conditionals
    const blockNumberInConditional =
      /if\s*\(.*\bblock\.number\b/.test(func.body) ||
      /require\s*\(.*\bblock\.number\b/.test(func.body) ||
      /\bblock\.number\b.*[<>=!]+/.test(func.body) ||
      /[<>=!]+.*\bblock\.number\b/.test(func.body);

    // Check if timestamp is used for randomness (very dangerous)
    const timestampForRandomness =
      /keccak256\s*\(.*\bblock\.timestamp\b/.test(func.body) ||
      /\bblock\.timestamp\b.*\bhash\b/.test(func.body) ||
      /abi\.encodePacked\s*\(.*\bblock\.timestamp\b/.test(func.body);

    // Check if block.number is used for randomness
    const blockNumberForRandomness =
      /keccak256\s*\(.*\bblock\.number\b/.test(func.body) ||
      /abi\.encodePacked\s*\(.*\bblock\.number\b/.test(func.body);

    if (timestampForRandomness || blockNumberForRandomness) {
      const variable = timestampForRandomness ? 'block.timestamp' : 'block.number';
      risks.push({
        functionName: func.name,
        riskType: 'timestamp_dependency',
        severity: 'high',
        description:
          `Function '${func.name}' uses ${variable} as a source of randomness. ` +
          'Miners/validators can manipulate this value to influence outcomes. This is NOT a secure randomness source.',
        line: func.line,
        mitigation:
          'Use Chainlink VRF or a commit-reveal scheme for secure on-chain randomness. ' +
          'Never use block.timestamp, block.number, or blockhash for random number generation.',
      });
    } else if (timestampInConditional) {
      // Check if it's just a deadline check (common and usually acceptable)
      const isDeadlineCheck =
        /\bdeadline\b/.test(func.body) &&
        /block\.timestamp\s*[<>]=?\s*\w*deadline/i.test(func.body);

      if (!isDeadlineCheck) {
        risks.push({
          functionName: func.name,
          riskType: 'timestamp_dependency',
          severity: 'medium',
          description:
            `Function '${func.name}' uses block.timestamp in a conditional. ` +
            'Validators can manipulate timestamps within ~15 seconds, which may affect time-sensitive logic.',
          line: func.line,
          mitigation:
            'Avoid relying on exact block.timestamp values. Use a tolerance window for time comparisons. ' +
            'For critical timing logic, consider using block.number with known block times as a more predictable alternative.',
        });
      }
    } else if (blockNumberInConditional) {
      risks.push({
        functionName: func.name,
        riskType: 'timestamp_dependency',
        severity: 'low',
        description:
          `Function '${func.name}' uses block.number in a conditional. ` +
          'While less manipulable than timestamp, validators can still influence which block a transaction lands in.',
        line: func.line,
        mitigation:
          'Ensure block number checks have sufficient buffer to account for inclusion delays. ' +
          'Consider using a commit-reveal pattern for time-sensitive operations.',
      });
    }

    return risks;
  }

  /**
   * Escape special regex characters in a string for safe use in RegExp constructor.
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
