/**
 * Tests for the grouped command palette.
 *
 * Covers the pure grouping/ordering core ({@link buildCommandGroups}) and the
 * vscode-facing registration ({@link registerCommandPalette}) — that it
 * registers `sigscan.showAllCommands`, presents a categorised QuickPick with
 * separators, and dispatches the picked command.
 */

import * as vscode from 'vscode';
import {
  buildCommandGroups,
  registerCommandPalette,
  type CommandEntry,
} from '../command-palette';

const commandsMock = vscode.commands as unknown as {
  registerCommand: jest.Mock;
  executeCommand: jest.Mock;
};
const windowMock = vscode.window as unknown as {
  showQuickPick: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();
});

/** Minimal ExtensionContext exposing only the `subscriptions` array. */
function makeContext(): vscode.ExtensionContext {
  return { subscriptions: [] } as unknown as vscode.ExtensionContext;
}

describe('buildCommandGroups', () => {
  it('groups commands by category', () => {
    const input: CommandEntry[] = [
      { command: 'a', title: 'Alpha', category: 'Gas' },
      { command: 'b', title: 'Beta', category: 'Security' },
      { command: 'c', title: 'Gamma', category: 'Gas' },
    ];

    const groups = buildCommandGroups(input);

    const gas = groups.find((g) => g.category === 'Gas');
    const security = groups.find((g) => g.category === 'Security');
    expect(gas?.items.map((i) => i.command)).toEqual(['a', 'c']);
    expect(security?.items.map((i) => i.command)).toEqual(['b']);
  });

  it('orders categories in the fixed sensible order', () => {
    const input: CommandEntry[] = [
      { command: '1', title: 'A', category: 'Other' },
      { command: '2', title: 'B', category: 'Deploy & Run' },
      { command: '3', title: 'C', category: 'Signatures' },
      { command: '4', title: 'D', category: 'Security' },
      { command: '5', title: 'E', category: 'Gas' },
      { command: '6', title: 'F', category: 'On-chain' },
      { command: '7', title: 'G', category: 'Foundry/Hardhat' },
    ];

    const order = buildCommandGroups(input).map((g) => g.category);

    expect(order).toEqual([
      'Signatures',
      'Gas',
      'Security',
      'On-chain',
      'Deploy & Run',
      'Foundry/Hardhat',
      'Other',
    ]);
  });

  it('always sorts "Other" last, even with unknown categories present', () => {
    const input: CommandEntry[] = [
      { command: '1', title: 'A', category: 'Other' },
      { command: '2', title: 'B', category: 'Zeta' },
      { command: '3', title: 'C', category: 'Gas' },
    ];

    const order = buildCommandGroups(input).map((g) => g.category);

    expect(order).toEqual(['Gas', 'Zeta', 'Other']);
    expect(order[order.length - 1]).toBe('Other');
  });

  it('sorts items alphabetically by title (case-insensitive) within a category', () => {
    const input: CommandEntry[] = [
      { command: '1', title: 'zeta', category: 'Gas' },
      { command: '2', title: 'Alpha', category: 'Gas' },
      { command: '3', title: 'beta', category: 'Gas' },
    ];

    const titles = buildCommandGroups(input)[0].items.map((i) => i.title);

    expect(titles).toEqual(['Alpha', 'beta', 'zeta']);
  });

  it('omits empty input as no groups', () => {
    expect(buildCommandGroups([])).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input: CommandEntry[] = [
      { command: 'b', title: 'Beta', category: 'Gas' },
      { command: 'a', title: 'Alpha', category: 'Gas' },
    ];
    const snapshot = input.map((e) => e.command);

    buildCommandGroups(input);

    expect(input.map((e) => e.command)).toEqual(snapshot);
  });
});

describe('registerCommandPalette', () => {
  it('registers sigscan.showAllCommands and tracks the disposable', () => {
    const context = makeContext();

    registerCommandPalette(context);

    expect(commandsMock.registerCommand).toHaveBeenCalledWith(
      'sigscan.showAllCommands',
      expect.any(Function)
    );
    expect(context.subscriptions).toHaveLength(1);
  });

  it('shows a categorised QuickPick with separators and runs the picked command', async () => {
    const context = makeContext();
    registerCommandPalette(context);
    const handler = commandsMock.registerCommand.mock.calls[0][1] as () => Promise<void>;

    // User picks the gas estimate command.
    windowMock.showQuickPick.mockResolvedValueOnce({
      label: 'Estimate Gas Costs',
      command: 'sigscan.estimateGas',
    });

    await handler();

    // QuickPick was offered a list that includes category separators.
    const offered = windowMock.showQuickPick.mock.calls[0][0] as Array<{
      label: string;
      kind?: number;
      command?: string;
    }>;
    const separators = offered.filter(
      (i) => i.kind === vscode.QuickPickItemKind.Separator
    );
    expect(separators.length).toBeGreaterThan(0);
    expect(separators.map((s) => s.label)).toContain('Gas');

    // Every non-separator item carries a runnable command id.
    const runnable = offered.filter(
      (i) => i.kind !== vscode.QuickPickItemKind.Separator
    );
    expect(runnable.length).toBeGreaterThan(0);
    expect(runnable.every((i) => typeof i.command === 'string')).toBe(true);

    // The picked command was dispatched.
    expect(commandsMock.executeCommand).toHaveBeenCalledWith('sigscan.estimateGas');
  });

  it('does nothing when the picker is dismissed', async () => {
    const context = makeContext();
    registerCommandPalette(context);
    const handler = commandsMock.registerCommand.mock.calls[0][1] as () => Promise<void>;

    windowMock.showQuickPick.mockResolvedValueOnce(undefined);

    await handler();

    expect(commandsMock.executeCommand).not.toHaveBeenCalled();
  });

  it('does not dispatch when a separator-like item with no command is picked', async () => {
    const context = makeContext();
    registerCommandPalette(context);
    const handler = commandsMock.registerCommand.mock.calls[0][1] as () => Promise<void>;

    windowMock.showQuickPick.mockResolvedValueOnce({
      label: 'Gas',
      kind: vscode.QuickPickItemKind.Separator,
    });

    await handler();

    expect(commandsMock.executeCommand).not.toHaveBeenCalled();
  });
});
