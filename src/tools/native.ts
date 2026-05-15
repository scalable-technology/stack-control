/**
 * control/native — Native Code Layer
 *
 * Full LLDB integration with batch and interactive modes.
 * Full-stack native debugging for Control.
 *
 * Batch Methods (stateless):
 * - crash_run: Run binary and capture crash details
 * - breakpoint_trace: Trace breakpoints during execution
 * - variable_inspect: Inspect variable at breakpoint
 * - memory_read: Read memory at address
 * - expression: Evaluate LLDB expression
 *
 * Interactive Methods (session-based):
 * - session_attach: Start debugging session
 * - session_detach: End debugging session
 * - session_status: Get session state
 * - session_list: List active sessions
 * - simulator_launch: Launch app on simulator with debugger
 * - breakpoint_set/list/delete: Manage breakpoints
 * - continue, step, backtrace, frame_select, inspect, memory, raw_command
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import { existsSync } from 'fs';
import { join, resolve, dirname, isAbsolute } from 'path';
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../types.js';

// =============================================================================
// Types
// =============================================================================

interface LldbSession {
  id: string;
  process: ChildProcess;
  deviceId?: string;
  pid?: number;
  binary?: string;
  state: 'starting' | 'running' | 'stopped' | 'exited';
  stopReason?: string;
  breakpoints: Map<number, { id: number; location: string; enabled: boolean; hitCount: number }>;
  outputBuffer: string;
  lastActivity: number;
  createdAt: number;
}

// =============================================================================
// Session Manager
// =============================================================================

const sessions = new Map<string, LldbSession>();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

function generateSessionId(): string {
  return `lldb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanupSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      destroySession(id);
    }
  }
}

setInterval(cleanupSessions, 5 * 60 * 1000);

function destroySession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  try {
    session.process.stdin?.write('quit\n');
    setTimeout(() => {
      try {
        session.process.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 1000);
  } catch {
    /* ignore */
  }
  sessions.delete(sessionId);
}

function getSession(sessionId: string): LldbSession | null {
  const session = sessions.get(sessionId);
  if (session) session.lastActivity = Date.now();
  return session || null;
}

// =============================================================================
// Helpers
// =============================================================================

function findWorkspaceRoot(startDir: string = process.cwd()): string {
  let dir = startDir;
  while (dir !== '/') {
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) || existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    dir = resolve(dir, '..');
  }
  return startDir;
}

function resolveBinaryPath(binary: string, workspaceRoot: string): string {
  return isAbsolute(binary) ? binary : join(workspaceRoot, binary);
}

function formatEnvVars(env?: Record<string, string>): string {
  if (!env || Object.keys(env).length === 0) return '';
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
}

function signalNumber(name: string): number {
  const numbers: Record<string, number> = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6,
    SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12,
    SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
  };
  return numbers[name] || 0;
}

async function runLldbBatch(
  script: string,
  options: { cwd: string; timeout: number }
): Promise<{ stdout: string; stderr: string; exitCode: number | null; exitSignal: string | null; duration: number }> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let killed = false;

    const proc = spawn('lldb', ['-b', '-s', '/dev/stdin'], {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdin.write(script);
    proc.stdin.end();

    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    const timeout = setTimeout(() => { killed = true; proc.kill('SIGKILL'); }, options.timeout);

    proc.on('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: code, exitSignal: killed ? 'SIGKILL' : signal, duration: Date.now() - startTime });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr: stderr + `\nProcess error: ${err.message}`, exitCode: null, exitSignal: null, duration: Date.now() - startTime });
    });
  });
}

function parseLldbOutput(output: string): {
  backtrace: { index: number; address: string; symbol: string; file?: string; line?: number; module: string }[];
  variables: Record<string, string>;
  registers: Record<string, string>;
  stopReason?: string;
} {
  const lines = output.split('\n');
  const backtrace: { index: number; address: string; symbol: string; file?: string; line?: number; module: string }[] = [];
  const btRegex = /^\s*(?:\*\s+)?frame #(\d+): (0x[0-9a-f]+) (.+?)`(.+?)(?:\s+\+\s+\d+)?(?:\s+at\s+(.+?):(\d+))?$/i;

  for (const line of lines) {
    const match = line.match(btRegex);
    if (match) {
      backtrace.push({
        index: parseInt(match[1], 10), address: match[2], module: match[3],
        symbol: match[4].trim(), file: match[5], line: match[6] ? parseInt(match[6], 10) : undefined,
      });
    }
  }

  const variables: Record<string, string> = {};
  const varRegex = /^\s*\((.+?)\)\s+(\w+)\s+=\s+(.+)$/;
  let inVariables = false;
  for (const line of lines) {
    if (line.includes('frame variable') || line.includes('(lldb) fr v')) { inVariables = true; continue; }
    if (inVariables) {
      const match = line.match(varRegex);
      if (match) variables[match[2]] = `(${match[1]}) ${match[3]}`;
      else if (line.trim() === '' || line.startsWith('(lldb)')) inVariables = false;
    }
  }

  const registers: Record<string, string> = {};
  const regRegex = /^\s*(x\d+|sp|pc|lr|fp|cpsr|w\d+)\s+=\s+(0x[0-9a-f]+)/i;
  for (const line of lines) {
    const match = line.match(regRegex);
    if (match) registers[match[1].toLowerCase()] = match[2];
  }

  let stopReason: string | undefined;
  const stopMatch = output.match(/stop reason = (.+)/);
  if (stopMatch) stopReason = stopMatch[1].trim();

  return { backtrace, variables, registers, stopReason };
}

