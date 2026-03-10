# Claude Code Instructions — Control

## What This Is

Control is an MCP server for full-stack development — from React components to silicon.

**Not just debugging. CONTROL.**

## The Vision

```
control/react     →  React component tree, props, state
control/bridge    →  TurboModules, JSI, codegen verification
control/native    →  LLDB, crash analysis, build logs
control/metal     →  Private frameworks, IOKit, hardware APIs
control/silicon   →  ANE, GPU, memory buffers, IOSurfaces
control/discover  →  Reverse engineering, probing, fuzzing
control/kernel    →  Kernel-level tracing, crash analysis
```

## Origin

Started as debugging tools in `@scalable/mcp`. Grew as we built:
- `react-native-pglite` — PostgreSQL + PostGIS on mobile
- `react-native-ane` — LLM training on Apple Neural Engine

We went from debugging React components to causing kernel panics. The tools evolved to match.

## Current State

### Exists (port from @scalable/mcp)

```
packages/mcp/src/tools/
├── metro-devtools.ts    → control/react (CDP connection to React DevTools)
├── react-native.ts      → control/bridge (TurboModule health, platform diff)
├── lldb.ts              → control/native (full LLDB integration)
├── logs.ts              → control/native (crash_debug, build logs)
├── devices.ts           → control/device (simulators, screenshots, device SQL)
├── pglite-diagnostics.ts → control/device (PGLite health checks)
```

### To Build

```
control/metal
├── frameworks.ts        — Private framework analysis
├── symbols.ts           — Symbol extraction
├── iokit.ts             — IOKit service tracing
├── trace.ts             — syscall/mach tracing

control/silicon
├── ane.ts               — ANE compile tracking, shape validation, profiling
├── gpu.ts               — GPU utilization, Metal debugging
├── memory.ts            — IOSurface read/write, memory mapping

control/discover
├── probe.ts             — Controlled failure to find limits
├── fuzz.ts              — Parameter fuzzing
├── map.ts               — Memory/process mapping
├── document.ts          — Record discoveries

control/kernel
├── crash.ts             — macOS kernel panic analysis
├── checkpoint.ts        — State saving before risky ops
├── trace.ts             — Kernel-level tracing
```

## Key Technical Knowledge

### ANE (Apple Neural Engine)
- 64-byte alignment required on last axis (fp16 = multiple of 32)
- 119 compile limit per process, then must restart
- fp16 on ANE, fp32 for CPU crossover operations
- Private API via reverse engineering (see maderix/ANE)

### TurboModules
- Spec file → codegen → native implementation chain
- Platform type mapping: NSDictionary ↔ ReadableMap, etc.
- Health statuses: spec_only, partial, mismatch, healthy, broken

### LLDB Integration
- Batch mode for one-shot analysis
- Interactive sessions for debugging
- Can attach to simulators and devices

## Philosophy

1. **No black boxes** — If it runs, you can understand it
2. **Full stack = FULL stack** — Pixel to silicon
3. **Controlled failure is learning** — Crashes teach us limits
4. **AI at every layer** — Help at kernel level, not just JS

## Commands

```bash
# Development
pnpm install
pnpm dev

# Testing
pnpm test

# Build
pnpm build
```

## Related Projects

- `/Users/tyrauber/Sites/scalable` — Original MCP implementation
- `/Users/tyrauber/Sites/react-native-ane` — ANE training (our testbed)
- `/Users/tyrauber/Sites/react-native-pglite` — PGLite (our testbed)
