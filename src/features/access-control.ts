/**
 * Access Control Analyzer
 *
 * Detects public/external state-changing functions that lack
 * access control modifiers (onlyOwner, onlyRole, msg.sender checks).
 */

export interface AccessControlWarning {
  line: number;
  functionName: string;
  severity: 'critical' | 'high' | 'medium' | 'info';
  description: string;
}

export class AccessControlAnalyzer {
  // Known access control modifiers
  private accessModifiers = [
    /\bonlyOwner\b/,
    /\bonlyRole\b/,
    /\bonlyAdmin\b/,
    /\bonlyMinter\b/,
    /\bonlyGovernance\b/,
    /\bonlyAuthorized\b/,
    /\bonlyOperator\b/,
    /\bonlyManager\b/,
    /\bonlyPauser\b/,
    /\bwhenNotPaused\b/,
    /\bauth\b/,
    /\brequireAuth\b/,
    /\bonly[A-Z]\w+/, // any onlyX modifier
  ];

  // Functions that are sensitive without access control
  private sensitiveFunctionPatterns = [
    { pattern: /\b(mint|_mint)\b/i, severity: 'high' as const, label: 'minting' },
    { pattern: /\b(burn|_burn)\b/i, severity: 'high' as const, label: 'burning' },
    {
      pattern: /\b(pause|unpause|_pause|_unpause)\b/i,
      severity: 'high' as const,
      label: 'pausing',
    },
    {
      pattern: /\b(set|update|change)(Owner|Admin|Fee|Rate|Price|Config|Param)/i,
      severity: 'high' as const,
      label: 'admin setter',
    },
    {
      pattern: /\b(withdraw|emergencyWithdraw)\b/i,
      severity: 'high' as const,
      label: 'withdrawal',
    },
    { pattern: /\b(upgrade|upgradeTo)\b/i, severity: 'high' as const, label: 'upgrade' },
    { pattern: /\bselfdestruct\b/, severity: 'high' as const, label: 'selfdestruct' },
    {
      pattern: /\b(grant|revoke)(Role|Access)\b/i,
      severity: 'high' as const,
      label: 'role management',
    },
    {
      pattern: /\b(blacklist|whitelist|ban|allow)\b/i,
      severity: 'medium' as const,
      label: 'access list',
    },
    {
      pattern: /\b(transfer|send).*\b(ETH|ether|token)\b/i,
      severity: 'medium' as const,
      label: 'token movement',
    },
    { pattern: /\b(rescue|recover|sweep)\b/i, severity: 'high' as const, label: 'token recovery' },
    {
      pattern: /\b(setImplementation|updateProxy)\b/i,
      severity: 'high' as const,
      label: 'proxy admin',
    },
    {
      pattern: /\b(addMinter|removeMinter)\b/i,
      severity: 'high' as const,
      label: 'minter management',
    },
    {
      pattern: /\b(setOracle|updateOracle|setPriceFeed)\b/i,
      severity: 'high' as const,
      label: 'oracle configuration',
    },
  ];

