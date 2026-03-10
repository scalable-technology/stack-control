/**
 * Control MCP Server
 *
 * Full-stack debugging from pixel to silicon.
 * Applies Mill's harm principle: question locks that constrain, respect locks that protect.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { tools, executeTool } from './tools/index.js';
import type { ToolContext } from './types.js';

export interface ControlServerConfig {
  name?: string;
  version?: string;
  workspaceRoot?: string;
}

/**
 * Create the Control MCP server
 */
export function createControlServer(config: ControlServerConfig = {}) {
  const server = new Server(
    {
      name: config.name || 'control',
      version: config.version || '0.0.1',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const context: ToolContext = {
    workspaceRoot: config.workspaceRoot || process.cwd(),
  };

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  });

  // Execute tools
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const result = await executeTool(name, args, context);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
      isError: !result.success,
    };
  });

  return server;
}

/**
 * Run the Control MCP server with stdio transport
 */
export async function runControlServer(config: ControlServerConfig = {}) {
  const server = createControlServer(config);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await server.close();
    process.exit(0);
  });
}
