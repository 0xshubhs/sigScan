/**
 * Invariant Detector - Pattern-match Solidity source for common invariants
 *
 * Detects common smart contract invariant patterns including:
 * - Balance tracking (mapping-based balance management)
 * - Ownership (owner state variable with access control)
 * - Reentrancy guards (nonReentrant, mutex locks, CEI pattern)
 * - Access control (role-based or address-based restrictions)
 * - Pausable (circuit breaker pattern)
 */

import { InvariantInfo } from '../types';

/**
 * Represents a parsed function block extracted from Solidity source.
 */
interface FunctionBlock {
  name: string;
  line: number;
  body: string;
  fullDeclaration: string;
}

export class InvariantDetector {
  /**
   * Detect invariant patterns in Solidity source code.
   *
   * Scans the source for known invariant patterns and returns an array of
   * InvariantInfo objects describing each detected pattern, its location,
   * confidence level, and related functions.
   *
   * @param source - The Solidity source code to analyze
   * @returns Array of detected invariant patterns
   */
  public detect(source: string): InvariantInfo[] {
    const invariants: InvariantInfo[] = [];
    const lines = source.split('\n');
    const functions = this.extractFunctionBlocks(source, lines);

    const balanceInvariant = this.detectBalanceTracking(source, lines, functions);
    if (balanceInvariant) {
      invariants.push(balanceInvariant);
    }

    const ownershipInvariant = this.detectOwnership(source, lines, functions);
    if (ownershipInvariant) {
      invariants.push(ownershipInvariant);
    }

    const reentrancyInvariant = this.detectReentrancyGuard(source, lines, functions);
    if (reentrancyInvariant) {
      invariants.push(reentrancyInvariant);
    }

    const accessControlInvariant = this.detectAccessControl(source, lines, functions);
    if (accessControlInvariant) {
      invariants.push(accessControlInvariant);
    }

    const pausableInvariant = this.detectPausable(source, lines, functions);
    if (pausableInvariant) {
      invariants.push(pausableInvariant);
    }

    return invariants;
  }

  /**
   * Extract function blocks from source for cross-referencing patterns.
   */
  private extractFunctionBlocks(source: string, _lines: string[]): FunctionBlock[] {
    const blocks: FunctionBlock[] = [];
    const funcRegex = /function\s+(\w+)\s*\([^)]*\)[^{]*\{/g;
    let match: RegExpExecArray | null;

    while ((match = funcRegex.exec(source)) !== null) {
      const name = match[1];
      const startOffset = match.index;
      const line = this.offsetToLine(source, startOffset);
      const body = this.extractBraceBlock(source, match.index + match[0].length - 1);

      blocks.push({
        name,
        line,
        body,
        fullDeclaration: match[0],
      });
    }

    return blocks;
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
   * Extract the content of a brace-delimited block starting at the given open brace.
   */
  private extractBraceBlock(source: string, openBraceIndex: number): string {
    let depth = 0;
    let i = openBraceIndex;

    for (; i < source.length; i++) {
      if (source[i] === '{') {
        depth++;
      } else if (source[i] === '}') {
        depth--;
        if (depth === 0) {
          return source.substring(openBraceIndex, i + 1);
        }
      }
    }

    // If unbalanced, return whatever we have
    return source.substring(openBraceIndex);
  }

  /**
   * Find the 1-based line number of the first occurrence of a pattern.
   */
  private findFirstLine(lines: string[], pattern: RegExp): number {
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        return i + 1; // 1-based
      }
    }
    return 1;
  }

