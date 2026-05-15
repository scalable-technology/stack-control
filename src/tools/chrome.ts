/**
 * control/chrome — Chrome Browser Inspection Layer
 *
 * Connect to Chrome via raw CDP (Chrome DevTools Protocol) over WebSocket.
 * No Puppeteer. No dependencies beyond `ws` (already in package.json).
 *
 * Architecture:
 * 1. GET http://localhost:9222/json/list → list available tabs
 * 2. WebSocket ws://localhost:9222/devtools/page/<id> → CDP connection
 * 3. Enable domains, send commands, receive events
 *
 * Chrome must be launched with: --remote-debugging-port=9222
 * IMPORTANT: On macOS, Chrome must be fully quit (Cmd+Q) before relaunching
 * with this flag. If Chrome is already running, the flag is silently ignored.
 *
 * Methods:
 * - connect        Connect to Chrome (auto-discover or specify port)
 * - disconnect     Close connection
 * - status         List tabs, connection state
 * - select         Select a specific tab by ID
 * - evaluate       Run JS in page context
 * - screenshot     Capture page screenshot (base64 PNG)
 * - navigate       Go to URL
 * - reload         Reload page
 * - dom            Query DOM (document tree or CSS selectors)
 * - network        List captured network requests
 * - console        List captured console messages
 * - accessibility  Get accessibility tree
 */

import { EventEmitter } from 'events';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import WebSocket from 'ws';
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../types.js';

// =============================================================================
// Types
// =============================================================================

interface ChromeTarget {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl: string;
  devtoolsFrontendUrl?: string;
  faviconUrl?: string;
}

interface ChromeVersionInfo {
  Browser: string;
  'Protocol-Version': string;
  'User-Agent': string;
  'V8-Version': string;
  'WebKit-Version': string;
  webSocketDebuggerUrl: string;
}

interface CDPCommand {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface CDPResponse {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface NetworkRequest {
  requestId: string;
  url: string;
  method: string;
  timestamp: number;
  type?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
}

interface ConsoleMessage {
  type: string;
  text: string;
  timestamp: number;
  url?: string;
  line?: number;
  column?: number;
}

// =============================================================================
// Chrome CDP Client
// =============================================================================

/**
 * Interpolate console format strings (%s, %d, %i, %f, %o) with args.
 * Chrome sends console.log("Warning: %s", "value") as separate args.
 */
function interpolateConsoleArgs(
  args: { type: string; value?: unknown; description?: string }[]
): string {
  if (args.length === 0) return '';

  const first = args[0];
  const firstStr = first.value !== undefined ? String(first.value) : first.description || '';

  // If first arg contains format specifiers and there are more args, interpolate
  if (args.length > 1 && typeof first.value === 'string' && /%[sdifoc%]/.test(firstStr)) {
    let argIdx = 1;
    const result = firstStr.replace(/%([sdifoc%])/g, (match, specifier) => {
      if (specifier === '%') return '%';
      if (argIdx >= args.length) return match;
      const arg = args[argIdx++];
      const val = arg.value !== undefined ? arg.value : arg.description || '';
      switch (specifier) {
        case 's': return String(val);
        case 'd':
        case 'i': return String(parseInt(String(val), 10));
        case 'f': return String(parseFloat(String(val)));
        case 'o':
        case 'c': return String(val);
        default: return String(val);
      }
    });
    // Append any remaining args not consumed by format specifiers
    const remaining = args.slice(argIdx)
      .map((a) => (a.value !== undefined ? String(a.value) : a.description || ''))
      .filter(Boolean);
    return remaining.length > 0 ? `${result} ${remaining.join(' ')}` : result;
  }

  // No format string — just join all args
  return args
    .map((a) => (a.value !== undefined ? String(a.value) : a.description || ''))
    .join(' ');
}

let commandId = 0;
const getCommandId = () => ++commandId;

const MAX_COLLECTED_EVENTS = 1000;

class ChromeCDPClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private pendingCommands = new Map<
    number,
    {
      resolve: (response: CDPResponse) => void;
      reject: (error: Error) => void;
    }
  >();
  private port: number;
  private connected = false;
  private currentTarget: ChromeTarget | null = null;

  // Event collection buffers
  private networkRequests: NetworkRequest[] = [];
  private consoleMessages: ConsoleMessage[] = [];

  constructor(port: number = 9222) {
    super();
    this.port = port;
  }

