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

### `control/react`
Inspect and manipulate the React component tree.

```bash
control/react tree                    # Full component tree with props/state
control/react find Marker             # Find components by name
control/react eval "myRef.current"    # Execute JS in app context
```

### `control/bridge`
Understand and verify the native-to-JS boundary.

```bash
control/bridge status                 # List all TurboModules with health
control/bridge status NativeANEModule # Detailed module status
control/bridge diff NativeANEModule   # Compare iOS vs Android implementations
control/bridge codegen                # Trace spec → codegen → native impl
```

### `control/native`
Debug native code (Swift, Objective-C, Kotlin, Java).

```bash
control/native crash                  # Full crash context in one call
control/native build ios              # Analyze Xcode build logs
control/native lldb attach            # Start LLDB session
control/native lldb break main        # Set breakpoint
control/native lldb bt                # Backtrace
```

### `control/metal`
Access hardware APIs and private frameworks.

```bash
control/metal frameworks              # List private frameworks
control/metal symbols ANECompiler     # Dump symbols from framework
control/metal trace ./train           # Trace IOKit/syscalls
control/metal iokit services          # List IOKit services in use
```

### `control/silicon`
Direct hardware control — ANE, GPU, memory buffers.

```bash
control/silicon ane status            # ANE compiler state, compile count
control/silicon ane validate [1,32,1,513]  # Validate shape before kernel panic
control/silicon ane profile ./train   # Profile ANE utilization
control/silicon read 0x1F8A00000      # Read IOSurface memory
control/silicon gpu utilization       # GPU stats
```

### `control/discover`
Reverse engineering and exploration tools.

```bash
control/discover probe ane.shape --fuzz 500-520  # Find limits through controlled failure
control/discover map ANECompilerService          # Memory map a process
control/discover diff state1 state2              # What changed?
control/discover limits ane                      # Document discovered limits
```

### `control/kernel`
When you need to go all the way down.

```bash
control/kernel trace ./train          # Kernel-level tracing
control/kernel crash                  # Parse macOS kernel panic
control/kernel checkpoint             # Save state before risky operation
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
- **PostgreSQL** — Indexes code, logs, symbols, crash reports
- **LLDB** — Native debugging (batch and interactive)
- **Reverse-engineered APIs** — ANE runtime, private frameworks
- **Direct hardware access** — IOSurface, IOKit, Metal

```
┌─────────────────────────────────────────────────────────────────┐
│                         AI Assistant                             │
│                  (Claude, Cursor, VS Code, etc.)                │
├─────────────────────────────────────────────────────────────────┤
│                         Control MCP                              │
│        control/react | control/bridge | control/native          │
│        control/metal | control/silicon | control/discover        │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │   Metro     │  │    LLDB     │  │  Hardware   │              │
│  │  DevTools   │  │   Bridge    │  │   Probes    │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
├─────────────────────────────────────────────────────────────────┤
│                       PostgreSQL Index                           │
│         Code | Symbols | Logs | Crashes | Discoveries           │
├─────────────────────────────────────────────────────────────────┤
│                         The Device                               │
│              iOS / macOS / Android / Simulator                   │
└─────────────────────────────────────────────────────────────────┘
```

## Current Status

### Working (from Scalable MCP)

| Layer | Tools | Status |
|-------|-------|--------|
| React | devtools_tree, devtools_find, devtools_eval | ✅ |
| Bridge | module_status, platform_diff, codegen_trace | ✅ |
| Native | lldb.*, crash_debug, build logs | ✅ |
| Device | simulator control, screenshots, SQL | ✅ |

### Building

| Layer | Tools | Status |
|-------|-------|--------|
| Metal | framework analysis, symbol dump, IOKit trace | 🔲 |
| Silicon | ANE validate, profile, memory read | 🔲 |
| Discover | probe, fuzz, map, document | 🔲 |
| Kernel | crash analysis, checkpointing | 🔲 |

## Getting Started

```bash
# Install
npm install @control/mcp

# Add to Claude Code
claude mcp add control

# Start controlling
control/react tree
control/bridge status
control/native crash
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
