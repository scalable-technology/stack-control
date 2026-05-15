#!/usr/bin/env node
/**
 * Control CLI
 *
 * Usage:
 *   control                     # Run MCP server (stdio)
 *   control --workspace /path   # Run with specific workspace
 */

import { runControlServer, type ControlServerConfig } from './server.js';

function parseArgs(): ControlServerConfig {
  const args = process.argv.slice(2);
  const config: ControlServerConfig = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--workspace':
      case '-w':
        if (next) {
          config.workspaceRoot = next;
          i++;
        }
        break;

      case '--help':
      case '-h':
        console.log(`
Control — Full-stack MCP from pixel to silicon

Usage:
  stack-control [options]

Options:
  --workspace, -w <path>    Workspace path (default: current directory)
  -h, --help                Show this help message

Layers:
  control/react     React component tree, props, state
  control/bridge    TurboModules, JSI, codegen verification
  control/native    LLDB, crash analysis, build logs
  control/metal     Private frameworks, IOKit, hardware APIs
  control/silicon   ANE, GPU, memory buffers, IOSurfaces
  control/discover  Reverse engineering, probing, fuzzing
  control/kernel    Kernel-level tracing, crash analysis

Philosophy:
  We respect locks that protect the user.
  We question locks that constrain the user.
  We document what we find.

  See PHILOSOPHY.md for the full Millian framework.
`);
        process.exit(0);
        break;
    }
  }

  // Default workspace
  if (!config.workspaceRoot) {
    config.workspaceRoot = process.cwd();
  }

  return config;
}

async function main() {
  const config = parseArgs();

  console.error(`[control] Starting MCP server...`);
  console.error(`[control] Workspace: ${config.workspaceRoot}`);

  await runControlServer(config);
}

main().catch((error) => {
  console.error('[control] Failed to start:', error);
  process.exit(1);
});
