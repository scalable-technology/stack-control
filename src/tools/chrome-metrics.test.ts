import { describe, expect, it } from 'vitest';
import {
  MAX_VITAL_ENTRIES,
  TAB_CHANGED,
  createMetricsReader,
  inpOf,
  lcpOf,
  pageVitals,
  pickMetrics,
  readMetrics,
  type MetricsCdp,
} from './chrome-metrics.js';
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

describe('pageVitals: numbers outside a sane domain', () => {
  const finiteOrNull = (v: unknown): boolean =>
    v === null || (typeof v === 'number' && Number.isFinite(v)) ||
    (typeof v === 'object' && Object.values(v as object).every((x) => typeof x === 'string' || finiteOrNull(x)));

  it('ignores 1e308 values, so nothing overflows to Infinity', () => {
    const v = pageVitals({
      lcp: [{ startTime: 1e308, size: 1, element: 'p' }, { startTime: 10, size: 1e308, element: 'h1' }],
      shifts: [
        { value: 1e308, startTime: 0, hadRecentInput: false },
        { value: 1e308, startTime: 1, hadRecentInput: false },
        { value: 0.1, startTime: 1e308, hadRecentInput: false },
      ],
      events: [{ duration: 1e308, interactionId: 1, startTime: 0 }, { duration: 50, interactionId: 2, startTime: 1e308 }],
    });
    // The second event is ignored too: its startTime is a time, bounded like a duration.
    expect(v).toEqual({ lcp: null, cls: 0, shiftCount: 0, inp: null });
    expect(finiteOrNull(v)).toBe(true);
  });

  it('accepts the edges of each domain and rejects just past them and below 0', () => {
    const v = pageVitals({
      lcp: [{ startTime: 1e12, size: 1e15, element: 'p' }, { startTime: 1e12 + 1, size: 1, element: 'x' }, { startTime: 5, size: 1e15 + 1, element: 'y' }],
      shifts: [
        { value: 1000, startTime: 0, hadRecentInput: false },
        { value: 1000.001, startTime: 1, hadRecentInput: false },
        { value: -0.5, startTime: 2, hadRecentInput: false },
        { value: 0.1, startTime: -1, hadRecentInput: false },
      ],
      events: [{ duration: 1e12, interactionId: 1, startTime: 0 }, { duration: -5, interactionId: 2, startTime: 0 }],
    });
    expect(v!.lcp).toEqual({ ms: 1e12, size: 1e15, element: 'p' });
    expect(v!.cls).toBe(1000);
    expect(v!.shiftCount).toBe(1);
    expect(v!.inp).toEqual({ ms: 1e12, interactions: 1 });
  });
});

interface FakeMetricsOptions {
  /** Per method: 'reject' (no answer), 'error' (Chrome answers with an error), or the result to answer. */
  answers?: Record<string, 'reject' | 'error' | unknown>;
  /** Runs before a method is answered. */
  onSend?: (method: string) => void | Promise<void>;
}

/** A fake CDP with Chrome's answers for one metrics call; records every command. */
function fakeCdp(options: FakeMetricsOptions = {}) {
  const sent: { method: string; params?: Record<string, unknown>; timeoutMs?: number }[] = [];
  const defaults: Record<string, unknown> = {
    'Performance.enable': {},
    'Performance.getMetrics': { metrics: [{ name: 'Nodes', value: 42 }, { name: 'JSHeapUsedSize', value: 1000 }] },
    'Performance.disable': {},
    'Page.getFrameTree': { frameTree: { frame: { id: 'F1' } } },
    'Page.createIsolatedWorld': { executionContextId: 77 },
    'Runtime.evaluate': { result: { value: { lcp: [], shifts: [{ value: 0.25, startTime: 10, hadRecentInput: false }], events: [] } } },
  };
  const cdp: MetricsCdp = {
    sendCommand: async (method, params, timeoutMs) => {
      sent.push({ method, params, timeoutMs });
      await options.onSend?.(method);
      const answer = options.answers && method in options.answers ? options.answers[method] : defaults[method];
      if (answer === 'reject') throw new Error(`Command ${method} timed out after 30s`);
      if (answer === 'error') return { error: { message: `${method} refused` } };
      return { result: answer };
    },
  };
  return { cdp, sent, methods: () => sent.map((x) => x.method) };
}

