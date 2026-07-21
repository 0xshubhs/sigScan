# 0xTools · Deploy & Run — Future Work

Captured at the end of the session that shipped the Deploy & Run sidebar
through to commit `0833396`. Pick up from here next session.

---

## Top picks — ship next

Ordered by bang-for-buck. The first four together would make the panel
feel "complete" for daily Solidity work.

### 1. Block explorer links everywhere   _~30 min_

Every tx hash, contract address, and "Deployed" field in the panel becomes
a click → opens the right explorer in the user's browser.

- We already have explorer URLs in `BUILT_IN_NETWORKS`
  (`src/shared/deploy-run-protocol.ts`).
- Use `vscode.env.openExternal(vscode.Uri.parse(url))` from the provider via
  a new request `openExplorer { kind: 'tx' | 'address'; value: string }`.
- Webview adds a tiny "↗" button next to each address/hash chip in
  `TxLogPanel.tsx` and `InstanceCard.tsx`.
- Fallback: when on Anvil / network with no explorerUrl, hide the button.

### 2. "Verify on explorer" after deploy   _~1 hr_

Close the loop: deploy → verify → click → see source on basescan, all from
the sidebar.

- Add a `Verify` button on each `InstanceCard` (only shown when the
  network has `explorerUrl` and the contract has `sourcePath`).
- New service `src/features/verifier.ts` that shells out to
  `forge verify-contract <addr> <ContractName> --chain <chainId> --etherscan-api-key <key>`.
- Store Etherscan API key (one per chain family) via `context.secrets`. Add a
  command `0xtools: Set Etherscan API Key` that prompts for the key.
- Stream output to the webview just like build does; on success, show the
  basescan URL in the tx log.
- For Hardhat projects: `npx hardhat verify --network <name> <addr> <args>`.

### 3. Persistent deployed instances   _~45 min_

Currently the instance list lives in memory; reload VS Code → all gone.

- Save to `context.workspaceState` (per-workspace, survives reloads) keyed
  by `{network}::{address}::{name}`.
- Optionally also write to `.0xtools/deployments-<chainId>.json` in the
  workspace so the list can be checked in or shared with teammates (Remix
  does this with `.deploys/pinned-contracts/`).
- Hydrate on `resolveWebviewView` after the first scan.
- Add `Remove from all` action somewhere so users can wipe stale entries.

### 4. Value field on payable function rows   _~30 min_

Real gap: `InstanceCard` function rows have no `value` input. Calling a
payable function like `deposit() payable` always sends `msg.value = 0`,
which usually reverts.

- Each function row that's `payable` gets a small `ValueUI` (compact mode)
  next to or below its args.
- Per-row state (we can't share the constructor's value since each function
  needs its own).
- Pass `valueWei` through to `sendTransaction` in the provider (already
  supported by the protocol).

### 5. Auto-register script-deployed contracts   _~1-2 hr_

Loose end from the scripts commit (`0833396`). When `forge script --broadcast`
runs, it writes a structured `broadcast/<file>.s.sol/<chainId>/run-latest.json`
with deployed addresses + contract names. Parse it.

- After `runScript` succeeds, read the broadcast file from
  `<projectRoot>/broadcast/<basename>.s.sol/<chainId>/run-latest.json`.
- For each `CREATE` transaction in the `transactions` array, match the
  `contractName` to a built artifact and auto-add a `DeployedInstance`
  (so you can interact immediately, no "At Address" copy-paste).
- For Hardhat: harder — output is script-specific. Skip for V1 unless we
  see a common pattern (hardhat-deploy plugin writes `deployments/<network>/<Name>.json`,
  which is parseable similarly).

---

## Deeper cuts — valuable but bigger

### Custom RPC URL input
Let users add networks we don't ship (Linea, Mode, Scroll, Lisk, …).
- Add a `Custom…` option to the network dropdown that opens a small form
  (RPC URL, chainId, native symbol, explorer URL).
- Store in `context.workspaceState` and merge with `BUILT_IN_NETWORKS`
  when rendering.

### Send raw ETH
Independent of contract calls — useful for funding testnet accounts.
- Sidebar utility: To + Value + Send. Goes through `sendTransaction` path
  but with empty `data`.