async function sendCommand(session: LldbSession, command: string, timeout: number = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    let timer: ReturnType<typeof setTimeout>;
    let stabilityTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (stabilityTimer) clearTimeout(stabilityTimer);
      session.process.stdout?.off('data', onData);
      session.process.stderr?.off('data', onData);
    };

    const onData = (data: Buffer) => {
      const str = data.toString();
      session.outputBuffer += str;
      output += str;
      if (stabilityTimer) clearTimeout(stabilityTimer);
      stabilityTimer = setTimeout(() => {
        cleanup();
        let result = output;
        const cmdIndex = result.indexOf(command);
        if (cmdIndex !== -1) result = result.slice(cmdIndex + command.length);
        result = result.replace(/^\s*\(lldb\)\s*/gm, '').trim();
        resolve(result);
      }, 200);
    };

    session.process.stdout?.on('data', onData);
    session.process.stderr?.on('data', onData);

    timer = setTimeout(() => {
      cleanup();
      if (output.length > 0) resolve(output);
      else reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);

    session.process.stdin?.write(`${command}\n`);
  });
}

// =============================================================================
// Input Schemas (Batch)
// =============================================================================

const CrashRunInput = z.object({
  method: z.literal('crash_run'),
  binary: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  timeout: z.number().optional().default(60),
  workingDirectory: z.string().optional(),
});

const BreakpointTraceInput = z.object({
  method: z.literal('breakpoint_trace'),
  binary: z.string(),
  breakpoints: z.array(z.string()),
  captureCommands: z.array(z.string()).optional(),
  maxHits: z.number().optional().default(10),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  timeout: z.number().optional().default(120),
});

const VariableInspectInput = z.object({
  method: z.literal('variable_inspect'),
  binary: z.string(),
  variable: z.string(),
  atFunction: z.string(),
  format: z.enum(['default', 'hex', 'binary', 'decimal', 'char']).optional(),
  dereference: z.boolean().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  timeout: z.number().optional().default(60),
});

const MemoryReadInput = z.object({
  method: z.literal('memory_read'),
  binary: z.string(),
  address: z.string(),
  size: z.number().optional().default(64),
  format: z.enum(['hex', 'bytes', 'words', 'instructions']).optional().default('hex'),
  atFunction: z.string().optional(),
  args: z.array(z.string()).optional(),
  timeout: z.number().optional().default(60),
});

const ExpressionInput = z.object({
  method: z.literal('expression'),
  binary: z.string(),
  expression: z.string(),
  atFunction: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  timeout: z.number().optional().default(60),
});

// =============================================================================
// Input Schemas (Interactive)
// =============================================================================

const SessionAttachInput = z.object({
  method: z.literal('session_attach'),
  deviceId: z.string().optional(),
  bundleId: z.string().optional(),
  appName: z.string().optional(),
  pid: z.number().optional(),
  binary: z.string().optional(),
  waitForLaunch: z.boolean().optional(),
});

const SessionDetachInput = z.object({ method: z.literal('session_detach'), sessionId: z.string() });
const SessionStatusInput = z.object({ method: z.literal('session_status'), sessionId: z.string() });
const SessionListInput = z.object({ method: z.literal('session_list') });

const SimulatorLaunchInput = z.object({
  method: z.literal('simulator_launch'),
  deviceId: z.string(),
  bundleId: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  stopOnEntry: z.boolean().optional().default(true),
});

const BreakpointSetInput = z.object({
  method: z.literal('breakpoint_set'),
  sessionId: z.string(),
  location: z.string(),
  condition: z.string().optional(),
  ignoreCount: z.number().optional(),
  oneShot: z.boolean().optional(),
});

