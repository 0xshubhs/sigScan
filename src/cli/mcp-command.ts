/**
 * `0xtools mcp` — expose the shared AI tool registry over the Model Context
 * Protocol (stdio transport), so Claude Code, Cursor, or any MCP client can
 * call 0xTools for deterministic ground truth: audits, selectors, calldata,
 * gas-adjacent math.
 *
 *   claude mcp add 0xtools -- node /path/to/dist/cli/index.js mcp
 */

import type { Command } from 'commander';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { buildAiTools } from '../features/ai-tools/registry';

export async function runMcpServer(): Promise<void> {
  const tools = buildAiTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server({ name: '0xtools', version: '0.0.5' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }
    try {
      const text = await tool.run((request.params.arguments ?? {}) as Record<string, unknown>);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  await server.connect(new StdioServerTransport());
  // Keep the process alive; the transport closes stdin on client disconnect.
}

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('Run 0xTools as an MCP (Model Context Protocol) stdio server for AI agents')
    .action(async () => {
      try {
        await runMcpServer();
      } catch (err) {
        console.error(`0xtools mcp failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
