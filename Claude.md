# SigScan - Complete Project Documentation

## Project Objective

**SigScan** is a professional VS Code extension and CLI tool for Solidity smart contract analysis. Its primary objectives are:

1. **Automatic Signature Extraction** - Extract function selectors, event topics, and error selectors from Solidity contracts
2. **Real-time Gas Estimation** - Provide inline gas cost analysis using the Solidity compiler (solc)
3. **Developer Experience** - Seamless integration with VS Code for Foundry and Hardhat projects
4. **Fallback Resilience** - Generate se``lectors even when compilation fails (import issues, syntax errors)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER INTERFACE                                  │
├─────────────────┬─────────────────┬─────────────────┬──────────────────────┤
│  VS Code        │  Tree View      │  Inline         │  CLI                 │
│  Commands       │  Provider       │  Decorations    │  Interface           │
└────────┬────────┴────────┬────────┴────────┬────────┴──────────┬───────────┘
         │                 │                 │                   │
         ▼                 ▼                 ▼                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           EXTENSION LAYER                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │  extension.ts │  │  manager.ts  │  │ treeProvider │  │  realtime.ts │    │
│  │  (Activation) │  │  (Commands)  │  │  (Sidebar)   │  │  (Analysis)  │    │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
         │                 │                 │                   │
         ▼                 ▼                 ▼                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CORE ENGINE                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │  scanner.ts  │  │  parser.ts   │  │  watcher.ts  │  │  cache.ts    │    │
│  │  (Discovery) │  │  (Regex)     │  │  (FS Watch)  │  │  (SHA-256)   │    │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
         │                 │                 │                   │
         ▼                 ▼                 ▼                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            FEATURES LAYER                                    │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐           │
│  │ SolcManager │ │ gas.ts      │ │compilation- │ │ gas-        │           │
│  │ (Compiler)  │ │ (Estimator) │ │ service.ts  │ │ decorations │           │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘           │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐           │
│  │ abi.ts      │ │ size.ts     │ │ complexity  │ │ storage-    │           │
│  │ (ABI Gen)   │ │ (24KB)      │ │ .ts         │ │ layout.ts   │           │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘           │
└─────────────────────────────────────────────────────────────────────────────┘
         │                 │                 │                   │
         ▼                 ▼                 ▼                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            EXPORT LAYER                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │  JSON        │  │  TXT         │  │  CSV         │  │  Markdown    │    │
│  │  Exporter    │  │  Exporter    │  │  Exporter    │  │  Exporter    │    │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Directory Structure

```
sigScan/
├── src/
│   ├── types.ts                 # TypeScript interfaces and types
│   ├── cli/
│   │   └── index.ts             # CLI entry point (sigscan command)
│   ├── core/
│   │   ├── scanner.ts           # Project discovery and file scanning
│   │   ├── parser.ts            # Regex-based Solidity parsing
│   │   ├── watcher.ts           # File system watcher
│   │   ├── cache.ts             # SHA-256 content caching
│   │   └── exporter.ts          # Multi-format export logic
│   ├── extension/
│   │   ├── extension.ts         # VS Code extension activation
│   │   ├── manager.ts           # Command handlers and coordination
│   │   └── providers/
│   │       └── treeProvider.ts  # Sidebar tree view
│   ├── features/
│   │   ├── SolcManager.ts       # Solc compiler lifecycle (WASM)
│   │   ├── compilation-service.ts # Debounced compilation orchestration
│   │   ├── gas.ts               # Gas estimation (solc + heuristic)
│   │   ├── gas-decorations.ts   # Inline VS Code decorations
│   │   ├── realtime.ts          # Real-time analysis engine
│   │   ├── abi.ts               # ABI generation
│   │   ├── size.ts              # Contract size checking (24KB limit)
│   │   ├── complexity.ts        # Cyclomatic complexity analysis
│   │   ├── storage-layout.ts    # Storage slot visualization
│   │   ├── call-graph.ts        # Function call hierarchy
│   │   ├── deployment.ts        # Deployment cost estimation
│   │   ├── regression.ts        # Gas regression tracking
│   │   ├── profiler.ts          # Runtime profiling
│   │   ├── solc-integration.ts  # Legacy solc integration
│   │   └── solc-version-manager.ts # Pragma-based version selection
│   └── utils/
│       └── helpers.ts           # Keccak256, normalization utilities
├── data/
│   └── signatures.json          # Known signature database
├── examples/                    # Example Solidity projects
├── docs/                        # Documentation
└── package.json                 # Extension manifest
```

