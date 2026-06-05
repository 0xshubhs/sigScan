/**
 * Tests for Access Control Analyzer
 */

import { AccessControlAnalyzer } from '../access-control';
import { SolidityAstNode } from '../ast/solidity-ast';

// ── Hand-written AST fixtures for the AST-backed path ────────────────────────

function ident(name: string, typeString = ''): SolidityAstNode {
  return { nodeType: 'Identifier', name, src: '0:0:0', typeDescriptions: { typeString } };
}
function member(base: SolidityAstNode, memberName: string): SolidityAstNode {
  return { nodeType: 'MemberAccess', memberName, expression: base, src: '0:0:0' };
}
function write(varName: string, src = '0:0:0'): SolidityAstNode {
  return {
    nodeType: 'Assignment',
    operator: '=',
    leftHandSide: ident(varName),
    rightHandSide: { nodeType: 'Literal', src: '0:0:0' },
    src,
  };
}
function requireSenderCheck(): SolidityAstNode {
  return {
    nodeType: 'ExpressionStatement',
    src: '0:0:0',
    expression: {
      nodeType: 'FunctionCall',
      kind: 'functionCall',
      expression: ident('require'),
      arguments: [
        {
          nodeType: 'BinaryOperation',
          operator: '==',
          leftExpression: member(ident('msg'), 'sender'),
          rightExpression: ident('owner'),
          src: '0:0:0',
        },
      ],
      src: '0:0:0',
    },
  };
}
function modifier(name: string): SolidityAstNode {
  return {
    nodeType: 'ModifierInvocation',
    modifierName: { nodeType: 'IdentifierPath', name },
  };
}
function fnDef(
  name: string,
  statements: SolidityAstNode[],
  opts: {
    visibility?: string;
    stateMutability?: string;
    modifiers?: SolidityAstNode[];
    kind?: string;
    src?: string;
  } = {}
): SolidityAstNode {
  return {
    nodeType: 'FunctionDefinition',
    name,
    kind: opts.kind ?? 'function',
    visibility: opts.visibility ?? 'public',
    stateMutability: opts.stateMutability ?? 'nonpayable',
    modifiers: opts.modifiers ?? [],
    src: opts.src ?? '0:0:0',
    body: { nodeType: 'Block', statements },
  };
}
function sourceUnit(stateVarNames: string[], fns: SolidityAstNode[]): SolidityAstNode {
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

describe('AccessControlAnalyzer', () => {
  let analyzer: AccessControlAnalyzer;

  beforeEach(() => {
    analyzer = new AccessControlAnalyzer();
  });

  describe('detect - empty/trivial input', () => {
    it('should return empty array for empty source', () => {
      const warnings = analyzer.detect('');
      expect(warnings).toEqual([]);
    });

    it('should return empty array for safe contract with access control', () => {
      const source = `
pragma solidity ^0.8.0;
contract Safe {
    address public owner;
    modifier onlyOwner() { require(msg.sender == owner); _; }

    function mint(address to, uint256 amount) public onlyOwner {
        // mint logic
    }
}
`;
      const warnings = analyzer.detect(source);
      // mint has onlyOwner modifier, so no warning
      const mintWarning = warnings.find((w) => w.functionName === 'mint');
      expect(mintWarning).toBeUndefined();
    });
  });

  describe('detect - missing access control on sensitive functions', () => {
    it('should detect unprotected mint function', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    function mint(address to, uint256 amount) public {
        // anyone can mint
    }
}
`;
      const warnings = analyzer.detect(source);
      const mintWarning = warnings.find((w) => w.functionName === 'mint');
      expect(mintWarning).toBeDefined();
      expect(mintWarning!.severity).toBe('high');
      expect(mintWarning!.description).toContain('minting');
    });

    it('should detect unprotected burn function', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    function burn(uint256 amount) public {
        // anyone can burn
    }
}
`;
      const warnings = analyzer.detect(source);
      const burnWarning = warnings.find((w) => w.functionName === 'burn');
      expect(burnWarning).toBeDefined();
      expect(burnWarning!.severity).toBe('high');
    });

    it('should detect unprotected pause function', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    function pause() public {
        // anyone can pause
    }
}
`;
      const warnings = analyzer.detect(source);
      const pauseWarning = warnings.find((w) => w.functionName === 'pause');
      expect(pauseWarning).toBeDefined();
    });

    it('should detect unprotected withdraw function', () => {
      const source = `
pragma solidity ^0.8.0;
contract Vault {
    function withdraw(uint256 amount) public {
        // anyone can withdraw
    }
}
`;
      const warnings = analyzer.detect(source);
      const withdrawWarning = warnings.find((w) => w.functionName === 'withdraw');
      expect(withdrawWarning).toBeDefined();
      expect(withdrawWarning!.severity).toBe('high');
    });

    it('should detect unprotected setFee function', () => {
      const source = `
pragma solidity ^0.8.0;
contract Protocol {
    function setFee(uint256 newFee) public {
        // anyone can set fee
    }
}
`;
      const warnings = analyzer.detect(source);
      const feeWarning = warnings.find((w) => w.functionName === 'setFee');
      expect(feeWarning).toBeDefined();
      expect(feeWarning!.description).toContain('admin setter');
    });
  });

  describe('detect - protected functions (no false positives)', () => {
    it('should NOT flag function with onlyOwner modifier', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    function mint(address to, uint256 amount) public onlyOwner {
        // protected
    }
}
`;
      const warnings = analyzer.detect(source);
      const mintWarning = warnings.find((w) => w.functionName === 'mint');
      expect(mintWarning).toBeUndefined();
    });

    it('should NOT flag function with msg.sender check', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    address admin;
    function mint(address to, uint256 amount) public {
        require(msg.sender == admin, "not admin");
        // protected
    }
}
`;
      const warnings = analyzer.detect(source);
      const mintWarning = warnings.find((w) => w.functionName === 'mint');
      expect(mintWarning).toBeUndefined();
    });

    it('should NOT flag view functions', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    function getBalance() public view returns (uint256) {
        return address(this).balance;
    }
}
`;
      const warnings = analyzer.detect(source);
      expect(warnings).toEqual([]);
    });

    it('should NOT flag pure functions', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    function add(uint256 a, uint256 b) public pure returns (uint256) {
        return a + b;
    }
}
`;
      const warnings = analyzer.detect(source);
      expect(warnings).toEqual([]);
    });

    it('should NOT flag internal/private functions', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    function _mint(address to, uint256 amount) internal {
        // internal minting
    }
}
`;
      const warnings = analyzer.detect(source);
      expect(warnings).toEqual([]);
    });
  });

  describe('detect - centralization risks', () => {
    it('should detect single-owner pause centralization risk', () => {
      const source = `
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/security/Pausable.sol";
contract Token is Pausable {
    function pause() public onlyOwner {
        _pause();
    }
}
`;
      const warnings = analyzer.detect(source);
      const centralWarning = warnings.find((w) => w.description.includes('Centralization'));
      expect(centralWarning).toBeDefined();
      expect(centralWarning!.severity).toBe('medium');
    });

    it('should NOT flag pause with timelock/governance', () => {
      const source = `
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/security/Pausable.sol";
import "./Governance.sol";
contract Token is Pausable, Governance {
    function pause() public onlyOwner {
        _pause();
    }
}
`;
      const warnings = analyzer.detect(source);
      const centralWarning = warnings.find((w) => w.description.includes('Centralization'));
      expect(centralWarning).toBeUndefined();
    });
  });

  describe('detect - Ownable without Ownable2Step', () => {
    it('should warn about Ownable without Ownable2Step', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token is Ownable {
    function mint() public onlyOwner {}
}
`;
      const warnings = analyzer.detect(source);
      const ownable2StepWarning = warnings.find((w) => w.description.includes('Ownable2Step'));
      expect(ownable2StepWarning).toBeDefined();
      expect(ownable2StepWarning!.severity).toBe('medium');
    });

    it('should NOT warn when using Ownable2Step', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token is Ownable2Step {
    function mint() public onlyOwner {}
}
`;
      const warnings = analyzer.detect(source);
      const ownable2StepWarning = warnings.find(
        (w) => w.description.includes('Ownable2Step') && w.description.includes('without')
      );
      expect(ownable2StepWarning).toBeUndefined();
    });
  });

  describe('detect - unprotected initialize()', () => {
    it('should detect unprotected initialize function', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    function initialize(address admin) public {
        // anyone can initialize
    }
}
`;
      const warnings = analyzer.detect(source);
      const initWarning = warnings.find((w) => w.functionName === 'initialize');
      expect(initWarning).toBeDefined();
      expect(initWarning!.severity).toBe('critical');
    });

    it('should NOT flag initialize with initializer modifier', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    function initialize(address admin) public initializer {
        // protected by initializer
    }
}
`;
      const warnings = analyzer.detect(source);
      const initWarning = warnings.find(
        (w) => w.functionName === 'initialize' && w.severity === 'critical'
      );
      expect(initWarning).toBeUndefined();
    });
  });

  describe('generateReport', () => {
    it('should generate report with no issues', () => {
      const report = analyzer.generateReport([]);
      expect(report).toContain('Access Control Analysis');
      expect(report).toContain('No access control issues detected');
    });

    it('should generate report with categorized issues', () => {
      const warnings = [
        {
          line: 5,
          functionName: 'initialize',
          severity: 'critical' as const,
          description: 'Unprotected initialize()',
        },
        {
          line: 10,
          functionName: 'mint',
          severity: 'high' as const,
          description: 'No access control on mint',
        },
        {
          line: 15,
          functionName: 'setConfig',
          severity: 'medium' as const,
          description: 'Missing modifier',
        },
      ];

      const report = analyzer.generateReport(warnings);
      expect(report).toContain('**3** issue(s)');
      expect(report).toContain('Critical: 1');
      expect(report).toContain('High: 1');
      expect(report).toContain('Medium: 1');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // AST-backed path (detect(source, ast))
  // ──────────────────────────────────────────────────────────────────────
  describe('detect - AST-backed path', () => {
    const source = 'pragma solidity ^0.8.0;\ncontract C {}\n';

    it('flags a public state-changing function with no access guard', () => {
      const ast = sourceUnit(['totalSupply'], [fnDef('mint', [write('totalSupply')])]);
      const warnings = analyzer.detect(source, ast);
      const w = warnings.find((x) => x.functionName === 'mint');
      expect(w).toBeDefined();
      expect(w!.severity).toBe('high'); // 'mint' matches sensitive pattern
      expect(w!.description).toContain('no access control');
    });

    it('does NOT flag a function guarded by an onlyOwner modifier', () => {
      const ast = sourceUnit(
        ['totalSupply'],
        [fnDef('mint', [write('totalSupply')], { modifiers: [modifier('onlyOwner')] })]
      );
      expect(analyzer.detect(source, ast)).toEqual([]);
    });

    it('does NOT flag a function with an inline require(msg.sender == ...) check', () => {
      const ast = sourceUnit(
        ['totalSupply'],
        [fnDef('mint', [requireSenderCheck(), write('totalSupply')])]
      );
      expect(analyzer.detect(source, ast)).toEqual([]);
    });

    it('does NOT flag view/pure functions', () => {
      const ast = sourceUnit(
        ['totalSupply'],
        [fnDef('peek', [write('totalSupply')], { stateMutability: 'view' })]
      );
      expect(analyzer.detect(source, ast)).toEqual([]);
    });

    it('does NOT flag internal/private functions', () => {
      const ast = sourceUnit(
        ['totalSupply'],
        [fnDef('_mint', [write('totalSupply')], { visibility: 'internal' })]
      );
      expect(analyzer.detect(source, ast)).toEqual([]);
    });

    it('does NOT flag constructors', () => {
      const ast = sourceUnit(
        ['owner'],
        [fnDef('', [write('owner')], { kind: 'constructor' })]
      );
      expect(analyzer.detect(source, ast)).toEqual([]);
    });

    it('does NOT flag public functions that do not change state', () => {
      const ast = sourceUnit(['owner'], [fnDef('noop', [])]);
      expect(analyzer.detect(source, ast)).toEqual([]);
    });

    it('flags a public function moving value via .transfer with no guard', () => {
      const transferCall: SolidityAstNode = {
        nodeType: 'ExpressionStatement',
        src: '0:0:0',
        expression: {
          nodeType: 'FunctionCall',
          kind: 'functionCall',
          expression: member(ident('recipient', 'address'), 'transfer'),
          arguments: [],
          src: '0:0:0',
        },
      };
      const ast = sourceUnit([], [fnDef('payout', [transferCall])]);
      const warnings = analyzer.detect(source, ast);
      expect(warnings.find((x) => x.functionName === 'payout')).toBeDefined();
    });

    it('marks initialize() as critical when unguarded', () => {
      const ast = sourceUnit(['owner'], [fnDef('initialize', [write('owner')])]);
      const w = analyzer.detect(source, ast).find((x) => x.functionName === 'initialize');
      expect(w).toBeDefined();
      expect(w!.severity).toBe('critical');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Regression: single-arg detect(source) must be unchanged
  // ──────────────────────────────────────────────────────────────────────
  describe('regression - single-arg detect unchanged', () => {
    const source = `
pragma solidity ^0.8.0;
contract Token {
    function mint(address to, uint256 amount) public {
        // anyone can mint
    }
}
`;
    it('produces identical output regardless of ast=undefined being passed explicitly', () => {
      const a = analyzer.detect(source);
      const b = analyzer.detect(source, undefined);
      expect(b).toEqual(a);
      const mint = a.find((w) => w.functionName === 'mint');
      expect(mint).toBeDefined();
      expect(mint!.severity).toBe('high');
    });
  });
});