const BreakpointListInput = z.object({ method: z.literal('breakpoint_list'), sessionId: z.string() });
const BreakpointDeleteInput = z.object({ method: z.literal('breakpoint_delete'), sessionId: z.string(), breakpointId: z.number().optional(), all: z.boolean().optional() });
const ContinueInput = z.object({ method: z.literal('continue'), sessionId: z.string(), timeout: z.number().optional().default(30000) });
const StepInput = z.object({ method: z.literal('step'), sessionId: z.string(), type: z.enum(['over', 'into', 'out']), count: z.number().optional().default(1) });
const BacktraceInput = z.object({ method: z.literal('backtrace'), sessionId: z.string(), limit: z.number().optional().default(20), all: z.boolean().optional() });
const FrameSelectInput = z.object({ method: z.literal('frame_select'), sessionId: z.string(), index: z.number() });
const InspectInput = z.object({ method: z.literal('inspect'), sessionId: z.string(), variable: z.string().optional(), expression: z.string().optional(), frame: z.number().optional(), format: z.enum(['default', 'hex', 'binary', 'decimal', 'char']).optional() });
const SessionMemoryReadInput = z.object({ method: z.literal('memory'), sessionId: z.string(), address: z.string(), size: z.number().optional().default(64), format: z.enum(['hex', 'bytes', 'words', 'instructions']).optional() });
const RawCommandInput = z.object({ method: z.literal('raw_command'), sessionId: z.string(), command: z.string(), timeout: z.number().optional().default(10000) });

const NativeInput = z.discriminatedUnion('method', [
  CrashRunInput, BreakpointTraceInput, VariableInspectInput, MemoryReadInput, ExpressionInput,
  SessionAttachInput, SessionDetachInput, SessionStatusInput, SessionListInput, SimulatorLaunchInput,
  BreakpointSetInput, BreakpointListInput, BreakpointDeleteInput, ContinueInput, StepInput,
  BacktraceInput, FrameSelectInput, InspectInput, SessionMemoryReadInput, RawCommandInput,
]);

// =============================================================================
// Batch Handlers
// =============================================================================

async function handleCrashRun(input: z.infer<typeof CrashRunInput>, context: ToolContext): Promise<ToolResult> {
  const workspaceRoot = context.workspaceRoot || findWorkspaceRoot();
  const binaryPath = resolveBinaryPath(input.binary, workspaceRoot);

  if (!existsSync(binaryPath)) {
    return { success: false, error: `Binary not found: ${binaryPath}` };
  }

  const envSetup = input.env ? `settings set target.env-vars ${formatEnvVars(input.env)}` : '';
  const argsSetup = input.args?.length ? `settings set target.run-args ${input.args.join(' ')}` : '';

  const lldbScript = `
file "${binaryPath}"
${envSetup}
${argsSetup}
run
echo === CRASH CONTEXT ===
bt 50
echo === VARIABLES ===
frame variable
echo === REGISTERS ===
register read
echo === END CONTEXT ===
`;

  const cwd = input.workingDirectory ? resolveBinaryPath(input.workingDirectory, workspaceRoot) : dirname(binaryPath);
  const result = await runLldbBatch(lldbScript, { cwd, timeout: (input.timeout || 60) * 1000 });
  const parsed = parseLldbOutput(result.stdout);

  const crashed = result.exitSignal !== null || result.stdout.includes('stop reason = signal') ||
    result.stdout.includes('EXC_BAD_ACCESS') || result.stdout.includes('SIGABRT') || result.stdout.includes('SIGSEGV');

  let signal: number | null = null;
  let signalNameStr: string | null = null;
  const signalMatch = result.stdout.match(/stop reason = signal SIG(\w+)/);
  if (signalMatch) { signalNameStr = 'SIG' + signalMatch[1]; signal = signalNumber(signalNameStr); }

  return {
    success: true,
    data: {
      crashed, exitCode: result.exitCode, exitSignal: result.exitSignal, signal, signalName: signalNameStr,
      stopReason: parsed.stopReason, backtrace: parsed.backtrace, variables: parsed.variables, registers: parsed.registers,
      summary: crashed ? `Crashed with ${signalNameStr || 'unknown signal'} at ${parsed.backtrace[0]?.symbol || 'unknown'}` : `Exited normally with code ${result.exitCode}`,
    },
    meta: { duration: result.duration },
  };
}

