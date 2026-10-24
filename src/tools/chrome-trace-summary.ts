/**
 * control/chrome-trace-summary — a short summary of a trace file, limited in size
 *
 * Reads a trace that stop just wrote and runs analyzeTrace over it. Chrome
 * writes the structure, but function names, URLs and node names come from the
 * page and can say anything, including text aimed at whoever reads the result.
 *
 * The file is streamed twice and never held whole (see chrome-trace-stream); what
 * is kept is held, and grows with the trace up to MAX_KEPT_EVENTS and MAX_KEPT_BYTES.
 * The structure is trusted to be Chrome's; the strings in it are the page's. A trace
 * with forged structure (deep or dense arrays) can cost several times its text in
 * memory once parsed, bounded then only by SUMMARY_MAX_BYTES. The first pass
 * keeps almost nothing: which thread is the main thread, and the trace window. The
 * second keeps only the events analyzeTrace reads for that thread
 * (eventsAnalysisReads), plus two events that carry the window, and analyzeTrace
 * runs on those. That it gives the same summary as all the events is verified on
 * the traces in the tests (fixtures, synthetic traces, Chrome recordings, a real
 * 184MB profile), not proven. The input is limited in bytes (SUMMARY_MAX_BYTES,
 * decompressed), kept events, threads, and time for the two scans; the result by
 * count (10 long tasks, 10 hot functions, 10 shifts) and string length (200). A
 * bad or oversized file yields a reason instead of an error.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream';
import { createGunzip } from 'node:zlib';
import {
  analyzeTrace,
  eventsAnalysisReads,
  isTimed,
  MainThreadTally,
  TraceWindow,
  type TraceEvent,
  type TraceSummary,
} from './chrome-trace.js';
import { scanTraceEvents, type ScanResult } from './chrome-trace-stream.js';

/**
 * Decompressed bytes the event array must end within. The file is not held, so this bounds time
 * more than memory: a 30s profile, the longest, is about 700MB inflated, and the two passes read
 * about 100MB of it a second.
 */
export const SUMMARY_MAX_BYTES = 1024 * 1024 * 1024;

/**
 * Events the second pass may keep; MAX_KEPT_BYTES bounds their text. A real 8s three.js profile
 * kept 180,577 of 856,875 and grew RSS by 133MB (about 700 bytes an event), so a 30s one keeps
 * about 700,000. At the cap that is about 700MB, as much as the old whole-file summary took at its
 * 128MB limit. analyzeTrace over 1,000,000 kept task and frame events took 212ms (measured); it
 * runs after the scans, outside their time limit.
 */
export const MAX_KEPT_EVENTS = 1_000_000;

/**
 * Text of the events the second pass may keep, counted as the scanner reads it. Kept memory is
 * the parsed size of these events: about their text for the strings a page chooses (mark names,
 * function names, URLs), more only for structure, which is trusted to be Chrome's. The real 8s
 * profile kept 37.7MB of text (180,575 events, of 174MB in all), so a 30s one keeps about 140MB.
 */
export const MAX_KEPT_BYTES = 256 * 1024 * 1024;

/** Threads the first pass may hold a name or task time for. A real browser trace has a few hundred. */
export const MAX_THREADS = 10_000;

/** The two scans; analyzeTrace after them is not covered. Measured: under 3s for the real 184MB trace. */
export const SUMMARY_TIME_LIMIT_MS = 60_000;

const MAX_LONG_TASKS = 10;
const MAX_STRING = 200;

export type BoundedSummary = TraceSummary & {
  /** How many long tasks the trace has; longTasks lists only the longest few. */
  longTaskCount: number;
};

const MiB = 1024 * 1024;
const size = (n: number) => (n >= MiB ? `${Math.round(n / MiB)}MB` : `${n} bytes`);

function round(n: number): number {
  const r = Math.round(n * 100) / 100;
  // n * 100 overflows near 1e308; NaN and Infinity have no rounded value to invent, so they stay as they are.
  if (!Number.isFinite(r)) return n;
  return r === 0 ? 0 : r; // -0 reads as a negative score
}
const roundOrNull = (n: number | null) => (n === null ? null : round(n));

