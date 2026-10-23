import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { analyzeTrace, type AnalyzeOptions, type TraceEvent } from './chrome-trace.js';

const MAIN = { pid: 1, tid: 10 };

const threadName = (pid: number, tid: number, name: string): TraceEvent => ({
  name: 'thread_name',
  ph: 'M',
  ts: 0,
  pid,
  tid,
  args: { name },
});

/** Complete event; ts and dur in milliseconds for readability. */
const ev = (
  name: string,
  tsMs: number,
  durMs: number,
  at: { pid: number; tid: number } = MAIN
): TraceEvent => ({
  name,
  cat: 'disabled-by-default-devtools.timeline',
  ph: 'X',
  ts: tsMs * 1000,
  dur: durMs * 1000,
  ...at,
});

const withMain = (...events: TraceEvent[]): TraceEvent[] => [
  threadName(MAIN.pid, MAIN.tid, 'CrRendererMain'),
  ...events,
];

describe('analyzeTrace: long tasks', () => {
  it('returns zeros for an empty trace', () => {
    const s = analyzeTrace([]);
    expect(s.longTasks).toEqual([]);
    expect(s.busyPct).toBe(0);
    expect(s.windowMs).toBe(0);
    expect(s.mainThread).toBeNull();
  });

  it('reports a 120ms task as exactly one long task of 120ms', () => {
    const s = analyzeTrace(withMain(ev('RunTask', 100, 120)));
    expect(s.mainThread).toEqual(MAIN);
    expect(s.longTasks).toEqual([{ startMs: 0, durationMs: 120 }]);
  });

  it('does not report a 49ms task', () => {
    expect(analyzeTrace(withMain(ev('RunTask', 0, 49))).longTasks).toEqual([]);
  });

  it('reports 51ms but not exactly 50ms (long means longer than 50ms)', () => {
    expect(analyzeTrace(withMain(ev('RunTask', 0, 51))).longTasks).toHaveLength(1);
    expect(analyzeTrace(withMain(ev('RunTask', 0, 50))).longTasks).toEqual([]);
  });

  it('ignores long tasks on threads that are not the renderer main thread', () => {
    const compositor = { pid: 1, tid: 11 };
    const s = analyzeTrace([
      threadName(MAIN.pid, MAIN.tid, 'CrRendererMain'),
      threadName(compositor.pid, compositor.tid, 'Compositor'),
      ev('RunTask', 0, 10),
      ev('RunTask', 0, 200, compositor),
    ]);
    expect(s.longTasks).toEqual([]);
  });

  it('picks the busiest CrRendererMain when there are several', () => {
    const other = { pid: 2, tid: 20 };
    const s = analyzeTrace([
      threadName(MAIN.pid, MAIN.tid, 'CrRendererMain'),
      threadName(other.pid, other.tid, 'CrRendererMain'),
      ev('RunTask', 0, 10),
      ev('RunTask', 0, 80, other),
    ]);
    expect(s.mainThread).toEqual(other);
    expect(s.longTasks).toEqual([{ startMs: 0, durationMs: 80 }]);
  });
});

describe('analyzeTrace: real-trace shapes', () => {
  it('handles a trace with hundreds of thousands of events', () => {
    // Real DevTools exports reach 200k-1M events. Spreading that many into
    // Math.min/Math.max throws RangeError: plain node fails past ~100k, and
    // under vitest past ~300k-600k (measured), so this size fails either way.
    const events: TraceEvent[] = [threadName(MAIN.pid, MAIN.tid, 'CrRendererMain')];
    for (let i = 0; i < 700_000; i++) events.push(ev('RunTask', i, 0.5));
    events.push(ev('RunTask', 800_000, 120));
    const s = analyzeTrace(events);
    expect(s.longTasks).toEqual([{ startMs: 800_000, durationMs: 120 }]);
  });

  it('reports a RunTask nested inside another RunTask once', () => {
    // Nested message loops put a task inside a task: one long task, not two.
    const s = analyzeTrace(withMain(ev('RunTask', 0, 200), ev('RunTask', 50, 100)));
    expect(s.longTasks).toEqual([{ startMs: 0, durationMs: 200 }]);
  });

  it('gives a null main thread and no long tasks when no CrRendererMain is named', () => {
    const s = analyzeTrace([ev('RunTask', 0, 200)]);
    expect(s.mainThread).toBeNull();
    expect(s.longTasks).toEqual([]);
  });

  it('counts an event outside any task in its category, so categories can exceed busy time', () => {
    const s = analyzeTrace(withMain(ev('RunTask', 0, 10), ev('Layout', 20, 5)));
    expect(s.categoryMs.layout).toBeCloseTo(5, 5);
    expect(s.busyPct).toBeCloseTo((10 / 25) * 100, 5);
  });
});

describe('analyzeTrace: busy percentage', () => {
  it('is the share of the trace window the main thread spent in tasks', () => {
    // Window runs from 0 to 1000ms; two 100ms tasks -> 20%.
    const s = analyzeTrace(withMain(ev('RunTask', 0, 100), ev('RunTask', 900, 100)));
    expect(s.windowMs).toBe(1000);
    expect(s.busyPct).toBeCloseTo(20, 5);
  });

  it('counts overlapping tasks once', () => {
    const s = analyzeTrace(
      withMain(ev('RunTask', 0, 100), ev('RunTask', 50, 100), ev('RunTask', 900, 100))
    );
    // Union: 0-150 and 900-1000 = 250ms of 1000ms.
    expect(s.busyPct).toBeCloseTo(25, 5);
  });
});

