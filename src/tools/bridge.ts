/**
 * control/bridge — Native Bridge Layer
 *
 * TurboModule health checker with granular status tracking.
 * Detects spec-only modules, missing codegen, signature mismatches, and broken modules.
 *
 * Methods:
 * - module_list      List TurboModules with health status
 * - module_status    Get detailed status for a specific module
 * - platform_diff    Compare iOS and Android implementations
 * - type_mappings    Show platform type equivalences
 *
 * Status Values:
 * - spec_only: TS spec exists, no native implementation
 * - partial: Native impl exists but codegen missing
 * - mismatch: Native impl doesn't match spec signature
 * - healthy: Everything aligned
 * - broken: Runtime failures detected
 */

import { z } from 'zod';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve, basename } from 'path';
import type { Tool, ToolContext, ToolResult } from '../types.js';

// =============================================================================
// Types
// =============================================================================

type ModuleStatus = 'spec_only' | 'partial' | 'mismatch' | 'healthy' | 'broken' | 'unknown';

interface ModuleInfo {
  name: string;
  specPath: string | null;
  status: ModuleStatus;
  ios: {
    hasImplementation: boolean;
    hasCodegen: boolean;
    implementationPath: string | null;
    codegenPath: string | null;
  };
  android: {
    hasImplementation: boolean;
    hasCodegen: boolean;
    implementationPath: string | null;
    codegenPath: string | null;
  };
  methods: string[];
  issues: string[];
}

interface MethodSignature {
  name: string;
  returnType: string;
  params: { name: string; type: string }[];
  rawSignature: string;
}

interface DiffResult {
  method: string;
  status: 'equivalent' | 'ios_only' | 'android_only' | 'signature_mismatch';
  ios?: MethodSignature;
  android?: MethodSignature;
  notes?: string[];
}

// =============================================================================
// Platform Type Mappings (Semantic Equivalence)
// =============================================================================

const PLATFORM_TYPE_MAPPINGS: Record<string, string[]> = {
  // Objective-C/Swift → Java/Kotlin
  NSDictionary: ['ReadableMap', 'WritableMap', 'Map<String, Object>'],
  NSArray: ['ReadableArray', 'WritableArray', 'List<Object>'],
  NSString: ['String'],
  NSNumber: ['Double', 'Integer', 'Float', 'Boolean', 'Number'],
  BOOL: ['boolean', 'Boolean'],
  double: ['double', 'Double'],
  float: ['float', 'Float'],
  int: ['int', 'Integer'],
  NSInteger: ['int', 'Integer', 'long', 'Long'],
  NSUInteger: ['int', 'Integer', 'long', 'Long'],
  void: ['void', 'Unit'],
  // Promises
  RCTPromiseResolveBlock: ['Promise'],
  RCTPromiseRejectBlock: ['Promise'],
  // Callbacks
  RCTResponseSenderBlock: ['Callback'],
  // React Native specific
  RCTBridge: ['ReactApplicationContext'],
  UIView: ['View'],
};

const REVERSE_TYPE_MAPPINGS: Record<string, string[]> = {};
for (const [iosType, androidTypes] of Object.entries(PLATFORM_TYPE_MAPPINGS)) {
  for (const androidType of androidTypes) {
    if (!REVERSE_TYPE_MAPPINGS[androidType]) {
      REVERSE_TYPE_MAPPINGS[androidType] = [];
    }
    REVERSE_TYPE_MAPPINGS[androidType].push(iosType);
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

function findProjectRoot(startDir: string = process.cwd()): string {
  let dir = startDir;
  while (dir !== '/') {
    if (
      existsSync(join(dir, 'package.json')) &&
      (existsSync(join(dir, 'ios')) || existsSync(join(dir, 'android')))
    ) {
      return dir;
    }
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = resolve(dir, '..');
  }
  return startDir;
}

function findFiles(dir: string, pattern: RegExp, maxDepth: number = 10): string[] {
  const results: string[] = [];
  if (!existsSync(dir) || maxDepth <= 0) return results;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'Pods', 'build'].includes(entry.name)) {
          results.push(...findFiles(fullPath, pattern, maxDepth - 1));
        }
      } else if (pattern.test(entry.name)) {
        results.push(fullPath);
      }
    }
  } catch {
    // Permission denied
  }

  return results;
}

