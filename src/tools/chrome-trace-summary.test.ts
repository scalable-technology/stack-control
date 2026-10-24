import { execFileSync } from 'node:child_process';
import { accessSync, chmodSync, constants, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeTrace, type TraceEvent, type TraceSummary } from './chrome-trace.js';
import { scanTraceEvents } from './chrome-trace-stream.js';
import {
  MAX_KEPT_EVENTS,
  MAX_THREADS,
  SUMMARY_MAX_BYTES,
  boundSummary,
  fileChunks,
  reduceTraceEvents,
  summarizeTraceFile,
  summarizeTraceSource,
  type BoundedSummary,
} from './chrome-trace-summary.js';

// Test seam: stat can report a smaller size than the file has, as when the file grows after the stat.
const fsSeam = vi.hoisted(() => ({ statSize: undefined as number | undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    stat: async (path: string) => {
      const st = await real.stat(path);
      return fsSeam.statSize === undefined ? st : { ...st, size: fsSeam.statSize };
    },
  };
});

// Test seam: every read stream and gunzip the summary makes, and a hook that runs before each open.
const streams = vi.hoisted(() => ({
  reads: [] as { destroyed: boolean; bytesRead: number }[],
  gunzips: [] as { destroyed: boolean }[],
  opens: 0,
  beforeOpen: undefined as ((path: string, n: number) => void) | undefined,
}));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    createReadStream: (...args: Parameters<typeof real.createReadStream>) => {
      streams.beforeOpen?.(String(args[0]), ++streams.opens);
      const stream = real.createReadStream(...args);
      streams.reads.push(stream);
      return stream;
    },
  };
});
vi.mock('node:zlib', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:zlib')>();
  return {
    ...real,
    createGunzip: (...args: Parameters<typeof real.createGunzip>) => {
      const stream = real.createGunzip(...args);
      streams.gunzips.push(stream);
      return stream;
    },
  };
});

const MAIN = { pid: 1, tid: 10 };

/** Complete event on the main thread; ts and dur in milliseconds. */
const task = (tsMs: number, durMs: number): TraceEvent => ({
  name: 'RunTask', cat: 'toplevel', ph: 'X', ts: tsMs * 1000, dur: durMs * 1000, ...MAIN,
});

const EVENTS: TraceEvent[] = [
  { name: 'thread_name', ph: 'M', ts: 0, ...MAIN, args: { name: 'CrRendererMain' } },
  task(0, 120),
  task(200, 10),
];

