/**
 * control/native — Native Code Layer
 *
 * Tools for debugging native code (Swift, Objective-C, Kotlin, Java).
 * Full LLDB integration with batch and interactive modes.
 *
 * Commands:
 * - control/native crash        — Full crash context in one call
 * - control/native build ios    — Analyze Xcode build logs
 * - control/native build android — Analyze Gradle build logs
 * - control/native lldb attach  — Start LLDB session
 * - control/native lldb break   — Set breakpoint
 * - control/native lldb bt      — Backtrace
 * - control/native lldb step    — Step through code
 * - control/native lldb eval    — Evaluate expression
 *
 * Port from: @scalable/mcp/src/tools/lldb.ts
 *            @scalable/mcp/src/tools/logs.ts (crash_debug, build)
 */

export const native = {
  name: 'control/native',
  description: 'Native debugging with LLDB and crash analysis',

  // TODO: Port from lldb.ts
  // - Batch methods: crash_run, breakpoint_trace, variable_inspect, memory_read
  // - Interactive: session_attach, breakpoint_set, continue, step, backtrace
  // - simulator_launch for iOS debugging

  // TODO: Port from logs.ts
  // - crash_debug
  // - build log analysis
};
