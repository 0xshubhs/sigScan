/**
 * VS Code Language Model tools adapter — registers the shared AI tool
 * registry with `vscode.lm.registerTool` so Copilot agent mode (and any
 * LM-tool-aware agent inside VS Code) can call 0xTools directly.
 *
 * Yash's rule: nothing silent. A status-bar strip lights up on every AI
 * invocation and the "0xTools AI" output channel logs exactly what the agent
 * asked for. `sigscan.ai.enableTools` turns the whole surface off.
 */

import * as vscode from 'vscode';

import type { AiTool } from '../features/ai-tools/registry';

/** Lazy: the registry's import graph includes ethers — keep it off the
 *  activation path and load it on the first actual tool invocation. */
let toolCache: Map<string, AiTool> | undefined;
function getTool(name: string): AiTool | undefined {
  if (!toolCache) {
    const { buildAiTools } =
      require('../features/ai-tools/registry') as typeof import('../features/ai-tools/registry');
    toolCache = new Map(buildAiTools().map((t) => [t.name, t]));
  }
  return toolCache.get(name);
}

const SETTING = 'sigscan.ai.enableTools';
const PREFIX = '0xtools_';

/** Tools contributed in package.json `languageModelTools` — the in-editor
 *  surface stays curated; the MCP server exposes the full registry. */
const LM_SURFACE = new Set([
  'audit_solidity',
  'scan_signatures',
  'compute_selector',
  'lookup_selector',
  'decode_calldata',
  'encode_calldata',
  'keccak256',
  'convert_eth_units',
]);

let registrations: vscode.Disposable[] = [];
let channel: vscode.OutputChannel | undefined;
let statusItem: vscode.StatusBarItem | undefined;
let flashTimer: ReturnType<typeof setTimeout> | undefined;

function flashIndicator(toolName: string): void {
  if (!statusItem) {
    return;
  }
  statusItem.text = `$(zap) 0xTools AI: ${toolName}`;
  statusItem.show();
  if (flashTimer) {
    clearTimeout(flashTimer);
  }
  flashTimer = setTimeout(() => {
    if (statusItem) {
      statusItem.text = '$(check) 0xTools AI ready';
    }
  }, 4000);
}

function registerOne(name: string): vscode.Disposable {
  return vscode.lm.registerTool(PREFIX + name, {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>) {
      const args = options.input ?? {};
      channel?.appendLine(`[${new Date().toISOString()}] ${name} ← ${JSON.stringify(args)}`);
      flashIndicator(name);
      try {
        const tool = getTool(name);
        if (!tool) {
          throw new Error(`unknown tool ${name}`);
        }
        const text = await tool.run(args);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
      } catch (err) {
        const message = `error: ${(err as Error).message}`;
        channel?.appendLine(`  ↳ ${message}`);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
      }
    },
  });
}

function applyState(context: vscode.ExtensionContext): void {
  const enabled = vscode.workspace.getConfiguration().get<boolean>(SETTING, true);
  for (const d of registrations) {
    d.dispose();
  }
  registrations = [];
  if (!enabled) {
    statusItem?.hide();
    channel?.appendLine('AI tools disabled via settings.');
    return;
  }
  if (typeof vscode.lm?.registerTool !== 'function') {
    channel?.appendLine('This VS Code build has no Language Model tool API — MCP still works.');
    return;
  }
  for (const name of LM_SURFACE) {
    const reg = registerOne(name);
    registrations.push(reg);
    context.subscriptions.push(reg);
  }
  if (statusItem) {
    statusItem.text = '$(check) 0xTools AI ready';
    statusItem.show();
  }
  channel?.appendLine(`Registered ${registrations.length} language-model tools.`);
}

export function registerAiTools(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('0xTools AI');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusItem.tooltip =
    'AI agents can call 0xTools (audit, selectors, calldata). Click to view the log.';
  statusItem.command = 'workbench.action.output.toggleOutput';
  context.subscriptions.push(channel, statusItem);

  applyState(context);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SETTING)) {
        applyState(context);
      }
    })
  );
}
