import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { analyzeTrace, type TraceEvent } from './chrome-trace.js';
import { boundSummary, type BoundedSummary } from './chrome-trace-summary.js';
import { chromeTool } from './chrome.js';
import {
  chromeAvailable,
  launchTestBrowser,
  servePage,
  type TestBrowser,
  type TestServer,
} from './chrome-test-browser.js';

// Test seam: a tiny summary cap, or a summary that throws, without making either a tool input. Unset, it passes through.
const seam = vi.hoisted(() => ({ maxBytes: undefined as number | undefined, fail: false }));
vi.mock('./chrome-trace-summary.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./chrome-trace-summary.js')>();
  return {
    ...real,
    summarizeTraceFile: async (path: string, options: { compressed: boolean; maxBytes?: number }) => {
      if (seam.fail) throw new Error('injected summary failure');
      return real.summarizeTraceFile(path, { ...options, maxBytes: seam.maxBytes ?? options.maxBytes });
    },
  };
});

const call = (input: Record<string, unknown>) => chromeTool.handler(input, {});

const evaluate = async (expression: string): Promise<unknown> => {
  const r = await call({ method: 'evaluate', expression });
  expect(r.success, r.error).toBe(true);
  return (r.data as { result: unknown }).result;
};

// A tall page with a rAF loop, so a scroll produces frames and main-thread work to record.
const PAGE = `<!doctype html><body style="margin:0">
<div style="height:6000px;background:linear-gradient(#fff,#888)"></div>
<script>
  let n = 0;
  (function tick() { document.title = 'f' + (n++); requestAnimationFrame(tick); })();
</script></body>`;

interface TraceData {
  path: string;
  bytes: number;
  compressed: boolean;
  dataLoss: boolean;
  durationMs: number;
  summary?: BoundedSummary;
  summarySkipped?: string;
}

const readTrace = (path: string): TraceEvent[] => {
  const raw = readFileSync(path);
  const text = path.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  return (JSON.parse(text) as { traceEvents: TraceEvent[] }).traceEvents;
};

const countOf = (events: TraceEvent[], name: string) => events.filter((e) => e.name === name).length;

