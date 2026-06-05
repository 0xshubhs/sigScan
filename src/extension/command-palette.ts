/**
 * Grouped Command Palette
 *
 * The extension contributes dozens of commands. Discovering them through the
 * native Command Palette means typing the `0xTools` prefix and scrolling a flat
 * list. This module adds a single entry point — `sigscan.showAllCommands` —
 * that presents every command grouped by feature category, with separators, so
 * users can browse the toolkit by what they want to do.
 *
 * The categorisation logic lives in a pure, vscode-free function
 * ({@link buildCommandGroups}) so it can be unit-tested in isolation. The
 * command list itself ({@link COMMANDS}) mirrors `contributes.commands` in
 * `package.json`; keep the two in sync when commands are added or removed.
 */

import * as vscode from 'vscode';

/** A single contributed command, paired with the category it belongs to. */
export interface CommandEntry {
  command: string;
  title: string;
  category: string;
}

/** A category and its commands, as produced by {@link buildCommandGroups}. */
export interface CommandGroup {
  category: string;
  items: CommandEntry[];
}

/**
 * Fixed display order for categories. Categories are rendered in this order;
 * anything not listed here falls to the end (before 'Other', which is always
 * last). This keeps the most common workflows near the top of the picker.
 */
const CATEGORY_ORDER: readonly string[] = [
  'Signatures',
  'Gas',
  'Security',
  'On-chain',
  'Deploy & Run',
  'Foundry/Hardhat',
  'Other',
];

/**
 * Every command contributed by the extension (mirrors `contributes.commands`
 * in package.json), tagged with a feature category. The category was derived
 * from each command's id and title per the heuristics documented on
 * {@link categorize}; here it is materialised so grouping stays a cheap, pure
 * lookup at runtime.
 */
