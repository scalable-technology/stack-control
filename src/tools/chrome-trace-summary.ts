/**
 * control/chrome-trace-summary — a short summary of a trace file, limited in size
 *
 * Reads a trace that stop just wrote and runs analyzeTrace over it. Chrome
 * writes the structure, but function names, URLs and node names come from the
 * page and can say anything, including text aimed at whoever reads the result.
 * The input is limited by file size (SUMMARY_MAX_BYTES, decompressed); the
 * result by count (10 long tasks, 10 hot functions, 10 shifts) and string
 * length (200). A bad or oversized file yields a reason instead of an error.
 */

import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { analyzeTrace, type TraceEvent, type TraceSummary } from './chrome-trace.js';

const gunzipAsync = promisify(gunzip);

/**
 * Decompressed size above which the summary is skipped. It limits memory only as
 * far as the parse cost per byte holds: a real 98MB trace took 581MB RSS, and a
 * synthetic 120MB one took +506MB plain and +637MB gzipped (raw, inflated and
 * parsed copies at once), under a second. A trace of heavier events may cost more.
 */
export const SUMMARY_MAX_BYTES = 128 * 1024 * 1024;

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

/**
 * Never throws. A reason never quotes the file: parse errors carry snippets of
 * its text, so only plain words and error codes go back.
 */
export async function summarizeTraceFile(
  path: string,
  options: { compressed: boolean; maxBytes?: number }
): Promise<{ summary: BoundedSummary } | { skipped: string }> {
  const cap = options.maxBytes ?? SUMMARY_MAX_BYTES;
  const tooBig = (n: number) => ({
    skipped: `The trace is ${size(n)}, over the ${size(cap)} summary limit; open the file in DevTools or Perfetto`,
  });

  let raw: Buffer;
  try {
    // Before the read: a file the stat shows over the cap is not loaded.
    const onDisk = (await stat(path)).size;
    if (onDisk > cap) return tooBig(onDisk);
    raw = await readFile(path);
  } catch (error) {
    return { skipped: `The trace file could not be read (${codeOf(error)})` };
  }
  // The file grew between the stat and the read; already loaded, but not parsed.
  if (raw.length > cap) return tooBig(raw.length);

  let text: Buffer = raw;
  if (options.compressed) {
    try {
      // maxOutputLength makes a gzip that inflates past the cap fail, rather than be buffered whole.
      text = await gunzipAsync(raw, { maxOutputLength: cap });
    } catch (error) {
      if (codeOf(error) === 'ERR_BUFFER_TOO_LARGE') {
        return { skipped: `The trace inflates past the ${size(cap)} summary limit; open the file in DevTools or Perfetto` };
      }
      return { skipped: 'The trace file is not valid gzip' };
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.toString('utf8'));
  } catch {
    return { skipped: 'The trace is not valid JSON' };
  }
  // Chrome writes both forms: an object with traceEvents, or a bare array of events.
  const events = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { traceEvents?: unknown }).traceEvents)
      ? (parsed as { traceEvents: unknown[] }).traceEvents
      : null;
  if (!events) return { skipped: 'The trace has no traceEvents array' };

  try {
    return { summary: boundSummary(analyzeTrace(events as TraceEvent[])) };
  } catch {
    return { skipped: 'The trace could not be analyzed' };
  }
}
