# SigScan — Features, Optimizations & Roadmap

## What's Been Built

### Core Engine (Fully Implemented)

**Signature Extraction** — The heart of SigScan. Parses any `.sol` file and extracts:
- Function selectors (4-byte keccak256)
- Event topics (32-byte keccak256)
- Error selectors
- Constructor signatures
- Modifier signatures

Works entirely via regex — no AST dependency, no compilation required. Selectors are always available even when the contract has import errors or syntax issues.

**Three-Tier Gas Backend** — A priority chain that picks the most accurate available source:

| Backend | How it works | Accuracy | Speed |
|---------|-------------|----------|-------|
| **Rust Runner (revm)** | Compiles via forge, deploys in-memory EVM, executes every function | Real execution gas | ~2-5s |
| **Forge** | `forge build` output, reads gas estimates from artifacts | Compiler estimates | ~3-8s |
| **Solc-JS (WASM)** | Bundled compiler, no external tooling needed | Compiler estimates | ~5-15s |

If all three fail, the regex fallback still gives you selectors with "N/A" for gas.

**Smart Argument Generation** (Rust runner) — The runner doesn't just call functions with zeros. It tries three strategies in order:
1. **SmartDefaults** — type-aware values (1 for uint, caller address for address params, etc.)
2. **CallerAddress** — uses the caller's own address for address params
3. **ZeroDefaults** — all-zero calldata

Early-exits on the first strategy that doesn't revert. Same retry logic applies to constructor deployment.

**Project Discovery** — Auto-detects your project type:
- `foundry.toml` present → Foundry (scans `src/`, `lib/`)
- `hardhat.config.js/ts` present → Hardhat (scans `contracts/`)
- Neither → Generic recursive `.sol` scan

### VS Code Extension (Fully Implemented)

**Inline Gas Decorations** — Remix-style annotations on every function:
```
function transfer(address to, uint256 amount) external returns (bool) {  // 51.2k gas | 0xa9059cbb
```
Color-coded by cost: green (<50k) → yellow (<150k) → orange (<500k) → red (>500k) → gray (N/A).

**Contract Size Validation** — Inline error when contracts exceed the 24KB EIP-170 limit:
```
contract Large {  // ⚠️ Contract size: 24.8 KB (exceeds 24 KB limit)
```
Displayed with a warning indicator whenever bytecode size is calculated, helping catch deployment failures early.

**17 Commands** available via Command Palette:
- Scan project, export signatures, generate ABI
- Gas estimation, contract size check, complexity analysis
- Storage layout, call graph, deployment cost
- Gas regression tracking (git-aware branch comparison)
- Runtime profiler (reads forge test output)
- Etherscan verification (partial)

**Sidebar Tree View** — Browse all contracts and their signatures in the Explorer panel.

**Real-time Analysis** — Two-phase approach:
1. Immediate: parse signatures on file open (instant)
2. Background: run solc/runner after idle period (configurable, default 10s)

Extended analysis (storage layout, call graph, deployment cost) runs only when system resources allow (CPU <50%, Memory <500MB).

### CLI Tool (Fully Implemented)

```bash
sigscan ./contracts --format json,txt,csv,md --watch
```

Standalone tool. Scans directories, exports in 4 formats (JSON, TXT, CSV, Markdown), optional file watching.

### Analysis Modules (All Fully Implemented)

| Module | What it does |
|--------|-------------|
| `gas.ts` | Solc-based gas estimation with source location mapping |
| `storage-layout.ts` | Storage slot visualization, packing analysis, wasted-space detection |
| `call-graph.ts` | Function dependency graph within and across contracts |
| `deployment.ts` | Deployment cost estimation (bytecode size + constructor gas) |
| `complexity.ts` | Cyclomatic and cognitive complexity metrics per function |
| `size.ts` | Contract bytecode size vs. 24KB EIP-170 limit 
| `regression.ts` | Gas diff between current code and a git branch |
| `profiler.ts` | Runtime profile from forge test output |
| `abi.ts` | Standard Ethereum ABI JSON generation |
| `database.ts` | Lookup against known signature database |
| `verify.ts` | Etherscan verification (API structure defined, network calls are stubs) |

