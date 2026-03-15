/**
 * control/silicon — Silicon Layer
 *
 * Direct hardware control — ANE, GPU, memory buffers.
 *
 * Methods:
 * - ane_validate   Validate tensor shape before kernel panic
 * - ane_status     Get ANE compiler state (compile count toward 119 limit)
 * - ane_info       Get ANE device capabilities
 * - gpu_info       Get GPU device capabilities
 * - gpu_power      Get GPU frequency and power state (requires sudo)
 * - gpu_sample     Take multiple GPU power samples for variance analysis
 *
 * ANE Knowledge (earned through kernel panics):
 * - 64-byte alignment required on last axis (fp16 = multiple of 32)
 * - 119 compile limit per process, then must restart
 * - fp16 on ANE, fp32 for CPU crossover operations
 *
 * GPU Knowledge (earned through variance debugging):
 * - M4 GPU uses DVFS (Dynamic Voltage Frequency Scaling)
 * - Can cause 3x performance variance on identical workloads
 * - powermetrics exposes real-time GPU frequency and P-state
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

const GPUInfoInput = z.object({
  method: z.literal('gpu_info'),
});

const GPUPowerInput = z.object({
  method: z.literal('gpu_power'),
  samples: z.number().int().min(1).max(100).default(1),
  interval: z.number().int().min(100).max(10000).default(500),
});

const GPUSampleInput = z.object({
  method: z.literal('gpu_sample'),
  duration: z.number().int().min(1000).max(60000).default(5000),
  interval: z.number().int().min(100).max(5000).default(500),
});

const SiliconInput = z.discriminatedUnion('method', [
  ANEValidateInput,
  ANEStatusInput,
  ANEInfoInput,
  GPUInfoInput,
  GPUPowerInput,
  GPUSampleInput,
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
// GPU Handlers
// =============================================================================

interface GPUPowerSample {
  timestamp: number;
  gpuFrequencyMHz?: number;
  gpuPowerW?: number;
  gpuBusy?: number;
  anePowerW?: number;
  raw?: string;
}

function parseGPUPowerMetrics(output: string): GPUPowerSample[] {
  const samples: GPUPowerSample[] = [];
  const blocks = output.split(/\*{10,}/);

  for (const block of blocks) {
    if (!block.trim()) continue;

    const sample: GPUPowerSample = { timestamp: Date.now() };

    // Parse GPU frequency (look for "GPU HW active frequency" or similar)
    const freqMatch = block.match(/GPU\s+(?:HW\s+)?(?:active\s+)?frequency[:\s]+(\d+(?:\.\d+)?)\s*MHz/i);
    if (freqMatch) {
      sample.gpuFrequencyMHz = parseFloat(freqMatch[1]);
    }

    // Parse GPU power
    const powerMatch = block.match(/GPU\s+Power[:\s]+(\d+(?:\.\d+)?)\s*m?W/i);
    if (powerMatch) {
      const value = parseFloat(powerMatch[1]);
      sample.gpuPowerW = powerMatch[0].includes('mW') ? value / 1000 : value;
    }

    // Parse GPU busy percentage
    const busyMatch = block.match(/GPU\s+(?:HW\s+)?(?:active\s+)?residency[:\s]+(\d+(?:\.\d+)?)\s*%/i);
    if (busyMatch) {
      sample.gpuBusy = parseFloat(busyMatch[1]);
    }

    // Parse ANE power
    const aneMatch = block.match(/ANE\s+Power[:\s]+(\d+(?:\.\d+)?)\s*m?W/i);
    if (aneMatch) {
      const value = parseFloat(aneMatch[1]);
      sample.anePowerW = aneMatch[0].includes('mW') ? value / 1000 : value;
    }

    // Store raw block for debugging
    if (sample.gpuFrequencyMHz || sample.gpuPowerW) {
      sample.raw = block.trim().substring(0, 500);
      samples.push(sample);
    }
  }

  return samples;
}

function handleGPUInfo(): ToolResult {
  try {
    // Get GPU info via system_profiler
    const spOutput = execSync('system_profiler SPDisplaysDataType 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();

    // Parse the output
    const lines = spOutput.split('\n');
    const gpuInfo: Record<string, string> = {};

    for (const line of lines) {
      const match = line.match(/^\s*([^:]+):\s*(.+)$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();
        if (value && !key.includes('Displays')) {
          gpuInfo[key] = value;
        }
      }
    }

    // Check sysctl for GPU-related settings
    let sysctlInfo: Record<string, string | number> = {};
    try {
      const sysctlOutput = execSync('sysctl -a 2>/dev/null | grep -i iogpu', {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();

      for (const line of sysctlOutput.split('\n')) {
        const match = line.match(/^([^:]+):\s*(.+)$/);
        if (match) {
          sysctlInfo[match[1].trim()] = isNaN(Number(match[2])) ? match[2].trim() : Number(match[2]);
        }
      }
    } catch {
      // sysctl might not have all entries
    }

    return {
      success: true,
      data: {
        gpu: gpuInfo,
        sysctl: sysctlInfo,
        note: 'For real-time frequency/power, use gpu_power (requires sudo)',
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unable to query GPU info',
    };
  }
}

function handleGPUPower(input: z.infer<typeof GPUPowerInput>): ToolResult {
  const { samples, interval } = input;

  try {
    // powermetrics requires sudo
    const cmd = `sudo -n powermetrics --samplers gpu_power,ane_power -i ${interval} -n ${samples} 2>&1`;

    try {
      const output = execSync(cmd, {
        encoding: 'utf-8',
        timeout: Math.max(30000, samples * interval + 10000),
      });

      const parsedSamples = parseGPUPowerMetrics(output);

      if (parsedSamples.length === 0) {
        return {
          success: true,
          data: {
            samples: [],
            raw: output.substring(0, 2000),
            note: 'Could not parse GPU metrics. Raw output included for debugging.',
          },
        };
      }

      // Calculate statistics if multiple samples
      if (parsedSamples.length > 1) {
        const frequencies = parsedSamples.map((s) => s.gpuFrequencyMHz).filter((f) => f !== undefined) as number[];

        if (frequencies.length > 1) {
          const min = Math.min(...frequencies);
          const max = Math.max(...frequencies);
          const avg = frequencies.reduce((a, b) => a + b, 0) / frequencies.length;
          const variance = max / min;

          return {
            success: true,
            data: {
              samples: parsedSamples,
              statistics: {
                frequencyMHz: { min, max, avg: Math.round(avg), variance: Math.round(variance * 100) / 100 },
                sampleCount: frequencies.length,
              },
              insight:
                variance > 1.5
                  ? `GPU frequency varied ${Math.round(variance * 100)}% — DVFS is active. This explains performance variance.`
                  : 'GPU frequency is stable.',
            },
          };
        }
      }

      return {
        success: true,
        data: {
          samples: parsedSamples,
        },
      };
    } catch (execError) {
      const errorMsg = execError instanceof Error ? execError.message : String(execError);

      if (errorMsg.includes('sudo') || errorMsg.includes('password')) {
        return {
          success: false,
          error: 'powermetrics requires sudo access',
          meta: {
            hint: 'Run with: sudo -n powermetrics --samplers gpu_power -i 500 -n 3',
            workaround: 'Add to sudoers: username ALL=(ALL) NOPASSWD: /usr/bin/powermetrics',
          },
        };
      }

      throw execError;
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get GPU power metrics',
    };
  }
}

function handleGPUSample(input: z.infer<typeof GPUSampleInput>): ToolResult {
  const { duration, interval } = input;
  const samples = Math.ceil(duration / interval);

  // Just delegate to gpu_power with calculated samples
  return handleGPUPower({ method: 'gpu_power', samples, interval });
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

• **gpu_info** - Get GPU device info (cores, Metal support, sysctl)
  \`silicon({ method: "gpu_info" })\`

• **gpu_power** - Get GPU frequency and power state (requires sudo)
  \`silicon({ method: "gpu_power", samples: 3, interval: 500 })\`

• **gpu_sample** - Sample GPU power over duration for variance analysis
  \`silicon({ method: "gpu_sample", duration: 5000, interval: 500 })\`

**Critical Knowledge:**
- ANE requires 64-byte alignment on last axis (fp16 = multiple of 32)
- 119 compile limit per process, then must restart
- Misalignment causes KERNEL PANIC, not catchable error
- GPU uses DVFS — frequency can vary 3x causing performance variance
- Use gpu_power during inference to detect throttling`,

  inputSchema: {
    type: 'object',
    properties: {
      method: {
        type: 'string',
        enum: ['ane_validate', 'ane_status', 'ane_info', 'gpu_info', 'gpu_power', 'gpu_sample'],
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
      samples: {
        type: 'number',
        description: 'Number of power samples to take (gpu_power, default: 1)',
      },
      interval: {
        type: 'number',
        description: 'Sampling interval in ms (gpu_power/gpu_sample, default: 500)',
      },
      duration: {
        type: 'number',
        description: 'Total sampling duration in ms (gpu_sample, default: 5000)',
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
      case 'gpu_info':
        return handleGPUInfo();
      case 'gpu_power':
        return handleGPUPower(input);
      case 'gpu_sample':
        return handleGPUSample(input);
      default:
        return { success: false, error: `Unknown method: ${(input as { method: string }).method}` };
    }
  },
};