describe('analyzeTrace: time by category (self time)', () => {
  it('splits a nested task into scripting, layout and other without double counting', () => {
    // RunTask 100ms > FunctionCall 60ms > Layout 20ms
    // self: other 40, scripting 40, layout 20. Total 100.
    const s = analyzeTrace(
      withMain(ev('RunTask', 0, 100), ev('FunctionCall', 10, 60), ev('Layout', 20, 20))
    );
    expect(s.categoryMs.other).toBeCloseTo(40, 5);
    expect(s.categoryMs.scripting).toBeCloseTo(40, 5);
    expect(s.categoryMs.layout).toBeCloseTo(20, 5);
    const total = Object.values(s.categoryMs).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(100, 5);
  });

  it('classifies paint and gc events', () => {
    const s = analyzeTrace(
      withMain(
        ev('RunTask', 0, 100),
        ev('Paint', 0, 30),
        ev('MajorGC', 40, 25),
        ev('UpdateLayoutTree', 70, 10)
      )
    );
    expect(s.categoryMs.paint).toBeCloseTo(30, 5);
    expect(s.categoryMs.gc).toBeCloseTo(25, 5);
    expect(s.categoryMs.layout).toBeCloseTo(10, 5);
    expect(s.categoryMs.other).toBeCloseTo(35, 5);
  });
});

describe('analyzeTrace: frames', () => {
  const COMPOSITOR = { pid: 1, tid: 12 };

  /** DrawFrame instant event on a compositor, ts in milliseconds. */
  const draw = (tsMs: number, layerTreeId = 2): TraceEvent => ({
    name: 'DrawFrame',
    cat: 'disabled-by-default-devtools.timeline.frame',
    ph: 'I',
    ts: tsMs * 1000,
    ...COMPOSITOR,
    args: { layerTreeId, frameSeqId: Math.round(tsMs) },
  });

  /** Draws separated by the given gaps (ms), starting at t=1000. */
  const drawsWithGaps = (gaps: number[], layerTreeId = 2): TraceEvent[] => {
    const out = [draw(1000, layerTreeId)];
    let t = 1000;
    for (const g of gaps) {
      t += g;
      out.push(draw(t, layerTreeId));
    }
    return out;
  };

  const V = 1000 / 60;

  it('reports 60 steady frames as about 60fps with nothing slow or dropped', () => {
    const f = analyzeTrace(drawsWithGaps(Array(59).fill(V))).frames;
    expect(f.count).toBe(60);
    expect(f.fps).toBeCloseTo(60, 1);
    expect(f.p50Ms).toBeCloseTo(V, 3);
    expect(f.slow).toBe(0);
    expect(f.dropped).toBe(0);
  });

  it('counts five 50ms gaps as 5 slow frames and 10 dropped vsync slots', () => {
    const f = analyzeTrace(drawsWithGaps([...Array(55).fill(V), ...Array(5).fill(50)])).frames;
    expect(f.slow).toBe(5);
    expect(f.dropped).toBe(10); // round(50 / 16.67) = 3 slots, 2 missed, five times
    expect(f.p50Ms).toBeCloseTo(V, 3);
    expect(f.p99Ms).toBeCloseTo(50, 3);
    expect(f.maxMs).toBeCloseTo(50, 3);
  });

  it('uses nearest-rank percentiles', () => {
    // 100 gaps: 94 x 10ms, 6 x 100ms. Rank 95 of 100 is the first 100ms gap.
    const f = analyzeTrace(drawsWithGaps([...Array(94).fill(10), ...Array(6).fill(100)])).frames;
    expect(f.p50Ms).toBe(10);
    expect(f.p95Ms).toBe(100);
  });

  it('does not round a percentile up past its rank', () => {
    // 100 gaps: 95 x 10ms, 5 x 100ms. Rank 95 is the last 10ms gap. Together
    // with the test above this pins the rank from both sides.
    const f = analyzeTrace(drawsWithGaps([...Array(95).fill(10), ...Array(5).fill(100)])).frames;
    expect(f.p95Ms).toBe(10);
    expect(f.p99Ms).toBe(100);
  });

  it.each([0, -1, NaN, Infinity])('rejects a frame budget of %s', (frameBudgetMs) => {
    expect(() => analyzeTrace(drawsWithGaps([16, 16]), { frameBudgetMs })).toThrow(RangeError);
  });

  it('gives null percentiles and 0 fps for under two draws', () => {
    expect(analyzeTrace([]).frames).toMatchObject({ count: 0, fps: 0, p50Ms: null, slow: 0 });
    expect(analyzeTrace([draw(1000)]).frames).toMatchObject({ count: 1, fps: 0, p50Ms: null });
  });

  it('measures only the compositor with the most draws', () => {
    const noise = drawsWithGaps([200, 200], 7); // another layer tree, 3 draws
    const f = analyzeTrace([...noise, ...drawsWithGaps(Array(9).fill(V), 2)]).frames;
    expect(f.count).toBe(10);
    expect(f.slow).toBe(0);
  });

  it('judges slow frames against the frame budget it is given', () => {
    const gaps = Array(20).fill(25); // 25ms gaps: fine at 60Hz, slow at 120Hz
    expect(analyzeTrace(drawsWithGaps(gaps)).frames.slow).toBe(0);
    const f = analyzeTrace(drawsWithGaps(gaps), { frameBudgetMs: 1000 / 120 }).frames;
    expect(f.slow).toBe(20);
    expect(f.dropped).toBe(40); // round(25 / 8.33) = 3 slots, 2 missed, twenty times
  });

  it('rounds a gap to the nearest vsync slot when counting dropped frames', () => {
    // 45ms is 2.7 slots at 60Hz: it lands on slot 3, so two were missed.
    expect(analyzeTrace(drawsWithGaps([45])).frames.dropped).toBe(2);
    // 40ms is 2.4 slots: it lands on slot 2, so one was missed.
    expect(analyzeTrace(drawsWithGaps([40])).frames.dropped).toBe(1);
  });

  it('sorts draws by time before measuring gaps', () => {
    const shuffled = drawsWithGaps(Array(9).fill(V)).reverse();
    const f = analyzeTrace(shuffled).frames;
    expect(f.slow).toBe(0);
    expect(f.p50Ms).toBeCloseTo(V, 3);
  });

  describe('against a real Chrome trace', () => {
    // Frame events cut from a headless Chrome trace of a page that stalls
    // the main thread for 120ms every 20 animation frames (3s, 138 frames).
    const events = (
      JSON.parse(
        readFileSync(new URL('./__fixtures__/frames-real.json', import.meta.url), 'utf8')
      ) as { traceEvents: TraceEvent[] }
    ).traceEvents;

    it('finds the seven 120ms stalls', () => {
      const f = analyzeTrace(events).frames;
      expect(f.count).toBe(138);
      expect(f.slow).toBe(7);
      expect(f.p50Ms).toBeGreaterThan(16);
      expect(f.p50Ms).toBeLessThan(17.5);
      expect(f.maxMs).toBeGreaterThan(119);
      expect(f.maxMs).toBeLessThan(121.5);
    });

    it('agrees with Chrome on a page whose stalls stop the compositor too', () => {
      // True here only because each 120ms stall also skips every draw. It is
      // not general: see the DevTools trace below, where the two disagree.
      const f = analyzeTrace(events).frames;
      expect(f.chromeDropped).toBe(events.filter((e) => e.name === 'DroppedFrame').length);
      expect(f.chromeDropped).toBeGreaterThan(0);
      expect(f.dropped).toBe(f.chromeDropped);
    });
  });
});

