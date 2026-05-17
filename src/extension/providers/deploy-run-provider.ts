// Deploy & Run sidebar — WebviewView provider.
// Hosts the React UI from dist/webview/deploy-run.js and routes typed messages
// between the webview and the local AnvilManager / contract / keystore / signing services.

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type { AnvilManager } from '../../features/anvil-manager';
import {
  discoverWorkspace,
  type DiscoveredContract,
} from '../../features/contract-discovery';
import { runBuild, detectProjectKind, type ProjectKind } from '../../features/build-pipeline';
import { parseBuildDiagnostics, groupByFile } from '../../features/build-diagnostics';
import { discoverScripts, type ScriptEntry } from '../../features/script-discovery';
import { runScript } from '../../features/script-runner';
import {
  getDefaultKeystoreDir,
  listKeystores,
  readKeystoreJson,
  storePassword,
  takePassword,
  clearPassword,
  isUnlocked,
} from '../../features/keystore-discovery';
import { fetchBalance, invalidateBalance } from '../../features/balance-cache';
import { ensureRegistry } from '../../features/rpc-registry';
import {
  deployContract,
  sendTransaction,
  callFunction,
  decodeRevert,
  type SignerSource,
} from '../../features/deployer';
import { parseFunctionParams, normalizeParam } from '../../features/remix-port/tx-format';
import type { AbiEntry, AbiParameter } from '../../features/remix-port/tx-helper';
import type {
  AccountSelection,
  BalanceStatus,
  ContractSummary,
  DeployedInstance,
  DeployRunEvent,
  DeployRunRequest,
  DeployRunResponse,
  DeployRunStatus,
  Envelope,
  HardforkName,
  KeystoreBalance,
  KeystoreInfo,
  NetworkConfig,
  ProjectGroup,
  ScriptRunState,
  ScriptSummary,
  TxLogEntry,
} from '../../shared/deploy-run-protocol';
import { BUILT_IN_NETWORKS } from '../../shared/deploy-run-protocol';
import * as path from 'path';

type GetAnvil = () => AnvilManager;

const ANVIL_NETWORK: NetworkConfig = { kind: 'anvil', name: 'Anvil (local)' };
const TX_LOG_LIMIT = 50;

