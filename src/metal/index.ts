/**
 * control/metal — Hardware API Layer
 *
 * Tools for accessing private frameworks, IOKit, and hardware APIs.
 *
 * Commands:
 * - control/metal frameworks           — List private frameworks
 * - control/metal symbols <framework>  — Dump symbols
 * - control/metal iokit services       — List IOKit services
 * - control/metal trace <binary>       — Trace syscalls/mach calls
 *
 * NEW - To build:
 * - Private framework discovery
 * - Symbol extraction from binaries
 * - IOKit service enumeration
 * - Syscall/mach tracing
 */

export const metal = {
  name: 'control/metal',
  description: 'Private framework and hardware API access',

  // TODO: Build new tools
  // - listPrivateFrameworks()
  // - extractSymbols(framework)
  // - listIOKitServices()
  // - traceSyscalls(binary)
};
