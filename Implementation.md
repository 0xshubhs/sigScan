# SigScan — Next Phase: Non-Verified Contract Tooling

## Problem Statement

As a smart contract developer, interacting with **non-verified contracts** is a constant pain point. When a contract isn't verified on Etherscan/Sourcify, you're left with raw bytecode and no ABI — making it nearly impossible to:

- Know what functions exist on the contract
- Decode transaction calldata
- Understand if you're interacting with a proxy
- Read storage slots without knowing the layout
- Simulate calls before sending real transactions
- Detect if a contract is malicious (honeypot, hidden fees, etc.)

SigScan already solves the **function selector extraction** problem for source code. The next phase extends this to work **entirely from bytecode and on-chain data** — no source code required.

---

## Feature 1: Bytecode Selector Extraction

### What It Does

Extracts all 4-byte function selectors directly from deployed contract bytecode by analyzing the dispatcher pattern (the `PUSH4 ... EQ JUMPI` sequences the Solidity compiler generates at the start of every contract).

### Why It Matters

When you encounter an unverified contract, the first question is always: **"What functions does this thing have?"** This feature answers that instantly without needing source code, verification, or any external API.

### Technical Approach

```
Raw Bytecode
    ↓
Scan for PUSH4 (0x63) opcodes followed by EQ (0x14)
    ↓
Extract 4-byte selectors from each PUSH4
    ↓
Cross-reference against:
  1. Local signatures.json database
  2. 4byte.directory API (already implemented)
  3. OpenChain / Samczsun signature DB
    ↓
Output: List of selectors with resolved names (where available)
```

### Implementation Details

- **New file**: `src/features/bytecode-analyzer.ts`
- **Class**: `BytecodeAnalyzer`
- **Key methods**:
  - `extractSelectors(bytecode: string): string[]` — parse PUSH4/EQ patterns
  - `extractSelectorsWithMetadata(bytecode: string): SelectorInfo[]` — includes jump destinations, potential visibility hints
  - `detectCompilerVersion(bytecode: string): string | null` — check metadata hash at end of bytecode (CBOR-encoded solc version)
  - `isProxy(bytecode: string): boolean` — quick check for DELEGATECALL patterns
- **Handles edge cases**:
  - Vyper contracts (different dispatcher pattern)
  - Minimal proxies (EIP-1167) — very short bytecode with DELEGATECALL
  - Diamond proxies (EIP-2535) — multiple facets
  - Contracts with no dispatcher (receive/fallback only)

### Integration Points

- **CLI**: `sigscan bytecode <hex-or-address>` — extract selectors from raw bytecode or fetch from RPC
- **VS Code**: New command `sigscan.analyzeBytescode` — paste bytecode or enter address
- **Hover provider**: Extend existing selector hover to show reverse-lookup results

### Priority: P0 (Critical)

This is the foundation — every other non-verified contract feature builds on knowing what selectors exist.

---

## Feature 2: Calldata Decoder / Encoder

### What It Does

Decodes raw transaction calldata into human-readable function calls with named parameters, and encodes function calls into calldata for interacting with unverified contracts.

### Why It Matters

You see a transaction on Etherscan with calldata `0xa9059cbb000000000000000000000000...` — what does it actually do? This feature instantly tells you: `transfer(address: 0x..., uint256: 1000000)`. Going the other direction, you can construct calldata to call functions on unverified contracts.

### Technical Approach

**Decoding:**
```
Raw Calldata (0xa9059cbb...)
    ↓
Extract first 4 bytes → selector (0xa9059cbb)
    ↓
Look up selector → "transfer(address,uint256)"
    ↓
ABI-decode remaining bytes using parameter types
    ↓
Output: { function: "transfer", params: { to: "0x...", amount: "1000000" } }
```

**Encoding:**
```
User input: transfer(address,uint256) with args [0x..., 1000000]
    ↓
Compute selector: keccak256("transfer(address,uint256)")[0:4]
    ↓
ABI-encode parameters according to types
    ↓
Output: Complete calldata hex string
```

### Implementation Details

