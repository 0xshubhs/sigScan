# SigScan VS Code Extension - Complete Guide

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Building from Source](#building-from-source)
- [Development Setup](#development-setup)
- [Features](#features)
- [Usage](#usage)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)

## Overview

SigScan is a VS Code extension that automatically scans Solidity smart contracts and generates function, event, and error signatures with their corresponding method hashes. It supports both Foundry and Hardhat projects with real-time file watching capabilities.

### Key Features

- 🔍 **Automatic Contract Detection**: Detects Foundry and Hardhat projects automatically
- 📝 **Signature Generation**: Creates function selectors, event topics, and error signatures
- 🔄 **Real-time Updates**: Watches for file changes and updates signatures automatically
- 📊 **Multiple Output Formats**: Supports TXT, JSON, CSV, and Markdown formats
- 🌲 **Tree View**: Interactive signature browser in VS Code sidebar
- 💡 **Hover Information**: Shows signature details when hovering over functions
- 📋 **Copy to Clipboard**: Quick copy functionality for signatures and selectors

## Installation

### Method 1: Install from VSIX Package

1. **Download the latest release** or build from source (see below)
2. **Install the extension**:
   ```bash
   code --install-extension sigscan-0.1.0.vsix
   ```

### Method 2: Install from VS Code Marketplace (Coming Soon)

1. Open VS Code
2. Go to Extensions (`Ctrl+Shift+X`)
3. Search for "SigScan"
4. Click Install

## Building from Source

### Prerequisites

- Node.js (≥16.0.0)
- npm or yarn
- VS Code Extension Manager (`vsce`)

### Build Steps

1. **Clone the repository**:
   ```bash
   git clone https://github.com/0xshubhs/sigScan.git
   cd sigScan
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Install VS Code Extension Manager**:
   ```bash
   npm install -g @vscode/vsce
   ```

4. **Build the project**:
   ```bash
   npm run compile
   ```

5. **Package the extension**:
   ```bash
   vsce package
   ```

6. **Install the packaged extension**:
   ```bash
   code --install-extension sigscan-0.1.0.vsix
   ```

### Build Scripts

- `npm run compile` - Build for production
- `npm run watch` - Build and watch for changes (development)
- `npm run dev` - Development build
- `npm run test` - Run tests
- `vsce package` - Create VSIX package

## Development Setup

### Running in Development Mode

1. **Open the project in VS Code**:
   ```bash
   code /path/to/sigScan
   ```

2. **Start development mode**:
   - Press `F5` or go to Run and Debug panel
   - Select "Run Extension" and click play button
   - This opens a new VS Code window with your extension loaded

3. **Make changes and test**:
   - Edit source files in `src/extension/`
   - Changes are automatically reloaded in the extension host window

### Project Structure

```
src/
├── extension/
│   ├── extension.ts          # Main extension entry point
│   ├── manager.ts           # Extension manager and core logic
│   └── providers/
│       └── treeProvider.ts  # Tree view provider
├── core/
│   ├── scanner.ts           # Contract scanning logic
│   ├── parser.ts           # Solidity parsing
│   ├── exporter.ts         # Signature file generation
│   └── watcher.ts          # File watching functionality
├── cli/
│   └── index.ts            # CLI interface
└── utils/
    └── helpers.ts          # Utility functions
```

## Features

### Automatic File Watching

The extension automatically:
- Monitors all `.sol` files in `src/` and `contracts/` directories
- Detects file changes, additions, and deletions
- Re-parses contracts and updates signatures in real-time
- Shows notifications when contracts are updated

### Signature Generation

Generates comprehensive signatures for:
- **Functions**: All visibility levels (public, external, internal, private)
- **Events**: Including indexed parameters and event topics
- **Errors**: Custom error types with selectors
- **Constructors**: Contract initialization functions

### Output Formats

Supports multiple export formats:

#### TXT Format
```
# Smart Contract Signatures
# Generated: 2025-08-08T[timestamp]

## Contract: SimpleToken (SimpleToken.sol)

### Functions:
transfer(address,uint256)                --> 0xa9059cbb
approve(address,uint256)                 --> 0x095ea7b3
```

#### JSON Format
```json
{
  "metadata": {
    "generated": "2025-08-08T[timestamp]",
    "projectType": "foundry",
    "totalContracts": 2
  },
  "contracts": {
    "SimpleToken": {
      "functions": [
        {
          "name": "transfer",
          "signature": "transfer(address,uint256)",
          "selector": "0xa9059cbb"
        }
      ]
    }
  }
}
```

## Usage

### Basic Workflow

1. **Open your Solidity project** in VS Code
2. **The extension activates automatically** when it detects `.sol` files
3. **Run initial scan**:
   - Press `Ctrl+Shift+P`
   - Type "SigScan: Scan Project for Signatures"
   - Press Enter

4. **Signature files are created** in `signatures/` folder:
   - `signatures_[timestamp].txt`
   - `signatures_[timestamp].json`

### Available Commands

Access these via Command Palette (`Ctrl+Shift+P`):

- **SigScan: Scan Project for Signatures** - Initial scan and auto-watch
- **SigScan: Start Watching for Changes** - Enable file monitoring
- **SigScan: Stop Watching for Changes** - Disable file monitoring
- **SigScan: Export Signatures** - Manual export to files
- **SigScan: Refresh Signatures** - Re-scan all contracts

### Tree View

The extension adds a "SigScan Explorer" panel to the VS Code sidebar:
- Browse contracts and their signatures
- Click to copy signatures or selectors
- Expand/collapse contract sections
- Real-time updates when files change

### Hover Information

When hovering over function names in `.sol` files:
- Shows function signature and selector
- Displays multiple overloads if available
- Quick copy functionality

## Configuration

Configure the extension in VS Code settings (`Ctrl+,`):

### Settings Reference

```json
{
  "sigscan.autoScan": {
    "type": "boolean",
    "default": true,
    "description": "Automatically scan when extension activates"
  },
  "sigscan.outputFormats": {
    "type": "array",
    "default": ["txt", "json"],
    "description": "Output formats to generate",
    "items": {
      "enum": ["txt", "json", "csv", "md"]
    }
  },
  "sigscan.excludeInternal": {
    "type": "boolean",
    "default": true,
    "description": "Exclude internal functions from output"
  },
  "sigscan.includePrivate": {
    "type": "boolean",
    "default": false,
    "description": "Include private functions in output"
  },
  "sigscan.contractDirs": {
    "type": "array",
    "default": ["src", "contracts"],
    "description": "Directories to scan for contracts"
  }
}
```

### Example Configuration

```json
{
  "sigscan.autoScan": true,
  "sigscan.outputFormats": ["txt", "json", "csv", "md"],
  "sigscan.excludeInternal": false,
  "sigscan.includePrivate": true,
  "sigscan.contractDirs": ["src", "contracts", "lib"]
}
```

## Troubleshooting

### Common Issues

#### Extension Not Activating

**Problem**: Extension doesn't activate when opening a Solidity project.

**Solution**:
- Ensure your workspace contains `.sol` files
- Check if `foundry.toml` or `hardhat.config.js` is present
- Reload VS Code window (`Ctrl+Shift+P` → "Developer: Reload Window")

#### No Signature Files Generated

**Problem**: Extension scans but doesn't create signature files.

**Solution**:
- Check VS Code output panel for errors
- Ensure workspace folder has write permissions
- Try manual export: `Ctrl+Shift+P` → "SigScan: Export Signatures"

#### File Watching Not Working

**Problem**: Changes to `.sol` files don't trigger updates.

**Solution**:
- Manually start watching: `Ctrl+Shift+P` → "SigScan: Start Watching for Changes"
- Check if `chokidar` is properly installed: `npm ls chokidar`
- Ensure file system supports file watching

#### Parsing Errors

**Problem**: Some contracts fail to parse correctly.

**Solution**:
- Check Solidity syntax in the problematic files
- Ensure contracts compile successfully with your build tool
- Report parsing issues with contract examples

### Debug Mode

Enable debug logging:

1. Open VS Code Developer Tools (`Help` → `Toggle Developer Tools`)
2. Check Console tab for SigScan debug messages
3. Look for parsing errors or file system issues

### Support

If you encounter issues:

1. **Check the logs** in VS Code Output panel
2. **Verify your setup** matches the requirements
3. **Report bugs** on the GitHub repository with:
   - VS Code version
   - Extension version
   - Sample contract that causes issues
   - Error messages from logs

## License

MIT License - see [LICENSE](../LICENSE) file for details.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.
