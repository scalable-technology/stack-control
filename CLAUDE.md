# Claude Code Instructions — Control

> **MCP Connected:** The `.mcp.json` connects to scalable's infrastructure. You have full access to `code()`, `device()`, `git()`, `logs()`, and knowledge tools from day one. You're not starting from scratch.

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

## Shared Knowledge — From Scalable

Control inherits knowledge from scalable. This is intentional. We earned these lessons.

### The Debugging Loop

```
1. CRASH OCCURS
   ↓
2. VERIFY BUILD IS CURRENT
   - If mismatch → rebuild and reinstall
   - If match → continue
   ↓
3. GET CRASH CONTEXT
   - JS errors: logs, stack traces
   - Native crashes: .ips files, crash reports
   - Kernel panics: panic logs, hardware state
   ↓
4. ANALYZE
   - Function names in stack trace
   - Memory addresses
   - Signal type (SIGABRT, EXC_BAD_ACCESS, kernel panic)
   ↓
5. FIX
   - Make changes
   - Rebuild
   ↓
6. VERIFY FIX BUILT
   - Check fingerprint changed
   - Install and verify
   ↓
7. TEST
   - Run diagnostics
   - Test the operation that was crashing
   ↓
8. REPEAT if crash persists
```

### Known Crash Patterns

| Signal | Location | Cause | Fix |
|--------|----------|-------|-----|
| EXC_BAD_ACCESS | hash_search | Uninitialized extension | Add to init function |
| SIGABRT | plpgsql | HashTable not initialized | Check init order |
| NULL pointer | PostGIS | Extension not loaded | Check loading order |
| Kernel panic | ANE | Alignment violation | 64-byte align last axis |
| Kernel panic | ANE | Compile limit | Restart process after 119 |

### Platform Type Mappings (Bridge Layer)

| iOS (ObjC/Swift) | Android (Kotlin/Java) | JS |
|-----------------|----------------------|-----|
| NSDictionary | ReadableMap | object |
| NSArray | ReadableArray | array |
| NSString | String | string |
| NSNumber | Double/Integer | number |
| BOOL | Boolean | boolean |
| void | Unit | void |
| Promise | Promise | Promise |

## Cross-Project References

When working in control, you may need to reference:

### Scalable Documentation
- `.scalable/workflows/debug-pglite.md` — Full debugging workflow
- `.scalable/packages/mcp.md` — MCP tool reference
- `.agents/react-native/` — Generic RN patterns

### Scalable Source (to port)
- `packages/mcp/src/tools/metro-devtools.ts` — CDP/React DevTools
- `packages/mcp/src/tools/react-native.ts` — TurboModule health
- `packages/mcp/src/tools/lldb.ts` — LLDB integration
- `packages/mcp/src/tools/logs.ts` — Crash analysis

### ANE Knowledge (react-native-ane)
- The ANE compiler lives at `/System/Library/PrivateFrameworks/ANECompiler.framework`
- MIL (Machine Intermediate Language) is the instruction format
- Use `aneinfo` to query device capabilities
- Shapes must be statically known at compile time

## Related Projects

- `/Users/tyrauber/Sites/scalable` — Original MCP implementation, knowledge source
- `/Users/tyrauber/Sites/react-native-ane` — ANE training (silicon testbed)
- `/Users/tyrauber/Sites/react-native-pglite` — PGLite (native testbed)

## Continuity Note

This project maintains continuity with work done in scalable. The knowledge, patterns, and debugging wisdom here were earned through real crashes, real kernel panics, and real debugging sessions.

When you pick this up, you're not starting fresh. You're continuing.