export class DeployRunViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'zeroXTools.deployRun';

  private view: vscode.WebviewView | undefined;
  private selectedHardfork: HardforkName = 'cancun';
  private network: NetworkConfig = ANVIL_NETWORK;
  private accountSelection: AccountSelection = { kind: 'none' };

  private contracts: DiscoveredContract[] = [];
  private contractsByKey: Map<string, DiscoveredContract> = new Map();
  private instances: DeployedInstance[] = [];
  private txLog: TxLogEntry[] = [];
  private buildingProjects: Set<string> = new Set();
  private fileWatcher: vscode.Disposable | undefined;

  // Balance state, keyed by `${keystoreName}::${chainId}` so we can render the
  // right balance per network without losing prior fetches when the user toggles.
  private balanceByKey: Map<string, KeystoreBalance> = new Map();
  private balanceStatusByKey: Map<string, BalanceStatus> = new Map();
  private balanceErrorByKey: Map<string, string> = new Map();

  // VS Code diagnostic collection for forge/hardhat build errors — populated on
  // build failure, cleared on the next build attempt for the same project.
  private readonly buildDiagnostics: vscode.DiagnosticCollection =
    vscode.languages.createDiagnosticCollection('0xtools-build');

  // Some keystores don't include the address in their JSON metadata (e.g. those
  // created via ethers' encrypt() without an explicit address field). When we
  // decrypt one on unlock we capture the address here and overlay it on the
  // keystore list so subsequent UI / balance fetches have a real address to use.
  private addressOverlay: Map<string, string> = new Map();

  // Deploy scripts discovered in the workspace + per-script run state.
  private scripts: ScriptEntry[] = [];
  private scriptsByKey: Map<string, ScriptEntry> = new Map();
  private scriptRunStates: Map<string, ScriptRunState> = new Map();
  private scriptResults: Map<string, { error?: string; deployed: string[]; txHashes: string[]; durationMs: number }> = new Map();
  private runningScripts: Set<string> = new Set();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getAnvil: GetAnvil
  ) {}

  resolveWebviewView(
    view: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
    view.webview.html = this.renderHtml(view.webview);
    view.webview.onDidReceiveMessage((message: Envelope) => {
      if (message.type !== 'req') return;
      void this.handleRequest(message.id, message.req);
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.fileWatcher?.dispose();
      this.fileWatcher = undefined;
    });

    // On first resolution, eagerly scan the workspace so the panel shows contracts.
    void this.refreshContracts();
    this.installFileWatcher();
    // Warm the chainlist registry in the background so the first testnet balance
    // fetch already has access to the live RPC list.
    void ensureRegistry();
  }

  private installFileWatcher(): void {
    if (this.fileWatcher) return;
    if (!vscode.workspace.workspaceFolders?.length) return;
    // Watch source files AND artifact files. We debounce inside refreshContracts'
    // caller. The patterns intentionally exclude node_modules etc. via VS Code's
    // default exclude rules; the watcher fires per-file but discovery itself is cheap.
    const solWatcher = vscode.workspace.createFileSystemWatcher('**/*.sol');
    const fyAbiWatcher = vscode.workspace.createFileSystemWatcher('**/out/**/*.json');
    const hhAbiWatcher = vscode.workspace.createFileSystemWatcher('**/artifacts/**/*.json');
    // Hardhat deploy scripts live in scripts/ or deploy/ as .ts/.js — watch
    // both so the panel picks up new ones without a manual refresh.
    const tsScriptWatcher = vscode.workspace.createFileSystemWatcher(
      '**/{scripts,deploy}/**/*.{ts,js}'
    );

    let timer: NodeJS.Timeout | undefined;
    const schedule = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void this.refreshContracts();
      }, 400);
    };

    for (const w of [solWatcher, fyAbiWatcher, hhAbiWatcher, tsScriptWatcher]) {
      w.onDidCreate(schedule);
      w.onDidChange(schedule);
      w.onDidDelete(schedule);
    }
    this.fileWatcher = vscode.Disposable.from(solWatcher, fyAbiWatcher, hhAbiWatcher, tsScriptWatcher);
  }

  /** External entry — called from extension.ts when anvil state changes outside the panel. */
  pushStatus(): void {
    if (!this.view) return;
    void this.sendEvent({ kind: 'statusChanged', payload: this.currentStatus() });
  }

  reveal(): void {
    this.view?.show?.(true);
  }

  // ─── Request router ────────────────────────────────────────────────────

  private async handleRequest(id: string, req: DeployRunRequest): Promise<void> {
    try {
      const res = await this.dispatch(req);
      await this.sendResponse(id, res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.sendResponse(id, { kind: 'error', message: msg });
    }
  }

  private async dispatch(req: DeployRunRequest): Promise<DeployRunResponse> {
    switch (req.kind) {
      case 'getStatus':
        return { kind: 'status', payload: this.currentStatus() };

      case 'startAnvil': {
        const anvil = this.getAnvil();
        if (!(await anvil.isAvailable())) {
          return { kind: 'error', message: 'anvil is not installed. Install Foundry: https://book.getfoundry.sh/getting-started/installation' };
        }
        if (req.hardfork) this.selectedHardfork = req.hardfork;
        await anvil.start({
          port: req.port,
          forkUrl: req.forkUrl,
          hardfork: this.selectedHardfork,
        });
        this.network = ANVIL_NETWORK;
        // Auto-select the first anvil account
        const first = anvil.getAccounts()[0];
        if (first) {
          this.accountSelection = { kind: 'anvil', index: 0, address: first.address };
        }
        this.pushStatus();
        return { kind: 'status', payload: this.currentStatus() };
      }

      case 'stopAnvil': {
        const anvil = this.getAnvil();
        if (anvil.isRunning()) await anvil.stop();
        if (this.accountSelection.kind === 'anvil') this.accountSelection = { kind: 'none' };
        this.pushStatus();
        return { kind: 'status', payload: this.currentStatus() };
      }

      case 'restartAnvil': {
        const anvil = this.getAnvil();
        if (req.hardfork) this.selectedHardfork = req.hardfork;
        const prevState = anvil.getState();
        if (anvil.isRunning()) await anvil.stop();
        await anvil.start({
          port: prevState?.port,
          forkUrl: prevState?.forkUrl,
          hardfork: this.selectedHardfork,
        });
        const first = anvil.getAccounts()[0];
        if (first) {
          this.accountSelection = { kind: 'anvil', index: 0, address: first.address };
        }
        this.pushStatus();
        return { kind: 'status', payload: this.currentStatus() };
      }

      case 'refreshContracts':
        await this.refreshContracts();
        return { kind: 'status', payload: this.currentStatus() };

      case 'buildProject':
        await this.buildOne(req.projectRoot);
        return { kind: 'status', payload: this.currentStatus() };

      case 'buildAll': {
        const roots = Array.from(new Set(this.contracts.map((c) => c.projectRoot)));
        await Promise.all(roots.map((r) => this.buildOne(r)));
        return { kind: 'status', payload: this.currentStatus() };
      }

      case 'selectNetwork': {
        this.network = req.network;
        // Reset account selection when switching networks; anvil networks pick the local account automatically
        if (req.network.kind === 'anvil') {
          const first = this.getAnvil().getAccounts()[0];
          this.accountSelection = first
            ? { kind: 'anvil', index: 0, address: first.address }
            : { kind: 'none' };
        } else {
          // Carry over a keystore selection if present
          if (this.accountSelection.kind !== 'keystore') {
            this.accountSelection = { kind: 'none' };
          }
        }
        this.pushStatus();
        // Eagerly refresh balances for the new network — non-blocking.
        void this.refreshAllBalancesForCurrentNetwork();
        return { kind: 'status', payload: this.currentStatus() };
      }

      case 'selectAccount': {
        this.accountSelection = req.selection;
        this.pushStatus();
        // If we just selected a keystore on a testnet/mainnet, fetch its balance.
        if (req.selection.kind === 'keystore' && this.network.kind !== 'anvil') {
          void this.refreshBalanceFor(req.selection.name);
        }
        return { kind: 'status', payload: this.currentStatus() };
      }

      case 'refreshKeystores':
        return { kind: 'status', payload: this.currentStatus() };

      case 'unlockKeystore': {
        // Validate the password by attempting a decryption. We discard the
        // wallet *after* capturing its address — that's the only way to learn
        // the address for keystores whose JSON omits it (some ethers-encrypted
        // ones do).
        try {
          const json = readKeystoreJson(this.keystorePathFor(req.name));
          const { Wallet } = await import('ethers');
          const wallet = await Wallet.fromEncryptedJson(json, req.password);
          const addr = (wallet as { address?: string }).address;
          if (addr) this.addressOverlay.set(req.name, addr);
        } catch {
          return { kind: 'error', message: 'invalid password' };
        }
        storePassword(req.name, req.password, (req.ttlMinutes ?? 15) * 60 * 1000);
        // If the user already had this keystore selected with an empty address,
        // patch the selection so the next sign call has something to use.
        const known = this.addressOverlay.get(req.name);
        if (
          known &&
          this.accountSelection.kind === 'keystore' &&
          this.accountSelection.name === req.name &&
          !this.accountSelection.address
        ) {
          this.accountSelection = { kind: 'keystore', name: req.name, address: known };
        }
        this.pushStatus();
        if (this.network.kind !== 'anvil') void this.refreshBalanceFor(req.name);
        return { kind: 'status', payload: this.currentStatus() };
      }

      case 'lockKeystore':
        clearPassword(req.name);
        this.pushStatus();
        return { kind: 'status', payload: this.currentStatus() };

      case 'refreshBalance': {
        // Refresh balance for the currently selected keystore on the current network.
        if (this.accountSelection.kind === 'keystore' && this.network.kind !== 'anvil') {
          await this.refreshBalanceFor(this.accountSelection.name, { force: true });
        }
        return { kind: 'status', payload: this.currentStatus() };
      }

      case 'refreshAllBalances': {
        if (this.network.kind !== 'anvil') {
          await this.refreshAllBalancesForCurrentNetwork({ force: true });
        }
        return { kind: 'status', payload: this.currentStatus() };
      }

      case 'refreshScripts': {
        await this.refreshContracts();
        return { kind: 'status', payload: this.currentStatus() };
      }

      case 'runScript': {
        await this.runOneScript(req.scriptKey, req.hardhatNetwork);
        return { kind: 'status', payload: this.currentStatus() };
      }

      case 'deployContract': {
        const contract = this.contractsByKey.get(req.contractKey);
        if (!contract) throw new Error(`contract not found: ${req.contractKey}`);
        if (!contract.abi || !contract.bytecode || contract.bytecode === '0x') {
          throw new Error(
            `${contract.name} has no compiled bytecode — build the project first.`
          );
        }
        const rpcUrl = this.activeRpcUrl();
        const signer = await this.resolveSignerSource();
        const ctorAbi = contract.abi.find((e) => e.type === 'constructor');
        const ctorInputs = (ctorAbi?.inputs ?? []) as AbiParameter[];
        const ctorArgs = parseArgs(req.ctorArgsRaw, ctorInputs);
        const entry: TxLogEntry = {
          id: makeId(),
          kind: 'deploy',
          contractName: contract.name,
          status: 'pending',
          fromAddress: this.activeFromAddress(),
          valueWei: req.valueWei,
          networkLabel: this.network.name,
          at: Date.now(),
        };
        this.appendTx(entry);
        try {
          const result = await deployContract({
            rpcUrl,
            signer,
            abi: contract.abi,
            bytecode: contract.bytecode,
            ctorArgs,
            value: req.valueWei !== undefined ? BigInt(req.valueWei) : undefined,
            gasLimit: req.gasLimit !== undefined ? BigInt(req.gasLimit) : undefined,
          });
          const instance: DeployedInstance = {
            id: makeId(),
            name: contract.name,
            address: result.address,
            network: this.network.kind,
            abi: contract.abi,
            deployedAt: Date.now(),
            fromKey: contract.key,
          };
          this.instances = [...this.instances, instance];
          this.updateTx(entry.id, {
            status: 'success',
            txHash: result.txHash,
            blockNumber: result.blockNumber,
            gasUsed: result.gasUsed,
            deployedAddress: result.address,
          });
          this.pushStatus();
          return {
            kind: 'deployResult',
            payload: { instance, txEntry: this.findTx(entry.id)! },
          };
        } catch (err) {
          const message = decodeRevert(contract.abi, err);
          this.updateTx(entry.id, { status: 'error', errorMessage: message });
          this.pushStatus();
          throw new Error(message);
        }
      }

      case 'callFunction': {
        const rpcUrl = this.activeRpcUrl();
        const fnAbi = findFunctionInAbi(req.abi, req.funcName);
        if (!fnAbi) throw new Error(`function not found in ABI: ${req.funcName}`);
        const args = parseArgs(req.argsRaw, fnAbi.inputs ?? []);
        const entry: TxLogEntry = {
          id: makeId(),
          kind: 'call',
          contractName: this.instanceNameFor(req.address) ?? shortenAddr(req.address),
          funcName: req.funcName,
          status: 'pending',
          toAddress: req.address,
          fromAddress: this.activeFromAddress(),
          valueWei: req.valueWei,
          networkLabel: this.network.name,
          at: Date.now(),
        };
        this.appendTx(entry);
        try {
          const result = await callFunction({
            rpcUrl,
            to: req.address,
            abi: req.abi,
            funcName: req.funcName,
            args,
            value: req.valueWei !== undefined ? BigInt(req.valueWei) : undefined,
          });
          this.updateTx(entry.id, { status: 'success', returnValue: result.decoded });
          this.pushStatus();
          return {
            kind: 'callResult',
            payload: { decoded: result.decoded, txEntry: this.findTx(entry.id)! },
          };
        } catch (err) {
          const message = decodeRevert(req.abi, err);
          this.updateTx(entry.id, { status: 'error', errorMessage: message });
          this.pushStatus();
          throw new Error(message);
        }
      }

      case 'sendTransaction': {
        const rpcUrl = this.activeRpcUrl();
        const signer = await this.resolveSignerSource();
        const fnAbi = findFunctionInAbi(req.abi, req.funcName);
        if (!fnAbi) throw new Error(`function not found in ABI: ${req.funcName}`);
        const args = parseArgs(req.argsRaw, fnAbi.inputs ?? []);
        const entry: TxLogEntry = {
          id: makeId(),
          kind: 'send',
          contractName: this.instanceNameFor(req.address) ?? shortenAddr(req.address),
          funcName: req.funcName,
          status: 'pending',
          toAddress: req.address,
          fromAddress: this.activeFromAddress(),
          valueWei: req.valueWei,
          networkLabel: this.network.name,
          at: Date.now(),
        };
        this.appendTx(entry);
        try {
          const result = await sendTransaction({
            rpcUrl,
            signer,
            to: req.address,
            abi: req.abi,
            funcName: req.funcName,
            args,
            value: req.valueWei !== undefined ? BigInt(req.valueWei) : undefined,
            gasLimit: req.gasLimit !== undefined ? BigInt(req.gasLimit) : undefined,
          });
          this.updateTx(entry.id, {
            status: result.status === 'success' ? 'success' : 'reverted',
            txHash: result.txHash,
            blockNumber: result.blockNumber,
            gasUsed: result.gasUsed,
            decodedEvents: result.decodedLogs,
          });
          this.pushStatus();
          return { kind: 'sendResult', payload: { txEntry: this.findTx(entry.id)! } };
        } catch (err) {
          const message = decodeRevert(req.abi, err);
          this.updateTx(entry.id, { status: 'error', errorMessage: message });
          this.pushStatus();
          throw new Error(message);
        }
      }

      case 'loadAtAddress': {
        const contract = this.contractsByKey.get(req.contractKey);
        if (!contract) throw new Error(`contract not found: ${req.contractKey}`);
        if (!contract.abi || contract.abi.length === 0) {
          throw new Error(
            `${contract.name} has no ABI — build the project first so we can interact with it.`
          );
        }
        const { isAddress } = await import('ethers');
        if (!isAddress(req.address)) throw new Error(`invalid address: ${req.address}`);
        const instance: DeployedInstance = {
          id: makeId(),
          name: contract.name,
          address: req.address,
          network: this.network.kind,
          abi: contract.abi,
          deployedAt: Date.now(),
          fromKey: contract.key,
        };
        this.instances = [...this.instances, instance];
        this.pushStatus();
        return { kind: 'status', payload: this.currentStatus() };
      }

      case 'removeInstance': {
        this.instances = this.instances.filter((i) => i.id !== req.instanceId);
        this.pushStatus();
        return { kind: 'ok' };
      }

      case 'clearTxLog': {
        this.txLog = [];
        this.pushStatus();
        return { kind: 'ok' };
      }

      default: {
        const _exhaustive: never = req;
        return { kind: 'error', message: `unhandled request: ${JSON.stringify(_exhaustive)}` };
      }
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private async refreshContracts(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      this.contracts = [];
      this.contractsByKey = new Map();
      this.scripts = [];
      this.scriptsByKey = new Map();
      this.pushStatus();
      return;
    }
    let found: DiscoveredContract[];
    try {
      found = await discoverWorkspace(root);
    } catch {
      found = [];
    }
    // Discover scripts in parallel — small fs walk, no I/O bottleneck.
    try {
      const scripts = await discoverScripts(root);
      this.scripts = scripts;
      this.scriptsByKey = new Map(scripts.map((s) => [s.key, s]));
    } catch {
      this.scripts = [];
      this.scriptsByKey = new Map();
    }
    // Preserve transient buildStates ('building' / 'failed') that the on-disk
    // discovery doesn't capture.
    const prev = this.contractsByKey;
    for (const c of found) {
      const old = prev.get(c.key);
      if (old?.buildState === 'building') c.buildState = 'building';
      if (old?.buildState === 'failed' && !c.abi) {
        c.buildState = 'failed';
        c.lastError = old.lastError;
      }
    }
    this.contracts = found;
    this.contractsByKey = new Map(found.map((c) => [c.key, c]));
    this.pushStatus();
  }

  private async buildOne(projectRoot: string): Promise<void> {
    if (this.buildingProjects.has(projectRoot)) return;
    this.buildingProjects.add(projectRoot);

    // Mark every contract under this project as 'building' for UI feedback.
    for (const c of this.contracts) {
      if (c.projectRoot === projectRoot && c.buildState !== 'built') {
        c.buildState = 'building';
        c.lastError = undefined;
      }
    }
    this.pushStatus();

    const kind: ProjectKind = detectProjectKind(projectRoot);
    void this.sendEvent({
      kind: 'buildStarted',
      projectRoot,
      // User-facing label; the actual command used is an implementation detail.
      command: kind === 'hardhat' ? 'Compiling (Hardhat)' : kind === 'foundry' ? 'Compiling (Foundry)' : 'Compiling',
    });

    // Clear stale diagnostics for any file under this project before re-running.
    this.clearBuildDiagnosticsForProject(projectRoot);

    // Accumulate every line so we can re-parse the entire output post-mortem.
    // Solc's rich error format spans 3–5 lines per issue, so per-line parsing
    // would miss the location-pairing logic.
    const fullOutput: string[] = [];

    const result = await runBuild({
      projectRoot,
      kind,
      onLine: (line, stream) => {
        fullOutput.push(line);
        void this.sendEvent({ kind: 'buildLog', projectRoot, stream, line });
      },
    });

    void this.sendEvent({
      kind: 'buildFinished',
      projectRoot,
      ok: result.ok,
      durationMs: result.durationMs,
      error: result.errorMessage,
    });

    if (!result.ok) {
      for (const c of this.contracts) {
        if (c.projectRoot === projectRoot && c.buildState === 'building') {
          c.buildState = 'failed';
          c.lastError = result.errorMessage;
        }
      }
      // Parse + publish diagnostics so the user sees red squigglies in their
      // .sol files and a Problems-panel entry that jumps to the exact line.
      this.publishBuildDiagnostics(projectRoot, fullOutput.join('\n'));
    }

    this.buildingProjects.delete(projectRoot);
    // Re-discover artifacts so the panel picks up freshly built ones.
    await this.refreshContracts();
  }

  private clearBuildDiagnosticsForProject(projectRoot: string): void {
    const root = projectRoot.toLowerCase();
    const toClear: vscode.Uri[] = [];
    this.buildDiagnostics.forEach((uri) => {
      if (uri.fsPath.toLowerCase().startsWith(root)) toClear.push(uri);
    });
    for (const uri of toClear) this.buildDiagnostics.delete(uri);
  }

  private publishBuildDiagnostics(projectRoot: string, output: string): void {
    const parsed = parseBuildDiagnostics(output, projectRoot);
    if (parsed.length === 0) return;
    const byFile = groupByFile(parsed);
    for (const [filePath, items] of byFile) {
      const uri = vscode.Uri.file(filePath);
      const diags = items.map((p) => {
        const lineIdx = Math.max(0, p.line - 1);
        const colIdx = Math.max(0, p.column - 1);
        // Single-character range at the start of the location — VS Code shows
        // a squiggly under that character and the message in the Problems panel.
        const range = new vscode.Range(lineIdx, colIdx, lineIdx, colIdx + 1);
        const severity =
          p.severity === 'warning'
            ? vscode.DiagnosticSeverity.Warning
            : p.severity === 'info'
              ? vscode.DiagnosticSeverity.Information
              : vscode.DiagnosticSeverity.Error;
        const d = new vscode.Diagnostic(range, p.message, severity);
        d.source = '0xtools';
        if (p.code) d.code = p.code;
        return d;
      });
      this.buildDiagnostics.set(uri, diags);
    }
  }

  private activeFromAddress(): string | undefined {
    const sel = this.accountSelection;
    if (sel.kind === 'anvil') return this.getAnvil().getAccounts()[sel.index]?.address;
    if (sel.kind === 'keystore') {
      // We pulled the address into the selection itself when the user picked it.
      return sel.address;
    }
    return undefined;
  }

  private instanceNameFor(address: string): string | undefined {
    return this.instances.find((i) => i.address.toLowerCase() === address.toLowerCase())?.name;
  }

  private activeRpcUrl(): string {
    if (this.network.kind === 'anvil') {
      const anvil = this.getAnvil();
      if (!anvil.isRunning()) throw new Error('anvil is not running');
      return anvil.getRpcUrl();
    }
    if (!this.network.rpcUrl) throw new Error(`no RPC URL configured for ${this.network.name}`);
    return this.network.rpcUrl;
  }

  private balanceCacheKey(name: string, chainId: number): string {
    return `${name}::${chainId}`;
  }

  private async refreshBalanceFor(
    keystoreName: string,
    opts: { force?: boolean } = {}
  ): Promise<void> {
    if (this.network.kind === 'anvil' || !this.network.chainId) return;
    const raw = listKeystores().find((k) => k.name === keystoreName);
    if (!raw) return;
    const address = raw.address || this.addressOverlay.get(keystoreName) || '';
    if (!address) return; // address still unknown — wait for an unlock to learn it
    const key = this.balanceCacheKey(keystoreName, this.network.chainId);
    this.balanceStatusByKey.set(key, 'fetching');
    this.balanceErrorByKey.delete(key);
    this.pushStatus();

    const result = await fetchBalance(address, this.network, { force: opts.force });
    if (result.ok && result.balance) {
      this.balanceByKey.set(key, result.balance);
      this.balanceStatusByKey.set(key, 'ok');
      this.balanceErrorByKey.delete(key);
    } else {
      this.balanceStatusByKey.set(key, 'error');
      this.balanceErrorByKey.set(key, result.error ?? 'unknown error');
    }
    this.pushStatus();
  }

  private async runOneScript(scriptKey: string, hardhatNetwork?: string): Promise<void> {
    if (this.runningScripts.has(scriptKey)) return;
    const script = this.scriptsByKey.get(scriptKey);
    if (!script) throw new Error(`script not found: ${scriptKey}`);

    this.runningScripts.add(scriptKey);
    this.scriptRunStates.set(scriptKey, 'running');
    this.pushStatus();
    void this.sendEvent({ kind: 'scriptStarted', scriptKey });

    let rpcUrl: string;
    try {
      rpcUrl = this.activeRpcUrl();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.runningScripts.delete(scriptKey);
      this.scriptRunStates.set(scriptKey, 'error');
      this.scriptResults.set(scriptKey, { error: message, deployed: [], txHashes: [], durationMs: 0 });
      this.pushStatus();
      void this.sendEvent({
        kind: 'scriptFinished',
        scriptKey,
        ok: false,
        durationMs: 0,
        error: message,
        deployed: [],
        txHashes: [],
      });
      return;
    }

    // Resolve the signer source. Foundry scripts need a private key or
    // keystore; Hardhat scripts may use the project's hardhat.config network
    // accounts, so 'none' is acceptable for them.
    let signer:
      | { kind: 'privateKey'; privateKey: string }
      | { kind: 'keystore'; name: string; password: string }
      | { kind: 'none' };
    try {
      const src = await this.resolveSignerSource();
      if (src.kind === 'privateKey') signer = { kind: 'privateKey', privateKey: src.privateKey };
      else signer = { kind: 'keystore', name: this.accountSelection.kind === 'keystore' ? this.accountSelection.name : '', password: src.password };
    } catch {
      // Hardhat: fall back to 'none' so user's hardhat.config can provide accounts.
      signer = { kind: 'none' };
    }

    const result = await runScript({
      script,
      rpcUrl,
      networkLabel: this.network.name,
      hardhatNetwork,
      signer,
      onLine: (line, stream) => {
        void this.sendEvent({ kind: 'scriptLog', scriptKey, stream, line });
      },
    });

    this.runningScripts.delete(scriptKey);
    this.scriptRunStates.set(scriptKey, result.ok ? 'success' : 'error');
    this.scriptResults.set(scriptKey, {
      error: result.errorMessage,
      deployed: result.deployedContracts.map((c) => c.address),
      txHashes: result.txHashes,
      durationMs: result.durationMs,
    });

    // Append a tx-log entry summarising the script run so it shows in the receipt feed.
    const summaryTx: TxLogEntry = {
      id: makeId(),
      kind: 'send',
      contractName: `script: ${script.name}`,
      funcName: 'run',
      status: result.ok ? 'success' : 'error',
      deployedAddress: result.deployedContracts[0]?.address,
      txHash: result.txHashes[0],
      networkLabel: this.network.name,
      errorMessage: result.ok ? undefined : result.errorMessage,
      at: Date.now(),
    };
    this.appendTx(summaryTx);

    // For each deployed address, also try to register it as a DeployedInstance
    // so the user can interact with it. We don't know the ABI yet, so this
    // step is best-effort — find a matching built contract with that address.
    for (const dc of result.deployedContracts) {
      // Heuristic: don't auto-add — we can't tell which contract the script
      // deployed. The user can use "At Address" to load it manually with the
      // correct ABI. We still surface the address in the tx log for copy/paste.
      void dc;
    }

    void this.sendEvent({
      kind: 'scriptFinished',
      scriptKey,
      ok: result.ok,
      durationMs: result.durationMs,
      error: result.errorMessage,
      deployed: result.deployedContracts.map((c) => c.address),
      txHashes: result.txHashes,
    });
    this.pushStatus();
  }

  private async refreshAllBalancesForCurrentNetwork(
    opts: { force?: boolean } = {}
  ): Promise<void> {
    if (this.network.kind === 'anvil' || !this.network.chainId) return;
    // Fetch only the currently selected keystore for now — fanning out to all
    // keystores would be wasteful (most users have 1-2 and only one is active).
    // The other keystores still get their balance lazy-fetched when selected.
    if (this.accountSelection.kind === 'keystore') {
      await this.refreshBalanceFor(this.accountSelection.name, opts);
    }
  }

  private async resolveSignerSource(): Promise<SignerSource> {
    const sel = this.accountSelection;
    if (sel.kind === 'anvil') {
      const acc = this.getAnvil().getAccounts()[sel.index];
      if (!acc) throw new Error('selected anvil account is unavailable');
      return { kind: 'privateKey', privateKey: acc.privateKey };
    }
    if (sel.kind === 'keystore') {
      const pwd = takePassword(sel.name);
      if (!pwd) throw new Error(`keystore "${sel.name}" is locked — unlock it first`);
      const json = readKeystoreJson(this.keystorePathFor(sel.name));
      return { kind: 'keystore', json, password: pwd };
    }
    throw new Error('no account selected');
  }

  private keystorePathFor(name: string): string {
    // discovery validates these — but we still join here for the signing path
    return require('path').join(getDefaultKeystoreDir(), name);
  }

  private appendTx(entry: TxLogEntry): void {
    this.txLog = [entry, ...this.txLog].slice(0, TX_LOG_LIMIT);
    void this.sendEvent({ kind: 'txAppended', payload: entry });
  }

  private updateTx(id: string, patch: Partial<TxLogEntry>): void {
    this.txLog = this.txLog.map((e) => (e.id === id ? { ...e, ...patch } : e));
  }

  private findTx(id: string): TxLogEntry | undefined {
    return this.txLog.find((e) => e.id === id);
  }

  private currentStatus(): DeployRunStatus {
    const anvil = this.getAnvil();
    const state = anvil.getState();
    const chainId = this.network.chainId;
    const keystoreEntries: KeystoreInfo[] = listKeystores().map((k) => {
      // Overlay the address learned from a prior unlock when the keystore JSON
      // didn't include one (ethers-encrypted keystores often omit it).
      const effectiveAddress = k.address || this.addressOverlay.get(k.name) || '';
      const info: KeystoreInfo = {
        name: k.name,
        address: effectiveAddress,
        unlocked: isUnlocked(k.name),
      };
      if (chainId !== undefined && this.network.kind !== 'anvil') {
        const key = this.balanceCacheKey(k.name, chainId);
        const balance = this.balanceByKey.get(key);
        if (balance) info.balance = balance;
        const status = this.balanceStatusByKey.get(key);
        if (status) info.balanceStatus = status;
        const err = this.balanceErrorByKey.get(key);
        if (err) info.balanceError = err;
      }
      return info;
    });
    const contracts: ContractSummary[] = this.contracts.map((c) => ({
      key: c.key,
      name: c.name,
      file: c.file,
      sourcePath: c.sourcePath,
      projectRoot: c.projectRoot,
      projectType: c.projectType,
      abi: c.abi ?? [],
      hasBytecode: !!c.bytecode && c.bytecode.length > 2,
      buildState: c.buildState,
      lastError: c.lastError,
    }));

    const scriptSummaries: ScriptSummary[] = this.scripts.map((s) => {
      const runState = this.scriptRunStates.get(s.key) ?? 'idle';
      const result = this.scriptResults.get(s.key);
      return {
        key: s.key,
        name: s.name,
        relPath: s.relPath,
        projectRoot: s.projectRoot,
        projectType: s.projectType,
        kind: s.kind,
        runState,
        lastError: result?.error,
        lastDeployed: result?.deployed,
        lastTxHashes: result?.txHashes,
        lastDurationMs: result?.durationMs,
      };
    });

    const projectGroups = buildProjectGroups(contracts, scriptSummaries, this.buildingProjects);

    return {
      anvil: {
        available: true,
        running: anvil.isRunning(),
        port: state?.port,
        rpcUrl: state?.rpcUrl,
        chainId: state?.chainId,
        hardfork: this.selectedHardfork,
        accounts: (state?.accounts ?? []).map((a) => ({
          address: a.address,
          balance: a.balance,
          privateKeyAvailable: true,
        })),
      },
      selectedHardfork: this.selectedHardfork,
      network: this.network,
      account: this.accountSelection,
      contracts,
      projectGroups,
      instances: this.instances,
      keystores: keystoreEntries,
      txLog: this.txLog,
      buildingProjects: Array.from(this.buildingProjects),
      scripts: scriptSummaries,
    };
  }

  // ─── Message senders ───────────────────────────────────────────────────

  private async sendResponse(id: string, res: DeployRunResponse): Promise<void> {
    if (!this.view) return;
    const env: Envelope = { type: 'res', id, res };
    await this.view.webview.postMessage(env);
  }

  private async sendEvent(evt: DeployRunEvent): Promise<void> {
    if (!this.view) return;
    const env: Envelope = { type: 'evt', evt };
    await this.view.webview.postMessage(env);
  }

  // ─── HTML shell ────────────────────────────────────────────────────────

  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'deploy-run.js')
    );
    const nonce = crypto.randomBytes(16).toString('base64');
    const cspSource = webview.cspSource;

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${cspSource} data:; font-src ${cspSource};" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Deploy &amp; Run</title>
    <style>${PANEL_CSS}</style>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

