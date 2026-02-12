/**
 * ERC Interface Compliance Checker
 *
 * Checks whether a contract implements known ERC interfaces (ERC20, ERC721,
 * ERC1155, ERC4626, etc.) by comparing its function selectors against the
 * required selectors defined in each standard.
 */

import { ContractInfo, InterfaceDefinition, InterfaceComplianceResult } from '../types';

/**
 * Known ERC interface definitions with their required function selectors.
 *
 * Selectors are the first 4 bytes of keccak256 of the canonical function signature.
 * These are pre-computed for efficiency and correctness.
 */
export const KNOWN_INTERFACES: InterfaceDefinition[] = [
  {
    name: 'ERC20',
    selectors: {
      'transfer(address,uint256)': '0xa9059cbb',
      'approve(address,uint256)': '0x095ea7b3',
      'transferFrom(address,address,uint256)': '0x23b872dd',
      'balanceOf(address)': '0x70a08231',
      'allowance(address,address)': '0xdd62ed3e',
      'totalSupply()': '0x18160ddd',
    },
    events: {
      'Transfer(address,address,uint256)':
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      'Approval(address,address,uint256)':
        '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
    },
  },
  {
    name: 'ERC721',
    selectors: {
      'balanceOf(address)': '0x70a08231',
      'ownerOf(uint256)': '0x6352211e',
      'safeTransferFrom(address,address,uint256)': '0x42842e0e',
      'safeTransferFrom(address,address,uint256,bytes)': '0xb88d4fde',
      'transferFrom(address,address,uint256)': '0x23b872dd',
      'approve(address,uint256)': '0x095ea7b3',
      'getApproved(uint256)': '0x081812fc',
      'setApprovalForAll(address,bool)': '0xa22cb465',
      'isApprovedForAll(address,address)': '0xe985e9c5',
    },
    events: {
      'Transfer(address,address,uint256)':
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      'Approval(address,address,uint256)':
        '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
      'ApprovalForAll(address,address,bool)':
        '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31',
    },
  },
  {
    name: 'ERC1155',
    selectors: {
      'safeTransferFrom(address,address,uint256,uint256,bytes)': '0xf242432a',
      'safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)': '0x2eb2c2d6',
      'balanceOf(address,uint256)': '0x00fdd58e',
      'balanceOfBatch(address[],uint256[])': '0x4e1273f4',
    },
    events: {
      'TransferSingle(address,address,address,uint256,uint256)':
        '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62',
      'TransferBatch(address,address,address,uint256[],uint256[])':
        '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb',
    },
  },
  {
    name: 'ERC4626',
    selectors: {
      'asset()': '0x38d52e0f',
      'totalAssets()': '0x01e1d114',
      'convertToShares(uint256)': '0xc6e6f592',
      'convertToAssets(uint256)': '0x07a2d13a',
      'deposit(uint256,address)': '0x6e553f65',
      'mint(uint256,address)': '0x94bf804d',
      'withdraw(uint256,address,address)': '0xb460af94',
      'redeem(uint256,address,address)': '0xba087652',
    },
  },
];

export class InterfaceChecker {
  private interfaces: InterfaceDefinition[];

  constructor(additionalInterfaces?: InterfaceDefinition[]) {
    this.interfaces = [...KNOWN_INTERFACES];
    if (additionalInterfaces) {
      this.interfaces.push(...additionalInterfaces);
    }
  }

  /**
   * Check a contract's compliance against all known ERC interfaces.
   *
   * Compares the contract's function selectors against each known interface
   * definition. Returns results only for interfaces where at least one
   * required function selector is present in the contract.
   *
   * @param contractInfo - Parsed contract information with function selectors
   * @returns Array of compliance results, one per partially/fully matched interface
   */
  public checkCompliance(contractInfo: ContractInfo): InterfaceComplianceResult[] {
    // Collect all selectors from the contract (public + external only)
    const contractSelectors = new Set<string>();

    for (const func of contractInfo.functions) {
      if (func.visibility === 'public' || func.visibility === 'external') {
        contractSelectors.add(func.selector.toLowerCase());
      }
    }

    const results: InterfaceComplianceResult[] = [];

    for (const iface of this.interfaces) {
      const implemented: string[] = [];
      const missing: string[] = [];

      for (const [signature, selector] of Object.entries(iface.selectors)) {
        if (contractSelectors.has(selector.toLowerCase())) {
          implemented.push(signature);
        } else {
          missing.push(signature);
        }
      }

      // Only report interfaces where at least one function matches
      if (implemented.length > 0) {
        results.push({
          interfaceName: iface.name,
          implemented,
          missing,
          compliant: missing.length === 0,
        });
      }
    }

    return results;
  }

  /**
   * Check compliance for all contracts in a project.
   *
   * @param contracts - Map of file paths to ContractInfo
   * @returns Map of contract name to its compliance results
   */
  public checkAllContracts(
    contracts: Map<string, ContractInfo>
  ): Map<string, InterfaceComplianceResult[]> {
    const results = new Map<string, InterfaceComplianceResult[]>();

    for (const [, contractInfo] of contracts) {
      const compliance = this.checkCompliance(contractInfo);
      if (compliance.length > 0) {
        results.set(contractInfo.name, compliance);
      }
    }

    return results;
  }

  /**
   * Register a custom interface definition for compliance checking.
   *
   * @param definition - Interface definition with name and required selectors
   */
  public registerInterface(definition: InterfaceDefinition): void {
    // Replace if an interface with the same name already exists
    const existingIndex = this.interfaces.findIndex((i) => i.name === definition.name);
    if (existingIndex >= 0) {
      this.interfaces[existingIndex] = definition;
    } else {
      this.interfaces.push(definition);
    }
  }

  /**
   * Get all registered interface definitions.
   *
   * @returns Array of all known interface definitions
   */
  public getRegisteredInterfaces(): InterfaceDefinition[] {
    return [...this.interfaces];
  }

  /**
   * Generate a human-readable compliance report.
   *
   * @param contractName - Name of the contract
   * @param results - Compliance check results
   * @returns Markdown-formatted report string
   */
  public generateReport(contractName: string, results: InterfaceComplianceResult[]): string {
    if (results.length === 0) {
      return `# Interface Compliance: ${contractName}\n\nNo known ERC interface patterns detected.\n`;
    }

    let report = `# Interface Compliance: ${contractName}\n\n`;

    for (const result of results) {
      const status = result.compliant ? 'COMPLIANT' : 'PARTIAL';
      const icon = result.compliant ? '[PASS]' : '[WARN]';
      const total = result.implemented.length + result.missing.length;
      const pct = Math.round((result.implemented.length / total) * 100);

      report += `## ${icon} ${result.interfaceName} (${pct}% - ${status})\n\n`;

      if (result.implemented.length > 0) {
        report += '**Implemented:**\n';
        for (const sig of result.implemented) {
          report += `- \`${sig}\`\n`;
        }
        report += '\n';
      }

      if (result.missing.length > 0) {
        report += '**Missing:**\n';
        for (const sig of result.missing) {
          report += `- \`${sig}\`\n`;
        }
        report += '\n';
      }
    }

    return report;
  }
}
