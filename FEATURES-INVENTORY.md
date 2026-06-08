# 0xTools — Feature Inventory & Implementation Status

> **Generated**: 2026-06-05  
> **Scale**: ~138 TS files, ~52k lines, 70+ feature modules  
> **Purpose**: Categorize every feature by implementation status to guide stabilization and UX surfacing.

---

## Legend

| Status | Meaning |
|--------|---------|
| ✅ **Complete** | Tested, working, ready for production |
| 🟡 **Functional but Unsursurfaced** | Works end-to-end but not exposed in the UI/UX |
| 🟡 **Needs UI Wiring** | Backend works; UI/panel integration is missing or incomplete |
| 🔴 **Partially Implemented** | Core logic exists but key pieces are stubs/TODOs |
| 🔴 **Truly Incomplete** | Stub, placeholder, or dead code path |

---

## 1. Core Engine

| Feature | Status | LOC | Notes |
|---------|--------|-----|-------|
| Scanner (contract discovery) | ✅ | 504 | Robust regex-based Solidity parser |
| Parser (function/event/error extraction) | ✅ | 722 | Full selector extraction |
| Cache (content-hash SHA-256) | ✅ | 84 | 5min TTL, content-addressed |
| Exporter (ABI/JSON) | ✅ | 845 | Full export pipeline |
| Watcher (file system) | ✅ | 124 | Chokidar-based real-time |
| SolcManager (compiler lifecycle) | ✅ | 1357 | Multi-version, pragma-aware |
| CompilationService (debounced) | ✅ | 686 | 300ms debounce, caching |
| FourByteLookup (selector cache) | ✅ | 285 | In-memory + disk cache |
| RPC Registry | ✅ | 211 | Multi-chain RPC discovery |
| ResourceMonitor | ✅ | 31 | CPU/memory gating (50% / 300MB) |
| Logger | ✅ | 78 | Structured logging |
| Helpers | ✅ | 111 | Utility functions |
| types.ts (shared interfaces) | ✅ | 244 | Core type definitions |
| deploy-run-protocol.ts (shared) | ✅ | 272 | Webview ↔ extension protocol |

---

## 2. Gas Analysis (The Core Differentiator)

| Feature | Status | LOC | Notes |
|---------|--------|-----|-------|
| **Three-Tier Compilation Backend** | ✅ | — | Rust runner → Forge → Solc-JS |
| Runner-Backend (Rust binary) | ✅ | 650 | Spawns sigscan-runner, parses JSON |
| Forge-Backend | ✅ | 452 | `forge build` integration |
| Solc-JS fallback | ✅ | (in SolcManager) | WASM compiler, universal fallback |
| Gas Decorations (inline) | ✅ | 447 | Real-time VS Code decorations |
| Gas Decorations Manager | ✅ | 567 | Decoration lifecycle |
| Gas (core estimation) | ✅ | 505 | Real gas via Rust runner |
| Gas Optimizer | ✅ | 543 | Static analysis for gas savings |
| Gas Pricing (eth/usd) | ✅ | 304 | Live gas price from RPC |
| Gas Snapshot | ✅ | 283 | Gas comparison over time |
| **Gas Regression Tracker** | 🔴 | 481 | ⚠️ `getOrFetchSnapshot()` returns **empty snapshot** for non-HEAD commits. `trackTrends()` returns `gas: 0` for all historical commits. The comparison logic works but has no real data source. |
| **Test Generator** | 🔴 | 413 | ⚠️ Generates test files with `// TODO: Add assertions` stubs. `/* TODO: provide valid X value */` in generated code. Functional as a test scaffolding tool but not production-ready assertions. |

---

## 3. Deploy & Run Dashboard