/** At most MAX_STRING UTF-16 units, ending in an ellipsis when cut; never half a surrogate pair. Not a string: ''. */
export function truncate(s: unknown): string {
  if (typeof s !== 'string') return '';
  if (s.length <= MAX_STRING) return s;
  let end = MAX_STRING - 1;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return s.slice(0, end) + '…';
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function boundSummary(s: TraceSummary): BoundedSummary {
  const { frames, vitals, profile } = s;
  return {
    windowMs: round(s.windowMs),
    // The ids come from the file as-is; only numbers may pass.
    mainThread: s.mainThread && finite(s.mainThread.pid) && finite(s.mainThread.tid)
      ? { pid: s.mainThread.pid, tid: s.mainThread.tid } : null,
    busyPct: round(s.busyPct),
    // Stable sort: equal durations keep their order in time.
    longTasks: [...s.longTasks]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, MAX_LONG_TASKS)
      .map((t) => ({ startMs: round(t.startMs), durationMs: round(t.durationMs) })),
    longTaskCount: s.longTasks.length,
    categoryMs: {
      scripting: round(s.categoryMs.scripting),
      layout: round(s.categoryMs.layout),
      paint: round(s.categoryMs.paint),
      gc: round(s.categoryMs.gc),
      other: round(s.categoryMs.other),
    },
    frames: {
      ...frames,
      fps: round(frames.fps),
      p50Ms: roundOrNull(frames.p50Ms),
      p95Ms: roundOrNull(frames.p95Ms),
      p99Ms: roundOrNull(frames.p99Ms),
      maxMs: roundOrNull(frames.maxMs),
    },
    vitals: {
      lcp: vitals.lcp && {
        ms: round(vitals.lcp.ms),
        type: truncate(vitals.lcp.type),
        nodeName: truncate(vitals.lcp.nodeName),
        size: round(vitals.lcp.size),
      },
      cls: round(vitals.cls),
      shiftCount: vitals.shiftCount,
      shifts: vitals.shifts.map((x) => ({ atMs: round(x.atMs), score: round(x.score) })),
    },
    profile: profile && {
      sampledMs: round(profile.sampledMs),
      idleMs: round(profile.idleMs),
      programMs: round(profile.programMs),
      hot: profile.hot.map((f) => ({
        name: truncate(f.name),
        url: truncate(f.url),
        line: f.line,
        column: f.column,
        selfMs: round(f.selfMs),
        selfPct: round(f.selfPct),
      })),
    },
  };
}

const codeOf = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'unknown error';
};

/** What the first pass learns: the main thread by findMainThread's rule, and the trace window. */
class FirstPass {
  readonly tally = new MainThreadTally();
  readonly window = new TraceWindow();
  private count = 0;

  add(e: TraceEvent): void {
    this.tally.add(e);
    if (isTimed(e)) this.window.add(e, this.count);
    this.count++;
  }

  /**
   * The window's two ends as complete events on a thread that matches nothing (NaN equals no id),
   * with the ts and dur of the events that set them, in their order in the trace. Put first, they
   * set windowStart and windowEnd exactly as all the events do: no other event passes them.
   */
  windowEvents(): TraceEvent[] {
    const { first, last } = this.window;
    const ends = first && last && first.at === last.at ? [first] : [first, last].filter((x) => x !== null);
    return ends
      .sort((a, b) => a.at - b.at)
      .map(({ event }) => ({ name: '(trace window)', ph: 'X', ts: event.ts, dur: event.dur, pid: NaN, tid: NaN }));
  }
}

/**
 * The events the summary keeps, from a trace in memory: the same two passes the file gets.
 * analyzeTrace of the result is verified equal to analyzeTrace of all the events on the traces in
 * the tests; it can differ when ts or dur is not a number, which Chrome never writes.
 */
export function reduceTraceEvents(events: TraceEvent[]): TraceEvent[] {
  const first = new FirstPass();
  for (const e of events) first.add(e);
  const main = first.tally.pick();
  return [...first.windowEvents(), ...events.filter((e) => eventsAnalysisReads(e, main))];
}

const DEVTOOLS = 'open the file in DevTools or Perfetto';

export interface SourceOptions {
  /** Picks the words for a source past the cap: a gzip inflates past it. */
  compressed: boolean;
  maxBytes?: number;
  /** Text of kept events; MAX_KEPT_BYTES by default. */
  maxKeptBytes?: number;
  timeLimitMs?: number;
  now?: () => number;
}

/**
 * The summary of a trace read twice from open(). Throws what the source throws; every other
 * failure is a reason in our own words.
 */
