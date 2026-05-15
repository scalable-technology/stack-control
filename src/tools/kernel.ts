/**
 * control/kernel — Kernel Layer
 *
 * When you need to go all the way down.
 *
 * Methods:
 * - panic_parse    Parse a macOS kernel panic log
 * - panic_list     List recent kernel panics
 * - panic_analyze  Full analysis with suggestions
 */

import { z } from 'zod';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import type { Tool, ToolContext, ToolResult, CrashInfo } from '../types.js';

// =============================================================================
// Input Schemas
// =============================================================================

const PanicParseInput = z.object({
  method: z.literal('panic_parse'),
  log: z.string().describe('Kernel panic log content'),
});

const PanicListInput = z.object({
  method: z.literal('panic_list'),
  limit: z.number().optional().default(10),
});

const PanicAnalyzeInput = z.object({
  method: z.literal('panic_analyze'),
  path: z.string().describe('Path to panic log file'),
});

const KernelInput = z.discriminatedUnion('method', [
  PanicParseInput,
  PanicListInput,
  PanicAnalyzeInput,
]);

// =============================================================================
// Handlers
// =============================================================================

function parseKernelPanic(panicLog: string): CrashInfo {
  const info: CrashInfo = {
    type: 'KERNEL_PANIC',
  };

  // Look for panic reason
  const panicMatch = panicLog.match(/panic\(.*?\): (.+)/);
  if (panicMatch) {
    info.cause = panicMatch[1];
  }

  // Look for ANE-specific faults
  if (panicLog.includes('ANE') || panicLog.includes('H11ANE') || panicLog.includes('H13ANE')) {
    info.type = 'ANE_FAULT';

    if (panicLog.includes('alignment') || panicLog.includes('EXC_BAD_ACCESS')) {
      info.suggestion = 'Check tensor shape alignment (must be multiple of 32 for fp16, 16 for fp32)';
    }

    if (panicLog.includes('compile') || panicLog.includes('program')) {
      info.suggestion = 'Check ANE compile count (limit is 119 per process)';
    }
  }

  // Look for GPU faults
  if (panicLog.includes('AGX') || panicLog.includes('GPU')) {
    info.type = 'OTHER';
    info.suggestion = 'GPU-related panic. Check Metal shader compilation or resource limits.';
  }

  // Extract faulting address
  const addrMatch = panicLog.match(/Fault CR2: (0x[0-9a-f]+)/i);
  if (addrMatch) {
    info.address = addrMatch[1];
  }

  // Try alternative address patterns
  if (!info.address) {
    const altAddrMatch = panicLog.match(/FAR: (0x[0-9a-f]+)/i);
    if (altAddrMatch) {
      info.address = altAddrMatch[1];
    }
  }

  // Extract backtrace
  const btMatch = panicLog.match(/Backtrace.*?:\s*([\s\S]*?)(?:\n\n|\nProcess|\nKernel|$)/);
  if (btMatch) {
    info.backtrace = btMatch[1]
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 20); // Limit to 20 frames
  }

  // If no backtrace found, try panic backtrace format
  if (!info.backtrace || info.backtrace.length === 0) {
    const panicBtMatch = panicLog.match(/Panicked thread.*?:([\s\S]*?)(?:\n\n|$)/);
    if (panicBtMatch) {
      info.backtrace = panicBtMatch[1]
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 20);
    }
  }

  return info;
}

function handlePanicParse(input: z.infer<typeof PanicParseInput>): ToolResult {
  const info = parseKernelPanic(input.log);
  return {
    success: true,
    data: info,
  };
}

function handlePanicList(input: z.infer<typeof PanicListInput>): ToolResult {
  const panicDirs = [
    '/Library/Logs/DiagnosticReports',
    `${process.env.HOME}/Library/Logs/DiagnosticReports`,
  ];

  const panics: Array<{
    path: string;
    name: string;
    date: Date;
    size: number;
  }> = [];

  for (const dir of panicDirs) {
    if (!existsSync(dir)) continue;

    try {
      const files = readdirSync(dir);
      for (const file of files) {
        if (file.includes('panic') || file.endsWith('.panic')) {
          const fullPath = join(dir, file);
          const stat = statSync(fullPath);
          panics.push({
            path: fullPath,
            name: file,
            date: stat.mtime,
            size: stat.size,
          });
        }
      }
    } catch {
      // Permission denied or other error
    }
  }

  // Sort by date, newest first
  panics.sort((a, b) => b.date.getTime() - a.date.getTime());

  return {
    success: true,
    data: {
      count: panics.length,
      panics: panics.slice(0, input.limit).map((p) => ({
        path: p.path,
        name: p.name,
        date: p.date.toISOString(),
        size: p.size,
      })),
      note: panics.length > input.limit ? `Showing ${input.limit} of ${panics.length}` : undefined,
    },
  };
}

function handlePanicAnalyze(input: z.infer<typeof PanicAnalyzeInput>): ToolResult {
  if (!existsSync(input.path)) {
    return {
      success: false,
      error: `File not found: ${input.path}`,
    };
  }

  try {
    const content = readFileSync(input.path, 'utf-8');
    const info = parseKernelPanic(content);

    return {
      success: true,
      data: {
        file: input.path,
        analysis: info,
        raw_length: content.length,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

// =============================================================================
// Tool Export
// =============================================================================

export const kernelTool: Tool = {
  name: 'kernel',
  description: `Kernel-level tracing and crash analysis.

**Methods:**

• **panic_parse** - Parse a kernel panic log
  \`kernel({ method: "panic_parse", log: "..." })\`

• **panic_list** - List recent kernel panics
  \`kernel({ method: "panic_list", limit: 5 })\`

• **panic_analyze** - Analyze a panic log file
  \`kernel({ method: "panic_analyze", path: "/Library/Logs/DiagnosticReports/..." })\`

Automatically detects:
- ANE faults (alignment, compile limits)
- GPU faults (AGX, Metal)
- Memory faults with address extraction
- Provides suggestions based on patterns`,

  inputSchema: {
    type: 'object',
    properties: {
      method: {
        type: 'string',
        enum: ['panic_parse', 'panic_list', 'panic_analyze'],
        description: 'Kernel operation to perform',
      },
      log: {
        type: 'string',
        description: 'Kernel panic log content (for panic_parse)',
      },
      path: {
        type: 'string',
        description: 'Path to panic log file (for panic_analyze)',
      },
      limit: {
        type: 'number',
        description: 'Max panics to return (for panic_list, default: 10)',
      },
    },
    required: ['method'],
  },

  handler: async (rawInput: unknown, _context: ToolContext): Promise<ToolResult> => {
    const parseResult = KernelInput.safeParse(rawInput);
    if (!parseResult.success) {
      return {
        success: false,
        error: `Invalid input: ${parseResult.error.message}`,
      };
    }

    const input = parseResult.data;

    switch (input.method) {
      case 'panic_parse':
        return handlePanicParse(input);
      case 'panic_list':
        return handlePanicList(input);
      case 'panic_analyze':
        return handlePanicAnalyze(input);
      default:
        return { success: false, error: `Unknown method: ${(input as { method: string }).method}` };
    }
  },
};
