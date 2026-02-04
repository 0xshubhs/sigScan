/**
 * ABI Generator - Converts signatures to standard Ethereum ABI format
 */

export interface ABIEntry {
  type: 'function' | 'event' | 'error' | 'constructor';
  name?: string;
  inputs: ABIParameter[];
  outputs?: ABIParameter[];
  stateMutability?: 'pure' | 'view' | 'nonpayable' | 'payable';
  anonymous?: boolean;
}

export interface ABIParameter {
  name: string;
  type: string;
  indexed?: boolean;
  components?: ABIParameter[];
}

export class ABIGenerator {
  /**
   * Generate complete ABI from signatures
   */
  public generateABI(signatures: any): ABIEntry[] {
    const abi: ABIEntry[] = [];

    // Add functions
    if (signatures.functions) {
      signatures.functions.forEach((func: any) => {
        abi.push(this.functionToABI(func));
      });
    }

    // Add events
    if (signatures.events) {
      signatures.events.forEach((event: any) => {
        abi.push(this.eventToABI(event));
      });
    }

    // Add errors
    if (signatures.errors) {
      signatures.errors.forEach((error: any) => {
        abi.push(this.errorToABI(error));
      });
    }

    return abi;
  }

  /**
   * Convert function signature to ABI entry
   */
  private functionToABI(func: any): ABIEntry {
    const inputs = this.parseParameters(func.signature);
    const outputs = func.returns ? this.parseParameters(func.returns) : [];

    let stateMutability: 'pure' | 'view' | 'nonpayable' | 'payable' = 'nonpayable';
    if (func.stateMutability === 'pure') {
      stateMutability = 'pure';
    } else if (func.stateMutability === 'view') {
      stateMutability = 'view';
    } else if (func.stateMutability === 'payable' || func.isPayable) {
      stateMutability = 'payable';
    }

    return {
      type: func.name === 'constructor' ? 'constructor' : 'function',
      name: func.name !== 'constructor' ? func.name : undefined,
      inputs,
      outputs: func.name !== 'constructor' ? outputs : undefined,
      stateMutability,
    };
  }

  /**
   * Convert event signature to ABI entry
   */
  private eventToABI(event: any): ABIEntry {
    const inputs = this.parseEventParameters(event.signature);

    return {
      type: 'event',
      name: event.name,
      inputs,
      anonymous: false,
    };
  }

  /**
   * Convert error signature to ABI entry
   */
  private errorToABI(error: any): ABIEntry {
    const inputs = this.parseParameters(error.signature);

    return {
      type: 'error',
      name: error.name,
      inputs,
    };
  }

  /**
   * Parse parameter string into ABI parameters
   */
  private parseParameters(signature: string): ABIParameter[] {
    // Extract parameters from signature like "transfer(address,uint256)"
    const match = signature.match(/\((.*?)\)/);
    if (!match || !match[1]) {
      return [];
    }

    const paramString = match[1];
    if (!paramString.trim()) {
      return [];
    }

    const params = paramString.split(',').map((p) => p.trim());
    return params.map((param, index) => {
      const [type, name] = param.split(/\s+/);
      return {
        name: name || `param${index}`,
        type: type || 'bytes',
      };
    });
  }

  /**
   * Parse event parameters with indexed markers
   */
  private parseEventParameters(signature: string): ABIParameter[] {
    const match = signature.match(/\((.*?)\)/);
    if (!match || !match[1]) {
      return [];
    }

    const paramString = match[1];
    if (!paramString.trim()) {
      return [];
    }

    const params = paramString.split(',').map((p) => p.trim());
    return params.map((param, index) => {
      const isIndexed = param.includes('indexed');
      const cleanParam = param.replace('indexed', '').trim();
      const [type, name] = cleanParam.split(/\s+/);

      return {
        name: name || `param${index}`,
        type: type || 'bytes',
        indexed: isIndexed,
      };
    });
  }

  /**
   * Export ABI to JSON file
   */
  public exportABI(abi: ABIEntry[], _contractName: string): string {
    return JSON.stringify(abi, null, 2);
  }

  /**
   * Generate human-readable ABI documentation
   */
  public generateABIDocs(abi: ABIEntry[]): string {
    let docs = '# Contract ABI Documentation\n\n';

    const functions = abi.filter((e) => e.type === 'function');
    const events = abi.filter((e) => e.type === 'event');
    const errors = abi.filter((e) => e.type === 'error');

    if (functions.length > 0) {
      docs += '## Functions\n\n';
      functions.forEach((func) => {
        docs += `### ${func.name}\n\n`;
        docs += `- **State Mutability**: ${func.stateMutability}\n`;
        docs += `- **Inputs**: ${this.formatParameters(func.inputs)}\n`;
        if (func.outputs && func.outputs.length > 0) {
          docs += `- **Outputs**: ${this.formatParameters(func.outputs)}\n`;
        }
        docs += '\n';
      });
    }

    if (events.length > 0) {
      docs += '## Events\n\n';
      events.forEach((event) => {
        docs += `### ${event.name}\n\n`;
        docs += `- **Parameters**: ${this.formatParameters(event.inputs)}\n\n`;
      });
    }

    if (errors.length > 0) {
      docs += '## Errors\n\n';
      errors.forEach((error) => {
        docs += `### ${error.name}\n\n`;
        docs += `- **Parameters**: ${this.formatParameters(error.inputs)}\n\n`;
      });
    }

    return docs;
  }

  /**
   * Format parameters for documentation
   */
  private formatParameters(params: ABIParameter[]): string {
    if (params.length === 0) {
      return 'none';
    }
    return params.map((p) => `${p.type} ${p.name}${p.indexed ? ' indexed' : ''}`).join(', ');
  }
}
