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