async function handleBreakpointTrace(input: z.infer<typeof BreakpointTraceInput>, context: ToolContext): Promise<ToolResult> {
  const workspaceRoot = context.workspaceRoot || findWorkspaceRoot();
  const binaryPath = resolveBinaryPath(input.binary, workspaceRoot);

  if (!existsSync(binaryPath)) return { success: false, error: `Binary not found: ${binaryPath}` };

  const captureCommands = input.captureCommands || ['bt 10', 'frame variable'];
  const breakpointSetup = input.breakpoints.map((bp) => {
    if (bp.includes(':') && !bp.startsWith('0x')) {
      const [file, line] = bp.split(':');
      return `breakpoint set -f "${file}" -l ${line}`;
    }
    return `breakpoint set -n "${bp}"`;
  }).join('\n');

  const envSetup = input.env ? `settings set target.env-vars ${formatEnvVars(input.env)}` : '';
  const argsSetup = input.args?.length ? `settings set target.run-args ${input.args.join(' ')}` : '';

  const lldbScript = `
file "${binaryPath}"
${envSetup}
${argsSetup}
${breakpointSetup}
breakpoint command add -o "
echo === BREAKPOINT HIT ===
${captureCommands.join('\n')}
echo === END BREAKPOINT ===
continue
"
run
echo === FINAL STATE ===
bt 30
frame variable
echo === END FINAL ===
`;

  const result = await runLldbBatch(lldbScript, { cwd: dirname(binaryPath), timeout: (input.timeout || 120) * 1000 });

  const hits: { index: number; function: string; file?: string; line?: number; variables: Record<string, string> }[] = [];
  const sections = result.stdout.split(/=== BREAKPOINT HIT ===/);
  for (let i = 1; i < sections.length && hits.length < (input.maxHits || 10); i++) {
    const section = sections[i].split(/=== END BREAKPOINT ===/)[0] || sections[i];
    const parsed = parseLldbOutput(section);
    if (parsed.backtrace.length > 0) {
      const topFrame = parsed.backtrace[0];
      hits.push({ index: hits.length, function: topFrame.symbol, file: topFrame.file, line: topFrame.line, variables: parsed.variables });
    }
  }

  const finalSection = result.stdout.split('=== FINAL STATE ===')[1] || '';
  const finalParsed = parseLldbOutput(finalSection);
  const crashed = result.exitSignal !== null || result.stdout.includes('stop reason = signal');

  return {
    success: true,
    data: {
      hits, hitCount: hits.length, truncated: hits.length >= (input.maxHits || 10),
      finalState: { crashed, exitCode: result.exitCode, backtrace: finalParsed.backtrace, variables: finalParsed.variables },
      callSequence: hits.map((h) => h.function).join(' → '),
    },
    meta: { duration: result.duration },
  };
}

async function handleVariableInspect(input: z.infer<typeof VariableInspectInput>, context: ToolContext): Promise<ToolResult> {
  const workspaceRoot = context.workspaceRoot || findWorkspaceRoot();
  const binaryPath = resolveBinaryPath(input.binary, workspaceRoot);
  if (!existsSync(binaryPath)) return { success: false, error: `Binary not found: ${binaryPath}` };

  const formatFlag: Record<string, string> = { hex: '-f x', binary: '-f b', decimal: '-f d', char: '-f c', default: '' };
  const fmt = formatFlag[input.format || 'default'];
  const printCmd = input.dereference ? `p ${fmt} *${input.variable}` : `p ${fmt} ${input.variable}`;

  const envSetup = input.env ? `settings set target.env-vars ${formatEnvVars(input.env)}` : '';
  const argsSetup = input.args?.length ? `settings set target.run-args ${input.args.join(' ')}` : '';

  const lldbScript = `
file "${binaryPath}"
${envSetup}
${argsSetup}
breakpoint set -n "${input.atFunction}"
breakpoint command add -o "
echo === VARIABLE INSPECTION ===
${printCmd}
p &${input.variable}
frame variable
echo === END INSPECTION ===
continue
"
run
`;

  const result = await runLldbBatch(lldbScript, { cwd: dirname(binaryPath), timeout: (input.timeout || 60) * 1000 });
  const section = result.stdout.split('=== VARIABLE INSPECTION ===')[1]?.split('=== END INSPECTION ===')[0] || '';

  const printMatch = section.match(/\((.+?)\)\s+\$\d+\s+=\s+(.+)/);
  const type = printMatch?.[1] || 'unknown';
  const value = printMatch?.[2]?.trim() || 'unknown';

  const addrMatch = section.match(/\((.+?\s*\*)\)\s+\$\d+\s+=\s+(0x[0-9a-f]+)/i);
  const address = addrMatch?.[2] || 'unknown';

  const isNull = value === '0x0' || value === 'NULL' || value === 'nil' || value === '0x0000000000000000' || (value.startsWith('0x') && BigInt(value) === 0n);
  let isValid = !isNull;
  if (value.startsWith('0x')) { try { isValid = !isNull && BigInt(value) > 0x1000n; } catch { isValid = false; } }

  return { success: true, data: { variable: input.variable, atFunction: input.atFunction, value, address, type, isNull, isValid, otherVariables: parseLldbOutput(section).variables } };
}