const fixture = (name: string) => fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'control-summary-test-'));
});
afterEach(() => {
  fsSeam.statSize = undefined;
  streams.reads.length = 0;
  streams.gunzips.length = 0;
  streams.opens = 0;
  streams.beforeOpen = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, data: string | Buffer): string => {
  const path = join(dir, name);
  writeFileSync(path, data);
  return path;
};

const summaryOf = (r: { summary: BoundedSummary } | { skipped: string }): BoundedSummary => {
  if (!('summary' in r)) throw new Error(`expected a summary, got skipped: ${r.skipped}`);
  return r.summary;
};

const skippedOf = (r: { summary: BoundedSummary } | { skipped: string }): string => {
  if (!('skipped' in r)) throw new Error('expected the summary to be skipped');
  return r.skipped;
};

describe('summarizeTraceFile', () => {
  it('gives the same summary for plain and gzipped files of the same trace', async () => {
    const text = JSON.stringify({ traceEvents: EVENTS });
    const plain = summaryOf(await summarizeTraceFile(write('t.json', text), { compressed: false }));
    const gz = summaryOf(await summarizeTraceFile(write('t.json.gz', gzipSync(text)), { compressed: true }));
    expect(gz).toEqual(plain);
    expect(plain.longTasks).toEqual([{ startMs: 0, durationMs: 120 }]);
    expect(plain.longTaskCount).toBe(1);
    expect(plain.mainThread).toEqual(MAIN);
  });

  it('accepts the bare-array trace format', async () => {
    const wrapped = summaryOf(await summarizeTraceFile(write('a.json', JSON.stringify({ traceEvents: EVENTS })), { compressed: false }));
    const bare = summaryOf(await summarizeTraceFile(write('b.json', JSON.stringify(EVENTS)), { compressed: false }));
    expect(bare).toEqual(wrapped);
    expect(bare.longTasks[0].durationMs).toBe(120);
  });

  it('skips a file over the cap without reading it', async () => {
    const path = write('big.json', JSON.stringify({ traceEvents: EVENTS }) + ' '.repeat(2000));
    // Unreadable: if the cap check did not come first, the read would fail with a different reason.
    chmodSync(path, 0o000);
    expect(skippedOf(await summarizeTraceFile(path, { compressed: false }))).toMatch(/could not be read/);
    const reason = skippedOf(await summarizeTraceFile(path, { compressed: false, maxBytes: 1000 }));
    expect(reason).toMatch(/over the 1000 bytes summary limit/);
    expect(reason).not.toMatch(/could not be read/);
  });

  it('refuses a gzip that inflates past the cap instead of buffering it', async () => {
    const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x20));
    expect(bomb.length).toBeLessThan(64 * 1024);
    const reason = skippedOf(await summarizeTraceFile(write('bomb.json.gz', bomb), { compressed: true, maxBytes: 1024 * 1024 }));
    expect(reason).toBe('The trace inflates past the 1MB summary limit; open the file in DevTools or Perfetto');
  });

  it.each([
    ['corrupt gzip', 'x.json.gz', true, Buffer.from('SECRET-TEXT not gzip at all'), 'The trace file is not valid gzip'],
    ['truncated gzip', 'y.json.gz', true, gzipSync('{"traceEvents":[{"name":"SECRET-TEXT"}]}').subarray(0, 20), 'The trace file is not valid gzip'],
    ['random bytes gzipped', 'r.json.gz', true, gzipSync(Buffer.concat([Buffer.from('['), randomBytes(1500)])), 'The trace is not valid JSON'],
    ['truncated JSON', 'x.json', false, '{"traceEvents":[{"name":"SECRET-TEXT', 'The trace is not valid JSON'],
    ['an event JSON.parse refuses', 'b.json', false, '{"traceEvents":[{"name":SECRET-TEXT}]}', 'The trace is not valid JSON'],
    ['a JSON number', 'n.json', false, '42', 'The trace has no traceEvents array'],
    ['an object without traceEvents', 'o.json', false, '{"SECRET-TEXT":[1,2,3]}', 'The trace has no traceEvents array'],
  ])('skips %s and says why without quoting the file', async (_label, name, compressed, data, why) => {
    const reason = skippedOf(await summarizeTraceFile(write(name, data), { compressed }));
    expect(reason).toBe(why);
  });

  // Changed with the streaming summary: events that are not objects used to fail the whole summary.
  it('skips events that are not objects and summarizes the rest', async () => {
    const text = JSON.stringify({ traceEvents: [null, 'SECRET-TEXT', 7, [1], ...EVENTS] });
    const s = summaryOf(await summarizeTraceFile(write('e.json', text), { compressed: false }));
    expect(s).toStrictEqual(boundSummary(analyzeTrace(EVENTS)));
  });

  // Changed with the streaming summary: the size past the cap is not known, since the read stops there.
  it('skips a plain file that grew past the cap after the stat', async () => {
    const path = write('grown.json', Buffer.alloc(2000, 0x20));
    fsSeam.statSize = 10;
    const reason = skippedOf(await summarizeTraceFile(path, { compressed: false, maxBytes: 1000 }));
    expect(reason).toBe('The trace is over the 1000 bytes summary limit; open the file in DevTools or Perfetto');
  });

  it('keeps structure from a hand-written file out of the result', async () => {
    const events = [
      // Chrome writes pid as a number; a string here must not reach mainThread.
      { name: 'thread_name', ph: 'M', ts: 0, pid: 'p'.repeat(1024 * 1024), tid: 10, args: { name: 'CrRendererMain' } },
      { name: 'RunTask', ph: 'X', ts: 0, dur: 1000, pid: 'p'.repeat(1024 * 1024), tid: 10 },
      { name: 'navigationStart', ph: 'R', ts: 0, pid: 1, tid: 10, args: { frame: 'main' } },
      {
        name: 'largestContentfulPaint::Candidate', ph: 'R', ts: 5000, pid: 1, tid: 10,
        args: { frame: 'main', data: { isOutermostMainFrame: true, type: 'text', nodeName: 'P', size: 1e308 } },
      },
      { name: 'LayoutShift', ph: 'I', ts: 1000, pid: 1, tid: 10, args: { data: { score: -0.001, had_recent_input: false } } },
    ];
    const s = summaryOf(await summarizeTraceFile(write('h.json', JSON.stringify({ traceEvents: events })), { compressed: false }));
    expect(s.mainThread).toBeNull();
    expect(JSON.stringify(s).length).toBeLessThan(3000);
    expect(s.vitals.lcp).toEqual({ ms: 5, type: 'text', nodeName: 'P', size: 1e308 });
    expect(s.vitals.shifts).toHaveLength(1);
    expect(Object.is(s.vitals.shifts[0].score, 0)).toBe(true);
  });

  it('skips a missing file with a plain reason instead of throwing', async () => {
    const reason = skippedOf(await summarizeTraceFile(join(dir, 'nope.json'), { compressed: false }));
    expect(reason).toMatch(/could not be read \(ENOENT\)/);
  });

  it('summarizes the real profile fixture to the numbers analyzeTrace pins, in under 3000 characters', async () => {
    const s = summaryOf(await summarizeTraceFile(fixture('profile-real.json'), { compressed: false }));
    expect(s.profile).not.toBeNull();
    expect(s.profile!.hot[0]).toMatchObject({ name: 'tick', url: 'http://localhost/page.html', line: 5, column: 17, selfMs: 1.81 });
    expect(s.profile!.sampledMs).toBe(1283.99);
    expect(JSON.stringify(s).length).toBeLessThan(3000);
  });

  it('summarizes the real vitals fixture to the CLS and LCP analyzeTrace pins', async () => {
    const s = summaryOf(await summarizeTraceFile(fixture('vitals-real.json'), { compressed: false }));
    expect(s.vitals.cls).toBe(0.23);
    expect(s.vitals.shiftCount).toBe(2);
    expect(s.vitals.lcp).toEqual({ ms: 51.03, type: 'text', nodeName: 'P', size: 23828 });
  });
});