| Feature | Status | LOC | Notes |
|---------|--------|-----|-------|
| Deployer | ✅ | 315 | Contract deployment logic |
| Deployment (state management) | ✅ | 460 | Deployment state tracking |
| Anvil Manager | ✅ | 518 | Local node management |
| Script Runner | ✅ | 226 | Generic script execution |
| Script Discovery | ✅ | 173 | Discovers deploy/maint scripts |
| Forge Script Runner | ✅ | 471 | `forge script` wrapper with log parsing |
| Forge Test Runner (CodeLens) | ✅ | 283 | Inline "Run Test" buttons, pass/fail |
| Keystore Discovery | ✅ | 134 | Foundry keystores at `~/.foundry/keystores/` |
| **Build Pipeline** | ✅ | 164 | Triggers Foundry/Hardhat builds |
| **Build Diagnostics** | ✅ | 176 | Parses rich/legacy compiler output → diagnostics |
| **Deploy-Run Provider (VS Code tree)** | ✅ | 2825 | Large but functional dashboard panel |
| **Extension.ts (main)** | 🟡 | 2571 | ⚠️ **2,571 LOC god-object** — all commands wired here. Needs splitting. |
| Notebook Provider | ✅ | 729 | Interactive notebook for contracts |
| Playground | ✅ | 401 | Interactive contract playground |
| Dashboard Provider | ✅ | 471 | Sidebar dashboard |
| Selector Hover Provider | ✅ | 166 | Hover info for selectors |
| Findings Tree Provider | ✅ | 193 | Security findings tree view |
| Code Action Provider | ✅ | 337 | Quick fixes in editor |
| Tree Provider | ✅ | 226 | Base tree view |

---

## 4. Security Suite

| Feature | Status | LOC | Notes |
|---------|--------|-----|-------|
| Collision Detector | ✅ | 183 | 4-byte selector collision detection |
| Invariant Detector | ✅ | 593 | Reentrancy, access control, balance invariants |
| MEV Analyzer | ✅ | 588 | Sandwich, oracle manipulation, timestamp risks |
| Slither Integration | ✅ | 416 | CLI runner, JSON parsing, VS Code diagnostics |
| Mythril Integration | ✅ | 401 | CLI runner, JSON parsing, markdown reports |
| **Source Verifier** | ✅ | 231 | Etherscan verification via `forge verify-contract` |
| **Verify** (wrapper) | ✅ | 236 | Panel integration for verification |
| **Dangerous Patterns** | ✅ | 305 | Pattern matching for unsafe code |
| **Unchecked Calls** | ✅ | 217 | Detects unchecked external calls |
| **Reentrancy Detector** | ✅ | 481 | Reentrancy pattern detection |
| **Access Control Checker** | ✅ | 304 | Access control analysis |
| **Event Emission Checker** | ✅ | 154 | Detects state changes without events |
| **Natspec Checker** | ✅ | 168 | Missing @notice/@param/@return detection |
| **Interface Compliance** | ✅ | 231 | ERC20/721/1155/4626 implementation checker |
| **Storage Layout Analyzer** | ✅ | 471 | Storage slot analysis |
| **Call Graph** | ✅ | 520 | Function call graph analysis |
| **Complexity Analyzer** | ✅ | 278 | Cyclomatic complexity |
| **Size Analyzer** | ✅ | 214 | Contract size analysis |
| **Defi Risks** | ✅ | 503 | DeFi-specific risk patterns |
| **Address Inspector** | ✅ | 306 | Address analysis |
| **Upgrade Analyzer** | ✅ | 516 | Upgrade pattern detection |
| **Analysis Engine** | ✅ | 975 | Unified analysis orchestrator |
| Custom Error Suggestions | ✅ | 225 | Gas-saving custom error detection |
| Balance Cache | ✅ | 151 | Cached balance lookups |
| RPC Provider | ✅ | 491 | RPC abstraction layer |
| Snippet Provider | ✅ | 2019 | Solidity code snippets |

---

## 5. Integration Modules (External Tool Wrappers)

| Feature | Status | LOC | Notes |
|---------|--------|-----|-------|
| Tenderly Integration | ✅ | 849 | Transaction tracing/simulation via Tenderly API |
| Cast Integration | ✅ | 340 | Foundry cast commands |
| **Hardhat Integration** | ✅ | 667 | ⚠️ Full Hardhat project support (compile, test, deploy, verify, node). Works but depends on `hardhat` npm package. |
| Fork Simulator | ✅ | 819 | Fork-based simulation |
| **Remix Port** | 🟡 | 960 total | ⚠️ Standalone Remix-style transaction decoder. 4 files. Fully functional but **no VS Code integration** — it's a self-contained module. |

---

## 6. Stubbed / Truly Incomplete Features

These are the **actual incomplete features** — code paths that exist but are stubs, placeholders, or explicitly blocked:

### 🔴 `regression.ts` — Gas Regression Tracker (Partially Implemented)

