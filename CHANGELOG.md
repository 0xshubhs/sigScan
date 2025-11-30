# Changelog

All notable changes to the SigScan extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2025-11-30

### ✨ Features
- **Project-specific signatures folder**: Signatures now created in the actual project directory (where foundry.toml or hardhat.config.js exists) instead of workspace root
- **Smart folder creation**: Only creates signatures/ folder when Solidity files are present in the project
- **Complete tooling setup**: Added Husky, lint-staged, Prettier, CommitLint for code quality
- **Testing infrastructure**: Jest setup with unit tests for core modules
- **Coverage reporting**: Automated code coverage with configurable thresholds

### 🐛 Bug Fixes
- Fixed signatures folder placement to respect project boundaries
- Improved Solidity file detection before folder creation

### 📚 Documentation
- Added comprehensive GitHub workflows for CI/CD
- Created PR validation and automated release workflows
- Configured Dependabot for security updates

### 🏗️ Build System
- **Package size optimization**: Reduced extension size by 98% (from 6.77MB to 135KB)
- Added .vscodeignore to exclude unnecessary files
- Configured webpack to exclude test files from bundle

### 🔧 Chores
- Added pre-commit hooks for linting and formatting
- Configured conventional commits enforcement
- Added standard-version for automated changelog generation

## [0.2.1] - 2025-11-30

### 🐛 Bug Fixes
- Enhanced validation to only create signatures folder when Solidity files exist

## [0.2.0] - 2025-11-30

### ✨ Features
- **Enhanced signature organization**: Separate files for contracts, libraries, and tests
- **Signature deduplication**: Eliminates duplicate signatures across files
- **Contract-wise organization**: Groups signatures by contract while maintaining deduplication
- **File watching improvements**: Better change detection and auto-export
- **Update existing files**: No more timestamped files, updates signatures in place
- **Enhanced library filtering**: Only includes signatures from contracts actually imported from lib/
- **Automatic .gitignore management**: Automatically adds signatures/ to .gitignore

### ♻️ Code Refactoring
- Complete rewrite of exporter with category separation
- Improved scanner with library detection
- Enhanced CLI and extension integration

## [0.1.0] - Initial Release

### ✨ Features
- Automatic Solidity contract scanning for Foundry and Hardhat projects
- Function signature generation with selectors
- Event signature generation
- Custom error signature support
- Multiple export formats (JSON, TXT)
- File watching for automatic updates
- VS Code extension with commands and tree view
- CLI tool for CI/CD integration
- Support for visibility filtering (public, external, internal, private)

[0.3.0]: https://github.com/DevJSter/sigScan/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/DevJSter/sigScan/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/DevJSter/sigScan/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/DevJSter/sigScan/releases/tag/v0.1.0