  detect(source: string): AccessControlWarning[] {
    const warnings: AccessControlWarning[] = [];
    const lines = source.split('\n');

    // Check if contract inherits from Ownable/AccessControl
    const hasAccessControlBase = /\b(Ownable|AccessControl|Owned|Auth)\b/.test(source);

    const funcPattern = /function\s+(\w+)\s*\(([^)]*)\)([^{]*)\{/;

    for (let i = 0; i < lines.length; i++) {
      const funcMatch = funcPattern.exec(lines[i]);
      if (!funcMatch) {
        continue;
      }

      const funcName = funcMatch[1];
      const modifiers = funcMatch[3];

      // Only check public/external functions
      if (!/\b(public|external)\b/.test(modifiers)) {
        continue;
      }

      // Skip view/pure
      if (/\b(view|pure)\b/.test(modifiers)) {
        continue;
      }

      // Check if it has access control modifier
      const hasModifier = this.accessModifiers.some((p) => p.test(modifiers));

      // Check if the function body has a msg.sender check (within first few lines)
      let hasMsgSenderCheck = false;
      let depth = 0;
      let foundOpen = false;
      for (let j = i; j < Math.min(i + 10, lines.length); j++) {
        for (const ch of lines[j]) {
          if (ch === '{') {
            depth++;
            foundOpen = true;
          }
          if (ch === '}') {
            depth--;
          }
        }
        if (/\bmsg\.sender\b/.test(lines[j]) && /\b(require|if|assert)\b/.test(lines[j])) {
          hasMsgSenderCheck = true;
          break;
        }
        if (/\b_msgSender\(\)\b/.test(lines[j]) && /\b(require|if|assert)\b/.test(lines[j])) {
          hasMsgSenderCheck = true;
          break;
        }
        if (foundOpen && depth === 0) {
          break;
        }
      }

      if (hasModifier || hasMsgSenderCheck) {
        continue;
      }

      // Check if function name matches a sensitive pattern
      for (const { pattern, severity, label } of this.sensitiveFunctionPatterns) {
        if (pattern.test(funcName)) {
          warnings.push({
            line: i + 1,
            functionName: funcName,
            severity,
            description: `${label} function \`${funcName}\` has no access control. Anyone can call this function.`,
          });
          break;
        }
      }

      // If contract has Ownable/AccessControl base but function doesn't use it
      if (hasAccessControlBase && !hasModifier && !hasMsgSenderCheck) {
        // Check if it's a state-changing function by scanning body
        let hasStateChange = false;
        depth = 0;
        foundOpen = false;
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
          if (j > i && /\b\w+\s*\[.*\]\s*=[^=]/.test(lines[j])) {
            hasStateChange = true;
          }
          if (foundOpen && depth === 0) {
            break;
          }
        }

        // Only warn if not already warned by sensitive pattern
        if (hasStateChange && !warnings.some((w) => w.line === i + 1)) {
          warnings.push({
            line: i + 1,
            functionName: funcName,
            severity: 'medium',
            description: `Contract inherits access control but \`${funcName}\` has no modifier. Intentional?`,
          });
        }
      }
    }

    // --- Centralization risk: Pausable + single onlyOwner pause ---
    const hasPausable = /\bPausable\b/.test(source);
    if (hasPausable) {
      const pauseFuncPattern = /function\s+pause\s*\(([^)]*)\)([^{]*)\{/;
      for (let i = 0; i < lines.length; i++) {
        const m = pauseFuncPattern.exec(lines[i]);
        if (!m) {
          continue;
        }
        const mods = m[2];
        if (/\bonlyOwner\b/.test(mods)) {
          const hasTimelockOrMultisig =
            /\b(timelock|Timelock|TimeLock|multisig|MultiSig|Multisig|governance|Governance|DAO)\b/.test(
              source
            );
          if (!hasTimelockOrMultisig) {
            warnings.push({
              line: i + 1,
              functionName: 'pause',
              severity: 'medium',
              description:
                'Centralization risk: `pause()` is controlled by a single owner with no timelock, multisig, or governance. A compromised owner key can halt the contract.',
            });
          }
        }
      }
    }

    // --- Missing two-step ownership transfer ---
    const hasOwnable = /\bOwnable\b/.test(source);
    const hasOwnable2Step = /\bOwnable2Step\b/.test(source);
    if (hasOwnable && !hasOwnable2Step) {
      // Find the contract declaration line for accurate reporting
      let contractLine = 1;
      for (let i = 0; i < lines.length; i++) {
        if (/\bcontract\s+\w+/.test(lines[i]) && /\bOwnable\b/.test(lines[i])) {
          contractLine = i + 1;
          break;
        }
      }
      warnings.push({
        line: contractLine,
        functionName: 'transferOwnership',
        severity: 'medium',
        description:
          'Contract uses `Ownable` without `Ownable2Step`. Single-step `transferOwnership()` can permanently lose access if the wrong address is provided.',
      });
    }

    // --- Unprotected initialize() / init() function ---
    const initFuncPattern = /function\s+(initialize|init)\s*\(([^)]*)\)([^{]*)\{/;
    for (let i = 0; i < lines.length; i++) {
      const m = initFuncPattern.exec(lines[i]);
      if (!m) {
        continue;
      }
      const initName = m[1];
      const mods = m[3];
      const isPublicOrExternal = /\b(public|external)\b/.test(mods);
      const hasInitializerModifier = /\binitializer\b/.test(mods);
      if (isPublicOrExternal && !hasInitializerModifier) {
        warnings.push({
          line: i + 1,
          functionName: initName,
          severity: 'critical',
          description: `Unprotected \`${initName}()\` function is public/external without an \`initializer\` modifier. Upgradeable contracts can be taken over by anyone calling this function.`,
        });
      }
    }

    return warnings;
  }

  generateReport(warnings: AccessControlWarning[]): string {
    const lines = ['# Access Control Analysis\n'];

    if (warnings.length === 0) {
      lines.push('No access control issues detected.\n');
      return lines.join('\n');
    }

    const critical = warnings.filter((w) => w.severity === 'critical');
    const high = warnings.filter((w) => w.severity === 'high');
    const medium = warnings.filter((w) => w.severity === 'medium');

    lines.push(`Found **${warnings.length}** issue(s):\n`);
    if (critical.length) {
      lines.push(`- ⛔ Critical: ${critical.length}`);
    }
    if (high.length) {
      lines.push(`- 🔴 High: ${high.length}`);
    }
    if (medium.length) {
      lines.push(`- 🟡 Medium: ${medium.length}`);
    }
    lines.push('');

    for (const w of warnings) {
      const icon = w.severity === 'critical' ? '⛔' : w.severity === 'high' ? '🔴' : '🟡';
      lines.push(`## ${icon} ${w.functionName}() — Line ${w.line}\n`);
      lines.push(`**Severity:** ${w.severity}`);
      lines.push(`**Issue:** ${w.description}\n`);
    }

    return lines.join('\n');
  }
}
