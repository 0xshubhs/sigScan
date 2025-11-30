# SigScan - Smart Contract Signature Scanner

[![Version](https://img.shields.io/visual-studio-marketplace/v/devjster.sigscan?style=flat-square)](https://marketplace.visualstudio.com/items?itemName=devjster.sigscan)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/devjster.sigscan?style=flat-square)](https://marketplace.visualstudio.com/items?itemName=devjster.sigscan)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/devjster.sigscan?style=flat-square)](https://marketplace.visualstudio.com/items?itemName=devjster.sigscan)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)

> Automatically scan and generate method signatures for Solidity smart contracts in Foundry and Hardhat projects.

## 🚀 Features

- **🔍 Smart Contract Scanning**: Automatically detects and scans Solidity contracts in your project
- **📁 Organized Output**: Separate signature files for contracts, libraries, and tests
- **🎯 Deduplication**: Eliminates duplicate signatures across your codebase
- **📊 Multiple Formats**: Export signatures in both JSON and TXT formats
- **👁️ File Watching**: Automatically updates signatures when contracts change
- **🏗️ Project-Aware**: Creates signatures folder in the correct project directory
- **⚡ Fast & Lightweight**: Only 135KB extension size, optimized for performance
- **🔧 Configurable**: Filter by visibility (public, external, internal, private)
- **🌳 Tree View**: Browse contract signatures directly in VS Code sidebar
- **💻 CLI Support**: Use in CI/CD pipelines and build scripts

## 📦 Installation

### From VS Code Marketplace

1. Open VS Code
2. Press \`Ctrl+P\` / \`Cmd+P\`
3. Type: \`ext install devjster.sigscan\`
4. Press Enter

### From VSIX File

\`\`\`bash
code --install-extension sigscan-0.3.0.vsix
\`\`\`

## 🎯 Usage

### VS Code Extension

#### Quick Start

1. Open a Foundry or Hardhat project
2. Press \`Ctrl+Shift+P\` / \`Cmd+Shift+P\`
3. Type "SigScan: Scan Project"
4. Signatures will be generated in \`<project-root>/signatures/\`

#### Available Commands

- **SigScan: Scan Project** - Scan all Solidity contracts
- **SigScan: Export Signatures** - Export signatures to files
- **SigScan: Start Watching** - Enable auto-update on file changes
- **SigScan: Stop Watching** - Disable file watching
- **SigScan: Refresh Signatures** - Refresh the signature tree view

### CLI Tool

\`\`\`bash
# Scan a project
sigscan scan /path/to/project --output ./signatures

# Watch for changes
sigscan watch /path/to/project --output ./signatures

# Specify formats
sigscan scan /path/to/project --output ./signatures --format json,txt
\`\`\`

## 📂 Output Structure

\`\`\`
your-project/
├── foundry.toml
├── src/
│   ├── Token.sol
│   └── NFT.sol
└── signatures/
    ├── signatures-contracts.json    # Contract signatures
    ├── signatures-contracts.txt
    ├── signatures-libs.json         # Library signatures
    ├── signatures-libs.txt
    ├── signatures-tests.json        # Test signatures
    └── signatures-tests.txt
\`\`\`

## 📋 Example Output

### Text Format (\`signatures-contracts.txt\`)

\`\`\`
# Smart Contract Signatures
# Category: CONTRACTS
# Generated: 2025-11-30T16:30:00.000Z

## Token

### Functions
transfer(address,uint256) -> 0xa9059cbb
approve(address,uint256) -> 0x095ea7b3
balanceOf(address) -> 0x70a08231

### Events
Transfer(address,address,uint256) -> 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
Approval(address,address,uint256) -> 0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925
\`\`\`

## ⚙️ Configuration

### VS Code Settings

\`\`\`json
{
  "sigscan.outputFormats": ["txt", "json"],
  "sigscan.excludeInternal": true,
  "sigscan.excludePrivate": true,
  "sigscan.autoExport": true
}
\`\`\`

## 🔧 Supported Projects

- ✅ **Foundry** - Full support
- ✅ **Hardhat** - Full support
- ✅ **Generic Solidity** - Basic support

## 🤝 Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](docs/CONTRIBUTING.md) for details.

## 📄 License

MIT © [DevJSter](https://github.com/DevJSter)

## 🐛 Issues & Support

Found a bug or have a feature request? [Open an issue](https://github.com/DevJSter/sigScan/issues)

---

**Built with ❤️ for the Solidity community**