const COMMANDS: readonly CommandEntry[] = [
  // ── Signatures ────────────────────────────────────────────────────────────
  { command: 'sigscan.scanProject', title: 'Scan Project for Signatures', category: 'Signatures' },
  { command: 'sigscan.startWatching', title: 'Start Watching for Changes', category: 'Signatures' },
  { command: 'sigscan.stopWatching', title: 'Stop Watching for Changes', category: 'Signatures' },
  { command: 'sigscan.exportSignatures', title: 'Export Signatures', category: 'Signatures' },
  { command: 'sigscan.refreshSignatures', title: 'Refresh Signatures', category: 'Signatures' },
  { command: 'sigscan.copySignature', title: 'Copy Function Signature', category: 'Signatures' },
  { command: 'sigscan.copySelector', title: 'Copy Function Selector', category: 'Signatures' },
  { command: 'sigscan.generateABI', title: 'Generate ABI from Signatures', category: 'Signatures' },
  { command: 'sigscan.searchDatabase', title: 'Search Signature Database', category: 'Signatures' },
  { command: 'sigscan.detectCollisions', title: 'Detect Selector Collisions', category: 'Signatures' },

  // ── Gas ───────────────────────────────────────────────────────────────────
  { command: 'sigscan.estimateGas', title: 'Estimate Gas Costs', category: 'Gas' },
  { command: 'sigscan.showGasAnnotations', title: 'Show Gas Annotations (Refresh)', category: 'Gas' },
  { command: 'sigscan.toggleRealtimeAnalysis', title: 'Toggle Real-time Gas Analysis', category: 'Gas' },
  { command: 'sigscan.showDeploymentCost', title: 'Show Deployment Cost Estimate', category: 'Gas' },
  { command: 'sigscan.compareWithBranch', title: 'Compare Gas with Branch', category: 'Gas' },
  { command: 'sigscan.suggestOptimizations', title: 'Suggest Gas Optimizations', category: 'Gas' },
  { command: 'sigscan.createGasSnapshot', title: 'Create Gas Snapshot', category: 'Gas' },
  { command: 'sigscan.showGasPricing', title: 'Show Live Gas Prices', category: 'Gas' },

  // ── Security ──────────────────────────────────────────────────────────────
  { command: 'sigscan.analyzeMEV', title: 'Analyze MEV Risks', category: 'Security' },
  { command: 'sigscan.detectReentrancy', title: 'Detect Reentrancy Vulnerabilities', category: 'Security' },
  { command: 'sigscan.detectUncheckedCalls', title: 'Detect Unchecked Low-Level Calls', category: 'Security' },
  { command: 'sigscan.checkAccessControl', title: 'Check Access Control', category: 'Security' },
  { command: 'sigscan.detectDangerousPatterns', title: 'Detect Dangerous Patterns (tx.origin, selfdestruct, delegatecall)', category: 'Security' },
  { command: 'sigscan.detectDeFiRisks', title: 'Detect DeFi Risks (Oracle, Precision, Approval, Zero-Address, Vault)', category: 'Security' },
  { command: 'sigscan.runSlither', title: 'Run Slither Analysis', category: 'Security' },
  { command: 'sigscan.runMythril', title: 'Run Mythril Analysis', category: 'Security' },

  // ── On-chain ──────────────────────────────────────────────────────────────
  { command: 'sigscan.lookup4byte', title: 'Lookup 4-Byte Selector', category: 'On-chain' },
  { command: 'sigscan.inspectTransaction', title: 'Inspect Transaction by Hash', category: 'On-chain' },
  { command: 'sigscan.exploreAddress', title: 'Inspect Address (Balance, Code, Proxy)', category: 'On-chain' },
  { command: 'sigscan.viewEvents', title: 'View Contract Events', category: 'On-chain' },
  { command: 'sigscan.readContractState', title: 'Read Contract State', category: 'On-chain' },
  { command: 'sigscan.getTokenBalance', title: 'Get ERC20 Token Balance', category: 'On-chain' },
  { command: 'sigscan.traceTenderly', title: 'Trace Transaction (Tenderly)', category: 'On-chain' },

  // ── Deploy & Run ──────────────────────────────────────────────────────────
  { command: 'sigscan.deployRun.show', title: 'Show Deploy & Run Panel', category: 'Deploy & Run' },
  { command: 'sigscan.deployRun.refresh', title: 'Refresh Deploy & Run Panel', category: 'Deploy & Run' },
  { command: 'sigscan.deployRun.setEtherscanApiKey', title: 'Set Etherscan API Key', category: 'Deploy & Run' },
  { command: 'sigscan.deployRun.clearEtherscanApiKey', title: 'Clear Etherscan API Key', category: 'Deploy & Run' },

  // ── Foundry/Hardhat ───────────────────────────────────────────────────────
  { command: 'sigscan.forgeRunTest', title: 'Run Forge Test', category: 'Foundry/Hardhat' },
  { command: 'sigscan.forgeRunAllTests', title: 'Run All Forge Tests', category: 'Foundry/Hardhat' },
  { command: 'sigscan.castCommand', title: 'Run Cast Command', category: 'Foundry/Hardhat' },
  { command: 'sigscan.startAnvil', title: 'Start Local Anvil Node', category: 'Foundry/Hardhat' },
  { command: 'sigscan.stopAnvil', title: 'Stop Anvil Node', category: 'Foundry/Hardhat' },
  { command: 'sigscan.runForgeScript', title: 'Run Forge Script', category: 'Foundry/Hardhat' },
  { command: 'sigscan.runHardhatTask', title: 'Run Hardhat Task', category: 'Foundry/Hardhat' },
  { command: 'sigscan.hardhatCompile', title: 'Hardhat: Compile', category: 'Foundry/Hardhat' },
  { command: 'sigscan.hardhatTest', title: 'Hardhat: Run Tests', category: 'Foundry/Hardhat' },

  // ── Other ─────────────────────────────────────────────────────────────────
  { command: 'sigscan.checkContractSize', title: 'Check Contract Size', category: 'Other' },
  { command: 'sigscan.analyzeComplexity', title: 'Analyze Code Complexity', category: 'Other' },
  { command: 'sigscan.verifyEtherscan', title: 'Verify Against Etherscan', category: 'Other' },
  { command: 'sigscan.generateAllReports', title: 'Generate All Analysis Reports', category: 'Other' },
  { command: 'sigscan.showStorageLayout', title: 'Show Storage Layout Analysis', category: 'Other' },
  { command: 'sigscan.showCallGraph', title: 'Show Function Call Graph', category: 'Other' },
  { command: 'sigscan.showProfilerReport', title: 'Show Runtime Profiler Report', category: 'Other' },
  { command: 'sigscan.checkInterfaces', title: 'Check Interface Compliance (ERC20/721/1155)', category: 'Other' },
  { command: 'sigscan.showCoverage', title: 'Show Test Coverage', category: 'Other' },
  { command: 'sigscan.analyzeUpgrade', title: 'Analyze Upgrade Compatibility', category: 'Other' },
  { command: 'sigscan.detectInvariants', title: 'Detect Contract Invariants', category: 'Other' },
  { command: 'sigscan.generateTests', title: 'Generate Foundry Test Stubs', category: 'Other' },
  { command: 'sigscan.openPlayground', title: 'Open Contract Playground', category: 'Other' },
  { command: 'sigscan.openDashboard', title: 'Open Project Dashboard', category: 'Other' },
  { command: 'sigscan.checkEvents', title: 'Check Missing Event Emissions', category: 'Other' },
  { command: 'sigscan.suggestCustomErrors', title: 'Suggest Custom Errors (Gas Savings)', category: 'Other' },
  { command: 'sigscan.checkNatspec', title: 'Check NatSpec Completeness', category: 'Other' },
  { command: 'sigscan.flattenContract', title: 'Flatten Contract', category: 'Other' },
  { command: 'sigscan.insertSnippet', title: 'Insert Solidity Snippet', category: 'Other' },
  { command: 'sigscan.simulateFork', title: 'Simulate on Fork', category: 'Other' },
  { command: 'sigscan.stopFork', title: 'Stop Fork Simulation', category: 'Other' },
];

