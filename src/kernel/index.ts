/**
 * control/kernel — Kernel Layer
 *
 * When you need to go all the way down.
 *
 * Commands:
 * - control/kernel crash         — Parse macOS kernel panic
 * - control/kernel trace <bin>   — Kernel-level tracing
 * - control/kernel checkpoint    — Save state before risky operation
 *
 * NEW - To build:
 *
 * Use cases:
 * - Understanding why macOS panicked
 * - Tracing kernel calls from userspace
 * - Checkpointing before operations that might crash
 */

import type { CrashInfo } from '../types';

/**
 * Parse a macOS kernel panic log
 *
 * Typical panic log location: /Library/Logs/DiagnosticReports/
 * Format: Kernel_*.panic
 */
export function parseKernelPanic(panicLog: string): CrashInfo {
  const info: CrashInfo = {
    type: 'KERNEL_PANIC',
  };

  // Look for panic reason
  const panicMatch = panicLog.match(/panic\(.*?\): (.+)/);
  if (panicMatch) {
    info.cause = panicMatch[1];
  }

  // Look for ANE-specific faults
  if (panicLog.includes('ANE') || panicLog.includes('H11ANE')) {
    info.type = 'ANE_FAULT';

    // Check for alignment issues
    if (panicLog.includes('alignment') || panicLog.includes('EXC_BAD_ACCESS')) {
      info.suggestion = 'Check tensor shape alignment (must be multiple of 32 for fp16)';
    }
  }

  // Extract faulting address
  const addrMatch = panicLog.match(/Fault CR2: (0x[0-9a-f]+)/i);
  if (addrMatch) {
    info.address = addrMatch[1];
  }

  // Extract backtrace
  const btMatch = panicLog.match(/Backtrace.*?:\s*([\s\S]*?)(?:\n\n|$)/);
  if (btMatch) {
    info.backtrace = btMatch[1]
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  return info;
}

export const kernel = {
  name: 'control/kernel',
  description: 'Kernel-level tracing and crash analysis',

  // Implemented
  parseKernelPanic,

  // TODO: Build
  // - traceSyscalls(binary): SyscallTrace[]
  // - checkpoint(): CheckpointId
  // - restore(checkpointId): void
  // - listPanicLogs(): PanicLogInfo[]
};