describe('boundSummary', () => {
  const base = (): TraceSummary => analyzeTrace([]);

  it('lists the 10 longest tasks, longest first, and counts them all', () => {
    const longTasks = Array.from({ length: 200 }, (_, i) => ({ startMs: i * 100, durationMs: 51 + ((i * 37) % 150) }));
    const b = boundSummary({ ...base(), longTasks });
    const expected = [...longTasks].sort((x, y) => y.durationMs - x.durationMs).slice(0, 10);
    expect(b.longTasks).toEqual(expected);
    expect(b.longTasks[0].durationMs).toBe(200);
    expect(b.longTaskCount).toBe(200);
  });

  it('truncates page strings to 200 characters ending in an ellipsis', () => {
    const long = 'f'.repeat(5000);
    const b = boundSummary({
      ...base(),
      vitals: { ...base().vitals, lcp: { ms: 1, type: 't'.repeat(300), nodeName: 'N'.repeat(300), size: 1 } },
      profile: {
        sampledMs: 1, idleMs: 0, programMs: 0,
        hot: [
          { name: long, url: long, line: 1, column: 1, selfMs: 1, selfPct: 100 },
          { name: 'tick', url: 'http://x/', line: null, column: null, selfMs: 1, selfPct: 1 },
        ],
      },
    });
    const hot = b.profile!.hot[0];
    for (const s of [hot.name, hot.url, b.vitals.lcp!.nodeName, b.vitals.lcp!.type]) {
      expect(s).toHaveLength(200);
      expect(s.endsWith('…')).toBe(true);
    }
    expect(hot.name).toBe('f'.repeat(199) + '…');
    expect(b.profile!.hot[1]).toMatchObject({ name: 'tick', url: 'http://x/' });
  });

  it('does not split a surrogate pair at the cut', () => {
    const name = 'a'.repeat(198) + '😀' + 'b'.repeat(100);
    const b = boundSummary({
      ...base(),
      profile: { sampledMs: 1, idleMs: 0, programMs: 0, hot: [{ name, url: '', line: null, column: null, selfMs: 1, selfPct: 100 }] },
    });
    expect(b.profile!.hot[0].name).toBe('a'.repeat(198) + '…');
  });

  it('rounds numbers to 2 decimals and keeps nulls', () => {
    const s = base();
    const b = boundSummary({
      ...s,
      windowMs: 1234.56789,
      busyPct: 33.333333,
      longTasks: [{ startMs: 1.005001, durationMs: 120.126 }],
      categoryMs: { ...s.categoryMs, scripting: 9.876 },
      frames: { ...s.frames, fps: 59.9412, p50Ms: 16.6666, p95Ms: null },
      vitals: { ...s.vitals, cls: 0.234229, lcp: { ms: 51.032, type: 'text', nodeName: 'P', size: 23828 }, shifts: [{ atMs: 10.556, score: 0.12345 }] },
      profile: { sampledMs: 1283.987, idleMs: 0.004, programMs: 44.267, hot: [{ name: 'tick', url: '', line: 5, column: 17, selfMs: 1.806, selfPct: 3.88888 }] },
    });
    expect(b.windowMs).toBe(1234.57);
    expect(b.busyPct).toBe(33.33);
    expect(b.longTasks).toEqual([{ startMs: 1.01, durationMs: 120.13 }]);
    expect(b.categoryMs.scripting).toBe(9.88);
    expect(b.frames).toMatchObject({ fps: 59.94, p50Ms: 16.67, p95Ms: null, p99Ms: null, maxMs: null });
    expect(b.vitals).toMatchObject({ cls: 0.23, lcp: { ms: 51.03, size: 23828 }, shifts: [{ atMs: 10.56, score: 0.12 }] });
    expect(b.profile).toMatchObject({ sampledMs: 1283.99, idleMs: 0, programMs: 44.27 });
    expect(b.profile!.hot[0]).toMatchObject({ selfMs: 1.81, selfPct: 3.89, line: 5, column: 17 });
  });

  it('keeps mainThread only when pid and tid are finite numbers', () => {
    const at = (mainThread: unknown) => boundSummary({ ...base(), mainThread } as unknown as TraceSummary).mainThread;
    expect(at({ pid: 1, tid: 10 })).toEqual({ pid: 1, tid: 10 });
    expect(at({ pid: 'p'.repeat(1000), tid: 10 })).toBeNull();
    expect(at({ pid: 1, tid: NaN })).toBeNull();
    expect(at({ pid: Infinity, tid: 1 })).toBeNull();
  });

  it('turns page strings that are not strings into empty strings', () => {
    const b = boundSummary({
      ...base(),
      vitals: { ...base().vitals, lcp: { ms: 1, type: ['t'.repeat(10000)], nodeName: { x: 1 }, size: 1 } },
      profile: { sampledMs: 1, idleMs: 0, programMs: 0, hot: [{ name: 42, url: null, line: null, column: null, selfMs: 1, selfPct: 100 }] },
    } as unknown as TraceSummary);
    expect(b.vitals.lcp).toMatchObject({ type: '', nodeName: '' });
    expect(b.profile!.hot[0]).toMatchObject({ name: '', url: '' });
  });

  it('rounds without overflowing, writes -0 as 0, and leaves NaN and Infinity as they are', () => {
    const b = boundSummary({
      ...base(),
      windowMs: 1e308,
      busyPct: -0.001,
      categoryMs: { ...base().categoryMs, scripting: NaN, layout: Infinity },
    });
    expect(b.windowMs).toBe(1e308);
    expect(Object.is(b.busyPct, 0)).toBe(true);
    expect(b.categoryMs.scripting).toBeNaN();
    expect(b.categoryMs.layout).toBe(Infinity);
  });

  it('keeps a null LCP, main thread and profile as null', () => {
    const b = boundSummary(base());
    expect(b.vitals.lcp).toBeNull();
    expect(b.mainThread).toBeNull();
    expect(b.profile).toBeNull();
    expect(b.longTaskCount).toBe(0);
  });
});

// --- The streaming summary: the reduced events must give what all the events give ---

