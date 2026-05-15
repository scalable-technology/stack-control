/**
 * control/device — Device Management Layer
 *
 * iOS Simulator and Android Emulator management.
 * Direct device control without server dependency.
 *
 * Methods:
 * - list          List iOS simulators and Android emulators
 * - boot          Boot a simulator/emulator
 * - shutdown      Shutdown a device
 * - install       Install an app
 * - launch        Launch an app
 * - logs          Get device logs
 * - screenshot    Capture screenshot
 * - crash_logs    List crash logs
 * - fingerprint   Generate native code fingerprint
 */

import { z } from 'zod';
import { spawn, execSync, ChildProcess } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import type { Tool, ToolContext, ToolResult } from '../types.js';

// =============================================================================
// Types
// =============================================================================

interface DeviceInfo {
  id: string;
  name: string;
  platform: 'ios' | 'android';
  type: 'simulator' | 'emulator' | 'device';
  state: 'booted' | 'shutdown' | 'unavailable';
  os: string;
}

// =============================================================================
// Helpers
// =============================================================================

function exec(cmd: string, options: { cwd?: string; timeout?: number } = {}): string {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: options.timeout || 30000,
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const err = error as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
    const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString();
    const stdout = typeof err.stdout === 'string' ? err.stdout : err.stdout?.toString();
    // Some tools (like idevicescreenshot) write errors to stdout
    throw new Error(stderr || stdout || err.message || 'Command failed');
  }
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect if an iOS device ID is a simulator or physical device.
 * Simulator UDIDs are standard UUIDs (36 chars with hyphens).
 * Physical device UDIDs are 40-char hex strings (older) or 25-char with hyphens (newer).
 */
function isIOSSimulator(deviceId: string): boolean {
  // Simulator UDIDs are standard UUIDs: 8-4-4-4-12 format (36 chars)
  const simulatorPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return simulatorPattern.test(deviceId);
}

function listIOSSimulators(): DeviceInfo[] {
  if (!commandExists('xcrun')) return [];
  try {
    const output = exec('xcrun simctl list devices -j');
    const data = JSON.parse(output);
    const devices: DeviceInfo[] = [];
    for (const [runtime, runtimeDevices] of Object.entries(data.devices)) {
      const osMatch = runtime.match(/iOS[- ](\d+[.-]\d+)/);
      const osVersion = osMatch ? osMatch[1].replace('-', '.') : '';
      for (const device of runtimeDevices as any[]) {
        devices.push({
          id: device.udid,
          name: device.name,
          platform: 'ios',
          type: 'simulator',
          state: device.state.toLowerCase() as DeviceInfo['state'],
          os: osVersion ? `iOS ${osVersion}` : 'iOS',
        });
      }
    }
    return devices;
  } catch {
    return [];
  }
}

function listAndroidEmulators(): DeviceInfo[] {
  if (!commandExists('emulator')) return [];
  try {
    const output = exec('emulator -list-avds');
    return output
      .split('\n')
      .filter(Boolean)
      .map((name) => ({
        id: name,
        name,
        platform: 'android' as const,
        type: 'emulator' as const,
        state: 'shutdown' as const,
        os: 'Android',
      }));
  } catch {
    return [];
  }
}

function listAndroidDevices(): DeviceInfo[] {
  if (!commandExists('adb')) return [];
  try {
    const output = exec('adb devices -l');
    const lines = output
      .split('\n')
      .slice(1)
      .filter((l) => l.trim());
    return lines.map((line) => {
      const [id, ...rest] = line.split(/\s+/);
      const model = rest.find((p) => p.startsWith('model:'))?.split(':')[1] || 'Unknown';
      return {
        id,
        name: model,
        platform: 'android' as const,
        type: 'device' as const,
        state: (rest[0] === 'device' ? 'booted' : 'unavailable') as DeviceInfo['state'],
        os: 'Android',
      };
    });
  } catch {
    return [];
  }
}

