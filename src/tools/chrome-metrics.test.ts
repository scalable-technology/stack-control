import { describe, expect, it } from 'vitest';
import { MAX_VITAL_ENTRIES, inpOf, lcpOf, pageVitals, pickMetrics } from './chrome-metrics.js';
import { worstSessionWindow } from './chrome-trace.js';

describe('worstSessionWindow (CLS, shared by trace summaries and metrics)', () => {
  // The analyzeTrace vitals cases, run against the shared function in page milliseconds.
  const at = (...pairs: [number, number][]) => pairs.map(([t, score]) => ({ t, score }));

  it('is 0 without shifts', () => {
    expect(worstSessionWindow([], 1)).toBe(0);
  });

  it('sums nearby shifts, in any input order', () => {
    expect(worstSessionWindow(at([200, 0.05], [100, 0.1]), 1)).toBeCloseTo(0.15);
  });

  it('takes the largest session rather than summing sessions separated by over one second', () => {
    expect(worstSessionWindow(at([1500, 0.3], [0, 0.2]), 1)).toBeCloseTo(0.3);
    expect(worstSessionWindow(at([0, 0.3], [1500, 0.2]), 1)).toBeCloseTo(0.3);
  });

  it('starts a new session at a gap of exactly one second', () => {
    expect(worstSessionWindow(at([0, 0.2], [1000, 0.3]), 1)).toBeCloseTo(0.3);
  });

  it('keeps a gap just under one second in the same session', () => {
    expect(worstSessionWindow(at([0, 0.2], [999, 0.3]), 1)).toBeCloseTo(0.5);
  });

  it('caps a session at five seconds despite smaller gaps', () => {
    const shifts = [0, 900, 1800, 2700, 3600, 4500, 5400].map((t) => ({ t, score: 0.1 }));
    expect(worstSessionWindow(shifts, 1)).toBeCloseTo(0.6);
  });

  it('starts a new session at exactly five seconds from the first shift', () => {
    const shifts = [0, 800, 1600, 2400, 3200, 4000, 4800, 5000].map((t) => ({ t, score: 0.1 }));
    expect(worstSessionWindow(shifts, 1)).toBeCloseTo(0.7);
  });

  it('keeps a shift 4999ms after the first in the same session', () => {
    const shifts = [0, 800, 1600, 2400, 3200, 4000, 4800, 4999].map((t) => ({ t, score: 0.1 }));
    expect(worstSessionWindow(shifts, 1)).toBeCloseTo(0.8);
  });

  it('reads trace microseconds with perMs 1000', () => {
    expect(worstSessionWindow(at([0, 0.2], [999_000, 0.3]), 1000)).toBeCloseTo(0.5);
    expect(worstSessionWindow(at([0, 0.2], [1_000_000, 0.3]), 1000)).toBeCloseTo(0.3);
  });
});

describe('inpOf', () => {
  const events = (...durations: number[]) => durations.map((duration, i) => ({ duration, interactionId: i + 1 }));

  it('is null without interactions, never 0', () => {
    expect(inpOf([])).toBeNull();
    expect(inpOf([{ duration: 300, interactionId: 0 }])).toBeNull();
  });

  it('is the one interaction when there is one', () => {
    expect(inpOf(events(120))).toEqual({ ms: 120, interactions: 1 });
  });

  it('takes the worst of 49 interactions', () => {
    const durations = Array.from({ length: 49 }, (_, i) => i + 1);
    expect(inpOf(events(...durations))).toEqual({ ms: 49, interactions: 49 });
  });

  it('skips the worst one at 50 interactions (index 1)', () => {
    const durations = Array.from({ length: 50 }, (_, i) => i + 1);
    expect(inpOf(events(...durations))).toEqual({ ms: 49, interactions: 50 });
  });

  it('skips the worst two at 100 interactions (index 2)', () => {
    const durations = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(inpOf(events(...durations))).toEqual({ ms: 98, interactions: 100 });
  });

  it('skips one at 99 interactions: floor, not ceil', () => {
    const durations = Array.from({ length: 99 }, (_, i) => i + 1);
    expect(inpOf(events(...durations))).toEqual({ ms: 98, interactions: 99 });
  });

  it('handles ties', () => {
    expect(inpOf(events(200, 200, 50))).toEqual({ ms: 200, interactions: 3 });
  });

  it('ignores interactionId 0 and keeps the longest duration per interactionId', () => {
    const v = inpOf([
      { duration: 500, interactionId: 0 },
      { duration: 40, interactionId: 7 },
      { duration: 160, interactionId: 7 },
      { duration: 64, interactionId: 7 },
      { duration: 80, interactionId: 9 },
    ]);
    expect(v).toEqual({ ms: 160, interactions: 2 });
  });
});

