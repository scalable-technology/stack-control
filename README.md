# Control

**Control the whole stack. From pixel to silicon.**

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                  │
│     You don't debug the stack.                                   │
│     You don't observe the stack.                                 │
│     You don't hope the stack works.                              │
│                                                                  │
│     You CONTROL the stack.                                       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## What is This?

Control is an MCP (Model Context Protocol) server that gives AI assistants complete control over the entire software stack — from React components down to silicon.

Not just JavaScript. Not just native code. **All of it.**

```
React Component
      ↓
JavaScript Runtime
      ↓
TurboModules / JSI
      ↓
Swift / Objective-C / Kotlin
      ↓
C / C++
      ↓
Private APIs (ANE Runtime, Metal, IOKit)
      ↓
Hardware Instructions
      ↓
Silicon (ANE / GPU / CPU)
      ↓
Memory Buffers
```

One toolchain. Every layer. Full control.

## Getting Started

### Install

```bash
npm install -g stack-control
```

Or run directly with `npx` — no install required.

### Configure Your MCP Client

**Claude Code** — add to `.mcp.json` in your project root:
```json
{
  "mcpServers": {
    "control": {
      "command": "npx",
      "args": ["stack-control"]
    }
  }
}
```

**Cursor** — add to `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "control": {
      "command": "npx",
      "args": ["stack-control"]
    }
  }
}
```

**VS Code** — add to `.vscode/mcp.json`:
```json
{
  "servers": {
    "control": {
      "command": "npx",
      "args": ["stack-control"]
    }
  }
}
```

### Prerequisites

- **Node.js 20+**
- **macOS** — silicon, kernel, and ANE tools require macOS with Apple Silicon
- **Xcode** — required for LLDB, simulators, and device tools
- **Chrome** — for chrome tools, launch with `--remote-debugging-port=9222`
- **Metro** — for react tools, your React Native app must be running in dev mode

## The Layers

### `react`
Inspect the React component tree via Metro DevTools.

```javascript
react({ method: "status" })                          // List debuggable apps
react({ method: "connect" })                         // Connect to Metro
react({ method: "tree", maxDepth: 10 })              // Full component tree
react({ method: "find", displayName: "Button" })     // Find components by name
react({ method: "props", componentName: "Header" })  // Get props/state
react({ method: "evaluate", expression: "..." })     // Execute JS in app context
```

### `bridge`
Verify the native-to-JS boundary (TurboModules).

```javascript
bridge({ method: "module_list" })                     // List all TurboModules with health
bridge({ method: "module_list", status: "broken" })   // Filter by status
bridge({ method: "module_status", name: "MyModule" }) // Detailed module status
bridge({ method: "platform_diff", name: "MyModule" }) // Compare iOS vs Android
bridge({ method: "type_mappings" })                   // Show platform type equivalences
```

### `native`
Full LLDB integration for native debugging.

```javascript
// Batch (stateless)
native({ method: "crash_run", binary: "./test" })     // Run and capture crash
native({ method: "memory_read", address: "0x..." })   // Read memory

// Interactive (session-based)
native({ method: "session_attach", binary: "./test" })
native({ method: "breakpoint_set", sessionId: "...", location: "main" })
native({ method: "continue", sessionId: "..." })
native({ method: "backtrace", sessionId: "..." })
```

### `chrome`
Chrome browser inspection via CDP (Chrome DevTools Protocol).

```javascript
chrome({ method: "status" })                            // List tabs, browser version
chrome({ method: "connect" })                           // Connect to first tab
chrome({ method: "connect", targetId: "..." })          // Connect to specific tab
chrome({ method: "evaluate", expression: "document.title" })
chrome({ method: "screenshot" })                        // Viewport screenshot (base64)
chrome({ method: "screenshot", fullPage: true })        // Full page screenshot
chrome({ method: "dom", selector: "h1" })               // Query DOM elements
chrome({ method: "navigate", url: "https://..." })      // Navigate to URL
chrome({ method: "network" })                           // List captured requests
chrome({ method: "console" })                           // List captured messages
chrome({ method: "accessibility" })                     // Full accessibility tree
chrome({ method: "scene" })                             // three.js scene graph dump
chrome({ method: "scene", match: "sail|boat" })         // Grep scene nodes (name/type regex)
chrome({ method: "scene", handle: "window.__APP__.scene" })  // App-convention fallback
```

Chrome must be launched with: `--remote-debugging-port=9222`