async function handleMemoryRead(input: z.infer<typeof MemoryReadInput>, context: ToolContext): Promise<ToolResult> {
  const workspaceRoot = context.workspaceRoot || findWorkspaceRoot();
  const binaryPath = resolveBinaryPath(input.binary, workspaceRoot);
  if (!existsSync(binaryPath)) return { success: false, error: `Binary not found: ${binaryPath}` };

  const formatFlag: Record<string, string> = { hex: '-f x', bytes: '-f Y', words: '-f w', instructions: '-f i' };
  const fmt = formatFlag[input.format || 'hex'];
  const memoryCmd = `memory read ${fmt} -c ${input.size || 64} ${input.address}`;

  let lldbScript: string;
  if (input.atFunction) {
    lldbScript = `file "${binaryPath}"\n${input.args?.length ? `settings set target.run-args ${input.args.join(' ')}` : ''}\nbreakpoint set -n "${input.atFunction}"\nbreakpoint command add -o "\necho === MEMORY READ ===\n${memoryCmd}\necho === END MEMORY ===\ncontinue\n"\nrun`;
  } else {
    lldbScript = `file "${binaryPath}"\n${input.args?.length ? `settings set target.run-args ${input.args.join(' ')}` : ''}\nrun\necho === MEMORY READ ===\n${memoryCmd}\necho === END MEMORY ===`;
  }

  const result = await runLldbBatch(lldbScript, { cwd: dirname(binaryPath), timeout: (input.timeout || 60) * 1000 });
  const section = result.stdout.split('=== MEMORY READ ===')[1]?.split('=== END MEMORY ===')[0] || '';
  const memoryLines = section.split('\n').filter((line) => line.trim().startsWith('0x')).map((line) => line.trim());

  return { success: true, data: { address: input.address, size: input.size || 64, format: input.format || 'hex', memory: memoryLines.join('\n'), count: memoryLines.length } };
}

async function handleExpression(input: z.infer<typeof ExpressionInput>, context: ToolContext): Promise<ToolResult> {
  const workspaceRoot = context.workspaceRoot || findWorkspaceRoot();
  const binaryPath = resolveBinaryPath(input.binary, workspaceRoot);
  if (!existsSync(binaryPath)) return { success: false, error: `Binary not found: ${binaryPath}` };

  const envSetup = input.env ? `settings set target.env-vars ${formatEnvVars(input.env)}` : '';
  const argsSetup = input.args?.length ? `settings set target.run-args ${input.args.join(' ')}` : '';

  const lldbScript = `
file "${binaryPath}"
${envSetup}
${argsSetup}
breakpoint set -n "${input.atFunction}"
breakpoint command add -o "
echo === EXPRESSION RESULT ===
p ${input.expression}
echo === END EXPRESSION ===
continue
"
run
`;

  const result = await runLldbBatch(lldbScript, { cwd: dirname(binaryPath), timeout: (input.timeout || 60) * 1000 });
  const section = result.stdout.split('=== EXPRESSION RESULT ===')[1]?.split('=== END EXPRESSION ===')[0] || '';

  const exprMatch = section.match(/\((.+?)\)\s+\$\d+\s+=\s+(.+)/s);
  const type = exprMatch?.[1]?.trim() || 'unknown';
  const value = exprMatch?.[2]?.trim() || section.trim();

  return { success: true, data: { expression: input.expression, atFunction: input.atFunction, type, value, raw: section.trim() } };
}

// =============================================================================
// Interactive Handlers
// =============================================================================

async function handleSessionAttach(input: z.infer<typeof SessionAttachInput>): Promise<ToolResult> {
  const sessionId = generateSessionId();
  const proc = spawn('lldb', [], { stdio: ['pipe', 'pipe', 'pipe'] });

  const session: LldbSession = {
    id: sessionId, process: proc, deviceId: input.deviceId, binary: input.binary,
    state: 'starting', breakpoints: new Map(), outputBuffer: '', lastActivity: Date.now(), createdAt: Date.now(),
  };
  sessions.set(sessionId, session);

  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    if (input.binary) {
      await sendCommand(session, `file "${input.binary}"`);
      session.state = 'stopped';
    } else if (input.pid) {
      await sendCommand(session, `process attach -p ${input.pid}`);
      session.pid = input.pid;
      session.state = 'stopped';
    } else if (input.bundleId && input.deviceId) {
      if (input.waitForLaunch) {
        await sendCommand(session, `process attach --name "${input.appName || input.bundleId}" --waitfor`);
      } else {
        await sendCommand(session, `process attach --name "${input.appName || input.bundleId}"`);
      }
      session.state = 'stopped';
    } else {
      return { success: false, error: 'Must provide binary, pid, or bundleId+deviceId' };
    }

    return { success: true, data: { sessionId, state: session.state, message: 'Session attached' } };
  } catch (error) {
    destroySession(sessionId);
    return { success: false, error: `Failed to attach: ${error}` };
  }
}

