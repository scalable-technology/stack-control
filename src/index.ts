/**
 * Control — Full-stack MCP from pixel to silicon
 *
 * Layers:
 * - control/react    — React component tree, props, state
 * - control/bridge   — TurboModules, JSI, codegen verification
 * - control/native   — LLDB, crash analysis, build logs
 * - control/metal    — Private frameworks, IOKit, hardware APIs
 * - control/silicon  — ANE, GPU, memory buffers, IOSurfaces
 * - control/chrome   — Chrome browser inspection via CDP
 * - control/discover — Reverse engineering, probing, fuzzing
 * - control/kernel   — Kernel-level tracing, crash analysis
 *
 * Philosophy:
 * We respect locks that protect the user.
 * We question locks that constrain the user.
 * We document what we find.
 */

// Server exports
export { createControlServer, runControlServer, type ControlServerConfig } from './server.js';

// Tool exports
export { tools, getTool, executeTool } from './tools/index.js';
export { siliconTool } from './tools/silicon.js';
export { kernelTool } from './tools/kernel.js';
export { discoverTool } from './tools/discover.js';
export { chromeTool } from './tools/chrome.js';

// Type exports
export * from './types.js';
