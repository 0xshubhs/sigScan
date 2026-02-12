/**
 * Test Generator - Generate Foundry test file templates from contract info
 *
 * Creates complete Foundry test stubs (.t.sol) for Solidity contracts,
 * generating a test function for each public/external function with
 * appropriate zero-value arguments based on parameter types.
 *
 * Designed to accelerate test development by providing a starting scaffold
 * that compiles out of the box with `forge test`.
 */

import { ContractInfo, FunctionSignature, Parameter } from '../types';

export class TestGenerator {
  /**
   * Generate a complete Foundry test file for a contract.
   *
   * Creates a test contract that:
   * - Uses the specified pragma version (defaults to ^0.8.20)
   * - Imports forge-std/Test.sol and the target contract
   * - Deploys the contract in setUp()
   * - Generates one test function per public/external function
   * - Uses type-appropriate zero/default values for all arguments
   *
   * @param contractInfo - The parsed contract information
   * @param pragmaVersion - Solidity pragma version (default: "^0.8.20")
   * @returns The complete .t.sol file content as a string
   */
  public generateTestFile(contractInfo: ContractInfo, pragmaVersion?: string): string {
    const version = pragmaVersion || '^0.8.20';
    const contractName = contractInfo.name;
    const importPath = this.inferImportPath(contractInfo);

    // Filter to only public/external non-modifier functions
    const testableFunctions = contractInfo.functions.filter(
      (func) =>
        (func.visibility === 'public' || func.visibility === 'external') &&
        !func.name.startsWith('modifier:') &&
        func.name !== 'constructor'
    );

    const lines: string[] = [];

    // SPDX and pragma
    lines.push('// SPDX-License-Identifier: MIT');
    lines.push(`pragma solidity ${version};`);
    lines.push('');

    // Imports
    lines.push('import "forge-std/Test.sol";');
    lines.push(`import "${importPath}";`);
    lines.push('');

    // Test contract declaration
    lines.push(`contract ${contractName}Test is Test {`);
    lines.push(`    ${contractName} public target;`);
    lines.push('');

    // setUp function
    lines.push('    function setUp() public {');
    const constructorFunc = contractInfo.functions.find((f) => f.name === 'constructor');
    if (constructorFunc && constructorFunc.inputs.length > 0) {
      const ctorArgs = this.generateArgList(constructorFunc.inputs);
      lines.push(`        target = new ${contractName}(${ctorArgs});`);
    } else {
      lines.push(`        target = new ${contractName}();`);
    }
    lines.push('    }');

    // Generate test function for each testable function
    for (const func of testableFunctions) {
      lines.push('');
      lines.push(...this.generateTestFunction(func, contractName));
    }

    // Close contract
    lines.push('}');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Generate a single test function for a contract function.
   *
   * @param func - The function signature to generate a test for
   * @param contractName - The name of the contract under test
   * @returns Array of indented source lines for the test function
   */
  private generateTestFunction(func: FunctionSignature, _contractName: string): string[] {
    const lines: string[] = [];
    const testName = this.generateTestName(func.name);

    // Add a brief doc comment
    lines.push(`    /// @notice Test ${func.name}(${func.inputs.map((p) => p.type).join(', ')})`);
    lines.push(`    function ${testName}() public {`);

    // Declare variables for arguments if there are any
    if (func.inputs.length > 0) {
      for (const param of func.inputs) {
        const varName = this.safeVarName(param.name, param.type);
        const defaultValue = this.getDefaultValue(param.type);
        lines.push(
          `        ${this.solidityTypeDeclaration(param.type)} ${varName} = ${defaultValue};`
        );
      }
      lines.push('');
    }

    // Build the function call
    const argNames = func.inputs.map((param) => this.safeVarName(param.name, param.type));
    const argList = argNames.join(', ');

    if (func.stateMutability === 'view' || func.stateMutability === 'pure') {
      // For view/pure functions, capture the return value if there are outputs
      if (func.outputs.length > 0) {
        if (func.outputs.length === 1) {
          const retType = this.solidityTypeDeclaration(func.outputs[0].type);
          lines.push(`        ${retType} result = target.${func.name}(${argList});`);
        } else {
          // Multiple return values
          const retDecls = func.outputs.map((o, i) => {
            const name = o.name || `ret${i}`;
            return `${this.solidityTypeDeclaration(o.type)} ${name}`;
          });
          lines.push(`        (${retDecls.join(', ')}) = target.${func.name}(${argList});`);
        }
      } else {
        lines.push(`        target.${func.name}(${argList});`);
      }
    } else if (func.stateMutability === 'payable') {
      // For payable functions, send 0 ETH by default
      if (func.outputs.length > 0) {
        lines.push(`        target.${func.name}{value: 0}(${argList});`);
      } else {
        lines.push(`        target.${func.name}{value: 0}(${argList});`);
      }
    } else {
      // nonpayable state-changing function
      if (func.outputs.length > 0 && func.outputs.length === 1) {
        const retType = this.solidityTypeDeclaration(func.outputs[0].type);
        lines.push(`        ${retType} result = target.${func.name}(${argList});`);
      } else {
        lines.push(`        target.${func.name}(${argList});`);
      }
    }

    // Add a placeholder assertion
    lines.push('');
    lines.push('        // TODO: Add assertions');
    lines.push('        assertTrue(true);');

    lines.push('    }');

    return lines;
  }

  /**
   * Generate a test function name from the original function name.
   * Follows the Foundry convention: test_FunctionName
   */
  private generateTestName(functionName: string): string {
    // Capitalize first letter
    const capitalized = functionName.charAt(0).toUpperCase() + functionName.slice(1);
    return `test_${capitalized}`;
  }

  /**
   * Get the appropriate default/zero value for a Solidity type.
   *
   * @param type - The Solidity type string
   * @returns A Solidity literal representing the zero/default value
   */
  private getDefaultValue(type: string): string {
    const normalized = type.trim();

    // Address
    if (normalized === 'address') {
      return 'address(0)';
    }

    // Boolean
    if (normalized === 'bool') {
      return 'false';
    }

    // String
    if (normalized === 'string') {
      return '""';
    }

    // Fixed-size bytes (bytes1 through bytes32)
    if (/^bytes\d+$/.test(normalized)) {
      return `${normalized}(0)`;
    }

    // Dynamic bytes
    if (normalized === 'bytes') {
      return 'bytes("")';
    }

    // Unsigned integers (uint, uint8, uint16, ..., uint256)
    if (/^uint\d*$/.test(normalized)) {
      return '0';
    }

    // Signed integers (int, int8, int16, ..., int256)
    if (/^int\d*$/.test(normalized)) {
      return '0';
    }

    // Dynamic arrays (e.g., address[], uint256[], bytes32[])
    if (normalized.endsWith('[]')) {
      const baseType = normalized.slice(0, -2);
      return `new ${baseType}[](0)`;
    }

    // Fixed-size arrays (e.g., uint256[3])
    const fixedArrayMatch = normalized.match(/^(.+)\[(\d+)\]$/);
    if (fixedArrayMatch) {
      const baseType = fixedArrayMatch[1];
      const size = parseInt(fixedArrayMatch[2], 10);
      const defaults = Array(size).fill(this.getDefaultValue(baseType));
      return `[${defaults.join(', ')}]`;
    }

    // Enum types default to 0
    // Struct types and other complex types: use a type cast of 0
    // For unknown types, provide a comment hint
    if (/^[A-Z]/.test(normalized)) {
      // Likely a user-defined type (struct, enum)
      // Cannot easily construct a zero value; leave a placeholder
      return `${normalized}(0) /* TODO: provide valid ${normalized} value */`;
    }

    // Fallback for unrecognized types
    return `0 /* TODO: provide valid ${normalized} value */`;
  }

  /**
   * Get the Solidity type declaration, handling memory/calldata for reference types.
   *
   * @param type - The Solidity type
   * @returns The type with appropriate data location keyword
   */
  private solidityTypeDeclaration(type: string): string {
    const normalized = type.trim();

    // Reference types need memory location in function body
    if (
      normalized === 'string' ||
      normalized === 'bytes' ||
      normalized.endsWith('[]') ||
      normalized.includes('[')
    ) {
      return `${normalized} memory`;
    }

    // Struct types (capitalized identifiers that are not basic types)
    if (/^[A-Z]/.test(normalized) && !this.isBasicType(normalized)) {
      return `${normalized} memory`;
    }

    return normalized;
  }

  /**
   * Check if a type is a basic (value) type that does not need a memory qualifier.
   */
  private isBasicType(type: string): boolean {
    return /^(uint\d*|int\d*|bool|address|bytes\d+)$/.test(type);
  }

  /**
   * Generate a safe variable name from a parameter name and type.
   *
   * If the parameter has no name, generates one from the type.
   * Avoids Solidity reserved words.
   */
  private safeVarName(name: string, type: string): string {
    if (name && name.length > 0 && !this.isReservedWord(name)) {
      // Remove leading underscores for local variable clarity
      return name.startsWith('_') ? name.substring(1) || this.typeToVarName(type) : name;
    }

    return this.typeToVarName(type);
  }

  /**
   * Generate a variable name from a Solidity type.
   */
  private typeToVarName(type: string): string {
    const normalized = type
      .trim()
      .replace('[]', 'Array')
      .replace(/\[.*?\]/, 'Array');

    if (normalized === 'address') {
      return 'addr';
    }
    if (normalized === 'bool') {
      return 'flag';
    }
    if (normalized === 'string') {
      return 'str';
    }
    if (normalized === 'bytes') {
      return 'data';
    }
    if (/^bytes\d+$/.test(normalized)) {
      return 'bval';
    }
    if (/^uint\d*$/.test(normalized)) {
      return 'amount';
    }
    if (/^int\d*$/.test(normalized)) {
      return 'val';
    }

    // For complex types, use a simplified version
    return 'arg';
  }

  /**
   * Check if a name is a Solidity reserved word.
   */
  private isReservedWord(name: string): boolean {
    const reserved = new Set([
      'abstract',
      'after',
      'alias',
      'apply',
      'auto',
      'byte',
      'case',
      'catch',
      'copyof',
      'default',
      'define',
      'final',
      'immutable',
      'implements',
      'in',
      'inline',
      'let',
      'macro',
      'match',
      'mutable',
      'null',
      'of',
      'override',
      'partial',
      'promise',
      'reference',
      'relocatable',
      'sealed',
      'sizeof',
      'static',
      'supports',
      'switch',
      'try',
      'typedef',
      'typeof',
      'unchecked',
      'virtual',
      'address',
      'bool',
      'string',
      'bytes',
      'mapping',
      'type',
    ]);
    return reserved.has(name);
  }

  /**
   * Infer the import path for the contract source file.
   *
   * Attempts to produce a relative import path following Foundry conventions
   * (e.g., "../src/ContractName.sol").
   */
  private inferImportPath(contractInfo: ContractInfo): string {
    const filePath = contractInfo.filePath;

    // Try to extract a relative path from common project structures
    // Foundry: src/ContractName.sol -> "../src/ContractName.sol"
    const srcMatch = filePath.match(/(?:^|[/\\])(src[/\\].+\.sol)$/);
    if (srcMatch) {
      return `../${srcMatch[1].replace(/\\/g, '/')}`;
    }

    // Hardhat: contracts/ContractName.sol -> "../contracts/ContractName.sol"
    const contractsMatch = filePath.match(/(?:^|[/\\])(contracts[/\\].+\.sol)$/);
    if (contractsMatch) {
      return `../${contractsMatch[1].replace(/\\/g, '/')}`;
    }

    // Fallback: use just the filename
    const fileName = filePath.split(/[/\\]/).pop() || `${contractInfo.name}.sol`;
    return `../src/${fileName}`;
  }

  /**
   * Generate a comma-separated argument list for a function call.
   *
   * @param params - Array of function parameters
   * @returns Comma-separated string of default values
   */
  private generateArgList(params: Parameter[]): string {
    return params.map((p) => this.getDefaultValue(p.type)).join(', ');
  }
}
