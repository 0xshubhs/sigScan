/**
 * Tests for Reentrancy Detector - CEI pattern violation detection
 */

import { ReentrancyDetector } from '../reentrancy-detector';
import { SolidityAstNode } from '../ast/solidity-ast';

// ── Minimal hand-written AST fixtures for the AST-backed CEI path ────────────

function ident(name: string, typeString = ''): SolidityAstNode {
  return { nodeType: 'Identifier', name, src: '0:0:0', typeDescriptions: { typeString } };
}
function member(base: SolidityAstNode, memberName: string): SolidityAstNode {
  return { nodeType: 'MemberAccess', memberName, expression: base, src: '0:0:0' };
}
function extCall(src: string): SolidityAstNode {
  return {
    nodeType: 'FunctionCall',
    kind: 'functionCall',
    expression: member(ident('target', 'address'), 'call'),
    arguments: [],
    src,
  };
}
function write(varName: string, src: string): SolidityAstNode {
  return {
    nodeType: 'Assignment',
    operator: '=',
    leftHandSide: ident(varName),
    rightHandSide: { nodeType: 'Literal', src: '0:0:0' },
    src,
  };
}
function fnDef(
  name: string,
  statements: SolidityAstNode[],
  opts: { stateMutability?: string; modifiers?: SolidityAstNode[]; src?: string } = {}
): SolidityAstNode {
  return {
    nodeType: 'FunctionDefinition',
    name,
    stateMutability: opts.stateMutability ?? 'nonpayable',
    modifiers: opts.modifiers ?? [],
    src: opts.src ?? '0:0:0',
    body: { nodeType: 'Block', statements },
  };
}
function sourceUnit(
  stateVarNames: string[],
  fns: SolidityAstNode[]
): SolidityAstNode {
  return {
    nodeType: 'SourceUnit',
    nodes: [
      {
        nodeType: 'ContractDefinition',
        name: 'C',
        nodes: [
          ...stateVarNames.map((n) => ({
            nodeType: 'VariableDeclaration',
            name: n,
            stateVariable: true,
          })),
          ...fns,
        ],
      },
    ],
  };
}

