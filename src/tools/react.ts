/**
 * control/react — React Component Layer
 *
 * Connect directly to Metro's debugger proxy to access React DevTools data.
 * No client SDK required - works with any React Native app in dev mode.
 *
 * Architecture:
 * 1. GET http://localhost:8081/json/list → list debuggable apps
 * 2. WebSocket ws://localhost:8081/inspector/debug?device=<id>&page=1 → CDP connection
 * 3. Runtime.evaluate → execute JS in the running app
 * 4. Access __FUSEBOX_REACT_DEVTOOLS_DISPATCHER__ → React DevTools data
 *
 * Methods:
 * - connect        Connect to Metro debugger
 * - disconnect     Disconnect from Metro
 * - status         Get connection status and list apps
 * - tree           Get React component tree
 * - find           Find components by display name
 * - props          Get component props
 * - navigation     Get navigation state
 * - evaluate       Evaluate JS expression in app context
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../types.js';

// =============================================================================
// Types
// =============================================================================

interface MetroApp {
  id: string;
  title: string;
  appId: string;
  description: string;
  type: 'node';
  devtoolsFrontendUrl: string;
  webSocketDebuggerUrl: string;
  deviceName: string;
  reactNative?: {
    logicalDeviceId: string;
    capabilities: unknown;
  };
}

interface CDPCommand {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface CDPResponse {
  id: number;
  result?: {
    result?: {
      type: string;
      subtype?: string;
      value?: unknown;
      description?: string;
    };
    exceptionDetails?: {
      text: string;
      exception?: {
        description?: string;
        value?: unknown;
      };
    };
  };
  error?: {
    code: number;
    message: string;
  };
}

interface ReactComponentNode {
  id?: number;
  type: string;
  displayName?: string;
  key: string | null;
  props: Record<string, unknown>;
  state: Record<string, unknown> | null;
  children: ReactComponentNode[];
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

// =============================================================================
// Metro DevTools Client
// =============================================================================

let commandId = 0;
const getCommandId = () => ++commandId;

class MetroDevToolsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private pendingCommands = new Map<
    number,
    {
      resolve: (response: CDPResponse) => void;
      reject: (error: Error) => void;
    }
  >();
  private metroUrl: string;
  private connected = false;
  private deviceId: string | null = null;

  constructor(metroUrl: string = 'http://localhost:8081') {
    super();
    this.metroUrl = metroUrl;
  }

  isConnected(): boolean {
    return this.connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  getDeviceId(): string | null {
    return this.deviceId;
  }

  getMetroUrl(): string {
    return this.metroUrl;
  }

  async listApps(): Promise<MetroApp[]> {
    const response = await fetch(`${this.metroUrl}/json/list?user-agent=control-mcp`);
    if (!response.ok) {
      throw new Error(`Failed to list apps: ${response.status}`);
    }
    const apps = (await response.json()) as MetroApp[];
    return apps.reverse(); // Most recent first
  }

  async connect(deviceId?: string, pageId: string = '1'): Promise<void> {
    if (!deviceId) {
      const apps = await this.listApps();
      if (apps.length === 0) {
        throw new Error('No debuggable React Native apps found. Is Metro running?');
      }
      deviceId = apps[0].reactNative?.logicalDeviceId || apps[0].id;
    }

    this.deviceId = deviceId;
    const wsUrl = `${this.metroUrl.replace('http', 'ws')}/inspector/debug?device=${deviceId}&page=${pageId}&user-agent=control-mcp`;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = async () => {
        try {
          await this.waitForFuseboxDispatcher();
          await this.sendCommand('Runtime.evaluate', {
            expression: `__FUSEBOX_REACT_DEVTOOLS_DISPATCHER__.initializeDomain('react-devtools')`,
          });
          await this.sendCommand('Console.enable', {});
          this.connected = true;
          resolve();
        } catch (error) {
          reject(error);
        }
      };

      this.ws.onerror = (event) => {
        reject(new Error(`WebSocket error: ${event}`));
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.emit('close');
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);

          if (data.id && this.pendingCommands.has(data.id)) {
            const { resolve } = this.pendingCommands.get(data.id)!;
            this.pendingCommands.delete(data.id);
            resolve(data);
          }

          if (data.method && !data.id) {
            this.emit('event', data);

            if (data.method === 'Runtime.bindingCalled') {
              try {
                const payload = JSON.parse(data.params.payload);
                if (payload.domain === 'react-devtools') {
                  this.emit('devtools-message', payload.message);
                }
              } catch {
                // Ignore parse errors
              }
            }
          }
        } catch {
          // Ignore parse errors
        }
      };
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.deviceId = null;
    this.pendingCommands.clear();
  }

  async sendCommand(method: string, params: Record<string, unknown> = {}): Promise<CDPResponse> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to Metro debugger');
    }

    const id = getCommandId();
    const command: CDPCommand = { id, method, params };

    return new Promise((resolve, reject) => {
      this.pendingCommands.set(id, { resolve, reject });

      const timeout = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`Command ${method} timed out`));
      }, 30000);

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

  async evaluate(expression: string, returnByValue: boolean = true): Promise<unknown> {
    const response = await this.sendCommand('Runtime.evaluate', {
      expression,
      returnByValue,
    });

    if (response.error) {
      throw new Error(`Evaluation failed: ${response.error.message}`);
    }

    if (response.result?.exceptionDetails) {
      throw new Error(
        `Evaluation exception: ${response.result.exceptionDetails.text} - ${response.result.exceptionDetails.exception?.description || ''}`
      );
    }

    return response.result?.result?.value;
  }

  async getComponentTree(maxDepth: number = 10): Promise<ReactComponentNode | null> {
    const expression = `
      (function() {
        const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        if (!hook) return { error: 'React DevTools hook not found' };

        const renderers = hook.renderers;
        if (!renderers || renderers.size === 0) {
          return { error: 'No React renderers found' };
        }

        const renderer = renderers.values().next().value;
        if (!renderer) return { error: 'Could not get renderer' };

        const roots = hook.getFiberRoots(renderer.rendererID || 1);
        if (!roots || roots.size === 0) {
          return { error: 'No Fiber roots found' };
        }

        const root = roots.values().next().value;
        if (!root || !root.current) {
          return { error: 'Could not get root Fiber' };
        }

        const visited = new WeakSet();

        function traverseFiber(fiber, depth) {
          if (!fiber || depth > ${maxDepth}) return null;
          if (visited.has(fiber)) return null;
          visited.add(fiber);

          let typeName = 'Unknown';
          if (typeof fiber.type === 'string') {
            typeName = fiber.type;
          } else if (fiber.type?.displayName) {
            typeName = fiber.type.displayName;
          } else if (fiber.type?.name) {
            typeName = fiber.type.name;
          } else if (fiber.tag === 5) {
            typeName = 'HostComponent';
          } else if (fiber.tag === 6) {
            typeName = 'HostText';
          }

          const node = {
            type: typeName,
            key: fiber.key,
            props: {},
            state: null,
            children: []
          };

          if (fiber.memoizedProps) {
            for (const [key, value] of Object.entries(fiber.memoizedProps)) {
              try {
                if (typeof value === 'function') {
                  node.props[key] = '[Function]';
                } else if (value === null || value === undefined) {
                  node.props[key] = value;
                } else if (typeof value !== 'object') {
                  node.props[key] = value;
                } else if (key === 'style') {
                  try {
                    node.props.style = JSON.parse(JSON.stringify(value));
                  } catch {
                    node.props.style = '[Complex style]';
                  }
                } else if (key === 'children' && typeof value === 'string') {
                  node.props.children = value;
                } else if (Array.isArray(value)) {
                  node.props[key] = '[Array(' + value.length + ')]';
                } else {
                  node.props[key] = '[Object]';
                }
              } catch {
                // Skip problematic props
              }
            }
          }

          if (fiber.memoizedState && fiber.tag === 1) {
            try {
              const stateStr = JSON.stringify(fiber.memoizedState);
              if (stateStr.length < 1000) {
                node.state = JSON.parse(stateStr);
              } else {
                node.state = '[Large state object]';
              }
            } catch {
              node.state = '[Complex state]';
            }
          }

          let child = fiber.child;
          while (child) {
            const childNode = traverseFiber(child, depth + 1);
            if (childNode) {
              node.children.push(childNode);
            }
            child = child.sibling;
          }

          return node;
        }

        return traverseFiber(root.current, 0);
      })()
    `;

    const result = await this.evaluate(expression);

    if (result && typeof result === 'object' && 'error' in result) {
      throw new Error((result as { error: string }).error);
    }

    return result as ReactComponentNode | null;
  }

  async findComponents(displayName: string): Promise<ReactComponentNode[]> {
    const tree = await this.getComponentTree(20);
    if (!tree) return [];

    const matches: ReactComponentNode[] = [];

    function search(node: ReactComponentNode) {
      if (node.type.toLowerCase().includes(displayName.toLowerCase())) {
        matches.push(node);
      }
      for (const child of node.children) {
        search(child);
      }
    }

    search(tree);
    return matches;
  }

  async getNavigationState(): Promise<unknown> {
    const expression = `
      (function() {
        const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        if (!hook) return null;

        if (window.__REACT_NAVIGATION_DEVTOOLS__) {
          return window.__REACT_NAVIGATION_DEVTOOLS__.getState();
        }

        return null;
      })()
    `;

    return this.evaluate(expression);
  }

  private async waitForFuseboxDispatcher(maxAttempts: number = 20): Promise<void> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const response = await this.sendCommand('Runtime.evaluate', {
        expression: 'globalThis.__FUSEBOX_REACT_DEVTOOLS_DISPATCHER__ != undefined',
        returnByValue: true,
      });

      if (response.result?.result?.value === true) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error('Fusebox dispatcher not initialized after timeout');
  }
}

// =============================================================================
// Singleton client
// =============================================================================

let client: MetroDevToolsClient | null = null;

function getClient(metroUrl?: string): MetroDevToolsClient {
  if (!client || (metroUrl && client.getMetroUrl() !== metroUrl)) {
    if (client) client.disconnect();
    client = new MetroDevToolsClient(metroUrl);
  }
  return client;
}

// =============================================================================
// Input Schemas
// =============================================================================

const ConnectInput = z.object({
  method: z.literal('connect'),
  metroUrl: z.string().optional().default('http://localhost:8081'),
  deviceId: z.string().optional(),
});

const DisconnectInput = z.object({
  method: z.literal('disconnect'),
});

const StatusInput = z.object({
  method: z.literal('status'),
  metroUrl: z.string().optional().default('http://localhost:8081'),
});

const TreeInput = z.object({
  method: z.literal('tree'),
  maxDepth: z.number().optional().default(10),
});

const FindInput = z.object({
  method: z.literal('find'),
  displayName: z.string(),
});

const PropsInput = z.object({
  method: z.literal('props'),
  componentName: z.string(),
});

const NavigationInput = z.object({
  method: z.literal('navigation'),
});

const EvaluateInput = z.object({
  method: z.literal('evaluate'),
  expression: z.string(),
});

const ReactInput = z.discriminatedUnion('method', [
  ConnectInput,
  DisconnectInput,
  StatusInput,
  TreeInput,
  FindInput,
  PropsInput,
  NavigationInput,
  EvaluateInput,
]);

// =============================================================================
// Handlers
// =============================================================================

async function handleConnect(input: z.infer<typeof ConnectInput>): Promise<ToolResult> {
  try {
    const c = getClient(input.metroUrl);
    await c.connect(input.deviceId);
    return {
      success: true,
      data: {
        connected: true,
        metroUrl: input.metroUrl,
        deviceId: c.getDeviceId(),
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
    const tempClient = new MetroDevToolsClient(input.metroUrl);
    const apps = await tempClient.listApps();

    return {
      success: true,
      data: {
        metroUrl: input.metroUrl,
        connected: client?.isConnected() ?? false,
        currentDeviceId: client?.getDeviceId() ?? null,
        availableApps: apps.map((app) => ({
          id: app.id,
          title: app.title,
          appId: app.appId,
          deviceName: app.deviceName,
          logicalDeviceId: app.reactNative?.logicalDeviceId,
        })),
      },
    };
  } catch (error) {
    return {
      success: true,
      data: {
        metroUrl: input.metroUrl,
        connected: false,
        error: 'Metro not reachable. Is it running?',
      },
    };
  }
}

async function handleTree(input: z.infer<typeof TreeInput>): Promise<ToolResult> {
  if (!client?.isConnected()) {
    return {
      success: false,
      error: 'Not connected. Use react({ method: "connect" }) first.',
    };
  }

  try {
    const tree = await client.getComponentTree(input.maxDepth);
    return {
      success: true,
      data: { tree },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get tree',
    };
  }
}

async function handleFind(input: z.infer<typeof FindInput>): Promise<ToolResult> {
  if (!client?.isConnected()) {
    return {
      success: false,
      error: 'Not connected. Use react({ method: "connect" }) first.',
    };
  }

  try {
    const components = await client.findComponents(input.displayName);
    return {
      success: true,
      data: {
        query: input.displayName,
        count: components.length,
        components,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Search failed',
    };
  }
}

async function handleProps(input: z.infer<typeof PropsInput>): Promise<ToolResult> {
  if (!client?.isConnected()) {
    return {
      success: false,
      error: 'Not connected. Use react({ method: "connect" }) first.',
    };
  }

  try {
    const components = await client.findComponents(input.componentName);
    if (components.length === 0) {
      return {
        success: true,
        data: {
          componentName: input.componentName,
          found: false,
          message: 'No components found with that name',
        },
      };
    }

    return {
      success: true,
      data: {
        componentName: input.componentName,
        found: true,
        count: components.length,
        components: components.map((c) => ({
          type: c.type,
          key: c.key,
          props: c.props,
          state: c.state,
        })),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get props',
    };
  }
}

async function handleNavigation(): Promise<ToolResult> {
  if (!client?.isConnected()) {
    return {
      success: false,
      error: 'Not connected. Use react({ method: "connect" }) first.',
    };
  }

  try {
    const state = await client.getNavigationState();
    return {
      success: true,
      data: {
        navigationState: state,
        note: state === null ? 'No React Navigation devtools found' : undefined,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get navigation state',
    };
  }
}

async function handleEvaluate(input: z.infer<typeof EvaluateInput>): Promise<ToolResult> {
  if (!client?.isConnected()) {
    return {
      success: false,
      error: 'Not connected. Use react({ method: "connect" }) first.',
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

// =============================================================================
// Tool Export
// =============================================================================

export const reactTool: Tool = {
  name: 'react',
  description: `React component tree inspection via Metro DevTools.

**Methods:**

• **connect** - Connect to Metro debugger
  \`react({ method: "connect" })\`
  \`react({ method: "connect", metroUrl: "http://localhost:8081", deviceId: "..." })\`

• **disconnect** - Disconnect from Metro
  \`react({ method: "disconnect" })\`

• **status** - Get connection status and list debuggable apps
  \`react({ method: "status" })\`

• **tree** - Get React component tree
  \`react({ method: "tree", maxDepth: 10 })\`

• **find** - Find components by display name
  \`react({ method: "find", displayName: "Button" })\`

• **props** - Get component props and state
  \`react({ method: "props", componentName: "MyComponent" })\`

• **navigation** - Get React Navigation state
  \`react({ method: "navigation" })\`

• **evaluate** - Evaluate JS in app context
  \`react({ method: "evaluate", expression: "window.myVar" })\`

Works with any React Native app in dev mode. No client SDK required.`,

  inputSchema: {
    type: 'object',
    properties: {
      method: {
        type: 'string',
        enum: ['connect', 'disconnect', 'status', 'tree', 'find', 'props', 'navigation', 'evaluate'],
        description: 'React operation to perform',
      },
      metroUrl: {
        type: 'string',
        description: 'Metro URL (default: http://localhost:8081)',
      },
      deviceId: {
        type: 'string',
        description: 'Device ID to connect to (auto-selects first if not provided)',
      },
      maxDepth: {
        type: 'number',
        description: 'Max tree depth (default: 10)',
      },
      displayName: {
        type: 'string',
        description: 'Component display name to search for',
      },
      componentName: {
        type: 'string',
        description: 'Component name to get props for',
      },
      expression: {
        type: 'string',
        description: 'JavaScript expression to evaluate',
      },
    },
    required: ['method'],
  },

  handler: async (rawInput: unknown, _context: ToolContext): Promise<ToolResult> => {
    const parseResult = ReactInput.safeParse(rawInput);
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
      case 'tree':
        return handleTree(input);
      case 'find':
        return handleFind(input);
      case 'props':
        return handleProps(input);
      case 'navigation':
        return handleNavigation();
      case 'evaluate':
        return handleEvaluate(input);
      default:
        return { success: false, error: `Unknown method: ${(input as { method: string }).method}` };
    }
  },
};
