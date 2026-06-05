/**
 * Tests for the pure Solidity-AST helpers.
 *
 * These use hand-written compact-AST fixtures so they are fast and fully
 * deterministic (no solc compile). The compile-backed `getAst` is exercised
 * lightly for its no-throw / fallback contract.
 */

import {
  SolidityAstNode,
  getAst,
  srcToLine,
  getContracts,
  getFunctions,
  getStateVariableNames,
  getExternalCalls,
  getStateWrites,
  getModifierNames,
  walkAst,
} from '../solidity-ast';

// ── Fixture builders ───────────────────────────────────────────────────────

function identifier(name: string, typeString = ''): SolidityAstNode {
  return {
    nodeType: 'Identifier',
    name,
    src: '0:0:0',
    typeDescriptions: { typeString },
  };
}

function memberAccess(
  base: SolidityAstNode,
  memberName: string,
  typeString = ''
): SolidityAstNode {
  return {
    nodeType: 'MemberAccess',
    memberName,
    expression: base,
    src: '0:0:0',
    typeDescriptions: { typeString },
  };
}

function functionCall(
  callee: SolidityAstNode,
  src = '0:0:0',
  extra: Record<string, unknown> = {}
): SolidityAstNode {
  return {
    nodeType: 'FunctionCall',
    kind: 'functionCall',
    expression: callee,
    arguments: [],
    src,
    ...extra,
  };
}

function assignment(lhsName: string, src: string): SolidityAstNode {
  return {
    nodeType: 'Assignment',
    operator: '=',
    leftHandSide: identifier(lhsName),
    rightHandSide: { nodeType: 'Literal', src: '0:0:0' },
    src,
  };
}

describe('srcToLine', () => {
  const source = 'line1\nline2\nline3\nline4';

  it('returns 1 for offset 0', () => {
    expect(srcToLine('0:5:0', source)).toBe(1);
  });

  it('maps an offset on the third line correctly', () => {
    const offset = source.indexOf('line3');
    expect(srcToLine(`${offset}:5:0`, source)).toBe(3);
  });

  it('returns 1 for undefined/malformed src', () => {
    expect(srcToLine(undefined, source)).toBe(1);
    expect(srcToLine('abc', source)).toBe(1);
    expect(srcToLine('-5:1:0', source)).toBe(1);
  });
});

describe('walkAst', () => {
  it('visits nested nodes through nodes/body/arrays', () => {
    const ast: SolidityAstNode = {
      nodeType: 'SourceUnit',
      nodes: [
        {
          nodeType: 'ContractDefinition',
          nodes: [
            { nodeType: 'FunctionDefinition', body: { nodeType: 'Block' } },
          ],
        },
      ],
    };
    const seen: string[] = [];
    walkAst(ast, (n) => seen.push(n.nodeType));
    expect(seen).toEqual([
      'SourceUnit',
      'ContractDefinition',
      'FunctionDefinition',
      'Block',
    ]);
  });

  it('handles null/non-object gracefully', () => {
    expect(() => walkAst(null, () => undefined)).not.toThrow();
    expect(() => walkAst(undefined, () => undefined)).not.toThrow();
  });
});

describe('getContracts / getFunctions / getStateVariableNames', () => {
  const ast: SolidityAstNode = {
    nodeType: 'SourceUnit',
    nodes: [
      {
        nodeType: 'ContractDefinition',
        name: 'Token',
        nodes: [
          { nodeType: 'VariableDeclaration', name: 'owner', stateVariable: true },
          { nodeType: 'VariableDeclaration', name: 'localish', stateVariable: false },
          { nodeType: 'VariableDeclaration', name: 'balances', stateVariable: true },
          { nodeType: 'FunctionDefinition', name: 'mint' },
          { nodeType: 'FunctionDefinition', name: 'burn' },
          { nodeType: 'EventDefinition', name: 'Transfer' },
        ],
      },
    ],
  };

  it('finds all contract definitions', () => {
    const contracts = getContracts(ast);
    expect(contracts).toHaveLength(1);
    expect(contracts[0].name).toBe('Token');
  });

  it('finds direct function definitions only', () => {
    const fns = getFunctions(getContracts(ast)[0]);
    expect(fns.map((f) => f.name)).toEqual(['mint', 'burn']);
  });

  it('collects only stateVariable names', () => {
    const names = getStateVariableNames(getContracts(ast)[0]);
    expect(names.has('owner')).toBe(true);
    expect(names.has('balances')).toBe(true);
    expect(names.has('localish')).toBe(false);
    expect(names.size).toBe(2);
  });
});

