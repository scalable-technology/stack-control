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
Direct hardware control — ANE validation.

```javascript
silicon({ method: "ane_validate", dimensions: [1, 32, 32, 64], dtype: "fp16" })
silicon({ method: "ane_status" })                     // ANE compiler state
silicon({ method: "ane_info" })                       // Device capabilities
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
- `react-native-pglite` — PostgreSQL + PostGIS on mobile
- `react-native-ane` — LLM training on Apple Neural Engine
- `maplibre-react-native` — Full map rendering engine
- Any native module with C/C++ dependencies

**People going where Apple doesn't want you to go:**
- Reverse engineering private frameworks
- Using undocumented hardware features
- Pushing beyond documented limits
- Understanding black boxes

**People who need AI assistance at every level:**
- From "why isn't this component rendering?"
- To "why did this tensor shape panic the kernel?"

## Philosophy

### No Black Boxes

If it runs on the device, you can understand it. If you can understand it, you can control it.

### Full Stack Means FULL Stack

"Full stack" isn't React + Node. Full stack is:
- The pixel on screen
- The component that rendered it
- The JS that drove it
- The bridge that crossed it
- The native code that executed it
- The C that powered it
- The hardware that computed it
- The silicon that switched it
- The memory that stored it

### Controlled Failure is Learning

When you probe limits and things crash, you've learned something. Capture it. Document it. Share it.

The 64-byte ANE alignment requirement? Someone crashed to find that. The 119 compile limit? Someone hit it. We turn crashes into knowledge.

### AI at Every Layer

Why should AI assistance stop at JavaScript? When you're debugging a kernel panic caused by tensor misalignment in a reverse-engineered Neural Engine API, you need help there too.

Control gives AI the tools to help at every layer.

## Technical Architecture

Control is built on:

- **MCP (Model Context Protocol)** — Standard protocol for AI tool use
- **LLDB** — Native debugging (batch and interactive)
- **Metro DevTools** — React component inspection via CDP
- **Reverse-engineered APIs** — ANE runtime, private frameworks
- **Direct hardware access** — IOSurface, IOKit, Metal

Control is **stateless by design** — pure inspection tools with no database. Use `everytask` or `scalable` for persistence.

```
┌─────────────────────────────────────────────────────────────────┐
│                         AI Assistant                             │
│                  (Claude, Cursor, VS Code, etc.)                │
├─────────────────────────────────────────────────────────────────┤
│                         Control MCP                              │
│   react | bridge | native | device | silicon | kernel | discover │
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

## Current Status

All layers implemented and working:

| Layer | Methods | Status |
|-------|---------|--------|
| **react** | connect, disconnect, status, tree, find, props, navigation, evaluate | ✅ |
| **bridge** | module_list, module_status, platform_diff, type_mappings | ✅ |
| **native** | crash_run, breakpoint_trace, session_attach, lldb commands | ✅ |
| **device** | list, boot, shutdown, install, launch, logs, screenshot, crash_logs, fingerprint | ✅ |
| **silicon** | ane_validate, ane_status, ane_info | ✅ |
| **kernel** | panic_parse, panic_list, panic_analyze | ✅ |
| **discover** | discoveries, frameworks, symbols | ✅ |

## Getting Started

```bash
# Clone and build
git clone https://github.com/tyrauber/control
cd control
pnpm install
pnpm build

# Add to Claude Code (in your project's .mcp.json)
{
  "mcpServers": {
    "control": {
      "command": "node",
      "args": ["/path/to/control/dist/mcp.js"]
    }
  }
}

# Or add globally (~/.claude/settings.json under mcpServers)
```

Then use the tools via MCP:
```javascript
react({ method: "tree" })
bridge({ method: "module_list" })
native({ method: "crash_run", binary: "./test" })
```

## Origin Story

This started as debugging tools for Expo/React Native apps. Then we built `react-native-pglite` (PostgreSQL on mobile) and needed to debug C code. Then we built `react-native-ane` (LLM training on Apple Neural Engine) and found ourselves causing kernel panics.

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

See [CONTRIBUTING.md](CONTRIBUTING.md).

If you're building something hard — native packages with C dependencies, hardware access, private APIs — we want to hear from you. The goal is to make this kind of work accessible to more people.

---

*Built by humans and AI, working together at every layer of the stack.*