---

## Core Components

### 1. Project Scanner (`src/core/scanner.ts`)

**Purpose**: Discovers Solidity files and categorizes them.

**Key Functions**:
- `findAllSubProjects()` - Recursively finds Foundry/Hardhat projects
- `scanProject()` - Scans a single project for .sol files
- `categorizeContract()` - Classifies as contracts/libs/tests

**Detection Logic**:
```
foundry.toml exists?  → Foundry project (scan src/, lib/)
hardhat.config.js?    → Hardhat project (scan contracts/)
Neither?              → Generic (recursive scan)
```

### 2. Solidity Parser (`src/core/parser.ts`)

**Purpose**: Extracts signatures using regex (no AST dependency).

**Extracts**:
- **Functions**: `function name(params) visibility mutability returns (type)`
- **Events**: `event Name(type indexed param, ...)`
- **Errors**: `error Name(type param, ...)`
- **Constructors**: `constructor(params) visibility`
- **Modifiers**: `modifier name(params)`

**Selector Calculation**:
```typescript
// Function selector (first 4 bytes of keccak256)
keccak256("transfer(address,uint256)") → 0xa9059cbb

// Event topic (full 32 bytes)
keccak256("Transfer(address,address,uint256)") → 0xddf252ad...
```

### 3. SolcManager (`src/features/SolcManager.ts`)

**Purpose**: Centralized Solidity compiler management.

**Key Features**:
- Uses WASM solc-js (platform-independent)
- Lazy-loads compiler versions based on pragma
- Caches loaded compilers to prevent re-downloads
- Falls back to bundled 0.8.x if exact version unavailable

**Compilation Flow**:
```
Source Code
    ↓
Parse pragma (e.g., ^0.8.20)
    ↓
Resolve best version from available
    ↓
Load compiler (cached or download)
    ↓
Compile with standard JSON input
    ↓
Extract: AST, bytecode, gas estimates
    ↓
Map gas to source locations
```

### 4. Compilation Service (`src/features/compilation-service.ts`)

**Purpose**: Debounced, event-driven compilation orchestration.

**Features**:
- Debounces rapid edits (300ms default)
- Content-hash based caching (5 min expiry)
- Emits events: `compilation:start`, `compilation:success`, `compilation:error`
- Handles import resolution via callback

### 5. Real-time Analyzer (`src/features/realtime.ts`)

**Purpose**: Live analysis during editing.

**Two-Phase Analysis**:
1. **Immediate** (on file open): Show signatures with selectors
2. **Background** (after idle): Run solc for gas estimates

**Extended Analysis** (background, resource-aware):
- Storage layout
- Call graph
- Deployment costs

---

## Gas Estimation System

### Primary: Solc-based (Accurate)

```typescript
// Compile contract and extract gas estimates
const result = await compileWithGasAnalysis(source, fileName, settings);

// Result includes:
{
  gasInfo: [{
    name: "transfer",
    selector: "0xa9059cbb",
    gas: 51234,  // From solc
    loc: { line: 15, endLine: 20 },
    visibility: "external",
    stateMutability: "nonpayable",
    warnings: []
  }]
}
```

### Fallback: Regex-based (When Compilation Fails)

When imports are missing or code doesn't compile:

```typescript
// extractFunctionsWithRegex() provides:
{
  name: "transfer",
  selector: "0xa9059cbb",  // Still correct!
  gas: 0,                   // Unavailable
  warnings: ["⚠️ Gas unavailable - compilation failed (check imports)"]
}
```

**This ensures selectors are ALWAYS shown**, even with broken imports.

---

## Data Types

### FunctionSignature
```typescript
interface FunctionSignature {
  name: string;              // "transfer"
  signature: string;         // "transfer(address,uint256)"
  selector: string;          // "0xa9059cbb"
  visibility: 'public' | 'external' | 'internal' | 'private';
  stateMutability: 'pure' | 'view' | 'nonpayable' | 'payable';
  inputs: Parameter[];
  outputs: Parameter[];
  contractName: string;
  filePath: string;
}
```