- **New file**: `src/features/calldata-codec.ts`
- **Class**: `CalldataCodec`
- **Key methods**:
  - `decode(calldata: string, knownAbi?: AbiEntry[]): DecodedCall` — decode calldata to structured result
  - `encode(signature: string, args: unknown[]): string` — encode function call to calldata
  - `decodeParameters(types: string[], data: string): unknown[]` — low-level ABI parameter decoding
  - `encodeParameters(types: string[], values: unknown[]): string` — low-level ABI parameter encoding
- **ABI encoding support**:
  - Static types: uint, int, address, bool, bytesN
  - Dynamic types: bytes, string, arrays
  - Nested tuples (struct parameters)
  - Fixed-size arrays
- **No ethers.js / web3.js dependency** — implement ABI codec from scratch using just `Buffer` operations (keeps the extension lightweight)

### Integration Points

- **CLI**: `sigscan decode <calldata>` and `sigscan encode <signature> <args...>`
- **VS Code**: Command `sigscan.decodeCalldata` — opens input box, shows decoded result in output panel
- **Context menu**: Right-click hex string in editor → "Decode as calldata"
- **Playground webview**: Integrate encoder into the existing contract interaction playground

### Priority: P0 (Critical)

This is the most-requested feature for working with non-verified contracts. Every MEV searcher, auditor, and DeFi developer needs this daily.

---

## Feature 3: Proxy Detection + Implementation Resolution

### What It Does

Automatically detects if a contract is a proxy, identifies the proxy pattern, and resolves the implementation address by reading the correct storage slot.

### Why It Matters

Over 60% of major DeFi contracts are proxies. When you interact with a proxy, you're actually calling the implementation contract's code. Without resolving the implementation, you're analyzing the wrong bytecode. This feature automatically follows the proxy chain to the actual logic contract.

### Proxy Patterns to Detect

| Pattern | Storage Slot | Identifier |
|---------|-------------|------------|
| EIP-1967 Transparent | `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc` | Most common (OpenZeppelin) |
| EIP-1967 Beacon | `0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50` | Beacon proxy pattern |
| EIP-1822 UUPS | `0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7` | Universal Upgradeable |
| EIP-1167 Minimal | Bytecode contains implementation address | Clone factory |
| EIP-2535 Diamond | Facet registry in storage | Multi-facet proxy |
| GnosisSafe | Slot 0 | `masterCopy` |
| Custom/Legacy | Various | Heuristic detection |

### Technical Approach

```
Contract Address
    ↓
Fetch bytecode via RPC
    ↓
Check for known proxy patterns:
  1. EIP-1167: Pattern match bytecode for clone template
  2. EIP-1967: Read standard storage slots
  3. EIP-2535: Check for diamondCut selector
  4. Heuristic: Look for DELEGATECALL in bytecode
    ↓
If proxy detected:
  - Read implementation address from appropriate slot
  - Recursively check if implementation is also a proxy
  - Return full proxy chain
    ↓
Output: { isProxy: true, pattern: "EIP-1967", implementation: "0x...", chain: [...] }
```

### Implementation Details

- **New file**: `src/features/proxy-resolver.ts`
- **Class**: `ProxyResolver`
- **Key methods**:
  - `detectProxy(bytecode: string): ProxyInfo | null` — bytecode-only detection
  - `resolveImplementation(address: string, rpcUrl: string): ProxyChain` — full resolution via RPC
  - `getStorageAt(address: string, slot: string, rpcUrl: string): string` — raw storage read (via `eth_getStorageAt`)
  - `resolveFullChain(address: string, rpcUrl: string): ProxyChain` — follow proxy chain recursively (max depth 5)
- **RPC calls**: Use Node `https` module (no web3/ethers) to call `eth_getCode` and `eth_getStorageAt`
- **Safety**: Max recursion depth of 5 to prevent infinite proxy loops

### Integration Points

- **CLI**: `sigscan proxy <address> --rpc <url>` — detect and resolve proxy
- **VS Code**: Command `sigscan.resolveProxy` — enter address, see proxy chain
- **Automatic**: When analyzing bytecode, auto-detect proxies and offer to analyze the implementation instead
- **Tree view**: Show proxy → implementation relationship in sidebar

### Priority: P0 (Critical)

Without this, you're always analyzing the wrong contract. This unlocks Features 1 and 2 for the vast majority of production DeFi contracts.

