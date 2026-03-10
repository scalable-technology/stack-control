/**
 * control/discover — Reverse Engineering Layer
 *
 * Tools for discovering undocumented behavior through controlled exploration.
 *
 * Commands:
 * - control/discover probe <target> --fuzz <range>  — Find limits through controlled failure
 * - control/discover map <process>                  — Memory map a process
 * - control/discover diff <state1> <state2>         — What changed?
 * - control/discover limits <target>                — Document discovered limits
 *
 * NEW - To build:
 *
 * Philosophy: Controlled failure is learning.
 * When we crash to find the alignment limit, we document it.
 * When we hit the compile limit, we record it.
 * Knowledge is extracted from the edges of behavior.
 */

export interface Discovery {
  target: string;
  parameter: string;
  limit: unknown;
  discovered_at: Date;
  method: 'fuzz' | 'crash' | 'observation';
  notes?: string;
}

// Known discoveries (to be persisted to DB)
export const KNOWN_DISCOVERIES: Discovery[] = [
  {
    target: 'ane',
    parameter: 'last_axis_alignment_fp16',
    limit: 32,
    discovered_at: new Date('2024-01-01'),
    method: 'crash',
    notes: 'Must be multiple of 32 for fp16, or kernel panic',
  },
  {
    target: 'ane',
    parameter: 'compile_limit_per_process',
    limit: 119,
    discovered_at: new Date('2024-01-01'),
    method: 'observation',
    notes: 'After 119 compiles, must restart process',
  },
];

export const discover = {
  name: 'control/discover',
  description: 'Reverse engineering through controlled exploration',

  // TODO: Build
  // - probe(target, parameter, range): Discovery
  // - fuzz(target, parameter, range): Discovery[]
  // - mapMemory(process): MemoryMap
  // - diffState(before, after): StateDiff
  // - recordDiscovery(discovery): void
  // - getDiscoveries(target?): Discovery[]
};