| Issue | Details |
|-------|---------|
| Empty snapshot for non-HEAD commits | `getOrFetchSnapshot()` explicitly returns an **empty snapshot** with no gas data |
| `trackTrends()` returns `gas: 0` | Historical gas values are never computed — the git log parsing works but gas analysis per commit is a TODO |
| VS Code-dependent | Uses `vscode` types in a feature file that should be standalone |
| **Verdict**: Core comparison logic works, but the data pipeline is disconnected. Needs to actually analyze each commit's gas. |

### 🔴 `source-verifier.ts` — Hardhat Verification (Stubbed)

| Issue | Details |
|-------|---------|
| Hardhat verify blocked | Returns explicit error: `"Hardhat verify is not wired into the panel yet. Run \`npx hardhat verify --network <name> \` manually"` |
| Only Foundry supported | `projectType !== 'foundry'` returns failure with generic message |
| **Verdict**: Functional for Foundry projects only. The Hardhat path is an intentional stub with a clear user message. |

### ✅ Re-classified: `custom-error-suggestions.ts` — NOT Incomplete

The `return []` for pragma < 0.8.4 is a **correct guard clause**, not a stub. This module is complete and working.

### ✅ Re-classified: `hardhat-integration.ts` — Complete

This is fully implemented. The risk is external dependency stability (the `hardhat` npm package), not code quality.

### ✅ Re-classified: `database.ts` — Complete

Signature database with search, import/export, statistics — all working.

---

## 7. Remix Port (Standalone Module)

Located at `src/features/remix-port/`. Fully standalone with zero VS Code dependencies.

| File | LOC | Purpose |
|------|-----|---------|
| `tx-format.ts` | 525 | ABI-encoded transaction formatting |
| `events-decoder.ts` | 175 | Log/event decoding |
| `tx-helper.ts` | 199 | Transaction helper utilities |
| `index.ts` | 77 | Module entry point |
| `__tests__/` | ~530 | Comprehensive tests |

**Verdict**: ✅ Fully functional, zero coupling to VS Code. Easy to extract as a standalone npm package.

---

## 8. Summary Counts

| Category | Count | Files | Lines |
|----------|-------|-------|-------|
| ✅ Complete | ~55 | ~110 | ~45k |
| 🟡 Functional but Unsursurfaced | ~8 | ~15 | ~5k |
| 🔴 Partially Implemented | 2 | `regression.ts`, `test-generator.ts` | ~894 |
| 🔴 Stubbed (intentional) | 1 | `source-verifier.ts` (Hardhat path) | ~40 |
| **Total** | **~66** | **~138** | **~52k** |

---

## 9. What's Actually Broken vs. What's Just Unsursurfaced

### The Hard Truth: Only 2 Features Are Truly Incomplete

| Feature | Problem | Fix Effort |
|---------|---------|-----------|
| **regression.ts** | `getOrFetchSnapshot()` returns empty data for non-HEAD commits. `trackTrends()` returns `gas: 0`. The comparison engine works but has nothing to compare. | Medium — hook up actual gas analysis per commit |
| **test-generator.ts** | Test scaffolding works but assertions are `// TODO: Add assertions` stubs. Generated code won't run. | Medium — implement assertion generation |

### The Hard Truth: Hardhat Verification Stub is Intentional

The `source-verifier.ts` stub for Hardhat is **not a bug** — it's a deliberate decision with a clear user-facing message. The comment says: "Adding Hardhat support is straightforward but requires a hardhat-network-name → chainId mapping that's user-configured, so we punt for now."

### The Hard Truth: Remix Port is Complete but Isolated

The entire `remix-port/` directory is a fully functional transaction decoder with zero VS Code coupling. It just needs a VS Code integration layer (a command + output channel + hover provider).

---

## 10. Recommendations

### Priority 1: Ship 1.0 (Stabilize Core)

1. **Split `extension.ts`** (2,571 LOC → ~5-8 files)
2. **Split `deploy-run-provider.ts`** (2,825 LOC → ~3-4 files)
3. **Fix `regression.ts`** — hook up real gas analysis per commit
4. **Fix `test-generator.ts`** — implement assertion generation
5. **Wire up `remix-port`** — add a VS Code command + output channel

### Priority 2: Surface Existing Features (Zero Backend Work Needed)

The following features are **complete but not surfaced** in the UI:

| Feature | How to Surface |
|---------|----------------|
| Slither Integration | Add "Run Slither" command + diagnostics |
| Mythril Integration | Add "Run Mythril" command + markdown report |
| Tenderly Integration | Add "Simulate on Tenderly" hover/command |
| MEV Analyzer | Add to security dashboard panel |
| Collision Detector | Add to security dashboard panel |
| Invariant Detector | Add to security dashboard panel |
| Interface Compliance | Add to security dashboard panel |
| Gas Optimizer | Add to gas analysis panel |
| Storage Layout | Add to security dashboard panel |
| Call Graph | Add to security dashboard panel |
| Hardhat Integration | Surface commands for compile/test/deploy |
| Remix Port | Add "Decode Transaction" command |

**Total effort for Priority 2**: ~2-3 days of UI wiring. No new backend code needed.

### Priority 3: Startup Viability

The core is startup-worthy:
- ✅ Three-tier compilation (Rust → Forge → Solc-JS)
- ✅ Real gas numbers (not heuristic estimates)
- ✅ 25+ security analysis modules
- ✅ Deploy & Run dashboard
- ✅ Comprehensive test tooling

What's missing for startup:
- ❌ Clear monetization strategy
- ❌ Aggressive feature scope reduction (ship the core, not the museum)
- ❌ Integration with existing tools (Slither, Mythril, Tenderly) into a unified dashboard
- ❌ Telemetry to understand which features users actually need

---

## Appendix: File Map by Category

### Core (14 files)
`src/scanner.ts`, `src/parser.ts`, `src/cache.ts`, `src/exporter.ts`, `src/watcher.ts`, `src/features/SolcManager.ts`, `src/features/compilation-service.ts`, `src/features/four-byte-lookup.ts`, `src/features/rpc-registry.ts`, `src/features/resource-monitor.ts`, `src/features/logger.ts`, `src/features/helpers.ts`, `src/types.ts`, `src/features/deploy-run-protocol.ts`

### Gas Analysis (11 files)
`src/features/gas.ts`, `src/features/gas-decorations.ts`, `src/features/gas-decorations-manager.ts`, `src/features/gas-optimizer.ts`, `src/features/gas-pricing.ts`, `src/features/gas-snapshot.ts`, `src/features/regression.ts`, `src/features/runner-backend.ts`, `src/features/forge-backend.ts`, `src/features/test-generator.ts`, `src/features/forge-script-runner.ts`

### Deploy & Run (13 files)
`src/features/deployer.ts`, `src/features/deployment.ts`, `src/features/anvil-manager.ts`, `src/features/script-runner.ts`, `src/features/script-discovery.ts`, `src/features/forge-test-runner.ts`, `src/features/keystore-discovery.ts`, `src/features/build-pipeline.ts`, `src/features/build-diagnostics.ts`, `src/features/deploy-run-provider.ts`, `src/features/notebook-provider.ts`, `src/features/playground.ts`, `src/features/dashboard-provider.ts`

### Security (25 files)
`src/features/collision-detector.ts`, `src/features/invariant-detector.ts`, `src/features/mev-analyzer.ts`, `src/features/slither-integration.ts`, `src/features/mythril-integration.ts`, `src/features/source-verifier.ts`, `src/features/verify.ts`, `src/features/dangerous-patterns.ts`, `src/features/unchecked-calls.ts`, `src/features/reentrancy-detector.ts`, `src/features/access-control-checker.ts`, `src/features/event-checker.ts`, `src/features/natspec-checker.ts`, `src/features/interface-check.ts`, `src/features/storage-layout.ts`, `src/features/call-graph.ts`, `src/features/complexity.ts`, `src/features/size.ts`, `src/features/defi-risks.ts`, `src/features/address-inspector.ts`, `src/features/upgrade-analyzer.ts`, `src/features/analysis-engine.ts`, `src/features/custom-error-suggestions.ts`, `src/features/balance-cache.ts`, `src/features/snippet-provider.ts`

### Integration (5 files)
`src/features/tenderly-integration.ts`, `src/features/cast-integration.ts`, `src/features/hardhat-integration.ts`, `src/features/fork-simulator.ts`, `src/features/remix-port/` (4 files)

### UI (8 files)
`src/features/selector-hover-provider.ts`, `src/features/findings-tree-provider.ts`, `src/features/code-action-provider.ts`, `src/features/tree-provider.ts`, `src/features/signature-database.ts`, `src/features/remappings.ts`, `src/features/contract-flattener.ts`, `src/features/chain-explorer.ts`