describe('lcpOf', () => {
  it('is null without candidates', () => {
    expect(lcpOf([])).toBeNull();
  });

  it('is the last candidate, rounded to 2 decimals', () => {
    expect(
      lcpOf([
        { startTime: 100, size: 5000, element: 'img' },
        { startTime: 412.34567, size: 90, element: 'p' },
      ])
    ).toEqual({ ms: 412.35, size: 90, element: 'p' });
  });
});

describe('pickMetrics', () => {
  const real = [
    { name: 'Timestamp', value: 1234.5 },
    { name: 'Nodes', value: 512 },
    { name: 'Documents', value: 2 },
    { name: 'Frames', value: 1 },
    { name: 'JSEventListeners', value: 7 },
    { name: 'JSHeapUsedSize', value: 1_500_000 },
    { name: 'JSHeapTotalSize', value: 3_000_000 },
    { name: 'LayoutCount', value: 4 },
    { name: 'RecalcStyleCount', value: 5 },
    { name: 'LayoutDuration', value: 0.0123456 },
    { name: 'RecalcStyleDuration', value: 0.002 },
    { name: 'ScriptDuration', value: 0.25 },
    { name: 'V8CompileDuration', value: 0.001234 },
    { name: 'TaskDuration', value: 1.5 },
  ];

  it('keeps the named metrics, converts durations to ms with 2 decimals, and drops the rest', () => {
    expect(pickMetrics(real)).toEqual({
      nodes: 512,
      documents: 2,
      frames: 1,
      jsEventListeners: 7,
      jsHeapUsedBytes: 1_500_000,
      jsHeapTotalBytes: 3_000_000,
      layoutCount: 4,
      recalcStyleCount: 5,
      layoutMs: 12.35,
      recalcStyleMs: 2,
      scriptMs: 250,
      v8CompileMs: 1.23,
      taskMs: 1500,
    });
  });

  it('gives null, never 0, for a metric that is missing or not a finite number', () => {
    const m = pickMetrics([
      { name: 'Nodes', value: NaN },
      { name: 'Documents', value: '2' },
      { name: 'Frames', value: Infinity },
      { name: 'LayoutDuration' },
      null,
      'Nodes',
    ]);
    expect(Object.values(m).every((v) => v === null)).toBe(true);
    expect(Object.keys(m)).toHaveLength(13);
  });

  it('gives all null for a result that is not an array', () => {
    for (const raw of [undefined, null, {}, 'metrics', { length: 3, 0: { name: 'Nodes', value: 1 } }]) {
      const m = pickMetrics(raw);
      expect(m.nodes).toBeNull();
      expect(Object.keys(m)).toHaveLength(13);
    }
  });
});

