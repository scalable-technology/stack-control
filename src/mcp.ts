#!/usr/bin/env node
/**
 * Control MCP Server Entry Point
 *
 * Clean entry for MCP protocol - no logging to interfere with JSON-RPC.
 */

import { runControlServer } from './server.js';

runControlServer({
  workspaceRoot: process.cwd(),
}).catch(() => {
  process.exit(1);
});