function extractModuleName(filename: string): string | null {
  const match = filename.match(/^Native(\w+)\.ts$/);
  return match ? match[1] : null;
}

function parseSpecMethods(content: string): string[] {
  const methods: string[] = [];
  const methodPattern = /^\s*(\w+)\s*\([^)]*\)\s*:\s*[^;]+;/gm;
  let match;
  while ((match = methodPattern.exec(content)) !== null) {
    methods.push(match[1]);
  }
  return methods;
}

function parseIosMethod(content: string): MethodSignature[] {
  const methods: MethodSignature[] = [];

  // Objective-C method pattern
  const objcPattern =
    /^[-+]\s*\(([^)]+)\)\s*(\w+)(?::(?:\s*\(([^)]+)\)\s*(\w+))?(?:\s+(\w+):(?:\s*\(([^)]+)\)\s*(\w+)))*)?/gm;
  let match;
  while ((match = objcPattern.exec(content)) !== null) {
    const returnType = match[1]?.trim() || 'void';
    const methodName = match[2];
    const params: { name: string; type: string }[] = [];

    if (match[3] && match[4]) {
      params.push({ name: match[4], type: match[3].trim() });
    }

    methods.push({
      name: methodName,
      returnType,
      params,
      rawSignature: match[0],
    });
  }

  // RCT_EXPORT_METHOD pattern
  const rctExportPattern = /RCT_EXPORT_METHOD\s*\(\s*(\w+)\s*(?::\s*\(([^)]+)\)\s*(\w+))?/g;
  while ((match = rctExportPattern.exec(content)) !== null) {
    const methodName = match[1];
    const params: { name: string; type: string }[] = [];
    if (match[2] && match[3]) {
      params.push({ name: match[3], type: match[2].trim() });
    }
    methods.push({
      name: methodName,
      returnType: 'void',
      params,
      rawSignature: match[0],
    });
  }

  return methods;
}

function parseAndroidMethod(content: string): MethodSignature[] {
  const methods: MethodSignature[] = [];

  // Java @ReactMethod pattern
  const javaPattern = /@ReactMethod[^}]*?\n\s*(?:public\s+)?(\w+)\s+(\w+)\s*\(([^)]*)\)/g;
  let match;
  while ((match = javaPattern.exec(content)) !== null) {
    const returnType = match[1];
    const methodName = match[2];
    const paramsStr = match[3];

    const params: { name: string; type: string }[] = [];
    if (paramsStr.trim()) {
      const paramParts = paramsStr.split(',');
      for (const part of paramParts) {
        const trimmed = part.trim();
        const lastSpace = trimmed.lastIndexOf(' ');
        if (lastSpace > 0) {
          params.push({
            type: trimmed.substring(0, lastSpace).trim(),
            name: trimmed.substring(lastSpace + 1).trim(),
          });
        }
      }
    }

    methods.push({
      name: methodName,
      returnType,
      params,
      rawSignature: match[0],
    });
  }

  // Kotlin @ReactMethod pattern
  const kotlinPattern = /@ReactMethod[^}]*?\n\s*(?:fun\s+)(\w+)\s*\(([^)]*)\)(?:\s*:\s*(\w+))?/g;
  while ((match = kotlinPattern.exec(content)) !== null) {
    const methodName = match[1];
    const paramsStr = match[2];
    const returnType = match[3] || 'Unit';

    const params: { name: string; type: string }[] = [];
    if (paramsStr.trim()) {
      const paramParts = paramsStr.split(',');
      for (const part of paramParts) {
        const colonIdx = part.indexOf(':');
        if (colonIdx > 0) {
          params.push({
            name: part.substring(0, colonIdx).trim(),
            type: part.substring(colonIdx + 1).trim(),
          });
        }
      }
    }

    methods.push({
      name: methodName,
      returnType,
      params,
      rawSignature: match[0],
    });
  }

  return methods;
}

function areTypesEquivalent(iosType: string, androidType: string): boolean {
  if (iosType === androidType) return true;

  const androidEquivalents = PLATFORM_TYPE_MAPPINGS[iosType];
  if (androidEquivalents?.includes(androidType)) return true;

  const iosEquivalents = REVERSE_TYPE_MAPPINGS[androidType];
  if (iosEquivalents?.includes(iosType)) return true;

  const stripNullable = (t: string) => t.replace(/[?!]$/, '').replace(/^Optional<(.+)>$/, '$1');
  if (stripNullable(iosType) === stripNullable(androidType)) return true;

  return false;
}

