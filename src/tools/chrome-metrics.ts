/**
 * control/chrome-metrics — a cheap snapshot of a page's counters and web vitals, without a trace
 *
 * Counters come from Chrome (Performance.getMetrics). Vitals come from the page itself: one
 * evaluate asks PerformanceObserver for what the browser has buffered since load. The page runs
 * that script in its own world, so a page that lies can mislead it, as it can mislead evaluate.
 * Everything it returns is checked here: lists must be arrays, numbers finite, strings short.
 */

import { truncate } from './chrome-trace-summary.js';
import { worstSessionWindow } from './chrome-trace.js';

export interface ChromeMetrics {
  nodes: number | null;
  documents: number | null;
  frames: number | null;
  jsEventListeners: number | null;
  jsHeapUsedBytes: number | null;
  jsHeapTotalBytes: number | null;
  layoutCount: number | null;
  recalcStyleCount: number | null;
  layoutMs: number | null;
  recalcStyleMs: number | null;
  scriptMs: number | null;
  v8CompileMs: number | null;
  taskMs: number | null;
}

export interface PageVitals {
  /** The last largest-contentful-paint candidate; null when there is none. */
  lcp: { ms: number; size: number; element: string } | null;
  /** The worst session window of shifts without recent input; 0 when there are none. */
  cls: number;
  shiftCount: number;
  /** Null when there were no interactions, never 0. */
  inp: { ms: number; interactions: number } | null;
}

/** Chrome's metric name, our key, and whether Chrome reports it in seconds. */
const METRICS: [string, keyof ChromeMetrics, boolean][] = [
  ['Nodes', 'nodes', false],
  ['Documents', 'documents', false],
  ['Frames', 'frames', false],
  ['JSEventListeners', 'jsEventListeners', false],
  ['JSHeapUsedSize', 'jsHeapUsedBytes', false],
  ['JSHeapTotalSize', 'jsHeapTotalBytes', false],
  ['LayoutCount', 'layoutCount', false],
  ['RecalcStyleCount', 'recalcStyleCount', false],
  ['LayoutDuration', 'layoutMs', true],
  ['RecalcStyleDuration', 'recalcStyleMs', true],
  ['ScriptDuration', 'scriptMs', true],
  ['V8CompileDuration', 'v8CompileMs', true],
  ['TaskDuration', 'taskMs', true],
];

/** Chrome sends about 60 metrics; more than this is not Chrome's shape, and the rest is not read. */
const MAX_METRICS = 500;

/** Entries of each kind read from the page; the rest are ignored, so a flood cannot cost much. */
export const MAX_VITAL_ENTRIES = 500;

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The metrics array of a Performance.getMetrics result, reduced to our keys. A missing one is null. */
export function pickMetrics(raw: unknown): ChromeMetrics {
  const out = Object.fromEntries(METRICS.map(([, key]) => [key, null])) as Record<keyof ChromeMetrics, number | null>;
  if (!Array.isArray(raw)) return out;
  const wanted = new Map(METRICS.map(([name, key, seconds]) => [name, { key, seconds }]));
  for (let i = 0; i < Math.min(raw.length, MAX_METRICS); i++) {
    const m = raw[i] as { name?: unknown; value?: unknown } | null;
    const found = typeof m?.name === 'string' ? wanted.get(m.name) : undefined;
    if (!found || !finite(m?.value)) continue;
    const value = found.seconds ? round2(m.value * 1000) : m.value;
    if (finite(value)) out[found.key] = value;
  }
  return out;
}

/**
 * INP as web-vitals estimates it: the longest event per interaction, then the worst interaction,
 * skipping one per 50 so a rare outlier on a long session does not count. Null without any.
 */
