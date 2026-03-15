# Claude Code Instructions — Control

Control is an MCP server for full-stack development — from React components to silicon.

**Not just debugging. CONTROL.**

## The Layers

```
react      →  Component tree, props, state (via Metro DevTools)
bridge     →  TurboModules, platform diff, type mappings
native     →  Full LLDB (batch + interactive), crash analysis
device     →  Simulator/emulator control, screenshots, logs
silicon    →  ANE validation, GPU power/frequency monitoring
kernel     →  Kernel panic parsing and analysis
discover   →  Private frameworks, symbols, discoveries
```

## Origin

Started as debugging tools for Expo/React Native. Grew as we built:
- `react-native-pglite` — PostgreSQL + PostGIS on mobile
- `react-native-ane` — LLM training on Apple Neural Engine

We went from debugging React components to causing kernel panics. The tools evolved to match.

## Current State

All layers implemented:

```
src/tools/
├── react.ts      — Component tree via Metro DevTools (CDP)
├── bridge.ts     — TurboModule health, platform diff
├── native.ts     — Full LLDB integration (batch + interactive)
├── device.ts     — Simulator/emulator management, screenshots, logs
├── silicon.ts    — ANE validation, GPU power/frequency monitoring
├── kernel.ts     — Kernel panic parsing and analysis
├── discover.ts   — Framework listing, symbol extraction, discoveries
```

Control is **stateless by design** — pure inspection tools, no database.

## Key Technical Knowledge

### ANE (Apple Neural Engine)
- 64-byte alignment required on last axis (fp16 = multiple of 32)
- 119 compile limit per process, then must restart
- fp16 on ANE, fp32 for CPU crossover operations
- Private API via reverse engineering (see maderix/ANE)

### GPU (Metal/AGX)
- M4 uses DVFS — can cause 3x performance variance on identical workloads
- `powermetrics --samplers gpu_power` exposes real-time frequency (requires sudo)
- P-states: ~1.5GHz (max) vs ~0.5GHz (throttled)
- Pre-warm GPU with sustained load to stabilize high P-state
- `iogpu.dynamic_lwm` sysctl controls adaptive power management

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

## Shared Knowledge

These patterns were learned through real debugging sessions.

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