---

## How to Make It More Lightweight

### 1. Drop `solc` from bundled dependencies

**Impact: ~100-120MB saved from node_modules**

`solc` (the WASM compiler) is the heaviest dependency by far. Since the Rust runner and forge backend are both more accurate, `solc` is effectively a third-choice fallback. Options:

- **Lazy-download solc on first use** instead of bundling it. Download the specific version needed based on pragma, cache it locally. The `solc-version-manager.ts` already has this logic — just needs to be the default path instead of npm-installed solc.
- **Make solc an optional peer dependency** — users who want it can install it, but it doesn't ship with the extension.
- **Use native solc binary** if available on PATH before falling back to WASM. Native solc is 10x faster than WASM.

### 2. Replace `glob` and `chokidar` with built-in alternatives

**Impact: ~5-10MB saved, fewer transitive deps**

- `glob` → Use `vscode.workspace.findFiles()` in the extension context (already available). For CLI, Node 22+ has `fs.glob()` built-in, or use a lighter alternative like `fast-glob` (smaller tree).
- `chokidar` → Use `vscode.workspace.createFileSystemWatcher()` in VS Code context. Only need chokidar for the CLI watcher.

### 3. Split `realtime.ts`

**Impact: Better tree-shaking, faster activation**

At 1,385 LOC, `realtime.ts` is the largest file and does too much: analysis orchestration, decoration management, caching, resource monitoring, and extended analysis coordination. Split into:
- `analysis-engine.ts` — core orchestration
- `decoration-manager.ts` — VS Code decoration lifecycle
- `resource-monitor.ts` — CPU/memory gating

Webpack can then tree-shake unused paths in CLI builds.

### 4. Remove legacy `solc-integration.ts`

**Impact: ~632 LOC dead code removed**

This file is superseded by `SolcManager.ts`. It's still in the codebase but no longer the active compilation path. Safe to delete.

### 5. Lazy-load analysis modules

**Current state**: Extended analyzers (storage, call-graph, deployment, regression, profiler) are imported but only used on-demand.

**Improvement**: Use dynamic `import()` so webpack can code-split them into separate chunks. Users who never run "Show Storage Layout" never pay the parse cost for `storage-layout.ts`.

### 6. Cache compiled runner binary

The Rust runner binary is ~5MB. Ship a prebuilt binary for common platforms (macOS arm64, macOS x64, Linux x64) so users don't need a Rust toolchain. Use a postinstall script or VS Code extension binary publishing.

---

## What Else Can Be Added

### High Value / Low Effort

**1. Selector Collision Detection**
Scan all contracts in a project and flag any two functions that share the same 4-byte selector. This is a real security concern (proxy contracts, diamond pattern). The parser already extracts all selectors — just need a Map check.

**2. Natspec / Documentation Extraction**
Parse `@notice`, `@param`, `@dev` comments above functions and include them in exports. Useful for ABI + docs generation. Regex-based, same approach as current parser.

**3. Interface Compliance Check**
Given a contract, check if it fully implements a known interface (ERC20, ERC721, ERC1155, ERC4626). Compare extracted selectors against known interface selector sets. The `signatures.json` database already exists — extend it with interface definitions.

**4. Copy Selector to Clipboard**
Right-click a function in the tree view or inline decoration → copy its selector. Simple UX win.

**5. Diff View for Gas Changes**
When `regression.ts` finds gas changes between branches, open a VS Code diff view highlighting the affected functions. Currently it outputs a text report — a visual diff would be much more useful.

### Medium Value / Medium Effort

**6. Foundry Test Coverage Integration**
Read `forge coverage` output and overlay coverage data on source files. Show which functions have test coverage and which don't. Complements the existing profiler module.