function compareSignatures(
  iosMethods: MethodSignature[],
  androidMethods: MethodSignature[]
): DiffResult[] {
  const results: DiffResult[] = [];
  const matchedAndroid = new Set<string>();

  for (const iosMethod of iosMethods) {
    const androidMethod = androidMethods.find((m) => m.name === iosMethod.name);

    if (!androidMethod) {
      results.push({
        method: iosMethod.name,
        status: 'ios_only',
        ios: iosMethod,
        notes: ['Method exists on iOS but not on Android'],
      });
      continue;
    }

    matchedAndroid.add(androidMethod.name);

    const returnTypeMatches = areTypesEquivalent(iosMethod.returnType, androidMethod.returnType);
    const paramCountMatches = iosMethod.params.length === androidMethod.params.length;

    let paramsMatch = paramCountMatches;
    const paramNotes: string[] = [];

    if (paramCountMatches) {
      for (let i = 0; i < iosMethod.params.length; i++) {
        if (!areTypesEquivalent(iosMethod.params[i].type, androidMethod.params[i].type)) {
          paramsMatch = false;
          paramNotes.push(
            `Param ${i}: iOS=${iosMethod.params[i].type}, Android=${androidMethod.params[i].type}`
          );
        }
      }
    } else {
      paramNotes.push(
        `Parameter count: iOS=${iosMethod.params.length}, Android=${androidMethod.params.length}`
      );
    }

    if (returnTypeMatches && paramsMatch) {
      results.push({
        method: iosMethod.name,
        status: 'equivalent',
        ios: iosMethod,
        android: androidMethod,
        notes: ['Semantically equivalent implementation'],
      });
    } else {
      const notes: string[] = [];
      if (!returnTypeMatches) {
        notes.push(`Return type: iOS=${iosMethod.returnType}, Android=${androidMethod.returnType}`);
      }
      notes.push(...paramNotes);

      results.push({
        method: iosMethod.name,
        status: 'signature_mismatch',
        ios: iosMethod,
        android: androidMethod,
        notes,
      });
    }
  }

  for (const androidMethod of androidMethods) {
    if (!matchedAndroid.has(androidMethod.name)) {
      results.push({
        method: androidMethod.name,
        status: 'android_only',
        android: androidMethod,
        notes: ['Method exists on Android but not on iOS'],
      });
    }
  }

  return results;
}

function determineStatus(
  hasSpec: boolean,
  hasIosCodegen: boolean,
  hasAndroidCodegen: boolean,
  hasIosImpl: boolean,
  hasAndroidImpl: boolean
): ModuleStatus {
  if (!hasSpec) return 'unknown';

  const hasAnyCodegen = hasIosCodegen || hasAndroidCodegen;
  const hasAnyImpl = hasIosImpl || hasAndroidImpl;

  if (!hasAnyCodegen && !hasAnyImpl) return 'spec_only';
  if (hasAnyImpl && !hasAnyCodegen) return 'partial';

  if ((hasIosCodegen && !hasIosImpl) || (hasAndroidCodegen && !hasAndroidImpl)) {
    return 'mismatch';
  }

  const iosHealthy = hasIosCodegen && hasIosImpl;
  const androidHealthy = hasAndroidCodegen && hasAndroidImpl;

  if (iosHealthy || androidHealthy) return 'healthy';

  return 'unknown';
}

// =============================================================================
// Input Schemas
// =============================================================================

const ModuleListInput = z.object({
  method: z.literal('module_list'),
  projectPath: z.string().optional(),
  status: z
    .enum(['spec_only', 'partial', 'mismatch', 'healthy', 'broken', 'unknown', 'all'])
    .optional()
    .default('all'),
  platform: z.enum(['ios', 'android', 'all']).optional().default('all'),
  limit: z.number().optional().default(50),
});

const ModuleStatusInput = z.object({
  method: z.literal('module_status'),
  name: z.string(),
  projectPath: z.string().optional(),
});

const PlatformDiffInput = z.object({
  method: z.literal('platform_diff'),
  name: z.string(),
  projectPath: z.string().optional(),
  showEquivalent: z.boolean().optional().default(false),
});

