/**
 * control/chrome-trace — Chrome trace analysis
 *
 * Pure functions over Chrome trace events (the `traceEvents` array that
 * DevTools exports and Perfetto opens). No Chrome, no I/O: unit-testable.
 */

export interface TraceEvent {
  name: string;
  cat?: string;
  ph: string;
  /** Microseconds. */
  ts: number;
  /** Microseconds. Present on complete ('X') events. */
  dur?: number;
  pid: number;
  tid: number;
  args?: Record<string, unknown>;
}

export interface LongTask {
  /** Milliseconds from the start of the trace window. */
  startMs: number;
  durationMs: number;
}

export interface CategoryMs {
  scripting: number;
  layout: number;
  paint: number;
  gc: number;
  other: number;
}

export interface TraceSummary {
  windowMs: number;
  mainThread: { pid: number; tid: number } | null;
  busyPct: number;
  longTasks: LongTask[];
  categoryMs: CategoryMs;
}

/** W3C Long Tasks: a task is long when it runs for more than 50ms. */
const LONG_TASK_MS = 50;

const SCRIPTING = new Set([
  'FunctionCall',
  'EvaluateScript',
  'v8.compile',
  'v8.run',
  'EventDispatch',
  'TimerFire',
  'FireAnimationFrame',
  'FireIdleCallback',
  'RunMicrotasks',
]);
const LAYOUT = new Set(['Layout', 'UpdateLayoutTree', 'IntersectionObserverController::computeIntersections']);
const PAINT = new Set(['Paint', 'PrePaint', 'Layerize', 'UpdateLayer', 'Commit', 'CompositeLayers']);
const GC = new Set(['MinorGC', 'MajorGC', 'BlinkGC.AtomicPhase', 'ThreadState::performIdleLazySweep']);

function categoryOf(name: string): keyof CategoryMs {
  if (SCRIPTING.has(name)) return 'scripting';
  if (LAYOUT.has(name)) return 'layout';
  if (PAINT.has(name)) return 'paint';
  if (GC.has(name) || name.startsWith('V8.GC_')) return 'gc';
  return 'other';
}

interface Span {
  name: string;
  start: number;
  end: number;
}

const spanOf = (e: TraceEvent): Span => ({
  name: e.name,
  start: e.ts,
  end: e.ts + (e.dur ?? 0),
});

/**
 * The renderer main thread: the CrRendererMain thread with the most RunTask
 * time. A browser-level trace can hold several (other tabs, iframes).
 */
function findMainThread(events: TraceEvent[]): { pid: number; tid: number } | null {
  const key = (e: { pid: number; tid: number }) => `${e.pid}:${e.tid}`;
  const mains = new Map<string, { pid: number; tid: number }>();
  for (const e of events) {
    if (e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain') {
      mains.set(key(e), { pid: e.pid, tid: e.tid });
    }
  }
  const busy = new Map<string, number>();
  for (const e of events) {
    if (e.ph === 'X' && e.name === 'RunTask') {
      busy.set(key(e), (busy.get(key(e)) ?? 0) + (e.dur ?? 0));
    }
  }
  let best: { pid: number; tid: number } | null = null;
  let bestBusy = -1;
  for (const [k, thread] of mains) {
    const b = busy.get(k) ?? 0;
    if (b > bestBusy) {
      best = thread;
      bestBusy = b;
    }
  }
  return best;
}

/** Total length of the union of [start, end) spans, in microseconds. */
function unionLength(spans: Span[]): number {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = 0;
  let curEnd = -Infinity;
  for (const s of sorted) {
    if (s.start > curEnd) {
      if (curEnd > -Infinity) total += curEnd - curStart;
      curStart = s.start;
      curEnd = s.end;
    } else if (s.end > curEnd) {
      curEnd = s.end;
    }
  }
  if (curEnd > -Infinity) total += curEnd - curStart;
  return total;
}

/**
 * Self time per category. A nested event's time belongs to the event, not to
 * its parent, so the categories sum to the time spent in tasks.
 */
function selfTimeByCategory(spans: Span[]): CategoryMs {
  const out: CategoryMs = { scripting: 0, layout: 0, paint: 0, gc: 0, other: 0 };
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const stack: { span: Span; childUs: number }[] = [];
  const close = () => {
    const top = stack.pop()!;
    out[categoryOf(top.span.name)] += (top.span.end - top.span.start - top.childUs) / 1000;
  };
  for (const span of sorted) {
    while (stack.length && stack[stack.length - 1].span.end <= span.start) close();
    const parent = stack[stack.length - 1];
    if (parent) parent.childUs += Math.min(span.end, parent.span.end) - span.start;
    stack.push({ span, childUs: 0 });
  }
  while (stack.length) close();
  return out;
}

export function analyzeTrace(events: TraceEvent[]): TraceSummary {
  const timed = events.filter((e) => e.ph === 'X' && e.dur !== undefined);
  const main = findMainThread(events);
  const mainSpans = main
    ? timed.filter((e) => e.pid === main.pid && e.tid === main.tid).map(spanOf)
    : [];
  const tasks = mainSpans.filter((s) => s.name === 'RunTask');

  const windowStart = Math.min(...timed.map((e) => e.ts));
  const windowEnd = Math.max(...timed.map((e) => e.ts + (e.dur ?? 0)));
  const windowUs = timed.length ? windowEnd - windowStart : 0;

  return {
    windowMs: windowUs / 1000,
    mainThread: main,
    busyPct: windowUs > 0 ? (unionLength(tasks) / windowUs) * 100 : 0,
    longTasks: tasks
      .filter((t) => (t.end - t.start) / 1000 > LONG_TASK_MS)
      .map((t) => ({
        startMs: (t.start - windowStart) / 1000,
        durationMs: (t.end - t.start) / 1000,
      })),
    categoryMs: selfTimeByCategory(mainSpans),
  };
}
