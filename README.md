# SigScan - Smart Contract Signature Scanner

[![Version](https://img.shields.io/visual-studio-marketplace/v/0xshubhs.sigscan?style=flat-square)](https://marketplace.visualstudio.com/items?itemName=0xshubhs.sigscan)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/0xshubhs.sigscan?style=flat-square)](https://marketplace.visualstudio.com/items?itemName=0xshubhs.sigscan)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/0xshubhs.sigscan?style=flat-square)](https://marketplace.visualstudio.com/items?itemName=0xshubhs.sigscan)
[![Build Status](https://img.shields.io/github/actions/workflow/status/0xshubhs/sigScan/pr-validation.yml?branch=main&style=flat-square)](https://github.com/0xshubhs/sigScan/actions)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)

A professional VS Code extension and CLI tool for automatically scanning and generating method signatures from Solidity smart contracts in Foundry and Hardhat projects.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
  - [VS Code Extension](#vs-code-extension)
  - [Command Line Interface](#command-line-interface)
- [Output Structure](#output-structure)
- [Configuration](#configuration)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Overview

SigScan is a developer tool designed to streamline smart contract development by automatically extracting and organizing function signatures, events, and custom errors from Solidity contracts. It supports both Foundry and Hardhat project structures and provides organized output that can be used for testing, documentation, and contract interaction.

## Features

### Core Functionality

- **Automatic Contract Detection**: Recursively scans your project for Solidity files
- **Intelligent Categorization**: Separates contracts, libraries, and tests automatically
- **Signature Extraction**: Extracts function selectors, event signatures, and error signatures
- **Multiple Export Formats**: Generates both JSON and TXT format outputs
- **Deduplication**: Eliminates duplicate signatures across your codebase
- **Project-Aware**: Creates output in the correct project root directory

### Developer Experience

- **File Watching**: Automatically regenerates signatures when contracts change
- **Tree View Integration**: Browse signatures directly in VS Code sidebar
- **Command Palette**: Quick access to scanning and export functions
- **CLI Support**: Integrate into build scripts and CI/CD pipelines
- **Configurable Filtering**: Control visibility levels (public, external, internal, private)
- **Lightweight**: Optimized package size of approximately 140KB

### Supported Project Types

- Foundry projects (foundry.toml)
- Hardhat projects (hardhat.config.js/ts)
- Mixed and monorepo structures

## Installation

### From VS Code Marketplace

1. Open Visual Studio Code
2. Press `Ctrl+P` (Windows/Linux) or `Cmd+P` (macOS)
3. Type: `ext install 0xshubhs.sigscan`
4. Press Enter

### From VSIX File

```bash
code --install-extension sigscan-0.3.0.vsix
```

### Command Line Installation

```bash
# Install globally via npm
npm install -g sigscan

# Or use directly with npx
npx sigscan scan ./my-project
```

## Usage

### VS Code Extension

#### Quick Start

1. Open a Foundry or Hardhat project in VS Code
2. Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (macOS)
3. Type "SigScan: Scan Project"
4. Signatures will be generated in `<project-root>/signatures/`

#### Available Commands

- **SigScan: Scan Project** - Scan all contracts in the current project
- **SigScan: Export Signatures** - Export signatures to specific format
- **SigScan: Toggle Watch Mode** - Enable/disable automatic rescanning
- **SigScan: Clear Signatures** - Remove generated signature files

#### Tree View

Access the SigScan sidebar to:
- Browse contracts by category (contracts, libraries, tests)
- View function signatures and selectors
- Copy selectors to clipboard
- Navigate to contract definitions

### Command Line Interface

#### Basic Usage

```bash
# Scan current directory
sigscan scan

# Scan specific project
sigscan scan /path/to/project

# Watch mode for continuous scanning
sigscan watch /path/to/project

# Export to specific format
sigscan export --format json /path/to/project
sigscan export --format txt /path/to/project
```

#### CLI Options

```
Options:
  -o, --output <path>         Output directory (default: ./signatures)
  -f, --format <type>         Export format: json, txt, or both (default: both)
  -w, --watch                 Watch mode for automatic rescanning
  -i, --include-internal      Include internal functions
  -p, --include-private       Include private functions
  --no-dedupe                 Disable signature deduplication
  -v, --verbose               Verbose logging
  -h, --help                  Display help information
```

#### Integration Examples

**Package.json Script:**
```json
{
  "scripts": {
    "signatures": "sigscan scan",
    "signatures:watch": "sigscan watch"
  }
}
```

**CI/CD Pipeline:**
```yaml
- name: Generate Signatures
  run: npx sigscan scan --format json
  
- name: Upload Signatures
  uses: actions/upload-artifact@v3
  with:
    name: contract-signatures
    path: signatures/
```

## Output Structure

SigScan generates organized signature files in your project's `signatures/` directory:

```
signatures/
├── signatures_2025-11-30T12-00-00.json
├── signatures_2025-11-30T12-00-00.txt
└── signatures-contracts.json (latest symlink)
```

## Example Projects

The `examples/` directory contains complete sample projects demonstrating best practices and folder structure conventions with production-grade contracts:

### Foundry Projects

**foundry-defi/** - DeFi Protocol Example
```
foundry-defi/
├── foundry.toml
├── src/
│   ├── LiquidityPool.sol      # AMM liquidity pool implementation
│   └── StakingRewards.sol     # Token staking with rewards
├── lib/
│   └── SafeMath.sol            # Math utility library
├── test/
│   └── LiquidityPool.t.sol    # Contract tests
└── signatures/
    ├── signatures_2025-11-30T12-00-00.json
    └── signatures_2025-11-30T12-00-00.txt
```

Features demonstrated:
- AMM liquidity pool with swap functionality
- Staking rewards distribution system
- Library usage and organization
- Comprehensive function signatures
- Event and error definitions

**foundry-dao/** - Advanced DAO Governance System
```
foundry-dao/
├── foundry.toml
├── src/
│   ├── GovernanceToken.sol     # ERC20 with delegation & checkpoints
│   ├── GovernorAlpha.sol       # On-chain governance
│   ├── Timelock.sol            # Delayed execution
│   └── Treasury.sol            # DAO fund management
├── test/
│   └── Governance.t.sol        # Governance tests
└── signatures/
    ├── signatures_2025-11-30T16-00-00.json
    └── signatures_2025-11-30T16-00-00.txt
```

Features demonstrated:
- Vote delegation with checkpoint system
- Proposal lifecycle management (propose, vote, queue, execute)
- Binary search for historical vote queries
- EIP-712 signature support for gasless voting
- Timelock with grace period and delay controls
- Treasury with budget management and spending proposals
- Complex state machine patterns
- Advanced access control and security mechanisms

### Hardhat Projects

**hardhat-nft/** - NFT Marketplace Example
```
hardhat-nft/
├── hardhat.config.js
├── contracts/
│   ├── ERC721A.sol             # Optimized NFT implementation
│   └── NFTMarketplace.sol      # Marketplace with auctions
├── test/
│   └── ERC721A.test.js         # Contract tests
└── signatures/
    ├── signatures_2025-11-30T14-30-00.json
    └── signatures_2025-11-30T14-30-00.txt
```

Features demonstrated:
- ERC721A batch minting optimization
- NFT marketplace with listing and auction support
- Complex contract interactions
- Structured event emissions
- Custom error handling

**hardhat-marketplace/** - Advanced Trading Platform
```
hardhat-marketplace/
├── hardhat.config.js
├── contracts/
│   ├── OrderBook.sol           # Decentralized order book exchange
│   └── LendingPool.sol         # Variable rate lending protocol
├── test/
│   └── OrderBook.test.js       # Exchange tests
└── signatures/
    ├── signatures_2025-11-30T18-00-00.json
    └── signatures_2025-11-30T18-00-00.txt
```

Features demonstrated:
- Limit and market order matching engine
- Order book depth and best bid/ask queries
- Variable interest rate calculations
- Utilization-based rate curves
- Liquidation mechanism for undercollateralized positions
- Health factor calculations
- Fee collection and distribution
- Complex state management with multiple data structures

**hardhat-bridge/** - Cross-Chain Bridge Infrastructure
```
hardhat-bridge/
├── hardhat.config.js
├── contracts/
│   ├── CrossChainBridge.sol    # Multi-sig bridge with validation
│   └── RelayerNetwork.sol      # Decentralized relayer system
├── test/
│   └── Bridge.test.js          # Bridge tests
└── signatures/
    ├── signatures_2025-11-30T19-00-00.json
    └── signatures_2025-11-30T19-00-00.txt
```

Features demonstrated:
- Multi-signature validation with weighted voting
- Validator network with reputation system
- Transfer lifecycle management (pending, validated, completed)
- Timeout and cancellation mechanisms
- Relayer staking and slashing
- Message delivery with cryptographic proofs
- Cross-chain communication patterns
- Dispute resolution system
- Dynamic threshold calculations

### Running Examples

```bash
# Scan the DeFi example
cd examples/foundry-defi
sigscan scan

# Scan the DAO governance example
cd examples/foundry-dao
sigscan scan

# Scan the NFT marketplace example
cd examples/hardhat-nft
sigscan scan

# Scan the trading platform example
cd examples/hardhat-marketplace
sigscan scan

# Scan the bridge example
cd examples/hardhat-bridge
sigscan scan

# Watch mode for development
sigscan watch
```

### JSON Format

```json
{
  "metadata": {
    "generatedAt": "2025-11-30T12:00:00.000Z",
    "projectType": "foundry",
    "totalContracts": 5,
    "totalFunctions": 25,
    "totalEvents": 8,
    "totalErrors": 3
  },
  "contracts": {
    "SimpleToken": {
      "path": "src/SimpleToken.sol",
      "category": "contracts",
      "functions": [
        {
          "name": "transfer",
          "signature": "transfer(address,uint256)",
          "selector": "0xa9059cbb",
          "visibility": "public"
        }
      ],
      "events": [
        {
          "name": "Transfer",
          "signature": "Transfer(address,address,uint256)",
          "hash": "0xddf252ad..."
        }
      ]
    }
  }
}
```

### TXT Format

```
# Contract Signatures
# Generated: 2025-11-30T12:00:00.000Z

## SimpleToken (src/SimpleToken.sol)

### Functions
transfer(address,uint256) -> 0xa9059cbb
approve(address,uint256) -> 0x095ea7b3
balanceOf(address) -> 0x70a08231

### Events
Transfer(address,address,uint256) -> 0xddf252ad...
Approval(address,address,uint256) -> 0x8c5be1e5...
```

## Configuration

### VS Code Settings

Configure SigScan through VS Code settings (File > Preferences > Settings):

```json
{
  "sigscan.autoScan": true,
  "sigscan.watchMode": false,
  "sigscan.includeInternal": false,
  "sigscan.includePrivate": false,
  "sigscan.outputFormat": "both",
  "sigscan.deduplicate": true,
  "sigscan.excludePaths": ["node_modules", "lib"]
}
```

### Configuration File

Create a `.sigscanrc.json` in your project root:

```json
{
  "includeInternal": false,
  "includePrivate": false,
  "outputFormat": "both",
  "deduplicate": true,
  "excludePaths": [
    "node_modules",
    "lib",
    "cache"
  ]
}
```

## Development

### Building from Source

```bash
# Clone the repository
git clone https://github.com/0xshubhs/sigScan.git
cd sigScan

# Install dependencies
npm install

# Build the extension
npm run compile

# Run tests
npm test

# Package the extension
npm run package
```

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

### Project Structure

```
sigScan/
├── src/
│   ├── cli/              # Command-line interface
│   ├── core/             # Core scanning logic
│   │   ├── parser.ts     # Solidity parser
│   │   ├── scanner.ts    # Project scanner
│   │   ├── exporter.ts   # Signature exporter
│   │   └── watcher.ts    # File watcher
│   ├── extension/        # VS Code extension
│   │   ├── extension.ts  # Extension entry point
│   │   ├── manager.ts    # Scan manager
│   │   └── providers/    # Tree view providers
│   └── utils/            # Utility functions
├── .github/
│   └── workflows/        # CI/CD workflows
├── test/                 # Test files
└── docs/                 # Documentation
```

## Contributing

Contributions are welcome! Please follow these guidelines:

1. **Fork the repository** and create a feature branch
2. **Follow the existing code style** (enforced by ESLint and Prettier)
3. **Write tests** for new features
4. **Update documentation** as needed
5. **Submit a pull request** with a clear description

### Development Guidelines

- Use TypeScript for all new code
- Follow conventional commit messages (feat, fix, docs, etc.)
- Ensure all tests pass before submitting PR
- Add unit tests for new functionality
- Update README for user-facing changes

### Reporting Issues

When reporting issues, please include:
- VS Code version
- Extension version
- Project type (Foundry/Hardhat)
- Steps to reproduce
- Expected vs actual behavior
- Relevant error messages or logs

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built with the VS Code Extension API
- Solidity parsing powered by regular expressions and AST analysis
- Inspired by tools like Foundry's `forge` and Hardhat's contract interaction utilities

## Links

- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=0xshubhs.sigscan)
- [GitHub Repository](https://github.com/0xshubhs/sigScan)
- [Issue Tracker](https://github.com/0xshubhs/sigScan/issues)
- [Changelog](https://github.com/0xshubhs/sigScan/releases)

---

**Maintained by**: [0xshubhs](https://github.com/0xshubhs)  
**Version**: 0.3.0  
**Last Updated**: November 2025
