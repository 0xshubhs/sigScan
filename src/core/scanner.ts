import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { ProjectInfo, ContractInfo, ScanResult, ContractCategory } from '../types';
import { SolidityParser } from './parser';

export class ProjectScanner {
  private parser: SolidityParser;

  constructor() {
    this.parser = new SolidityParser();
  }

  /**
   * Detect project type and scan for contracts
   */
  public async scanProject(rootPath: string): Promise<ScanResult> {
    const projectInfo = this.detectProjectType(rootPath);
    const contracts = new Map<string, ContractInfo>();
    const contractsByCategory = new Map<ContractCategory, ContractInfo[]>();
    const uniqueSignatures = new Map<string, any>();

    // Initialize category maps
    contractsByCategory.set('contracts', []);
    contractsByCategory.set('libs', []);
    contractsByCategory.set('tests', []);

    // Scan all contract directories
    for (const contractDir of projectInfo.contractDirs) {
      const fullPath = path.join(rootPath, contractDir);
      if (fs.existsSync(fullPath)) {
        const contractFiles = await this.findSolidityFiles(fullPath);

        for (const filePath of contractFiles) {
          const contractInfo = this.parser.parseFile(filePath);
          if (contractInfo) {
            // Categorize the contract
            contractInfo.category = this.categorizeContract(filePath, rootPath);
            contracts.set(filePath, contractInfo);

            // Add to category map
            const categoryContracts = contractsByCategory.get(contractInfo.category) || [];
            categoryContracts.push(contractInfo);
            contractsByCategory.set(contractInfo.category, categoryContracts);
          }
        }
      }
    }

    // Detect inherited contracts from libs
    this.detectInheritedContracts(contracts, projectInfo);

    // Filter lib contracts to only include inherited ones
    const libContracts = contractsByCategory.get('libs') || [];
    const filteredLibContracts = libContracts.filter((contract) => {
      // Include contract if it's inherited or if it's imported by main contracts
      return (
        projectInfo.inheritedContracts.has(contract.name) ||
        this.isContractImported(contract.name, contracts)
      );
    });
    contractsByCategory.set('libs', filteredLibContracts);

    // Collect unique signatures to avoid duplicates
    this.collectUniqueSignatures(contracts, uniqueSignatures);

    projectInfo.contracts = contracts;

    // Calculate statistics
    let totalFunctions = 0;
    let totalEvents = 0;
    let totalErrors = 0;

    contracts.forEach((contract) => {
      totalFunctions += contract.functions.length;
      totalEvents += contract.events.length;
      totalErrors += contract.errors.length;
    });

    return {
      projectInfo,
      totalContracts: contracts.size,
      totalFunctions,
      totalEvents,
      totalErrors,
      scanTime: new Date(),
      contractsByCategory,
      uniqueSignatures,
    };
  }

  /**
   * Categorize contract based on file path
   */
  private categorizeContract(filePath: string, rootPath: string): ContractCategory {
    const relativePath = path.relative(rootPath, filePath);

    if (relativePath.includes('test') || relativePath.includes('Test')) {
      return 'tests';
    }
    if (relativePath.includes('lib/') || relativePath.includes('libs/')) {
      return 'libs';
    }
    return 'contracts';
  }

  /**
   * Detect inherited contracts by parsing import statements
   */
  private detectInheritedContracts(
    contracts: Map<string, ContractInfo>,
    projectInfo: ProjectInfo
  ): void {
    projectInfo.inheritedContracts = new Set<string>();

    for (const [filePath, contract] of contracts) {
      if (contract.category === 'contracts') {
        const content = fs.readFileSync(filePath, 'utf-8');
        const imports = this.extractImports(content);

        for (const importPath of imports) {
          if (importPath.includes('lib/')) {
            const contractName = this.extractContractNameFromImport(importPath);
            if (contractName) {
              projectInfo.inheritedContracts.add(contractName);
            }
          }
        }
      }
    }
  }

