import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { OwnWorldSlot, waitForCdpEventMatching } from './cdp-events.js';
import {
  MAX_VITAL_ENTRIES,
  METRICS_WORLD_NAME,
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
  /** Per method, answers used one per call, in order, before falling back to answers. */
  sequence?: Record<string, ('reject' | 'error' | unknown)[]>;
  /** Runs before a method is answered. */
  onSend?: (method: string) => void | Promise<void>;
  /** When Chrome announces each world it makes: before its answer (Chrome's own order), after it, or never. */
  announce?: 'before' | 'after' | 'never';
  /** The contexts announced for the world made with this numeric id; by default that world alone. */
  contexts?: (id: number) => unknown[];
}

/** The context Chrome announces for a world made in frame T1 by Page.createIsolatedWorld. */
const ourWorld = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  uniqueId: `U-${id}`,
  name: METRICS_WORLD_NAME,
  origin: 'http://127.0.0.1:1',
  auxData: { frameId: 'T1', isDefault: false, type: 'isolated' },
  ...extra,
});

const CREATED = 'Runtime.executionContextCreated';

/**
 * A fake CDP with Chrome's answers for metrics calls; records every command. Each world it makes has
 * the next numeric id from 77, announced as a 'cdp' event on its emitter as Chrome does.
 */
function fakeCdp(options: FakeMetricsOptions = {}) {
  const sent: { method: string; params?: Record<string, unknown>; timeoutMs?: number }[] = [];
  const emitter = new EventEmitter();
  // As the client does: the slot first, then the re-emit.
  const slot = new OwnWorldSlot(METRICS_WORLD_NAME);
  const emit = (event: { method: string; params?: Record<string, unknown> }) => {
    slot.onEvent(event);
    emitter.emit('cdp', event);
  };
  const waits: number[] = [];
  let nextWorld = 77;
  const announce = (id: number) => {
    for (const context of options.contexts?.(id) ?? [ourWorld(id)]) emit({ method: CREATED, params: { context } });
  };
  const defaults: Record<string, unknown> = {
    'Performance.enable': {},
    'Performance.getMetrics': { metrics: [{ name: 'Nodes', value: 42 }, { name: 'JSHeapUsedSize', value: 1000 }] },
    'Performance.disable': {},
    'Runtime.evaluate': { result: { value: { lcp: [], shifts: [{ value: 0.25, startTime: 10, hadRecentInput: false }], events: [] } } },
  };
  const cdp: MetricsCdp = {
    sendCommand: async (method, params, timeoutMs) => {
      sent.push({ method, params, timeoutMs });
      await options.onSend?.(method);
      const queued = options.sequence?.[method];
      const answer = queued?.length
        ? queued.shift()
        : options.answers && method in options.answers ? options.answers[method] : defaults[method];
      if (answer === 'reject') throw new Error(`Command ${method} timed out after 30s`);
      if (answer === 'error') return { error: { message: `${method} refused` } };
      if (typeof answer === 'object' && answer !== null && 'cdpError' in answer) {
        return { error: (answer as { cdpError: { code: number; message: string } }).cdpError };
      }
      if (method === 'Page.createIsolatedWorld' && answer === undefined) {
        const id = nextWorld++;
        if (options.announce === 'after') setTimeout(() => announce(id), 5);
        else if (options.announce !== 'never') announce(id);
        return { result: { executionContextId: id } };
      }
      return { result: answer };
    },
    metricsWorld: () => slot.get(),
    waitForEventMatching: (method, predicate, timeoutMs, signal) => {
      waits.push(timeoutMs);
      return waitForCdpEventMatching(emitter, method, predicate, timeoutMs, signal);
    },
  };
  return {
    cdp,
    sent,
    emitter,
    waits,
    /** Chrome announces a context outside any command, as on a navigation. */
    announce: (context: unknown) => emit({ method: CREATED, params: { context } }),
    methods: () => sent.map((x) => x.method),
    evaluates: () => sent.filter((x) => x.method === 'Runtime.evaluate').map((x) => x.params ?? {}),
  };
}

type VitalsData = { metrics: Record<string, unknown>; vitals: unknown; vitalsError?: string };

