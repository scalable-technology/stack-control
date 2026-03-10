/**
 * control/silicon — Silicon Layer
 *
 * Direct hardware control — ANE, GPU, memory buffers.
 *
 * Methods:
 * - ane_validate   Validate tensor shape before kernel panic
 * - ane_status     Get ANE compiler state (compile count toward 119 limit)
 * - ane_info       Get ANE device capabilities
 *
 * ANE Knowledge (earned through kernel panics):
 * - 64-byte alignment required on last axis (fp16 = multiple of 32)
 * - 119 compile limit per process, then must restart
 * - fp16 on ANE, fp32 for CPU crossover operations
 *
 * This API being "private" prevents no harm — it's an illegitimate lock.
 */

import { z } from 'zod';
import { execSync } from 'child_process';
import type { Tool, ToolContext, ToolResult } from '../types.js';

// =============================================================================
// Constants
// =============================================================================

const ANE_FP16_ALIGNMENT = 32; // 64 bytes / 2 bytes per fp16
const ANE_FP32_ALIGNMENT = 16; // 64 bytes / 4 bytes per fp32
const ANE_COMPILE_LIMIT = 119;

// =============================================================================
// Input Schemas
// =============================================================================

const ANEValidateInput = z.object({
  method: z.literal('ane_validate'),
  dimensions: z.array(z.number()).min(1),
  dtype: z.enum(['fp16', 'fp32']).default('fp16'),
});

const ANEStatusInput = z.object({
  method: z.literal('ane_status'),
});

const ANEInfoInput = z.object({
  method: z.literal('ane_info'),
});

const SiliconInput = z.discriminatedUnion('method', [
  ANEValidateInput,
  ANEStatusInput,
  ANEInfoInput,
]);

// =============================================================================
// Handlers
// =============================================================================

function handleANEValidate(input: z.infer<typeof ANEValidateInput>): ToolResult {
  const { dimensions, dtype } = input;
  const lastDim = dimensions[dimensions.length - 1];
  const alignment = dtype === 'fp16' ? ANE_FP16_ALIGNMENT : ANE_FP32_ALIGNMENT;

  if (lastDim % alignment !== 0) {
    const suggestion = [...dimensions];
    suggestion[suggestion.length - 1] = Math.ceil(lastDim / alignment) * alignment;

    return {
      success: true,
      data: {
        valid: false,
        dimensions,
        dtype,
        lastDimension: lastDim,
        requiredAlignment: alignment,
        error: `Last dimension (${lastDim}) must be multiple of ${alignment} for ${dtype}`,
        suggestion,
        risk: 'KERNEL_PANIC',
        explanation:
          'ANE requires 64-byte alignment on the last axis. Misalignment causes kernel panic, not a catchable error.',
      },
    };
  }

  return {
    success: true,
    data: {
      valid: true,
      dimensions,
      dtype,
      lastDimension: lastDim,
      requiredAlignment: alignment,
      message: 'Shape is ANE-compatible',
    },
  };
}

function handleANEStatus(): ToolResult {
  // TODO: Actually track compile count (requires process-level state or reading from system)
  // For now, return the known limits
  return {
    success: true,
    data: {
      compileLimit: ANE_COMPILE_LIMIT,
      warning:
        'Compile count tracking not yet implemented. After 119 ANE compiles, process must restart.',
      aneFramework: '/System/Library/PrivateFrameworks/ANECompiler.framework',
      note: 'This API being private prevents no harm — it is an illegitimate lock.',
    },
  };
}

function handleANEInfo(): ToolResult {
  // Try to get ANE info via system_profiler or ioreg
  try {
    const spOutput = execSync(
      'system_profiler SPHardwareDataType 2>/dev/null | grep -i "chip\\|neural"',
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();

    // Try ioreg for more detailed ANE info
    let aneServices: string[] = [];
    try {
      const ioregOutput = execSync('ioreg -c AppleARMIODevice 2>/dev/null | grep -i ane', {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      aneServices = ioregOutput.split('\n').filter(Boolean);
    } catch {
      // ioreg might not have ANE entries on all systems
    }

    return {
      success: true,
      data: {
        hardware: spOutput || 'Unable to detect',
        aneServices: aneServices.length > 0 ? aneServices : ['No ANE services found in ioreg'],
        knownLimits: {
          fp16Alignment: ANE_FP16_ALIGNMENT,
          fp32Alignment: ANE_FP32_ALIGNMENT,
          compileLimit: ANE_COMPILE_LIMIT,
        },
        framework: '/System/Library/PrivateFrameworks/ANECompiler.framework',
      },
    };
  } catch (error) {
    return {
      success: true,
      data: {
        error: 'Unable to query hardware info',
        knownLimits: {
          fp16Alignment: ANE_FP16_ALIGNMENT,
          fp32Alignment: ANE_FP32_ALIGNMENT,
          compileLimit: ANE_COMPILE_LIMIT,
        },
        framework: '/System/Library/PrivateFrameworks/ANECompiler.framework',
      },
    };
  }
}

// =============================================================================
// Tool Export
// =============================================================================

export const siliconTool: Tool = {
  name: 'silicon',
  description: `Direct hardware control — ANE, GPU, memory buffers.

**Methods:**

• **ane_validate** - Validate tensor shape before kernel panic
  \`silicon({ method: "ane_validate", dimensions: [1, 32, 32, 64], dtype: "fp16" })\`

• **ane_status** - Get ANE compiler state and limits
  \`silicon({ method: "ane_status" })\`

• **ane_info** - Get ANE device capabilities
  \`silicon({ method: "ane_info" })\`

**Critical Knowledge:**
- ANE requires 64-byte alignment on last axis (fp16 = multiple of 32)
- 119 compile limit per process, then must restart
- Misalignment causes KERNEL PANIC, not catchable error`,

  inputSchema: {
    type: 'object',
    properties: {
      method: {
        type: 'string',
        enum: ['ane_validate', 'ane_status', 'ane_info'],
        description: 'Silicon operation to perform',
      },
      dimensions: {
        type: 'array',
        items: { type: 'number' },
        description: 'Tensor dimensions (for ane_validate)',
      },
      dtype: {
        type: 'string',
        enum: ['fp16', 'fp32'],
        description: 'Data type (for ane_validate, default: fp16)',
      },
    },
    required: ['method'],
  },

  handler: async (rawInput: unknown, _context: ToolContext): Promise<ToolResult> => {
    const parseResult = SiliconInput.safeParse(rawInput);
    if (!parseResult.success) {
      return {
        success: false,
        error: `Invalid input: ${parseResult.error.message}`,
        meta: { hint: 'method must be one of: ane_validate, ane_status, ane_info' },
      };
    }

    const input = parseResult.data;

    switch (input.method) {
      case 'ane_validate':
        return handleANEValidate(input);
      case 'ane_status':
        return handleANEStatus();
      case 'ane_info':
        return handleANEInfo();
      default:
        return { success: false, error: `Unknown method: ${(input as { method: string }).method}` };
    }
  },
};