### GasInfo (Remix-style)
```typescript
interface GasInfo {
  name: string;
  selector: string;
  gas: number | 'infinite';
  loc: { line: number; endLine: number };
  visibility: string;
  stateMutability: string;
  warnings: string[];
}
```

### CompilationOutput
```typescript
interface CompilationOutput {
  success: boolean;
  version: string;           // "0.8.20"
  gasInfo: GasInfo[];
  errors: string[];
  warnings: string[];
  ast?: unknown;
  bytecode?: string;
}
```

---

## VS Code Integration

### Commands (Command Palette)
| Command | Description |
|---------|-------------|
| `sigscan.scanProject` | Scan project for signatures |
| `sigscan.exportSignatures` | Export to files |
| `sigscan.estimateGas` | Show gas report |
| `sigscan.generateABI` | Generate ABI JSON |
| `sigscan.checkContractSize` | Check 24KB limit |
| `sigscan.toggleRealtimeAnalysis` | Enable/disable inline gas |

### Inline Decorations
```
function transfer(address to, uint256 amount) external returns (bool) { ⛽ 51.2k gas | 0xa9059cbb
```

- **Green**: < 50,000 gas (low complexity)
- **Yellow**: 50,000 - 150,000 gas (medium)
- **Orange**: 150,000 - 500,000 gas (high)
- **Red**: > 500,000 gas (very high)
- **Gray**: N/A (compilation failed, selector-only)

### Hover Information
```markdown
### ⛽ Gas Analysis: `transfer`

**Estimated Gas:** 51,234
**Complexity:** 🟢 Low
**Selector:** `0xa9059cbb`
**Visibility:** external | **Mutability:** nonpayable
```

---

## CLI Usage

```bash
# Install globally
npm install -g sigscan

# Scan current directory
sigscan

# Scan specific path with options
sigscan ./contracts --format json,txt --watch

# Options:
#   --format    Output formats (json, txt, csv, md)
#   --output    Output directory
#   --watch     Watch for changes
#   --internal  Include internal functions
#   --private   Include private functions
```

---

## Performance Optimizations

1. **Content-Hash Caching**: SHA-256 hash of source code as cache key
2. **Debounced Compilation**: 300ms delay prevents rapid recompilation
3. **Lazy Compiler Loading**: Only downloads solc versions when needed
4. **Resource Monitoring**: Extended analysis only runs when CPU < 50%, Memory < 500MB
5. **Background Processing**: Heavy operations never block UI

---

## Error Handling & Fallbacks

| Scenario | Behavior |
|----------|----------|
| Missing imports | Regex fallback extracts selectors, gas shows "N/A" |
| Syntax errors | Same as above |
| Solc unavailable | Uses bundled 0.8.x version |
| Network offline | Uses hardcoded version list |
| Memory pressure | Skips extended analysis |

---

## Testing

```bash
# Run all tests
pnpm test

# Test coverage
pnpm test --coverage

# Specific test file
pnpm test -- --testPathPattern="parser"
```

**Test Files**:
- `parser.test.ts` - Signature extraction
- `scanner.test.ts` - Project discovery
- `gas.test.ts` - Gas estimation
- `solc-integration.test.ts` - Compiler integration
- `helpers.test.ts` - Utility functions

---

## Build & Package

```bash
# Install dependencies
pnpm install

# Compile TypeScript
pnpm run compile

# Package extension (.vsix)
pnpm run package

# Publish to marketplace
pnpm run publish
```

---

## Key Files Summary

| File | Purpose |
|------|---------|
| `extension.ts` | VS Code activation, event handlers |
| `SolcManager.ts` | Compiler loading, version management |
| `compilation-service.ts` | Debounced compilation orchestration |
| `realtime.ts` | Live analysis engine |
| `parser.ts` | Regex-based Solidity parsing |
| `scanner.ts` | Project/file discovery |
| `gas.ts` | Gas estimation logic |
| `helpers.ts` | keccak256, type normalization |

---

## Recent Enhancement: Compilation Fallback

**Problem**: When contracts have import errors, no selectors were shown.

**Solution**: Added `extractFunctionsWithRegex()` in SolcManager.ts that:
1. Uses regex to parse function declarations (no compilation needed)
2. Computes correct selectors using keccak256
3. Returns gasInfo with `gas: 0` and warning about compilation failure
4. UI shows selectors in gray with "N/A" for gas

This ensures **selectors are always available** regardless of compilation status.