const fixtureEvents = (name: string): TraceEvent[] =>
  (JSON.parse(readFileSync(fixture(name), 'utf8')) as { traceEvents: TraceEvent[] }).traceEvents;

const at = (pid: number | string, tid: number | string) => ({ pid, tid }) as { pid: number; tid: number };
const thread = (where: { pid: number; tid: number }, name: string): TraceEvent => ({ name: 'thread_name', ph: 'M', ts: 0, ...where, args: { name } });
const x = (name: string, tsMs: number, durMs: number, where = MAIN): TraceEvent => ({ name, ph: 'X', ts: tsMs * 1000, dur: durMs * 1000, ...where });
const instant = (name: string, tsMs: number, where: { pid: number; tid: number }, args: Record<string, unknown>): TraceEvent =>
  ({ name, ph: 'I', ts: tsMs * 1000, ...where, args });

const COMPOSITOR = { pid: 1, tid: 12 };
const OTHER = { pid: 2, tid: 20 };
const node = (id: number, functionName: string) => ({ id, callFrame: { functionName, url: functionName === 'tick' ? 'http://x/' : '' } });
const NODES = [node(1, '(root)'), node(2, 'tick'), node(3, '(idle)'), node(4, '(program)')];

/** Every kind of event an analyzer reads, among the kinds it does not, on several threads. */
const BUSY_PAGE: TraceEvent[] = [
  // The window is set by events on other threads: earliest on pid 2, latest end on pid 3.
  x('GPUTask', 0.5, 1, OTHER),
  thread(MAIN, 'CrRendererMain'),
  thread(COMPOSITOR, 'Compositor'),
  thread(OTHER, 'CrRendererMain'),
  x('RunTask', 10, 120), x('FunctionCall', 12, 60), x('Layout', 80, 20), x('Paint', 101, 5), x('MajorGC', 110, 10),
  x('ThreadControllerImpl::RunTask', 10, 119), { name: 'NoDuration', ph: 'X', ts: 9000, ...MAIN },
  x('RunTask', 200, 30), x('v8.compile', 201, 3), x('UpdateLayoutTree', 210, 4), x('Commit', 220, 2),
  x('RunTask', 5, 40, OTHER), x('RunTask', 300, 400, COMPOSITOR), x('Receive mojo message', 15, 1, COMPOSITOR),
  { name: 'flow', ph: 's', ts: 11_000, id: 1, ...MAIN }, { name: 'flow', ph: 'f', ts: 12_000, id: 1, ...OTHER },
  { name: 'Begin', ph: 'B', ts: 13_000, ...MAIN }, { name: 'Begin', ph: 'E', ts: 14_000, ...MAIN },
  ...[0, 16.7, 33.4, 50.1, 120, 136.7].map((t, i) => instant('DrawFrame', 100 + t, COMPOSITOR, { layerTreeId: 2, frameSeqId: i })),
  instant('DrawFrame', 101, OTHER, { layerTreeId: 9, frameSeqId: 1 }),
  { ...instant('DrawFrame', 102, COMPOSITOR, { layerTreeId: 2, frameSeqId: 50 }), ph: 'b' },
  instant('DroppedFrame', 190, COMPOSITOR, { layerTreeId: 2, frameSeqId: 4 }),
  instant('DroppedFrame', 191, COMPOSITOR, { layerTreeId: 2, frameSeqId: 77 }),
  { name: 'navigationStart', ph: 'R', ts: 1000, ...MAIN, args: { frame: 'F', data: { navigationId: 'N' } } },
  { name: 'largestContentfulPaint::Candidate', ph: 'R', ts: 1051_000, ...MAIN,
    args: { frame: 'F', data: { navigationId: 'N', isOutermostMainFrame: true, type: 'text', nodeName: 'P', size: 500, candidateIndex: 1 } } },
  instant('LayoutShift', 300, MAIN, { data: { score: 0.125, had_recent_input: false } }),
  instant('LayoutShift', 900, MAIN, { data: { score: 0.5, had_recent_input: true } }),
  { name: 'Profile', ph: 'P', ts: 0, ...MAIN, id: '0x1' },
  { name: 'Profile', ph: 'P', ts: 0, ...OTHER, id: '0x9' },
  { name: 'ProfileChunk', ph: 'P', ts: 20, pid: 1, tid: 99, id: '0x1',
    args: { data: { cpuProfile: { nodes: NODES, samples: [2, 2, 3, 4, 2] }, timeDeltas: [1000, 1500, 2000, 500, 250] } } },
  { name: 'ProfileChunk', ph: 'P', ts: 10, pid: 2, tid: 98, id: '0x9',
    args: { data: { cpuProfile: { nodes: NODES, samples: [2, 2] }, timeDeltas: [1000, 9000] } } },
  x('VizCompositor', 9000, 3000, { pid: 3, tid: 30 }),
];

/** Two renderer main threads with equal task time: the first one named is the main thread. */
const TIE: TraceEvent[] = [
  thread(OTHER, 'CrRendererMain'),
  thread(MAIN, 'CrRendererMain'),
  x('RunTask', 0, 100, MAIN), x('Layout', 10, 20, MAIN),
  x('RunTask', 0, 100, OTHER), x('FunctionCall', 10, 20, OTHER),
];

/**
 * Task time is summed per `${pid}:${tid}`, while the main thread's events match pid and tid exactly:
 * a RunTask with a string pid counts toward the main thread's time but is none of its tasks. Here it
 * is what lifts that time above -1 (Chrome writes neither form; the rule must still be the one rule).
 */