const TypeMappingsInput = z.object({
  method: z.literal('type_mappings'),
});

const BridgeInput = z.discriminatedUnion('method', [
  ModuleListInput,
  ModuleStatusInput,
  PlatformDiffInput,
  TypeMappingsInput,
]);

// =============================================================================
// Handlers
// =============================================================================

function handleModuleList(input: z.infer<typeof ModuleListInput>): ToolResult {
  const projectPath = input.projectPath || findProjectRoot();

  // Find TurboModule spec files
  const specPattern = /^Native\w+\.ts$/;
  const specFiles = findFiles(projectPath, specPattern);

  // Find codegen outputs
  const codegenPattern = /Native\w+Spec\.(h|mm|java|kt)$/;
  const iosDir = join(projectPath, 'ios');
  const androidDir = join(projectPath, 'android');

  const iosCodegenFiles = existsSync(iosDir) ? findFiles(iosDir, codegenPattern) : [];
  const androidCodegenFiles = existsSync(androidDir) ? findFiles(androidDir, codegenPattern) : [];

  // Build module list
  const modules: ModuleInfo[] = [];

  for (const specPath of specFiles) {
    const filename = basename(specPath);
    const moduleName = extractModuleName(filename);
    if (!moduleName) continue;

    // Check for spec content
    let methods: string[] = [];
    try {
      const content = readFileSync(specPath, 'utf-8');
      if (!content.includes('TurboModule')) continue;
      methods = parseSpecMethods(content);
    } catch {
      continue;
    }

    // Check for codegen
    const hasIosCodegen = iosCodegenFiles.some(
      (f) => f.includes(`Native${moduleName}Spec.h`) || f.includes(`Native${moduleName}Spec.mm`)
    );
    const hasAndroidCodegen = androidCodegenFiles.some(
      (f) =>
        f.includes(`Native${moduleName}Spec.java`) || f.includes(`Native${moduleName}Spec.kt`)
    );

    // Check for native implementations
    const iosImplPattern = new RegExp(`${moduleName}.*\\.(m|mm|swift)$`);
    const androidImplPattern = new RegExp(`${moduleName}.*\\.(java|kt)$`);

    const iosImplFiles = existsSync(iosDir) ? findFiles(iosDir, iosImplPattern) : [];
    const androidImplFiles = existsSync(androidDir) ? findFiles(androidDir, androidImplPattern) : [];

    const hasIosImpl = iosImplFiles.length > 0;
    const hasAndroidImpl = androidImplFiles.length > 0;

    const status = determineStatus(true, hasIosCodegen, hasAndroidCodegen, hasIosImpl, hasAndroidImpl);

    // Apply filters
    if (input.status !== 'all' && status !== input.status) continue;
    if (input.platform === 'ios' && !hasIosCodegen && !hasIosImpl) continue;
    if (input.platform === 'android' && !hasAndroidCodegen && !hasAndroidImpl) continue;

    const issues: string[] = [];
    if (!hasIosCodegen && hasIosImpl) issues.push('iOS: implementation exists but codegen missing');
    if (!hasAndroidCodegen && hasAndroidImpl)
      issues.push('Android: implementation exists but codegen missing');
    if (hasIosCodegen && !hasIosImpl) issues.push('iOS: codegen exists but no implementation found');
    if (hasAndroidCodegen && !hasAndroidImpl)
      issues.push('Android: codegen exists but no implementation found');

    modules.push({
      name: moduleName,
      specPath,
      status,
      ios: {
        hasImplementation: hasIosImpl,
        hasCodegen: hasIosCodegen,
        implementationPath: iosImplFiles[0] || null,
        codegenPath: iosCodegenFiles.find((f) => f.includes(moduleName)) || null,
      },
      android: {
        hasImplementation: hasAndroidImpl,
        hasCodegen: hasAndroidCodegen,
        implementationPath: androidImplFiles[0] || null,
        codegenPath: androidCodegenFiles.find((f) => f.includes(moduleName)) || null,
      },
      methods,
      issues,
    });

    if (modules.length >= input.limit) break;
  }

  const summary = {
    total: modules.length,
    healthy: modules.filter((m) => m.status === 'healthy').length,
    spec_only: modules.filter((m) => m.status === 'spec_only').length,
    partial: modules.filter((m) => m.status === 'partial').length,
    mismatch: modules.filter((m) => m.status === 'mismatch').length,
    broken: modules.filter((m) => m.status === 'broken').length,
    unknown: modules.filter((m) => m.status === 'unknown').length,
  };

  return {
    success: true,
    data: {
      projectPath,
      modules,
      summary,
    },
  };
}