export async function summarizeTraceSource(
  open: () => AsyncIterable<Buffer>,
  options: SourceOptions
): Promise<{ summary: BoundedSummary } | { skipped: string }> {
  const cap = options.maxBytes ?? SUMMARY_MAX_BYTES;
  const now = options.now ?? Date.now;
  const limitMs = options.timeLimitMs ?? SUMMARY_TIME_LIMIT_MS;
  const scan = { maxBytes: cap, deadline: now() + limitMs, now };
  const why = (r: ScanResult) => {
    switch (r.end) {
      case 'invalid': return { skipped: 'The trace is not valid JSON' };
      case 'noEvents': return { skipped: 'The trace has no traceEvents array' };
      case 'timeout': return { skipped: `The summary took over ${limitMs / 1000}s; ${DEVTOOLS}` };
      case 'tooBig':
        return {
          skipped: options.compressed
            ? `The trace inflates past the ${size(cap)} summary limit; ${DEVTOOLS}`
            : `The trace is over the ${size(cap)} summary limit; ${DEVTOOLS}`,
        };
      default: return { skipped: 'The trace could not be analyzed' };
    }
  };

  const first = new FirstPass();
  const one = await scanTraceEvents(open(), (e) => {
    first.add(e as unknown as TraceEvent);
    return first.tally.threads <= MAX_THREADS;
  }, scan);
  if (one.end === 'stopped') return { skipped: `The trace has tasks on over ${MAX_THREADS} threads; ${DEVTOOLS}` };
  if (one.end !== 'done') return why(one);

  const main = first.tally.pick();
  const kept = first.windowEvents();
  let count = 0;
  const maxKeptBytes = options.maxKeptBytes ?? MAX_KEPT_BYTES;
  let keptBytes = 0;
  const two = await scanTraceEvents(open(), (e, bytes) => {
    const event = e as unknown as TraceEvent;
    if (!eventsAnalysisReads(event, main)) return true;
    keptBytes += bytes;
    if (++count > MAX_KEPT_EVENTS || keptBytes > maxKeptBytes) return false;
    kept.push(event);
    return true;
  }, scan);
  if (two.end === 'stopped') {
    return {
      skipped: count > MAX_KEPT_EVENTS
        ? `The trace has over ${MAX_KEPT_EVENTS} events the summary reads; ${DEVTOOLS}`
        : `The trace has over ${size(maxKeptBytes)} of events the summary reads; ${DEVTOOLS}`,
    };
  }
  if (two.end !== 'done') return why(two);
  // The main thread and window came from the first read: a different file now would not match them.
  if (two.events !== one.events || two.bytes !== one.bytes) return { skipped: 'The trace file changed while it was read' };

  try {
    return { summary: boundSummary(analyzeTrace(kept)) };
  } catch {
    return { skipped: 'The trace could not be analyzed' };
  }
}

/** A read failure, told apart from a gzip one: they get different reasons. */
class SourceError extends Error {
  constructor(readonly kind: 'read' | 'gzip', readonly cause: unknown) {
    super(kind);
  }
}

/**
 * The file's bytes, inflated when compressed. Ending the iteration, however it ends, destroys the
 * read stream and the gunzip, so the fd is closed even when the scan stops early.
 */
export async function* fileChunks(path: string, compressed: boolean): AsyncGenerator<Buffer> {
  const file = createReadStream(path, { highWaterMark: 1024 * 1024 });
  let readFailed = false;
  file.on('error', () => { readFailed = true; });
  const gunzip = compressed ? createGunzip({ chunkSize: 256 * 1024 }) : null;
  // pipeline, not pipe: an error or early end on either side destroys both.
  if (gunzip) pipeline(file, gunzip, () => {});
  try {
    for await (const chunk of gunzip ?? file) yield chunk as Buffer;
  } catch (error) {
    throw new SourceError(readFailed || !gunzip ? 'read' : 'gzip', error);
  } finally {
    file.destroy();
    gunzip?.destroy();
  }
}

/** What tells a file rewritten or replaced between the reads, even at the same size. */
const identity = (s: { size: number; mtimeMs: number; ino: number }) => `${s.size}:${s.mtimeMs}:${s.ino}`;

/**
 * Never throws. A reason never quotes the file: parse errors carry snippets of
 * its text, so only plain words and error codes go back.
 */
export async function summarizeTraceFile(
  path: string,
  options: { compressed: boolean; maxBytes?: number }
): Promise<{ summary: BoundedSummary } | { skipped: string }> {
  const cap = options.maxBytes ?? SUMMARY_MAX_BYTES;
  let before: string;
  try {
    // Before the read: a file the stat shows over the cap is not opened.
    const st = await stat(path);
    if (st.size > cap) {
      return { skipped: `The trace is ${size(st.size)}, over the ${size(cap)} summary limit; ${DEVTOOLS}` };
    }
    before = identity(st);
  } catch (error) {
    return { skipped: `The trace file could not be read (${codeOf(error)})` };
  }
  try {
    const result = await summarizeTraceSource(() => fileChunks(path, options.compressed), { compressed: options.compressed, maxBytes: cap });
    if ('summary' in result && identity(await stat(path)) !== before) return { skipped: 'The trace file changed while it was read' };
    return result;
  } catch (error) {
    if (error instanceof SourceError && error.kind === 'gzip') return { skipped: 'The trace file is not valid gzip' };
    if (error instanceof SourceError) return { skipped: `The trace file could not be read (${codeOf(error.cause)})` };
    return { skipped: 'The trace could not be analyzed' };
  }
}