describe('analyzeTrace: frames Chrome logged as dropped', () => {
  const drawAt = (tsMs: number, seq: number, layerTreeId = 2): TraceEvent => ({
    name: 'DrawFrame',
    cat: 'disabled-by-default-devtools.timeline.frame',
    ph: 'I',
    ts: tsMs * 1000,
    pid: 1,
    tid: 12,
    args: { layerTreeId, frameSeqId: seq },
  });
  const dropAt = (tsMs: number, seq: number, layerTreeId = 2): TraceEvent => ({
    name: 'DroppedFrame',
    cat: 'disabled-by-default-devtools.timeline.frame',
    ph: 'I',
    ts: tsMs * 1000,
    pid: 1,
    tid: 12,
    args: { layerTreeId, frameSeqId: seq, hasPartialUpdate: true },
  });

  it('counts DroppedFrame events and how many were drawn anyway', () => {
    const f = analyzeTrace([
      drawAt(1000, 1),
      drawAt(1016.7, 2),
      drawAt(1033.4, 3),
      drawAt(1050.1, 4),
      dropAt(1016.7, 2), // seq 2 also has a DrawFrame: drawn anyway
      dropAt(1033.4, 3), // drawn anyway
      dropAt(1040, 99), // seq 99 never drawn
    ]).frames;
    expect(f.chromeDropped).toBe(3);
    expect(f.chromeDroppedDrawn).toBe(2);
  });

  it('ignores DroppedFrame events from other compositors', () => {
    const f = analyzeTrace([
      drawAt(1000, 1),
      drawAt(1016.7, 2),
      dropAt(1016.7, 2),
      dropAt(1016.7, 2, 7), // another layer tree
    ]).frames;
    expect(f.chromeDropped).toBe(1);
  });

  it('does not match a drop and a draw that both lack a frameSeqId', () => {
    const noSeq = (name: string, tsMs: number): TraceEvent => ({
      name,
      ph: 'I',
      ts: tsMs * 1000,
      pid: 1,
      tid: 12,
      args: { layerTreeId: 2 },
    });
    const f = analyzeTrace([noSeq('DrawFrame', 1000), noSeq('DrawFrame', 1016), noSeq('DroppedFrame', 1010)]).frames;
    expect(f.chromeDropped).toBe(1);
    expect(f.chromeDroppedDrawn).toBe(0);
  });

  it('counts only instant DrawFrame events, not async begin/end pairs', () => {
    // Older Chromium emitted DrawFrame as async 'b'/'e'; counting both would double the frames.
    const async = (ph: string, tsMs: number): TraceEvent => ({ ...drawAt(tsMs, 1), ph });
    const f = analyzeTrace([
      drawAt(1000, 1),
      drawAt(1016.7, 2),
      async('b', 1020),
      async('e', 1021),
      { ...dropAt(1016.7, 2), ph: 'b' },
    ]).frames;
    expect(f.count).toBe(2);
    expect(f.chromeDropped).toBe(0);
  });

  it('reports drops even when there are fewer than two draws', () => {
    const f = analyzeTrace([drawAt(1000, 1), dropAt(1005, 5)]).frames;
    expect(f.count).toBe(1);
    expect(f.chromeDropped).toBe(1);
  });

  describe('against a real DevTools Performance trace', () => {
    // Frame events only, cut from an 11s scroll recording of a WebGPU page.
    // DrawFrame events ran at ~59fps, yet Chrome logged 87 DroppedFrame events,
    // 77 sharing a frameSeqId with a DrawFrame: gap-based numbers alone would
    // call this page smooth.
    const events = (
      JSON.parse(
        readFileSync(new URL('./__fixtures__/frames-devtools.json', import.meta.url), 'utf8')
      ) as { traceEvents: TraceEvent[] }
    ).traceEvents;

    it('sees the drops that the draw gaps cannot', () => {
      const f = analyzeTrace(events).frames;
      expect(f.count).toBe(655);
      expect(f.fps).toBeGreaterThan(58);
      expect(f.slow).toBe(3);
      expect(f.dropped).toBe(12); // gap-derived: looks nearly clean
      expect(f.chromeDropped).toBe(87);
      expect(f.chromeDroppedDrawn).toBe(77);
    });
  });
});


