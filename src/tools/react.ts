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

  /**
   * Get all elements by traversing the ACTUAL fiber tree.
   * NOTE: rendererInterface methods return STALE cached data - we must traverse fibers directly.
   */
  async getAllElements(
    options: { filter?: string; limit?: number } = {}
  ): Promise<{ id: number; name: string }[]> {
    const { filter, limit = 500 } = options;
    const filterLower = filter?.toLowerCase();

    const expression = `
      (function() {
        const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        if (!hook) return { error: 'React DevTools hook not found' };

        // Get fiber roots - renderer 2 typically has the main app
        const roots = hook.getFiberRoots(2) || hook.getFiberRoots(1);
        if (!roots || roots.size === 0) {
          return { error: 'No fiber roots found' };
        }

        const root = roots.values().next().value;
        if (!root?.current) return { error: 'No root fiber' };

        const elements = [];
        const limit = ${limit};
        const filter = ${filterLower ? `"${filterLower}"` : 'null'};
        let idCounter = 0;

        function walk(fiber, depth) {
          if (!fiber || depth > 200 || elements.length >= limit) return;

          const name = fiber.type?.displayName || fiber.type?.name || '';

          if (name) {
            if (!filter || name.toLowerCase().includes(filter)) {
              elements.push({ id: ++idCounter, name, depth });
            }
          }

          walk(fiber.child, depth + 1);
          walk(fiber.sibling, depth);
        }

        walk(root.current, 0);

        return { elements, count: elements.length };
      })()
    `;

    const result = (await this.evaluate(expression)) as
      | { error: string }
      | { elements: { id: number; name: string }[]; count: number };

    if (result && typeof result === 'object' && 'error' in result) {
      throw new Error(result.error);
    }

    return (result as { elements: { id: number; name: string }[] }).elements;
  }

  /**
   * Inspect a specific element by ID using React DevTools API.
   * Returns full props, hooks, state, and owner chain.
   */
  async inspectElement(elementId: number): Promise<unknown> {
    const expression = `
      (function() {
        const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        if (!hook) return { error: 'React DevTools hook not found' };

        const ri = hook.rendererInterfaces;
        if (!ri || ri.size === 0) {
          return { error: 'No renderer interfaces found' };
        }

        const renderer = ri.values().next().value;
        if (!renderer) return { error: 'Could not get renderer interface' };

        if (!renderer.hasElementWithId(${elementId})) {
          return { error: 'Element not found: ${elementId}' };
        }

        try {
          const inspection = renderer.inspectElement(1, ${elementId}, [], false);
          return inspection;
        } catch (e) {
          return { error: e.message };
        }
      })()
    `;

    return this.evaluate(expression);
  }

  /**
   * Get component tree using React DevTools API.
   * Falls back to fiber traversal if devtools API unavailable.
   */
  async getComponentTree(maxDepth: number = 10): Promise<ReactComponentNode | null> {
    // First try to get elements via the proper DevTools API
    const expression = `
      (function() {
        const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        if (!hook) return { error: 'React DevTools hook not found', fallback: true };

        const ri = hook.rendererInterfaces;
        if (!ri || ri.size === 0) {
          return { error: 'No renderer interfaces found', fallback: true };
        }

        const renderer = ri.values().next().value;
        if (!renderer) return { error: 'Could not get renderer interface', fallback: true };

        // Collect all elements with their names
        const elements = new Map();
        const maxId = 3000;

        for (let id = 1; id <= maxId; id++) {
          try {
            if (renderer.hasElementWithId(id)) {
              const name = renderer.getDisplayNameForElementID(id);
              elements.set(id, { id, name: name || 'Unknown' });
            }
          } catch (e) {}
        }

        if (elements.size === 0) {
          return { error: 'No elements found', fallback: true };
        }

        // Build tree by inspecting root element and following owners
        // Element 1 is typically the root
        const rootId = 1;
        const maxDepth = ${maxDepth};

        function buildNode(id, depth) {
          if (depth > maxDepth) return null;
          const elem = elements.get(id);
          if (!elem) return null;

          const node = {
            id: id,
            type: elem.name,
            key: null,
            props: {},
            state: null,
            children: []
          };

          // Find children (elements whose owner chain includes this element)
          // This is expensive, so we limit depth
          if (depth < 3) {
            try {
              const inspection = renderer.inspectElement(1, id, [], false);
              if (inspection && inspection.value) {
                node.key = inspection.value.key;
                // Get basic props preview
                if (inspection.value.props && inspection.value.props.data) {
                  const propsData = inspection.value.props.data;
                  for (const [key, val] of Object.entries(propsData)) {
                    if (typeof val === 'object' && val !== null && 'preview_short' in val) {
                      node.props[key] = val.preview_short;
                    } else if (typeof val !== 'function') {
                      node.props[key] = val;
                    }
                  }
                }
              }
            } catch (e) {}
          }

          return node;
        }

        // Get summary of interesting components (skip Context.Provider, View, etc.)
        const interestingElements = [];
        const skipPatterns = ['Context.Provider', 'Context.Consumer', 'View', 'RCTView', 'Anonymous'];

        for (const [id, elem] of elements) {
          const isSkippable = skipPatterns.some(p => elem.name === p || elem.name.startsWith('Context'));
          if (!isSkippable) {
            interestingElements.push(elem);
          }
        }

        return {
          total: elements.size,
          interesting: interestingElements.length,
          elements: interestingElements.slice(0, 100), // Return first 100 interesting elements
          root: buildNode(rootId, 0)
        };
      })()
    `;

    const result = await this.evaluate(expression);

    if (result && typeof result === 'object' && 'error' in result && (result as { fallback?: boolean }).fallback) {
      // Fall back to legacy fiber traversal
      return this.getComponentTreeLegacy(maxDepth);
    }

    if (result && typeof result === 'object' && 'error' in result) {
      throw new Error((result as { error: string }).error);
    }

    // Return the result in a format compatible with ReactComponentNode
    const data = result as {
      total: number;
      interesting: number;
      elements: { id: number; name: string }[];
      root: ReactComponentNode | null;
    };

    // Build a simple tree structure from the elements
    const rootNode: ReactComponentNode = {
      id: 0,
      type: 'Root',
      key: null,
      props: {
        _totalElements: data.total,
        _interestingElements: data.interesting,
      },
      state: null,
      children: data.elements.map((e) => ({
        id: e.id,
        type: e.name,
        key: null,
        props: {},
        state: null,
        children: [],
      })),
    };

    return rootNode;
  }

  /**
   * Legacy fiber traversal - used as fallback when DevTools API unavailable
   */
  private async getComponentTreeLegacy(maxDepth: number): Promise<ReactComponentNode | null> {
    const expression = `
      (function() {
        const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        if (!hook) return { error: 'React DevTools hook not found' };

        const renderers = hook.renderers;
        if (!renderers || renderers.size === 0) {
          return { error: 'No React renderers found' };
        }

        let roots = null;
        for (const [id, renderer] of renderers) {
          const r = hook.getFiberRoots(id);
          if (r && r.size > 0) {
            roots = r;
            break;
          }
        }

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
          }

          const node = {
            type: typeName,
            key: fiber.key,
            props: {},
            state: null,
            children: []
          };

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

  /**
   * Find components by display name using React DevTools API.
   */
  async findComponents(displayName: string): Promise<ReactComponentNode[]> {
    // Use the DevTools API to find components by name
    const elements = await this.getAllElements({ filter: displayName });

    return elements.map((e) => ({
      id: e.id,
      type: e.name,
      key: null,
      props: {},
      state: null,
      children: [],
    }));
  }

  async getNavigationState(): Promise<unknown> {
    // Traverse ACTUAL fiber tree to find focused screen
    // NOTE: rendererInterface methods return STALE data - we must traverse fibers directly
    const expression = `
      (function() {
        const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        if (!hook) return { error: 'React DevTools hook not found' };

        // Get fiber roots - renderer 2 typically has the main app
        const roots = hook.getFiberRoots(2) || hook.getFiberRoots(1);
        if (!roots || roots.size === 0) {
          return { error: 'No fiber roots found' };
        }

        const root = roots.values().next().value;
        if (!root?.current) return { error: 'No root fiber' };

        // Find the FOCUSED SceneView - this is the current screen
        let focusedScene = null;
        const allScenes = [];

        function findScenes(fiber, depth) {
          if (!fiber || depth > 400) return;
          const name = fiber.type?.displayName || fiber.type?.name || '';

          if (name === 'SceneView') {
            const props = fiber.memoizedProps || {};
            // Route can be in props.route OR props.descriptor.route
            const route = props.route || props.descriptor?.route;
            const sceneInfo = {
              depth,
              focused: props.focused,
              route
            };
            allScenes.push(sceneInfo);
            if (props.focused === true) {
              focusedScene = sceneInfo;
            }
          }

          findScenes(fiber.child, depth + 1);
          findScenes(fiber.sibling, depth);
        }

        findScenes(root.current, 0);

        if (!focusedScene && allScenes.length > 0) {
          // If no explicitly focused scene, use the deepest one
          focusedScene = allScenes.reduce((a, b) => a.depth > b.depth ? a : b);
        }

        if (!focusedScene) {
          return { error: 'No SceneView found in fiber tree' };
        }

        // Find the screen component file path by looking for components with .tsx in name
        // Start from the focused scene and look for the deepest component with a file path
        let screenFile = null;
        let screenComponent = null;

        function findScreenFile(fiber, depth) {
          if (!fiber || depth > 100) return;
          const name = fiber.type?.displayName || fiber.type?.name || '';

          if (name && (name.includes('.tsx)') || name.includes('.ts)'))) {
            // Extract file path from name like "ContentDetails(./[content_type]/[slug]/index.tsx)"
            const match = name.match(/\\((\\.\\/.+\\.tsx?)\\)/);
            if (match) {
              screenFile = match[1];
              screenComponent = name.split('(')[0];
            }
          }

          findScreenFile(fiber.child, depth + 1);
          findScreenFile(fiber.sibling, depth);
        }

        // Walk from the root to find screen files in the focused branch
        function walkToFocused(fiber, depth, targetDepth) {
          if (!fiber || depth > targetDepth + 50) return;
          const name = fiber.type?.displayName || fiber.type?.name || '';

          if (name && (name.includes('.tsx)') || name.includes('.ts)'))) {
            const match = name.match(/\\((\\.\\/.+\\.tsx?)\\)/);
            if (match) {
              screenFile = match[1];
              screenComponent = name.split('(')[0];
            }
          }

          walkToFocused(fiber.child, depth + 1, targetDepth);
          walkToFocused(fiber.sibling, depth, targetDepth);
        }

        walkToFocused(root.current, 0, focusedScene.depth);

        // Build the result
        const route = focusedScene.route || {};
        return {
          source: 'fiber-tree',
          screen: route.name || 'unknown',
          component: screenComponent,
          file: screenFile,
          params: route.params || {},
          key: route.key,
          focused: focusedScene.focused
        };
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

  /**
   * Get a complete snapshot of the current screen for debugging.
   * Returns: screen, file, params, component hierarchy, and key props.
   * ONE call = everything you need to start debugging.
   */
  async getScreenSnapshot(): Promise<unknown> {
    const expression = `
      (function() {
        const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        if (!hook) return { error: 'React DevTools hook not found' };

        const roots = hook.getFiberRoots(2) || hook.getFiberRoots(1);
        if (!roots || roots.size === 0) return { error: 'No fiber roots found' };

        const root = roots.values().next().value;
        if (!root?.current) return { error: 'No root fiber' };

        // Find focused SceneView and collect screen info
        let focusedSceneFiber = null;
        let focusedRoute = null;
        let screenFile = null;
        let screenComponent = null;
        const fileStack = [];

        function findFocused(fiber, depth) {
          if (!fiber || depth > 400) return;
          const name = fiber.type?.displayName || fiber.type?.name || '';

          // Track file paths
          if (name && (name.includes('.tsx)') || name.includes('.ts)'))) {
            const match = name.match(/\\((\\.\\/.+\\.tsx?)\\)/);
            if (match) {
              fileStack.push({ component: name.split('(')[0], file: match[1], depth });
            }
          }

          // Find focused scene
          if (name === 'SceneView') {
            const props = fiber.memoizedProps || {};
            if (props.focused === true) {
              focusedSceneFiber = fiber;
              focusedRoute = props.route || props.descriptor?.route;
            }
          }

          findFocused(fiber.child, depth + 1);
          findFocused(fiber.sibling, depth);
        }

        findFocused(root.current, 0);

        if (!focusedSceneFiber) {
          return { error: 'No focused screen found' };
        }

        // Get the deepest file (the actual screen file)
        if (fileStack.length > 0) {
          const deepest = fileStack.reduce((a, b) => a.depth > b.depth ? a : b);
          screenFile = deepest.file;
          screenComponent = deepest.component;
        }

        // Get component hierarchy under the focused screen
        const components = [];
        const seen = new Set();

        function getComponents(fiber, depth) {
          if (!fiber || depth > 60 || components.length > 50) return;
          const name = fiber.type?.displayName || fiber.type?.name || '';

          if (name &&
              !seen.has(name) &&
              !name.includes('Context') &&
              !name.includes('Provider') &&
              !name.includes('ForwardRef') &&
              !name.includes('Anonymous') &&
              name !== 'View' &&
              name !== 'RCTView' &&
              name !== 'Text' &&
              name !== 'Suspense' &&
              name !== 'Memo') {
            seen.add(name);

            // Get key props for this component
            const props = fiber.memoizedProps || {};
            const keyProps = {};
            for (const [k, v] of Object.entries(props)) {
              if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                keyProps[k] = v;
              } else if (Array.isArray(v)) {
                keyProps[k] = '[Array(' + v.length + ')]';
              } else if (v && typeof v === 'object') {
                keyProps[k] = '{...}';
              }
            }

            components.push({
              name,
              depth,
              props: Object.keys(keyProps).length > 0 ? keyProps : undefined
            });
          }

          getComponents(fiber.child, depth + 1);
          getComponents(fiber.sibling, depth);
        }

        getComponents(focusedSceneFiber, 0);

        return {
          screen: focusedRoute?.name || 'unknown',
          component: screenComponent,
          file: screenFile,
          params: focusedRoute?.params || {},
          components: components.slice(0, 40),
          fileStack: fileStack.map(f => f.file)
        };
      })()
    `;

    return this.evaluate(expression);
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

const ScreenInput = z.object({
  method: z.literal('screen'),
});

const EvaluateInput = z.object({
  method: z.literal('evaluate'),
  expression: z.string(),
});

const ElementsInput = z.object({
  method: z.literal('elements'),
  filter: z.string().optional().describe('Filter elements by name (case-insensitive)'),
  limit: z.number().optional().default(100).describe('Max elements to return'),
});

const InspectInput = z.object({
  method: z.literal('inspect'),
  elementId: z.number().describe('Element ID to inspect (get ID from elements method)'),
});

const ReactInput = z.discriminatedUnion('method', [
  ConnectInput,
  DisconnectInput,
  StatusInput,
  TreeInput,
  FindInput,
  PropsInput,
  NavigationInput,
  ScreenInput,
  EvaluateInput,
  ElementsInput,
  InspectInput,
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
    const state = (await client.getNavigationState()) as {
      source?: string;
      error?: string;
      screen?: string;
      component?: string;
      file?: string;
      params?: Record<string, unknown>;
      key?: string;
      focused?: boolean;
    };

    // Handle error response
    if (state && state.error) {
      return {
        success: false,
        error: state.error,
      };
    }

    // Return the current screen info
    return {
      success: true,
      data: {
        screen: state?.screen || 'unknown',
        component: state?.component,
        file: state?.file,
        params: state?.params || {},
        key: state?.key,
        focused: state?.focused,
        source: state?.source || 'unknown',
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get navigation state',
    };
  }
}

async function handleScreen(): Promise<ToolResult> {
  if (!client?.isConnected()) {
    return {
      success: false,
      error: 'Not connected. Use react({ method: "connect" }) first.',
    };
  }

  try {
    const snapshot = (await client.getScreenSnapshot()) as {
      error?: string;
      screen?: string;
      component?: string;
      file?: string;
      params?: Record<string, unknown>;
      components?: { name: string; depth: number; props?: Record<string, unknown> }[];
      fileStack?: string[];
    };

    if (snapshot && snapshot.error) {
      return {
        success: false,
        error: snapshot.error,
      };
    }

    return {
      success: true,
      data: {
        screen: snapshot?.screen || 'unknown',
        component: snapshot?.component,
        file: snapshot?.file,
        params: snapshot?.params || {},
        components: snapshot?.components || [],
        files: snapshot?.fileStack || [],
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get screen snapshot',
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

async function handleElements(input: z.infer<typeof ElementsInput>): Promise<ToolResult> {
  if (!client?.isConnected()) {
    return {
      success: false,
      error: 'Not connected. Use react({ method: "connect" }) first.',
    };
  }

  try {
    const elements = await client.getAllElements({
      filter: input.filter,
      limit: input.limit,
    });
    return {
      success: true,
      data: {
        count: elements.length,
        filter: input.filter || null,
        elements,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get elements',
    };
  }
}

async function handleInspect(input: z.infer<typeof InspectInput>): Promise<ToolResult> {
  if (!client?.isConnected()) {
    return {
      success: false,
      error: 'Not connected. Use react({ method: "connect" }) first.',
    };
  }

  try {
    const inspection = await client.inspectElement(input.elementId);

    if (inspection && typeof inspection === 'object' && 'error' in inspection) {
      return {
        success: false,
        error: (inspection as { error: string }).error,
      };
    }

    // Extract useful data from the inspection
    // Structure: inspection.value.data contains the actual element data
    const wrapper = inspection as {
      id: number;
      type: string;
      value?: {
        data?: {
          id: number;
          key: string | null;
          props?: { data: Record<string, unknown> };
          hooks?: { data: unknown[] };
          owners?: { id: number; displayName: string }[];
          source?: { sourceURL: string; line: number; column: number };
        };
      };
    };

    const elementData = wrapper.value?.data;

    const result: Record<string, unknown> = {
      id: input.elementId,
    };

    if (elementData) {
      result.key = elementData.key;

      // Extract props (handling dehydrated format)
      // Props can be at elementData.props (object with keys) or elementData.props.data
      const propsSource = elementData.props?.data || elementData.props;
      if (propsSource && typeof propsSource === 'object') {
        const props: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(propsSource)) {
          if (typeof val === 'object' && val !== null) {
            const v = val as { preview_short?: string; preview_long?: string; type?: string };
            if (v.preview_short) {
              props[key] = v.preview_short;
            } else if (v.preview_long) {
              props[key] = v.preview_long;
            } else if (v.type && v.type !== 'function') {
              props[key] = val;
            }
          } else {
            props[key] = val;
          }
        }
        result.props = props;
      }

      // Extract hooks with state values
      // Hooks can be at elementData.hooks (array) or elementData.hooks.data
      const hooksSource = Array.isArray(elementData.hooks)
        ? elementData.hooks
        : elementData.hooks?.data;
      if (hooksSource && Array.isArray(hooksSource)) {
        const hooks: { name: string; value: unknown }[] = [];

        // Parse hook info from dehydrated preview_long strings
        for (const hook of hooksSource) {
          const h = hook as {
            name?: string;
            value?: unknown;
            preview_long?: string;
            subHooks?: unknown[];
          };

          // Try to extract from preview_long: "{name: \"BoundStore\", value: {...}, ...}"
          if (h.preview_long) {
            const nameMatch = h.preview_long.match(/name:\s*"([^"]+)"/);
            // Look for actual values in preview
            const valueMatch = h.preview_long.match(/userId:\s*(\d+)/);
            if (nameMatch) {
              const hookInfo: { name: string; value: unknown } = { name: nameMatch[1], value: null };
              if (valueMatch) {
                hookInfo.value = { userId: parseInt(valueMatch[1], 10) };
              }
              hooks.push(hookInfo);
            }
          } else if (h.name && h.value !== undefined) {
            // Direct access (non-dehydrated)
            let hookValue: unknown = h.value;
            if (typeof hookValue === 'object' && hookValue !== null && 'value' in hookValue) {
              hookValue = (hookValue as { value: unknown }).value;
            }
            if (hookValue !== undefined && (hookValue as { type?: string }).type !== 'undefined') {
              hooks.push({ name: h.name, value: hookValue });
            }
          }
        }
        if (hooks.length > 0) {
          result.hooks = hooks;
        }
      }

      // Extract owner chain (component hierarchy)
      // Owners come as dehydrated objects with preview_long containing the data
      if (elementData.owners && Array.isArray(elementData.owners)) {
        result.owners = elementData.owners
          .map((o: unknown) => {
            const owner = o as { displayName?: string; id?: number; preview_long?: string };
            // Direct access
            if (owner.displayName) {
              return { id: owner.id, name: owner.displayName };
            }
            // Parse from preview_long: "{displayName: \"Drawer\", id: 999, ...}"
            if (owner.preview_long) {
              const nameMatch = owner.preview_long.match(/displayName:\s*"([^"]+)"/);
              const idMatch = owner.preview_long.match(/id:\s*(\d+)/);
              if (nameMatch) {
                return {
                  id: idMatch ? parseInt(idMatch[1], 10) : undefined,
                  name: nameMatch[1],
                };
              }
            }
            return null;
          })
          .filter((o): o is { id: number | undefined; name: string } => o !== null);
      }

      // Source location
      if (elementData.source) {
        result.source = {
          line: elementData.source.line,
          column: elementData.source.column,
        };
      }
    }

    return {
      success: true,
      data: result,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Inspection failed',
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

• **elements** - List all React elements with proper component names
  \`react({ method: "elements" })\`
  \`react({ method: "elements", filter: "Button", limit: 50 })\`

• **inspect** - Inspect element by ID (props, hooks, state, owners)
  \`react({ method: "inspect", elementId: 123 })\`

• **tree** - Get React component tree
  \`react({ method: "tree", maxDepth: 10 })\`

• **find** - Find components by display name
  \`react({ method: "find", displayName: "Button" })\`

• **props** - Get component props and state
  \`react({ method: "props", componentName: "MyComponent" })\`

• **navigation** - Get React Navigation state
  \`react({ method: "navigation" })\`

• **screen** - Get complete screen snapshot (route, file, components, props) - ONE call for debugging
  \`react({ method: "screen" })\`

• **evaluate** - Evaluate JS in app context
  \`react({ method: "evaluate", expression: "window.myVar" })\`

Works with any React Native app in dev mode. No client SDK required.`,

  inputSchema: {
    type: 'object',
    properties: {
      method: {
        type: 'string',
        enum: [
          'connect',
          'disconnect',
          'status',
          'elements',
          'inspect',
          'tree',
          'find',
          'props',
          'navigation',
          'screen',
          'evaluate',
        ],
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
      filter: {
        type: 'string',
        description: 'Filter elements by name (case-insensitive)',
      },
      limit: {
        type: 'number',
        description: 'Max elements to return (default: 100)',
      },
      elementId: {
        type: 'number',
        description: 'Element ID to inspect (get ID from elements method)',
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
      case 'elements':
        return handleElements(input);
      case 'inspect':
        return handleInspect(input);
      case 'tree':
        return handleTree(input);
      case 'find':
        return handleFind(input);
      case 'props':
        return handleProps(input);
      case 'navigation':
        return handleNavigation();
      case 'screen':
        return handleScreen();
      case 'evaluate':
        return handleEvaluate(input);
      default:
        return { success: false, error: `Unknown method: ${(input as { method: string }).method}` };
    }
  },
};