describe('readMetrics', () => {
  const always = () => true;

  it('reads the counters, then the vitals in an isolated world', async () => {
    const f = fakeCdp();
    const r = await readMetrics(f.cdp, always, 'T1');
    expect(r.success, r.error).toBe(true);
    const d = r.data as { metrics: Record<string, unknown>; vitals: Record<string, unknown> };
    expect(d.metrics.nodes).toBe(42);
    expect(d.metrics.documents).toBeNull();
    expect(d.vitals).toEqual({ lcp: null, cls: 0.25, shiftCount: 1, inp: null });
    expect(f.methods()).toEqual([
      'Performance.enable', 'Performance.getMetrics', 'Performance.disable',
      'Page.createIsolatedWorld', 'Runtime.evaluate',
    ]);
    // The page target's id is its main frame's id: no frame tree (page names and URLs) is fetched.
    expect(f.sent[3].params).toEqual({ frameId: 'T1', worldName: METRICS_WORLD_NAME });
    // A page that blocks its main thread holds createIsolatedWorld too: bounded like the probe.
    expect(f.sent[3].timeoutMs).toBe(10_000);
    const evaluate = f.sent[4];
    // The world is addressed by the unique id Chrome announced for it, never by its numeric id.
    expect(evaluate.params).toMatchObject({ uniqueContextId: 'U-77', returnByValue: true, awaitPromise: true });
    expect(evaluate.params).not.toHaveProperty('contextId');
    expect(evaluate.timeoutMs).toBe(10_000);
    // Announced before the answer, so found in the map without waiting.
    expect(f.waits).toEqual([]);
    expect(f.emitter.listenerCount('cdp') + f.emitter.listenerCount('teardown')).toBe(0);
  });

  it.each([
    ['Page.createIsolatedWorld', 'error'],
    ['Page.createIsolatedWorld', 'reject'],
    ['Page.createIsolatedWorld', { executionContextId: 'not a number' }],
  ])('never falls back to the page world: %s answering %j gives vitals null', async (method, answer) => {
    const f = fakeCdp({ answers: { [method]: answer } });
    const r = await readMetrics(f.cdp, always, 'T1');
    expect(r.success, r.error).toBe(true);
    const d = r.data as { metrics: Record<string, unknown>; vitals: unknown; vitalsError?: string };
    expect(d.metrics.nodes).toBe(42);
    expect(d.vitals).toBeNull();
    expect(d.vitalsError).toMatch(/separate JS world/);
    expect(f.methods()).not.toContain('Runtime.evaluate');
  });

  it('takes the unique id from an announcement that comes after the answer', async () => {
    const f = fakeCdp({ announce: 'after' });
    const r = await readMetrics(f.cdp, always, 'T1');
    expect((r.data as VitalsData).vitals).toEqual({ lcp: null, cls: 0.25, shiftCount: 1, inp: null });
    expect(f.evaluates()).toHaveLength(1);
    expect(f.evaluates()[0]).toMatchObject({ uniqueContextId: 'U-77' });
    expect(f.evaluates()[0]).not.toHaveProperty('contextId');
    expect(f.emitter.listenerCount('cdp') + f.emitter.listenerCount('teardown')).toBe(0);
    // Unless told otherwise, the announcement may come up to 2s after the answer.
    expect(f.waits.at(-1)).toBe(2000);
  });

  it('gives vitals null, and sends no probe, when Chrome never announces the world', async () => {
    const f = fakeCdp({ announce: 'never' });
    const started = Date.now();
    const r = await readMetrics(f.cdp, always, 'T1', { contextWaitMs: 50 });
    expect(Date.now() - started).toBeLessThan(2000);
    const d = r.data as VitalsData;
    expect(r.success).toBe(true);
    expect(d.metrics.nodes).toBe(42);
    expect(d.vitals).toBeNull();
    expect(d.vitalsError).toBe(
      'Chrome did not announce the JS world it made for the vitals, or the number it gave is held by a context that is not ours (the page may be navigating); run metrics again.'
    );
    expect(f.methods()).not.toContain('Runtime.evaluate');
    expect(f.emitter.listenerCount('cdp') + f.emitter.listenerCount('teardown')).toBe(0);
  });

  it('stops waiting, with vitals null, when the connection is torn down', async () => {
    const f = fakeCdp({
      announce: 'never',
      onSend: (m) => { if (m === 'Page.createIsolatedWorld') setTimeout(() => f.emitter.emit('teardown'), 5); },
    });
    const r = await readMetrics(f.cdp, always, 'T1', { contextWaitMs: 60_000 });
    expect((r.data as VitalsData).vitals).toBeNull();
    expect((r.data as VitalsData).vitalsError).toMatch(/did not announce/);
    expect(f.methods()).not.toContain('Runtime.evaluate');
    expect(f.emitter.listenerCount('cdp') + f.emitter.listenerCount('teardown')).toBe(0);
  });

  // Each is the only announcement with a chance to match: none is the world the command made.
  const page = { name: '', auxData: { frameId: 'T1', isDefault: true, type: 'default' } };
  const refused = /names another context/;
  const missing = /did not announce/;
  // Before the answer, a context that is not ours leaves nothing to find, so the wait for an
  // announcement times out; after it, the announcement under the number is seen and refused.
  it.each([
    ["the page's own world, with the same numeric id (the reuse hazard)", (id: number) => [ourWorld(id, page)], missing, refused],
    ['a world of another name', (id: number) => [ourWorld(id, { name: 'other-tool' })], missing, refused],
    ['our world name in another frame', (id: number) => [ourWorld(id, { auxData: { frameId: 'F2', isDefault: false, type: 'isolated' } })], refused, refused],
    ['our world name with type default', (id: number) => [ourWorld(id, { auxData: { frameId: 'T1', isDefault: false, type: 'default' } })], missing, refused],
    ['a context without auxData', (id: number) => [ourWorld(id, { auxData: undefined })], missing, refused],
    ['our world in this frame with another numeric id', (id: number) => [ourWorld(id + 100)], missing, missing],
    ['a context that is not an object', () => ['control-metrics'], missing, missing],
  ])('ignores %s: vitals null and no probe', async (_label, contexts, before, after) => {
    for (const [announce, why] of [['before', before], ['after', after]] as const) {
      const f = fakeCdp({ announce, contexts });
      const r = await readMetrics(f.cdp, always, 'T1', { contextWaitMs: 50 });
      expect((r.data as VitalsData).vitals).toBeNull();
      expect((r.data as VitalsData).vitalsError).toMatch(why);
      expect(f.evaluates()).toEqual([]);
    }
  });

  it.each([
    ['before', missing],
    ['after', refused],
  ] as const)('refuses when the page takes over the number after our world was announced %s the answer', async (announce, why) => {
    const f = fakeCdp({ announce, contexts: (id) => [ourWorld(id), ourWorld(id, { ...page, uniqueId: 'PAGE' })] });
    const r = await readMetrics(f.cdp, always, 'T1', { contextWaitMs: 50 });
    expect((r.data as VitalsData).vitalsError).toMatch(why);
    expect(f.evaluates()).toEqual([]);
  });

  it("never uses our world once Chrome announced the page's own world under its number", async () => {
    const f = fakeCdp({ announce: 'never' });
    f.announce(ourWorld(77, { uniqueId: 'OURS' }));
    f.announce(ourWorld(77, { ...page, uniqueId: 'PAGE' }));
    const r = await readMetrics(f.cdp, always, 'T1', { contextWaitMs: 50 });
    expect((r.data as VitalsData).vitals).toBeNull();
    expect((r.data as VitalsData).vitalsError).toMatch(missing);
    expect(f.evaluates()).toEqual([]);
    expect(f.waits).toEqual([50]);
  });

  it("does not take the page's own world announced under the number the answer gives", async () => {
    const f = fakeCdp({ announce: 'never' });
    f.announce(ourWorld(77, { ...page, uniqueId: 'PAGE' }));
    const r = await readMetrics(f.cdp, always, 'T1', { contextWaitMs: 50 });
    expect((r.data as VitalsData).vitals).toBeNull();
    expect(f.evaluates()).toEqual([]);
  });

  it('uses the world Chrome rebuilt and announced on navigation, when the answer brings no announcement', async () => {
    // Measured in headless Chrome: after a same-process navigation the world is announced with the
    // new document, and createIsolatedWorld then answers with its id and announces nothing.
    const f = fakeCdp({ announce: 'never' });
    f.announce(ourWorld(77, { uniqueId: 'REBUILT' }));
    const r = await readMetrics(f.cdp, always, 'T1', { contextWaitMs: 50 });
    expect((r.data as VitalsData).vitals).toEqual({ lcp: null, cls: 0.25, shiftCount: 1, inp: null });
    expect(f.evaluates()).toEqual([expect.objectContaining({ uniqueContextId: 'REBUILT' })]);
    expect(f.evaluates()[0]).not.toHaveProperty('contextId');
    expect(f.waits).toEqual([]);
  });

  it.each(['before', 'after'] as const)('picks our world out of others announced %s the answer', async (announce) => {
    const evil = { uniqueId: 'EVIL' };
    const f = fakeCdp({
      announce,
      contexts: (id) => [
        ourWorld(id, { ...page, ...evil }),
        ourWorld(id, { name: 'other-tool', ...evil }),
        ourWorld(id, { auxData: { frameId: 'F2', isDefault: false, type: 'isolated' }, ...evil }),
        ourWorld(id + 100, evil),
        ourWorld(id),
      ],
    });
    const r = await readMetrics(f.cdp, always, 'T1');
    expect((r.data as VitalsData).vitals).not.toBeNull();
    expect(f.evaluates()).toEqual([expect.objectContaining({ uniqueContextId: 'U-77' })]);
  });

  it.each([
    ['missing', undefined],
    ['not a string', 77],
    ['empty', ''],
    ['10k characters', 'u'.repeat(10_000)],
  ])('gives vitals null, in our own words, when the unique id is %s', async (_label, uniqueId) => {
    // The map skips such a context: announced before the answer it is a miss, after it a refusal.
    for (const [announce, why] of [['before', /did not announce/], ['after', /no usable id/]] as const) {
      const f = fakeCdp({ announce, contexts: (id) => [ourWorld(id, { uniqueId })] });
      const r = await readMetrics(f.cdp, always, 'T1', { contextWaitMs: 50 });
      const d = r.data as VitalsData;
      expect(d.vitals).toBeNull();
      expect(d.vitalsError).toMatch(why);
      expect(d.vitalsError!.length).toBeLessThan(200);
      expect(f.evaluates()).toEqual([]);
    }
  });


  it('accepts a unique id of 200 characters', async () => {
    const f = fakeCdp({ contexts: (id) => [ourWorld(id, { uniqueId: 'u'.repeat(200) })] });
    await readMetrics(f.cdp, always, 'T1');
    expect(f.evaluates()).toEqual([expect.objectContaining({ uniqueContextId: 'u'.repeat(200) })]);
  });

  it('names its world with a nonce of this process: stable across calls, new in a fresh module', async () => {
    expect(METRICS_WORLD_NAME).toMatch(/^control-metrics-[0-9a-f]{12}$/);
    expect(METRICS_WORLD_NAME.length).toBeLessThanOrEqual(64);
    const f = fakeCdp();
    await readMetrics(f.cdp, always, 'T1');
    await readMetrics(f.cdp, always, 'T1');
    const names = f.sent.filter((x) => x.method === 'Page.createIsolatedWorld').map((x) => x.params?.worldName);
    expect(names).toEqual([METRICS_WORLD_NAME, METRICS_WORLD_NAME]);
    vi.resetModules();
    const fresh = await import('./chrome-metrics.js');
    expect(fresh.METRICS_WORLD_NAME).toMatch(/^control-metrics-[0-9a-f]{12}$/);
    expect(fresh.METRICS_WORLD_NAME).not.toBe(METRICS_WORLD_NAME);
  });

  it.each([
    ["the plain name another tool or an extension could use", { name: 'control-metrics' }],
    ['our nonce name with type default', { auxData: { frameId: 'T1', isDefault: true, type: 'default' } }],
  ])('refuses an isolated context with %s', async (_label, extra) => {
    // Before the answer it is never kept, so nothing is found; after it, it is seen and refused.
    for (const [announce, why] of [['before', /did not announce/], ['after', /names another context/]] as const) {
      const f = fakeCdp({ announce, contexts: (id) => [ourWorld(id, extra)] });
      const r = await readMetrics(f.cdp, always, 'T1', { contextWaitMs: 50 });
      expect((r.data as VitalsData).vitals).toBeNull();
      expect((r.data as VitalsData).vitalsError).toMatch(why);
      expect(f.evaluates()).toEqual([]);
    }
  });

  it.each([
    [-32000, 'Cannot find context with specified id'],
    [-32602, 'uniqueContextId not found'],
  ])('says the page navigated when the probe finds its world gone (%d %s)', async (code, message) => {
    const f = fakeCdp({ answers: { 'Runtime.evaluate': { cdpError: { code, message } } } });
    const r = await readMetrics(f.cdp, always, 'T1');
    expect((r.data as VitalsData).vitals).toBeNull();
    expect((r.data as VitalsData).vitalsError).toBe('The page navigated while measuring the vitals; run metrics again.');
  });

  it.each([
    [-32000, 'Execution was terminated'],
    [-32602, 'Cannot find context with specified id'],
    [-32000, 'uniqueContextId not found'],
  ])('keeps the refusal text for any other error (%d %s)', async (code, message) => {
    const f = fakeCdp({ answers: { 'Runtime.evaluate': { cdpError: { code, message } } } });
    const r = await readMetrics(f.cdp, always, 'T1');
    expect((r.data as VitalsData).vitalsError).toBe('Chrome refused to run the vitals probe.');
  });

  it('gives vitals null, and sends no probe, without a target id to make the world in', async () => {
    const f = fakeCdp();
    const r = await readMetrics(f.cdp, always, undefined);
    expect(r.success, r.error).toBe(true);
    expect((r.data as { vitals: unknown }).vitals).toBeNull();
    expect((r.data as { vitalsError?: string }).vitalsError).toMatch(/separate JS world/);
    expect(f.methods()).not.toContain('Runtime.evaluate');
    expect(f.methods()).not.toContain('Page.createIsolatedWorld');
  });

  it("gives vitals null and our own reason when the probe throws, without the page's text", async () => {
    const f = fakeCdp({
      answers: { 'Runtime.evaluate': { exceptionDetails: { text: 'page secret text', exception: { description: 'page secret text' } } } },
    });
    const r = await readMetrics(f.cdp, always, 'T1');
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
    const r = await readMetrics(f.cdp, always, 'T1');
    expect((r.data as { vitals: unknown }).vitals).toEqual({ lcp: null, cls: 0, shiftCount: 0, inp: null });
  });

  it.each(['reject', 'error'])('sends Performance.disable even when enable gets %s', async (answer) => {
    const f = fakeCdp({ answers: { 'Performance.enable': answer } });
    const r = await readMetrics(f.cdp, always, 'T1');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^Could not read Chrome's metrics: /);
    expect(f.methods()).toEqual(['Performance.enable', 'Performance.disable']);
  });

  it("fails with Chrome's message when getMetrics is refused, and still disables", async () => {
    const f = fakeCdp({ answers: { 'Performance.getMetrics': 'error' } });
    const r = await readMetrics(f.cdp, always, 'T1');
    expect(r).toEqual({ success: false, error: "Could not read Chrome's metrics: Performance.getMetrics refused" });
    expect(f.methods()).toContain('Performance.disable');
  });

  it('ignores a failed disable', async () => {
    const f = fakeCdp({ answers: { 'Performance.disable': 'reject' } });
    expect((await readMetrics(f.cdp, always, 'T1')).success).toBe(true);
  });

  it.each(['Performance.disable', 'Runtime.evaluate'])(
    'refuses to mix tabs: a tab switch at %s gives an error, never data',
    async (at) => {
      let selected = true;
      const f = fakeCdp({ onSend: (m) => { if (m === at) selected = false; } });
      const r = await readMetrics(f.cdp, () => selected, 'T1');
      expect(r).toEqual({ success: false, error: TAB_CHANGED });
      // Once the tab changed, nothing more is sent: the probe never runs in the new tab.
      expect(f.methods().slice(f.methods().indexOf(at) + 1)).toEqual([]);
    }
  );

  it('sends nothing when the tab already changed before it started', async () => {
    const f = fakeCdp();
    expect(await readMetrics(f.cdp, () => false, 'T1')).toEqual({ success: false, error: TAB_CHANGED });
    expect(f.sent).toEqual([]);
  });
});

describe('createMetricsReader', () => {
  const perf = (methods: string[]) => methods.filter((m) => m.startsWith('Performance.'));

  it('runs overlapping calls one at a time, so one never disables the other mid-read', async () => {
    const f = fakeCdp({ onSend: () => new Promise((r) => setTimeout(r, 5)) });
    const read = createMetricsReader();
    const [a, b] = await Promise.all([read(f.cdp, () => true, 'T1'), read(f.cdp, () => true, 'T1')]);
    expect(a.success && b.success).toBe(true);
    expect(perf(f.methods())).toEqual([
      'Performance.enable', 'Performance.getMetrics', 'Performance.disable',
      'Performance.enable', 'Performance.getMetrics', 'Performance.disable',
    ]);
  });

  it('does not let a call that throws block the next one', async () => {
    const f = fakeCdp();
    const read = createMetricsReader();
    const first = read(f.cdp, () => { throw new Error('boom'); }, 'T1');
    const second = read(f.cdp, () => true, 'T1');
    await expect(first).rejects.toThrow('boom');
    expect((await second).success).toBe(true);
  });
});