const MIXED_IDS: TraceEvent[] = [
  thread(MAIN, 'CrRendererMain'),
  x('RunTask', 0, -5, MAIN),
  x('RunTask', 50, 10, at('1', 10)),
  x('Layout', 1, 2, MAIN),
];

/** No renderer main thread at all: frames, vitals and the window still count. */
const NO_MAIN: TraceEvent[] = [
  x('RunTask', 0, 10, OTHER),
  ...[0, 16, 40].map((t, i) => instant('DrawFrame', t, COMPOSITOR, { layerTreeId: 1, frameSeqId: i })),
  instant('LayoutShift', 5, OTHER, { data: { score: 0.25 } }),
];

/** Events no analyzer reads, on threads that are not the main one; cat marks them. */
const NOISE: TraceEvent[] = [
  { name: 'GPUTask', cat: 'noise', ph: 'X', ts: 150_000, dur: 10, pid: 77, tid: 1 },
  { name: 'Receive mojo message', cat: 'noise', ph: 'X', ts: 151_000, dur: 5, pid: 77, tid: 2 },
  { name: 'RunTask', cat: 'noise', ph: 'X', ts: 152_000, dur: 5, pid: 77, tid: 3 },
  { name: 'flow', cat: 'noise', ph: 's', ts: 153_000, id: 9, pid: 77, tid: 1 },
  { name: 'flow', cat: 'noise', ph: 'f', ts: 154_000, id: 9, pid: 77, tid: 2 },
  { name: 'Async', cat: 'noise', ph: 'b', ts: 155_000, id: 3, pid: 77, tid: 1 },
  { name: 'Async', cat: 'noise', ph: 'e', ts: 156_000, id: 3, pid: 77, tid: 1 },
  { name: 'Counter', cat: 'noise', ph: 'C', ts: 157_000, pid: 77, tid: 1, args: { n: 1 } },
  { name: 'thread_name', cat: 'noise', ph: 'M', ts: 0, pid: 77, tid: 1, args: { name: 'VizCompositorThread' } },
];

const TRACES: [string, () => TraceEvent[]][] = [
  ['the busy synthetic page', () => BUSY_PAGE],
  ['a tie between two main threads', () => TIE],
  ['mixed id types', () => MIXED_IDS],
  ['no main thread', () => NO_MAIN],
  ['an empty trace', () => []],
  ['the unit-test events', () => EVENTS],
  ['frames-real.json', () => fixtureEvents('frames-real.json')],
  ['frames-devtools.json', () => fixtureEvents('frames-devtools.json')],
  ['profile-real.json', () => fixtureEvents('profile-real.json')],
  ['vitals-real.json', () => fixtureEvents('vitals-real.json')],
];

describe('reduceTraceEvents', () => {
  it.each(TRACES)('gives analyzeTrace the same summary as all the events: %s', (_label, events) => {
    const all = events();
    expect(analyzeTrace(reduceTraceEvents(all))).toStrictEqual(analyzeTrace(all));
  });

  // A trace that keeps everything proves nothing about the rule: the same, with events to drop.
  it.each(TRACES)('drops what no analyzer reads and still gives the same summary: %s plus noise', (_label, events) => {
    const all = [...events(), ...NOISE];
    const reduced = reduceTraceEvents(all);
    expect(analyzeTrace(reduced)).toStrictEqual(analyzeTrace(all));
    expect(reduced.filter((e) => e.cat === 'noise')).toEqual([]);
    expect(reduced.filter((e) => e.name !== '(trace window)').length).toBeLessThan(all.length);
  });

  it.each([
    ['the busy synthetic page', () => BUSY_PAGE],
    ['a tie between two main threads', () => TIE],
    ['no main thread', () => NO_MAIN],
    ['frames-real.json', () => fixtureEvents('frames-real.json')],
    ['frames-devtools.json', () => fixtureEvents('frames-devtools.json')],
    ['vitals-real.json', () => fixtureEvents('vitals-real.json')],
  ])('drops events from %s as it is', (_label, events) => {
    const all = events();
    expect(reduceTraceEvents(all).filter((e) => e.name !== '(trace window)').length).toBeLessThan(all.length);
  });

  it('keeps the events the analyzers read and drops the rest', () => {
    const reduced = reduceTraceEvents(BUSY_PAGE);
    const names = new Set(reduced.map((e) => e.name));
    for (const kept of ['DrawFrame', 'DroppedFrame', 'LayoutShift', 'navigationStart', 'largestContentfulPaint::Candidate',
      'Profile', 'ProfileChunk', 'thread_name', 'RunTask', 'FunctionCall', 'Layout', 'Paint', 'ThreadControllerImpl::RunTask']) {
      expect(names, kept).toContain(kept);
    }
    for (const dropped of ['Receive mojo message', 'flow', 'Begin', 'NoDuration']) expect(names, dropped).not.toContain(dropped);
    // Only the main thread's tasks, its name, its profile and the chunks of its process.
    expect(reduced.filter((e) => e.name === 'RunTask').map((e) => e.pid)).toEqual([1, 1]);
    expect(reduced.filter((e) => e.name === 'thread_name')).toEqual([thread(MAIN, 'CrRendererMain')]);
    expect(reduced.filter((e) => e.name === 'Profile').map((e) => e.id)).toEqual(['0x1']);
    expect(reduced.filter((e) => e.name === 'ProfileChunk').map((e) => e.pid)).toEqual([1]);
    // The async DrawFrame is not a frame; the instants on every compositor are.
    expect(reduced.filter((e) => e.name === 'DrawFrame')).toHaveLength(7);
  });

  it('carries the window in two events at the front that match no thread', () => {
    const reduced = reduceTraceEvents(BUSY_PAGE);
    const [first, second] = reduced;
    expect(first).toMatchObject({ ph: 'X', ts: 500, dur: 1000 });
    expect(second).toMatchObject({ ph: 'X', ts: 9_000_000, dur: 3_000_000 });
    for (const e of [first, second]) {
      expect(e.pid).toBeNaN();
      expect(e.tid).toBeNaN();
    }
    expect(reduced.filter((e) => e.name === 'GPUTask' || e.name === 'VizCompositor')).toEqual([]);
  });

  it('carries one window event when one event sets both ends', () => {
    const reduced = reduceTraceEvents([thread(MAIN, 'CrRendererMain'), x('RunTask', 0, 1000, OTHER), x('RunTask', 10, 10)]);
    expect(reduced.filter((e) => Number.isNaN(e.pid))).toHaveLength(1);
  });
});