async function handleSessionDetach(input: z.infer<typeof SessionDetachInput>): Promise<ToolResult> {
  const session = getSession(input.sessionId);
  if (!session) return { success: false, error: `Session not found: ${input.sessionId}` };
  try { await sendCommand(session, 'detach', 3000); } catch { /* ignore */ }
  destroySession(input.sessionId);
  return { success: true, data: { message: 'Session detached' } };
}

async function handleSessionStatus(input: z.infer<typeof SessionStatusInput>): Promise<ToolResult> {
  const session = getSession(input.sessionId);
  if (!session) return { success: false, error: `Session not found: ${input.sessionId}` };
  return { success: true, data: { sessionId: session.id, state: session.state, stopReason: session.stopReason, pid: session.pid, binary: session.binary, deviceId: session.deviceId, breakpointCount: session.breakpoints.size, age: Math.round((Date.now() - session.createdAt) / 1000) } };
}

async function handleSessionList(): Promise<ToolResult> {
  const sessionList = Array.from(sessions.values()).map((s) => ({ sessionId: s.id, state: s.state, binary: s.binary, deviceId: s.deviceId, pid: s.pid, age: Math.round((Date.now() - s.createdAt) / 1000) }));
  return { success: true, data: { sessions: sessionList, count: sessionList.length } };
}

async function handleSimulatorLaunch(input: z.infer<typeof SimulatorLaunchInput>): Promise<ToolResult> {
  const sessionId = generateSessionId();
  const proc = spawn('lldb', [], { stdio: ['pipe', 'pipe', 'pipe'] });

  const session: LldbSession = {
    id: sessionId, process: proc, deviceId: input.deviceId, state: 'starting',
    breakpoints: new Map(), outputBuffer: '', lastActivity: Date.now(), createdAt: Date.now(),
  };
  sessions.set(sessionId, session);

  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    const appPath = execSync(`xcrun simctl get_app_container ${input.deviceId} ${input.bundleId}`, { encoding: 'utf-8' }).trim();

    await sendCommand(session, `platform select ios-simulator`);
    await sendCommand(session, `file "${appPath}"`);

    if (input.env) {
      for (const [key, value] of Object.entries(input.env)) {
        await sendCommand(session, `settings set target.env-vars ${key}="${value}"`);
      }
    }

    if (input.args?.length) await sendCommand(session, `settings set target.run-args ${input.args.join(' ')}`);
    if (input.stopOnEntry) await sendCommand(session, `breakpoint set -n main`);

    await sendCommand(session, `process launch`);
    session.state = input.stopOnEntry ? 'stopped' : 'running';

    return { success: true, data: { sessionId, state: session.state, appPath, message: 'App launched under debugger' } };
  } catch (error) {
    destroySession(sessionId);
    return { success: false, error: `Failed to launch: ${error}` };
  }
}

async function handleBreakpointSet(input: z.infer<typeof BreakpointSetInput>): Promise<ToolResult> {
  const session = getSession(input.sessionId);
  if (!session) return { success: false, error: `Session not found: ${input.sessionId}` };

  let cmd = `breakpoint set`;
  if (input.location.includes(':') && !input.location.startsWith('0x')) {
    const [file, line] = input.location.split(':');
    cmd += ` -f "${file}" -l ${line}`;
  } else if (input.location.startsWith('0x')) {
    cmd += ` -a ${input.location}`;
  } else {
    cmd += ` -n "${input.location}"`;
  }

  if (input.condition) cmd += ` -c "${input.condition}"`;
  if (input.ignoreCount) cmd += ` -i ${input.ignoreCount}`;
  if (input.oneShot) cmd += ` -o`;

  const output = await sendCommand(session, cmd);
  const idMatch = output.match(/Breakpoint (\d+):/);
  const breakpointId = idMatch ? parseInt(idMatch[1], 10) : session.breakpoints.size + 1;

  session.breakpoints.set(breakpointId, { id: breakpointId, location: input.location, enabled: true, hitCount: 0 });
  return { success: true, data: { breakpointId, location: input.location, message: 'Breakpoint set' } };
}

async function handleBreakpointList(input: z.infer<typeof BreakpointListInput>): Promise<ToolResult> {
  const session = getSession(input.sessionId);
  if (!session) return { success: false, error: `Session not found: ${input.sessionId}` };
  const output = await sendCommand(session, 'breakpoint list');
  return { success: true, data: { breakpoints: Array.from(session.breakpoints.values()), raw: output } };
}

