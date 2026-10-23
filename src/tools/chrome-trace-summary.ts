/**
 * control/chrome-trace-summary — a short, bounded summary of a trace file
 *
 * Reads a trace that stop just wrote and runs analyzeTrace over it. The trace
 * is data from a page we do not trust: function names, URLs and node names can
 * say anything, including text aimed at whoever reads the result. So the work
 * is capped by size, what comes back is capped by count and length, and a bad
 * or huge file yields a reason instead of an error.
 */

import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { analyzeTrace, type TraceEvent, type TraceSummary } from './chrome-trace.js';

const gunzipAsync = promisify(gunzip);

/**
 * Decompressed size above which the summary is skipped. JSON.parse of a trace
 * costs about 6x its size in memory (98MB / 437k events measured 581MB RSS).
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

const round = (n: number) => Math.round(n * 100) / 100;
const roundOrNull = (n: number | null) => (n === null ? null : round(n));

/** At most MAX_STRING UTF-16 units, ending in an ellipsis when cut; never half a surrogate pair. */
function truncate(s: string): string {
  if (s.length <= MAX_STRING) return s;
  let end = MAX_STRING - 1;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return s.slice(0, end) + '…';
}

export function boundSummary(s: TraceSummary): BoundedSummary {
  const { frames, vitals, profile } = s;
  return {
    windowMs: round(s.windowMs),
    mainThread: s.mainThread,
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
    // Before the read, so a huge file is never loaded.
    const onDisk = (await stat(path)).size;
    if (onDisk > cap) return tooBig(onDisk);
    raw = await readFile(path);
  } catch (error) {
    return { skipped: `The trace file could not be read (${codeOf(error)})` };
  }

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
  } else if (raw.length > cap) {
    // The file grew between the stat and the read.
    return tooBig(raw.length);
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
