#!/usr/bin/env node
// URL2Pin MCP server (stdio). Needs URL2PIN_API_KEY, created at https://url2pin.com/my-account.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient, DEFAULT_API_URL, VERSION } from './client.js';
import { buildTools } from './tools.js';

const apiKey = String(process.env.URL2PIN_API_KEY || '').trim();
if (!apiKey) {
  // stderr only: stdout is the MCP channel.
  console.error('url2pin-mcp: URL2PIN_API_KEY is not set. Create a key at https://url2pin.com/my-account#api-keys. The tools will explain this too.');
}

const client = createClient({ apiKey, apiUrl: process.env.URL2PIN_API_URL || DEFAULT_API_URL });
const waitSeconds = Number(process.env.URL2PIN_WAIT_SECONDS) > 0 ? Number(process.env.URL2PIN_WAIT_SECONDS) : 50;

const server = new McpServer(
  { name: 'url2pin', version: VERSION },
  {
    instructions:
      'URL2Pin turns product and blog links into Pinterest pins and schedules them. ' +
      'Typical flow: generate_pins (about 2 minutes, use check_pins if it is still running), then schedule_pins. ' +
      'schedule_pins picks the best board for each pin by itself when no board_id is given (sure matches only), ' +
      'and creates one new board for pins that fit none (new_board_if_none: false turns that off). ' +
      'suggest_boards shows the picks without scheduling. Confirm the times with the person before schedule_pins.',
  }
);

for (const t of buildTools(client, { waitSeconds })) {
  server.registerTool(
    t.name,
    { title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations },
    async (args) => {
      try {
        const { text, isError } = await t.handler(args || {});
        return { content: [{ type: 'text', text }], isError };
      } catch (e) {
        return { content: [{ type: 'text', text: `Something went wrong: ${e?.message || e}` }], isError: true };
      }
    }
  );
}

await server.connect(new StdioServerTransport());