describe('chrome trace: input validation', () => {
  it.each([
    [{ method: 'trace' }, 'action'],
    [{ method: 'trace', action: 'pause' }, 'action'],
    [{ method: 'trace', action: 'start', categories: ['bad category'] }, 'categories'],
    [{ method: 'trace', action: 'start', categories: ['a,b'] }, 'categories'],
    [{ method: 'trace', action: 'start', categories: [] }, 'categories'],
    [{ method: 'trace', action: 'start', compress: 'yes' }, 'compress'],
    [{ method: 'trace', action: 'stop', outPath: '' }, 'outPath'],
    [{ method: 'trace', action: 'stop', outPath: '/tmp/a\0b.json.gz' }, 'outPath'],
    [{ method: 'trace', action: 'stop', overwrite: 'yes' }, 'overwrite'],
    [{ method: 'trace', action: 'stop', summary: 'yes' }, 'summary'],
  ])('rejects %j and names the field %s', async (input, field) => {
    const r = await call(input);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(new RegExp(`"${field}"`));
  });

  it('says to connect first when there is no connection', async () => {
    await call({ method: 'disconnect' });
    const r = await call({ method: 'trace', action: 'start' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Not connected/);
  });
});

describe.skipIf(!chromeAvailable)('chrome trace: recording in headless Chrome', () => {
  let browser: TestBrowser;
  let server: TestServer;

  beforeAll(async () => {
    browser = await launchTestBrowser();
    server = await servePage(PAGE);
    const c = await call({ method: 'connect', port: browser.port });
    expect(c.success, c.error).toBe(true);
    await call({ method: 'navigate', url: server.url });
    for (let i = 0; i < 50; i++) {
      if ((await evaluate('document.readyState === "complete"')) === true) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 60_000);

  afterAll(async () => {
    await call({ method: 'disconnect' });
    await server?.close();
    await browser?.close();
  }, 30_000);

  it('records a gzipped trace that parses and names the renderer main thread', async () => {
    const s = await call({ method: 'trace', action: 'start' });
    expect(s.success, s.error).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    const e = await call({ method: 'trace', action: 'stop' });
    expect(e.success, e.error).toBe(true);
    const d = e.data as TraceData;
    expect(d.compressed).toBe(true);
    expect(d.path.endsWith('.json.gz')).toBe(true);
    expect(statSync(d.path).size).toBe(d.bytes);
    expect(statSync(d.path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(d.path)).mode & 0o777).toBe(0o700);
    const events = readTrace(d.path);
    expect(events.length).toBeGreaterThan(100);
    expect(countOf(events, 'RunTask')).toBeGreaterThan(0);
    expect(
      events.some((ev) => ev.ph === 'M' && ev.name === 'thread_name' && ev.args?.name === 'CrRendererMain')
    ).toBe(true);
  }, 60_000);

  it('records the frame, input and CPU-profile events a scroll investigation needs', async () => {
    await evaluate('window.scrollTo(0, 0)');
    const s = await call({ method: 'trace', action: 'start' });
    expect(s.success, s.error).toBe(true);
    const scroll = await call({ method: 'scroll', distance: 1200, speed: 1200 });
    expect(scroll.success, scroll.error).toBe(true);
    const e = await call({ method: 'trace', action: 'stop' });
    expect(e.success, e.error).toBe(true);
    const events = readTrace((e.data as TraceData).path);

    expect(countOf(events, 'DrawFrame')).toBeGreaterThan(10);
    expect(countOf(events, 'BeginFrame')).toBeGreaterThan(10);
    expect(countOf(events, 'ProfileChunk')).toBeGreaterThan(0);
    expect(countOf(events, 'FireAnimationFrame')).toBeGreaterThan(10);
    const wheel = events.filter(
      (ev) => ev.name === 'EventDispatch' && (ev.args?.data as { type?: string } | undefined)?.type === 'wheel'
    );
    expect(wheel.length).toBeGreaterThan(0);

    // And the analyzer understands what was captured.
    const summary = analyzeTrace(events);
    expect(summary.mainThread).not.toBeNull();
    expect(summary.frames.count).toBeGreaterThan(10);
  }, 60_000);

  it('writes plain json when compress is false', async () => {
    await call({ method: 'trace', action: 'start', compress: false });
    await new Promise((r) => setTimeout(r, 300));
    const e = await call({ method: 'trace', action: 'stop' });
    expect(e.success, e.error).toBe(true);
    const d = e.data as TraceData;
    expect(d.compressed).toBe(false);
    expect(d.path.endsWith('.json')).toBe(true);
    expect(readTrace(d.path).length).toBeGreaterThan(50);
  }, 60_000);

  it('records only the categories it is given', async () => {
    await call({ method: 'trace', action: 'start', categories: ['toplevel'] });
    await new Promise((r) => setTimeout(r, 400));
    const e = await call({ method: 'trace', action: 'stop' });
    expect(e.success, e.error).toBe(true);
    const events = readTrace((e.data as TraceData).path);
    expect(events.length).toBeGreaterThan(10);
    expect(countOf(events, 'DrawFrame')).toBe(0);
    expect(countOf(events, 'FireAnimationFrame')).toBe(0);
  }, 60_000);

  it('writes to a chosen outPath, and a taken path leaves the trace running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'control-trace-out-'));
    try {
      const target = join(dir, 'scroll.json.gz');
      expect((await call({ method: 'trace', action: 'start' })).success).toBe(true);
      await new Promise((r) => setTimeout(r, 300));
      const e = await call({ method: 'trace', action: 'stop', outPath: target });
      expect(e.success, e.error).toBe(true);
      const d = e.data as TraceData;
      expect(d.path).toBe(target);
      expect(statSync(target).size).toBe(d.bytes);
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(readTrace(target).length).toBeGreaterThan(50);

      expect((await call({ method: 'trace', action: 'start' })).success).toBe(true);
      const taken = await call({ method: 'trace', action: 'stop', outPath: target });
      expect(taken.success).toBe(false);
      expect(taken.error).toMatch(/already exists.*overwrite: true/);
      const other = join(dir, 'second.json.gz');
      const again = await call({ method: 'trace', action: 'stop', outPath: other });
      expect(again.success, again.error).toBe(true);
      expect(readTrace(other).length).toBeGreaterThan(10);
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses to stop when nothing is recording and to start twice', async () => {
    const none = await call({ method: 'trace', action: 'stop' });
    expect(none.success).toBe(false);
    expect(none.error).toMatch(/No trace is running/);

    expect((await call({ method: 'trace', action: 'start' })).success).toBe(true);
    const twice = await call({ method: 'trace', action: 'start' });
    expect(twice.success).toBe(false);
    expect(twice.error).toMatch(/already running/);
    expect((await call({ method: 'trace', action: 'stop' })).success).toBe(true);
  }, 60_000);

  it('keeps a running trace when a reconnect fails, because the old connection is still there', async () => {
    expect((await call({ method: 'trace', action: 'start' })).success).toBe(true);
    const bad = await call({ method: 'connect', port: browser.port, targetId: 'no-such-target' });
    expect(bad.success).toBe(false);
    const stop = await call({ method: 'trace', action: 'stop' });
    expect(stop.success, stop.error).toBe(true);
  }, 60_000);

  it('forgets a running trace when another tab is selected', async () => {
    const created = await fetch(`http://127.0.0.1:${browser.port}/json/new?about:blank`, { method: 'PUT' });
    const second = (await created.json()) as { id: string };
    expect((await call({ method: 'trace', action: 'start' })).success).toBe(true);
    const sel = await call({ method: 'select', targetId: second.id });
    expect(sel.success, sel.error).toBe(true);
    const stop = await call({ method: 'trace', action: 'stop' });
    expect(stop.success).toBe(false);
    expect(stop.error).toMatch(/No trace is running/);
    // Back to the original tab for the tests that follow.
    const targets = (await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json()) as { id: string; url: string }[];
    const original = targets.find((x) => x.url.startsWith(server.url));
    expect(original).toBeDefined();
    expect((await call({ method: 'select', targetId: original!.id })).success).toBe(true);
  }, 60_000);

  it('starts clean when it reconnects after a tab closed under a running trace', async () => {
    // Selecting the original tab tears the dead socket down, which is what clears the state here;
    // the unexpected-close path itself is covered by the in-flight-stop test below.
    const created = await fetch(`http://127.0.0.1:${browser.port}/json/new?about:blank`, { method: 'PUT' });
    const doomed = (await created.json()) as { id: string };
    expect((await call({ method: 'select', targetId: doomed.id })).success).toBe(true);
    expect((await call({ method: 'trace', action: 'start' })).success).toBe(true);
    await fetch(`http://127.0.0.1:${browser.port}/json/close/${doomed.id}`);
    await new Promise((r) => setTimeout(r, 800));

    const targets = (await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json()) as { id: string; url: string }[];
    const original = targets.find((x) => x.url.startsWith(server.url));
    expect(original).toBeDefined();
    expect((await call({ method: 'select', targetId: original!.id })).success).toBe(true);
    // The old session's recording is gone; stopping must say so rather than wait on a dead trace.
    const stop = await call({ method: 'trace', action: 'stop' });
    expect(stop.success).toBe(false);
    expect(stop.error).toMatch(/No trace is running/);
  }, 60_000);

  it('does not wait out the 120s limit when the tab dies while a stop is in flight', async () => {
    // Racy by nature: if the stop finishes before the tab closes it passes either way; it fails
    // (by timeout) only when a dead connection is left waiting, which is the regression it guards.
    const created = await fetch(`http://127.0.0.1:${browser.port}/json/new?about:blank`, { method: 'PUT' });
    const doomed = (await created.json()) as { id: string };
    expect((await call({ method: 'select', targetId: doomed.id })).success).toBe(true);
    expect((await call({ method: 'trace', action: 'start' })).success).toBe(true);
    const startedAt = Date.now();
    const stopping = call({ method: 'trace', action: 'stop' });
    await fetch(`http://127.0.0.1:${browser.port}/json/close/${doomed.id}`);
    await stopping; // either outcome is fine; what matters is that it comes back quickly
    expect(Date.now() - startedAt).toBeLessThan(30_000);

    const targets = (await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json()) as { id: string; url: string }[];
    const original = targets.find((x) => x.url.startsWith(server.url));
    expect((await call({ method: 'select', targetId: original!.id })).success).toBe(true);
  }, 70_000);

  it('forgets a running trace when connecting again without disconnecting', async () => {
    expect((await call({ method: 'trace', action: 'start' })).success).toBe(true);
    const c = await call({ method: 'connect', port: browser.port });
    expect(c.success, c.error).toBe(true);
    const stop = await call({ method: 'trace', action: 'stop' });
    expect(stop.success).toBe(false);
    expect(stop.error).toMatch(/No trace is running/);
  }, 60_000);

  it('forgets a running trace when the connection is dropped', async () => {
    expect((await call({ method: 'trace', action: 'start' })).success).toBe(true);
    await call({ method: 'disconnect' });
    const c = await call({ method: 'connect', port: browser.port });
    expect(c.success, c.error).toBe(true);
    const stop = await call({ method: 'trace', action: 'stop' });
    expect(stop.success).toBe(false);
    expect(stop.error).toMatch(/No trace is running/);
    // A fresh start works on the new connection.
    expect((await call({ method: 'trace', action: 'start' })).success).toBe(true);
    expect((await call({ method: 'trace', action: 'stop' })).success).toBe(true);
  }, 60_000);
});

// After load, a 120ms synchronous task, then a banner inserted above visible content: a long task and a layout shift.
const BUSY_PAGE = `<!doctype html><body style="margin:0;font:16px sans-serif">
<p style="height:400px;margin:0;background:#ddd">Content that a late banner pushes down.</p>
<script>
  window.busyThenShift = () => setTimeout(() => {
    const start = performance.now();
    while (performance.now() - start < 120) {}
    const banner = document.createElement('div');
    banner.style.height = '200px';
    banner.textContent = 'Late banner';
    document.body.prepend(banner);
  }, 50);
</script></body>`;

const QUIET_PAGE = `<!doctype html><body style="margin:0;font:16px sans-serif">
<p style="height:400px;margin:0;background:#ddd">Static content.</p></body>`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!chromeAvailable)('chrome trace: summary on stop in headless Chrome', () => {
  let browser: TestBrowser;
  let busy: TestServer;
  let quiet: TestServer;
  /** Trace directories these tests create, removed after each test. */
  const made: string[] = [];

  const open = async (url: string) => {
    const n = await call({ method: 'navigate', url });
    expect(n.success, n.error).toBe(true);
    for (let i = 0; i < 50; i++) {
      if ((await evaluate('document.readyState === "complete"')) === true) return;
      await sleep(100);
    }
    throw new Error(`${url} did not finish loading`);
  };

  /** Start, let profiler start-up pass, run the page's trigger (if any), wait it out, stop. */
  const record = async (stop: Record<string, unknown>, trigger?: string): Promise<TraceData> => {
    const s = await call({ method: 'trace', action: 'start' });
    expect(s.success, s.error).toBe(true);
    await sleep(500);
    if (trigger) await evaluate(trigger);
    await sleep(600);
    const e = await call({ method: 'trace', action: 'stop', ...stop });
    expect(e.success, e.error).toBe(true);
    const d = e.data as TraceData;
    if (stop.outPath === undefined) made.push(dirname(d.path));
    return d;
  };

  beforeAll(async () => {
    browser = await launchTestBrowser();
    busy = await servePage(BUSY_PAGE);
    quiet = await servePage(QUIET_PAGE);
    const c = await call({ method: 'connect', port: browser.port });
    expect(c.success, c.error).toBe(true);
  }, 60_000);

  afterEach(() => {
    seam.maxBytes = undefined;
    seam.fail = false;
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await call({ method: 'disconnect' });
    // Browser first: a server's close waits on the connections Chrome holds open.
    await browser?.close();
    await busy?.close();
    await quiet?.close();
  }, 30_000);

  it('summarizes a long task and a layout shift on a busy page', async () => {
    await open(busy.url);
    const d = await record({}, 'busyThenShift(), true');
    expect(d.summarySkipped).toBeUndefined();
    expect(d.summary).toBeDefined();
    const s = d.summary!;
    expect(s.longTasks.some((t) => t.durationMs >= 100)).toBe(true);
    expect(s.vitals.cls).toBeGreaterThan(0);
    expect(s).toEqual(boundSummary(analyzeTrace(readTrace(d.path))));
    expect(JSON.stringify(s).length).toBeLessThan(5000);
  }, 60_000);

  it('summarizes a quiet page as no long tasks and no shift', async () => {
    await open(quiet.url);
    const d = await record({});
    expect(d.summary).toBeDefined();
    const s = d.summary!;
    // An empty trace also has no long tasks and no shift: these show the recording happened.
    expect(s.mainThread).not.toBeNull();
    expect(s.windowMs).toBeGreaterThan(0);
    expect(s.longTasks).toEqual([]);
    expect(s.longTaskCount).toBe(0);
    expect(s.vitals.cls).toBe(0);
  }, 60_000);

  it('returns neither summary nor summarySkipped with summary: false', async () => {
    await open(quiet.url);
    const d = await record({ summary: false });
    expect(statSync(d.path).size).toBe(d.bytes);
    expect('summary' in d).toBe(false);
    expect('summarySkipped' in d).toBe(false);
  }, 60_000);

  it('summarizes the file at outPath', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'control-trace-out-'));
    try {
      await open(quiet.url);
      const target = join(dir, 'quiet.json.gz');
      const d = await record({ outPath: target });
      expect(d.path).toBe(target);
      expect(d.summary).toEqual(boundSummary(analyzeTrace(readTrace(target))));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('keeps the file and the stop result when the summary is skipped, and clears the recording', async () => {
    await open(quiet.url);
    seam.maxBytes = 1000;
    const d = await record({});
    expect(statSync(d.path).size).toBe(d.bytes);
    expect(d.bytes).toBeGreaterThan(1000);
    expect(d.summarySkipped).toMatch(/over the 1000 bytes summary limit/);
    expect('summary' in d).toBe(false);
    const again = await call({ method: 'trace', action: 'stop' });
    expect(again.success).toBe(false);
    expect(again.error).toMatch(/No trace is running/);
  }, 60_000);

  it('keeps the stop result when the summary itself throws', async () => {
    await open(quiet.url);
    seam.fail = true;
    const d = await record({});
    expect(statSync(d.path).size).toBe(d.bytes);
    expect(d.summarySkipped).toBe('The summary failed');
    expect('summary' in d).toBe(false);
  }, 60_000);
});