async function handleBreakpointDelete(input: z.infer<typeof BreakpointDeleteInput>): Promise<ToolResult> {
  const session = getSession(input.sessionId);
  if (!session) return { success: false, error: `Session not found: ${input.sessionId}` };

  if (input.all) {
    await sendCommand(session, 'breakpoint delete -f');
    session.breakpoints.clear();
    return { success: true, data: { message: 'All breakpoints deleted' } };
  } else if (input.breakpointId) {
    await sendCommand(session, `breakpoint delete ${input.breakpointId}`);
    session.breakpoints.delete(input.breakpointId);
    return { success: true, data: { message: `Breakpoint ${input.breakpointId} deleted` } };
  }
  return { success: false, error: 'Must provide breakpointId or all=true' };
}

async function handleContinue(input: z.infer<typeof ContinueInput>): Promise<ToolResult> {
  const session = getSession(input.sessionId);
  if (!session) return { success: false, error: `Session not found: ${input.sessionId}` };

  session.state = 'running';
  const output = await sendCommand(session, 'continue', input.timeout);

  if (output.includes('stop reason')) {
    session.state = 'stopped';
    const stopMatch = output.match(/stop reason = (.+)/);
    session.stopReason = stopMatch?.[1];
  }

  const parsed = parseLldbOutput(output);
  return { success: true, data: { state: session.state, stopReason: session.stopReason, backtrace: parsed.backtrace.slice(0, 5) } };
}

async function handleStep(input: z.infer<typeof StepInput>): Promise<ToolResult> {
  const session = getSession(input.sessionId);
  if (!session) return { success: false, error: `Session not found: ${input.sessionId}` };

  const cmdMap: Record<string, string> = { over: 'next', into: 'step', out: 'finish' };
  const cmd = cmdMap[input.type];

  let output = '';
  for (let i = 0; i < (input.count || 1); i++) { output = await sendCommand(session, cmd); }

  session.state = 'stopped';
  const parsed = parseLldbOutput(output);
  return { success: true, data: { state: session.state, backtrace: parsed.backtrace.slice(0, 3), variables: parsed.variables } };
}

async function handleBacktrace(input: z.infer<typeof BacktraceInput>): Promise<ToolResult> {
  const session = getSession(input.sessionId);
  if (!session) return { success: false, error: `Session not found: ${input.sessionId}` };

  const cmd = input.all ? 'bt all' : `bt ${input.limit || 20}`;
  const output = await sendCommand(session, cmd);
  const parsed = parseLldbOutput(output);
  return { success: true, data: { backtrace: parsed.backtrace, count: parsed.backtrace.length } };
}

async function handleFrameSelect(input: z.infer<typeof FrameSelectInput>): Promise<ToolResult> {
  const session = getSession(input.sessionId);
  if (!session) return { success: false, error: `Session not found: ${input.sessionId}` };

  const output = await sendCommand(session, `frame select ${input.index}`);
  const varsOutput = await sendCommand(session, 'frame variable');
  const parsed = parseLldbOutput(varsOutput);
  return { success: true, data: { frameIndex: input.index, variables: parsed.variables, raw: output } };
}

async function handleInspect(input: z.infer<typeof InspectInput>): Promise<ToolResult> {
  const session = getSession(input.sessionId);
  if (!session) return { success: false, error: `Session not found: ${input.sessionId}` };

  if (input.frame !== undefined) await sendCommand(session, `frame select ${input.frame}`);

  let cmd: string;
  if (input.variable) {
    cmd = `frame variable ${input.variable}`;
  } else if (input.expression) {
    const formatFlag: Record<string, string> = { hex: '-f x', binary: '-f b', decimal: '-f d', char: '-f c', default: '' };
    const fmt = formatFlag[input.format || 'default'];
    cmd = `p ${fmt} ${input.expression}`;
  } else {
    return { success: false, error: 'Must provide variable or expression' };
  }

  const output = await sendCommand(session, cmd);
  return { success: true, data: { query: input.variable || input.expression, result: output.trim() } };
}

async function handleSessionMemoryRead(input: z.infer<typeof SessionMemoryReadInput>): Promise<ToolResult> {
  const session = getSession(input.sessionId);
  if (!session) return { success: false, error: `Session not found: ${input.sessionId}` };

  const formatFlag: Record<string, string> = { hex: '-f x', bytes: '-f Y', words: '-f w', instructions: '-f i' };
  const fmt = formatFlag[input.format || 'hex'];
  const output = await sendCommand(session, `memory read ${fmt} -c ${input.size || 64} ${input.address}`);
  return { success: true, data: { address: input.address, size: input.size || 64, memory: output.trim() } };
}

async function handleRawCommand(input: z.infer<typeof RawCommandInput>): Promise<ToolResult> {
  const session = getSession(input.sessionId);
  if (!session) return { success: false, error: `Session not found: ${input.sessionId}` };

  const output = await sendCommand(session, input.command, input.timeout);
  return { success: true, data: { command: input.command, output: output.trim() } };
}

