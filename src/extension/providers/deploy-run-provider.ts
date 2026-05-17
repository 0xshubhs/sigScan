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

    let timer: NodeJS.Timeout | undefined;
    const schedule = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void this.refreshContracts();
      }, 400);
    };

    for (const w of [solWatcher, fyAbiWatcher, hhAbiWatcher]) {
      w.onDidCreate(schedule);
      w.onDidChange(schedule);
      w.onDidDelete(schedule);
    }
    this.fileWatcher = vscode.Disposable.from(solWatcher, fyAbiWatcher, hhAbiWatcher);
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
        // Validate the password by attempting a decryption. We discard the wallet
        // and just cache the password (ethers re-decrypts on each signing call,
        // which is fine — ~1s scrypt cost amortized over a session of clicks).
        try {
          const json = readKeystoreJson(this.keystorePathFor(req.name));
          const { Wallet } = await import('ethers');
          await Wallet.fromEncryptedJson(json, req.password);
        } catch {
          return { kind: 'error', message: 'invalid password' };
        }
        storePassword(req.name, req.password, (req.ttlMinutes ?? 15) * 60 * 1000);
        this.pushStatus();
        // Unlock often immediately precedes a deploy/call — pre-warm the balance.
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
          contractName: req.address,
          funcName: req.funcName,
          status: 'pending',
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
          contractName: req.address,
          funcName: req.funcName,
          status: 'pending',
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
      this.pushStatus();
      return;
    }
    let found: DiscoveredContract[];
    try {
      found = await discoverWorkspace(root);
    } catch {
      found = [];
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
    const ks = listKeystores().find((k) => k.name === keystoreName);
    if (!ks) return;
    const key = this.balanceCacheKey(keystoreName, this.network.chainId);
    this.balanceStatusByKey.set(key, 'fetching');
    this.balanceErrorByKey.delete(key);
    this.pushStatus();

    const result = await fetchBalance(ks.address, this.network, { force: opts.force });
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
      const info: KeystoreInfo = {
        name: k.name,
        address: k.address,
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
    const projectGroups = buildProjectGroups(contracts, this.buildingProjects);

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

function buildProjectGroups(
  contracts: ContractSummary[],
  buildingProjects: Set<string>
): ProjectGroup[] {
  const byProject = new Map<string, ContractSummary[]>();
  for (const c of contracts) {
    const list = byProject.get(c.projectRoot) ?? [];
    list.push(c);
    byProject.set(c.projectRoot, list);
  }
  const groups: ProjectGroup[] = [];
  for (const [projectRoot, list] of byProject) {
    const byDirMap = new Map<string, ContractSummary[]>();
    for (const c of list) {
      const dir = c.sourcePath ? path.dirname(c.sourcePath) : '(root)';
      const arr = byDirMap.get(dir) ?? [];
      arr.push(c);
      byDirMap.set(dir, arr);
    }
    const byDirectory = Array.from(byDirMap.entries())
      .map(([dir, contracts]) => ({
        dir,
        contracts: contracts.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.dir.localeCompare(b.dir));
    const built = list.filter((c) => c.buildState === 'built').length;
    groups.push({
      projectRoot,
      projectType: list[0]?.projectType ?? 'solidity',
      byDirectory,
      built,
      total: list.length,
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

// Themed via VS Code CSS variables — palette flips with the active theme.
// Design direction: "Observability Terminal" — bracket-marker section headers,
// color-as-data status rails, monospace-forward typography, event-stream tx log.
const PANEL_CSS = `
* { box-sizing: border-box; }
*:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, #007fd4);
  outline-offset: 1px;
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

/* ─── Layout ────────────────────────────────────────────────────────── */
.panel {
  display: flex; flex-direction: column;
  gap: 14px;
  padding: 12px 12px 16px;
  min-width: 0;
}

.panel-header {
  position: relative;
  display: flex; align-items: baseline; gap: 8px;
  padding: 2px 0 10px;
  margin-bottom: 2px;
}
.panel-header::after {
  content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 1px;
  background: linear-gradient(
    to right,
    var(--vscode-charts-green, #4ec9b0) 0,
    var(--vscode-charts-green, #4ec9b0) 24px,
    var(--vscode-panel-border, var(--vscode-editorWidget-border, transparent)) 24px
  );
  opacity: 0.55;
}
.panel-header .title {
  font-size: 11px; font-weight: 700; letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--vscode-foreground);
}
.panel-header .title-accent {
  color: var(--vscode-descriptionForeground);
  font-weight: 500;
}
.panel-header .header-dot {
  position: relative; top: 1px;
}

/* ─── Sections — bracket-marker headers ───────────────────────────── */
.section { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.section-title {
  display: flex; align-items: center; gap: 6px;
  margin: 0;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10px; font-weight: 600; letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--vscode-descriptionForeground);
}
.section-title::before {
  content: '◆';
  color: var(--vscode-charts-green, #4ec9b0);
  font-size: 8px;
  opacity: 0.7;
}
.section-title .count {
  color: var(--vscode-descriptionForeground);
  font-weight: 400;
  opacity: 0.7;
}
.section-title .rule {
  flex: 1; height: 1px;
  background: linear-gradient(
    to right,
    var(--vscode-editorWidget-border, transparent) 0,
    transparent 100%
  );
  margin: 0 4px;
  opacity: 0.6;
}
.section-title .right {
  display: flex; gap: 4px; align-items: center;
  margin-left: auto;
  font-family: var(--vscode-font-family);
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
}

/* ─── Generic rows / labels ────────────────────────────────────────── */
.row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.row-label {
  min-width: 64px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  letter-spacing: 0.02em;
}
.muted { color: var(--vscode-descriptionForeground); }
.small { font-size: 11px; }
.mono { font-family: var(--vscode-editor-font-family, monospace); }
.hint {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10.5px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.85;
  padding-left: 2px;
}

/* ─── Inputs ───────────────────────────────────────────────────────── */
.vsc-select, .vsc-input {
  flex: 1; min-width: 0;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 2px;
  padding: 4px 6px;
  font-family: inherit;
  font-size: 12px;
  outline: none;
  transition: border-color 100ms ease, background 100ms ease;
}
.vsc-input::placeholder { color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground)); opacity: 0.6; }
.vsc-select:hover:not(:disabled), .vsc-input:hover:not(:disabled) {
  border-color: var(--vscode-inputOption-hoverBackground, var(--vscode-focusBorder));
}
.vsc-select:focus, .vsc-input:focus { border-color: var(--vscode-focusBorder); }
.vsc-select:disabled, .vsc-input:disabled { opacity: 0.55; cursor: not-allowed; }

/* ─── Buttons ──────────────────────────────────────────────────────── */
.button-row { display: flex; gap: 6px; flex-wrap: wrap; }
.vsc-button {
  background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  border: 1px solid var(--vscode-button-border, var(--vscode-input-border, transparent));
  padding: 4px 12px;
  border-radius: 2px;
  cursor: pointer;
  font-family: inherit;
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: 0.01em;
  transition: background 100ms ease, transform 80ms ease, border-color 100ms ease;
  white-space: nowrap;
}
.vsc-button:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
}
.vsc-button:active:not(:disabled) { transform: translateY(1px); }
.vsc-button:disabled { opacity: 0.45; cursor: default; }
.vsc-button.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-color: transparent;
  font-weight: 600;
}
.vsc-button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
.vsc-button.warning {
  background: var(--vscode-statusBarItem-warningBackground, #cca700);
  color: var(--vscode-statusBarItem-warningForeground, #000);
  border-color: transparent;
}
.vsc-button.danger {
  background: var(--vscode-statusBarItem-errorBackground, #f44747);
  color: var(--vscode-statusBarItem-errorForeground, #fff);
  border-color: transparent;
}
.vsc-button.small { padding: 2px 8px; font-size: 10.5px; }
.vsc-button.cta {
  position: relative;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-size: 11px;
  padding: 6px 14px;
}
.vsc-button.cta::before {
  content: ''; position: absolute; inset: 0; border-radius: 2px;
  background: linear-gradient(135deg, rgba(255,255,255,0.1), transparent 60%);
  pointer-events: none;
}

/* ─── Status dot — pulsing when active ────────────────────────────── */
.status-dot {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%;
  background: var(--vscode-descriptionForeground);
  position: relative;
  flex-shrink: 0;
}
.status-dot.running {
  background: var(--vscode-charts-green, #4ec9b0);
}
.status-dot.running::after {
  content: ''; position: absolute; inset: -3px; border-radius: 50%;
  background: var(--vscode-charts-green, #4ec9b0);
  opacity: 0.4;
  animation: dot-pulse 1.8s ease-in-out infinite;
}
.status-dot.idle {
  background: var(--vscode-charts-red, #f44747);
  opacity: 0.55;
}
@keyframes dot-pulse {
  0%, 100% { transform: scale(1); opacity: 0.35; }
  50% { transform: scale(1.6); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .status-dot.running::after { animation: none; opacity: 0.25; }
}

/* ─── Environment pill ────────────────────────────────────────────── */
.env-pill {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px;
  border-radius: 3px;
  border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border, #4f4f4f));
  background: var(--vscode-textCodeBlock-background, var(--vscode-input-background));
  font-size: 11.5px;
  position: relative;
  overflow: hidden;
}
.env-pill::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
  background: var(--vscode-descriptionForeground);
  opacity: 0.5;
}
.env-pill.on::before { background: var(--vscode-charts-green, #4ec9b0); opacity: 1; }
.env-pill.off::before { background: var(--vscode-charts-red, #f44747); opacity: 0.55; }
.env-pill .env-name {
  font-weight: 600;
  color: var(--vscode-foreground);
  letter-spacing: 0.01em;
}
.env-pill .env-meta {
  color: var(--vscode-descriptionForeground);
  margin-left: auto;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10.5px;
}

/* ─── Account list ────────────────────────────────────────────────── */
.accounts-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 1px; }
.account-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 5px 8px;
  border-radius: 2px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
  cursor: pointer;
  border-left: 2px solid transparent;
  transition: background 80ms ease, border-color 80ms ease;
}
.account-row:hover {
  background: var(--vscode-list-hoverBackground);
  border-left-color: var(--vscode-focusBorder);
}
.account-row.selected {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
  border-left-color: var(--vscode-list-activeSelectionForeground);
}
.account-row .address { font-family: var(--vscode-editor-font-family, monospace); }
.address { font-family: var(--vscode-editor-font-family, monospace); }

.balance-chip {
  display: inline-flex; align-items: center;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--vscode-badge-background, var(--vscode-input-background));
  color: var(--vscode-badge-foreground, var(--vscode-foreground));
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.01em;
  white-space: nowrap;
}

/* Generic icon-button base — scoped variants in instance-header / account-chip override */
.icon-btn {
  background: transparent;
  color: var(--vscode-icon-foreground, var(--vscode-foreground));
  border: 1px solid transparent;
  padding: 1px 5px;
  cursor: pointer;
  opacity: 0.55;
  border-radius: 2px;
  font-size: 11px;
  font-family: inherit;
  line-height: 1;
  transition: opacity 100ms ease, background 100ms ease, color 100ms ease;
}
.icon-btn:hover {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
}
.icon-btn.row-copy { font-size: 10.5px; }

/* ─── Active account chip ─────────────────────────────────────────── */
.account-chip {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px;
  border-radius: 3px;
  border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border, #4f4f4f));
  background: var(--vscode-textCodeBlock-background, var(--vscode-input-background));
  font-size: 11.5px;
  position: relative;
  overflow: hidden;
  min-width: 0;
}
.account-chip::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
  background: var(--vscode-descriptionForeground);
  opacity: 0.5;
}
.account-chip.on::before { background: var(--vscode-charts-green, #4ec9b0); opacity: 1; }
.account-chip.locked::before { background: var(--vscode-charts-yellow, #cca700); opacity: 1; }
.account-chip .chip-icon { font-size: 11px; flex-shrink: 0; }
.account-chip .chip-name {
  font-weight: 600;
  color: var(--vscode-foreground);
  letter-spacing: 0.01em;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
  flex-shrink: 0;
  max-width: 80px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.account-chip .chip-addr {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10.5px;
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  flex: 1;
  min-width: 0;
  transition: color 100ms ease;
}
.account-chip .chip-addr:hover { color: var(--vscode-foreground); }
.account-chip .chip-bal {
  margin-left: auto;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--vscode-badge-background, var(--vscode-input-background));
  color: var(--vscode-badge-foreground, var(--vscode-foreground));
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
}
.account-chip .chip-bal.fetching {
  opacity: 0.6;
  animation: chip-pulse 1.2s ease-in-out infinite;
  font-weight: 500;
}
.account-chip .chip-bal.error {
  background: var(--vscode-inputValidation-errorBackground, rgba(244,71,71,0.15));
  color: var(--vscode-errorForeground, #f44747);
  font-weight: 500;
}
.account-chip .icon-btn {
  background: transparent;
  color: var(--vscode-icon-foreground, var(--vscode-foreground));
  border: 1px solid transparent;
  padding: 2px 6px;
  cursor: pointer;
  opacity: 0.55;
  border-radius: 2px;
  font-size: 11px;
  transition: opacity 100ms ease, background 100ms ease;
  flex-shrink: 0;
}
.account-chip .icon-btn:hover {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
}
.balance-chip.fetching {
  opacity: 0.6;
  animation: chip-pulse 1.2s ease-in-out infinite;
}
.balance-chip.error {
  background: var(--vscode-inputValidation-errorBackground, rgba(244,71,71,0.15));
  color: var(--vscode-errorForeground, #f44747);
  font-weight: 700;
  width: 14px;
  justify-content: center;
}
@keyframes chip-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 0.8; }
}
@media (prefers-reduced-motion: reduce) {
  .balance-chip.fetching { animation: none; }
}

/* ─── Contract tree ───────────────────────────────────────────────── */
.contract-tree {
  display: flex; flex-direction: column; gap: 4px;
  background: var(--vscode-textCodeBlock-background, transparent);
  border: 1px solid var(--vscode-editorWidget-border, transparent);
  border-radius: 3px;
  padding: 4px;
}
.proj-group {
  border-radius: 2px;
  overflow: hidden;
}
.proj-group + .proj-group {
  margin-top: 2px;
  border-top: 1px dashed var(--vscode-editorWidget-border, transparent);
  padding-top: 2px;
}
.proj-header {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 6px;
  cursor: pointer; user-select: none;
  border-radius: 2px;
  transition: background 80ms ease;
}
.proj-header:hover { background: var(--vscode-list-hoverBackground); }
.proj-header .proj-name {
  font-weight: 600;
  color: var(--vscode-foreground);
  letter-spacing: 0.01em;
}
.proj-header .proj-tag {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 1px 6px;
  border-radius: 2px;
  background: var(--vscode-badge-background, var(--vscode-input-background));
  color: var(--vscode-badge-foreground, var(--vscode-descriptionForeground));
  opacity: 0.85;
}
.proj-header .proj-count {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10.5px;
  color: var(--vscode-descriptionForeground);
}
.dir-group { padding-left: 10px; }
.dir-header {
  display: flex; align-items: center; gap: 4px;
  padding: 3px 6px;
  color: var(--vscode-descriptionForeground);
  cursor: pointer; user-select: none;
  border-radius: 2px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
  transition: background 80ms ease;
}
.dir-header:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
.contract-list { list-style: none; padding: 0; margin: 0 0 0 18px; }
.contract-row {
  display: flex; align-items: center; gap: 8px;
  padding: 3px 6px;
  border-radius: 2px;
  cursor: pointer;
  font-size: 12px;
  border-left: 2px solid transparent;
  transition: background 80ms ease, border-color 80ms ease;
  min-width: 0;
}
.contract-row:hover {
  background: var(--vscode-list-hoverBackground);
  border-left-color: var(--vscode-focusBorder);
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
  width: 12px;
  text-align: center;
  color: var(--vscode-descriptionForeground);
  font-size: 9px;
  opacity: 0.7;
  flex-shrink: 0;
}

.build-badge {
  display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px;
  text-align: center; font-size: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.build-badge.badge-ok { color: var(--vscode-charts-green, #4ec9b0); }
.build-badge.badge-err { color: var(--vscode-errorForeground, #f44747); }
.build-badge.badge-info {
  color: var(--vscode-charts-yellow, #cca700);
  animation: badge-spin 1.4s linear infinite;
}
.build-badge.badge-muted { color: var(--vscode-descriptionForeground); opacity: 0.6; }
@keyframes badge-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) { .build-badge.badge-info { animation: none; } }

/* ─── Selected contract chip + value/gas row ──────────────────────── */
.selected-chip {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px;
  background: var(--vscode-textCodeBlock-background, var(--vscode-input-background));
  border: 1px solid var(--vscode-editorWidget-border, transparent);
  border-radius: 2px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11.5px;
  position: relative;
}
.selected-chip::before {
  content: '▸';
  color: var(--vscode-charts-green, #4ec9b0);
  font-size: 9px;
  opacity: 0.7;
}
.selected-chip .selected-name {
  font-weight: 600;
  color: var(--vscode-foreground);
}
.selected-chip .selected-path {
  color: var(--vscode-descriptionForeground);
  font-size: 10px;
  margin-left: auto;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* ─── Instance card ───────────────────────────────────────────────── */
.instance-card {
  border: 1px solid var(--vscode-editorWidget-border, transparent);
  border-radius: 4px;
  background: var(--vscode-editor-background);
  margin-bottom: 8px;
  overflow: hidden;
  transition: border-color 120ms ease, transform 120ms ease;
  position: relative;
}
.instance-card::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
  background: var(--vscode-charts-green, #4ec9b0);
  opacity: 0;
  transition: opacity 120ms ease;
}
.instance-card:hover {
  border-color: var(--vscode-focusBorder);
}
.instance-card:hover::before { opacity: 0.6; }
.instance-header {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px;
  cursor: pointer; user-select: none;
  background: var(--vscode-sideBarSectionHeader-background, transparent);
}
.instance-header:hover { background: var(--vscode-list-hoverBackground); }
.instance-header .name {
  font-weight: 600;
  color: var(--vscode-foreground);
  letter-spacing: 0.01em;
  flex-shrink: 0;
}
.instance-header .at-divider {
  font-size: 9px;
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
  background: transparent;
  color: var(--vscode-icon-foreground, var(--vscode-foreground));
  border: 1px solid transparent;
  padding: 2px 6px;
  cursor: pointer;
  opacity: 0.55;
  border-radius: 2px;
  font-size: 11px;
  transition: opacity 100ms ease, background 100ms ease, border-color 100ms ease;
  flex-shrink: 0;
}
.instance-header .icon-btn:hover {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
  border-color: var(--vscode-editorWidget-border, transparent);
}
.instance-body {
  padding: 8px 10px;
  display: flex; flex-direction: column; gap: 4px;
  border-top: 1px solid var(--vscode-editorWidget-border, transparent);
}
.instance-body > * + * {
  padding-top: 4px;
  border-top: 1px dashed transparent;
}

/* ─── Function rows ───────────────────────────────────────────────── */
.fn-row {
  display: flex; gap: 4px;
  align-items: stretch;
  min-width: 0;
}
.fn-row .fn-btn {
  min-width: 96px;
  max-width: 156px;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--vscode-editor-font-family, monospace);
  font-weight: 500;
  font-size: 11px;
  letter-spacing: 0;
}
.fn-row .fn-btn.view {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-color: transparent;
}
.fn-row .fn-btn.view:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
.fn-row .fn-btn.send {
  background: var(--vscode-statusBarItem-warningBackground, #cca700);
  color: var(--vscode-statusBarItem-warningForeground, #000);
  border-color: transparent;
}
.fn-row .fn-btn.payable {
  background: var(--vscode-statusBarItem-errorBackground, #f44747);
  color: var(--vscode-statusBarItem-errorForeground, #fff);
  border-color: transparent;
}
.fn-row .fn-inline { flex: 1; min-width: 0; font-family: var(--vscode-editor-font-family, monospace); }
.fn-row .caret-toggle {
  background: transparent;
  border: 1px solid var(--vscode-input-border, transparent);
  color: var(--vscode-descriptionForeground);
  padding: 2px 6px;
  border-radius: 2px;
  cursor: pointer;
  font-size: 10px;
  flex-shrink: 0;
}
.fn-row .caret-toggle:hover { border-color: var(--vscode-focusBorder); color: var(--vscode-foreground); }
.fn-expanded {
  display: flex; flex-direction: column; gap: 4px;
  padding: 6px 6px 6px 8px;
  border-left: 2px solid var(--vscode-editorWidget-border, transparent);
  margin: 4px 0 6px 6px;
  background: var(--vscode-textCodeBlock-background, transparent);
  border-radius: 0 2px 2px 0;
}
.fn-expanded .arg-row { display: flex; gap: 6px; align-items: center; min-width: 0; }
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
  padding: 4px 8px;
  border-radius: 2px;
  margin: 2px 0;
  white-space: pre-wrap;
  word-break: break-all;
  border-left: 2px solid var(--vscode-editorWidget-border, transparent);
}
.fn-result.error {
  color: var(--vscode-errorForeground);
  border-left-color: var(--vscode-errorForeground);
}
.fn-result.success {
  border-left-color: var(--vscode-charts-green, #4ec9b0);
}

/* ─── Low-level interactions sub-block ────────────────────────────── */
.lowlevel {
  margin-top: 8px;
  padding: 8px 0 0;
  border-top: 1px dashed var(--vscode-editorWidget-border, transparent);
}
.lowlevel .ll-title {
  display: flex; align-items: center; gap: 6px;
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 6px;
  font-family: var(--vscode-editor-font-family, monospace);
}
.lowlevel .ll-title::before {
  content: '⌁';
  color: var(--vscode-charts-yellow, #cca700);
  font-size: 11px;
}

/* ─── Tx Log — the centerpiece ────────────────────────────────────── */
.tx-log {
  display: flex; flex-direction: column;
  gap: 3px;
  max-height: 320px;
  overflow-y: auto;
  padding-right: 2px;
}
.tx-log::-webkit-scrollbar { width: 6px; }
.tx-log::-webkit-scrollbar-thumb {
  background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.3));
  border-radius: 3px;
}
.tx-log::-webkit-scrollbar-thumb:hover {
  background: var(--vscode-scrollbarSlider-hoverBackground, rgba(128,128,128,0.5));
}

.tx-entry {
  position: relative;
  display: flex; flex-direction: column;
  padding: 6px 8px 6px 14px;
  border-radius: 3px;
  background: var(--vscode-textCodeBlock-background, var(--vscode-input-background));
  border: 1px solid transparent;
  font-size: 11px;
  animation: tx-enter 180ms ease-out;
  transition: border-color 100ms ease;
  min-width: 0;
}
.tx-entry:hover {
  border-color: var(--vscode-editorWidget-border, transparent);
}
@keyframes tx-enter {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}
.tx-entry::before {
  content: '';
  position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
  background: var(--vscode-descriptionForeground);
  border-radius: 3px 0 0 3px;
}
.tx-entry.pending::before {
  background: linear-gradient(
    180deg,
    var(--vscode-charts-yellow, #cca700) 0%,
    transparent 50%,
    var(--vscode-charts-yellow, #cca700) 100%
  );
  background-size: 100% 200%;
  animation: rail-scan 1.2s ease-in-out infinite;
}
.tx-entry.success::before { background: var(--vscode-charts-green, #4ec9b0); }
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
  display: flex; align-items: center; gap: 6px;
  min-width: 0;
}
.tx-kind {
  display: inline-flex; align-items: center;
  padding: 1px 5px;
  border-radius: 2px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  flex-shrink: 0;
}
.tx-kind.kind-deploy {
  background: var(--vscode-charts-blue, #3794ff);
  color: var(--vscode-button-foreground, #fff);
}
.tx-kind.kind-send {
  background: var(--vscode-charts-yellow, #cca700);
  color: #000;
}
.tx-kind.kind-call {
  background: var(--vscode-charts-purple, #b180d7);
  color: var(--vscode-button-foreground, #fff);
}
.tx-status-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 12px; height: 12px;
  font-size: 10px;
  flex-shrink: 0;
}
.tx-status-icon.s-success { color: var(--vscode-charts-green, #4ec9b0); }
.tx-status-icon.s-reverted, .tx-status-icon.s-error { color: var(--vscode-errorForeground, #f44747); }
.tx-status-icon.s-pending {
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
}
.tx-label .label-fn { color: var(--vscode-charts-green, #4ec9b0); }
.tx-label .label-ctor { color: var(--vscode-charts-blue, #3794ff); font-style: italic; }
.tx-time {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
  flex-shrink: 0;
}

.tx-meta {
  display: flex; flex-wrap: wrap; gap: 4px 10px;
  margin-top: 4px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  align-items: center;
}
.tx-meta .meta-item {
  display: inline-flex; align-items: baseline; gap: 3px;
}
.tx-meta .meta-key {
  opacity: 0.55;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.tx-meta .meta-val { color: var(--vscode-foreground); opacity: 0.85; }
.tx-meta .meta-hash {
  font-size: 9.5px;
  opacity: 0.75;
  cursor: help;
}

.tx-events {
  display: flex; flex-wrap: wrap; gap: 3px;
  margin-top: 5px;
}
.tx-event {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 1px 6px 1px 5px;
  background: var(--vscode-badge-background, var(--vscode-input-background));
  color: var(--vscode-badge-foreground, var(--vscode-foreground));
  border-radius: 8px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 9.5px;
  font-weight: 500;
  opacity: 0.9;
}
.tx-event::before {
  content: '';
  width: 4px; height: 4px;
  border-radius: 50%;
  background: var(--vscode-charts-green, #4ec9b0);
  flex-shrink: 0;
}

.tx-error {
  margin-top: 5px;
  padding: 4px 6px;
  border-radius: 2px;
  background: var(--vscode-inputValidation-errorBackground, rgba(244,71,71,0.08));
  border-left: 2px solid var(--vscode-errorForeground, #f44747);
  color: var(--vscode-errorForeground, #f44747);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10.5px;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.4;
}

.tx-return {
  margin-top: 5px;
  padding: 4px 6px;
  border-radius: 2px;
  background: var(--vscode-textCodeBlock-background, var(--vscode-input-background));
  border-left: 2px solid var(--vscode-charts-green, #4ec9b0);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10.5px;
  white-space: pre-wrap;
  word-break: break-all;
}

/* ─── Tx log empty state ──────────────────────────────────────────── */
.tx-empty {
  display: flex; flex-direction: column; align-items: center;
  gap: 10px;
  padding: 28px 12px 24px;
  color: var(--vscode-descriptionForeground);
  text-align: center;
}
.tx-empty .empty-glyph {
  width: 56px; height: 56px;
  opacity: 0.45;
}
.tx-empty .empty-glyph circle.outer { animation: empty-pulse 3s ease-in-out infinite; transform-origin: center; }
.tx-empty .empty-glyph circle.mid   { animation: empty-pulse 3s ease-in-out 0.3s infinite; transform-origin: center; }
.tx-empty .empty-glyph circle.inner { animation: empty-pulse 3s ease-in-out 0.6s infinite; transform-origin: center; }
@keyframes empty-pulse {
  0%, 100% { opacity: 0.5; r: var(--r, 8); }
  50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .tx-empty .empty-glyph circle { animation: none; }
}
.tx-empty .empty-title {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  opacity: 0.7;
}
.tx-empty .empty-hint {
  font-size: 10.5px;
  opacity: 0.55;
  max-width: 220px;
}

/* ─── Error banner ────────────────────────────────────────────────── */
.error-banner {
  background: var(--vscode-inputValidation-errorBackground, rgba(244,71,71,0.08));
  color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground, #f44747));
  border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground, #be1100));
  border-left-width: 3px;
  padding: 8px 10px;
  border-radius: 2px;
  font-size: 11.5px;
  display: flex; gap: 8px; align-items: flex-start;
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
  font-size: 13px;
  line-height: 1;
  padding-top: 1px;
}

/* ─── Panel footer ────────────────────────────────────────────────── */
.panel-footer {
  position: relative;
  display: flex; align-items: center; gap: 6px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 9.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding-top: 10px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.65;
}
.panel-footer::before {
  content: ''; position: absolute; left: 0; right: 0; top: 0; height: 1px;
  background: linear-gradient(
    to right,
    transparent,
    var(--vscode-panel-border, var(--vscode-editorWidget-border, transparent)) 30%,
    var(--vscode-panel-border, var(--vscode-editorWidget-border, transparent)) 70%,
    transparent
  );
  opacity: 0.5;
}

/* ─── Password modal ──────────────────────────────────────────────── */
.modal-backdrop {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center;
  padding: 12px; z-index: 1000;
  animation: backdrop-fade 120ms ease-out;
}
@keyframes backdrop-fade { from { opacity: 0; } to { opacity: 1; } }
.modal {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-editorWidget-border, transparent);
  border-top: 2px solid var(--vscode-charts-yellow, #cca700);
  border-radius: 4px;
  padding: 14px;
  width: 100%; max-width: 320px;
  display: flex; flex-direction: column; gap: 10px;
  animation: modal-rise 160ms ease-out;
}
@keyframes modal-rise {
  from { transform: translateY(8px); opacity: 0; }
  to   { transform: translateY(0); opacity: 1; }
}
.modal h4 {
  margin: 0;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--vscode-foreground);
  display: flex; align-items: center; gap: 6px;
}
.modal h4::before {
  content: '◆';
  color: var(--vscode-charts-yellow, #cca700);
  font-size: 9px;
}

/* ─── Loading skeleton ────────────────────────────────────────────── */
.skel-stack { display: flex; flex-direction: column; gap: 12px; padding: 14px 12px; }
.skel-bar {
  background: linear-gradient(
    90deg,
    var(--vscode-input-background) 0%,
    var(--vscode-list-hoverBackground) 50%,
    var(--vscode-input-background) 100%
  );
  background-size: 200% 100%;
  animation: skel-shimmer 1.6s ease-in-out infinite;
  border-radius: 2px;
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
@media (prefers-reduced-motion: reduce) {
  .skel-bar { animation: none; }
}

/* ─── Narrow-width adjustments ────────────────────────────────────── */
@media (max-width: 300px) {
  .panel { padding: 10px 8px 12px; gap: 12px; }
  .row-label { min-width: 56px; font-size: 10.5px; }
  .vsc-button { padding: 4px 8px; }
  .tx-meta { gap: 3px 8px; }
  .fn-row .fn-btn { min-width: 80px; max-width: 120px; }
}
`;
