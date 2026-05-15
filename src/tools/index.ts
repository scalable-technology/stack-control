/**
 * Control Tools Registry
 *
 * All tools use the grouped API pattern (method-based dispatch).
 * Each layer exposes a single tool with multiple methods.
 */

import type { Tool, ToolContext, ToolResult } from '../types.js';
import { siliconTool } from './silicon.js';
import { kernelTool } from './kernel.js';
import { discoverTool } from './discover.js';
import { nativeTool } from './native.js';
import { reactTool } from './react.js';
import { bridgeTool } from './bridge.js';
import { deviceTool } from './device.js';
import { chromeTool } from './chrome.js';

/**
 * All available Control tools
 */
export const tools: Tool[] = [
  siliconTool,
  kernelTool,
  discoverTool,
  nativeTool,
  reactTool,
  bridgeTool,
  deviceTool,
  chromeTool,
  // Future:
  // metalTool,      // Build new - IOKit, private framework access
];

/**
 * Get tool by name
 */
export function getTool(name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}

/**
 * Execute a tool with context
 */
export async function executeTool(
  name: string,
  input: unknown,
  context: ToolContext
): Promise<ToolResult> {
  const tool = getTool(name);

  if (!tool) {
    return { success: false, error: `Unknown tool: ${name}` };
  }

  const start = Date.now();
  try {
    const result = await tool.handler(input, context);
    return {
      ...result,
      meta: {
        ...result.meta,
        duration: Date.now() - start,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      meta: { duration: Date.now() - start },
    };
  }
}