// =============================================================================
// Tool Export
// =============================================================================

export const nativeTool: Tool = {
  name: 'native',
  description: `Full LLDB integration for native debugging.

**Batch Methods (stateless):**
• **crash_run** - Run binary and capture crash details
• **breakpoint_trace** - Trace breakpoint hits during execution
• **variable_inspect** - Inspect variable at breakpoint
• **memory_read** - Read memory at address
• **expression** - Evaluate LLDB expression

**Interactive Methods (session-based):**
• **session_attach** - Start debugging session (binary, pid, or bundleId)
• **session_detach** - End session
• **session_status** / **session_list** - Session management
• **simulator_launch** - Launch iOS app under debugger
• **breakpoint_set/list/delete** - Manage breakpoints
• **continue** / **step** (over/into/out) - Execution control
• **backtrace** / **frame_select** / **inspect** / **memory** / **raw_command**

Examples:
\`native({ method: "crash_run", binary: "./test_binary" })\`
\`native({ method: "session_attach", binary: "./test" })\`
\`native({ method: "breakpoint_set", sessionId: "...", location: "main" })\``,

  inputSchema: {
    type: 'object',
    properties: {
      method: {
        type: 'string',
        enum: ['crash_run', 'breakpoint_trace', 'variable_inspect', 'memory_read', 'expression',
          'session_attach', 'session_detach', 'session_status', 'session_list', 'simulator_launch',
          'breakpoint_set', 'breakpoint_list', 'breakpoint_delete', 'continue', 'step',
          'backtrace', 'frame_select', 'inspect', 'memory', 'raw_command'],
        description: 'LLDB operation to perform',
      },
      binary: { type: 'string', description: 'Path to binary' },
      sessionId: { type: 'string', description: 'Session ID for interactive methods' },
      breakpoints: { type: 'array', items: { type: 'string' }, description: 'Breakpoint locations' },
      location: { type: 'string', description: 'Breakpoint location' },
      variable: { type: 'string', description: 'Variable name' },
      expression: { type: 'string', description: 'LLDB expression' },
      atFunction: { type: 'string', description: 'Function for breakpoint' },
      address: { type: 'string', description: 'Memory address (hex)' },
      size: { type: 'number', description: 'Bytes to read' },
      format: { type: 'string', description: 'Output format' },
      deviceId: { type: 'string', description: 'Device UDID' },
      bundleId: { type: 'string', description: 'App bundle ID' },
      pid: { type: 'number', description: 'Process ID' },
      type: { type: 'string', enum: ['over', 'into', 'out'], description: 'Step type' },
      count: { type: 'number', description: 'Step count' },
      index: { type: 'number', description: 'Frame index' },
      frame: { type: 'number', description: 'Frame to inspect' },
      command: { type: 'string', description: 'Raw LLDB command' },
      timeout: { type: 'number', description: 'Timeout in seconds/ms' },
      args: { type: 'array', items: { type: 'string' }, description: 'Command arguments' },
      env: { type: 'object', description: 'Environment variables' },
    },
    required: ['method'],
  },

  handler: async (rawInput: unknown, context: ToolContext): Promise<ToolResult> => {
    const parseResult = NativeInput.safeParse(rawInput);
    if (!parseResult.success) {
      return { success: false, error: `Invalid input: ${parseResult.error.message}`, meta: { hint: 'Check method and required parameters' } };
    }

    const input = parseResult.data;

    switch (input.method) {
      case 'crash_run': return handleCrashRun(input, context);
      case 'breakpoint_trace': return handleBreakpointTrace(input, context);
      case 'variable_inspect': return handleVariableInspect(input, context);
      case 'memory_read': return handleMemoryRead(input, context);
      case 'expression': return handleExpression(input, context);
      case 'session_attach': return handleSessionAttach(input);
      case 'session_detach': return handleSessionDetach(input);
      case 'session_status': return handleSessionStatus(input);
      case 'session_list': return handleSessionList();
      case 'simulator_launch': return handleSimulatorLaunch(input);
      case 'breakpoint_set': return handleBreakpointSet(input);
      case 'breakpoint_list': return handleBreakpointList(input);
      case 'breakpoint_delete': return handleBreakpointDelete(input);
      case 'continue': return handleContinue(input);
      case 'step': return handleStep(input);
      case 'backtrace': return handleBacktrace(input);
      case 'frame_select': return handleFrameSelect(input);
      case 'inspect': return handleInspect(input);
      case 'memory': return handleSessionMemoryRead(input);
      case 'raw_command': return handleRawCommand(input);
      default: return { success: false, error: `Unknown method: ${(input as { method: string }).method}` };
    }
  },
};