describe('pageVitals', () => {
  it('computes lcp, cls and inp from the probe result', () => {
    const v = pageVitals({
      lcp: [
        { startTime: 80, size: 100, element: 'p' },
        { startTime: 210.5, size: 4000, element: 'h1' },
      ],
      shifts: [
        { value: 0.1, startTime: 300, hadRecentInput: false },
        { value: 0.9, startTime: 400, hadRecentInput: true },
        { value: 0.05, startTime: 500, hadRecentInput: false },
      ],
      events: [
        { duration: 152, interactionId: 3, startTime: 1000 },
        { duration: 48, interactionId: 3, startTime: 1000 },
        { duration: 300, interactionId: 0, startTime: 1100 },
      ],
    });
    expect(v).not.toBeNull();
    expect(v!.lcp).toEqual({ ms: 210.5, size: 4000, element: 'h1' });
    expect(v!.cls).toBeCloseTo(0.15);
    expect(v!.shiftCount).toBe(2);
    expect(v!.inp).toEqual({ ms: 152, interactions: 1 });
  });

  it('gives cls 0 (not null) and inp and lcp null for a quiet page', () => {
    expect(pageVitals({ lcp: [], shifts: [], events: [] })).toEqual({ lcp: null, cls: 0, shiftCount: 0, inp: null });
  });

  it('is null when the result is not the probe shape at all', () => {
    for (const raw of [undefined, null, 'vitals', 42, []]) expect(pageVitals(raw)).toBeNull();
  });

  describe('hostile entries from the page', () => {
    it('treats a list that is not an array as empty', () => {
      const v = pageVitals({ lcp: 'x', shifts: { length: 2, 0: { value: 1, startTime: 0 } }, events: 7 });
      expect(v).toEqual({ lcp: null, cls: 0, shiftCount: 0, inp: null });
    });

    it('ignores entries with non-finite or non-numeric numbers', () => {
      const v = pageVitals({
        lcp: [
          { startTime: 50, size: 10, element: 'p' },
          { startTime: NaN, size: 10, element: 'h1' },
          { startTime: 90, size: Infinity, element: 'h2' },
          { startTime: '95', size: 1, element: 'h3' },
          null,
        ],
        shifts: [
          { value: 0.2, startTime: 0, hadRecentInput: false },
          { value: Infinity, startTime: 10, hadRecentInput: false },
          { value: 0.3, startTime: NaN, hadRecentInput: false },
          { value: '0.4', startTime: 20 },
          42,
        ],
        events: [
          { duration: 120, interactionId: 1, startTime: 0 },
          { duration: Infinity, interactionId: 2, startTime: 0 },
          { duration: 500, interactionId: NaN, startTime: 0 },
          { duration: 600, interactionId: '3', startTime: 0 },
        ],
      });
      expect(v).toEqual({
        lcp: { ms: 50, size: 10, element: 'p' },
        cls: 0.2,
        shiftCount: 1,
        inp: { ms: 120, interactions: 1 },
      });
    });

    it('truncates a 1MB element name to 200 characters, and an element that is not a string is empty', () => {
      const v = pageVitals({ lcp: [{ startTime: 10, size: 1, element: 'x'.repeat(1 << 20) }], shifts: [], events: [] });
      expect(v!.lcp!.element.length).toBe(200);
      expect(v!.lcp!.element.endsWith('…')).toBe(true);
      const w = pageVitals({ lcp: [{ startTime: 10, size: 1, element: { toString: () => 'evil' } }], shifts: [], events: [] });
      expect(w!.lcp!.element).toBe('');
    });

    it(`reads at most ${MAX_VITAL_ENTRIES} entries of each list, and fast`, () => {
      // Each shift is 1001ms after the one before, so every shift is its own session: the worst
      // session is the largest single score considered. Only an entry past the cap scores 0.9.
      const shifts = Array.from({ length: 100_000 }, (_, i) => ({
        value: i < MAX_VITAL_ENTRIES ? 0.01 : 0.9,
        startTime: i * 1001,
        hadRecentInput: false,
      }));
      const events = Array.from({ length: 100_000 }, (_, i) => ({ duration: 100, interactionId: i + 1, startTime: i }));
      const lcp = Array.from({ length: 100_000 }, (_, i) => ({ startTime: i + 1, size: 1, element: 'p' }));
      const started = performance.now();
      const v = pageVitals({ lcp, shifts, events });
      // Generous: this catches work per entry over all 100k, not a slow machine.
      expect(performance.now() - started).toBeLessThan(5000);
      expect(v!.cls).toBeCloseTo(0.01);
      expect(v!.shiftCount).toBe(MAX_VITAL_ENTRIES);
      expect(v!.inp!.interactions).toBe(MAX_VITAL_ENTRIES);
      expect(v!.lcp!.ms).toBe(MAX_VITAL_ENTRIES);
    });
  });
});
