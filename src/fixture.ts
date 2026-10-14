// Tiny MCP server used only by the tests.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fixture', version: '1.0.0' });

server.registerTool('echo', { description: 'Echo text back', inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text }] }));

server.registerTool('boom', { description: 'Always fails', inputSchema: {} },
  async () => ({ isError: true, content: [{ type: 'text', text: 'kaboom' }] }));

await server.connect(new StdioServerTransport());