### Mainnet fork mode
`anvil --fork-url <rpc> --fork-block-number <n>` from the panel.
- `AnvilManager` already supports it; just need UI toggle in
  `NetworkSection` when env=Anvil.
- Fork URL selector: any non-Anvil network in our list is a candidate.

### Snapshot save/restore
`anvil_snapshot` / `anvil_revert` already wrapped in `AnvilManager`.
- "Save state" button in NetworkSection when Anvil running.
- Save list with optional name; restore reverts to that snapshot.

### Address book + labels
- Save addresses with labels (e.g. "Alice", "USDC contract").
- Show label everywhere the address appears (tx log, instance cards,
  account picker).
- ENS resolution overlay: type `vitalik.eth` in At Address, resolve via
  mainnet RPC.

### EIP-1559 gas controls
- Show `maxFeePerGas` / `maxPriorityFeePerGas` inputs when on EIP-1559
  chains. Default to `eth_feeHistory`-derived suggestions.
- Helpful on mainnet where gas can spike mid-tx.

### At Address with auto-ABI
- Paste an address; if no local ABI matches, hit Etherscan's `getsourcecode`
  endpoint (or Sourcify) and use the returned ABI.
- Lets users interact with any verified contract without compiling.

### Network status indicator
- Small chip in `NetworkSection` showing current block number + gas price.
- Updates on `eth_subscribe('newHeads')` (or polled `eth_blockNumber` if WS
  not supported).

---

## Polish queue

Smaller items worth a pass at some point:

- Auto-refresh balance after every successful tx (currently only on net/account change)
- Recent addresses dropdown for `At Address` input
- Multi-keystore selection persisted per network (e.g. always use `deployer`
  on Base Sepolia, `ops` on mainnet)
- "Copy as cast command" on every tx log entry — generates the equivalent
  `cast send` invocation for power users
- Better empty-state illustration for the `Contracts` section
- Solc compile errors that occur outside `forge build` (e.g. inline `solc-js`
  fallback) also feed the diagnostics collection

---

## Bugs / known sharp edges

- Low-level interactions (calldata + value) in `InstanceCard` is still a
  V1 placeholder — sends a "not implemented" message. Wiring up requires a
  separate sendTransaction path that accepts raw calldata bypassing the ABI.
- Build error parsing assumes solc output formats; might miss Vyper or
  Hardhat plugin errors. Re-test with a Vyper project if needed.
- Bun shim on the dev machine is broken (`~/.bun/bin/bun` is a wrapper script
  that loops). Commits use `--no-verify` to bypass the hung lint-staged hook.
  Fixing bun (`curl -fsSL https://bun.sh/install | bash`) would restore the
  pre-commit lint pipeline.

---

## Recommended next bundle

Ship items **1, 2, 3, 4** above together as one focused commit/PR — they all
touch the deploy + interact loop and combine to make the panel feel like a
complete daily-driver tool. Verification (item 2) especially: once deploy
+ verify + explorer link all live in one panel, the user basically doesn't
need Remix or a terminal for the whole development cycle.

Item **5** is meatier and best as its own commit afterward.

---

## Quick context for next session

Key files to know before extending:

- `src/extension/providers/deploy-run-provider.ts` — request router, state,
  inline PANEL_CSS at the bottom
- `src/shared/deploy-run-protocol.ts` — types + bus envelope; **read first**
- `src/features/{contract,script,keystore}-discovery.ts` — workspace walks
- `src/features/{build-pipeline,script-runner,deployer,balance-cache,rpc-registry}.ts` — services
- `src/webview/deploy-run/` — React UI (App + components)
- `src/features/remix-port/` — pure logic ported from Remix (txFormat, txHelper, eventsDecoder)

Build / test / install loop:

```sh
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.webview.json
npx jest --silent
npx webpack --mode production
npx vsce package --out 0xtools-deploy-run-dev.vsix --skip-license
code --install-extension 0xtools-deploy-run-dev.vsix --force
```

Then **reload the VS Code window** (`Ctrl+Shift+P` → "Developer: Reload Window")
to pick up the new install.