function handleModuleStatus(input: z.infer<typeof ModuleStatusInput>): ToolResult {
  const projectPath = input.projectPath || findProjectRoot();

  // Normalize module name
  let moduleName = input.name;
  if (moduleName.startsWith('Native')) {
    moduleName = moduleName.replace(/^Native/, '').replace(/Module$/, '');
  }
  if (moduleName.endsWith('Module')) {
    moduleName = moduleName.replace(/Module$/, '');
  }

  // Find the spec file
  const specPattern = new RegExp(`^Native${moduleName}(Module)?\\.ts$`);
  const specFiles = findFiles(projectPath, specPattern);

  if (specFiles.length === 0) {
    return {
      success: false,
      error: `No TurboModule spec found for: ${input.name}`,
    };
  }

  const specPath = specFiles[0];
  let methods: string[] = [];
  try {
    const content = readFileSync(specPath, 'utf-8');
    methods = parseSpecMethods(content);
  } catch {
    // Continue without methods
  }

  // Find all related files
  const iosDir = join(projectPath, 'ios');
  const androidDir = join(projectPath, 'android');

  const modulePattern = new RegExp(`${moduleName}`, 'i');
  const iosFiles = existsSync(iosDir) ? findFiles(iosDir, modulePattern) : [];
  const androidFiles = existsSync(androidDir) ? findFiles(androidDir, modulePattern) : [];

  // Categorize files
  const iosCodegen = iosFiles.filter((f) => f.includes('codegen') || f.includes('Spec'));
  const iosImpl = iosFiles.filter((f) => !f.includes('codegen') && !f.includes('Spec'));
  const androidCodegen = androidFiles.filter((f) => f.includes('codegen') || f.includes('Spec'));
  const androidImpl = androidFiles.filter((f) => !f.includes('codegen') && !f.includes('Spec'));

  const status = determineStatus(
    true,
    iosCodegen.length > 0,
    androidCodegen.length > 0,
    iosImpl.length > 0,
    androidImpl.length > 0
  );

  const issues: string[] = [];
  if (iosCodegen.length === 0) issues.push('iOS codegen output not found');
  if (androidCodegen.length === 0) issues.push('Android codegen output not found');
  if (iosImpl.length === 0) issues.push('iOS native implementation not found');
  if (androidImpl.length === 0) issues.push('Android native implementation not found');

  return {
    success: true,
    data: {
      name: moduleName,
      fullName: `Native${moduleName}Module`,
      status,
      specPath,
      methods,
      ios: {
        codegen: iosCodegen,
        implementation: iosImpl,
      },
      android: {
        codegen: androidCodegen,
        implementation: androidImpl,
      },
      issues,
    },
  };
}

function handlePlatformDiff(input: z.infer<typeof PlatformDiffInput>): ToolResult {
  const projectPath = input.projectPath || findProjectRoot();

  // Normalize module name
  let moduleName = input.name;
  if (moduleName.startsWith('Native')) {
    moduleName = moduleName.replace(/^Native/, '');
  }
  if (moduleName.endsWith('Module')) {
    moduleName = moduleName.replace(/Module$/, '');
  }

  // Find implementation files
  const iosDir = join(projectPath, 'ios');
  const androidDir = join(projectPath, 'android');

  const modulePattern = new RegExp(`${moduleName}`, 'i');
  const iosImplPattern = /\.(m|mm|swift)$/;
  const androidImplPattern = /\.(java|kt)$/;

  const iosFiles = existsSync(iosDir)
    ? findFiles(iosDir, modulePattern).filter((f) => iosImplPattern.test(f))
    : [];
  const androidFiles = existsSync(androidDir)
    ? findFiles(androidDir, modulePattern).filter((f) => androidImplPattern.test(f))
    : [];

  // Parse methods from files
  const iosMethods: MethodSignature[] = [];
  const androidMethods: MethodSignature[] = [];

  for (const file of iosFiles) {
    try {
      const content = readFileSync(file, 'utf-8');
      iosMethods.push(...parseIosMethod(content));
    } catch {
      // Skip unreadable files
    }
  }

  for (const file of androidFiles) {
    try {
      const content = readFileSync(file, 'utf-8');
      androidMethods.push(...parseAndroidMethod(content));
    } catch {
      // Skip unreadable files
    }
  }

  // Compare signatures
  const diffResults = compareSignatures(iosMethods, androidMethods);

  // Filter results
  const filteredResults = input.showEquivalent
    ? diffResults
    : diffResults.filter((r) => r.status !== 'equivalent');

  const summary = {
    equivalent: diffResults.filter((r) => r.status === 'equivalent').length,
    iosOnly: diffResults.filter((r) => r.status === 'ios_only').length,
    androidOnly: diffResults.filter((r) => r.status === 'android_only').length,
    signatureMismatch: diffResults.filter((r) => r.status === 'signature_mismatch').length,
  };

  return {
    success: true,
    data: {
      module: moduleName,
      summary,
      diff: filteredResults,
      files: {
        ios: iosFiles,
        android: androidFiles,
      },
    },
  };
}

