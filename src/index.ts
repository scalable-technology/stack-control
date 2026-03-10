/**
 * Control — Full-stack MCP from pixel to silicon
 *
 * Layers:
 * - control/react    — React component tree, props, state
 * - control/bridge   — TurboModules, JSI, codegen verification
 * - control/native   — LLDB, crash analysis, build logs
 * - control/metal    — Private frameworks, IOKit, hardware APIs
 * - control/silicon  — ANE, GPU, memory buffers, IOSurfaces
 * - control/discover — Reverse engineering, probing, fuzzing
 * - control/kernel   — Kernel-level tracing, crash analysis
 */

// Layer exports
export * from './react';
export * from './bridge';
export * from './native';
export * from './metal';
export * from './silicon';
export * from './discover';
export * from './kernel';

// Re-export types
export * from './types';