describe('analyzeTrace: vitals', () => {
  const shift = (tsMs: number, score: unknown, data: Record<string, unknown> = {}): TraceEvent => ({
    name: 'LayoutShift', ph: 'I', ts: tsMs * 1000, ...MAIN,
    args: { frame: 'main', data: { score, had_recent_input: false, is_main_frame: true, ...data } },
  });
  const navigation = (tsMs: number, frame = 'main', navigationId?: string): TraceEvent => ({
    name: 'navigationStart', ph: 'R', ts: tsMs * 1000, ...MAIN,
    args: navigationId === undefined ? { frame } : { frame, data: { navigationId } },
  });
  const candidate = (tsMs: number, data: Record<string, unknown> = {}, frame = 'main'): TraceEvent => ({
    name: 'largestContentfulPaint::Candidate', ph: 'R', ts: tsMs * 1000, ...MAIN,
    args: { frame, data: { isOutermostMainFrame: true, type: 'text', nodeName: 'P', size: 200, ...data } },
  });

  it('returns empty vitals without shifts or LCP candidates', () => {
    expect(analyzeTrace([]).vitals).toEqual({ lcp: null, cls: 0, shiftCount: 0, shifts: [] });
    expect(analyzeTrace(withMain(ev('RunTask', 100, 60))).vitals).toEqual({
      lcp: null, cls: 0, shiftCount: 0, shifts: [],
    });
  });

  it('sums nearby shifts and lists the largest score first', () => {
    const v = analyzeTrace([shift(200, 0.05), shift(100, 0.1)]).vitals;
    expect(v.cls).toBeCloseTo(0.15);
    expect(v.shiftCount).toBe(2);
    expect(v.shifts).toEqual([{ atMs: 0, score: 0.1 }, { atMs: 100, score: 0.05 }]);
  });

  it('excludes shifts caused by recent input, including from session gaps', () => {
    const v = analyzeTrace([
      shift(0, 0.1), shift(900, 0.9, { had_recent_input: true }), shift(1800, 0.2),
    ]).vitals;
    expect(v.cls).toBeCloseTo(0.2);
    expect(v.shiftCount).toBe(2);
    expect(v.shifts).toEqual([{ atMs: 1800, score: 0.2 }, { atMs: 0, score: 0.1 }]);
  });

  it.each([NaN, Infinity, -Infinity, '0.5', undefined, null])('ignores non-finite or non-numeric score %s', (score) => {
    const v = analyzeTrace([shift(0, score), shift(100, 0.1)]).vitals;
    expect(v.cls).toBeCloseTo(0.1);
    expect(v.shiftCount).toBe(1);
    expect(v.shifts).toEqual([{ atMs: 0, score: 0.1 }]);
  });

  it('includes layout shifts from subframes', () => {
    const subframe = shift(100, 0.2, { is_main_frame: false });
    subframe.args!.frame = 'child';
    const v = analyzeTrace([shift(0, 0.1), subframe]).vitals;
    expect(v.cls).toBeCloseTo(0.3);
    expect(v.shiftCount).toBe(2);
  });

  it('takes the largest session rather than summing sessions separated by over one second', () => {
    expect(analyzeTrace([shift(1500, 0.3), shift(0, 0.2)]).vitals.cls).toBeCloseTo(0.3);
    expect(analyzeTrace([shift(0, 0.3), shift(1500, 0.2)]).vitals.cls).toBeCloseTo(0.3);
  });

  it('starts a new session at a gap of exactly one second (web-vitals: gap under 1000ms stays)', () => {
    expect(analyzeTrace([shift(0, 0.2), shift(1000, 0.3)]).vitals.cls).toBeCloseTo(0.3);
  });

  it('keeps a gap just under one second in the same session', () => {
    expect(analyzeTrace([shift(0, 0.2), shift(999, 0.3)]).vitals.cls).toBeCloseTo(0.5);
  });

  it('caps a session at five seconds despite smaller gaps', () => {
    const events = [0, 900, 1800, 2700, 3600, 4500, 5400].map((t) => shift(t, 0.1));
    expect(analyzeTrace(events).vitals.cls).toBeCloseTo(0.6);
  });

  it('starts a new session at exactly five seconds from the first shift', () => {
    // Every gap is under one second, so only the five-second rule can split this.
    const events = [0, 800, 1600, 2400, 3200, 4000, 4800, 5000].map((t) => shift(t, 0.1));
    expect(analyzeTrace(events).vitals.cls).toBeCloseTo(0.7);
  });

  it('keeps a shift 4999ms after the first in the same session', () => {
    const events = [0, 800, 1600, 2400, 3200, 4000, 4800, 4999].map((t) => shift(t, 0.1));
    expect(analyzeTrace(events).vitals.cls).toBeCloseTo(0.8);
  });

  it('lists only the ten largest shifts but counts all shifts', () => {
    const events = Array.from({ length: 12 }, (_, i) => shift(i * 10, (i + 1) / 100));
    const v = analyzeTrace(events).vitals;
    expect(v.shiftCount).toBe(12);
    expect(v.cls).toBeCloseTo(0.78);
    expect(v.shifts).toEqual(Array.from({ length: 10 }, (_, i) => ({
      atMs: (11 - i) * 10, score: (12 - i) / 100,
    })));
  });

  it('shares the long-task time origin, including timed events outside the main thread', () => {
    const s = analyzeTrace(withMain(
      ev('Paint', 50, 10, { pid: 2, tid: 20 }), ev('RunTask', 100, 60), shift(150, 0.1),
    ));
    expect(s.longTasks).toEqual([{ startMs: 50, durationMs: 60 }]);
    expect(s.vitals.shifts).toEqual([{ atMs: 100, score: 0.1 }]);
  });

  it('uses the earliest counted shift as origin without timed events', () => {
    expect(analyzeTrace([navigation(100), shift(1000, 0.1)]).vitals.shifts).toEqual([
      { atMs: 0, score: 0.1 },
    ]);
  });

  it('measures LCP from navigationStart and passes through candidate details', () => {
    const v = analyzeTrace([navigation(1000), candidate(1051.032, { size: 23828 })]).vitals;
    expect(v.lcp?.ms).toBeCloseTo(51.032, 3);
    expect(v.lcp).toMatchObject({ type: 'text', nodeName: 'P', size: 23828 });
  });

  it('uses the last candidate by timestamp rather than input order or size', () => {
    const v = analyzeTrace([
      candidate(120, { type: 'image', nodeName: 'IMG', size: 100 }),
      navigation(100), candidate(110, { size: 1000 }),
    ]).vitals;
    expect(v.lcp).toEqual({ ms: 20, type: 'image', nodeName: 'IMG', size: 100 });
  });

  it('ignores candidates explicitly outside the outermost main frame', () => {
    const v = analyzeTrace([
      navigation(100), candidate(110), candidate(120, { isOutermostMainFrame: false, isMainFrame: true }),
    ]).vitals;
    expect(v.lcp?.ms).toBe(10);
  });

  it('falls back to isMainFrame only when isOutermostMainFrame is absent', () => {
    const fallback = candidate(120, { isMainFrame: true });
    delete (fallback.args!.data as Record<string, unknown>).isOutermostMainFrame;
    const v = analyzeTrace([navigation(100), candidate(110), fallback]).vitals;
    expect(v.lcp?.ms).toBe(20);
    const noMain = candidate(130, { isMainFrame: false });
    delete (noMain.args!.data as Record<string, unknown>).isOutermostMainFrame;
    expect(analyzeTrace([navigation(100), noMain]).vitals.lcp).toBeNull();
  });

  it('uses the latest preceding navigation on the same frame', () => {
    const v = analyzeTrace([
      navigation(130), navigation(100), candidate(120), navigation(115, 'child'), navigation(110),
    ]).vitals;
    expect(v.lcp?.ms).toBe(10);
  });

  it('matches navigationStart by navigationId when the candidate has one', () => {
    // Navigation A started at 0 and is still painting after navigation B began at 100.
    const v = analyzeTrace([
      navigation(0, 'main', 'A'), navigation(100, 'main', 'B'), candidate(120, { navigationId: 'A' }),
    ]).vitals;
    expect(v.lcp?.ms).toBe(120);
  });

  it('gives null when the candidate names a navigation that has no navigationStart', () => {
    expect(analyzeTrace([
      navigation(100, 'main', 'B'), candidate(120, { navigationId: 'A' }),
    ]).vitals.lcp).toBeNull();
    // A navigationStart without an id cannot be matched to a candidate that has one.
    expect(analyzeTrace([navigation(100), candidate(120, { navigationId: 'A' })]).vitals.lcp).toBeNull();
  });

  it('does not match a navigationId from another frame', () => {
    expect(analyzeTrace([
      navigation(100, 'child', 'A'), candidate(120, { navigationId: 'A' }),
    ]).vitals.lcp).toBeNull();
  });

  it('breaks a candidate timestamp tie with the higher candidateIndex', () => {
    const first = candidate(120, { candidateIndex: 1, size: 10 });
    const second = candidate(120, { candidateIndex: 2, size: 20 });
    expect(analyzeTrace([navigation(100), second, first]).vitals.lcp?.size).toBe(20);
    expect(analyzeTrace([navigation(100), first, second]).vitals.lcp?.size).toBe(20);
  });

  it('ignores a non-finite candidateIndex when breaking a tie', () => {
    const bad = candidate(120, { candidateIndex: NaN, size: 10 });
    const good = candidate(120, { candidateIndex: 1, size: 20 });
    expect(analyzeTrace([navigation(100), bad, good]).vitals.lcp?.size).toBe(20);
  });

  it('accepts a navigation at the exact candidate timestamp', () => {
    expect(analyzeTrace([candidate(120), navigation(120)]).vitals.lcp?.ms).toBe(0);
  });

  it.each([
    { navigations: [] },
    { navigations: [navigation(130)] },
    { navigations: [navigation(100, 'child')] },
    { navigations: [{ ...navigation(100), ph: 'I' }] },
  ])('returns null without a usable navigationStart ($navigations)', ({ navigations }) => {
    expect(analyzeTrace([...navigations, candidate(120)]).vitals.lcp).toBeNull();
  });

  it('does not reuse an earlier candidate when the last candidate has no navigation', () => {
    expect(analyzeTrace([
      navigation(100), candidate(110), candidate(120, {}, 'child'),
    ]).vitals.lcp).toBeNull();
  });

  it('defaults missing candidate details without discarding the candidate', () => {
    const v = analyzeTrace([
      navigation(100), candidate(120, { size: '200', type: undefined, nodeName: undefined }),
    ]).vitals;
    expect(v.lcp).toEqual({ ms: 20, size: 0, type: '', nodeName: '' });
  });

  it('accepts both instant shift phases and ignores async shift events', () => {
    const v = analyzeTrace([
      shift(0, 0.1), { ...shift(100, 0.2), ph: 'i' }, { ...shift(200, 0.9), ph: 'b' },
    ]).vitals;
    expect(v.cls).toBeCloseTo(0.3);
    expect(v.shiftCount).toBe(2);
  });

  it.each(['R', 'I', 'i'])('accepts LCP candidate phase %s', (ph) => {
    expect(analyzeTrace([navigation(100), { ...candidate(120), ph }]).vitals.lcp?.ms).toBe(20);
  });

  it('ignores async LCP candidates', () => {
    const v = analyzeTrace([navigation(100), candidate(110), { ...candidate(120), ph: 'b' }]).vitals;
    expect(v.lcp?.ms).toBe(10);
  });

  it('agrees with a real Chrome trace on CLS and LCP', () => {
    const events = (JSON.parse(readFileSync(
      new URL('./__fixtures__/vitals-real.json', import.meta.url), 'utf8'
    )) as { traceEvents: TraceEvent[] }).traceEvents;
    const v = analyzeTrace(events).vitals;
    expect(v.cls).toBeCloseTo(0.23422996, 8);
    expect(v.shiftCount).toBe(2);
    expect(v.lcp).not.toBeNull();
    expect(v.lcp!.ms).toBeCloseTo(51.032, 3);
    expect(v.lcp).toMatchObject({ type: 'text', nodeName: 'P', size: 23828 });
  });

  it('handles vitals in a trace with 700,000 other events', () => {
    const events: TraceEvent[] = [];
    for (let i = 0; i < 700_000; i++) events.push(ev('RunTask', i, 0.5));
    events.push(shift(100, 0.1), navigation(0), candidate(51.032));
    const v = analyzeTrace(events).vitals;
    expect(v.cls).toBeCloseTo(0.1);
    expect(v.shiftCount).toBe(1);
    expect(v.shifts).toEqual([{ atMs: 100, score: 0.1 }]);
    expect(v.lcp?.ms).toBeCloseTo(51.032, 3);
  });
});


