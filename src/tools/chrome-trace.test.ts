import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeTrace, type TraceEvent } from './chrome-trace.js';

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
