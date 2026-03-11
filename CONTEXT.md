# Context — Why Control Exists

This document captures the strategic thinking behind Control for future development sessions.

## The Journey

Started building debugging tools for Expo/React Native. Then:

1. **Built react-native-pglite** — PostgreSQL + PostGIS compiled for mobile
   - Needed: Device SQL execution, PGLite diagnostics
   - Built: `device.sql`, `pglite.diagnostics`

2. **Built react-native-ane** — LLM training on Apple Neural Engine
   - Needed: LLDB for native crashes, kernel panic analysis
   - Discovered: 64-byte alignment requirement, 119 compile limit
   - Realized: We're not debugging JS anymore. We're at silicon.

3. **Recognized the pattern** — We do "Native to JS" work
   - Take complex C/C++ libraries
   - Make them work on iOS and Android
   - Debug at every layer when things break

## Competitive Landscape (March 2026)

We researched existing tools. Everyone else is at the JS layer:

| Tool | What it does | Layer |
|------|--------------|-------|
| **Expo MCP** | Docs, builds, screenshots, taps | JS + Basic device |
| **Expo Skills** | Patterns for UI, deployment, upgrades | JS guidance |
| **Callstack Skills** | RN performance optimization | JS patterns |
| **Limelight** | Runtime context (network, state, renders) | JS runtime |
| **react-native-debugger-mcp** | Metro log streaming | JS logs |

**Gap we fill:**
- TurboModule health checking (spec → codegen → native)
- iOS vs Android implementation comparison
- LLDB integration (batch and interactive)
- Build log analysis (Xcode/Gradle)
- Crash context with related symbols
- **NEW:** ANE/GPU/silicon layer tooling
- **NEW:** Reverse engineering infrastructure

## The Positioning

> "Control the whole stack. From pixel to silicon."

Not "debug" — **control**. You understand and manipulate every layer.

The name "Control" came from the realization that "Threshold" (our earlier idea) was about the boundary between native and JS. But we went *through* that boundary. We're not at a threshold anymore — we're deep in the metal, causing kernel panics.

"Control" says what we do: give developers (and AI) control over layers they couldn't access before.

## Architecture Philosophy

**Layers, not tools.** Each layer (`control/react`, `control/bridge`, etc.) is a coherent unit. You think "where am I in the stack?" and use that layer's tools.

**AI at every layer.** The goal is AI-assisted development at levels where AI hasn't been useful before. When you're debugging a kernel panic from tensor misalignment, AI should help there too.

**Controlled failure is learning.** When we fuzz to find limits, crashes are data. The 64-byte ANE alignment? Someone crashed to find that. We systematize this with `control/discover`.

## Implementation Status

All layers implemented:

| Layer | File | Key Methods |
|-------|------|-------------|
| react | `react.ts` | connect, tree, find, props, evaluate |
| bridge | `bridge.ts` | module_list, module_status, platform_diff |
| native | `native.ts` | crash_run, session_attach, breakpoint_*, backtrace |
| device | `device.ts` | list, boot, screenshot, logs, fingerprint |
| silicon | `silicon.ts` | ane_validate, ane_status, ane_info |
| kernel | `kernel.ts` | panic_parse, panic_list, panic_analyze |
| discover | `discover.ts` | discoveries, frameworks, symbols |

## Test Targets

- **react-native-ane** (`~/Sites/react-native-ane`) — Silicon layer testing
- **react-native-pglite** (`~/Sites/react-native-pglite`) — Native/C layer testing
- **theoutboundclient** — React/bridge layer testing (MapLibre debugging)

## Success Criteria

1. Can debug a React component rendering issue → `control/react`
2. Can diagnose a TurboModule registration failure → `control/bridge`
3. Can analyze a native crash → `control/native`
4. Can discover what private APIs an app uses → `control/metal`
5. Can validate ANE tensor shapes before kernel panic → `control/silicon`
6. Can systematically find hardware limits → `control/discover`
7. Can parse a macOS kernel panic for ANE faults → `control/kernel`

## The Team

Built by Ty Rauber and Claude, going from "why isn't this button rendering" to "why did this tensor shape panic the kernel" over the course of building increasingly ambitious React Native packages.

---

*"We control the stack. All of it. From the pixel to the silicon."*