**three.js scene inspection.** `scene` serializes the live scene graph — per
node: type, name, visible, pos, scale, verts, material (type, color,
transparent, opacity, **side**), instance count. Scenes are discovered through
the standard `__THREE_DEVTOOLS__` hook, which `connect` installs into the
current and all future documents; if the app loaded before you connected,
reload once. Works on any three.js app with no app-side code. Screenshot is
pixel truth ("something's wrong"); scene is graph truth ("the sail is
`side: FrontSide` viewed from behind — that's why").

`evaluate` awaits Promises, so async expressions return resolved values.
`evaluate`, `screenshot`, and `scene` auto-detect a hidden page (macOS
occlusion throttles rAF, freezing animation-driven apps) and bring the tab to
front, reporting what they did in a `foreground` field.

### `device`
iOS Simulator and Android Emulator management.

```javascript
device({ method: "list" })                            // List simulators/emulators
device({ method: "boot", deviceId: "...", platform: "ios" })
device({ method: "screenshot", deviceId: "..." })
device({ method: "crash_logs", appName: "MyApp" })
device({ method: "fingerprint" })                     // Detect native code changes
```

### `silicon`
Direct hardware control — ANE validation, GPU monitoring.

```javascript
silicon({ method: "ane_validate", dimensions: [1, 32, 32, 64], dtype: "fp16" })
silicon({ method: "ane_status" })                     // ANE compiler state
silicon({ method: "ane_info" })                       // Device capabilities
silicon({ method: "gpu_info" })                       // GPU cores, Metal support
silicon({ method: "gpu_power" })                      // GPU frequency and power state
silicon({ method: "gpu_sample", duration: 5000 })     // GPU power variance analysis
```

### `kernel`
Kernel-level crash analysis.

```javascript
kernel({ method: "panic_list", limit: 5 })            // List recent kernel panics
kernel({ method: "panic_analyze", path: "/path/to/panic.log" })
kernel({ method: "panic_parse", log: "..." })         // Parse panic log content
```

### `discover`
Reverse engineering and exploration tools.

```javascript
discover({ method: "discoveries" })                   // List known discoveries
discover({ method: "discoveries", target: "ane" })    // Filter by target
discover({ method: "frameworks", filter: "ANE" })     // List private frameworks
discover({ method: "symbols", path: "/System/Library/PrivateFrameworks/..." })
```

## Who Is This For?

**People building hard things:**
- Native modules with C/C++ dependencies
- Embedded databases on mobile
- On-device ML/AI pipelines
- Complex rendering engines

**People going where Apple doesn't want you to go:**
- Reverse engineering private frameworks
- Using undocumented hardware features
- Pushing beyond documented limits
- Understanding black boxes

**People who need AI assistance at every level:**
- From "why isn't this component rendering?"
- To "why did this tensor shape panic the kernel?"

## Philosophy

Control applies [Mill's harm principle](PHILOSOPHY.md) to platform restrictions: the same API can be legitimate or illegitimate to restrict depending on context.

**Three cases:**

| API Type | Local Use | Distribution |
|----------|-----------|--------------|
| Can harm hardware (ANE compute) | Your right — self-regarding | Apple's restriction is fair |
| Cannot harm hardware (read-only) | Your right | Restriction is rent-seeking |
| Protects secrets (Secure Enclave) | Off-limits | Off-limits |

We respect locks that protect users. We question locks that protect market position. We accept risk on our own hardware and don't impose it on others.

### Principles

1. **No black boxes** — If it runs on your device, you can understand it
2. **Full stack means full stack** — Pixel to silicon, not just React + Node
3. **Controlled failure is learning** — Crashes teach us limits; we turn them into knowledge
4. **AI at every layer** — Help at the kernel level, not just JavaScript

## Technical Architecture

Control is built on:

- **MCP (Model Context Protocol)** — Standard protocol for AI tool use
- **LLDB** — Native debugging (batch and interactive)
- **Chrome DevTools Protocol** — Browser and React Native inspection via CDP
- **Reverse-engineered APIs** — ANE runtime, private frameworks
- **Direct hardware access** — IOSurface, IOKit, Metal

Control is **stateless by design** — pure inspection tools with no database.

```
┌─────────────────────────────────────────────────────────────────┐
│                         AI Assistant                             │
│                  (Claude, Cursor, VS Code, etc.)                │
├─────────────────────────────────────────────────────────────────┤
│                         Control MCP                              │
│  react | bridge | chrome | native | device | silicon | kernel | discover │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │   Metro     │  │    LLDB     │  │  Hardware   │              │
│  │  DevTools   │  │   Bridge    │  │   Probes    │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
├─────────────────────────────────────────────────────────────────┤
│                         The Device                               │
│              iOS / macOS / Android / Simulator                   │
└─────────────────────────────────────────────────────────────────┘
```

## Origin Story

This started as debugging tools for Expo/React Native apps. Then we embedded a database on mobile and needed to debug C code. Then we ran ML models on the Neural Engine and found ourselves causing kernel panics.

We weren't debugging React components anymore. We were reverse engineering silicon.

The tools grew to match the work:
- From `devtools_find` to `lldb.memory_read`
- From "why won't this render" to "why did the ANE panic at 513 dimensions"
- From JavaScript to assembly

**Control** is what those tools became. Infrastructure for controlling the entire stack.

## The Name

> "Control the whole stack. From pixel to silicon."

Not debug. Not observe. Not hope.

**Control.**

## License

MIT

## Contributing

If you're building something hard — native packages with C dependencies, hardware access, private APIs — we want to hear from you. The goal is to make this kind of work accessible to more people.

---

*Built by humans and AI, working together at every layer of the stack.*