function listIOSDevices(): DeviceInfo[] {
  if (!commandExists('idevice_id')) return [];
  try {
    const output = exec('idevice_id -l');
    const udids = output.split('\n').filter(Boolean);
    return udids.map((udid) => {
      let name = 'iOS Device';
      try {
        name = exec(`ideviceinfo -u ${udid} -k DeviceName`);
      } catch {
        /* ignore */
      }
      return {
        id: udid,
        name,
        platform: 'ios' as const,
        type: 'device' as const,
        state: 'booted' as const,
        os: 'iOS',
      };
    });
  } catch {
    return [];
  }
}

function findProjectRoot(startDir: string = process.cwd()): string {
  let dir = startDir;
  while (dir !== '/') {
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) || existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    dir = resolve(dir, '..');
  }
  return startDir;
}

function generateFingerprint(
  projectPath: string,
  showSources: boolean
): { hash: string; sources?: string[]; sourceCount: number } | null {
  try {
    const sources: string[] = [];
    const hasher = createHash('sha256');

    // Hash native directories
    const nativeDirs = ['ios', 'android'].map((d) => join(projectPath, d));

    for (const dir of nativeDirs) {
      if (!existsSync(dir)) continue;

      try {
        const files = readdirSync(dir, { recursive: true, withFileTypes: true });
        for (const f of files) {
          if (f.isFile()) {
            const parentPath = (f as any).parentPath || (f as any).path || dir;
            const path = join(parentPath, f.name);
            try {
              const content = readFileSync(path);
              hasher.update(content);
              sources.push(path.replace(projectPath, ''));
            } catch {
              // Skip unreadable files
            }
          }
        }
      } catch {
        // Permission denied
      }
    }

    if (sources.length === 0) return null;

    return {
      hash: hasher.digest('hex').slice(0, 16),
      sources: showSources ? sources : undefined,
      sourceCount: sources.length,
    };
  } catch {
    return null;
  }
}

// =============================================================================
// Input Schemas
// =============================================================================

const ListInput = z.object({
  method: z.literal('list'),
  platform: z.enum(['ios', 'android', 'all']).optional().default('all'),
  available: z.boolean().optional().default(true),
});

const BootInput = z.object({
  method: z.literal('boot'),
  deviceId: z.string(),
  platform: z.enum(['ios', 'android']),
});

const ShutdownInput = z.object({
  method: z.literal('shutdown'),
  deviceId: z.string(),
  platform: z.enum(['ios', 'android']),
});

const InstallInput = z.object({
  method: z.literal('install'),
  deviceId: z.string(),
  platform: z.enum(['ios', 'android']),
  appPath: z.string(),
});

const LaunchInput = z.object({
  method: z.literal('launch'),
  deviceId: z.string(),
  platform: z.enum(['ios', 'android']),
  bundleId: z.string(),
  args: z.array(z.string()).optional(),
});

const LogsInput = z.object({
  method: z.literal('logs'),
  deviceId: z.string(),
  platform: z.enum(['ios', 'android']),
  bundleId: z.string().optional(),
  lines: z.number().optional().default(100),
});

const ScreenshotInput = z.object({
  method: z.literal('screenshot'),
  deviceId: z.string(),
  platform: z.enum(['ios', 'android']),
  outputPath: z.string().optional(),
});

const CrashLogsInput = z.object({
  method: z.literal('crash_logs'),
  deviceId: z.string().optional(),
  platform: z.enum(['ios', 'android']).optional(),
  appName: z.string().optional(),
  limit: z.number().optional().default(10),
});

const FingerprintInput = z.object({
  method: z.literal('fingerprint'),
  projectPath: z.string().optional(),
  showSources: z.boolean().optional().default(false),
});

const DeviceInput = z.discriminatedUnion('method', [
  ListInput,
  BootInput,
  ShutdownInput,
  InstallInput,
  LaunchInput,
  LogsInput,
  ScreenshotInput,
  CrashLogsInput,
  FingerprintInput,
]);