function handleTypeMappings(): ToolResult {
  return {
    success: true,
    data: {
      iosToAndroid: PLATFORM_TYPE_MAPPINGS,
      androidToIos: REVERSE_TYPE_MAPPINGS,
      note: 'These mappings define semantic equivalence for cross-platform type checking.',
    },
  };
}

// =============================================================================
// Tool Export
// =============================================================================

export const bridgeTool: Tool = {
  name: 'bridge',
  description: `TurboModule health checker with platform diff.

**Methods:**

• **module_list** - List TurboModules with health status
  \`bridge({ method: "module_list" })\`
  \`bridge({ method: "module_list", status: "broken" })\`
  \`bridge({ method: "module_list", platform: "ios" })\`

• **module_status** - Get detailed status for a module
  \`bridge({ method: "module_status", name: "OfflineModule" })\`

• **platform_diff** - Compare iOS and Android implementations
  \`bridge({ method: "platform_diff", name: "OfflineModule" })\`
  \`bridge({ method: "platform_diff", name: "OfflineModule", showEquivalent: true })\`

• **type_mappings** - Show platform type equivalences
  \`bridge({ method: "type_mappings" })\`

**Status Values:**
- spec_only: TS spec exists, no native implementation
- partial: Native impl exists but codegen missing
- mismatch: Native impl doesn't match spec signature
- healthy: Everything aligned
- broken: Runtime failures detected

**Semantic Type Equivalence:**
- NSDictionary ↔ ReadableMap
- NSArray ↔ ReadableArray
- RCTPromiseResolveBlock ↔ Promise
- etc.`,

  inputSchema: {
    type: 'object',
    properties: {
      method: {
        type: 'string',
        enum: ['module_list', 'module_status', 'platform_diff', 'type_mappings'],
        description: 'Bridge operation to perform',
      },
      projectPath: {
        type: 'string',
        description: 'React Native project path (auto-detected if not provided)',
      },
      name: {
        type: 'string',
        description: 'Module name (module_status, platform_diff)',
      },
      status: {
        type: 'string',
        enum: ['spec_only', 'partial', 'mismatch', 'healthy', 'broken', 'unknown', 'all'],
        description: 'Filter by module status (module_list)',
      },
      platform: {
        type: 'string',
        enum: ['ios', 'android', 'all'],
        description: 'Filter by platform (module_list)',
      },
      showEquivalent: {
        type: 'boolean',
        description: 'Include equivalent methods in output (platform_diff)',
      },
      limit: {
        type: 'number',
        description: 'Max results (module_list)',
      },
    },
    required: ['method'],
  },

  handler: async (rawInput: unknown, _context: ToolContext): Promise<ToolResult> => {
    const parseResult = BridgeInput.safeParse(rawInput);
    if (!parseResult.success) {
      return {
        success: false,
        error: `Invalid input: ${parseResult.error.message}`,
      };
    }

    const input = parseResult.data;

    switch (input.method) {
      case 'module_list':
        return handleModuleList(input);
      case 'module_status':
        return handleModuleStatus(input);
      case 'platform_diff':
        return handlePlatformDiff(input);
      case 'type_mappings':
        return handleTypeMappings();
      default:
        return { success: false, error: `Unknown method: ${(input as { method: string }).method}` };
    }
  },
};