describe('analyzeTrace: cpu profile', () => {
  const node = (id: number, functionName: string, url = '', lineNumber?: number, columnNumber?: number, parent = 1) => ({
    id, parent, callFrame: { functionName, url, lineNumber, columnNumber },
  });
  const profile = (id = '0x2', at = MAIN): TraceEvent => ({
    name: 'Profile', ph: 'P', ts: 0, ...at, id,
  });
  const chunk = (
    nodes: ReturnType<typeof node>[], samples: number[], timeDeltas = samples.map(() => 1000),
    ts = 0, id = '0x2', pid = MAIN.pid,
  ): TraceEvent => ({
    name: 'ProfileChunk', ph: 'P', ts, pid, tid: 99, id,
    args: { data: { cpuProfile: { nodes, samples }, timeDeltas } },
  });
  const cpu = (events: TraceEvent[], options?: AnalyzeOptions) => {
    const p = analyzeTrace(withMain(...events), options).profile;
    expect(p).not.toBeNull();
    return p!;
  };
  const simple = (nodes: ReturnType<typeof node>[], samples: number[], deltas?: number[]) =>
    cpu([profile(), chunk(nodes, samples, deltas)]);
  const basicNodes = [node(1, '(root)'), node(2, 'A'), node(3, 'B'), node(4, '(idle)')];

  it('distinguishes an absent profile from a counted profile with no samples', () => {
    expect(analyzeTrace([]).profile).toBeNull();
    expect(analyzeTrace(withMain()).profile).toBeNull();
    expect(analyzeTrace([profile(), chunk(basicNodes, [2, 3])]).profile).toBeNull();
    expect(cpu([profile()])).toEqual({ sampledMs: 0, idleMs: 0, programMs: 0, hot: [] });
    expect(cpu([profile(), chunk(basicNodes, [])])).toEqual({ sampledMs: 0, idleMs: 0, programMs: 0, hot: [] });
  });

  it('attributes 80ms to A and 19ms to B, with no duration for the final idle sample', () => {
    const p = simple(basicNodes, [...Array(80).fill(2), ...Array(19).fill(3), 4]);
    expect(p.sampledMs).toBe(99);
    expect(p.idleMs).toBe(0);
    expect(p.programMs).toBe(0);
    expect(p.hot.map((f) => [f.name, f.selfMs])).toEqual([['A', 80], ['B', 19]]);
    expect(p.hot[0].selfPct).toBeCloseTo(80.808, 3);
  });

  it('leaves idle time out of the busy percentage denominator', () => {
    const p = simple(basicNodes, [...Array(20).fill(2), ...Array(70).fill(4), ...Array(10).fill(3), 4]);
    expect(p.sampledMs).toBe(100);
    expect(p.idleMs).toBe(70);
    expect(p.hot.map((f) => f.name)).toEqual(['A', 'B']);
    expect(p.hot[0].selfPct).toBeCloseTo(66.667, 3);
  });

  it('counts program time as busy, keeps garbage collection, and excludes root', () => {
    const p = simple([node(1, '(root)'), node(2, '(program)'), node(3, '(garbage collector)'), node(4, 'A')], [2, 2, 3, 4, 1, 1]);
    expect(p.sampledMs).toBe(5);
    expect(p.programMs).toBe(2);
    expect(p.hot.map((f) => [f.name, f.selfMs, f.selfPct])).toEqual([
      ['(garbage collector)', 1, 20], ['A', 1, 20],
    ]);
    expect(simple(basicNodes, [4, 4, 4])).toEqual({ sampledMs: 2, idleMs: 2, programMs: 0, hot: [] });
  });

  it('merges the same function across parents, but separates urls, lines and columns', () => {
    const nodes = [node(1, '(root)'), node(2, 'same', 'a', 0, 0), node(3, 'same', 'a', 0, 0, 2),
      node(4, 'same', 'b', 0, 0), node(5, 'same', 'a', 1, 0), node(6, 'same', 'a', 0, 1)];
    const p = simple(nodes, [2, 3, 4, 5, 6, 1]);
    expect(p.hot).toHaveLength(4);
    expect(p.hot[0]).toMatchObject({ name: 'same', url: 'a', line: 1, column: 1, selfMs: 2 });
    expect(p.hot).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: 'b', line: 1, column: 1, selfMs: 1 }),
      expect.objectContaining({ url: 'a', line: 2, column: 1, selfMs: 1 }),
      expect.objectContaining({ url: 'a', line: 1, column: 2, selfMs: 1 }),
    ]));
  });

  it('orders equal self times by code-unit name, url and line with null last', () => {
    const nodes = [node(1, '(root)'), node(2, 'z'), node(3, 'a', 'b', 0), node(4, 'a', 'a'),
      node(5, 'a', 'a', 2), node(6, 'a', 'a', 0), node(7, 'Z')];
    const samples = [2, 3, 4, 5, 6, 7, 1];
    const hot = simple(nodes, samples).hot;
    expect(hot.map((f) => [f.name, f.url, f.line])).toEqual([
      ['Z', '', null], ['a', 'a', 1], ['a', 'a', 3], ['a', 'a', null], ['a', 'b', 1], ['z', '', null],
    ]);
    expect(simple([...nodes].reverse(), samples).hot).toEqual(hot);
  });

  it('limits the hot list to ten by default and respects topFunctions', () => {
    const nodes = Array.from({ length: 12 }, (_, i) => node(i + 2, `f${i}`));
    const events = [profile(), chunk([node(1, '(root)'), ...nodes], [...nodes.map((n) => n.id), 1])];
    expect(cpu(events).hot).toHaveLength(10);
    expect(cpu(events, { topFunctions: 3 }).hot).toHaveLength(3);
    expect(cpu(events, { topFunctions: 20 }).hot).toHaveLength(12);
  });

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity])('rejects topFunctions %s even without a profile', (topFunctions) => {
    expect(() => analyzeTrace([], { topFunctions })).toThrow(RangeError);
  });

  it('sorts negative-delta samples by time instead of clamping the deltas', () => {
    // Times: A=1000, B=4000, A=2000, idle=6000 us. Sorted gaps:
    // A(1000)->A(2000)=1ms, A->B(4000)=2ms, B->idle(6000)=2ms.
    const p = simple(basicNodes, [2, 3, 2, 4], [1000, 3000, -2000, 4000]);
    expect(p.sampledMs).toBe((6000 - 1000) / 1000);
    expect(p.hot.map((f) => [f.name, f.selfMs])).toEqual([['A', 3], ['B', 2]]);
    expect(p.idleMs).toBe(0);
  });

  it('preserves recorded order when sample times tie and omits zero-time entries', () => {
    const p = simple(basicNodes, [2, 3, 4], [1000, 0, 1000]);
    expect(p.sampledMs).toBe(1);
    expect(p.hot.map((f) => [f.name, f.selfMs])).toEqual([['B', 1]]);
    expect(simple(basicNodes, [2]).hot).toEqual([]);
  });

  it('sorts chunks by timestamp and carries nodes and sample time across them', () => {
    const p = cpu([profile(), chunk([], [3, 4], [3000, 4000], 30),
      chunk(basicNodes, [], [], 10), chunk([], [2], [1000], 20)]);
    expect(p.sampledMs).toBe(7);
    expect(p.hot.map((f) => [f.name, f.selfMs])).toEqual([['B', 4], ['A', 3]]);
    expect(p.idleMs).toBe(0);
  });

  it('preserves input order for chunks whose timestamps tie', () => {
    const p = cpu([profile(), chunk(basicNodes, [2], [1000], 10), chunk([], [3, 4], [2000, 3000], 10)]);
    expect(p.hot.map((f) => [f.name, f.selfMs])).toEqual([['B', 3], ['A', 2]]);
  });

  it('drops unknown nodes but lets the previous known sample run until the next known one', () => {
    const p = simple(basicNodes, [2, 999, 3, 4], [1000, 2000, 3000, 4000]);
    expect(p.sampledMs).toBe(9);
    expect(p.programMs).toBe(0);
    expect(p.hot.map((f) => [f.name, f.selfMs])).toEqual([['A', 5], ['B', 4]]);
    expect(simple(basicNodes, [999, 999]).sampledMs).toBe(0);
  });

  it('finds node definitions even when they appear in a later chunk', () => {
    const p = cpu([profile(), chunk([], [2], [1000], 10), chunk(basicNodes, [3, 4], [2000, 3000], 20)]);
    expect(p.hot.map((f) => [f.name, f.selfMs])).toEqual([['B', 3], ['A', 2]]);
  });

  it('skips missing and non-finite deltas and ignores excess deltas', () => {
    const p = cpu([profile(), chunk(basicNodes, [2, 3, 3, 3, 3, 3], [1000, NaN, Infinity, -Infinity], 10),
      chunk([], [3, 4], [2000, 3000, 999999], 20)]);
    expect(p.sampledMs).toBe(5);
    expect(p.hot.map((f) => [f.name, f.selfMs])).toEqual([['B', 3], ['A', 2]]);
  });

  it('ignores worker profiles, chunks from another pid, and chunks without a counted profile', () => {
    const p = cpu([profile(), profile('worker', { pid: 1, tid: 11 }),
      chunk(basicNodes, [2, 3], [1000, 2000]), chunk(basicNodes, [3, 3], [1000, 9000], 0, 'worker'),
      chunk(basicNodes, [3, 3], [1000, 9000], 0, '0x2', 2), chunk(basicNodes, [3, 3], [1000, 9000], 0, 'orphan')]);
    expect(p.sampledMs).toBe(2);
    expect(p.hot.map((f) => [f.name, f.selfMs])).toEqual([['A', 2]]);
    expect(analyzeTrace(withMain(profile('worker', { pid: 1, tid: 11 }))).profile).toBeNull();
  });

  it('adds independent profile timelines and merges their function buckets', () => {
    const p = cpu([profile(), profile('second'), chunk(basicNodes, [2, 3], [1000, 2000]),
      chunk([node(2, 'A'), node(3, '(idle)')], [2, 3], [900000, 3000], 0, 'second')]);
    expect(p.sampledMs).toBe(5);
    expect(p.hot).toEqual([{ name: 'A', url: '', line: null, column: null, selfMs: 5, selfPct: 100 }]);
  });

  it('converts positions to 1-based and handles anonymous, native and missing positions', () => {
    const nodes = [node(1, '(root)'), node(2, 'A', 'page.js', 0, 4), node(3, '', '', 2, 3),
      node(4, 'missing', 'page.js'), node(5, 'negative', 'page.js', -1, -1),
      node(6, 'infinite', 'page.js', Infinity, NaN)];
    const p = simple(nodes, [2, 3, 4, 5, 6, 1]);
    expect(p.hot).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'A', line: 1, column: 5 }),
      expect.objectContaining({ name: '(anonymous)', url: '', line: null, column: null }),
      expect.objectContaining({ name: 'missing', line: null, column: null }),
      expect.objectContaining({ name: 'negative', line: null, column: null }),
      expect.objectContaining({ name: 'infinite', line: null, column: null }),
    ]));
    expect(p.hot).toHaveLength(5);
  });

  it('agrees with independently measured samples from a real Chrome trace', () => {
    const events = (JSON.parse(readFileSync(
      new URL('./__fixtures__/profile-real.json', import.meta.url), 'utf8'
    )) as { traceEvents: TraceEvent[] }).traceEvents;
    const p = analyzeTrace(events).profile;
    expect(p).not.toBeNull();
    expect(p!.sampledMs).toBeCloseTo(1283.987, 3);
    expect(p!.idleMs).toBeCloseTo(1237.508, 3);
    expect(p!.programMs).toBeCloseTo(44.267, 3);
    expect(p!.hot).toHaveLength(2);
    expect(p!.hot[0]).toMatchObject({ name: 'tick', url: 'http://localhost/page.html', line: 5, column: 17 });
    expect(p!.hot[0].selfMs).toBeCloseTo(1.806, 3);
    expect(p!.hot[1]).toMatchObject({ name: '(anonymous)', url: '', line: null, column: null });
    expect(p!.hot[1].selfMs).toBeCloseTo(0.406, 3);
  });

  it('handles 700,000 filler events and 300,000 profile samples without argument spreads', () => {
    const events = withMain(profile());
    for (let i = 0; i < 700_000; i++) events.push(ev('RunTask', i, 0.5));
    events.push(chunk(basicNodes, Array(300_000).fill(2)));
    const p = analyzeTrace(events).profile;
    expect(p).not.toBeNull();
    expect(p!.sampledMs).toBe(299999);
    expect(p!.hot).toEqual([{ name: 'A', url: '', line: null, column: null, selfMs: 299999, selfPct: 100 }]);
  });

  describe('chunk data that is not the shape Chrome writes', () => {
    const rawChunk = (data: Record<string, unknown>): TraceEvent => ({
      name: 'ProfileChunk', ph: 'P', ts: 0, pid: MAIN.pid, tid: 99, id: '0x2', args: { data },
    });

    it('counts real arrays (the control for the cases below)', () => {
      const p = cpu([profile(), rawChunk({ cpuProfile: { nodes: basicNodes, samples: [2, 2] }, timeDeltas: [1000, 1000] })]);
      expect(p.sampledMs).toBe(1);
      expect(p.hot.map((f) => f.name)).toEqual(['A']);
    });

    // Small finite lengths: without the guard a huge length would loop without end, and that cannot be timed out.
    it('ignores samples that are an array-like object', () => {
      const p = cpu([profile(), rawChunk({ cpuProfile: { nodes: basicNodes, samples: { length: 2, 0: 2, 1: 2 } }, timeDeltas: [1000, 1000] })]);
      expect(p).toEqual({ sampledMs: 0, idleMs: 0, programMs: 0, hot: [] });
    });

    it('ignores timeDeltas that are an object', () => {
      const p = cpu([profile(), rawChunk({ cpuProfile: { nodes: basicNodes, samples: [2, 2] }, timeDeltas: { length: 2, 0: 1000, 1: 1000 } })]);
      expect(p).toEqual({ sampledMs: 0, idleMs: 0, programMs: 0, hot: [] });
    });

    it('ignores nodes that are not an array instead of throwing', () => {
      const p = cpu([profile(), rawChunk({ cpuProfile: { nodes: { length: 1, 0: basicNodes[1] }, samples: [2, 2] }, timeDeltas: [1000, 1000] })]);
      expect(p).toEqual({ sampledMs: 0, idleMs: 0, programMs: 0, hot: [] });
    });

    it('serializes a node once, not once per sample, so a 1MB url is not copied per sample', () => {
      // A page can run a script from a data: URL, so a frame's url can be its whole source.
      const url = 'u'.repeat(1024 * 1024);
      const nodes = [node(1, '(root)'), { id: 2, parent: 1, callFrame: { functionName: 'big', url, lineNumber: 0, columnNumber: 0 } }];
      const events = withMain(profile(), rawChunk({ cpuProfile: { nodes, samples: Array(200).fill(2) }, timeDeltas: Array(200).fill(1000) }));
      const stringify = JSON.stringify;
      let large = 0;
      // Counts without keeping the results, so the unfixed red run does not hold 200MB.
      const spy = vi.spyOn(JSON, 'stringify').mockImplementation((...args: Parameters<typeof JSON.stringify>) => {
        const out = stringify(...args);
        if (typeof out === 'string' && out.length > 500_000) large++;
        return out;
      });
      let p: ReturnType<typeof analyzeTrace>['profile'];
      try {
        p = analyzeTrace(events).profile;
      } finally {
        spy.mockRestore();
      }
      expect(large).toBeLessThanOrEqual(2);
      expect(p!.hot).toHaveLength(1);
      expect(p!.hot[0]).toMatchObject({ name: 'big', line: 1, column: 1, selfMs: 199, selfPct: 100 });
      expect(p!.hot[0].url).toBe(url);
    });

    it('treats a functionName or url that is not a string as empty', () => {
      const nodes = [
        node(1, '(root)'),
        { id: 2, parent: 1, callFrame: { functionName: ['x'.repeat(10000)], url: 42, lineNumber: 3, columnNumber: 4 } },
      ];
      const p = cpu([profile(), rawChunk({ cpuProfile: { nodes, samples: [2, 2] }, timeDeltas: [1000, 1000] })]);
      expect(p.hot).toEqual([{ name: '(anonymous)', url: '', line: null, column: null, selfMs: 1, selfPct: 100 }]);
    });
  });
});
