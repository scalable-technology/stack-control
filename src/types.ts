/**
 * Control Types
 */

// =============================================================================
// Tool System
// =============================================================================

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  meta?: Record<string, unknown>;
}

export interface ToolContext {
  workspaceRoot?: string;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: unknown, context: ToolContext) => Promise<ToolResult>;
}

// Layer prefixes for tool naming
export type Layer =
  | 'react'
  | 'bridge'
  | 'native'
  | 'metal'
  | 'silicon'
  | 'discover'
  | 'kernel';

// ANE specific types
export interface ANEShape {
  dimensions: number[];
  dtype: 'fp16' | 'fp32';
}

export interface ANEValidationResult {
  valid: boolean;
  error?: string;
  suggestion?: number[];
  risk?: 'KERNEL_PANIC' | 'COMPILE_FAIL' | 'RUNTIME_ERROR';
}

export interface ANECompileState {
  count: number;
  limit: number;
  remaining: number;
  needsRestart: boolean;
}

export interface ANEProfile {
  duration_ms: number;
  ane_tflops: number;
  utilization_pct: number;
  bottleneck?: 'COMPUTE_BOUND' | 'IO_BOUND' | 'MEMORY_BOUND';
  suggestion?: string;
}

// Memory types
export interface MemoryRegion {
  address: string;
  size: number;
  protection: string;
  type?: string;
}

export interface IOSurfaceInfo {
  address: string;
  width: number;
  height: number;
  bytesPerRow: number;
  pixelFormat: string;
}

// Crash types
export interface CrashInfo {
  type: 'KERNEL_PANIC' | 'SEGFAULT' | 'ANE_FAULT' | 'ABORT' | 'OTHER';
  cause?: string;
  address?: string;
  lastOperation?: string;
  backtrace?: string[];
  suggestion?: string;
}