---

## Feature 4: On-Chain Storage Reader

### What It Does

Reads and decodes storage slots from deployed contracts, with intelligent layout detection that maps raw 32-byte slots to meaningful variable names and values.

### Why It Matters

Storage is the ground truth of a contract's state. For non-verified contracts, reading storage is often the **only** way to understand what the contract is doing — what the owner address is, what fees are set to, whether it's paused, etc. Combined with the existing storage layout analyzer (which works on source code), this feature bridges the gap to on-chain data.

### Technical Approach

```
Contract Address + Optional Source/ABI
    ↓
If source available:
  - Use existing StorageLayoutAnalyzer to compute slot layout
  - Read each slot via eth_getStorageAt
  - Decode values according to types
    ↓
If no source (non-verified):
  - Read slots 0-20 (common variable positions)
  - Heuristic decoding:
    - Slot looks like address? (20 bytes, left-padded zeros)
    - Slot looks like small number? (< 10^18)
    - Slot looks like boolean? (0 or 1)
    - Slot looks like timestamp? (reasonable epoch range)
  - Check known proxy slots
  - Read mapping slots if keys are known (keccak256(key . slot))
    ↓
Output: Table of slot → value → decoded interpretation
```

### Implementation Details

- **New file**: `src/features/storage-reader.ts`
- **Class**: `StorageReader`
- **Key methods**:
  - `readSlot(address: string, slot: number | string, rpcUrl: string): string` — read single slot
  - `readSlotRange(address: string, startSlot: number, count: number, rpcUrl: string): SlotValue[]` — batch read
  - `readMappingEntry(address: string, mappingSlot: number, key: string, rpcUrl: string): string` — compute and read mapping slot
  - `readArrayLength(address: string, arraySlot: number, rpcUrl: string): number` — read dynamic array length
  - `readArrayElement(address: string, arraySlot: number, index: number, rpcUrl: string): string` — read specific element
  - `decodeSlotHeuristic(rawValue: string): SlotInterpretation[]` — guess what a raw value represents
  - `readWithLayout(address: string, layout: StorageLayout, rpcUrl: string): DecodedStorage` — read all slots using known layout
- **Mapping slot calculation**: `keccak256(abi.encode(key, slotNumber))` — implemented with existing keccak256 utility
- **Packed storage**: Handle multiple variables packed into a single 32-byte slot (e.g., `uint128 + uint128`, `address + uint96`)

### Integration Points

- **CLI**: `sigscan storage <address> --rpc <url> [--slots 0-20]`
- **VS Code**: Command `sigscan.readStorage` — enter address, see decoded storage table
- **Existing integration**: Connect with `storage-layout.ts` — if source is available, use computed layout for accurate decoding
- **Webview**: Display storage as an interactive table with slot numbers, raw hex, and decoded values

### Priority: P1 (High)

Essential for auditing and debugging non-verified contracts. The heuristic decoding makes it useful even without source code.

---

## Feature 5: Transaction Simulator (Local Fork)

### What It Does

Simulates transactions against a local fork of any EVM chain without spending real gas or requiring private keys. Uses the existing Runner backend (Rust/revm) extended with RPC state forking.

### Why It Matters

Before sending a transaction to an unverified contract, you want to know: **"What will actually happen?"** Will it revert? How much gas will it use? What storage changes will it make? What events will it emit? This feature gives you a complete dry-run with full execution trace.

### Technical Approach

```
Transaction Parameters + RPC URL
    ↓
Fork chain state at latest (or specified) block
    ↓
Execute transaction in local revm instance:
  - Load account state on-demand from RPC (lazy forking)
  - Cache fetched state for subsequent calls
  - Full EVM execution with trace
    ↓
Capture:
  - Success/revert status + return data
  - Gas used (exact)
  - Storage changes (slot → old value → new value)
  - Event logs emitted
  - Internal calls (CALL, DELEGATECALL, STATICCALL trace)
  - Balance changes
    ↓
Output: Complete execution report
```

### Implementation Details