  /**
   * Detect balance tracking invariant.
   *
   * Looks for mapping variables named balances, _balances, balanceOf, etc.
   * and checks if they are used within transfer-like functions.
   */
  private detectBalanceTracking(
    source: string,
    lines: string[],
    functions: FunctionBlock[]
  ): InvariantInfo | null {
    // Check for balance-related state variables
    const balanceVarPatterns = [
      /mapping\s*\([^)]*\)\s*(public\s+|private\s+|internal\s+)?(balances|_balances|balanceOf)\b/,
      /mapping\s*\([^)]*\)\s*(public\s+|private\s+|internal\s+)?_?balance[sS]?\b/,
    ];

    let hasBalanceVar = false;
    let firstLine = 0;

    for (const pattern of balanceVarPatterns) {
      if (pattern.test(source)) {
        hasBalanceVar = true;
        firstLine = this.findFirstLine(lines, pattern);
        break;
      }
    }

    if (!hasBalanceVar) {
      return null;
    }

    // Find functions that reference balance variables in transfer-like operations
    const relatedFunctions: string[] = [];
    const balanceRefPattern = /\b(balances|_balances|balanceOf)\s*\[/;
    const transferLikeNames = /transfer|mint|burn|deposit|withdraw|send/i;

    for (const func of functions) {
      if (balanceRefPattern.test(func.body)) {
        relatedFunctions.push(func.name);
      }
    }

    // If we have the variable but no functions referencing it, still report with lower confidence
    if (relatedFunctions.length === 0) {
      // Check if any function name suggests transfer-like behavior
      for (const func of functions) {
        if (transferLikeNames.test(func.name)) {
          relatedFunctions.push(func.name);
        }
      }
    }

    const hasTransferFunctions = relatedFunctions.some((name) => transferLikeNames.test(name));
    const confidence: 'high' | 'medium' | 'low' = hasTransferFunctions
      ? 'high'
      : relatedFunctions.length > 0
        ? 'medium'
        : 'low';

    return {
      type: 'balance_tracking',
      description:
        'Contract tracks token balances via a mapping. Invariant: total supply should equal the sum of all individual balances.',
      line: firstLine,
      confidence,
      relatedFunctions,
    };
  }

  /**
   * Detect ownership invariant.
   *
   * Looks for an `owner` state variable combined with `onlyOwner` modifier
   * or `msg.sender == owner` checks.
   */
  private detectOwnership(
    source: string,
    lines: string[],
    functions: FunctionBlock[]
  ): InvariantInfo | null {
    // Check for owner state variable
    const ownerVarPattern = /\b(address)\s+(public\s+|private\s+|internal\s+)?_?owner\b/;
    const hasOwnerVar = ownerVarPattern.test(source);

    if (!hasOwnerVar) {
      return null;
    }

    const firstLine = this.findFirstLine(lines, ownerVarPattern);

    // Check for onlyOwner modifier definition or usage
    const hasOnlyOwnerModifier = /modifier\s+onlyOwner\b/.test(source);
    const hasOnlyOwnerUsage = /\bonlyOwner\b/.test(source);

    // Check for msg.sender == owner pattern
    const hasMsgSenderCheck =
      /require\s*\(\s*msg\.sender\s*==\s*_?owner\b/.test(source) ||
      /require\s*\(\s*_?owner\s*==\s*msg\.sender\b/.test(source) ||
      /if\s*\(\s*msg\.sender\s*!=\s*_?owner\b/.test(source);

    if (!hasOnlyOwnerModifier && !hasOnlyOwnerUsage && !hasMsgSenderCheck) {
      return null;
    }

    // Find functions that use onlyOwner or check owner
    const relatedFunctions: string[] = [];
    const ownerCheckPattern = /\bonlyOwner\b|msg\.sender\s*==\s*_?owner|_?owner\s*==\s*msg\.sender/;

    for (const func of functions) {
      if (ownerCheckPattern.test(func.fullDeclaration) || ownerCheckPattern.test(func.body)) {
        relatedFunctions.push(func.name);
      }
    }

    // Also check for ownership transfer functions
    for (const func of functions) {
      if (/transferOwnership|renounceOwnership/i.test(func.name)) {
        if (!relatedFunctions.includes(func.name)) {
          relatedFunctions.push(func.name);
        }
      }
    }

    const confidence: 'high' | 'medium' | 'low' =
      hasOnlyOwnerModifier && relatedFunctions.length > 0
        ? 'high'
        : hasOnlyOwnerUsage || hasMsgSenderCheck
          ? 'medium'
          : 'low';

    return {
      type: 'ownership',
      description:
        'Contract implements ownership pattern. Invariant: only the designated owner can execute privileged operations.',
      line: firstLine,
      confidence,
      relatedFunctions,
    };
  }

  /**
   * Detect reentrancy guard invariant.
   *
   * Looks for nonReentrant modifier, _locked/_status state variables,
   * or checks-effects-interactions pattern.
   */
  private detectReentrancyGuard(
    source: string,
    lines: string[],
    functions: FunctionBlock[]
  ): InvariantInfo | null {
    let firstLine = 0;
    let confidence: 'high' | 'medium' | 'low' = 'low';
    const relatedFunctions: string[] = [];

    // Check for nonReentrant modifier
    const hasNonReentrantModifier = /modifier\s+nonReentrant\b/.test(source);
    const hasNonReentrantUsage = /\bnonReentrant\b/.test(source);

    // Check for lock/status state variables
    const hasLockVar =
      /\b(bool|uint256)\s+(private\s+|internal\s+)?(_locked|_status|locked|_notEntered)\b/.test(
        source
      );

    // Check for ReentrancyGuard import or inheritance
    const hasReentrancyGuardImport =
      /import\s+.*ReentrancyGuard/.test(source) || /\bis\s+.*ReentrancyGuard\b/.test(source);

    if (
      !hasNonReentrantModifier &&
      !hasNonReentrantUsage &&
      !hasLockVar &&
      !hasReentrancyGuardImport
    ) {
      // Check for checks-effects-interactions pattern: state changes before external calls
      // This is a weaker signal
      let hasCEIPattern = false;
      for (const func of functions) {
        // Look for functions that do a state write then an external call
        const hasStateWrite =
          /\b\w+\s*\[.*?\]\s*=/.test(func.body) || /\b\w+\s*=\s*/.test(func.body);
        const hasExternalCall =
          /\.call\b/.test(func.body) ||
          /\.transfer\b/.test(func.body) ||
          /\.send\b/.test(func.body);

        if (hasStateWrite && hasExternalCall) {
          hasCEIPattern = true;
          relatedFunctions.push(func.name);
        }
      }

      if (!hasCEIPattern) {
        return null;
      }

      firstLine =
        relatedFunctions.length > 0
          ? (functions.find((f) => f.name === relatedFunctions[0])?.line ?? 1)
          : 1;
      confidence = 'low';

      return {
        type: 'reentrancy_guard',
        description:
          'Functions contain state changes before external calls (checks-effects-interactions pattern detected). Consider adding explicit reentrancy guards.',
        line: firstLine,
        confidence,
        relatedFunctions,
      };
    }

    // Determine first line from the most specific pattern found
    if (hasNonReentrantModifier) {
      firstLine = this.findFirstLine(lines, /modifier\s+nonReentrant\b/);
      confidence = 'high';
    } else if (hasReentrancyGuardImport) {
      firstLine = this.findFirstLine(lines, /ReentrancyGuard/);
      confidence = 'high';
    } else if (hasLockVar) {
      firstLine = this.findFirstLine(lines, /\b(_locked|_status|locked|_notEntered)\b/);
      confidence = 'medium';
    } else if (hasNonReentrantUsage) {
      firstLine = this.findFirstLine(lines, /\bnonReentrant\b/);
      confidence = 'medium';
    }

    // Find functions that use nonReentrant
    for (const func of functions) {
      if (/\bnonReentrant\b/.test(func.fullDeclaration)) {
        relatedFunctions.push(func.name);
      }
    }

    // If no specific functions found, check for functions with external calls
    if (relatedFunctions.length === 0) {
      for (const func of functions) {
        const hasExternalCall =
          /\.call\b/.test(func.body) ||
          /\.transfer\b/.test(func.body) ||
          /\.send\b/.test(func.body);
        if (hasExternalCall) {
          relatedFunctions.push(func.name);
        }
      }
    }

    return {
      type: 'reentrancy_guard',
      description:
        'Contract implements reentrancy protection. Invariant: no function can be re-entered while a guarded function is executing.',
      line: firstLine,
      confidence,
      relatedFunctions,
    };
  }

  /**
   * Detect access control invariant.
   *
   * Looks for role-based access control (hasRole, onlyRole) or
   * address-based access control (require(msg.sender == ...)).
   */
  private detectAccessControl(
    source: string,
    lines: string[],
    functions: FunctionBlock[]
  ): InvariantInfo | null {
    // Check for role-based access control
    const hasRolePattern = /\bhasRole\s*\(/.test(source);
    const hasOnlyRolePattern = /\bonlyRole\b/.test(source);
    const hasAccessControlImport =
      /import\s+.*AccessControl/.test(source) || /\bis\s+.*AccessControl\b/.test(source);

    // Check for general require(msg.sender == ...) patterns (excluding owner which is handled separately)
    const hasMsgSenderRequire =
      /require\s*\(\s*msg\.sender\s*==\s*(?!_?owner\b)\w+/.test(source) ||
      /require\s*\(\s*\w+\s*==\s*msg\.sender\b/.test(source);

    // Check for modifier-based access control (excluding onlyOwner)
    const hasCustomModifier = /modifier\s+only(?!Owner\b)\w+/.test(source);

    if (
      !hasRolePattern &&
      !hasOnlyRolePattern &&
      !hasAccessControlImport &&
      !hasMsgSenderRequire &&
      !hasCustomModifier
    ) {
      return null;
    }

    let firstLine: number;
    let confidence: 'high' | 'medium' | 'low';

    if (hasAccessControlImport || hasRolePattern) {
      firstLine = this.findFirstLine(lines, /AccessControl|hasRole/);
      confidence = 'high';
    } else if (hasOnlyRolePattern || hasCustomModifier) {
      firstLine = this.findFirstLine(lines, /onlyRole|modifier\s+only\w+/);
      confidence = 'medium';
    } else {
      firstLine = this.findFirstLine(lines, /require\s*\(\s*msg\.sender/);
      confidence = 'low';
    }

    // Find functions that reference access control
    const relatedFunctions: string[] = [];
    const accessCheckPattern =
      /\bhasRole\b|\bonlyRole\b|require\s*\(\s*msg\.sender\s*==|modifier\s+only\w+/;

    for (const func of functions) {
      if (
        accessCheckPattern.test(func.fullDeclaration) ||
        accessCheckPattern.test(func.body) ||
        /\bonly(?!Owner\b)\w+/.test(func.fullDeclaration)
      ) {
        relatedFunctions.push(func.name);
      }
    }

    return {
      type: 'access_control',
      description:
        'Contract implements access control restrictions. Invariant: protected functions can only be called by authorized addresses or roles.',
      line: firstLine,
      confidence,
      relatedFunctions,
    };
  }

  /**
   * Detect pausable invariant.
   *
   * Looks for whenNotPaused modifier and _paused state variable.
   */
  private detectPausable(
    source: string,
    lines: string[],
    functions: FunctionBlock[]
  ): InvariantInfo | null {
    // Check for whenNotPaused / whenPaused modifier usage
    const hasWhenNotPaused = /\bwhenNotPaused\b/.test(source);
    const hasWhenPaused = /\bwhenPaused\b/.test(source);

    // Check for _paused / paused state variable
    const hasPausedVar = /\bbool\s+(public\s+|private\s+|internal\s+)?_?paused\b/.test(source);

    // Check for Pausable import or inheritance
    const hasPausableImport =
      /import\s+.*Pausable/.test(source) || /\bis\s+.*Pausable\b/.test(source);

    // Check for pause/unpause functions
    const hasPauseFunctions = /function\s+(pause|unpause|_pause|_unpause)\s*\(/.test(source);

    if (
      !hasWhenNotPaused &&
      !hasWhenPaused &&
      !hasPausedVar &&
      !hasPausableImport &&
      !hasPauseFunctions
    ) {
      return null;
    }

    let firstLine: number;
    let confidence: 'high' | 'medium' | 'low';

    if (hasPausableImport || (hasWhenNotPaused && hasPausedVar)) {
      confidence = 'high';
      firstLine = this.findFirstLine(lines, /Pausable|_?paused\b/);
    } else if (hasWhenNotPaused || hasPauseFunctions) {
      confidence = 'medium';
      firstLine = this.findFirstLine(lines, /whenNotPaused|function\s+(pause|unpause)/);
    } else {
      confidence = 'low';
      firstLine = this.findFirstLine(lines, /_?paused\b/);
    }

    // Find functions that use whenNotPaused
    const relatedFunctions: string[] = [];

    for (const func of functions) {
      if (
        /\bwhenNotPaused\b/.test(func.fullDeclaration) ||
        /\bwhenPaused\b/.test(func.fullDeclaration)
      ) {
        relatedFunctions.push(func.name);
      }
    }

    // Also add pause/unpause functions themselves
    for (const func of functions) {
      if (/^(pause|unpause|_pause|_unpause)$/.test(func.name)) {
        if (!relatedFunctions.includes(func.name)) {
          relatedFunctions.push(func.name);
        }
      }
    }

    return {
      type: 'pausable',
      description:
        'Contract implements a pause mechanism (circuit breaker). Invariant: guarded functions cannot execute while the contract is paused.',
      line: firstLine,
      confidence,
      relatedFunctions,
    };
  }
}