export function inpOf(events: readonly { duration: number; interactionId: number }[]): PageVitals['inp'] {
  const longest = new Map<number, number>();
  for (const e of events) {
    if (e.interactionId <= 0) continue;
    longest.set(e.interactionId, Math.max(longest.get(e.interactionId) ?? 0, e.duration));
  }
  if (longest.size === 0) return null;
  const worstFirst = [...longest.values()].sort((a, b) => b - a);
  const index = Math.min(worstFirst.length - 1, Math.floor(worstFirst.length / 50));
  return { ms: round2(worstFirst[index]), interactions: worstFirst.length };
}

/** The current LCP is the last candidate the browser reported. */
export function lcpOf(entries: readonly { startTime: number; size: number; element: string }[]): PageVitals['lcp'] {
  const last = entries[entries.length - 1];
  return last ? { ms: round2(last.startTime), size: last.size, element: last.element } : null;
}

/** The first MAX_VITAL_ENTRIES items of a list from the page, or none when it is not an array. */
function firstEntries(list: unknown): Record<string, unknown>[] {
  if (!Array.isArray(list)) return [];
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < Math.min(list.length, MAX_VITAL_ENTRIES); i++) {
    const e = list[i];
    if (typeof e === 'object' && e !== null) out.push(e as Record<string, unknown>);
  }
  return out;
}

/** The probe's result, checked and reduced to vitals. Null when it is not the probe's shape at all. */
export function pageVitals(raw: unknown): PageVitals | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as { lcp?: unknown; shifts?: unknown; events?: unknown };

  const lcp = firstEntries(r.lcp)
    .filter((e) => finite(e.startTime) && finite(e.size))
    .map((e) => ({ startTime: e.startTime as number, size: e.size as number, element: truncate(e.element) }));
  // Shifts right after input are expected and do not count, as in analyzeTrace.
  const shifts = firstEntries(r.shifts)
    .filter((e) => finite(e.value) && finite(e.startTime) && e.hadRecentInput !== true)
    .map((e) => ({ t: e.startTime as number, score: e.value as number }));
  const events = firstEntries(r.events)
    .filter((e) => finite(e.duration) && finite(e.interactionId))
    .map((e) => ({ duration: e.duration as number, interactionId: e.interactionId as number }));

  return { lcp: lcpOf(lcp), cls: worstSessionWindow(shifts, 1), shiftCount: shifts.length, inp: inpOf(events) };
}

/**
 * Runs in the page (awaitPromise, returnByValue). Buffered observers replay what the browser kept
 * since load; the callback may run before the timer, so entries are kept from both it and
 * takeRecords. Returns plain numbers and a tag name, at most MAX_VITAL_ENTRIES of each kind.
 * Event timing reports only events of 40ms or more (durationThreshold).
 */
export const VITALS_PROBE = `new Promise((resolve, reject) => {
  const MAX = ${MAX_VITAL_ENTRIES};
  const types = [['largest-contentful-paint', {}], ['layout-shift', {}], ['event', { durationThreshold: 40 }]];
  const got = {};
  const observers = [];
  const keep = (type, entries) => { for (const e of entries) if (got[type].length < MAX) got[type].push(e); };
  try {
    for (const [type, extra] of types) {
      got[type] = [];
      const o = new PerformanceObserver((list) => keep(type, list.getEntries()));
      observers.push([type, o]);
      o.observe({ type, buffered: true, ...extra });
    }
  } catch (error) {
    for (const [, o] of observers) o.disconnect();
    reject(error);
    return;
  }
  setTimeout(() => {
    try {
      for (const [type, o] of observers) { keep(type, o.takeRecords()); o.disconnect(); }
      resolve({
        lcp: got['largest-contentful-paint'].map((e) => ({
          startTime: e.startTime, size: e.size, element: e.element ? String(e.element.tagName).slice(0, 200).toLowerCase() : '',
        })),
        shifts: got['layout-shift'].map((e) => ({ value: e.value, startTime: e.startTime, hadRecentInput: e.hadRecentInput })),
        events: got.event.map((e) => ({ duration: e.duration, interactionId: e.interactionId, startTime: e.startTime })),
      });
    } catch (error) {
      reject(error);
    }
  }, 0);
})`;