- **Modified file**: `runner/src/evm.rs` — add forked execution mode
  - New `ForkConfig` struct: `{ rpc_url: String, block_number: Option<u64> }`
  - Implement `DatabaseRef` trait that fetches from RPC on cache miss
  - Use `alloy-provider` or raw `reqwest` for JSON-RPC calls (`eth_getCode`, `eth_getBalance`, `eth_getStorageAt`, `eth_getTransactionCount`)
  - Cache all fetched state in a `HashMap` to avoid redundant RPC calls
- **New file**: `runner/src/fork.rs` — forked database implementation
  - `ForkedDb` struct implementing revm's `DatabaseRef`
  - LRU cache for fetched state (configurable size, default 10,000 entries)
  - Batch fetching where possible (`eth_getProof` for multiple slots)
- **Modified file**: `runner/src/types.rs` — add simulation result types
  - `SimulationResult { success, gas_used, return_data, logs, storage_changes, internal_calls }`
  - `StorageChange { address, slot, old_value, new_value }`
  - `InternalCall { from, to, value, input, output, call_type }`
- **New file**: `src/features/tx-simulator.ts` — TypeScript interface
  - `TxSimulator` class that spawns runner binary with fork mode
  - Parses JSON output from runner
  - Formats results for display

### Integration Points

- **CLI**: `sigscan simulate --to <address> --calldata <hex> --rpc <url> [--from <address>] [--value <wei>] [--block <number>]`
- **VS Code**: Command `sigscan.simulateTransaction` — form-based input, results in output panel
- **Playground webview**: "Simulate" button next to each function in the contract interaction view
- **Runner backend**: Extends existing `runner/` Rust binary — no new binary needed

### Priority: P1 (High)

This is the killer feature for non-verified contract interaction. Combined with Features 1-3, you can discover functions, construct calldata, resolve proxies, and simulate the call — all without touching mainnet.

---

## Feature 6: Honeypot / Malicious Pattern Scanner

### What It Does

Analyzes contract bytecode and (if available) source code for known malicious patterns: hidden fees, blacklist functions, ownership backdoors, token honeypots, and rug pull mechanisms.

### Why It Matters

Before interacting with any unverified contract (especially tokens), you need to know if it's safe. This feature checks for the most common scam patterns that have drained billions from users. It's not a full audit — it's a quick "red flag" scanner.

### Patterns to Detect

| Category | Pattern | Severity |
|----------|---------|----------|
| **Honeypot** | Buy succeeds but sell reverts (conditional transfer logic) | Critical |
| **Honeypot** | Hidden max transaction amount that blocks sells | Critical |
| **Honeypot** | Dynamic fee that increases to 100% | Critical |
| **Ownership** | Owner can pause/blacklist any address | High |
| **Ownership** | Owner can mint unlimited tokens | High |
| **Ownership** | Hidden owner change mechanism | High |
| **Fee** | Undisclosed transfer fee > 5% | High |
| **Fee** | Fee that changes based on recipient | High |
| **Rug Pull** | Owner can withdraw all liquidity | Critical |
| **Rug Pull** | Self-destruct capability | Critical |
| **Rug Pull** | Upgradeable without timelock | Medium |
| **Flash Loan** | Unprotected callback that modifies state | Medium |
| **Reentrancy** | External call before state update | Medium |

### Technical Approach

**From Bytecode (no source):**
```
Bytecode
    ↓
Extract selectors (Feature 1)
    ↓
Check for suspicious selectors:
  - SELFDESTRUCT opcode present?
  - DELEGATECALL to user-controlled address?
  - Conditional logic in transfer that depends on msg.sender vs tx.origin?
  - Multiple SSTORE before external CALL (potential reentrancy guard bypass)?
    ↓
Simulate token buy+sell (Feature 5):
  - Simulate buying token on DEX
  - Simulate selling token on DEX
  - Compare: if buy succeeds but sell reverts → honeypot
    ↓
Output: Risk score + findings
```

**From Source Code:**
```
Source Code
    ↓
Pattern match for:
  - Conditional require/revert in transfer based on sender/receiver
  - Fee variables that can be set > 25%
  - blacklist/whitelist mappings used in transfer
  - onlyOwner functions that call selfdestruct
  - Proxy upgrade without timelock
  - Balance manipulation in non-standard functions
    ↓
Cross-reference with bytecode analysis
    ↓
Output: Detailed findings with line numbers + risk score
```