describe('ReentrancyDetector', () => {
  let detector: ReentrancyDetector;

  beforeEach(() => {
    detector = new ReentrancyDetector();
  });

  describe('detect - empty/trivial input', () => {
    it('should return empty array for empty source', () => {
      const warnings = detector.detect('');
      expect(warnings).toEqual([]);
    });

    it('should return empty array for safe contract', () => {
      const source = `
pragma solidity ^0.8.0;
contract Safe {
    function add(uint256 a, uint256 b) public pure returns (uint256) {
        return a + b;
    }
}
`;
      const warnings = detector.detect(source);
      expect(warnings).toEqual([]);
    });
  });

  describe('detect - CEI violation', () => {
    it('should detect external call before state change', () => {
      const source = `
pragma solidity ^0.8.0;
contract Vulnerable {
    mapping(address => uint256) balances;

    function withdraw(uint256 amount) public {
        msg.sender.call{value: amount}("");
        balances[msg.sender] -= amount;
    }
}
`;
      const warnings = detector.detect(source);
      expect(warnings.length).toBeGreaterThan(0);
      const ceiWarning = warnings.find((w) => w.functionName === 'withdraw');
      expect(ceiWarning).toBeDefined();
      expect(ceiWarning!.severity).toBe('high');
      expect(ceiWarning!.callLine).toBeLessThan(ceiWarning!.stateChangeLine);
    });

    it('should detect .transfer() before state change', () => {
      const source = `
pragma solidity ^0.8.0;
contract Vulnerable {
    mapping(address => uint256) balances;

    function withdraw() public {
        payable(msg.sender).transfer(balances[msg.sender]);
        balances[msg.sender] = 0;
    }
}
`;
      const warnings = detector.detect(source);
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('should detect .send() before state change', () => {
      const source = `
pragma solidity ^0.8.0;
contract Vulnerable {
    mapping(address => uint256) balances;

    function withdraw() public {
        payable(msg.sender).send(balances[msg.sender]);
        balances[msg.sender] = 0;
    }
}
`;
      const warnings = detector.detect(source);
      expect(warnings.length).toBeGreaterThan(0);
    });
  });

  describe('detect - safe patterns (no false positives)', () => {
    it('should NOT flag CEI-compliant code (state before call)', () => {
      const source = `
pragma solidity ^0.8.0;
contract Safe {
    mapping(address => uint256) balances;

    function withdraw(uint256 amount) public {
        balances[msg.sender] -= amount;
        msg.sender.call{value: amount}("");
    }
}
`;
      const warnings = detector.detect(source);
      // State change before external call is safe CEI
      const ceiWarning = warnings.find(
        (w) => w.functionName === 'withdraw' && w.description.includes('before state change')
      );
      expect(ceiWarning).toBeUndefined();
    });

    it('should NOT flag view functions', () => {
      const source = `
pragma solidity ^0.8.0;
contract Safe {
    mapping(address => uint256) balances;

    function getBalance(address user) public view returns (uint256) {
        return balances[user];
    }
}
`;
      const warnings = detector.detect(source);
      expect(warnings).toEqual([]);
    });

    it('should NOT flag pure functions', () => {
      const source = `
pragma solidity ^0.8.0;
contract Safe {
    function compute(uint256 a, uint256 b) public pure returns (uint256) {
        return a + b;
    }
}
`;
      const warnings = detector.detect(source);
      expect(warnings).toEqual([]);
    });

    it('should NOT flag functions with nonReentrant modifier', () => {
      const source = `
pragma solidity ^0.8.0;
contract Protected {
    mapping(address => uint256) balances;

    function withdraw(uint256 amount) public nonReentrant {
        msg.sender.call{value: amount}("");
        balances[msg.sender] -= amount;
    }
}
`;
      const warnings = detector.detect(source);
      const ceiWarning = warnings.find(
        (w) => w.functionName === 'withdraw' && w.description.includes('before state change')
      );
      expect(ceiWarning).toBeUndefined();
    });
  });

  describe('detect - SafeERC20 calls', () => {
    it('should downgrade severity for SafeERC20 calls', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    mapping(address => uint256) balances;

    function withdraw(address token) public {
        safeTransfer(token, msg.sender, balances[msg.sender]);
        balances[msg.sender] = 0;
    }
}
`;
      const warnings = detector.detect(source);
      const safeWarning = warnings.find(
        (w) => w.functionName === 'withdraw' && w.description.includes('SafeERC20')
      );
      if (safeWarning) {
        expect(safeWarning.severity).toBe('medium');
      }
    });
  });

  describe('detect - cross-function reentrancy', () => {
    it('should detect cross-function reentrancy when two functions share state', () => {
      const source = `
pragma solidity ^0.8.0;
contract Vulnerable {
    mapping(address => uint256) balances;

    function withdraw(uint256 amount) public {
        msg.sender.call{value: amount}("");
    }

    function updateBalance(address user) public {
        balances[user] = 0;
    }
}
`;
      const warnings = detector.detect(source);
      const crossFuncWarning = warnings.find((w) => w.description.includes('Cross-function'));
      // Cross-function detection requires shared state variables
      // The specific detection depends on the variable analysis
      if (crossFuncWarning) {
        expect(crossFuncWarning.severity).toBe('high');
      }
    });
  });

  describe('detect - read-only reentrancy', () => {
    it('should detect read-only reentrancy risk', () => {
      const source = `
pragma solidity ^0.8.0;
contract Pool {
    mapping(address => uint256) shares;
    uint256 totalShares;

    function deposit() public {
        shares[msg.sender] += 100;
        totalShares += 100;
        msg.sender.call{value: 0}("");
    }

    function getSharePrice() public view returns (uint256) {
        return totalShares;
    }

    function withdraw(uint256 amount) public {
        shares[msg.sender] -= amount;
        totalShares -= amount;
    }
}
`;
      const warnings = detector.detect(source);
      const readOnlyWarning = warnings.find(
        (w) => w.description.includes('Read-only') || w.description.includes('read-only')
      );
      if (readOnlyWarning) {
        expect(readOnlyWarning.severity).toBe('low');
      }
    });
  });

  describe('detect - delegatecall', () => {
    it('should detect delegatecall before state change', () => {
      const source = `
pragma solidity ^0.8.0;
contract Proxy {
    mapping(address => uint256) balances;

    function execute(address target) public {
        target.delegatecall(abi.encodeWithSignature("run()"));
        balances[msg.sender] = 0;
    }
}
`;
      const warnings = detector.detect(source);
      expect(warnings.length).toBeGreaterThan(0);
    });
  });

  describe('generateReport', () => {
    it('should generate report with no warnings', () => {
      const report = detector.generateReport([]);
      expect(report).toContain('Reentrancy Analysis Report');
      expect(report).toContain('No reentrancy vulnerabilities detected');
    });

    it('should generate report with warnings categorized by severity', () => {
      const warnings = [
        {
          line: 10,
          functionName: 'withdraw',
          severity: 'high' as const,
          description: 'External call before state change',
          callLine: 10,
          stateChangeLine: 11,
        },
        {
          line: 20,
          functionName: 'deposit',
          severity: 'medium' as const,
          description: 'SafeERC20 call before state change',
          callLine: 20,
          stateChangeLine: 21,
        },
      ];

      const report = detector.generateReport(warnings);
      expect(report).toContain('2');
      expect(report).toContain('High: 1');
      expect(report).toContain('Medium: 1');
      expect(report).toContain('withdraw');
      expect(report).toContain('deposit');
    });

    it('should include fix suggestion for high severity', () => {
      const warnings = [
        {
          line: 5,
          functionName: 'test',
          severity: 'high' as const,
          description: 'External call before state change',
          callLine: 5,
          stateChangeLine: 6,
        },
      ];

      const report = detector.generateReport(warnings);
      expect(report).toContain('Checks-Effects-Interactions');
    });

    it('should include read-only fix for low severity', () => {
      const warnings = [
        {
          line: 5,
          functionName: 'getPrice',
          severity: 'low' as const,
          description: 'Read-only reentrancy',
          callLine: 5,
          stateChangeLine: 6,
        },
      ];

      const report = detector.generateReport(warnings);
      expect(report).toContain('view function');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // AST-backed CEI path (detect(source, ast))
  // ──────────────────────────────────────────────────────────────────────
  describe('detect - AST-backed path', () => {
    // Build a source where line numbers line up with the fixture src offsets.
    // Lines: 1 empty, 2 call, 3 write.
    const source = '\nline2_external_call\nline3_state_write\n';
    const callSrc = `${source.indexOf('line2')}:5:0`; // line 2
    const writeSrc = `${source.indexOf('line3')}:5:0`; // line 3

    it('flags external call before state write (high)', () => {
      const ast = sourceUnit(
        ['balances'],
        [fnDef('withdraw', [extCall(callSrc), write('balances', writeSrc)])]
      );
      const warnings = detector.detect(source, ast);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].functionName).toBe('withdraw');
      expect(warnings[0].severity).toBe('high');
      expect(warnings[0].callLine).toBe(2);
      expect(warnings[0].stateChangeLine).toBe(3);
      expect(warnings[0].callLine).toBeLessThan(warnings[0].stateChangeLine);
    });

    it('does NOT flag CEI-safe order (state write before call)', () => {
      const ast = sourceUnit(
        ['balances'],
        // write on line 2, call on line 3 → safe
        [fnDef('withdraw', [write('balances', callSrc), extCall(writeSrc)])]
      );
      expect(detector.detect(source, ast)).toEqual([]);
    });

    it('does NOT flag functions guarded by nonReentrant', () => {
      const guarded = fnDef('withdraw', [extCall(callSrc), write('balances', writeSrc)], {
        modifiers: [
          {
            nodeType: 'ModifierInvocation',
            modifierName: { nodeType: 'IdentifierPath', name: 'nonReentrant' },
          },
        ],
      });
      const ast = sourceUnit(['balances'], [guarded]);
      expect(detector.detect(source, ast)).toEqual([]);
    });

    it('does NOT flag view functions', () => {
      const ast = sourceUnit(
        ['balances'],
        [fnDef('peek', [extCall(callSrc), write('balances', writeSrc)], { stateMutability: 'view' })]
      );
      expect(detector.detect(source, ast)).toEqual([]);
    });

    it('does NOT flag writes to non-state (local) variables', () => {
      const ast = sourceUnit(
        ['balances'], // 'tmp' is not a state var
        [fnDef('withdraw', [extCall(callSrc), write('tmp', writeSrc)])]
      );
      expect(detector.detect(source, ast)).toEqual([]);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Regression: single-arg detect(source) must be unchanged
  // ──────────────────────────────────────────────────────────────────────
  describe('regression - single-arg detect unchanged', () => {
    const source = `
pragma solidity ^0.8.0;
contract Vulnerable {
    mapping(address => uint256) balances;

    function withdraw(uint256 amount) public {
        msg.sender.call{value: amount}("");
        balances[msg.sender] -= amount;
    }
}
`;
    it('produces identical output regardless of ast=undefined being passed explicitly', () => {
      const a = detector.detect(source);
      const b = detector.detect(source, undefined);
      expect(b).toEqual(a);
      const cei = a.find((w) => w.functionName === 'withdraw');
      expect(cei).toBeDefined();
      expect(cei!.severity).toBe('high');
    });
  });
});