describe('readMetrics', () => {
  const always = () => true;

  it('reads the counters, then the vitals in an isolated world', async () => {
    const f = fakeCdp();
    const r = await readMetrics(f.cdp, always);
    expect(r.success, r.error).toBe(true);
    const d = r.data as { metrics: Record<string, unknown>; vitals: Record<string, unknown> };
    expect(d.metrics.nodes).toBe(42);
    expect(d.metrics.documents).toBeNull();
    expect(d.vitals).toEqual({ lcp: null, cls: 0.25, shiftCount: 1, inp: null });
    expect(f.methods()).toEqual([
      'Performance.enable', 'Performance.getMetrics', 'Performance.disable',
      'Page.getFrameTree', 'Page.createIsolatedWorld', 'Runtime.evaluate',
    ]);
    expect(f.sent[4].params).toEqual({ frameId: 'F1', worldName: 'control-metrics' });
    const evaluate = f.sent[5];
    expect(evaluate.params).toMatchObject({ contextId: 77, returnByValue: true, awaitPromise: true });
    expect(evaluate.timeoutMs).toBe(10_000);
  });

  it.each([
    ['Page.createIsolatedWorld', 'error'],
    ['Page.createIsolatedWorld', 'reject'],
    ['Page.createIsolatedWorld', { executionContextId: 'not a number' }],
    ['Page.getFrameTree', 'error'],
    ['Page.getFrameTree', { frameTree: {} }],
  ])('never falls back to the page world: %s answering %j gives vitals null', async (method, answer) => {
    const f = fakeCdp({ answers: { [method]: answer } });
    const r = await readMetrics(f.cdp, always);
    expect(r.success, r.error).toBe(true);
    const d = r.data as { metrics: Record<string, unknown>; vitals: unknown; vitalsError?: string };
    expect(d.metrics.nodes).toBe(42);
    expect(d.vitals).toBeNull();
    expect(d.vitalsError).toMatch(/separate JS world/);
    expect(f.methods()).not.toContain('Runtime.evaluate');
  });

  it("gives vitals null and our own reason when the probe throws, without the page's text", async () => {
    const f = fakeCdp({
      answers: { 'Runtime.evaluate': { exceptionDetails: { text: 'page secret text', exception: { description: 'page secret text' } } } },
    });
    const r = await readMetrics(f.cdp, always);
    expect(r.success).toBe(true);
    const d = r.data as { vitals: unknown; vitalsError?: string };
    expect(d.vitals).toBeNull();
    expect(d.vitalsError).toBeTruthy();
    expect(d.vitalsError).not.toMatch(/secret/);
  });

  it('keeps 1e308 values from the probe out of the result', async () => {
    const f = fakeCdp({
      answers: {
        'Runtime.evaluate': {
          result: {
            value: {
              lcp: [{ startTime: 1e308, size: 1e308, element: 'p' }],
              shifts: [{ value: 1e308, startTime: 0 }, { value: 1e308, startTime: 1 }],
              events: [{ duration: 1e308, interactionId: 3, startTime: 0 }],
            },
          },
        },
      },
    });
    const r = await readMetrics(f.cdp, always);
    expect((r.data as { vitals: unknown }).vitals).toEqual({ lcp: null, cls: 0, shiftCount: 0, inp: null });
  });

  it.each(['reject', 'error'])('sends Performance.disable even when enable gets %s', async (answer) => {
    const f = fakeCdp({ answers: { 'Performance.enable': answer } });
    const r = await readMetrics(f.cdp, always);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^Could not read Chrome's metrics: /);
    expect(f.methods()).toEqual(['Performance.enable', 'Performance.disable']);
  });

  it("fails with Chrome's message when getMetrics is refused, and still disables", async () => {
    const f = fakeCdp({ answers: { 'Performance.getMetrics': 'error' } });
    const r = await readMetrics(f.cdp, always);
    expect(r).toEqual({ success: false, error: "Could not read Chrome's metrics: Performance.getMetrics refused" });
    expect(f.methods()).toContain('Performance.disable');
  });

  it('ignores a failed disable', async () => {
    const f = fakeCdp({ answers: { 'Performance.disable': 'reject' } });
    expect((await readMetrics(f.cdp, always)).success).toBe(true);
  });

  it.each(['Performance.disable', 'Runtime.evaluate'])(
    'refuses to mix tabs: a tab switch at %s gives an error, never data',
    async (at) => {
      let selected = true;
      const f = fakeCdp({ onSend: (m) => { if (m === at) selected = false; } });
      const r = await readMetrics(f.cdp, () => selected);
      expect(r).toEqual({ success: false, error: TAB_CHANGED });
      // Once the tab changed, nothing more is sent: the probe never runs in the new tab.
      expect(f.methods().slice(f.methods().indexOf(at) + 1)).toEqual([]);
    }
  );

  it('sends nothing when the tab already changed before it started', async () => {
    const f = fakeCdp();
    expect(await readMetrics(f.cdp, () => false)).toEqual({ success: false, error: TAB_CHANGED });
    expect(f.sent).toEqual([]);
  });
});

describe('createMetricsReader', () => {
  const perf = (methods: string[]) => methods.filter((m) => m.startsWith('Performance.'));

  it('runs overlapping calls one at a time, so one never disables the other mid-read', async () => {
    const f = fakeCdp({ onSend: () => new Promise((r) => setTimeout(r, 5)) });
    const read = createMetricsReader();
    const [a, b] = await Promise.all([read(f.cdp, () => true), read(f.cdp, () => true)]);
    expect(a.success && b.success).toBe(true);
    expect(perf(f.methods())).toEqual([
      'Performance.enable', 'Performance.getMetrics', 'Performance.disable',
      'Performance.enable', 'Performance.getMetrics', 'Performance.disable',
    ]);
  });

  it('does not let a call that throws block the next one', async () => {
    const f = fakeCdp();
    const read = createMetricsReader();
    const first = read(f.cdp, () => { throw new Error('boom'); });
    const second = read(f.cdp, () => true);
    await expect(first).rejects.toThrow('boom');
    expect((await second).success).toBe(true);
  });
});
