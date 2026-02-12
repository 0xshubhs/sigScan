export interface FunctionSignature {
  name: string;
  signature: string;
  selector: string;
  visibility: 'public' | 'external' | 'internal' | 'private';
  stateMutability: 'pure' | 'view' | 'nonpayable' | 'payable';
  inputs: Parameter[];
  outputs: Parameter[];
  contractName: string;
  filePath: string;
  natspec?: NatspecInfo;
}

export interface Parameter {
  name: string;
  type: string;
  indexed?: boolean;
}

export interface EventSignature {
  name: string;
  signature: string;
  selector: string;
  inputs: Parameter[];
  contractName: string;
  filePath: string;
  natspec?: NatspecInfo;
  indexingWarnings?: string[];
}

export interface ErrorSignature {
  name: string;
  signature: string;
  selector: string;
  inputs: Parameter[];
  contractName: string;
  filePath: string;
  natspec?: NatspecInfo;
}

export interface ContractInfo {
  name: string;
  filePath: string;
  functions: FunctionSignature[];
  events: EventSignature[];
  errors: ErrorSignature[];
  lastModified: Date;
  category: ContractCategory;
}

export interface ProjectInfo {
  type: 'foundry' | 'hardhat' | 'unknown';
  rootPath: string;
  contractDirs: string[];
  contracts: Map<string, ContractInfo>;
  inheritedContracts: Set<string>; // Track inherited contracts from libs
}

export interface ScanResult {
  projectInfo: ProjectInfo;
  totalContracts: number;
  totalFunctions: number;
  totalEvents: number;
  totalErrors: number;
  scanTime: Date;
  contractsByCategory: Map<ContractCategory, ContractInfo[]>;
  uniqueSignatures: Map<string, FunctionSignature | EventSignature | ErrorSignature>;
}

export type ContractCategory = 'contracts' | 'libs' | 'tests';

export interface ExportOptions {
  formats: ('txt' | 'json' | 'csv' | 'md')[];
  outputDir: string;
  includeInternal: boolean;
  includePrivate: boolean;
  includeEvents: boolean;
  includeErrors: boolean;
  separateByCategory?: boolean;
  updateExisting?: boolean;
  deduplicateSignatures?: boolean;
}

// --- Natspec extraction ---

export interface NatspecInfo {
  notice?: string;
  dev?: string;
  params: Record<string, string>;
  returns: Record<string, string>;
  custom: Record<string, string>;
}

// --- Selector collision detection ---

export interface CollisionResult {
  selector: string;
  functions: Array<{
    name: string;
    signature: string;
    contractName: string;
    filePath: string;
  }>;
}

// --- Interface compliance ---

export interface InterfaceDefinition {
  name: string;
  selectors: Record<string, string>;
  events?: Record<string, string>;
}

export interface InterfaceComplianceResult {
  interfaceName: string;
  implemented: string[];
  missing: string[];
  compliant: boolean;
}

// --- Gas optimization suggestions ---

export interface GasOptimizationSuggestion {
  line: number;
  endLine: number;
  rule: string;
  message: string;
  severity: 'info' | 'warning';
  savings?: string;
}

// --- Coverage ---

export interface CoverageEntry {
  filePath: string;
  lines: Map<number, number>; // line -> hit count
  branches: Map<number, boolean[]>; // branch line -> taken/not per branch
  functions: Map<string, number>; // function name -> hit count
}

export interface CoverageReport {
  entries: CoverageEntry[];
  summary: {
    linePercent: number;
    branchPercent: number;
    functionPercent: number;
  };
}

// --- Upgrade analysis ---

export interface StorageSlotDiff {
  slot: number;
  oldVar?: string;
  newVar?: string;
  oldType?: string;
  newType?: string;
  issue: 'type_changed' | 'removed' | 'reordered' | 'inserted_before_existing';
}

export interface UpgradeReport {
  contractName: string;
  compatible: boolean;
  diffs: StorageSlotDiff[];
  warnings: string[];
}

// --- Invariant detection ---

export interface InvariantInfo {
  type: 'balance_tracking' | 'ownership' | 'reentrancy_guard' | 'access_control' | 'pausable';
  description: string;
  line: number;
  confidence: 'high' | 'medium' | 'low';
  relatedFunctions: string[];
}

// --- MEV / Front-running analysis ---

export interface MEVRisk {
  functionName: string;
  riskType:
    | 'state_dependent_return'
    | 'unprotected_swap'
    | 'oracle_manipulation'
    | 'sandwich_attack'
    | 'timestamp_dependency';
  severity: 'high' | 'medium' | 'low';
  description: string;
  line: number;
  mitigation: string;
}

// --- Gas pricing ---

export interface GasPrice {
  chain: string;
  gasPriceGwei: number;
  ethPriceUsd: number;
  timestamp: number;
}

// --- Gas snapshot ---

export interface SnapshotData {
  version: string;
  timestamp: number;
  commitHash?: string;
  branch?: string;
  functions: Array<{
    contractName: string;
    functionName: string;
    selector: string;
    gas: number;
  }>;
}

export interface SnapshotDiff {
  added: SnapshotData['functions'];
  removed: SnapshotData['functions'];
  changed: Array<{
    contractName: string;
    functionName: string;
    selector: string;
    oldGas: number;
    newGas: number;
    changePercent: number;
  }>;
}

// --- File system abstraction ---

export interface FSProvider {
  findFiles(pattern: string, exclude?: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

export interface FSWatcher {
  onDidChange(callback: (path: string) => void): void;
  onDidCreate(callback: (path: string) => void): void;
  onDidDelete(callback: (path: string) => void): void;
  dispose(): void;
}