// =============================================================================
// Handlers
// =============================================================================

function handleList(input: z.infer<typeof ListInput>): ToolResult {
  const devices: DeviceInfo[] = [];

  if (input.platform === 'ios' || input.platform === 'all') {
    devices.push(...listIOSSimulators());
    devices.push(...listIOSDevices());
  }
  if (input.platform === 'android' || input.platform === 'all') {
    devices.push(...listAndroidEmulators());
    devices.push(...listAndroidDevices());
  }

  const filtered = input.available
    ? devices.filter((d) => d.state === 'booted' || d.state === 'shutdown' || d.type === 'emulator')
    : devices;

  // Group by type for better display
  const simulators = filtered.filter((d) => d.type === 'simulator');
  const emulators = filtered.filter((d) => d.type === 'emulator');
  const physicalDevices = filtered.filter((d) => d.type === 'device');

  return {
    success: true,
    data: {
      simulators,
      emulators,
      devices: physicalDevices,
      total: filtered.length,
    },
  };
}

function handleBoot(input: z.infer<typeof BootInput>): ToolResult {
  try {
    if (input.platform === 'ios') {
      exec(`xcrun simctl boot ${input.deviceId}`);
      exec('open -a Simulator');
    } else {
      spawn('emulator', ['-avd', input.deviceId], { detached: true, stdio: 'ignore' }).unref();
    }
    return {
      success: true,
      data: {
        deviceId: input.deviceId,
        platform: input.platform,
        status: 'booting',
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function handleShutdown(input: z.infer<typeof ShutdownInput>): ToolResult {
  try {
    if (input.platform === 'ios') {
      exec(`xcrun simctl shutdown ${input.deviceId}`);
    } else {
      exec(`adb -s ${input.deviceId} emu kill`);
    }
    return {
      success: true,
      data: {
        deviceId: input.deviceId,
        platform: input.platform,
        status: 'shutdown',
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function handleInstall(input: z.infer<typeof InstallInput>): ToolResult {
  try {
    if (!existsSync(input.appPath)) {
      return {
        success: false,
        error: `App not found: ${input.appPath}`,
      };
    }

    if (input.platform === 'ios') {
      if (input.appPath.endsWith('.ipa')) {
        exec(`ideviceinstaller -u ${input.deviceId} -i "${input.appPath}"`);
      } else {
        exec(`xcrun simctl install ${input.deviceId} "${input.appPath}"`);
      }
    } else {
      exec(`adb -s ${input.deviceId} install -r "${input.appPath}"`);
    }

    return {
      success: true,
      data: {
        deviceId: input.deviceId,
        appPath: input.appPath,
        status: 'installed',
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function handleLaunch(input: z.infer<typeof LaunchInput>): ToolResult {
  try {
    if (input.platform === 'ios') {
      const args = input.args?.length ? input.args.map((a) => `--args ${a}`).join(' ') : '';
      exec(`xcrun simctl launch ${input.deviceId} ${input.bundleId} ${args}`);
    } else {
      exec(`adb -s ${input.deviceId} shell am start -n ${input.bundleId}/.MainActivity`);
    }

    return {
      success: true,
      data: {
        deviceId: input.deviceId,
        bundleId: input.bundleId,
        status: 'launched',
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function handleLogs(input: z.infer<typeof LogsInput>): Promise<ToolResult> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    let proc: ChildProcess;

    if (input.platform === 'ios') {
      const args = input.bundleId
        ? [
            'simctl',
            'spawn',
            input.deviceId,
            'log',
            'stream',
            '--predicate',
            `subsystem == "${input.bundleId}"`,
          ]
        : ['simctl', 'spawn', input.deviceId, 'log', 'stream'];
      proc = spawn('xcrun', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      proc = spawn('adb', ['-s', input.deviceId, 'logcat', '-d'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }

    proc.stdout?.on('data', (data) => {
      lines.push(...data.toString().split('\n'));
      if (lines.length >= input.lines) {
        proc.kill();
      }
    });

    const timeout = setTimeout(() => {
      proc.kill();
      resolve({
        success: true,
        data: {
          logs: lines.slice(-input.lines).join('\n'),
          lineCount: Math.min(lines.length, input.lines),
        },
      });
    }, 5000);

    proc.on('close', () => {
      clearTimeout(timeout);
      resolve({
        success: true,
        data: {
          logs: lines.slice(-input.lines).join('\n'),
          lineCount: Math.min(lines.length, input.lines),
        },
      });
    });
  });
}

function handleScreenshot(input: z.infer<typeof ScreenshotInput>): ToolResult {
  try {
    const outputPath = input.outputPath || join(process.cwd(), `screenshot-${Date.now()}.png`);
    const dir = resolve(outputPath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (input.platform === 'ios') {
      if (isIOSSimulator(input.deviceId)) {
        // Simulator: use simctl
        exec(`xcrun simctl io ${input.deviceId} screenshot "${outputPath}"`);
      } else {
        // Physical device: use idevicescreenshot (requires Developer disk image)
        if (!commandExists('idevicescreenshot')) {
          return {
            success: false,
            error: 'idevicescreenshot not found. Install with: brew install libimobiledevice',
          };
        }
        try {
          exec(`idevicescreenshot -u ${input.deviceId} "${outputPath}"`);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          if (errMsg.includes('screenshotr') || errMsg.includes('Developer')) {
            return {
              success: false,
              error: `Screenshot failed: Developer disk image not mounted.\n\nTo fix:\n1. Open Xcode\n2. Go to Window > Devices and Simulators\n3. Select your device\n4. Wait for "Preparing debugger support" to complete\n\nAlternatively, run your app from Xcode once to auto-mount the image.`,
            };
          }
          throw error;
        }
      }
    } else {
      exec(`adb -s ${input.deviceId} exec-out screencap -p > "${outputPath}"`);
    }

    return {
      success: true,
      data: {
        path: outputPath,
        deviceId: input.deviceId,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function handleCrashLogs(input: z.infer<typeof CrashLogsInput>): ToolResult {
  const crashDirs = [
    '/Library/Logs/DiagnosticReports',
    `${process.env.HOME}/Library/Logs/DiagnosticReports`,
  ];

  const crashes: Array<{
    path: string;
    name: string;
    date: string;
    size: number;
  }> = [];

  for (const dir of crashDirs) {
    if (!existsSync(dir)) continue;

    try {
      const files = readdirSync(dir);
      for (const file of files) {
        // Filter by app name if provided
        if (input.appName && !file.toLowerCase().includes(input.appName.toLowerCase())) {
          continue;
        }

        // Check for crash file extensions
        if (file.endsWith('.ips') || file.endsWith('.crash') || file.includes('panic')) {
          const fullPath = join(dir, file);
          try {
            const stats = require('fs').statSync(fullPath);
            crashes.push({
              path: fullPath,
              name: file,
              date: stats.mtime.toISOString(),
              size: stats.size,
            });
          } catch {
            // Skip unreadable files
          }
        }
      }
    } catch {
      // Permission denied
    }
  }

  // Sort by date, newest first
  crashes.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return {
    success: true,
    data: {
      crashes: crashes.slice(0, input.limit),
      total: crashes.length,
      note: crashes.length > input.limit ? `Showing ${input.limit} of ${crashes.length}` : undefined,
    },
  };
}

function handleFingerprint(input: z.infer<typeof FingerprintInput>): ToolResult {
  const projectPath = input.projectPath || findProjectRoot();
  const fingerprint = generateFingerprint(projectPath, input.showSources);

  if (!fingerprint) {
    return {
      success: false,
      error: 'Could not generate fingerprint. No native code found.',
    };
  }

  return {
    success: true,
    data: {
      projectPath,
      hash: fingerprint.hash,
      sources: fingerprint.sources,
      sourceCount: fingerprint.sourceCount,
      note: 'Hash changes when native code is modified. Use to detect stale builds.',
    },
  };
}

// =============================================================================
// Tool Export
// =============================================================================

export const deviceTool: Tool = {
  name: 'device',
  description: `iOS Simulator and Android Emulator management.

**Methods:**

• **list** - List simulators/emulators/devices
  \`device({ method: "list" })\`
  \`device({ method: "list", platform: "ios" })\`

• **boot** - Boot a simulator/emulator
  \`device({ method: "boot", deviceId: "...", platform: "ios" })\`

• **shutdown** - Shutdown a device
  \`device({ method: "shutdown", deviceId: "...", platform: "ios" })\`

• **install** - Install an app
  \`device({ method: "install", deviceId: "...", platform: "ios", appPath: "/path/to/app.app" })\`

• **launch** - Launch an app
  \`device({ method: "launch", deviceId: "...", platform: "ios", bundleId: "com.example.app" })\`

• **logs** - Get device logs
  \`device({ method: "logs", deviceId: "...", platform: "ios", lines: 100 })\`

• **screenshot** - Capture screenshot
  \`device({ method: "screenshot", deviceId: "...", platform: "ios" })\`

• **crash_logs** - List crash logs
  \`device({ method: "crash_logs" })\`
  \`device({ method: "crash_logs", appName: "MyApp" })\`

• **fingerprint** - Generate native code fingerprint
  \`device({ method: "fingerprint" })\`
  \`device({ method: "fingerprint", showSources: true })\`

Fingerprint detects when native code changes, indicating rebuild is needed.`,

  inputSchema: {
    type: 'object',
    properties: {
      method: {
        type: 'string',
        enum: [
          'list',
          'boot',
          'shutdown',
          'install',
          'launch',
          'logs',
          'screenshot',
          'crash_logs',
          'fingerprint',
        ],
        description: 'Device operation to perform',
      },
      deviceId: {
        type: 'string',
        description: 'Device/simulator UDID',
      },
      platform: {
        type: 'string',
        enum: ['ios', 'android', 'all'],
        description: 'Platform',
      },
      available: {
        type: 'boolean',
        description: 'Only available devices (list)',
      },
      appPath: {
        type: 'string',
        description: 'Path to .app/.apk (install)',
      },
      bundleId: {
        type: 'string',
        description: 'App bundle ID (launch, logs)',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Launch arguments',
      },
      lines: {
        type: 'number',
        description: 'Number of log lines',
      },
      outputPath: {
        type: 'string',
        description: 'Screenshot output path',
      },
      appName: {
        type: 'string',
        description: 'Filter crash logs by app name',
      },
      limit: {
        type: 'number',
        description: 'Max crash logs to return',
      },
      projectPath: {
        type: 'string',
        description: 'Project path for fingerprint',
      },
      showSources: {
        type: 'boolean',
        description: 'Include source files in fingerprint',
      },
    },
    required: ['method'],
  },

  handler: async (rawInput: unknown, _context: ToolContext): Promise<ToolResult> => {
    const parseResult = DeviceInput.safeParse(rawInput);
    if (!parseResult.success) {
      return {
        success: false,
        error: `Invalid input: ${parseResult.error.message}`,
      };
    }

    const input = parseResult.data;

    switch (input.method) {
      case 'list':
        return handleList(input);
      case 'boot':
        return handleBoot(input);
      case 'shutdown':
        return handleShutdown(input);
      case 'install':
        return handleInstall(input);
      case 'launch':
        return handleLaunch(input);
      case 'logs':
        return handleLogs(input);
      case 'screenshot':
        return handleScreenshot(input);
      case 'crash_logs':
        return handleCrashLogs(input);
      case 'fingerprint':
        return handleFingerprint(input);
      default:
        return { success: false, error: `Unknown method: ${(input as { method: string }).method}` };
    }
  },
};
