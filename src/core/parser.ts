import * as fs from 'fs';
import {
  FunctionSignature,
  EventSignature,
  ErrorSignature,
  ContractInfo,
  Parameter,
} from '../types';
import {
  generateFunctionSelector,
  generateEventSignature,
  normalizeFunctionSignature,
  parseParameters,
  getContractNameFromPath,
} from '../utils/helpers';

export class SolidityParser {
  /**
   * Parse a Solidity file and extract all signatures
   */
  public parseFile(filePath: string): ContractInfo | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const contractName = this.extractContractName(content) || getContractNameFromPath(filePath);

      const functions = this.extractFunctions(content, contractName, filePath);
      const events = this.extractEvents(content, contractName, filePath);
      const errors = this.extractErrors(content, contractName, filePath);

      const stats = fs.statSync(filePath);

      return {
        name: contractName,
        filePath,
        functions,
        events,
        errors,
        lastModified: stats.mtime,
        category: 'contracts', // Default category, will be updated by scanner
      };
    } catch (error) {
      console.error(`Error parsing file ${filePath}:`, error);
      return null;
    }
  }

  /**
   * Extract contract name from Solidity content
   */
  private extractContractName(content: string): string | null {
    const contractMatch = content.match(/(contract|library|interface)\s+(\w+)/);
    return contractMatch ? contractMatch[2] : null;
  }

  /**
   * Extract function signatures from Solidity content
   */
  private extractFunctions(
    content: string,
    contractName: string,
    filePath: string
  ): FunctionSignature[] {
    const functions: FunctionSignature[] = [];

    // Regex to match function declarations
    const functionRegex =
      /function\s+(\w+)\s*\((.*?)\)\s*(public|external|internal|private)?\s*(pure|view|payable|nonpayable)?\s*(?:returns\s*\((.*?)\))?\s*[{;]/gs;

    let match;
    while ((match = functionRegex.exec(content)) !== null) {
      const [
        ,
        name,
        inputsStr,
        visibility = 'public',
        stateMutability = 'nonpayable',
        outputsStr = '',
      ] = match;

      const inputs = this.parseParameters(inputsStr);
      const outputs = this.parseParameters(outputsStr);

      const signature = normalizeFunctionSignature(name, inputs);
      const selector = generateFunctionSelector(signature);

      functions.push({
        name,
        signature,
        selector,
        visibility: visibility as 'public' | 'external' | 'internal' | 'private',
        stateMutability: stateMutability as 'pure' | 'view' | 'nonpayable' | 'payable',
        inputs,
        outputs,
        contractName,
        filePath,
      });
    }

    // Also extract constructor
    const constructorRegex = /constructor\s*\((.*?)\)\s*(public|internal)?\s*(payable)?\s*[{]/gs;
    const constructorMatch = constructorRegex.exec(content);
    if (constructorMatch) {
      const [, inputsStr, visibility = 'public', payable] = constructorMatch;
      const inputs = this.parseParameters(inputsStr);
      const signature = normalizeFunctionSignature('constructor', inputs);
      const selector = generateFunctionSelector(signature);

      functions.push({
        name: 'constructor',
        signature,
        selector,
        visibility: visibility as 'public' | 'internal',
        stateMutability: payable === 'payable' ? 'payable' : 'nonpayable',
        inputs,
        outputs: [],
        contractName,
        filePath,
      });
    }

    // Extract modifiers
    const modifierRegex = /modifier\s+(\w+)\s*\((.*?)\)\s*[{]/gs;
    let modifierMatch;
    while ((modifierMatch = modifierRegex.exec(content)) !== null) {
      const [, name, inputsStr] = modifierMatch;
      const inputs = this.parseParameters(inputsStr);
      const signature = normalizeFunctionSignature(name, inputs);
      const selector = generateFunctionSelector(signature);

      functions.push({
        name: `modifier:${name}`,
        signature,
        selector,
        visibility: 'internal', // Modifiers are always internal
        stateMutability: 'nonpayable',
        inputs,
        outputs: [],
        contractName,
        filePath,
      });
    }

    return functions;
  }

  /**
   * Extract event signatures from Solidity content
   */
  private extractEvents(content: string, contractName: string, filePath: string): EventSignature[] {
    const events: EventSignature[] = [];

    const eventRegex = /event\s+(\w+)\s*\((.*?)\)\s*;/gs;

    let match;
    while ((match = eventRegex.exec(content)) !== null) {
      const [, name, inputsStr] = match;
      const inputs = this.parseEventParameters(inputsStr);
      const signature = normalizeFunctionSignature(name, inputs);
      const selector = generateEventSignature(signature);

      events.push({
        name,
        signature,
        selector,
        inputs,
        contractName,
        filePath,
      });
    }

    return events;
  }

  /**
   * Extract error signatures from Solidity content
   */
  private extractErrors(content: string, contractName: string, filePath: string): ErrorSignature[] {
    const errors: ErrorSignature[] = [];

    const errorRegex = /error\s+(\w+)\s*\((.*?)\)\s*;/gs;

    let match;
    while ((match = errorRegex.exec(content)) !== null) {
      const [, name, inputsStr] = match;
      const inputs = this.parseParameters(inputsStr);
      const signature = normalizeFunctionSignature(name, inputs);
      const selector = generateFunctionSelector(signature);

      errors.push({
        name,
        signature,
        selector,
        inputs,
        contractName,
        filePath,
      });
    }

    return errors;
  }

  /**
   * Parse function parameters
   */
  private parseParameters(paramString: string): Parameter[] {
    if (!paramString.trim()) {
      return [];
    }

    const params = paramString.split(',').map((p) => p.trim());
    return params
      .map((param) => {
        const parts = param.split(' ').filter((p) => p.length > 0);
        if (parts.length >= 2) {
          return {
            type: parts[0],
            name: parts[1],
          };
        }
        return {
          type: param,
          name: '',
        };
      })
      .filter((p) => p.type.length > 0);
  }

  /**
   * Parse event parameters (includes indexed keyword)
   */
  private parseEventParameters(paramString: string): Parameter[] {
    if (!paramString.trim()) {
      return [];
    }

    const params = paramString.split(',').map((p) => p.trim());
    return params
      .map((param) => {
        const parts = param.split(' ').filter((p) => p.length > 0);
        const indexed = parts.includes('indexed');

        if (indexed) {
          const typeIndex = parts.findIndex((p) => p !== 'indexed');
          const nameIndex = typeIndex + 1;

          return {
            type: parts[typeIndex] || '',
            name: parts[nameIndex] || '',
            indexed: true,
          };
        } else if (parts.length >= 2) {
          return {
            type: parts[0],
            name: parts[1],
            indexed: false,
          };
        }

        return {
          type: param,
          name: '',
          indexed: false,
        };
      })
      .filter((p) => p.type.length > 0);
  }
}