function makeId(): string {
  return crypto.randomBytes(8).toString('hex');
}

function shortenAddr(a: string): string {
  if (!a || a.length < 14) return a || '';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function buildProjectGroups(
  contracts: ContractSummary[],
  scripts: ScriptSummary[],
  buildingProjects: Set<string>
): ProjectGroup[] {
  // Bucket contracts AND scripts by project root, so a project shows up even if
  // it only has scripts (no contracts compiled yet).
  const projects = new Set<string>();
  const contractsByProject = new Map<string, ContractSummary[]>();
  const scriptsByProject = new Map<string, ScriptSummary[]>();
  const projectTypeByRoot = new Map<string, ProjectGroup['projectType']>();

  for (const c of contracts) {
    projects.add(c.projectRoot);
    if (!projectTypeByRoot.has(c.projectRoot)) projectTypeByRoot.set(c.projectRoot, c.projectType);
    const list = contractsByProject.get(c.projectRoot) ?? [];
    list.push(c);
    contractsByProject.set(c.projectRoot, list);
  }
  for (const s of scripts) {
    projects.add(s.projectRoot);
    if (!projectTypeByRoot.has(s.projectRoot)) projectTypeByRoot.set(s.projectRoot, s.projectType);
    const list = scriptsByProject.get(s.projectRoot) ?? [];
    list.push(s);
    scriptsByProject.set(s.projectRoot, list);
  }

  const groups: ProjectGroup[] = [];
  for (const projectRoot of projects) {
    const projContracts = contractsByProject.get(projectRoot) ?? [];
    const projScripts = scriptsByProject.get(projectRoot) ?? [];

    // Merge by directory — same Map carries both contracts and scripts.
    const byDirMap = new Map<string, { contracts: ContractSummary[]; scripts: ScriptSummary[] }>();
    function bucket(dir: string): { contracts: ContractSummary[]; scripts: ScriptSummary[] } {
      let b = byDirMap.get(dir);
      if (!b) {
        b = { contracts: [], scripts: [] };
        byDirMap.set(dir, b);
      }
      return b;
    }
    for (const c of projContracts) {
      const dir = c.sourcePath ? path.dirname(c.sourcePath) : '(root)';
      bucket(dir).contracts.push(c);
    }
    for (const s of projScripts) {
      const dir = s.relPath ? path.dirname(s.relPath) : '(root)';
      bucket(dir).scripts.push(s);
    }

    const byDirectory = Array.from(byDirMap.entries())
      .map(([dir, { contracts, scripts }]) => ({
        dir,
        contracts: contracts.sort((a, b) => a.name.localeCompare(b.name)),
        scripts: scripts.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.dir.localeCompare(b.dir));

    const built = projContracts.filter((c) => c.buildState === 'built').length;
    groups.push({
      projectRoot,
      projectType: projectTypeByRoot.get(projectRoot) ?? 'solidity',
      byDirectory,
      built,
      total: projContracts.length,
      isBuilding: buildingProjects.has(projectRoot),
    });
  }
  return groups.sort((a, b) => a.projectRoot.localeCompare(b.projectRoot));
}

/**
 * Convert raw form strings into the typed JS array ethers expects.
 *  - argsRaw.length === inputs.length → normalize each
 *  - argsRaw.length === 1 && inputs.length > 1 → parseFunctionParams the single string
 *  - inputs.length === 0 → return []
 */
function parseArgs(argsRaw: string[], inputs: AbiParameter[]): unknown[] {
  if (inputs.length === 0) return [];
  if (argsRaw.length === 1 && inputs.length > 1) {
    return parseFunctionParams(argsRaw[0]);
  }
  if (argsRaw.length !== inputs.length) {
    throw new Error(`expected ${inputs.length} arg(s), got ${argsRaw.length}`);
  }
  return argsRaw.map((s) => {
    // For tuple/array types, route through parseFunctionParams to handle bracket syntax
    return normalizeParam(s);
  });
}

function findFunctionInAbi(abi: AbiEntry[], name: string): AbiEntry | undefined {
  return abi.find((e) => e.type === 'function' && e.name === name);
}

// Available built-in networks — re-exported for the webview side via the shared protocol
void BUILT_IN_NETWORKS;


// Themed via VS Code CSS variables — the palette flips with the active theme.
// Design direction: editor-native premium. Subtle 5px radius, hairline borders,
// soft accent pills, refined hover lift. A single accent color (VS Code's
// button-background) used sparingly. Status communicated through colored left
// rails on cards + tinted chips for events. Typography is proportional for prose,
// monospace for data — hierarchy through weight + tracking, not size jumps.
const PANEL_CSS = `
* { box-sizing: border-box; }
*:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, #007fd4);
  outline-offset: 1px;
  border-radius: 4px;
}
body {
  margin: 0;
  padding: 0;
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
  font-weight: var(--vscode-font-weight, 400);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* ─── Layout ─────────────────────────────────────────────────────── */
.panel {
  display: flex; flex-direction: column;
  gap: 18px;
  padding: 14px 12px 18px;
  min-width: 0;
}

/* ─── Panel header — refined wordmark with accent ────────────────── */
.panel-header {
  position: relative;
  display: flex; align-items: center; gap: 8px;
  padding: 0 0 12px;
  margin-bottom: 4px;
}
.panel-header::after {
  content: '';
  position: absolute; left: 0; right: 0; bottom: 0; height: 1px;
  background: linear-gradient(
    to right,
    var(--vscode-button-background, var(--vscode-focusBorder, #007fd4)) 0,
    var(--vscode-button-background, var(--vscode-focusBorder, #007fd4)) 32px,
    var(--vscode-editorWidget-border, transparent) 32px,
    var(--vscode-editorWidget-border, transparent) 100%
  );
  opacity: 0.5;
}
.panel-header .header-dot { display: none; }
.panel-header .title {
  font-family: var(--vscode-font-family);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--vscode-foreground);
}
.panel-header .title-accent {
  color: var(--vscode-descriptionForeground);
  font-weight: 400;
  font-size: 12px;
}

/* ─── Sections — small marker + clean label ──────────────────────── */
.section { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.section-title {
  display: flex; align-items: center; gap: 8px;
  margin: 4px 0 0;
  font-family: var(--vscode-font-family);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--vscode-foreground);
  padding-bottom: 6px;
  border-bottom: 1px solid var(--vscode-editorWidget-border, transparent);
}
.section-title::before {
  content: '';
  width: 5px; height: 5px; border-radius: 50%;
  background: var(--vscode-button-background, var(--vscode-focusBorder, #007fd4));
  flex-shrink: 0;
}
.section-title .count {
  color: var(--vscode-descriptionForeground);
  font-weight: 400;
  font-size: 10.5px;
}
.section-title .rule {
  flex: 1;
  height: 1px;
  background: linear-gradient(
    to right,
    var(--vscode-editorWidget-border, transparent),
    transparent 80%
  );
  margin: 0 4px;
  opacity: 0.5;
}
.section-title .right {
  display: flex; gap: 6px; align-items: center;
  margin-left: auto;
  font-family: var(--vscode-font-family);
  font-weight: 400;
  font-size: 11px;
}

/* ─── Generic ────────────────────────────────────────────────────── */
.row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.row-label {
  min-width: 64px;
  font-size: 11px;
  font-weight: 500;
  color: var(--vscode-descriptionForeground);
}
.muted { color: var(--vscode-descriptionForeground); }
.small { font-size: 11px; }
.mono { font-family: var(--vscode-editor-font-family, monospace); }
.hint {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.85;
  padding: 2px 10px;
  border-left: 2px solid var(--vscode-editorWidget-border, transparent);
  line-height: 1.45;
}

/* ─── Inputs — soft radius, subtle border ───────────────────────── */
.vsc-select, .vsc-input {
  flex: 1; min-width: 0;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border, transparent));
  border-radius: 5px;
  padding: 6px 9px;
  font-family: inherit;
  font-size: 12px;
  outline: none;
  transition: border-color 120ms ease, background 120ms ease, box-shadow 120ms ease;
}
.vsc-input::placeholder {
  color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground));
  opacity: 0.55;
}
.vsc-select:hover:not(:disabled),
.vsc-input:hover:not(:disabled) {
  border-color: var(--vscode-focusBorder, var(--vscode-foreground));
}
.vsc-select:focus, .vsc-input:focus {
  border-color: var(--vscode-focusBorder);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 18%, transparent);
}
.vsc-select:disabled, .vsc-input:disabled { opacity: 0.5; cursor: not-allowed; }

/* ─── Buttons — refined ─────────────────────────────────────────── */
.button-row { display: flex; gap: 6px; flex-wrap: wrap; }
.vsc-button {
  background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  border: 1px solid var(--vscode-button-border, var(--vscode-editorWidget-border, var(--vscode-input-border, transparent)));
  padding: 5px 12px;
  border-radius: 5px;
  cursor: pointer;
  font-family: inherit;
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: 0.01em;
  white-space: nowrap;
  transition: background 120ms ease, transform 80ms ease, border-color 120ms ease, color 120ms ease;
}
.vsc-button:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
  border-color: var(--vscode-focusBorder, var(--vscode-foreground));
}
.vsc-button:active:not(:disabled) { transform: translateY(1px); }
.vsc-button:disabled { opacity: 0.45; cursor: default; }
.vsc-button.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-color: transparent;
  font-weight: 600;
}
.vsc-button.primary:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
  border-color: transparent;
  box-shadow: 0 1px 6px color-mix(in srgb, var(--vscode-button-background) 35%, transparent);
}
.vsc-button.warning {
  background: transparent;
  color: var(--vscode-charts-yellow, #cca700);
  border-color: var(--vscode-charts-yellow, #cca700);
}
.vsc-button.warning:hover:not(:disabled) {
  background: color-mix(in srgb, var(--vscode-charts-yellow, #cca700) 14%, transparent);
}
.vsc-button.danger {
  background: transparent;
  color: var(--vscode-errorForeground, #f44747);
  border-color: var(--vscode-errorForeground, #f44747);
}
.vsc-button.danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--vscode-errorForeground, #f44747) 14%, transparent);
}
.vsc-button.small { padding: 3px 9px; font-size: 10.5px; border-radius: 4px; }
.vsc-button.cta {
  font-size: 12px;
  padding: 7px 16px;
  font-weight: 600;
  letter-spacing: 0.02em;
  border-radius: 6px;
}

/* ─── Status dot ────────────────────────────────────────────────── */
.status-dot {
  display: inline-block;
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--vscode-descriptionForeground);
  flex-shrink: 0;
  position: relative;
}
.status-dot.running {
  background: var(--vscode-charts-green, #4ec9b0);
  box-shadow: 0 0 8px color-mix(in srgb, var(--vscode-charts-green, #4ec9b0) 50%, transparent);
}
.status-dot.running::after {
  content: '';
  position: absolute; inset: -3px;
  border-radius: 50%;
  background: var(--vscode-charts-green, #4ec9b0);
  opacity: 0.35;
  animation: dot-pulse 2s ease-in-out infinite;
}
.status-dot.idle {
  background: var(--vscode-charts-red, #f44747);
  opacity: 0.65;
}
@keyframes dot-pulse {
  0%, 100% { transform: scale(1); opacity: 0.35; }
  50% { transform: scale(1.7); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .status-dot.running::after { animation: none; opacity: 0.25; }
}

/* ─── Environment pill ──────────────────────────────────────────── */
.env-pill {
  display: flex; align-items: center; gap: 9px;
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid var(--vscode-editorWidget-border, transparent);
  background: var(--vscode-input-background);
  font-size: 12px;
  position: relative;
  overflow: hidden;
  transition: border-color 120ms ease;
}
.env-pill::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
  background: var(--vscode-descriptionForeground);
  opacity: 0.55;
}
.env-pill.on::before { background: var(--vscode-charts-green, #4ec9b0); opacity: 1; }
.env-pill.off::before { background: var(--vscode-charts-red, #f44747); opacity: 0.7; }
.env-pill .env-name {
  font-weight: 600;
  color: var(--vscode-foreground);
  letter-spacing: 0.01em;
}
.env-pill .env-meta {
  color: var(--vscode-descriptionForeground);
  margin-left: auto;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
}

/* ─── Account list ──────────────────────────────────────────────── */
.accounts-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 2px; }
.account-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 6px 9px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11.5px;
  cursor: pointer;
  border-radius: 5px;
  border: 1px solid transparent;
  transition: background 120ms ease, border-color 120ms ease;
}
.account-row:hover {
  background: var(--vscode-list-hoverBackground);
  border-color: var(--vscode-editorWidget-border, transparent);
}
.account-row.selected {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}
.account-row .address { font-family: var(--vscode-editor-font-family, monospace); }
.address { font-family: var(--vscode-editor-font-family, monospace); }

/* ─── Balance chip ──────────────────────────────────────────────── */
.balance-chip {
  display: inline-flex; align-items: center;
  padding: 2px 8px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--vscode-foreground) 7%, transparent);
  color: var(--vscode-foreground);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.01em;
  white-space: nowrap;
}
.balance-chip.fetching {
  color: var(--vscode-charts-yellow, #cca700);
  background: color-mix(in srgb, var(--vscode-charts-yellow, #cca700) 14%, transparent);
  animation: chip-pulse 1.4s ease-in-out infinite;
}
.balance-chip.error {
  background: color-mix(in srgb, var(--vscode-errorForeground, #f44747) 14%, transparent);
  color: var(--vscode-errorForeground, #f44747);
  font-weight: 700;
  width: 18px;
  justify-content: center;
}
@keyframes chip-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) { .balance-chip.fetching { animation: none; } }

/* ─── Generic icon button ───────────────────────────────────────── */
.icon-btn {
  background: transparent;
  color: var(--vscode-icon-foreground, var(--vscode-foreground));
  border: 1px solid transparent;
  padding: 3px 7px;
  cursor: pointer;
  opacity: 0.55;
  border-radius: 4px;
  font-family: inherit;
  font-size: 11.5px;
  font-weight: 500;
  line-height: 1;
  transition: opacity 120ms ease, background 120ms ease, color 120ms ease;
}
.icon-btn:hover {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
}
.icon-btn.row-copy { font-size: 11px; }

/* ─── Active account chip ───────────────────────────────────────── */
.account-chip {
  display: flex; align-items: center; gap: 9px;
  padding: 8px 12px;
  border: 1px solid var(--vscode-editorWidget-border, transparent);
  border-radius: 6px;
  background: var(--vscode-input-background);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11.5px;
  position: relative;
  overflow: hidden;
  min-width: 0;
  transition: border-color 120ms ease;
}
.account-chip:hover { border-color: var(--vscode-focusBorder, var(--vscode-foreground)); }
.account-chip::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
  background: var(--vscode-descriptionForeground);
}
.account-chip.on::before {
  background: var(--vscode-charts-green, #4ec9b0);
  box-shadow: 0 0 8px color-mix(in srgb, var(--vscode-charts-green, #4ec9b0) 35%, transparent);
}
.account-chip.locked::before {
  background: var(--vscode-charts-yellow, #cca700);
}
.account-chip .chip-icon { font-size: 12px; flex-shrink: 0; }
.account-chip .chip-name {
  font-weight: 600;
  font-family: var(--vscode-font-family);
  font-size: 11.5px;
  letter-spacing: 0.01em;
  flex-shrink: 0;
  max-width: 90px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.account-chip .chip-addr {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10.5px;
  color: var(--vscode-descriptionForeground);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.account-chip .chip-bal {
  margin-left: auto;
  padding: 2px 8px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--vscode-foreground) 7%, transparent);
  color: var(--vscode-foreground);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
}
.account-chip .chip-bal.fetching {
  color: var(--vscode-charts-yellow, #cca700);
  background: color-mix(in srgb, var(--vscode-charts-yellow, #cca700) 14%, transparent);
  animation: chip-pulse 1.4s ease-in-out infinite;
}
.account-chip .chip-bal.error {
  background: color-mix(in srgb, var(--vscode-errorForeground, #f44747) 14%, transparent);
  color: var(--vscode-errorForeground, #f44747);
}

/* ─── Contract tree ─────────────────────────────────────────────── */
.contract-tree {
  display: flex; flex-direction: column;
  border: 1px solid var(--vscode-editorWidget-border, transparent);
  border-radius: 6px;
  overflow: hidden;
  background: var(--vscode-input-background);
}
.proj-group {
  border-bottom: 1px solid var(--vscode-editorWidget-border, transparent);
}
.proj-group:last-child { border-bottom: none; }
.proj-header {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 10px;
  cursor: pointer; user-select: none;
  background: transparent;
  transition: background 120ms ease;
}
.proj-header:hover { background: var(--vscode-list-hoverBackground); }
.proj-header .proj-name {
  font-weight: 600;
  font-size: 12px;
  letter-spacing: 0.01em;
  color: var(--vscode-foreground);
}
.proj-header .proj-tag {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 1px 6px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
  color: var(--vscode-descriptionForeground);
}
.proj-header .proj-count {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10.5px;
  color: var(--vscode-descriptionForeground);
}
.dir-group { padding: 0; }
.dir-header {
  display: flex; align-items: center; gap: 5px;
  padding: 4px 12px;
  color: var(--vscode-descriptionForeground);
  cursor: pointer; user-select: none;
  font-size: 11px;
  font-weight: 500;
  background: transparent;
  transition: background 120ms ease, color 120ms ease;
}
.dir-header:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
.contract-list { list-style: none; padding: 0; margin: 0; }
.contract-row {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 10px 4px 22px;
  cursor: pointer;
  font-size: 11.5px;
  border-left: 2px solid transparent;
  transition: background 120ms ease, border-color 120ms ease;
  min-width: 0;
}
.contract-row:hover {
  background: var(--vscode-list-hoverBackground);
  border-left-color: var(--vscode-button-background, var(--vscode-focusBorder));
}
.contract-row.selected {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
  border-left-color: var(--vscode-list-activeSelectionForeground);
}
.contract-row .contract-name {
  font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.contract-row .file-suffix {
  margin-left: auto;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
  flex-shrink: 0;
}
.caret {
  width: 11px;
  text-align: center;
  color: var(--vscode-descriptionForeground);
  font-size: 10px;
  opacity: 0.7;
  flex-shrink: 0;
}

/* ─── Build badges — soft colored circles ───────────────────────── */
.build-badge {
  display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px;
  border-radius: 50%;
  font-size: 9.5px;
  font-weight: 700;
  flex-shrink: 0;
}
.build-badge.badge-ok {
  background: color-mix(in srgb, var(--vscode-charts-green, #4ec9b0) 20%, transparent);
  color: var(--vscode-charts-green, #4ec9b0);
}
.build-badge.badge-err {
  background: color-mix(in srgb, var(--vscode-errorForeground, #f44747) 18%, transparent);
  color: var(--vscode-errorForeground, #f44747);
}
.build-badge.badge-info {
  background: color-mix(in srgb, var(--vscode-charts-yellow, #cca700) 18%, transparent);
  color: var(--vscode-charts-yellow, #cca700);
  animation: badge-spin 1.4s linear infinite;
}
.build-badge.badge-muted {
  color: var(--vscode-descriptionForeground);
  background: color-mix(in srgb, var(--vscode-foreground) 7%, transparent);
}
@keyframes badge-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .build-badge.badge-info { animation: none; } }

/* ─── Selected contract chip ────────────────────────────────────── */
.selected-chip {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-editorWidget-border, transparent);
  border-radius: 6px;
  font-size: 11.5px;
}
.selected-chip::before {
  content: '▸';
  color: var(--vscode-button-background, var(--vscode-focusBorder, #007fd4));
  font-size: 10px;
}
.selected-chip .selected-name {
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--vscode-foreground);
  font-family: var(--vscode-editor-font-family, monospace);
}
.selected-chip .selected-path {
  color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10.5px;
  margin-left: auto;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* ─── Instance card — soft elevation, status rail ───────────────── */
.instance-card {
  border: 1px solid var(--vscode-editorWidget-border, transparent);
  border-radius: 6px;
  background: var(--vscode-input-background);
  margin-bottom: 8px;
  overflow: hidden;
  position: relative;
  transition: border-color 150ms ease, transform 150ms ease, box-shadow 150ms ease;
}
.instance-card::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
  background: var(--vscode-charts-green, #4ec9b0);
  opacity: 0.8;
}
.instance-card:hover {
  border-color: var(--vscode-focusBorder, var(--vscode-foreground));
  transform: translateY(-1px);
  box-shadow: 0 2px 8px color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
}
.instance-header {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px 8px 14px;
  cursor: pointer; user-select: none;
  background: transparent;
}
.instance-header:hover { background: var(--vscode-list-hoverBackground); }
.instance-header .name {
  font-weight: 600;
  font-size: 12px;
  letter-spacing: 0.01em;
  color: var(--vscode-foreground);
  flex-shrink: 0;
}
.instance-header .at-divider {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.5;
  flex-shrink: 0;
}
.instance-header .addr {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10.5px;
  color: var(--vscode-descriptionForeground);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.instance-header .icon-btn {
  opacity: 0.55;
  flex-shrink: 0;
}
.instance-header .instance-net-tag {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 1px 6px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
  color: var(--vscode-descriptionForeground);
  flex-shrink: 0;
  white-space: nowrap;
}
.instance-body {
  padding: 10px 12px;
  display: flex; flex-direction: column; gap: 5px;
  border-top: 1px solid var(--vscode-editorWidget-border, transparent);
  background: color-mix(in srgb, var(--vscode-editor-background) 60%, transparent);
}

.other-networks {
  margin-top: 8px;
  padding-top: 10px;
  border-top: 1px dashed var(--vscode-editorWidget-border, transparent);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.other-networks .vsc-button { align-self: flex-start; }

/* ─── Script rows (rendered inline in the contracts tree) ────────── */
.contract-row.script-row {
  cursor: default;
}
.contract-row.script-row:hover {
  border-left-color: var(--vscode-charts-yellow, #cca700);
}
.contract-row.script-row .vsc-button { padding: 2px 9px; }
.script-kind-tag {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 1px 5px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--vscode-charts-yellow, #cca700) 18%, transparent);
  color: var(--vscode-charts-yellow, #cca700);
  flex-shrink: 0;
}
.script-duration {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10px;
  flex-shrink: 0;
}

/* ─── Function rows ─────────────────────────────────────────────── */
.fn-row {
  display: flex; gap: 5px;
  align-items: stretch;
  min-width: 0;
}
.fn-row .fn-btn {
  min-width: 100px;
  max-width: 160px;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--vscode-editor-font-family, monospace);
  font-weight: 600;
  font-size: 11px;
  letter-spacing: 0;
  border-radius: 4px;
}
.fn-row .fn-btn.view {
  background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 20%, transparent);
  color: var(--vscode-charts-blue, #3794ff);
  border-color: transparent;
}
.fn-row .fn-btn.view:hover:not(:disabled) {
  background: var(--vscode-charts-blue, #3794ff);
  color: var(--vscode-button-foreground, #fff);
}
.fn-row .fn-btn.send {
  background: color-mix(in srgb, var(--vscode-charts-yellow, #cca700) 22%, transparent);
  color: var(--vscode-charts-yellow, #cca700);
  border-color: transparent;
}
.fn-row .fn-btn.send:hover:not(:disabled) {
  background: var(--vscode-charts-yellow, #cca700);
  color: var(--vscode-editor-background, #000);
}
.fn-row .fn-btn.payable {
  background: color-mix(in srgb, var(--vscode-errorForeground, #f44747) 18%, transparent);
  color: var(--vscode-errorForeground, #f44747);
  border-color: transparent;
}
.fn-row .fn-btn.payable:hover:not(:disabled) {
  background: var(--vscode-errorForeground, #f44747);
  color: var(--vscode-button-foreground, #fff);
}
.fn-row .fn-inline {
  flex: 1; min-width: 0;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11.5px;
}
.fn-row .caret-toggle {
  background: transparent;
  border: 1px solid var(--vscode-editorWidget-border, var(--vscode-input-border, transparent));
  color: var(--vscode-descriptionForeground);
  padding: 3px 7px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 10px;
  flex-shrink: 0;
  transition: border-color 120ms ease, color 120ms ease;
}
.fn-row .caret-toggle:hover {
  border-color: var(--vscode-focusBorder);
  color: var(--vscode-foreground);
}
.fn-expanded {
  display: flex; flex-direction: column; gap: 5px;
  padding: 8px 8px 8px 10px;
  border-left: 2px solid var(--vscode-button-background, var(--vscode-focusBorder, transparent));
  margin: 4px 0 6px 6px;
  background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent);
  border-radius: 0 4px 4px 0;
}
.fn-expanded .arg-row { display: flex; gap: 8px; align-items: center; min-width: 0; }
.fn-expanded .arg-label {
  min-width: 80px;
  max-width: 110px;
  font-size: 10.5px;
  color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-editor-font-family, monospace);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  flex-shrink: 0;
}
.fn-result {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10.5px;
  background: var(--vscode-textCodeBlock-background, var(--vscode-input-background));
  padding: 6px 9px;
  border-radius: 5px;
  margin: 2px 0;
  white-space: pre-wrap;
  word-break: break-all;
  border-left: 2px solid var(--vscode-editorWidget-border, transparent);
}
.fn-result.error {
  color: var(--vscode-errorForeground);
  border-left-color: var(--vscode-errorForeground);
  background: color-mix(in srgb, var(--vscode-errorForeground, #f44747) 6%, var(--vscode-textCodeBlock-background, var(--vscode-input-background)));
}
.fn-result.success {
  border-left-color: var(--vscode-charts-green, #4ec9b0);
}

/* ─── Low-level interactions ────────────────────────────────────── */
.lowlevel {
  margin-top: 10px;
  padding: 10px 0 0;
  border-top: 1px dashed var(--vscode-editorWidget-border, transparent);
}
.lowlevel .ll-title {
  display: flex; align-items: center; gap: 6px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 7px;
}
.lowlevel .ll-title::before {
  content: '⌁';
  color: var(--vscode-charts-yellow, #cca700);
  font-size: 11px;
}

/* ─── Tx log — premium receipts ─────────────────────────────────── */
.tx-log {
  display: flex; flex-direction: column;
  gap: 6px;
  max-height: 400px;
  overflow-y: auto;
  padding-right: 2px;
}
.tx-log::-webkit-scrollbar { width: 8px; }
.tx-log::-webkit-scrollbar-thumb {
  background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.3));
  border-radius: 4px;
}
.tx-log::-webkit-scrollbar-thumb:hover {
  background: var(--vscode-scrollbarSlider-hoverBackground, rgba(128,128,128,0.5));
}

.tx-entry {
  position: relative;
  border: 1px solid var(--vscode-editorWidget-border, transparent);
  border-radius: 6px;
  background: var(--vscode-input-background);
  font-size: 11px;
  animation: tx-enter 200ms cubic-bezier(0.25, 0.46, 0.45, 0.94);
  transition: border-color 120ms ease;
  overflow: hidden;
  /* Critical: prevent the parent flex column from shrinking entries to fit
     max-height. Without this, collapsing an entry in the middle of a long
     list causes neighbouring entries to be sized down and visually overlap
     instead of letting the container scroll. */
  flex-shrink: 0;
}
.tx-entry:hover {
  border-color: var(--vscode-focusBorder, var(--vscode-foreground));
}
@keyframes tx-enter {
  from { opacity: 0; transform: translateY(-3px); }
  to   { opacity: 1; transform: translateY(0); }
}
.tx-entry::before {
  content: '';
  position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
  background: var(--vscode-descriptionForeground);
}
.tx-entry.pending::before {
  background: linear-gradient(
    180deg,
    var(--vscode-charts-yellow, #cca700) 0%,
    transparent 50%,
    var(--vscode-charts-yellow, #cca700) 100%
  );
  background-size: 100% 200%;
  animation: rail-scan 1.4s ease-in-out infinite;
}
.tx-entry.success::before {
  background: var(--vscode-charts-green, #4ec9b0);
  box-shadow: 0 0 8px color-mix(in srgb, var(--vscode-charts-green, #4ec9b0) 35%, transparent);
}
.tx-entry.reverted::before, .tx-entry.error::before {
  background: var(--vscode-errorForeground, #f44747);
}
@keyframes rail-scan {
  0% { background-position: 0% 0%; }
  100% { background-position: 0% 200%; }
}
@media (prefers-reduced-motion: reduce) {
  .tx-entry { animation: none; }
  .tx-entry.pending::before { animation: none; background: var(--vscode-charts-yellow, #cca700); }
}

.tx-head {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 10px 7px 14px;
  min-width: 0;
  cursor: pointer;
  user-select: none;
  transition: background 120ms ease;
}
.tx-head:hover { background: var(--vscode-list-hoverBackground); }
.tx-kind {
  display: inline-flex; align-items: center;
  padding: 2px 7px;
  border-radius: 10px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
  flex-shrink: 0;
  border: 1px solid transparent;
}
.tx-kind.kind-deploy {
  background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 18%, transparent);
  color: var(--vscode-charts-blue, #3794ff);
}
.tx-kind.kind-send {
  background: color-mix(in srgb, var(--vscode-charts-yellow, #cca700) 22%, transparent);
  color: var(--vscode-charts-yellow, #cca700);
}
.tx-kind.kind-call {
  background: color-mix(in srgb, var(--vscode-charts-purple, #b180d7) 20%, transparent);
  color: var(--vscode-charts-purple, #b180d7);
}

.tx-status-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 12px; height: 12px;
  font-size: 11px;
  flex-shrink: 0;
}
.tx-status-icon.s-success  { color: var(--vscode-charts-green, #4ec9b0); }
.tx-status-icon.s-reverted,
.tx-status-icon.s-error    { color: var(--vscode-errorForeground, #f44747); }
.tx-status-icon.s-pending  {
  color: var(--vscode-charts-yellow, #cca700);
  animation: spin 1.4s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .tx-status-icon.s-pending { animation: none; } }

.tx-label {
  font-family: var(--vscode-editor-font-family, monospace);
  font-weight: 500;
  color: var(--vscode-foreground);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  min-width: 0;
  flex: 1;
  font-size: 11.5px;
}
.tx-label .label-fn { color: var(--vscode-charts-green, #4ec9b0); font-weight: 600; }
.tx-label .label-ctor {
  color: var(--vscode-charts-blue, #3794ff);
  font-style: italic;
  font-weight: 500;
}
.tx-time {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.75;
  flex-shrink: 0;
  letter-spacing: 0.02em;
}
.tx-expand-caret {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  flex-shrink: 0;
  margin-left: 2px;
  opacity: 0.7;
}

/* Definition-list body for expanded entries */
.tx-body {
  border-top: 1px solid var(--vscode-editorWidget-border, transparent);
  padding: 9px 12px 11px 14px;
  display: grid;
  grid-template-columns: 70px 1fr;
  gap: 5px 10px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
  background: color-mix(in srgb, var(--vscode-editor-background) 50%, transparent);
}
.tx-body .dt {
  color: var(--vscode-descriptionForeground);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding-top: 2px;
}
.tx-body .dd {
  color: var(--vscode-foreground);
  min-width: 0;
  word-break: break-all;
  display: flex;
  align-items: center;
  gap: 6px;
}
.tx-body .dd .copy-inline {
  opacity: 0.4;
  font-size: 11px;
  cursor: pointer;
  background: transparent;
  border: none;
  color: inherit;
  padding: 0 3px;
  flex-shrink: 0;
  border-radius: 3px;
  transition: opacity 120ms ease, background 120ms ease;
}
.tx-body .dd .copy-inline:hover {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
}
.tx-body .dd.dd-address-deploy {
  font-weight: 600;
  color: var(--vscode-charts-green, #4ec9b0);
  font-size: 11.5px;
  letter-spacing: 0.01em;
}
.tx-body .dd.dd-gas { color: var(--vscode-foreground); }
.tx-body .dd.dd-status {
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 10.5px;
}
.tx-body .dd.dd-status.s-success  { color: var(--vscode-charts-green, #4ec9b0); }
.tx-body .dd.dd-status.s-reverted,
.tx-body .dd.dd-status.s-error    { color: var(--vscode-errorForeground, #f44747); }
.tx-body .dd.dd-status.s-pending  { color: var(--vscode-charts-yellow, #cca700); }

.tx-section {
  grid-column: 1 / -1;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--vscode-editorWidget-border, transparent);
  font-size: 9.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--vscode-descriptionForeground);
  display: flex;
  align-items: center;
  gap: 6px;
}
.tx-section::before {
  content: '';
  width: 5px; height: 5px; border-radius: 50%;
  background: var(--vscode-button-background, var(--vscode-focusBorder, #007fd4));
  flex-shrink: 0;
}
.tx-section.section-events::before { background: var(--vscode-charts-blue, #3794ff); }
.tx-section.section-revert::before { background: var(--vscode-errorForeground, #f44747); }
.tx-section.section-return::before { background: var(--vscode-charts-green, #4ec9b0); }
.tx-section.section-state::before  { background: var(--vscode-charts-yellow, #cca700); }

.tx-event-line {
  grid-column: 1 / -1;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10.5px;
  background: var(--vscode-textCodeBlock-background, transparent);
  padding: 5px 9px;
  border-left: 2px solid var(--vscode-charts-blue, #3794ff);
  border-radius: 0 4px 4px 0;
  white-space: pre-wrap;
  word-break: break-all;
}
.tx-event-line .ev-name {
  color: var(--vscode-charts-blue, #3794ff);
  font-weight: 600;
}
.tx-event-line .ev-args { color: var(--vscode-foreground); opacity: 0.9; }
.tx-event-line .ev-arg-key { color: var(--vscode-descriptionForeground); opacity: 0.7; }

.tx-return-block,
.tx-revert-block {
  grid-column: 1 / -1;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10.5px;
  padding: 6px 9px;
  background: var(--vscode-textCodeBlock-background, transparent);
  border-radius: 0 4px 4px 0;
  white-space: pre-wrap;
  word-break: break-all;
}
.tx-return-block { border-left: 2px solid var(--vscode-charts-green, #4ec9b0); }
.tx-revert-block {
  border-left: 2px solid var(--vscode-errorForeground, #f44747);
  color: var(--vscode-errorForeground, #f44747);
  background: color-mix(in srgb, var(--vscode-errorForeground, #f44747) 6%, var(--vscode-textCodeBlock-background, transparent));
}

/* ─── Tx log empty state ────────────────────────────────────────── */
.tx-empty {
  display: flex; flex-direction: column; align-items: center;
  gap: 12px;
  padding: 32px 14px 26px;
  color: var(--vscode-descriptionForeground);
  text-align: center;
  border: 1px dashed var(--vscode-editorWidget-border, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--vscode-foreground) 2%, transparent);
}
.tx-empty .empty-glyph {
  width: 52px; height: 52px;
  opacity: 0.4;
}
.tx-empty .empty-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--vscode-foreground);
}
.tx-empty .empty-hint {
  font-size: 11px;
  opacity: 0.7;
  max-width: 220px;
  line-height: 1.4;
}

/* ─── Error banner ──────────────────────────────────────────────── */
.error-banner {
  background: color-mix(in srgb, var(--vscode-errorForeground, #f44747) 10%, var(--vscode-input-background));
  color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground, #f44747));
  border: 1px solid var(--vscode-errorForeground, #be1100);
  border-left-width: 3px;
  padding: 8px 11px;
  border-radius: 6px;
  font-size: 11px;
  display: flex; gap: 9px; align-items: flex-start;
  font-family: var(--vscode-editor-font-family, monospace);
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}
.error-banner::before {
  content: '!';
  flex-shrink: 0;
  font-weight: 700;
  color: var(--vscode-errorForeground, #f44747);
  font-size: 14px;
  line-height: 1;
  padding-top: 1px;
}

/* ─── Footer ─────────────────────────────────────────────────────── */
.panel-footer {
  position: relative;
  display: flex; align-items: center; gap: 6px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10px;
  letter-spacing: 0.02em;
  padding: 10px 0 0;
  margin-top: 8px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
  border-top: 1px solid var(--vscode-editorWidget-border, transparent);
}

/* ─── Password modal ────────────────────────────────────────────── */
.modal-backdrop {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
  padding: 12px; z-index: 1000;
  animation: backdrop-fade 140ms ease-out;
}
@keyframes backdrop-fade { from { opacity: 0; } to { opacity: 1; } }
.modal {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-editorWidget-border, transparent);
  border-radius: 8px;
  padding: 16px;
  width: 100%; max-width: 340px;
  display: flex; flex-direction: column; gap: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
  animation: modal-rise 180ms cubic-bezier(0.25, 0.46, 0.45, 0.94);
}
@keyframes modal-rise {
  from { transform: translateY(10px) scale(0.97); opacity: 0; }
  to   { transform: translateY(0) scale(1); opacity: 1; }
}
.modal h4 {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--vscode-foreground);
  display: flex; align-items: center; gap: 8px;
}
.modal h4::before {
  content: '';
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--vscode-charts-yellow, #cca700);
  box-shadow: 0 0 8px color-mix(in srgb, var(--vscode-charts-yellow, #cca700) 50%, transparent);
}

/* ─── Loading skeleton ──────────────────────────────────────────── */
.skel-stack { display: flex; flex-direction: column; gap: 12px; padding: 14px 12px; }
.skel-bar {
  background: linear-gradient(
    90deg,
    var(--vscode-input-background) 0%,
    var(--vscode-list-hoverBackground) 50%,
    var(--vscode-input-background) 100%
  );
  background-size: 200% 100%;
  animation: skel-shimmer 1.8s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  border-radius: 5px;
  height: 12px;
}
.skel-bar.t  { height: 9px;  width: 30%; }
.skel-bar.b  { height: 28px; width: 100%; }
.skel-bar.s  { height: 14px; width: 70%; }
.skel-bar.xs { height: 9px;  width: 45%; }
@keyframes skel-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
@media (prefers-reduced-motion: reduce) { .skel-bar { animation: none; } }

/* ─── Narrow-width tweaks ───────────────────────────────────────── */
@media (max-width: 300px) {
  .panel { padding: 10px 8px 14px; gap: 14px; }
  .row-label { min-width: 52px; font-size: 10.5px; }
  .vsc-button { padding: 4px 9px; }
  .tx-body { grid-template-columns: 60px 1fr; gap: 4px 8px; }
  .fn-row .fn-btn { min-width: 84px; max-width: 124px; }
}
`;
