/**
 * control/react — React Component Layer
 *
 * Tools for inspecting and manipulating the React component tree.
 * Connects to Metro DevTools via CDP (Chrome DevTools Protocol).
 *
 * Commands:
 * - control/react tree       — Get full component tree with props/state
 * - control/react find       — Find components by display name
 * - control/react eval       — Execute JS in app context
 * - control/react nav        — Get React Navigation state
 *
 * Port from: @scalable/mcp/src/tools/metro-devtools.ts
 *            @scalable/mcp/src/tools/devices.ts (devtools_* methods)
 */

export const react = {
  name: 'control/react',
  description: 'React component tree inspection and manipulation',

  // TODO: Port from metro-devtools.ts
  // - MetroDevToolsClient
  // - getComponentTree
  // - findComponents
  // - evaluate
  // - getNavigationState
};
