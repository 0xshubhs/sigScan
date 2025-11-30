import { keccak256 } from 'js-sha3';

/**
 * Generate Keccak256 hash for function signature
 */
export function generateFunctionSelector(signature: string): string {
  const hash = keccak256(signature);
  return '0x' + hash.substring(0, 8);
}

/**
 * Generate Keccak256 hash for event signature
 */
export function generateEventSignature(signature: string): string {
  return '0x' + keccak256(signature);
}

/**
 * Normalize function signature for consistency
 */
export function normalizeFunctionSignature(name: string, inputs: any[]): string {
  const params = inputs.map((input) => normalizeType(input.type)).join(',');
  return `${name}(${params})`;
}

/**
 * Normalize Solidity types
 */
export function normalizeType(type: string): string {
  // Remove spaces and normalize array notation
  return type.replace(/\s+/g, '').replace(/\[\s*\]/g, '[]');
}

/**
 * Check if a function should be included based on visibility
 */
export function shouldIncludeFunction(
  visibility: string,
  includeInternal = false,
  includePrivate = false
): boolean {
  switch (visibility) {
    case 'public':
    case 'external':
      return true;
    case 'internal':
      return includeInternal;
    case 'private':
      return includePrivate;
    default:
      return false;
  }
}

/**
 * Format timestamp for output files
 */
export function formatTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-').slice(0, -5);
}

/**
 * Get file extension for export format
 */
export function getFileExtension(format: string): string {
  const extensions: Record<string, string> = {
    txt: '.txt',
    json: '.json',
    csv: '.csv',
    md: '.md',
  };
  return extensions[format] || '.txt';
}

/**
 * Validate Solidity identifier
 */
export function isValidSolidityIdentifier(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

/**
 * Parse function parameters from string
 */
export function parseParameters(paramString: string): { name: string; type: string }[] {
  if (!paramString.trim()) {
    return [];
  }

  const params = paramString.split(',').map((p) => p.trim());
  return params.map((param) => {
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
  });
}

/**
 * Clean contract name from file path
 */
export function getContractNameFromPath(filePath: string): string {
  const fileName = filePath.split('/').pop() || '';
  return fileName.replace('.sol', '');
}