  isConnected(): boolean {
    return this.connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  getPort(): number {
    return this.port;
  }

  getCurrentTarget(): ChromeTarget | null {
    return this.currentTarget;
  }

  async listTargets(): Promise<ChromeTarget[]> {
    const response = await fetch(`http://localhost:${this.port}/json/list`);
    if (!response.ok) {
      throw new Error(
        `Chrome not reachable on port ${this.port}.\n` +
          `1. Quit Chrome completely (Cmd+Q, not just close windows)\n` +
          `2. Relaunch: open -a "Google Chrome" --args --remote-debugging-port=${this.port}\n` +
          `If Chrome was already running, the flag is silently ignored.`
      );
    }
    const targets = (await response.json()) as ChromeTarget[];
    return targets.filter((t) => t.type === 'page');
  }

  async getVersion(): Promise<ChromeVersionInfo> {
    const response = await fetch(`http://localhost:${this.port}/json/version`);
    if (!response.ok) {
      throw new Error(`Chrome not reachable on port ${this.port}`);
    }
    return (await response.json()) as ChromeVersionInfo;
  }

  async connect(targetId?: string): Promise<void> {
    // Get available targets
    let targets: ChromeTarget[];
    try {
      targets = await this.listTargets();
    } catch {
      throw new Error(
        `Chrome not reachable on port ${this.port}.\n` +
          `1. Quit Chrome completely (Cmd+Q, not just close the window)\n` +
          `2. Relaunch with debugging enabled:\n` +
          `   open -a "Google Chrome" --args --remote-debugging-port=${this.port}\n` +
          `The --remote-debugging-port flag only takes effect on a fresh launch.`
      );
    }

    if (targets.length === 0) {
      throw new Error('No Chrome pages found. Open a tab in Chrome.');
    }

    // Find target
    let target: ChromeTarget | undefined;
    if (targetId) {
      target = targets.find((t) => t.id === targetId);
      if (!target) {
        throw new Error(
          `Target ${targetId} not found. Available: ${targets.map((t) => `${t.id} (${t.title})`).join(', ')}`
        );
      }
    } else {
      target = targets[0];
    }

    // Disconnect existing connection if switching tabs
    if (this.ws) {
      this.disconnectWebSocket();
    }

    this.currentTarget = target;
    this.clearEvents();

    const wsUrl = target.webSocketDebuggerUrl;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = async () => {
        try {
          // Enable CDP domains
          await this.sendCommand('Runtime.enable');
          await this.sendCommand('Page.enable');
          await this.sendCommand('DOM.enable');
          await this.sendCommand('Network.enable');
          await this.sendCommand('Console.enable');
          this.connected = true;
          resolve();
        } catch (error) {
          reject(error);
        }
      };

      this.ws.onerror = () => {
        reject(
          new Error(
            `WebSocket error connecting to Chrome tab "${target!.title}". ` +
              `Another DevTools client may be attached to this tab.`
          )
        );
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.emit('close');
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string) as CDPResponse;

          // Command response (has id)
          if (data.id && this.pendingCommands.has(data.id)) {
            const { resolve } = this.pendingCommands.get(data.id)!;
            this.pendingCommands.delete(data.id);
            resolve(data);
          }

          // CDP event (has method, no id)
          if (data.method && !data.id) {
            this.handleCDPEvent(data);
          }
        } catch {
          // Ignore parse errors
        }
      };
    });
  }

  private handleCDPEvent(event: CDPResponse): void {
    const params = event.params || {};

    switch (event.method) {
      case 'Network.requestWillBeSent': {
        const request = params.request as { url: string; method: string } | undefined;
        if (request) {
          this.addNetworkRequest({
            requestId: params.requestId as string,
            url: request.url,
            method: request.method,
            timestamp: (params.timestamp as number) || Date.now() / 1000,
            type: params.type as string,
          });
        }
        break;
      }
      case 'Network.responseReceived': {
        const response = params.response as {
          status: number;
          statusText: string;
          mimeType: string;
        } | undefined;
        if (response) {
          const existing = this.networkRequests.find(
            (r) => r.requestId === (params.requestId as string)
          );
          if (existing) {
            existing.status = response.status;
            existing.statusText = response.statusText;
            existing.mimeType = response.mimeType;
          }
        }
        break;
      }
      case 'Runtime.consoleAPICalled': {
        const args =
          (params.args as { type: string; value?: unknown; description?: string }[]) || [];
        const text = interpolateConsoleArgs(args);
        this.addConsoleMessage({
          type: (params.type as string) || 'log',
          text,
          timestamp: (params.timestamp as number) || Date.now() / 1000,
        });
        break;
      }
      case 'Runtime.exceptionThrown': {
        const details = params.exceptionDetails as {
          text?: string;
          url?: string;
          lineNumber?: number;
          columnNumber?: number;
        } | undefined;
        if (details) {
          this.addConsoleMessage({
            type: 'error',
            text: details.text || 'Unknown exception',
            timestamp: Date.now() / 1000,
            url: details.url,
            line: details.lineNumber,
            column: details.columnNumber,
          });
        }
        break;
      }
    }
  }

  private addNetworkRequest(req: NetworkRequest): void {
    this.networkRequests.push(req);
    if (this.networkRequests.length > MAX_COLLECTED_EVENTS) {
      this.networkRequests.shift();
    }
  }

  private addConsoleMessage(msg: ConsoleMessage): void {
    this.consoleMessages.push(msg);
    if (this.consoleMessages.length > MAX_COLLECTED_EVENTS) {
      this.consoleMessages.shift();
    }
  }

  getNetworkRequests(): NetworkRequest[] {
    return [...this.networkRequests];
  }

  getConsoleMessages(): ConsoleMessage[] {
    return [...this.consoleMessages];
  }

  clearEvents(): void {
    this.networkRequests = [];
    this.consoleMessages = [];
  }

  clearNetworkRequests(): void {
    this.networkRequests = [];
  }

  clearConsoleMessages(): void {
    this.consoleMessages = [];
  }

  async sendCommand(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = 30000
  ): Promise<CDPResponse> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to Chrome');
    }

    const id = getCommandId();
    const command: CDPCommand = { id, method, params };

    return new Promise((resolve, reject) => {
      this.pendingCommands.set(id, { resolve, reject });

      const timeout = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`Command ${method} timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);

      this.ws!.send(JSON.stringify(command));

      const originalResolve = this.pendingCommands.get(id)!.resolve;
      this.pendingCommands.set(id, {
        resolve: (response) => {
          clearTimeout(timeout);
          originalResolve(response);
        },
        reject,
      });
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const response = await this.sendCommand('Runtime.evaluate', {
      expression,
      returnByValue: true,
    });

    if (response.error) {
      throw new Error(`Evaluation failed: ${response.error.message}`);
    }

    const result = response.result as {
      result?: { type: string; value?: unknown; description?: string };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };

    if (result?.exceptionDetails) {
      throw new Error(
        `Exception: ${result.exceptionDetails.text} - ${result.exceptionDetails.exception?.description || ''}`
      );
    }

    return result?.result?.value;
  }

  private disconnectWebSocket(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.pendingCommands.clear();
  }

  disconnect(): void {
    this.disconnectWebSocket();
    this.currentTarget = null;
    this.clearEvents();
  }
}

// =============================================================================
// Singleton client
// =============================================================================

let client: ChromeCDPClient | null = null;

function getClient(port?: number): ChromeCDPClient {
  if (!client || (port && client.getPort() !== port)) {
    if (client) client.disconnect();
    client = new ChromeCDPClient(port);
  }
  return client;
}

// =============================================================================
// Input Schemas
// =============================================================================

const ConnectInput = z.object({
  method: z.literal('connect'),
  port: z.number().optional().default(9222),
  targetId: z.string().optional(),
});

const DisconnectInput = z.object({
  method: z.literal('disconnect'),
});

const StatusInput = z.object({
  method: z.literal('status'),
  port: z.number().optional().default(9222),
});

const SelectInput = z.object({
  method: z.literal('select'),
  targetId: z.string().describe('Target/tab ID from status listing'),
});

const EvaluateInput = z.object({
  method: z.literal('evaluate'),
  expression: z.string(),
});

const ScreenshotInput = z.object({
  method: z.literal('screenshot'),
  format: z.enum(['png', 'jpeg', 'webp']).optional().default('png'),
  quality: z.number().min(0).max(100).optional(),
  fullPage: z.boolean().optional().default(false),
  clip: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional()
    .describe('Capture a specific region of the page'),
});

const NavigateInput = z.object({
  method: z.literal('navigate'),
  url: z.string(),
});

const ReloadInput = z.object({
  method: z.literal('reload'),
  ignoreCache: z.boolean().optional().default(false),
});

const DomInput = z.object({
  method: z.literal('dom'),
  selector: z
    .string()
    .optional()
    .describe('CSS selector to query (omit for full document)'),
  depth: z.number().optional().default(3).describe('Tree depth to return'),
});

const NetworkInput = z.object({
  method: z.literal('network'),
  requestId: z
    .string()
    .optional()
    .describe('Get response body for a specific request ID'),
  clear: z
    .boolean()
    .optional()
    .default(false)
    .describe('Clear collected requests after returning'),
});

const ConsoleInput = z.object({
  method: z.literal('console'),
  clear: z
    .boolean()
    .optional()
    .default(false)
    .describe('Clear collected messages after returning'),
});

const AccessibilityInput = z.object({
  method: z.literal('accessibility'),
});

const ClickInput = z.object({
  method: z.literal('click'),
  selector: z.string().describe('CSS selector of element to click'),
  button: z.enum(['left', 'right', 'middle']).optional().default('left'),
  clickCount: z.number().optional().default(1).describe('1 for click, 2 for double-click'),
});

const TypeInput = z.object({
  method: z.literal('type'),
  text: z.string().describe('Text to type'),
  selector: z.string().optional().describe('CSS selector to focus before typing (optional)'),
  delay: z.number().optional().default(0).describe('Delay between keystrokes in ms'),
});

const PressInput = z.object({
  method: z.literal('press'),
  key: z
    .string()
    .describe(
      'Key to press: Enter, Tab, Escape, Backspace, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, or any single character'
    ),
  modifiers: z
    .array(z.enum(['Alt', 'Control', 'Meta', 'Shift']))
    .optional()
    .default([])
    .describe('Modifier keys to hold'),
});

const WaitInput = z.object({
  method: z.literal('wait'),
  selector: z
    .string()
    .optional()
    .describe('CSS selector to wait for'),
  timeout: z
    .number()
    .optional()
    .default(5000)
    .describe('Max wait time in ms (default: 5000)'),
  networkIdle: z
    .boolean()
    .optional()
    .default(false)
    .describe('Wait for no network activity for 500ms'),
});

const ChromeInput = z.discriminatedUnion('method', [
  ConnectInput,
  DisconnectInput,
  StatusInput,
  SelectInput,
  EvaluateInput,
  ScreenshotInput,
  NavigateInput,
  ReloadInput,
  DomInput,
  NetworkInput,
  ConsoleInput,
  AccessibilityInput,
  ClickInput,
  TypeInput,
  PressInput,
  WaitInput,
]);

// =============================================================================
// Handlers
// =============================================================================

async function handleConnect(input: z.infer<typeof ConnectInput>): Promise<ToolResult> {
  try {
    const c = getClient(input.port);
    await c.connect(input.targetId);
    const target = c.getCurrentTarget();
    return {
      success: true,
      data: {
        connected: true,
        port: input.port,
        target: target
          ? { id: target.id, title: target.title, url: target.url }
          : null,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Connection failed',
    };
  }
}

function handleDisconnect(): ToolResult {
  if (client) {
    client.disconnect();
    client = null;
  }
  return {
    success: true,
    data: { disconnected: true },
  };
}

async function handleStatus(input: z.infer<typeof StatusInput>): Promise<ToolResult> {
  try {
    const tempClient = new ChromeCDPClient(input.port);
    const [targets, version] = await Promise.all([
      tempClient.listTargets(),
      tempClient.getVersion().catch(() => null),
    ]);

    return {
      success: true,
      data: {
        port: input.port,
        browser: version?.Browser || null,
        connected: client?.isConnected() ?? false,
        currentTarget: client?.getCurrentTarget()
          ? {
              id: client.getCurrentTarget()!.id,
              title: client.getCurrentTarget()!.title,
              url: client.getCurrentTarget()!.url,
            }
          : null,
        tabs: targets.map((t) => ({
          id: t.id,
          title: t.title,
          url: t.url,
        })),
      },
    };
  } catch {
    return {
      success: true,
      data: {
        port: input.port,
        connected: false,
        error: `Chrome not reachable on port ${input.port}. Launch with: --remote-debugging-port=${input.port}`,
      },
    };
  }
}

async function handleSelect(input: z.infer<typeof SelectInput>): Promise<ToolResult> {
  if (!client) {
    return {
      success: false,
      error: 'Not connected. Use chrome({ method: "connect" }) first.',
    };
  }

  try {
    await client.connect(input.targetId);
    const target = client.getCurrentTarget();
    return {
      success: true,
      data: {
        selected: true,
        target: target
          ? { id: target.id, title: target.title, url: target.url }
          : null,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Tab selection failed',
    };
  }
}

async function handleEvaluate(input: z.infer<typeof EvaluateInput>): Promise<ToolResult> {
  if (!client?.isConnected()) {
    return {
      success: false,
      error: 'Not connected. Use chrome({ method: "connect" }) first.',
    };
  }

  try {
    const result = await client.evaluate(input.expression);
    return {
      success: true,
      data: { result },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Evaluation failed',
    };
  }
}

async function handleScreenshot(
  input: z.infer<typeof ScreenshotInput>
): Promise<ToolResult> {
  if (!client?.isConnected()) {
    return {
      success: false,
      error: 'Not connected. Use chrome({ method: "connect" }) first.',
    };
  }

  try {
    const params: Record<string, unknown> = { format: input.format };
    if (input.quality !== undefined) {
      params.quality = input.quality;
    }

    if (input.clip) {
      // User-specified region
      params.clip = { ...input.clip, scale: 1 };
    } else if (input.fullPage) {
      // Get full page dimensions
      const metrics = await client.sendCommand('Page.getLayoutMetrics');
      const contentSize = metrics.result as {
        cssContentSize?: { width: number; height: number };
        contentSize?: { width: number; height: number };
      };
      const size = contentSize?.cssContentSize || contentSize?.contentSize;
      if (size) {
        // Cap at Chrome's limit
        const width = Math.min(size.width, 16384);
        const height = Math.min(size.height, 16384);
        params.clip = { x: 0, y: 0, width, height, scale: 1 };
        params.captureBeyondViewport = true;
      }
    }

    // Screenshots can be slow on complex pages — use 60s timeout
    const response = await client.sendCommand('Page.captureScreenshot', params, 60000);
    const data = (response.result as { data?: string })?.data;

    if (!data) {
      return { success: false, error: 'No screenshot data returned' };
    }

    // Write to temp file — base64 screenshots exceed MCP output limits
    const dir = join(tmpdir(), 'control-screenshots');
    mkdirSync(dir, { recursive: true });
    const filename = `chrome-${Date.now()}.${input.format}`;
    const filepath = join(dir, filename);
    writeFileSync(filepath, Buffer.from(data, 'base64'));

    return {
      success: true,
      data: {
        format: input.format,
        path: filepath,
        bytes: Math.round(data.length * 0.75),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Screenshot failed',
    };
  }
}

async function handleNavigate(input: z.infer<typeof NavigateInput>): Promise<ToolResult> {
  if (!client?.isConnected()) {
    return {
      success: false,
      error: 'Not connected. Use chrome({ method: "connect" }) first.',
    };
  }

  try {
    const response = await client.sendCommand('Page.navigate', { url: input.url });
    const result = response.result as {
      frameId?: string;
      errorText?: string;
    };

    if (result?.errorText) {
      return {
        success: false,
        error: `Navigation failed: ${result.errorText}`,
      };
    }

    return {
      success: true,
      data: {
        url: input.url,
        frameId: result?.frameId,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Navigation failed',
    };
  }
}

async function handleReload(input: z.infer<typeof ReloadInput>): Promise<ToolResult> {
  if (!client?.isConnected()) {
    return {
      success: false,
      error: 'Not connected. Use chrome({ method: "connect" }) first.',
    };
  }

  try {
    await client.sendCommand('Page.reload', {
      ignoreCache: input.ignoreCache,
    });
    return {
      success: true,
      data: { reloaded: true, ignoreCache: input.ignoreCache },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Reload failed',
    };
  }
}

async function handleDom(input: z.infer<typeof DomInput>): Promise<ToolResult> {
  if (!client?.isConnected()) {
    return {
      success: false,
      error: 'Not connected. Use chrome({ method: "connect" }) first.',
    };
  }

  try {
    // Get document root
    const docResponse = await client.sendCommand('DOM.getDocument', { depth: 0 });
    const root = (docResponse.result as { root?: { nodeId: number } })?.root;
    if (!root) {
      return { success: false, error: 'Could not get document root' };
    }

    if (input.selector) {
      // Query for specific elements
      const queryResponse = await client.sendCommand('DOM.querySelectorAll', {
        nodeId: root.nodeId,
        selector: input.selector,
      });
      const nodeIds = (queryResponse.result as { nodeIds?: number[] })?.nodeIds || [];

      // Describe each node (cap at 50)
      const nodes = [];
      for (const nodeId of nodeIds.slice(0, 50)) {
        const desc = await client.sendCommand('DOM.describeNode', {
          nodeId,
          depth: input.depth,
        });
        if (desc.result?.node) {
          nodes.push(desc.result.node);
        }
      }

      return {
        success: true,
        data: {
          selector: input.selector,
          count: nodeIds.length,
          returned: nodes.length,
          nodes,
        },
      };
    } else {
      // Full document tree at specified depth
      const fullDoc = await client.sendCommand('DOM.getDocument', {
        depth: input.depth,
      });
      return {
        success: true,
        data: { document: fullDoc.result?.root },
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'DOM query failed',
    };
  }
}

async function handleNetwork(input: z.infer<typeof NetworkInput>): Promise<ToolResult> {
  if (!client?.isConnected()) {
    return {
      success: false,
      error: 'Not connected. Use chrome({ method: "connect" }) first.',
    };
  }

  // If requestId provided, get response body for that specific request
  if (input.requestId) {
    try {
      const response = await client.sendCommand('Network.getResponseBody', {
        requestId: input.requestId,
      });
      const result = response.result as {
        body?: string;
        base64Encoded?: boolean;
      };
      return {
        success: true,
        data: {
          requestId: input.requestId,
          body: result?.body || '',
          base64Encoded: result?.base64Encoded || false,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error
          ? `Failed to get response body: ${error.message}`
          : 'Failed to get response body',
      };
    }
  }

  const requests = client.getNetworkRequests();
  if (input.clear) {
    client.clearNetworkRequests();
  }

  return {
    success: true,
    data: {
      count: requests.length,
      requests,
    },
  };
}

async function handleConsole(input: z.infer<typeof ConsoleInput>): Promise<ToolResult> {
  if (!client?.isConnected()) {
    return {
      success: false,
      error: 'Not connected. Use chrome({ method: "connect" }) first.',
    };
  }

  const messages = client.getConsoleMessages();
  if (input.clear) {
    client.clearConsoleMessages();
  }

  return {
    success: true,
    data: {
      count: messages.length,
      messages,
    },
  };
}

async function handleAccessibility(): Promise<ToolResult> {
  if (!client?.isConnected()) {
    return {
      success: false,
      error: 'Not connected. Use chrome({ method: "connect" }) first.',
    };
  }

  try {
    const response = await client.sendCommand('Accessibility.getFullAXTree');
    const nodes = (response.result as { nodes?: unknown[] })?.nodes || [];

    return {
      success: true,
      data: {
        nodeCount: nodes.length,
        tree: nodes,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Accessibility tree failed',
    };
  }
}

// =============================================================================
// Interaction Handlers
// =============================================================================

/**
 * Resolve a CSS selector to the center coordinates of the element's bounding box.
 * Uses DOM.getDocument → DOM.querySelector → DOM.getBoxModel.
 */
async function resolveElementCenter(
  c: ChromeCDPClient,
  selector: string
): Promise<{ x: number; y: number; nodeId: number }> {
  const docResponse = await c.sendCommand('DOM.getDocument', { depth: 0 });
  const root = (docResponse.result as { root?: { nodeId: number } })?.root;
  if (!root) throw new Error('Could not get document root');

  const queryResponse = await c.sendCommand('DOM.querySelector', {
    nodeId: root.nodeId,
    selector,
  });
  const nodeId = (queryResponse.result as { nodeId?: number })?.nodeId;
  if (!nodeId) throw new Error(`No element found for selector: ${selector}`);

  const boxResponse = await c.sendCommand('DOM.getBoxModel', { nodeId });
  const model = (boxResponse.result as {
    model?: { content: number[] };
  })?.model;
  if (!model?.content) throw new Error(`Could not get box model for: ${selector}`);

  // content is [x1,y1, x2,y2, x3,y3, x4,y4] — four corners
  const quad = model.content;
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;

  return { x, y, nodeId };
}

const KEY_DEFINITIONS: Record<string, { keyCode: number; code: string; key: string }> = {
  Enter: { keyCode: 13, code: 'Enter', key: 'Enter' },
  Tab: { keyCode: 9, code: 'Tab', key: 'Tab' },
  Escape: { keyCode: 27, code: 'Escape', key: 'Escape' },
  Backspace: { keyCode: 8, code: 'Backspace', key: 'Backspace' },
  Delete: { keyCode: 46, code: 'Delete', key: 'Delete' },
  ArrowUp: { keyCode: 38, code: 'ArrowUp', key: 'ArrowUp' },
  ArrowDown: { keyCode: 40, code: 'ArrowDown', key: 'ArrowDown' },
  ArrowLeft: { keyCode: 37, code: 'ArrowLeft', key: 'ArrowLeft' },
  ArrowRight: { keyCode: 39, code: 'ArrowRight', key: 'ArrowRight' },
  Home: { keyCode: 36, code: 'Home', key: 'Home' },
  End: { keyCode: 35, code: 'End', key: 'End' },
  PageUp: { keyCode: 33, code: 'PageUp', key: 'PageUp' },
  PageDown: { keyCode: 34, code: 'PageDown', key: 'PageDown' },
  Space: { keyCode: 32, code: 'Space', key: ' ' },
};

function modifierBitmask(modifiers: string[]): number {
  let mask = 0;
  for (const m of modifiers) {
    if (m === 'Alt') mask |= 1;
    if (m === 'Control') mask |= 2;
    if (m === 'Meta') mask |= 4;
    if (m === 'Shift') mask |= 8;
  }
  return mask;
}

async function handleClick(input: z.infer<typeof ClickInput>): Promise<ToolResult> {
  if (!client?.isConnected()) {
    return {
      success: false,
      error: 'Not connected. Use chrome({ method: "connect" }) first.',
    };
  }

  try {
    const { x, y } = await resolveElementCenter(client, input.selector);

    // Scroll element into view first
    const docResponse = await client.sendCommand('DOM.getDocument', { depth: 0 });
    const root = (docResponse.result as { root?: { nodeId: number } })?.root;
    if (root) {
      const qr = await client.sendCommand('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: input.selector,
      });
      const nid = (qr.result as { nodeId?: number })?.nodeId;
      if (nid) {
        await client.sendCommand('DOM.scrollIntoViewIfNeeded', { nodeId: nid });
        // Re-resolve coordinates after scroll
        const boxResponse = await client.sendCommand('DOM.getBoxModel', { nodeId: nid });
        const model = (boxResponse.result as { model?: { content: number[] } })?.model;
        if (model?.content) {
          const quad = model.content;
          const cx = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
          const cy = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;

          // Dispatch mouse events at corrected coordinates
          for (let i = 0; i < input.clickCount; i++) {
            await client.sendCommand('Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x: cx,
              y: cy,
              button: input.button,
              clickCount: i + 1,
            });
            await client.sendCommand('Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x: cx,
              y: cy,
              button: input.button,
              clickCount: i + 1,
            });
          }

          return {
            success: true,
            data: {
              clicked: input.selector,
              coordinates: { x: cx, y: cy },
              button: input.button,
              clickCount: input.clickCount,
            },
          };
        }
      }
    }

    // Fallback: use original coordinates
    for (let i = 0; i < input.clickCount; i++) {
      await client.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: input.button,
        clickCount: i + 1,
      });
      await client.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: input.button,
        clickCount: i + 1,
      });
    }

    return {
      success: true,
      data: {
        clicked: input.selector,
        coordinates: { x, y },
        button: input.button,
        clickCount: input.clickCount,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Click failed',
    };
  }
}

async function handleType(input: z.infer<typeof TypeInput>): Promise<ToolResult> {
  if (!client?.isConnected()) {
    return {
      success: false,
      error: 'Not connected. Use chrome({ method: "connect" }) first.',
    };
  }

  try {
    // Focus element if selector provided
    if (input.selector) {
      const { x, y } = await resolveElementCenter(client, input.selector);
      await client.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        clickCount: 1,
      });
      await client.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        clickCount: 1,
      });
    }

    // Type each character
    for (const char of input.text) {
      await client.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown',
        text: char,
        key: char,
        unmodifiedText: char,
      });
      await client.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: char,
      });

      if (input.delay > 0) {
        await new Promise((r) => setTimeout(r, input.delay));
      }
    }

    return {
      success: true,
      data: {
        typed: input.text,
        selector: input.selector || '(focused element)',
        characters: input.text.length,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Type failed',
    };
  }
}

async function handlePress(input: z.infer<typeof PressInput>): Promise<ToolResult> {
  if (!client?.isConnected()) {
    return {
      success: false,
      error: 'Not connected. Use chrome({ method: "connect" }) first.',
    };
  }

  try {
    const mask = modifierBitmask(input.modifiers);
    const def = KEY_DEFINITIONS[input.key];

    if (def) {
      // Named key
      await client.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: def.key,
        code: def.code,
        windowsVirtualKeyCode: def.keyCode,
        nativeVirtualKeyCode: def.keyCode,
        modifiers: mask,
      });
      await client.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: def.key,
        code: def.code,
        windowsVirtualKeyCode: def.keyCode,
        nativeVirtualKeyCode: def.keyCode,
        modifiers: mask,
      });
    } else if (input.key.length === 1) {
      // Single character
      const code = input.key.charCodeAt(0);
      await client.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown',
        text: input.key,
        key: input.key,
        unmodifiedText: input.key,
        windowsVirtualKeyCode: code,
        modifiers: mask,
      });
      await client.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: input.key,
        windowsVirtualKeyCode: code,
        modifiers: mask,
      });
    } else {
      return {
        success: false,
        error: `Unknown key: ${input.key}. Use named keys (Enter, Tab, Escape, ArrowUp, etc.) or a single character.`,
      };
    }

    return {
      success: true,
      data: {
        pressed: input.key,
        modifiers: input.modifiers.length > 0 ? input.modifiers : undefined,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Key press failed',
    };
  }
}

async function handleWait(input: z.infer<typeof WaitInput>): Promise<ToolResult> {
  if (!client?.isConnected()) {
    return {
      success: false,
      error: 'Not connected. Use chrome({ method: "connect" }) first.',
    };
  }

  const startTime = Date.now();

  try {
    if (input.selector) {
      // Poll for selector existence
      while (Date.now() - startTime < input.timeout) {
        const docResponse = await client.sendCommand('DOM.getDocument', { depth: 0 });
        const root = (docResponse.result as { root?: { nodeId: number } })?.root;
        if (root) {
          const queryResponse = await client.sendCommand('DOM.querySelector', {
            nodeId: root.nodeId,
            selector: input.selector,
          });
          const nodeId = (queryResponse.result as { nodeId?: number })?.nodeId;
          if (nodeId) {
            return {
              success: true,
              data: {
                found: true,
                selector: input.selector,
                elapsed: Date.now() - startTime,
              },
            };
          }
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      return {
        success: true,
        data: {
          found: false,
          selector: input.selector,
          elapsed: Date.now() - startTime,
          timedOut: true,
        },
      };
    }

    if (input.networkIdle) {
      // Wait for no new network requests for 500ms
      let lastRequestCount = client.getNetworkRequests().length;
      let idleSince = Date.now();

      while (Date.now() - startTime < input.timeout) {
        const currentCount = client.getNetworkRequests().length;
        if (currentCount !== lastRequestCount) {
          lastRequestCount = currentCount;
          idleSince = Date.now();
        }
        if (Date.now() - idleSince >= 500) {
          return {
            success: true,
            data: {
              networkIdle: true,
              elapsed: Date.now() - startTime,
              pendingRequests: 0,
            },
          };
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      return {
        success: true,
        data: {
          networkIdle: false,
          elapsed: Date.now() - startTime,
          timedOut: true,
        },
      };
    }

    // Plain timeout wait
    const waitTime = Math.min(input.timeout, 30000);
    await new Promise((r) => setTimeout(r, waitTime));
    return {
      success: true,
      data: { waited: waitTime },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Wait failed',
    };
  }
}

// =============================================================================
// Tool Export
// =============================================================================

export const chromeTool: Tool = {
  name: 'chrome',
  description: `Chrome browser inspection via CDP (Chrome DevTools Protocol).

**Methods:**

• **connect** - Connect to Chrome debugger
  \`chrome({ method: "connect" })\`
  \`chrome({ method: "connect", port: 9222, targetId: "..." })\`

• **disconnect** - Disconnect from Chrome
  \`chrome({ method: "disconnect" })\`

• **status** - List available tabs and connection state
  \`chrome({ method: "status" })\`

• **select** - Switch to a different tab
  \`chrome({ method: "select", targetId: "ABC123" })\`

• **evaluate** - Run JavaScript in page context
  \`chrome({ method: "evaluate", expression: "document.title" })\`

• **screenshot** - Capture page screenshot
  \`chrome({ method: "screenshot" })\`
  \`chrome({ method: "screenshot", fullPage: true, format: "jpeg", quality: 80 })\`

• **navigate** - Navigate to URL
  \`chrome({ method: "navigate", url: "https://example.com" })\`

• **reload** - Reload current page
  \`chrome({ method: "reload" })\`
  \`chrome({ method: "reload", ignoreCache: true })\`

• **dom** - Query DOM tree or specific elements
  \`chrome({ method: "dom" })\`
  \`chrome({ method: "dom", selector: "h1", depth: 2 })\`

• **network** - List captured network requests
  \`chrome({ method: "network" })\`
  \`chrome({ method: "network", clear: true })\`

• **console** - List captured console messages
  \`chrome({ method: "console" })\`
  \`chrome({ method: "console", clear: true })\`

• **accessibility** - Get full accessibility tree
  \`chrome({ method: "accessibility" })\`

• **click** - Click an element by CSS selector
  \`chrome({ method: "click", selector: "button.submit" })\`
  \`chrome({ method: "click", selector: "a.nav-link", clickCount: 2 })\`

• **type** - Type text (optionally into a specific element)
  \`chrome({ method: "type", text: "hello world", selector: "input.search" })\`
  \`chrome({ method: "type", text: "slow typing", delay: 50 })\`

• **press** - Press a key (Enter, Tab, Escape, arrows, etc.)
  \`chrome({ method: "press", key: "Enter" })\`
  \`chrome({ method: "press", key: "a", modifiers: ["Control"] })\`

• **wait** - Wait for selector, network idle, or timeout
  \`chrome({ method: "wait", selector: ".loaded" })\`
  \`chrome({ method: "wait", networkIdle: true, timeout: 10000 })\`

**Prerequisites:**
Chrome must be launched with remote debugging enabled. On macOS:
1. Fully quit Chrome first (Cmd+Q — closing windows is not enough)
2. Relaunch from terminal: open -a "Google Chrome" --args --remote-debugging-port=9222
If Chrome was already running, the flag is silently ignored. You MUST quit first.

No Puppeteer dependency. Raw CDP over WebSocket.`,

  inputSchema: {
    type: 'object',
    properties: {
      method: {
        type: 'string',
        enum: [
          'connect',
          'disconnect',
          'status',
          'select',
          'evaluate',
          'screenshot',
          'navigate',
          'reload',
          'dom',
          'network',
          'console',
          'accessibility',
          'click',
          'type',
          'press',
          'wait',
        ],
        description: 'Chrome operation to perform',
      },
      port: {
        type: 'number',
        description: 'Chrome debugging port (default: 9222)',
      },
      targetId: {
        type: 'string',
        description: 'Target/tab ID from status listing',
      },
      expression: {
        type: 'string',
        description: 'JavaScript expression to evaluate',
      },
      url: {
        type: 'string',
        description: 'URL to navigate to',
      },
      selector: {
        type: 'string',
        description: 'CSS selector for DOM queries',
      },
      depth: {
        type: 'number',
        description: 'DOM tree depth (default: 3)',
      },
      format: {
        type: 'string',
        enum: ['png', 'jpeg', 'webp'],
        description: 'Screenshot format (default: png)',
      },
      quality: {
        type: 'number',
        description: 'Screenshot quality 0-100 (jpeg/webp only)',
      },
      fullPage: {
        type: 'boolean',
        description: 'Capture full page screenshot',
      },
      clip: {
        type: 'object',
        description: 'Capture specific region: {x, y, width, height}',
      },
      ignoreCache: {
        type: 'boolean',
        description: 'Bypass cache on reload',
      },
      clear: {
        type: 'boolean',
        description: 'Clear collected events after returning',
      },
      requestId: {
        type: 'string',
        description: 'Get response body for a specific network request ID',
      },
      button: {
        type: 'string',
        enum: ['left', 'right', 'middle'],
        description: 'Mouse button for click (default: left)',
      },
      clickCount: {
        type: 'number',
        description: '1 for click, 2 for double-click',
      },
      text: {
        type: 'string',
        description: 'Text to type',
      },
      delay: {
        type: 'number',
        description: 'Delay between keystrokes in ms',
      },
      key: {
        type: 'string',
        description: 'Key to press: Enter, Tab, Escape, ArrowUp, etc.',
      },
      modifiers: {
        type: 'array',
        description: 'Modifier keys: Alt, Control, Meta, Shift',
      },
      timeout: {
        type: 'number',
        description: 'Max wait time in ms (default: 5000)',
      },
      networkIdle: {
        type: 'boolean',
        description: 'Wait for no network activity for 500ms',
      },
    },
    required: ['method'],
  },

  handler: async (rawInput: unknown, _context: ToolContext): Promise<ToolResult> => {
    const parseResult = ChromeInput.safeParse(rawInput);
    if (!parseResult.success) {
      return {
        success: false,
        error: `Invalid input: ${parseResult.error.message}`,
      };
    }

    const input = parseResult.data;

    switch (input.method) {
      case 'connect':
        return handleConnect(input);
      case 'disconnect':
        return handleDisconnect();
      case 'status':
        return handleStatus(input);
      case 'select':
        return handleSelect(input);
      case 'evaluate':
        return handleEvaluate(input);
      case 'screenshot':
        return handleScreenshot(input);
      case 'navigate':
        return handleNavigate(input);
      case 'reload':
        return handleReload(input);
      case 'dom':
        return handleDom(input);
      case 'network':
        return handleNetwork(input);
      case 'console':
        return handleConsole(input);
      case 'accessibility':
        return handleAccessibility();
      case 'click':
        return handleClick(input);
      case 'type':
        return handleType(input);
      case 'press':
        return handlePress(input);
      case 'wait':
        return handleWait(input);
      default:
        return {
          success: false,
          error: `Unknown method: ${(input as { method: string }).method}`,
        };
    }
  },
};
