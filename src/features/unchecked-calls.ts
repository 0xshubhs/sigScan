/**
 * Unchecked Call Return Detector
 *
 * Flags low-level calls (.call, .delegatecall, .staticcall, .send)
 * where the boolean return value is not checked.
 */

export interface UncheckedCallWarning {
  line: number;
  functionName: string;
  callType: string;
  description: string;
}

export class UncheckedCallDetector {
  /**
   * Detect unchecked low-level calls
   */
  detect(source: string): UncheckedCallWarning[] {
    const warnings: UncheckedCallWarning[] = [];
    const lines = source.split('\n');

    // Track which function we're in
    let currentFunction = '(global)';
    const funcPattern = /function\s+(\w+)\s*\(/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Skip comments
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
        continue;
      }

      // Track current function
      const funcMatch = funcPattern.exec(line);
      if (funcMatch) {
        currentFunction = funcMatch[1];
      }

      // Check for .call{...}(...) or .call(...)
      if (/\.call\s*[({]/.test(line)) {
        if (this.isUnchecked(line, lines, i)) {
          warnings.push({
            line: i + 1,
            functionName: currentFunction,
            callType: '.call()',
            description:
              'Low-level .call() return value not checked. If the call fails, execution continues silently.',
          });
        }
      }

      // Check for .delegatecall(...)
      if (/\.delegatecall\s*\(/.test(line)) {
        if (this.isUnchecked(line, lines, i)) {
          warnings.push({
            line: i + 1,
            functionName: currentFunction,
            callType: '.delegatecall()',
            description:
              'Low-level .delegatecall() return value not checked. Failed delegatecall will be silently ignored.',
          });
        }
      }

      // Check for .staticcall(...)
      if (/\.staticcall\s*\(/.test(line)) {
        if (this.isUnchecked(line, lines, i)) {
          warnings.push({
            line: i + 1,
            functionName: currentFunction,
            callType: '.staticcall()',
            description: 'Low-level .staticcall() return value not checked.',
          });
        }
      }

      // Check for .send(...)
      if (/\.send\s*\(/.test(line)) {
        if (this.isUnchecked(line, lines, i)) {
          warnings.push({
            line: i + 1,
            functionName: currentFunction,
            callType: '.send()',
            description:
              '.send() return value not checked. Use .call{value: ...}("") with a require instead.',
          });
        }
      }

      // Check for unsafe ERC20 calls (missing SafeERC20)
      // IERC20(...).transfer(...) or token.transfer(...) preceded by IERC20 cast
      if (/IERC20\s*\([^)]*\)\s*\.transfer\s*\(/.test(line) && !/safeTransfer/.test(line)) {
        warnings.push({
          line: i + 1,
          functionName: currentFunction,
          callType: 'unsafe-erc20',
          description:
            'Direct IERC20.transfer() call without SafeERC20. Non-standard tokens (e.g. USDT) do not return a bool and will revert. Use SafeERC20.safeTransfer() instead.',
        });
      }

      if (/IERC20\s*\([^)]*\)\s*\.transferFrom\s*\(/.test(line) && !/safeTransferFrom/.test(line)) {
        warnings.push({
          line: i + 1,
          functionName: currentFunction,
          callType: 'unsafe-erc20',
          description:
            'Direct IERC20.transferFrom() call without SafeERC20. Non-standard tokens (e.g. USDT) do not return a bool and will revert. Use SafeERC20.safeTransferFrom() instead.',
        });
      }

      if (/IERC20\s*\([^)]*\)\s*\.approve\s*\(/.test(line) && !/safeApprove/.test(line)) {
        warnings.push({
          line: i + 1,
          functionName: currentFunction,
          callType: 'unsafe-erc20',
          description:
            'Direct IERC20.approve() call without SafeERC20. Non-standard tokens (e.g. USDT) do not return a bool and will revert. Use SafeERC20.safeApprove() instead.',
        });
      }
    }

    return warnings;
  }

  /**
   * Check if a low-level call's return value is unchecked.
   * It's checked if:
   * - Assigned to a variable: (bool success, ) = addr.call(...)
   * - Used in require: require(addr.send(...))
   * - Used in if: if (!addr.send(...))
   */
  private isUnchecked(line: string, lines: string[], index: number): boolean {
    const trimmed = line.trim();

    // Check this line and the previous line for assignment pattern
    const context = (index > 0 ? lines[index - 1] : '') + '\n' + line;

    // (bool success, ) = ... or (bool success, bytes memory data) = ...
    if (/\(\s*bool\s+\w+/.test(context)) {
      return false;
    }

    // bool success = ...
    if (/bool\s+\w+\s*=/.test(context)) {
      return false;
    }

    // require(addr.call(...))
    if (/require\s*\(/.test(trimmed) && /\.(call|send|delegatecall|staticcall)/.test(trimmed)) {
      return false;
    }

    // if (success) or if (!success) on next line — variable was captured
    if (/\(\s*bool\s/.test(trimmed)) {
      return false;
    }

    // Assignment: success = addr.send(...)
    if (/\w+\s*=\s*\w+\.(call|send|delegatecall|staticcall)/.test(trimmed)) {
      return false;
    }

    // The call result is just a statement by itself
    return true;
  }

  generateReport(warnings: UncheckedCallWarning[]): string {
    const lines = ['# Unchecked Low-Level Calls Report\n'];

    if (warnings.length === 0) {
      lines.push('No unchecked low-level calls found.\n');
      return lines.join('\n');
    }

    const lowLevel = warnings.filter((w) => w.callType !== 'unsafe-erc20');
    const unsafeErc20 = warnings.filter((w) => w.callType === 'unsafe-erc20');

    lines.push(
      `Found **${warnings.length}** issue(s): ${lowLevel.length} unchecked call(s), ${unsafeErc20.length} unsafe ERC20 call(s).\n`
    );

    for (const w of lowLevel) {
      lines.push(`## ${w.functionName}() — Line ${w.line}\n`);
      lines.push(`**Call type:** \`${w.callType}\``);
      lines.push(`**Issue:** ${w.description}\n`);
      lines.push(`**Fix:** Capture the return value and check it:\n`);
      lines.push('```solidity');
      lines.push('(bool success, ) = addr.call{value: amount}("");');
      lines.push('require(success, "Call failed");');
      lines.push('```\n');
    }

    if (unsafeErc20.length > 0) {
      lines.push('---\n');
      lines.push('## Unsafe ERC20 Calls (Missing SafeERC20)\n');
      lines.push(
        "Non-standard ERC20 tokens (e.g. USDT, BNB) do not return a `bool` from `transfer`/`approve`. Calling them directly via `IERC20` will revert. Use OpenZeppelin's `SafeERC20` library.\n"
      );
      lines.push('```solidity');
      lines.push(
        'import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";'
      );
      lines.push('using SafeERC20 for IERC20;');
      lines.push('```\n');
      for (const w of unsafeErc20) {
        lines.push(`- **Line ${w.line}** (${w.functionName}): ${w.description}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}