  /**
   * Extract import statements from Solidity content
   */
  private extractImports(content: string): string[] {
    const imports: string[] = [];
    const importRegex = /import\s+[^"]*"([^"]+)"/g;
    let match;

    while ((match = importRegex.exec(content)) !== null) {
      imports.push(match[1]);
    }

    return imports;
  }

  /**
   * Extract contract name from import path
   */
  private extractContractNameFromImport(importPath: string): string | null {
    const basename = path.basename(importPath, '.sol');
    return basename || null;
  }

  /**
   * Collect unique signatures to avoid duplicates
   */
  private collectUniqueSignatures(
    contracts: Map<string, ContractInfo>,
    uniqueSignatures: Map<string, any>
  ): void {
    for (const [, contract] of contracts) {
      // Collect unique function signatures
      for (const func of contract.functions) {
        uniqueSignatures.set(func.signature, func);
      }

      // Collect unique event signatures
      for (const event of contract.events) {
        uniqueSignatures.set(event.signature, event);
      }

      // Collect unique error signatures
      for (const error of contract.errors) {
        uniqueSignatures.set(error.signature, error);
      }
    }
  }

  /**
   * Detect if project is Foundry, Hardhat, or unknown
   */
  private detectProjectType(rootPath: string): ProjectInfo {
    const foundryConfig = path.join(rootPath, 'foundry.toml');
    const hardhatConfigJs = path.join(rootPath, 'hardhat.config.js');
    const hardhatConfigTs = path.join(rootPath, 'hardhat.config.ts');

    let type: 'foundry' | 'hardhat' | 'unknown' = 'unknown';
    let contractDirs: string[] = [];

    // Check for Foundry project
    const isFoundry = fs.existsSync(foundryConfig);
    // Check for Hardhat project
    const isHardhat = fs.existsSync(hardhatConfigJs) || fs.existsSync(hardhatConfigTs);

    if (isFoundry && isHardhat) {
      // Hybrid project - check both Foundry and Hardhat directories
      type = 'foundry';
      contractDirs = ['src', 'lib', 'contracts'];
    } else if (isFoundry) {
      type = 'foundry';
      // Also check for 'contracts' dir in case project uses non-standard Foundry layout
      contractDirs = fs.existsSync(path.join(rootPath, 'contracts'))
        ? ['src', 'lib', 'contracts']
        : ['src', 'lib'];
    } else if (isHardhat) {
      type = 'hardhat';
      contractDirs = ['contracts'];
    } else {
      // Default fallback - scan all common directories
      contractDirs = ['src', 'contracts'];
    }

    return {
      type,
      rootPath,
      contractDirs,
      contracts: new Map(),
      inheritedContracts: new Set(),
    };
  }

  /**
   * Find all Solidity files in a directory
   */
  private async findSolidityFiles(dirPath: string): Promise<string[]> {
    const pattern = path.join(dirPath, '**/*.sol');
    return new Promise((resolve, reject) => {
      glob(pattern, (err, files) => {
        if (err) {
          reject(err);
        } else {
          resolve(files);
        }
      });
    });
  }

  /**
   * Check if a file has been modified since last scan
   */
  public hasFileChanged(filePath: string, lastModified: Date): boolean {
    try {
      const stats = fs.statSync(filePath);
      return stats.mtime > lastModified;
    } catch {
      return true; // File doesn't exist or error, consider it changed
    }
  }

  /**
   * Scan only changed files
   */
  public async scanChangedFiles(
    projectInfo: ProjectInfo,
    lastScanTime: Date
  ): Promise<{ changed: ContractInfo[]; removed: string[] }> {
    const changed: ContractInfo[] = [];
    const removed: string[] = [];

    // Check existing contracts for changes
    for (const [filePath, contractInfo] of projectInfo.contracts) {
      if (!fs.existsSync(filePath)) {
        removed.push(filePath);
        continue;
      }

      if (this.hasFileChanged(filePath, lastScanTime)) {
        const updatedContract = this.parser.parseFile(filePath);
        if (updatedContract) {
          changed.push(updatedContract);
          projectInfo.contracts.set(filePath, updatedContract);
        }
      }
    }

    // Check for new files
    for (const contractDir of projectInfo.contractDirs) {
      const fullPath = path.join(projectInfo.rootPath, contractDir);
      if (fs.existsSync(fullPath)) {
        const contractFiles = await this.findSolidityFiles(fullPath);

        for (const filePath of contractFiles) {
          if (!projectInfo.contracts.has(filePath)) {
            const newContract = this.parser.parseFile(filePath);
            if (newContract) {
              changed.push(newContract);
              projectInfo.contracts.set(filePath, newContract);
            }
          }
        }
      }
    }

    // Remove deleted files from project
    removed.forEach((filePath) => {
      projectInfo.contracts.delete(filePath);
    });

    return { changed, removed };
  }

  /**
   * Check if a contract is imported by any main contracts
   */
  private isContractImported(contractName: string, contracts: Map<string, ContractInfo>): boolean {
    for (const [filePath, contract] of contracts) {
      if (contract.category === 'contracts') {
        const content = fs.readFileSync(filePath, 'utf-8');
        // Check if this contract imports the given contract name
        if (content.includes(`import`) && content.includes(contractName)) {
          return true;
        }
        // Also check inheritance patterns
        const inheritancePattern = new RegExp(`contract\\s+\\w+\\s+is\\s+.*${contractName}`, 'i');
        if (inheritancePattern.test(content)) {
          return true;
        }
      }
    }
    return false;
  }
}
