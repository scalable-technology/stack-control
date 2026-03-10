/**
 * control/discover — Reverse Engineering Layer
 *
 * Tools for discovering undocumented behavior through controlled exploration.
 * Read-only inspection tools. Use everytask dev({ method: "learn" }) to persist discoveries.
 *
 * Methods:
 * - discoveries   List known discoveries (hardcoded reference)
 * - frameworks    List private frameworks
 * - symbols       Extract symbols from a binary/framework
 */

import { z } from 'zod';
import { execSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import type { Tool, ToolContext, ToolResult } from '../types.js';

// =============================================================================
// Types
// =============================================================================

interface Discovery {
  target: string;
  parameter: string;
  limit: unknown;
  discovered_at: string;
  method: 'fuzz' | 'crash' | 'observation' | 'documentation';
  notes?: string;
}

// =============================================================================
// Known Discoveries (reference data - earned through crashes)
// =============================================================================

const KNOWN_DISCOVERIES: Discovery[] = [
  {
    target: 'ane',
    parameter: 'last_axis_alignment_fp16',
    limit: 32,
    discovered_at: '2024-01-01',
    method: 'crash',
    notes: 'Must be multiple of 32 for fp16, or kernel panic. 64-byte alignment requirement.',
  },
  {
    target: 'ane',
    parameter: 'last_axis_alignment_fp32',
    limit: 16,
    discovered_at: '2024-01-01',
    method: 'crash',
    notes: 'Must be multiple of 16 for fp32, or kernel panic. 64-byte alignment requirement.',
  },
  {
    target: 'ane',
    parameter: 'compile_limit_per_process',
    limit: 119,
    discovered_at: '2024-01-01',
    method: 'observation',
    notes: 'After 119 compiles, ANE stops accepting new programs. Must restart process.',
  },
  {
    target: 'ane',
    parameter: 'framework_path',
    limit: '/System/Library/PrivateFrameworks/ANECompiler.framework',
    discovered_at: '2024-01-01',
    method: 'documentation',
    notes: 'Private framework location. MIL (Machine Intermediate Language) is the instruction format.',
  },
];

// =============================================================================
// Input Schemas
// =============================================================================

const DiscoveriesInput = z.object({
  method: z.literal('discoveries'),
  target: z.string().optional().describe('Filter by target (e.g., "ane")'),
});

const FrameworksInput = z.object({
  method: z.literal('frameworks'),
  filter: z.string().optional().describe('Filter by name (case-insensitive)'),
});

const SymbolsInput = z.object({
  method: z.literal('symbols'),
  path: z.string().describe('Path to binary or framework'),
  filter: z.string().optional().describe('Filter symbols by name'),
  limit: z.number().optional().default(100),
});

const DiscoverInput = z.discriminatedUnion('method', [
  DiscoveriesInput,
  FrameworksInput,
  SymbolsInput,
]);

// =============================================================================
// Handlers
// =============================================================================

function handleDiscoveries(input: z.infer<typeof DiscoveriesInput>): ToolResult {
  let discoveries = [...KNOWN_DISCOVERIES];

  if (input.target) {
    discoveries = discoveries.filter(
      (d) => d.target.toLowerCase() === input.target!.toLowerCase()
    );
  }

  return {
    success: true,
    data: {
      count: discoveries.length,
      discoveries,
      note: 'Reference data. Use dev({ method: "learn" }) to persist new discoveries.',
    },
  };
}

function handleFrameworks(input: z.infer<typeof FrameworksInput>): ToolResult {
  const frameworkPaths = [
    '/System/Library/PrivateFrameworks',
    '/System/Library/Frameworks',
  ];

  const frameworks: Array<{ name: string; path: string; private: boolean }> = [];

  for (const basePath of frameworkPaths) {
    if (!existsSync(basePath)) continue;

    const isPrivate = basePath.includes('Private');

    try {
      const entries = readdirSync(basePath);
      for (const entry of entries) {
        if (entry.endsWith('.framework')) {
          const name = entry.replace('.framework', '');
          if (!input.filter || name.toLowerCase().includes(input.filter.toLowerCase())) {
            frameworks.push({
              name,
              path: `${basePath}/${entry}`,
              private: isPrivate,
            });
          }
        }
      }
    } catch {
      // Permission denied
    }
  }

  // Sort: private first, then alphabetically
  frameworks.sort((a, b) => {
    if (a.private !== b.private) return a.private ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    success: true,
    data: {
      count: frameworks.length,
      privateCount: frameworks.filter((f) => f.private).length,
      publicCount: frameworks.filter((f) => !f.private).length,
      frameworks: frameworks.slice(0, 200),
      note:
        frameworks.length > 200
          ? `Showing 200 of ${frameworks.length}. Use filter to narrow results.`
          : undefined,
    },
  };
}

function handleSymbols(input: z.infer<typeof SymbolsInput>): ToolResult {
  if (!existsSync(input.path)) {
    return {
      success: false,
      error: `Path not found: ${input.path}`,
    };
  }

  // Determine the actual binary path
  let binaryPath = input.path;
  if (input.path.endsWith('.framework')) {
    const name = input.path.split('/').pop()!.replace('.framework', '');
    binaryPath = `${input.path}/${name}`;
  }

  try {
    // Use nm to extract symbols
    const nmOutput = execSync(`nm -gU "${binaryPath}" 2>/dev/null || nm "${binaryPath}" 2>/dev/null`, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
    });

    let symbols = nmOutput
      .split('\n')
      .map((line) => {
        const match = line.match(/^([0-9a-f]+)?\s*([A-Za-z])\s+(.+)$/);
        if (match) {
          return {
            address: match[1] || undefined,
            type: match[2],
            name: match[3],
          };
        }
        return null;
      })
      .filter(Boolean) as Array<{ address?: string; type: string; name: string }>;

    if (input.filter) {
      symbols = symbols.filter((s) =>
        s.name.toLowerCase().includes(input.filter!.toLowerCase())
      );
    }

    const total = symbols.length;
    symbols = symbols.slice(0, input.limit);

    return {
      success: true,
      data: {
        path: input.path,
        binaryPath,
        total,
        returned: symbols.length,
        symbols,
        note: total > input.limit! ? `Showing ${input.limit} of ${total}. Use filter to narrow.` : undefined,
      },
    };
  } catch (error) {
    // Try otool as fallback
    try {
      const otoolOutput = execSync(`otool -tV "${binaryPath}" 2>/dev/null | head -100`, {
        encoding: 'utf-8',
        timeout: 10000,
      });

      return {
        success: true,
        data: {
          path: input.path,
          note: 'nm failed, showing otool disassembly preview',
          preview: otoolOutput.slice(0, 2000),
        },
      };
    } catch {
      return {
        success: false,
        error: `Failed to extract symbols: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }
}

// =============================================================================
// Tool Export
// =============================================================================

export const discoverTool: Tool = {
  name: 'discover',
  description: `Reverse engineering through controlled exploration. Read-only inspection tools.

**Methods:**

• **discoveries** - List known discoveries (reference data)
  \`discover({ method: "discoveries" })\`
  \`discover({ method: "discoveries", target: "ane" })\`

• **frameworks** - List private frameworks
  \`discover({ method: "frameworks" })\`
  \`discover({ method: "frameworks", filter: "ANE" })\`

• **symbols** - Extract symbols from binary/framework
  \`discover({ method: "symbols", path: "/System/Library/PrivateFrameworks/ANECompiler.framework" })\`

To persist new discoveries, use: dev({ method: "learn", topic: "...", content: "..." })`,

  inputSchema: {
    type: 'object',
    properties: {
      method: {
        type: 'string',
        enum: ['discoveries', 'frameworks', 'symbols'],
        description: 'Discovery operation to perform',
      },
      target: {
        type: 'string',
        description: 'Target system (discoveries)',
      },
      filter: {
        type: 'string',
        description: 'Filter results (frameworks, symbols)',
      },
      path: {
        type: 'string',
        description: 'Path to binary/framework (symbols)',
      },
      limit: {
        type: 'number',
        description: 'Max results (symbols)',
      },
    },
    required: ['method'],
  },

  handler: async (rawInput: unknown, _context: ToolContext): Promise<ToolResult> => {
    const parseResult = DiscoverInput.safeParse(rawInput);
    if (!parseResult.success) {
      return {
        success: false,
        error: `Invalid input: ${parseResult.error.message}`,
      };
    }

    const input = parseResult.data;

    switch (input.method) {
      case 'discoveries':
        return handleDiscoveries(input);
      case 'frameworks':
        return handleFrameworks(input);
      case 'symbols':
        return handleSymbols(input);
      default:
        return { success: false, error: `Unknown method: ${(input as { method: string }).method}` };
    }
  },
};
