/**
 * control/chrome-metrics — a cheap snapshot of a page's counters and web vitals, without a trace
 *
 * Metrics come from Chrome (Performance.getMetrics). Node, document, frame and listener counts
 * and the heap are true at any instant. Layout, style, script and task counters are not: Chrome
 * counts them only while the Performance domain is enabled, and keeps them across a disable, so a
 * read made right after enable is about 0. They are returned only as a window: two reads sampleMs
 * apart with the domain enabled between them, and the difference. Vitals come from one script that asks
 * PerformanceObserver for what the browser has buffered since load. It runs in an isolated world
 * Chrome makes for it, so the page's own scripts (a replaced PerformanceObserver or String
 * prototype) are not there and the entries are the browser's. The world is addressed by the unique
 * context id Chrome announced for it, not by its numeric id, which a new document in another
 * process can reuse: a context with a different name, type or frame is refused, and an id the client
 * never saw is not used. The world's name carries a nonce of this process, so an extension's or
 * another tool's isolated world never passes for it. Chrome keeps one such world per frame and
 * rebuilds it on navigation, so repeated calls make no new worlds. It never falls back to
 * the page's world. What comes back is validated and bounded here either way: arrays, finite
 * numbers in a sane range, short strings.
 */

import { randomBytes } from 'node:crypto';
import type { ToolResult } from '../types.js';
import { truncate } from './chrome-trace-summary.js';
import { worstSessionWindow } from './chrome-trace.js';
import { contextRecord, type ExecutionContextRecord } from './cdp-events.js';

/** What is true at the instant of the read. */
export interface ChromeMetrics {
  nodes: number | null;
  documents: number | null;
  frames: number | null;
  jsEventListeners: number | null;
  jsHeapUsedBytes: number | null;
  jsHeapTotalBytes: number | null;
}