**7. Upgrade Path Analyzer**
For upgradeable contracts (UUPS, Transparent Proxy), compare storage layouts between two versions and flag any slot collisions or ordering changes. The `storage-layout.ts` module already computes slots — just need a comparison mode.

**8. Gas Optimization Suggestions**
After analyzing gas, suggest common optimizations:
- `memory` → `calldata` for external function params
- Tight variable packing in structs
- `unchecked` blocks for safe arithmetic
- `immutable` / `constant` for state variables set once
- Custom errors vs require strings

Pattern-match on the source + gas data. No need for full static analysis.

**9. Event Indexing Warnings**
Flag events with >3 indexed parameters (invalid) or suggest adding `indexed` to commonly-filtered fields like addresses. Simple regex check.

**10. Inline Selector Lookup**
Hover over a raw selector (e.g., `0xa9059cbb` in calldata or test files) and show the resolved function name. Reverse-lookup from the known database + project-scanned selectors.

### High Value / High Effort

**11. Cross-Contract Call Tracing**
Extend the call graph to trace calls across contract boundaries. When contract A calls `B.transfer()`, link them. Requires resolving import paths and matching selectors across compiled artifacts.

**12. Invariant Detection**
Static analysis to detect likely invariants (total supply == sum of balances, owner != address(0)). Mark functions that could violate them. Research-grade feature but extremely valuable for auditing.

**13. MEV / Front-running Analysis**
Flag functions that are susceptible to front-running: state-dependent return values, sandwich-attackable swaps, unprotected price oracles. Pattern-based detection on function signatures + state mutability.

**14. Gas Snapshot CI Integration**
Export gas snapshots as JSON, compare in CI (GitHub Actions). Fail PR if any function's gas increases beyond a threshold. The `regression.ts` module has the comparison logic — needs a CI-friendly output mode and a GitHub Action wrapper.

**15. Multi-chain Gas Pricing**
Show gas costs in USD/ETH for different chains (Ethereum mainnet, Arbitrum, Optimism, Base, Polygon). Fetch current gas prices from public RPC endpoints. Display alongside raw gas units.

### Nice-to-Have

**16. Function Signature Search (4byte.directory)**
Integrate with the public 4byte.directory API. Look up unknown selectors encountered in transaction data.

**17. Contract Interaction Playground**
A webview panel where you can call functions on a locally-deployed contract (revm). The Rust runner already does this — expose it with a UI.

**18. Solidity Metrics Dashboard**
A webview panel showing project-wide metrics: total functions, average complexity, gas distribution histogram, largest contracts, most complex functions.

**19. Export to Foundry Test Template**
Generate a basic Foundry test file from extracted signatures. Each public function gets a test stub with the correct selector and parameter types.

**20. VS Code Notebook Support**
Support `.sol` analysis in VS Code notebooks for interactive auditing workflows. Run analysis cells, see results inline.

---

## Current Stats

| Metric | Value |
|--------|-------|
| TypeScript source | ~13,400 LOC across 31 files |
| Rust runner | ~670 LOC across 5 files |
| Production deps | 6 (chokidar, commander, glob, js-sha3, semver, solc) |
| VS Code commands | 17 |
| Configuration options | 15 |
| Export formats | 4 (JSON, TXT, CSV, Markdown) |
| Example projects | 8 (4 Foundry + 4 Hardhat) |
| Test coverage | Core modules covered (parser, scanner, helpers) |

## What's NOT Done

| Item | Status | Notes |
|------|--------|-------|
| Etherscan verification | Stub | API class defined, no actual network calls |
| `solc-integration.ts` | Legacy | Superseded by SolcManager, can be removed |
| Rust runner tests | None | Tested manually, no cargo test suite |
| E2E extension tests | None | Only unit tests exist |
| CI/CD pipeline | None | No GitHub Actions configured |
| VSIX publishing | Manual | No automated marketplace publish |