### Implementation Details

- **New file**: `src/features/honeypot-scanner.ts`
- **Class**: `HoneypotScanner`
- **Key methods**:
  - `scanBytecode(bytecode: string): ScanResult` — bytecode-only analysis
  - `scanSource(source: string, contractName: string): ScanResult` — source code analysis
  - `simulateTokenSafety(tokenAddress: string, dexRouter: string, rpcUrl: string): TokenSafetyResult` — simulate buy+sell via Feature 5
  - `calculateRiskScore(findings: Finding[]): number` — 0-100 risk score
- **New file**: `src/features/patterns/malicious-patterns.ts` — pattern definitions
  - Each pattern: `{ id, name, severity, description, bytecodeCheck?, sourceCheck? }`
  - Bytecode checks: opcode sequence matching
  - Source checks: regex + AST-like pattern matching (using existing parser infrastructure)
- **Risk score calculation**:
  - Critical finding: +40 points
  - High finding: +20 points
  - Medium finding: +10 points
  - Score > 70: "Likely malicious"
  - Score 40-70: "Suspicious — proceed with caution"
  - Score < 40: "Low risk (not a guarantee of safety)"

### Integration Points

- **CLI**: `sigscan scan-safety <address-or-file> [--rpc <url>]`
- **VS Code**: Command `sigscan.scanForHoneypot` — results shown as diagnostics (warnings/errors in Problems panel)
- **Tree view**: Red/yellow/green indicator next to contracts in sidebar
- **MEV analyzer integration**: Feed findings into existing `mev-analyzer.ts` for combined risk assessment

### Priority: P2 (Medium)

Important but complex. The bytecode-only honeypot detection (buy+sell simulation) depends on Features 1 and 5 being complete first. Source-code pattern matching can be done independently.

---

## Implementation Roadmap

```
Phase A: Foundation (Features 1 + 2)         ← Start here
  ├── bytecode-analyzer.ts
  ├── calldata-codec.ts
  └── Extend signatures.json + 4byte lookup

Phase B: On-Chain Access (Features 3 + 4)
  ├── proxy-resolver.ts
  ├── storage-reader.ts
  └── RPC utility module (shared JSON-RPC client)

Phase C: Simulation (Feature 5)
  ├── runner/src/fork.rs
  ├── tx-simulator.ts
  └── Extend playground webview

Phase D: Safety (Feature 6)
  ├── honeypot-scanner.ts
  ├── patterns/malicious-patterns.ts
  └── Integration with existing analyzers
```

### Dependencies Between Features

```
Feature 1 (Bytecode Selectors)
    ↓
Feature 2 (Calldata Codec)  ←  needs selector lookup
    ↓
Feature 3 (Proxy Resolver)  ←  needs bytecode analysis
    ↓
Feature 4 (Storage Reader)  ←  needs proxy resolution for accurate reads
    ↓
Feature 5 (Tx Simulator)    ←  needs all above for meaningful simulation
    ↓
Feature 6 (Honeypot Scanner) ← needs simulation for buy/sell test
```

### Shared Infrastructure Needed

| Module | Purpose | Used By |
|--------|---------|---------|
| `src/features/rpc-client.ts` | Lightweight JSON-RPC client (Node `https`, no deps) | Features 3, 4, 5, 6 |
| `src/features/abi-codec.ts` | ABI encode/decode (pure JS, no ethers) | Features 2, 4, 5 |
| `data/signatures.json` | Expanded selector database | Features 1, 2, 6 |

---

## Design Constraints

1. **No heavy dependencies** — No ethers.js, web3.js, or viem. Use Node `https` for RPC calls. ABI encoding/decoding implemented from scratch.
2. **Works offline** — Bytecode analysis, calldata decoding (with local DB), and source scanning all work without internet. Only RPC-dependent features need connectivity.
3. **Existing architecture** — All new features plug into the existing extension/CLI structure. New commands registered in `extension.ts`, new CLI subcommands in `cli/index.ts`.
4. **Runner reuse** — Transaction simulation extends the existing Rust runner binary rather than introducing a new one.
5. **Progressive enhancement** — Each feature adds value independently. You don't need all 6 to benefit from any one of them.