/** What Chrome counted between two reads. Null when either read lacks it, or it is not a finite rise. */
export interface MetricsWindow {
  /** Between the reads, by Chrome's Timestamp; by the clock when Chrome gave none. */
  ms: number | null;
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

/** Chrome's metric name and our key. */
const INSTANT: [string, keyof ChromeMetrics][] = [
  ['Nodes', 'nodes'],
  ['Documents', 'documents'],
  ['Frames', 'frames'],
  ['JSEventListeners', 'jsEventListeners'],
  ['JSHeapUsedSize', 'jsHeapUsedBytes'],
  ['JSHeapTotalSize', 'jsHeapTotalBytes'],
];

/** Chrome's counter name, our key, and whether Chrome reports it in seconds. */
const COUNTERS: [string, Exclude<keyof MetricsWindow, 'ms'>, boolean][] = [
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

/**
 * The ranges a real entry falls in. A number outside is not the browser's, and finite values that
 * large still overflow a sum or a rounding (two shifts of 1e308 make CLS Infinity).
 */
const DOMAIN = {
  /** A layout-shift value is a fraction of the viewport; real ones are far below this. */
  shiftValue: 1000,
  /** Page times and durations in ms: about 31 years. */
  ms: 1e12,
  /** An LCP size in square pixels. */
  size: 1e15,
};
const within = (n: unknown, max: number): n is number => finite(n) && n >= 0 && n <= max;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The finite values of a Performance.getMetrics metrics array, by name; the rest are not read. */
function metricValues(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(raw)) return out;
  for (let i = 0; i < Math.min(raw.length, MAX_METRICS); i++) {
    const m = raw[i] as { name?: unknown; value?: unknown } | null;
    if (typeof m?.name === 'string' && finite(m.value) && !out.has(m.name)) out.set(m.name, m.value);
  }
  return out;
}

/** The metrics array of a Performance.getMetrics result, reduced to the instantaneous keys. A missing one is null. */
export function pickMetrics(raw: unknown): ChromeMetrics {
  const values = metricValues(raw);
  return Object.fromEntries(INSTANT.map(([name, key]) => [key, values.get(name) ?? null])) as unknown as ChromeMetrics;
}

/**
 * The counters of read b minus those of read a. Durations go from seconds to ms with 2 decimals.
 * A counter missing from either read, or one that did not rise or stay (a negative or non-finite
 * difference), is null: never 0, never negative. wallMs is the window when Chrome gives no Timestamp.
 */
export function metricsWindow(a: unknown, b: unknown, wallMs: number): MetricsWindow {
  const before = metricValues(a);
  const after = metricValues(b);
  const delta = (name: string, seconds: boolean): number | null => {
    const x = before.get(name);
    const y = after.get(name);
    if (x === undefined || y === undefined) return null;
    const d = seconds ? round2((y - x) * 1000) : y - x;
    return finite(d) && d >= 0 ? (d === 0 ? 0 : d) : null;
  };
  const stamped = before.has('Timestamp') && after.has('Timestamp');
  const ms = stamped ? delta('Timestamp', true) : finite(wallMs) && wallMs >= 0 ? round2(wallMs) : null;
  const out = { ms } as MetricsWindow;
  for (const [name, key, seconds] of COUNTERS) out[key] = delta(name, seconds);
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
    .filter((e) => within(e.startTime, DOMAIN.ms) && within(e.size, DOMAIN.size))
    .map((e) => ({ startTime: e.startTime as number, size: e.size as number, element: truncate(e.element) }));
  // Shifts right after input are expected and do not count, as in analyzeTrace.
  const shifts = firstEntries(r.shifts)
    .filter((e) => within(e.value, DOMAIN.shiftValue) && within(e.startTime, DOMAIN.ms) && e.hadRecentInput !== true)
    .map((e) => ({ t: e.startTime as number, score: e.value as number }));
  const events = firstEntries(r.events)
    .filter((e) => within(e.duration, DOMAIN.ms) && within(e.startTime, DOMAIN.ms) && finite(e.interactionId))
    .map((e) => ({ duration: e.duration as number, interactionId: e.interactionId as number }));

  return { lcp: lcpOf(lcp), cls: worstSessionWindow(shifts, 1), shiftCount: shifts.length, inp: inpOf(events) };
}

/**
 * Runs in the isolated world (awaitPromise, returnByValue). Buffered observers replay what the
 * browser kept since load; the callback may run before the timer, so entries are kept from both
 * it and takeRecords. Returns plain numbers and a tag name, at most MAX_VITAL_ENTRIES of each kind,
 * checked only with typeof and comparisons. Event timing reports only events of 40ms or more.
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
          startTime: e.startTime, size: e.size,
          element: e.element && typeof e.element.tagName === 'string' && e.element.tagName.length <= 200 ? e.element.tagName.toLowerCase() : '',
        })),
        shifts: got['layout-shift'].map((e) => ({ value: e.value, startTime: e.startTime, hadRecentInput: e.hadRecentInput })),
        events: got.event.map((e) => ({ duration: e.duration, interactionId: e.interactionId, startTime: e.startTime })),
      });
    } catch (error) {
      reject(error);
    }
  }, 0);
})`;

export interface MetricsCdp {
  sendCommand(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<{ result?: unknown; error?: { code?: number; message: string } }>;
  /** The world with METRICS_WORLD_NAME the client keeps; see OwnWorldSlot for when it is dropped. */
  metricsWorld(): ExecutionContextRecord | undefined;
  /** See waitForCdpEventMatching: the first event of this method the predicate accepts. */
  waitForEventMatching(
    method: string,
    predicate: (params: Record<string, unknown>) => boolean,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>>;
}

export const TAB_CHANGED = 'The selected tab changed while measuring; run metrics again.';

/** A page that blocks its main thread holds the vitals probe; this bounds the wait for it. */
const VITALS_TIMEOUT_MS = 10_000;

/** How long after Chrome answers createIsolatedWorld its announcement of the world may still come. */
const CONTEXT_WAIT_MS = 2000;

/** createIsolatedWorld runs on the page's main thread, which a busy page holds; bounded like the probe. */
const CREATE_TIMEOUT_MS = 10_000;

/**
 * Our world's name, the one thing that tells it from other isolated worlds in the frame (an
 * extension's content scripts are isolated worlds too). Made once per process, never per call or
 * connection: Chrome keeps a world per name for good and has a finite range of world ids.
 */
export const METRICS_WORLD_NAME = `control-metrics-${randomBytes(6).toString('hex')}`;
const WORLD_NAME = METRICS_WORLD_NAME;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const noWorld = 'Could not make a separate JS world in the page to read its vitals (it may be navigating); run metrics again.';
// Also what a number held by a context announced earlier that is not ours gives: the client keeps
// nothing about such a context, so the wait for ours under that number runs out.
const unannounced =
  'Chrome did not announce the JS world it made for the vitals, or the number it gave is held by a context that is not ours (the page may be navigating); run metrics again.';
const unusableId = 'Chrome announced the JS world it made for the vitals with no usable id; run metrics again.';
const navigated = 'The page navigated while measuring the vitals; run metrics again.';

/** Chrome's answers to a probe whose world went with its document, in this process or another. */
const worldGone = (e: { code?: number; message: string }) =>
  (e.code === -32000 && e.message === 'Cannot find context with specified id') ||
  (e.code === -32602 && e.message === 'uniqueContextId not found');

const notOurs = 'The id Chrome gave for the vitals world names another context (the page may have navigated); run metrics again.';

/**
 * Get the world of ours in the frame and return its unique id, or our words for why not. The probe is
 * addressed by the unique id: a numeric context id can be reused by a new document after a
 * cross-process navigation, the page's own world among them. Chrome keeps one world per frame and
 * name, rebuilds it on navigation and announces it then, so createIsolatedWorld may answer with the
 * id of a world announced long before; the client keeps the last one announced. A world made
 * now is announced before the answer, or may still be announced for contextWaitMs after it.
 */
async function makeWorld(
  cdp: MetricsCdp,
  frameId: string,
  contextWaitMs: number
): Promise<{ uniqueId: string } | { vitalsError: string }> {
  let id: number;
  try {
    const world = await cdp.sendCommand('Page.createIsolatedWorld', { frameId, worldName: WORLD_NAME }, CREATE_TIMEOUT_MS);
    const answered = (world.result as { executionContextId?: unknown } | undefined)?.executionContextId;
    if (world.error || !finite(answered)) return { vitalsError: noWorld };
    id = answered;
  } catch {
    return { vitalsError: noWorld };
  }
  let context = cdp.metricsWorld();
  if (context?.id !== id) {
    // Registered in the same step that found no world under this number, so nothing announced in
    // between is missed.
    let announced: Record<string, unknown>;
    try {
      announced = await cdp.waitForEventMatching(
        'Runtime.executionContextCreated',
        (params) => (params.context as { id?: unknown } | null | undefined)?.id === id,
        contextWaitMs
      );
    } catch {
      return { vitalsError: unannounced };
    }
    context = cdp.metricsWorld();
    if (context?.id !== id) return { vitalsError: contextRecord(announced) ? notOurs : unusableId };
  }
  // The client keeps only an isolated world with our name; the frame is the one thing left to check.
  if (context.frameId !== frameId) return { vitalsError: notOurs };
  return { uniqueId: context.uniqueId };
}

export interface ReadMetricsOptions {
  /** How long after createIsolatedWorld answers to wait for Chrome to announce the world. */
  contextWaitMs?: number;
  /** Read the counters twice, this many ms apart, and return what they counted in between. */
  sampleMs?: number;
  /** The clock the window is waited and measured on; a test can move it. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const getMetrics = async (cdp: MetricsCdp): Promise<unknown> => {
  const r = await cdp.sendCommand('Performance.getMetrics');
  if (r.error) throw new Error(r.error.message);
  return (r.result as { metrics?: unknown } | undefined)?.metrics;
};

/**
 * The vitals, read in a world of our own, or our own words for why not. Never the page's text.
 * frameId is the page target's id, which is its main frame's id: asking for the frame tree would
 * bring every frame's name and URL (page data, any size) into Node just to find it.
 */
async function readVitals(
  cdp: MetricsCdp,
  frameId: string | undefined,
  options: ReadMetricsOptions
): Promise<{ vitals: PageVitals } | { vitalsError: string }> {
  if (frameId === undefined) return { vitalsError: noWorld };
  const world = await makeWorld(cdp, frameId, options.contextWaitMs ?? CONTEXT_WAIT_MS);
  if ('vitalsError' in world) return world;
  try {
    const r = await cdp.sendCommand(
      'Runtime.evaluate',
      { expression: VITALS_PROBE, uniqueContextId: world.uniqueId, returnByValue: true, awaitPromise: true },
      VITALS_TIMEOUT_MS
    );
    const result = r.result as { result?: { value?: unknown }; exceptionDetails?: unknown } | undefined;
    if (r.error) return { vitalsError: worldGone(r.error) ? navigated : 'Chrome refused to run the vitals probe.' };
    if (result?.exceptionDetails !== undefined) return { vitalsError: 'The vitals probe threw while reading performance entries.' };
    const vitals = pageVitals(result?.result?.value);
    return vitals ? { vitals } : { vitalsError: 'The vitals probe returned something other than performance entries.' };
  } catch (error) {
    // A timeout or a broken connection: the message is the client's own, not the page's.
    return { vitalsError: `The vitals probe got no answer: ${messageOf(error)}` };
  }
}

/**
 * One snapshot: Chrome's metrics, then the vitals; with sampleMs, a window of counters between.
 * stillSelected says the tab measured is still the selected one; it is checked before, between
 * the two reads, after them and after the vitals, so numbers of one tab are never returned with
 * those of another.
 */
export async function readMetrics(
  cdp: MetricsCdp,
  stillSelected: () => boolean,
  frameId: string | undefined,
  options: ReadMetricsOptions = {}
): Promise<ToolResult> {
  const changed = { success: false, error: TAB_CHANGED };
  if (!stillSelected()) return changed;
  const { sampleMs, now = Date.now, sleep = sleepFor } = options;
  let metrics: ChromeMetrics;
  let window: MetricsWindow | undefined;
  try {
    try {
      const enabled = await cdp.sendCommand('Performance.enable');
      if (enabled.error) throw new Error(enabled.error.message);
      const a = await getMetrics(cdp);
      let last = a;
      if (sampleMs !== undefined) {
        const started = now();
        const until = started + sampleMs;
        // On the clock, not on the timer: a timer can fire a millisecond early.
        while (now() < until) await sleep(until - now());
        if (!stillSelected()) return changed;
        last = await getMetrics(cdp);
        window = metricsWindow(a, last, now() - started);
      }
      metrics = pickMetrics(last);
    } finally {
      // An enable with no answer may still have turned the domain on: always ask to turn it off.
      // A failed disable must not hide the reading.
      await cdp.sendCommand('Performance.disable').catch(() => {});
    }
  } catch (error) {
    if (!stillSelected()) return changed;
    return { success: false, error: `Could not read Chrome's metrics: ${messageOf(error)}` };
  }
  if (!stillSelected()) return changed;
  const vitals = await readVitals(cdp, frameId, options);
  if (!stillSelected()) return changed;
  return {
    success: true,
    data: { metrics, ...(window ? { window } : {}), ...('vitals' in vitals ? vitals : { vitals: null, ...vitals }) },
  };
}

/**
 * readMetrics, one call at a time: Performance is one domain per tab, so an overlapping call would
 * turn it off under another's getMetrics, or in the middle of another's window. A call with
 * sampleMs holds the next one for its window. A call that fails does not hold up the next.
 */
export function createMetricsReader(): (
  cdp: MetricsCdp,
  stillSelected: () => boolean,
  frameId: string | undefined,
  options?: ReadMetricsOptions
) => Promise<ToolResult> {
  let tail: Promise<unknown> = Promise.resolve();
  return (cdp, stillSelected, frameId, options) => {
    const run = tail.then(() => readMetrics(cdp, stillSelected, frameId, options));
    tail = run.catch(() => {});
    return run;
  };
}