describe('getExternalCalls', () => {
  it('detects low-level .call on a non-this address', () => {
    const fn: SolidityAstNode = {
      nodeType: 'FunctionDefinition',
      name: 'withdraw',
      body: {
        nodeType: 'Block',
        statements: [
          functionCall(
            memberAccess(identifier('target', 'address'), 'call'),
            '10:8:0'
          ),
        ],
      },
    };
    const calls = getExternalCalls(fn);
    expect(calls).toHaveLength(1);
    expect(calls[0].src).toBe('10:8:0');
  });

  it('detects addr.call{value: x}(...) wrapped in FunctionCallOptions', () => {
    const fn: SolidityAstNode = {
      nodeType: 'FunctionDefinition',
      body: {
        nodeType: 'Block',
        statements: [
          functionCall(
            {
              nodeType: 'FunctionCallOptions',
              names: ['value'],
              expression: memberAccess(identifier('to', 'address'), 'call'),
              src: '0:0:0',
            },
            '42:9:0'
          ),
        ],
      },
    };
    const calls = getExternalCalls(fn);
    expect(calls).toHaveLength(1);
    expect(calls[0].src).toBe('42:9:0');
  });

  it('detects .transfer on an address base', () => {
    const fn: SolidityAstNode = {
      nodeType: 'FunctionDefinition',
      body: {
        nodeType: 'Block',
        statements: [
          functionCall(memberAccess(identifier('recipient', 'address'), 'transfer')),
        ],
      },
    };
    expect(getExternalCalls(fn)).toHaveLength(1);
  });

  it('detects external member call on a contract-typed base', () => {
    const fn: SolidityAstNode = {
      nodeType: 'FunctionDefinition',
      body: {
        nodeType: 'Block',
        statements: [
          functionCall(
            memberAccess(
              identifier('token', 'contract IERC20'),
              'transferFrom',
              'function (address,address,uint256) external returns (bool)'
            )
          ),
        ],
      },
    };
    expect(getExternalCalls(fn)).toHaveLength(1);
  });

  it('does NOT flag this.foo() self calls', () => {
    const fn: SolidityAstNode = {
      nodeType: 'FunctionDefinition',
      body: {
        nodeType: 'Block',
        statements: [
          functionCall(memberAccess(identifier('this'), 'send')),
        ],
      },
    };
    expect(getExternalCalls(fn)).toHaveLength(0);
  });

  it('does NOT flag array.push() (internal member, non-address, non-external)', () => {
    const fn: SolidityAstNode = {
      nodeType: 'FunctionDefinition',
      body: {
        nodeType: 'Block',
        statements: [
          functionCall(
            memberAccess(identifier('items', 'uint256[] storage ref'), 'push', '')
          ),
        ],
      },
    };
    expect(getExternalCalls(fn)).toHaveLength(0);
  });
});

describe('getStateWrites', () => {
  const stateVars = new Set(['balances', 'totalSupply', 'owner']);

  it('flags assignment to a state variable', () => {
    const fn: SolidityAstNode = {
      nodeType: 'FunctionDefinition',
      body: {
        nodeType: 'Block',
        statements: [assignment('balances', '50:10:0')],
      },
    };
    const writes = getStateWrites(fn, stateVars);
    expect(writes).toHaveLength(1);
    expect(writes[0].src).toBe('50:10:0');
  });

  it('flags indexed assignment balances[x] = ...', () => {
    const fn: SolidityAstNode = {
      nodeType: 'FunctionDefinition',
      body: {
        nodeType: 'Block',
        statements: [
          {
            nodeType: 'Assignment',
            operator: '=',
            leftHandSide: {
              nodeType: 'IndexAccess',
              baseExpression: identifier('balances'),
              indexExpression: identifier('user'),
            },
            src: '60:12:0',
          },
        ],
      },
    };
    expect(getStateWrites(fn, stateVars)).toHaveLength(1);
  });

  it('flags ++ / -- / delete unary ops on state vars', () => {
    const fn: SolidityAstNode = {
      nodeType: 'FunctionDefinition',
      body: {
        nodeType: 'Block',
        statements: [
          { nodeType: 'UnaryOperation', operator: '++', subExpression: identifier('totalSupply'), src: '1:1:0' },
          { nodeType: 'UnaryOperation', operator: 'delete', subExpression: identifier('owner'), src: '2:1:0' },
        ],
      },
    };
    expect(getStateWrites(fn, stateVars)).toHaveLength(2);
  });

  it('does NOT flag writes to non-state (local) variables', () => {
    const fn: SolidityAstNode = {
      nodeType: 'FunctionDefinition',
      body: {
        nodeType: 'Block',
        statements: [assignment('tmp', '5:5:0')],
      },
    };
    expect(getStateWrites(fn, stateVars)).toHaveLength(0);
  });
});

describe('getModifierNames', () => {
  it('extracts modifier invocation names', () => {
    const fn: SolidityAstNode = {
      nodeType: 'FunctionDefinition',
      name: 'withdraw',
      modifiers: [
        { nodeType: 'ModifierInvocation', modifierName: { nodeType: 'IdentifierPath', name: 'nonReentrant' } },
        { nodeType: 'ModifierInvocation', modifierName: { nodeType: 'IdentifierPath', name: 'onlyOwner' } },
      ],
    };
    expect(getModifierNames(fn)).toEqual(['nonReentrant', 'onlyOwner']);
  });

  it('returns [] when no modifiers', () => {
    expect(getModifierNames({ nodeType: 'FunctionDefinition' })).toEqual([]);
  });
});

describe('getAst (compile-backed contract)', () => {
  it('never throws and returns undefined for files with unresolved imports', async () => {
    const src = `
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
contract Foo is ERC20 {}
`;
    const ast = await getAst(src);
    // Imports cannot be resolved → undefined → caller falls back to regex.
    expect(ast).toBeUndefined();
  });

  it('returns undefined for empty/invalid input without throwing', async () => {
    await expect(getAst('')).resolves.toBeUndefined();
    // @ts-expect-error intentional bad input
    await expect(getAst(undefined)).resolves.toBeUndefined();
  });
});
