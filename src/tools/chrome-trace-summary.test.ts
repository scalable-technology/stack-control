import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeTrace, type TraceEvent, type TraceSummary } from './chrome-trace.js';
import { boundSummary, summarizeTraceFile, type BoundedSummary } from './chrome-trace-summary.js';

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
    expect(reason).toMatch(/inflates past the 1MB summary limit/);
  });

  it.each([
    ['corrupt gzip', 'x.json.gz', true, Buffer.from('SECRET-TEXT not gzip at all'), /not valid gzip/],
    ['truncated gzip', 'y.json.gz', true, gzipSync('{"traceEvents":[{"name":"SECRET-TEXT"}]}').subarray(0, 20), /not valid gzip/],
    ['truncated JSON', 'x.json', false, '{"traceEvents":[{"name":"SECRET-TEXT', /not valid JSON/],
    ['a JSON number', 'n.json', false, '42', /traceEvents/],
    ['an object without traceEvents', 'o.json', false, '{"SECRET-TEXT":[1,2,3]}', /traceEvents/],
    ['events that are not objects', 'e.json', false, '{"traceEvents":[null,"SECRET-TEXT"]}', /could not be analyzed/],
  ])('skips %s and says why without quoting the file', async (_label, name, compressed, data, why) => {
    const reason = skippedOf(await summarizeTraceFile(write(name, data), { compressed }));
    expect(reason).toMatch(why);
    expect(reason).not.toMatch(/SECRET|traceEvents":/);
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

  it('keeps a null LCP, main thread and profile as null', () => {
    const b = boundSummary(base());
    expect(b.vitals.lcp).toBeNull();
    expect(b.mainThread).toBeNull();
    expect(b.profile).toBeNull();
    expect(b.longTaskCount).toBe(0);
  });
});