/** A source that gives these buffers each time it is opened. */
const sourceOf = (...parts: (string | Buffer)[]) => () =>
  (async function* () {
    for (const p of parts) yield typeof p === 'string' ? Buffer.from(p) : p;
  })();

describe('summarizeTraceFile: streaming', () => {
  it.each(TRACES)('gives boundSummary(analyzeTrace) of the whole file, plain and gzipped: %s', async (_label, events) => {
    const all = events();
    const text = JSON.stringify({ traceEvents: all, metadata: { source: 'test' } });
    const expected = boundSummary(analyzeTrace(all));
    expect(summaryOf(await summarizeTraceFile(write('t.json', text), { compressed: false }))).toStrictEqual(expected);
    expect(summaryOf(await summarizeTraceFile(write('t.json.gz', gzipSync(text)), { compressed: true }))).toStrictEqual(expected);
  });

  it('allows 1GiB inflated by default', () => {
    expect(SUMMARY_MAX_BYTES).toBe(1024 * 1024 * 1024);
  });

  it(`skips a trace with more than ${MAX_KEPT_EVENTS} events the summary keeps, generated lazily`, async () => {
    const block = '{"name":"a","ph":"X","pid":1,"tid":10,"ts":1,"dur":1},'.repeat(10_000);
    const open = () => (async function* () {
      yield Buffer.from(`[${JSON.stringify(EVENTS[0])},`);
      for (let i = 0; i < 500; i++) yield Buffer.from(block); // 5 million events
      yield Buffer.from('{}]');
    })();
    const r = await summarizeTraceSource(open, { compressed: false });
    expect(skippedOf(r)).toBe(`The trace has over ${MAX_KEPT_EVENTS} events the summary reads; open the file in DevTools or Perfetto`);
  }, 120_000);

  it(`skips a trace with tasks on more than ${MAX_THREADS} threads`, async () => {
    const events = Array.from({ length: MAX_THREADS + 1 }, (_, i) => x('RunTask', i, 1, { pid: 1, tid: 100 + i }));
    const r = await summarizeTraceSource(sourceOf(JSON.stringify(events)), { compressed: false });
    expect(skippedOf(r)).toBe(`The trace has tasks on over ${MAX_THREADS} threads; open the file in DevTools or Perfetto`);
    const fits = events.slice(0, MAX_THREADS);
    expect(summaryOf(await summarizeTraceSource(sourceOf(JSON.stringify(fits)), { compressed: false })).windowMs).toBe(MAX_THREADS);
  });

  it('skips a summary that runs past its time limit, on its clock', async () => {
    let t = 0;
    const text = JSON.stringify({ traceEvents: BUSY_PAGE });
    const r = await summarizeTraceSource(sourceOf(text.slice(0, 50), text.slice(50)), { compressed: false, timeLimitMs: 60_000, now: () => (t += 40_000) });
    expect(skippedOf(r)).toBe('The summary took over 60s; open the file in DevTools or Perfetto');
  });

  it('allows 60s by default', async () => {
    let t = 0;
    const text = JSON.stringify({ traceEvents: BUSY_PAGE });
    // Each read of the clock is 1s later: well under 60 reads gives a summary.
    expect('summary' in await summarizeTraceSource(sourceOf(text), { compressed: false, now: () => (t += 1000) })).toBe(true);
    t = 0;
    expect(skippedOf(await summarizeTraceSource(sourceOf(text), { compressed: false, now: () => (t += 61_000) })))
      .toBe('The summary took over 60s; open the file in DevTools or Perfetto');
  });

  it('skips a file that changed between its two reads', async () => {
    let opened = 0;
    const texts = [JSON.stringify(EVENTS), JSON.stringify([...EVENTS, x('RunTask', 300, 100)])];
    const open = () => sourceOf(texts[opened++])();
    expect(skippedOf(await summarizeTraceSource(open, { compressed: false }))).toBe('The trace file changed while it was read');
  });

  it(`counts a thread that has both a name and task time once toward ${MAX_THREADS}`, async () => {
    const events: TraceEvent[] = [];
    for (let i = 0; i < 6000; i++) {
      const where = { pid: 1, tid: 100 + i };
      events.push(thread(where, 'CrRendererMain'), x('RunTask', i, 1, where));
    }
    expect('summary' in await summarizeTraceSource(sourceOf(JSON.stringify(events)), { compressed: false })).toBe(true);
  });

  it('skips a file rewritten between its reads with the same size and event count', async () => {
    const path = write('same.json', JSON.stringify(EVENTS));
    const edited = JSON.stringify(EVENTS).replace('"dur":120000', '"dur":130000');
    expect(edited.length).toBe(JSON.stringify(EVENTS).length);
    streams.beforeOpen = (_p, n) => {
      if (n !== 2) return;
      writeFileSync(path, edited);
      const later = new Date(Date.now() + 2000);
      utimesSync(path, later, later);
    };
    expect(skippedOf(await summarizeTraceFile(path, { compressed: false }))).toBe('The trace file changed while it was read');
  });

  it('skips a file replaced between its reads by one of the same size and time', async () => {
    const path = write('swap.json', JSON.stringify(EVENTS));
    // A whole second, so both files can carry exactly the same mtime: only the inode tells them apart.
    const at = new Date(Math.floor(Date.now() / 1000) * 1000 - 5000);
    utimesSync(path, at, at);
    streams.beforeOpen = (_p, n) => {
      if (n !== 2) return;
      const other = write('swap.tmp', JSON.stringify(EVENTS).replace('"dur":120000', '"dur":130000'));
      utimesSync(other, at, at);
      renameSync(other, path);
      expect(statSync(path).mtimeMs).toBe(at.getTime());
    };
    expect(skippedOf(await summarizeTraceFile(path, { compressed: false }))).toBe('The trace file changed while it was read');
  });

  it('keeps names like __proto__ and constructor as data, and pollutes nothing', async () => {
    const names = ['__proto__', 'constructor', 'hasOwnProperty', 'toString'];
    const events: TraceEvent[] = [
      thread(MAIN, 'CrRendererMain'),
      x('RunTask', 0, 100), ...names.map((n, i) => x(n, 1 + i * 10, 5)),
      ...[0, 16, 33].map((t, i) => instant('DrawFrame', t, COMPOSITOR, { layerTreeId: '__proto__', frameSeqId: i })),
      instant('DroppedFrame', 20, COMPOSITOR, { layerTreeId: '__proto__', frameSeqId: 1 }),
      { name: 'navigationStart', ph: 'R', ts: 0, ...MAIN, args: { frame: '__proto__', data: { navigationId: 'constructor' } } },
      { name: 'largestContentfulPaint::Candidate', ph: 'R', ts: 40_000, ...MAIN,
        args: { frame: '__proto__', data: { navigationId: 'constructor', isOutermostMainFrame: true, type: 'toString', nodeName: '__proto__', size: 9 } } },
      { name: 'Profile', ph: 'P', ts: 0, ...MAIN, id: '__proto__' },
      { name: 'ProfileChunk', ph: 'P', ts: 1, pid: 1, tid: 99, id: '__proto__',
        args: { data: { cpuProfile: { nodes: [{ id: 1, callFrame: { functionName: '(root)' } },
          ...names.map((n, i) => ({ id: i + 2, callFrame: { functionName: n, url: n } }))], samples: [2, 3, 4, 5, 1] }, timeDeltas: [1000, 2000, 3000, 4000, 5000] } } },
    ];
    const text = JSON.stringify({ traceEvents: events }).replace('{"name":"RunTask"', '{"__proto__":{"polluted":1},"name":"RunTask"');
    const s = summaryOf(await summarizeTraceFile(write('proto.json', text), { compressed: false }));
    expect(s).toStrictEqual(boundSummary(analyzeTrace(JSON.parse(text).traceEvents)));
    expect(s.profile!.hot.map((f) => [f.name, f.selfMs])).toEqual([['toString', 5], ['hasOwnProperty', 4], ['constructor', 3], ['__proto__', 2]]);
    expect(s.frames).toMatchObject({ count: 3, chromeDropped: 1, chromeDroppedDrawn: 1 });
    expect(s.vitals.lcp).toEqual({ ms: 40, type: 'toString', nodeName: '__proto__', size: 9 });
    expect(s.categoryMs.other).toBe(100);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  describe('closes the file and the gunzip on every way out', () => {
    const allDestroyed = () => {
      expect(streams.reads.length).toBeGreaterThan(0);
      for (const s of [...streams.reads, ...streams.gunzips]) expect(s.destroyed).toBe(true);
    };
    // 8MB of metadata after the array: a pass that reads to the end of the file did not stop early.
    const tail = `,"metadata":{"pad":"${'p'.repeat(8 * 1024 * 1024)}"}}`;
    const valid = `{"traceEvents":${JSON.stringify(EVENTS)}${tail}`;

    it.each([false, true])('at the end of the array, before the rest of the file (gzip %s)', async (gz) => {
      const path = write(gz ? 'v.json.gz' : 'v.json', gz ? gzipSync(valid) : valid);
      expect('summary' in await summarizeTraceFile(path, { compressed: gz })).toBe(true);
      allDestroyed();
      expect(streams.reads).toHaveLength(2);
      if (!gz) for (const s of streams.reads) expect(s.bytesRead).toBeLessThan(statSync(path).size);
    });

    it.each([
      ['not valid JSON', '{"traceEvents":[{"a":1', 'The trace is not valid JSON'],
      ['no traceEvents', '{"a":1}', 'The trace has no traceEvents array'],
    ])('on %s', async (_label, text, why) => {
      for (const gz of [false, true]) {
        streams.reads.length = 0;
        const path = write(gz ? 'b.json.gz' : 'b.json', gz ? gzipSync(text) : text);
        expect(skippedOf(await summarizeTraceFile(path, { compressed: gz }))).toBe(why);
        allDestroyed();
      }
    });

    it.each([false, true])('at the byte cap (gzip %s)', async (gz) => {
      const text = '[' + ' '.repeat(4 * 1024 * 1024) + ']';
      fsSeam.statSize = 10;
      const path = write(gz ? 'c.json.gz' : 'c.json', gz ? gzipSync(text) : text);
      expect(skippedOf(await summarizeTraceFile(path, { compressed: gz, maxBytes: 1024 * 1024 }))).toMatch(/summary limit/);
      allDestroyed();
    });

    it('on a gzip error', async () => {
      // The events come after the padding, so the corruption is met before the array ends.
      const late = `{"metadata":{"pad":"${'p'.repeat(8 * 1024 * 1024)}"},"traceEvents":${JSON.stringify(EVENTS)}}`;
      const path = write('d.json.gz', Buffer.concat([gzipSync(late).subarray(0, 4000), Buffer.alloc(4000, 7)]));
      expect(skippedOf(await summarizeTraceFile(path, { compressed: true }))).toBe('The trace file is not valid gzip');
      allDestroyed();
    });

    it('when the consumer stops or throws, and at the deadline', async () => {
      const path = write('e.json.gz', gzipSync(valid));
      const scan = { maxBytes: 1 << 30, deadline: Infinity };
      expect(await scanTraceEvents(fileChunks(path, true), () => false, scan)).toEqual({ end: 'stopped' });
      await expect(scanTraceEvents(fileChunks(path, true), () => { throw new Error('consumer'); }, scan)).rejects.toThrow('consumer');
      // The clock jumps past the deadline after the first chunk, which is padding: the array is still open.
      const late = write('f.json.gz', gzipSync(`{"metadata":{"pad":"${'p'.repeat(8 * 1024 * 1024)}"},"traceEvents":[]}`));
      let calls = 0;
      const jump = () => (calls++ < 2 ? 0 : 1e9);
      expect(await scanTraceEvents(fileChunks(late, true), () => {}, { ...scan, deadline: 10_000, now: jump })).toEqual({ end: 'timeout' });
      expect(streams.gunzips).toHaveLength(3);
      // Were the first read slower than the deadline, the source is asked to close without waiting,
      // and closes once that read lands.
      for (let i = 0; i < 200 && ![...streams.reads, ...streams.gunzips].every((x) => x.destroyed); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      allDestroyed();
    });
  });

  it('says why a gzipped source is too big in its own words', async () => {
    const r = await summarizeTraceSource(sourceOf('[', ' '.repeat(2000), ']'), { compressed: true, maxBytes: 1000 });
    expect(skippedOf(r)).toBe('The trace inflates past the 1000 bytes summary limit; open the file in DevTools or Perfetto');
  });
});

// --- Opt-in: the real 184MB trace the streaming summary was built for ---

const REAL_TRACE = process.env.CONTROL_REAL_TRACE;
const realReadable = (() => {
  if (!REAL_TRACE) return false;
  try {
    accessSync(REAL_TRACE, constants.R_OK);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!realReadable)('the real trace in CONTROL_REAL_TRACE (skipped unless that names a readable .json.gz file)', () => {
  const readAll = (): TraceEvent[] =>
    (JSON.parse(gunzipSync(readFileSync(REAL_TRACE!)).toString('utf8')) as { traceEvents: TraceEvent[] }).traceEvents;

  it('gives the same summary from the reduced events and from the stream as from all the events', async () => {
    const all = readAll();
    const full = analyzeTrace(all);
    const reduced = reduceTraceEvents(all);
    console.log(`real trace: ${all.length} events, ${reduced.length} kept`);
    expect(analyzeTrace(reduced)).toStrictEqual(full);
    const started = Date.now();
    const streamed = summaryOf(await summarizeTraceFile(REAL_TRACE!, { compressed: true }));
    console.log(`real trace: streaming summary in ${Date.now() - started}ms`);
    expect(streamed).toStrictEqual(boundSummary(full));
    expect(streamed.frames.count).toBe(475);
  }, 300_000);

  /** Peak RSS growth and time of one summary in a fresh node process. */
  const measure = (path: 'old' | 'new') => {
    const module = fileURLToPath(new URL(path === 'new' ? './chrome-trace-summary.ts' : './chrome-trace.ts', import.meta.url));
    const run = path === 'new'
      ? `const r = await m.summarizeTraceFile(file, { compressed: true }); if (!('summary' in r)) throw new Error(r.skipped);`
      : `const z = await import('node:zlib'); const fs = await import('node:fs');
         const e = JSON.parse(z.gunzipSync(fs.readFileSync(file)).toString('utf8')).traceEvents; m.analyzeTrace(e);`;
    const script = `const m = await import(${JSON.stringify(module)}); const file = ${JSON.stringify(REAL_TRACE)};
      const before = process.memoryUsage().rss; const t = Date.now(); ${run}
      console.log(JSON.stringify({ before, maxRss: process.resourceUsage().maxRSS * 1024, ms: Date.now() - t }));`;
    const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8' });
    const r = JSON.parse(out.trim().split('\n').at(-1)!) as { before: number; maxRss: number; ms: number };
    return { growthMB: Math.round((r.maxRss - r.before) / 1024 / 1024), ms: r.ms };
  };

  it('stays under 500MB of peak RSS growth where reading the whole file took about 1GB', () => {
    const fresh = measure('new');
    const whole = measure('old');
    console.log(`real trace: streaming +${fresh.growthMB}MB in ${fresh.ms}ms; whole file +${whole.growthMB}MB in ${whole.ms}ms`);
    expect(fresh.growthMB).toBeLessThan(500);
    expect(whole.growthMB).toBeGreaterThan(fresh.growthMB);
  }, 300_000);
});