/**
 * Group commands by category and order them for display.
 *
 * Pure and vscode-free so it can be unit-tested directly. Categories are
 * emitted in {@link CATEGORY_ORDER}; any category not listed there is appended
 * after the known ones but before `Other`, sorted alphabetically. Within each
 * category, commands are sorted alphabetically by title (case-insensitive).
 * Empty categories are omitted.
 *
 * @param commands - The flat list of command entries to group
 * @returns Ordered groups, each with a non-empty `items` array
 */
export function buildCommandGroups(commands: CommandEntry[]): CommandGroup[] {
  const byCategory = new Map<string, CommandEntry[]>();
  for (const entry of commands) {
    const bucket = byCategory.get(entry.category);
    if (bucket) {
      bucket.push(entry);
    } else {
      byCategory.set(entry.category, [entry]);
    }
  }

  const orderOf = (category: string): number => {
    const idx = CATEGORY_ORDER.indexOf(category);
    if (idx !== -1) {
      // 'Other' is pinned last regardless of its index in the array.
      return category === 'Other' ? Number.MAX_SAFE_INTEGER : idx;
    }
    // Unknown categories sit between the known ones and 'Other'.
    return CATEGORY_ORDER.length;
  };

  const sortedCategories = [...byCategory.keys()].sort((a, b) => {
    const oa = orderOf(a);
    const ob = orderOf(b);
    if (oa !== ob) {
      return oa - ob;
    }
    return a.localeCompare(b);
  });

  const groups: CommandGroup[] = [];
  for (const category of sortedCategories) {
    const items = (byCategory.get(category) ?? []).slice().sort((a, b) =>
      a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    );
    if (items.length > 0) {
      groups.push({ category, items });
    }
  }
  return groups;
}

/**
 * A QuickPick entry that either labels a category (a separator) or runs a
 * command (carries its `command` id).
 */
interface CommandPickItem extends vscode.QuickPickItem {
  command?: string;
}

/**
 * Build the flat list of QuickPick items: a separator per category followed by
 * its commands. Separators carry no `command`, so picking is impossible.
 */
function buildQuickPickItems(groups: CommandGroup[]): CommandPickItem[] {
  const items: CommandPickItem[] = [];
  for (const group of groups) {
    items.push({
      label: group.category,
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const entry of group.items) {
      items.push({
        label: entry.title,
        description: entry.command,
        detail: entry.command,
        command: entry.command,
      });
    }
  }
  return items;
}

/**
 * Register the grouped command palette.
 *
 * Adds `sigscan.showAllCommands`, which opens a categorised QuickPick of every
 * contributed command and, on selection, runs the chosen command. The
 * registration disposable is tracked on the extension context so VS Code can
 * tear it down on deactivation.
 *
 * @param context - The activating extension's context
 */
export function registerCommandPalette(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand('sigscan.showAllCommands', async () => {
    const groups = buildCommandGroups([...COMMANDS]);
    const items = buildQuickPickItems(groups);

    const picked = await vscode.window.showQuickPick(items, {
      title: '0xTools — All Commands',
      placeHolder: 'Browse 0xTools commands by category',
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (picked && picked.command) {
      await vscode.commands.executeCommand(picked.command);
    }
  });

  context.subscriptions.push(disposable);
}
