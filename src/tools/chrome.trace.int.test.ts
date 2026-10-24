import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { analyzeTrace, type TraceEvent } from './chrome-trace.js';
import { boundSummary, type BoundedSummary } from './chrome-trace-summary.js';
import { ChromeCDPClient, chromeTool } from './chrome.js';
import {
  chromeAvailable,
  launchTestBrowser,
  servePage,
  usePrivateTmpdir,
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

// Browser profiles and every trace the tool keeps land in this file's own temp directory, removed
// after the last test; counts of trace directories cannot see other suites running alongside.
const sharedTmp = tmpdir();
const privateTmp = usePrivateTmpdir();
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
    [{ method: 'profile', durationMs: 31000 }, 'durationMs'],
    [{ method: 'profile', durationMs: 30001 }, 'durationMs'],
    [{ method: 'profile', durationMs: 999 }, 'durationMs'],
    [{ method: 'profile', durationMs: 1500.5 }, 'durationMs'],
    [{ method: 'profile', scroll: { distance: 100, speed: 0 } }, 'speed'],
    [{ method: 'profile', scroll: { speed: 800 } }, 'distance'],
    [{ method: 'profile', categories: ['bad category'] }, 'categories'],
    [{ method: 'profile', outPath: '' }, 'outPath'],
    [{ method: 'profile', overwrite: 'yes' }, 'overwrite'],
    [{ method: 'profile', summary: 'yes' }, 'summary'],
  ])('rejects %j and names the field %s', async (input, field) => {
    const r = await call(input);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(new RegExp(`"${field}"`));
  });

  it.each([1000, 30000])('accepts durationMs %d (it gets as far as the connection check)', async (durationMs) => {
    await call({ method: 'disconnect' });
    const r = await call({ method: 'profile', durationMs });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^Not connected/);
  });

  it('runs in a private temp directory inside the shared one', () => {
    expect(tmpdir()).toBe(privateTmp());
    expect(dirname(privateTmp())).toBe(sharedTmp);
    expect(basename(privateTmp())).toMatch(/^control-int-/);
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
    // Browser first: a server's close waits on the connections Chrome holds open.
    await browser?.close();
    await server?.close();
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
    expect(dirname(dirname(d.path))).toBe(privateTmp());
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
    expect(summary.mainThread).toMatchObject({ pid: expect.any(Number), tid: expect.any(Number) });
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

  it('reports in status whether a trace is running', async () => {
    const running = async () => {
      const st = await call({ method: 'status', port: browser.port });
      expect(st.success, st.error).toBe(true);
      return (st.data as { trace?: { running?: unknown } }).trace?.running;
    };
    expect(await running()).toBe(false);
    expect((await call({ method: 'trace', action: 'start' })).success).toBe(true);
    expect(await running()).toBe(true);
    expect((await call({ method: 'trace', action: 'stop' })).success).toBe(true);
    expect(await running()).toBe(false);
    expect((await call({ method: 'trace', action: 'start' })).success).toBe(true);
    expect((await call({ method: 'connect', port: browser.port })).success).toBe(true); // a reset
    expect(await running()).toBe(false);
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
    // A closed tab ends every command in flight at once; 10s leaves room for a loaded machine.
    expect(Date.now() - startedAt).toBeLessThan(10_000);

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

/** Poll a page expression until it is true; throws, naming what never happened, after about 5s. */
const until = async (expression: string, what: string) => {
  for (let i = 0; i < 50; i++) {
    if ((await evaluate(expression)) === true) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
};
/** Two animation frames: what changed before them has been laid out and painted. */
const twoFrames = () => evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
const BANNER_IN = 'document.body.firstElementChild?.textContent === "Late banner"';

/**
 * Wait, by polling status, until a trace has started on this connection (Chrome answered its
 * start). Throws if none has within about 2.5s, so a test never acts on a start that did not happen.
 */
const traceStarted = async (port: number) => {
  for (let i = 0; i < 50; i++) {
    const st = await call({ method: 'status', port });
    if ((st.data as { trace?: { running?: boolean } } | undefined)?.trace?.running === true) return;
    await sleep(50);
  }
  throw new Error('No trace started within 2.5s: the profile never got its trace going');
};

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

  /** Start, let profiler start-up pass, run the page's trigger (if any) until its effect is painted, stop. */
  const record = async (stop: Record<string, unknown>, trigger?: { run: string; done: string }): Promise<TraceData> => {
    const s = await call({ method: 'trace', action: 'start' });
    expect(s.success, s.error).toBe(true);
    await sleep(500);
    if (trigger) {
      await evaluate(trigger.run);
      await until(trigger.done, 'the trigger to take effect');
      await twoFrames();
    } else {
      await sleep(600);
    }
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
    const d = await record({}, { run: 'busyThenShift(), true', done: BANNER_IN });
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
    expect(s.mainThread).toMatchObject({ pid: expect.any(Number), tid: expect.any(Number) });
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

describe.skipIf(!chromeAvailable)('chrome profile: one call in headless Chrome', () => {
  let browser: TestBrowser;
  let tall: TestServer;
  let quiet: TestServer;
  /** Directories these tests create, removed after each test. */
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
  const traceDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith('control-trace-')).sort();
  const expectNotRecording = async () => {
    const r = await call({ method: 'trace', action: 'stop' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/No trace is running/);
  };
  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'control-profile-test-'));
    made.push(dir);
    return dir;
  };
  const profile = async (input: Record<string, unknown>) => {
    const r = await call({ method: 'profile', ...input });
    const path = (r.data as { path?: string } | undefined)?.path;
    if (r.success && path && input.outPath === undefined) made.push(dirname(path));
    return r;
  };

  beforeAll(async () => {
    browser = await launchTestBrowser();
    tall = await servePage(PAGE);
    quiet = await servePage(QUIET_PAGE);
    const c = await call({ method: 'connect', port: browser.port });
    expect(c.success, c.error).toBe(true);
  }, 60_000);

  afterEach(async () => {
    // A test that timed out under heavy load can leave its trace running; end it here so the
    // tests after it start clean instead of failing with "already running".
    const left = await call({ method: 'trace', action: 'stop', summary: false });
    const leftPath = (left.data as { path?: string } | undefined)?.path;
    if (left.success && leftPath) made.push(dirname(leftPath));
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await call({ method: 'disconnect' });
    await browser?.close();
    await tall?.close();
    await quiet?.close();
  }, 30_000);

  it('records a wheel scroll on the tall page and returns the summary and the scroll', async () => {
    await open(tall.url);
    expect(await evaluate('window.scrollY')).toBe(0);
    const startedAt = Date.now();
    const r = await profile({ durationMs: 3000, scroll: { distance: 1200, speed: 800 } });
    const elapsed = Date.now() - startedAt;
    expect(r.success, r.error).toBe(true);
    const d = r.data as TraceData & { scroll: { requestedPx: number; scrolledPx: number } };
    expect(d.summary).toBeDefined();
    expect(d.summary!.frames.count).toBeGreaterThan(0);
    expect(d.scroll.requestedPx).toBe(1200);
    expect(Math.abs(d.scroll.scrolledPx - 1200)).toBeLessThanOrEqual(5);
    expect(Math.abs((await evaluate('window.scrollY')) as number - 1200)).toBeLessThanOrEqual(5);
    const events = readTrace(d.path);
    expect(events.length).toBeGreaterThan(100);
    // The gesture waits for the profiler to settle: the first wheel comes at least ~500ms into the trace.
    let firstTs = Infinity;
    for (const ev of events) if (ev.ph === 'X' && ev.ts < firstTs) firstTs = ev.ts;
    const wheel = events.find(
      (ev) => ev.name === 'EventDispatch' && (ev.args?.data as { type?: string } | undefined)?.type === 'wheel'
    );
    expect(wheel).toBeDefined();
    expect((wheel!.ts - firstTs) / 1000).toBeGreaterThanOrEqual(400);
    // The recording itself (start to stop) lasts durationMs; the call adds the stop and the summary.
    expect(d.durationMs).toBeGreaterThanOrEqual(3000);
    expect(d.durationMs).toBeLessThan(3000 + 2500);
    expect(elapsed).toBeGreaterThanOrEqual(3000);
    expect(elapsed).toBeLessThan(3000 + 10000);
    await expectNotRecording();
  }, 60_000);

  it('records a quiet page without a scroll', async () => {
    await open(quiet.url);
    const r = await profile({ durationMs: 1000 });
    expect(r.success, r.error).toBe(true);
    const d = r.data as TraceData;
    expect(d.durationMs).toBeGreaterThanOrEqual(1000);
    expect('scroll' in d).toBe(false);
    expect(d.summary?.mainThread).toMatchObject({ pid: expect.any(Number), tid: expect.any(Number) });
    expect(d.summary!.windowMs).toBeGreaterThan(0);
  }, 60_000);

  it.each([31000, 999])('rejects durationMs %d without starting a trace', async (durationMs) => {
    const before = traceDirs();
    const r = await profile({ durationMs });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/"durationMs"/);
    await expectNotRecording();
    expect(traceDirs()).toEqual(before);
  }, 60_000);

  it('rejects a scroll that does not fit in durationMs before it starts', async () => {
    const before = traceDirs();
    const r = await profile({ durationMs: 2000, scroll: { distance: 100000, speed: 800 } });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/125000ms/);
    expect(r.error).toMatch(/durationMs 2000/);
    await expectNotRecording();
    expect(traceDirs()).toEqual(before);
  }, 60_000);

  it('refuses while a trace is running and leaves that trace running', async () => {
    expect((await call({ method: 'trace', action: 'start' })).success).toBe(true);
    const r = await profile({ durationMs: 1000 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/A trace is already running.*stop it first/i);
    const stop = await call({ method: 'trace', action: 'stop' });
    expect(stop.success, stop.error).toBe(true);
    made.push(dirname((stop.data as TraceData).path));
  }, 60_000);

  it('refuses a bad outPath before it records anything', async () => {
    const dir = scratch();
    const wrong = await profile({ durationMs: 1000, outPath: join(dir, 'p.json') });
    expect(wrong.success).toBe(false);
    expect(wrong.error).toMatch(/must end in \.json\.gz/);
    await expectNotRecording();

    const taken = join(dir, 'taken.json.gz');
    writeFileSync(taken, 'mine');
    const before = traceDirs();
    const r = await profile({ durationMs: 1000, outPath: taken });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/already exists.*overwrite: true/);
    expect(traceDirs()).toEqual(before);
    expect(readFileSync(taken, 'utf8')).toBe('mine');
    expect(readdirSync(dir).sort()).toEqual(['taken.json.gz']);
    await expectNotRecording();
  }, 60_000);

  it('stops the trace and keeps it privately when the scroll fails mid-run', async () => {
    await open(tall.url);
    const dir = scratch();
    const r = await profile({ durationMs: 2000, scroll: { distance: 300, selector: '#nope' }, outPath: join(dir, 'p.json.gz') });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/No element matches selector "#nope"/);
    const kept = /The partial trace was kept at (\S+)\.$/.exec(r.error ?? '')?.[1];
    expect(kept, r.error).toBeDefined();
    made.push(dirname(kept!));
    // Not at the caller's outPath: a run that failed is not the trace they asked for.
    expect(readdirSync(dir)).toEqual([]);
    expect(readTrace(kept!).length).toBeGreaterThan(10);
    await expectNotRecording();
    expect((await call({ method: 'trace', action: 'start' })).success).toBe(true);
    const stop = await call({ method: 'trace', action: 'stop' });
    expect(stop.success, stop.error).toBe(true);
    made.push(dirname((stop.data as TraceData).path));
  }, 60_000);

  it('never stops a trace it did not start: a tab switch mid-profile, then a new trace', async () => {
    await open(quiet.url);
    const created = await fetch(`http://127.0.0.1:${browser.port}/json/new?about:blank`, { method: 'PUT' });
    const other = (await created.json()) as { id: string };
    const targets = (await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json()) as { id: string; url: string }[];
    const original = targets.find((x) => x.url.startsWith(quiet.url));
    expect(original).toBeDefined();
    try {
      const running = profile({ durationMs: 3000 });
      await traceStarted(browser.port);
      // The select ends the profile's trace with its session; trace B on the new tab is someone else's.
      expect((await call({ method: 'select', targetId: other.id })).success).toBe(true);
      expect((await call({ method: 'trace', action: 'start' })).success).toBe(true);
      const r = await running;
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/The trace this call started is no longer the active recording/);
      const stopB = await call({ method: 'trace', action: 'stop' });
      expect(stopB.success, stopB.error).toBe(true);
      made.push(dirname((stopB.data as TraceData).path));
    } finally {
      await call({ method: 'select', targetId: original!.id });
      await fetch(`http://127.0.0.1:${browser.port}/json/close/${other.id}`);
    }
  }, 60_000);

  it('sends no scroll once its trace is gone: a tab switch during the settle', async () => {
    await open(quiet.url);
    const created = await fetch(`http://127.0.0.1:${browser.port}/json/new?${tall.url}`, { method: 'PUT' });
    const other = (await created.json()) as { id: string };
    const targets = (await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json()) as { id: string; url: string }[];
    const original = targets.find((x) => x.url.startsWith(quiet.url));
    expect(original).toBeDefined();
    // Every CDP method sent while the profile runs: the proof is that no gesture went out at all,
    // not only that no page moved (a late gesture on the old tab is cut off by the switch).
    const sent: string[] = [];
    const realSend = WebSocket.prototype.send;
    const spy = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, data: unknown, ...rest: unknown[]) {
      if (typeof data === 'string') sent.push(String((JSON.parse(data) as { method?: string }).method));
      return (realSend as (...a: unknown[]) => void).call(this, data, ...rest);
    });
    try {
      let r: Awaited<ReturnType<typeof profile>>;
      try {
        const running = profile({ durationMs: 3000, scroll: { distance: 1200, speed: 800 } });
        // The trace has started, and the 500ms settle leaves room: the scroll has not been sent yet.
        await traceStarted(browser.port);
        expect((await call({ method: 'select', targetId: other.id })).success).toBe(true);
        r = await running;
      } finally {
        spy.mockRestore();
      }
      expect(sent).toContain('Tracing.start');
      expect(sent).not.toContain('Input.synthesizeScrollGesture');
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/no longer the active recording/);
      for (let i = 0; i < 50 && (await evaluate('document.readyState')) !== 'complete'; i++) await sleep(100);
      expect(await evaluate('document.body.scrollHeight > 5000')).toBe(true); // the tall page, so a scroll would move it
      await sleep(500);
      expect(await evaluate('window.scrollY')).toBe(0);
    } finally {
      await call({ method: 'select', targetId: original!.id });
      await fetch(`http://127.0.0.1:${browser.port}/json/close/${other.id}`);
    }
  }, 60_000);

  /**
   * Lose the answer to these CDP methods: the command still reaches Chrome when `deliver` says so,
   * then the send throws, as a broken socket does. Chrome acts, and the tool never hears back.
   */
  const loseAnswers = (methods: Record<string, { deliver: boolean }>) => {
    const real = WebSocket.prototype.send;
    return vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, data: unknown, ...rest: unknown[]) {
      const method = typeof data === 'string' ? (JSON.parse(data) as { method?: string }).method : undefined;
      const lost = method !== undefined ? methods[method] : undefined;
      if (lost?.deliver) (real as (...a: unknown[]) => void).call(this, data, ...rest);
      if (lost) throw new Error(`injected: lost the answer to ${method}`);
      return (real as (...a: unknown[]) => void).call(this, data, ...rest);
    });
  };

  it('ends its own trace when Chrome does not answer the start, and sends no scroll', async () => {
    await open(tall.url);
    const spy = loseAnswers({ 'Tracing.start': { deliver: true } });
    let r;
    try {
      r = await profile({ durationMs: 2000, scroll: { distance: 1200, speed: 800 } });
    } finally {
      spy.mockRestore();
    }
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^Chrome did not answer the start of the trace \(injected: lost the answer to Tracing\.start\), so it may have been running\./);
    const kept = /The partial trace was kept at (\S+)\.$/.exec(r.error ?? '')?.[1];
    expect(kept, r.error).toBeDefined();
    made.push(dirname(kept!));
    // Chrome did start: it refuses Tracing.end when nothing is tracing, and here the end gave a file.
    expect(Array.isArray(readTrace(kept!))).toBe(true);
    await sleep(300);
    expect(await evaluate('window.scrollY')).toBe(0);
    await expectNotRecording();
  }, 60_000);

  it('says the trace may still be running when Chrome answers neither its start nor its ends', async () => {
    await open(quiet.url);
    // Tracing.end never reaches Chrome, so the trace really is still running afterwards.
    const spy = loseAnswers({ 'Tracing.start': { deliver: true }, 'Tracing.end': { deliver: false } });
    let r;
    try {
      r = await profile({ durationMs: 1000 });
    } finally {
      spy.mockRestore();
    }
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/so it may have been running\./);
    expect(r.error).toMatch(/the trace may still be running\. Try chrome\(\{ method: "trace", action: "stop" \}\) again, or disconnect/);
    expect(r.error).not.toMatch(/nothing was kept|partial trace was kept/);
    // The advice works: a plain stop ends it and keeps the file.
    const stop = await call({ method: 'trace', action: 'stop' });
    expect(stop.success, stop.error).toBe(true);
    made.push(dirname((stop.data as TraceData).path));
    expect(readTrace((stop.data as TraceData).path).length).toBeGreaterThan(10);
  }, 60_000);

  it('trace start without an answer says the trace may be running, and stop ends it', async () => {
    await open(quiet.url);
    const spy = loseAnswers({ 'Tracing.start': { deliver: true } });
    let s;
    try {
      s = await call({ method: 'trace', action: 'start' });
    } finally {
      spy.mockRestore();
    }
    expect(s.success).toBe(false);
    expect(s.error).toMatch(
      /^Start did not complete; the trace may be running\. Stop it with chrome\(\{ method: "trace", action: "stop" \}\), or disconnect to end it\./
    );
    const stop = await call({ method: 'trace', action: 'stop' });
    expect(stop.success, stop.error).toBe(true);
    made.push(dirname((stop.data as TraceData).path));
    expect(readTrace((stop.data as TraceData).path).length).toBeGreaterThan(10);
  }, 60_000);

  it('replaces an existing file at outPath with overwrite: true', async () => {
    await open(quiet.url);
    const dir = scratch();
    const target = join(dir, 'p.json.gz');
    writeFileSync(target, 'old');
    const r = await profile({ durationMs: 1000, outPath: target, overwrite: true });
    expect(r.success, r.error).toBe(true);
    const d = r.data as TraceData & { overwritten?: boolean };
    expect(d.path).toBe(target);
    expect(d.overwritten).toBe(true);
    expect(readTrace(target).length).toBeGreaterThan(10);
    expect(d.summary).toEqual(boundSummary(analyzeTrace(readTrace(target))));
  }, 60_000);

  it('returns no summary keys with summary: false', async () => {
    await open(quiet.url);
    const r = await profile({ durationMs: 1000, summary: false });
    expect(r.success, r.error).toBe(true);
    expect('summary' in (r.data as object)).toBe(false);
    expect('summarySkipped' in (r.data as object)).toBe(false);
  }, 60_000);
});

// 500 elements inserted by script, so Nodes counts them.
const NODES_PAGE = `<!doctype html><body><script>
  for (let i = 0; i < 500; i++) document.body.appendChild(document.createElement('div')).textContent = 'n' + i;
</script></body>`;

const BIG_TEXT_PAGE = `<!doctype html><body style="margin:0">
<h1 style="font:64px sans-serif;margin:40px">A large heading paints the LCP</h1></body>`;

// A click whose handler blocks the main thread for about 150ms: one slow interaction.
const CLICK_PAGE = `<!doctype html><body style="margin:0">
<button id="slow" style="width:300px;height:120px;font-size:24px">Slow click</button>
<script>
  document.getElementById('slow').addEventListener('click', () => {
    const start = performance.now();
    while (performance.now() - start < 150) {}
    document.getElementById('slow').textContent = 'Clicked';
  });
</script></body>`;

// A page that attacks the probe: an observer that hands back a 16MB string as every entry value,
// and a slice that throws. Underneath, a real heading (LCP) and a real late banner (a shift).
const HOSTILE_PAGE = `<!doctype html><body style="margin:0;font:16px sans-serif">
<h1 style="font:64px sans-serif;margin:0">A large heading</h1>
<p style="height:300px;margin:0;background:#ddd">Content a late banner pushes down.</p>
<script>
  const huge = 'x'.repeat(16 << 20);
  const fake = [{ startTime: huge, value: huge, duration: huge, size: huge, interactionId: huge, element: huge }];
  window.PerformanceObserver = class {
    constructor(callback) { this.callback = callback; }
    observe() { setTimeout(() => this.callback({ getEntries: () => fake })); }
    takeRecords() { return fake; }
    disconnect() {}
  };
  String.prototype.slice = function () { throw new Error('slice is broken here'); };
  setTimeout(() => {
    const banner = document.createElement('div');
    banner.style.height = '200px';
    banner.textContent = 'Late banner';
    document.body.prepend(banner);
  }, 300);
</script></body>`;

// A page whose iframe carries a 5MB name: frame names and URLs are page data of any size.
const BIG_FRAME_NAME_PAGE = `<!doctype html><body style="margin:0">
<h1 style="font:64px sans-serif;margin:0">Heading beside a heavy iframe</h1>
<script>
  const f = document.createElement('iframe');
  f.name = 'n'.repeat(5 << 20);
  f.srcdoc = '<p>inner</p>';
  document.body.appendChild(f);
</script></body>`;

interface MetricsData {
  metrics: Record<string, number | null>;
  vitals: {
    lcp: { ms: number; size: number; element: string } | null;
    cls: number;
    shiftCount: number;
    inp: { ms: number; interactions: number } | null;
  } | null;
  vitalsError?: string;
}

describe('chrome metrics: input', () => {
  it('says to connect first when there is no connection', async () => {
    await call({ method: 'disconnect' });
    const r = await call({ method: 'metrics' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('Not connected. Use chrome({ method: "connect" }) first.');
  });
});

describe.skipIf(!chromeAvailable)('chrome metrics: snapshot in headless Chrome', () => {
  let browser: TestBrowser;
  const servers: Record<string, TestServer> = {};

  const open = async (url: string) => {
    const n = await call({ method: 'navigate', url });
    expect(n.success, n.error).toBe(true);
    for (let i = 0; i < 50; i++) {
      if ((await evaluate('document.readyState === "complete"')) === true) return;
      await sleep(100);
    }
    throw new Error(`${url} did not finish loading`);
  };
  const metrics = async (): Promise<MetricsData> => {
    const r = await call({ method: 'metrics' });
    expect(r.success, r.error).toBe(true);
    return r.data as MetricsData;
  };
  /** CDP methods the tool sends while fn runs, read off the socket. */
  const methodsSent = async (fn: () => Promise<unknown>): Promise<string[]> => {
    const sent: string[] = [];
    const real = WebSocket.prototype.send;
    const spy = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, data: unknown, ...rest: unknown[]) {
      if (typeof data === 'string') sent.push(String((JSON.parse(data) as { method?: string }).method));
      return (real as (...a: unknown[]) => void).call(this, data, ...rest);
    });
    try {
      await fn();
    } finally {
      spy.mockRestore();
    }
    return sent;
  };

  beforeAll(async () => {
    browser = await launchTestBrowser();
    for (const [name, html] of Object.entries({
      nodes: NODES_PAGE, quiet: QUIET_PAGE, busy: BUSY_PAGE, big: BIG_TEXT_PAGE, click: CLICK_PAGE, hostile: HOSTILE_PAGE, bigFrame: BIG_FRAME_NAME_PAGE,
    })) {
      servers[name] = await servePage(html);
    }
    const c = await call({ method: 'connect', port: browser.port });
    expect(c.success, c.error).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await call({ method: 'disconnect' });
    // Browser first: a server's close waits on the connections Chrome holds open.
    await browser?.close();
    for (const s of Object.values(servers)) await s.close();
  }, 30_000);

  it('counts the 500 inserted nodes and reports a numeric heap, in a small result', async () => {
    await open(servers.nodes.url);
    const r = await call({ method: 'metrics' });
    expect(r.success, r.error).toBe(true);
    const d = r.data as MetricsData;
    expect(d.metrics.nodes).toBeGreaterThanOrEqual(500);
    expect(d.metrics.jsHeapUsedBytes).toBeGreaterThan(0);
    expect(d.metrics.jsHeapTotalBytes).toBeGreaterThan(0);
    expect(d.metrics.documents).toBeGreaterThanOrEqual(1);
    expect(d.metrics.taskMs).toBeGreaterThan(0);
    const size = JSON.stringify(r.data).length;
    console.log(`metrics result: ${size} chars`);
    expect(size).toBeLessThan(2000);
  }, 60_000);

  it('gives inp null and cls 0 on a quiet page with no interaction', async () => {
    await open(servers.quiet.url);
    const d = await metrics();
    expect(d.vitals).not.toBeNull();
    expect(d.vitals!.inp).toBe(null);
    expect(d.vitals!.cls).toBe(0);
    expect(d.vitals!.shiftCount).toBe(0);
  }, 60_000);

  it('sees the late banner shift, and agrees with a trace of the same run', async () => {
    await open(servers.busy.url);
    expect((await call({ method: 'trace', action: 'start' })).success).toBe(true);
    await sleep(500);
    await evaluate('busyThenShift(), true');
    await until(BANNER_IN, 'the late banner');
    await twoFrames();
    const stop = await call({ method: 'trace', action: 'stop' });
    expect(stop.success, stop.error).toBe(true);
    const traced = (stop.data as TraceData).summary!.vitals.cls;
    const d = await metrics();
    expect(d.vitals!.cls).toBeGreaterThan(0);
    expect(d.vitals!.shiftCount).toBeGreaterThanOrEqual(1);
    expect(Math.abs(d.vitals!.cls - traced)).toBeLessThan(0.01);
  }, 60_000);

  it('reports the LCP of a big-text page', async () => {
    await open(servers.big.url);
    // LCP is reported after the heading paints: poll for it rather than guess how long that takes.
    let d = await metrics();
    for (let i = 0; i < 30 && d.vitals?.lcp == null; i++) {
      await sleep(100);
      d = await metrics();
    }
    expect(d.vitals!.lcp).not.toBeNull();
    expect(d.vitals!.lcp!.ms).toBeGreaterThan(0);
    expect(d.vitals!.lcp!.size).toBeGreaterThan(0);
    expect(d.vitals!.lcp!.element).toBe('h1');
  }, 60_000);

  it('reports INP for a real click on a slow handler', async () => {
    await open(servers.click.url);
    const clicked = await call({ method: 'click', selector: '#slow' });
    expect(clicked.success, clicked.error).toBe(true);
    await until('document.getElementById("slow").textContent === "Clicked"', 'the click handler');
    // The event entry is reported after the next paint: poll for it rather than guess.
    let d = await metrics();
    for (let i = 0; i < 30 && d.vitals?.inp == null; i++) {
      await sleep(100);
      d = await metrics();
    }
    console.log(`INP after one slow click: ${JSON.stringify(d.vitals!.inp)}`);
    expect(d.vitals!.inp).not.toBeNull();
    expect(d.vitals!.inp!.ms).toBeGreaterThanOrEqual(100);
    expect(d.vitals!.inp!.interactions).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('turns the Performance domain off again after reading', async () => {
    await open(servers.quiet.url);
    const sent = await methodsSent(() => metrics());
    const at = (m: string) => sent.indexOf(m);
    expect(at('Performance.enable')).toBeGreaterThanOrEqual(0);
    expect(at('Performance.getMetrics')).toBeGreaterThan(at('Performance.enable'));
    expect(at('Performance.disable')).toBeGreaterThan(at('Performance.getMetrics'));
  }, 60_000);

  it('fails with the reason when Chrome does not answer getMetrics, and still turns Performance off', async () => {
    await open(servers.quiet.url);
    const spy = loseAnswersFor('Performance.getMetrics');
    const sent: string[] = [];
    let r;
    try {
      r = await call({ method: 'metrics' });
      sent.push(...spy.mock.calls.map(([data]) => String((JSON.parse(String(data)) as { method?: string }).method)));
    } finally {
      spy.mockRestore();
    }
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/injected: lost the answer to Performance\.getMetrics/);
    expect(sent).toContain('Performance.disable');
  }, 60_000);

  it("reads the browser's real entries on a page that replaces PerformanceObserver and breaks slice", async () => {
    await open(servers.hostile.url);
    await until(BANNER_IN, 'the late banner');
    await twoFrames();
    const r = await call({ method: 'metrics' });
    expect(r.success, r.error).toBe(true);
    const size = JSON.stringify(r.data).length;
    console.log(`metrics on the hostile page: ${size} chars, vitals ${JSON.stringify((r.data as MetricsData).vitals)}`);
    expect(size).toBeLessThan(2000);
    const d = r.data as MetricsData;
    expect(d.vitals).not.toBeNull();
    expect(d.vitals!.cls).toBeGreaterThan(0.05);
    expect(d.vitals!.shiftCount).toBeGreaterThanOrEqual(1);
    expect(d.vitals!.lcp?.element).toBe('h1');
    expect(d.vitals!.lcp!.ms).toBeGreaterThan(0);
    expect(d.vitals!.inp).toBe(null);
  }, 60_000);

  it('finds the main frame without the frame tree, so a 5MB iframe name never reaches Node', async () => {
    await open(servers.bigFrame.url);
    await until('document.querySelector("iframe")?.name.length === 5 << 20', 'the iframe with the big name');
    let r: Awaited<ReturnType<typeof call>> | undefined;
    const startedAt = Date.now();
    const sent = await methodsSent(async () => {
      r = await call({ method: 'metrics' });
    });
    const elapsed = Date.now() - startedAt;
    expect(r!.success, r!.error).toBe(true);
    expect(sent).not.toContain('Page.getFrameTree');
    expect(sent).toContain('Page.createIsolatedWorld');
    const d = r!.data as MetricsData;
    expect(d.vitals).not.toBeNull();
    expect(d.vitals!.lcp?.element).toBe('h1');
    expect(JSON.stringify(d).length).toBeLessThan(2000);
    expect(elapsed).toBeLessThan(5000);
  }, 60_000);

  it('uses the target id as the frame in a second tab it selected', async () => {
    const created = await fetch(`http://127.0.0.1:${browser.port}/json/new?${servers.big.url}`, { method: 'PUT' });
    const other = (await created.json()) as { id: string };
    const targets = (await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json()) as { id: string; url: string }[];
    const original = targets.find((x) => x.id !== other.id && x.url.startsWith('http'));
    try {
      expect((await call({ method: 'select', targetId: other.id })).success).toBe(true);
      await until('document.readyState === "complete"', 'the second tab to load');
      const d = await metrics();
      expect(d.vitals, d.vitalsError).not.toBeNull();
      expect(d.metrics.nodes).toBeGreaterThan(0);
    } finally {
      if (original) await call({ method: 'select', targetId: original.id });
      await fetch(`http://127.0.0.1:${browser.port}/json/close/${other.id}`);
    }
  }, 60_000);

  it('gives vitals null, and never runs the probe in the page world, when the isolated world cannot be made', async () => {
    await open(servers.quiet.url);
    const spy = loseAnswersFor('Page.createIsolatedWorld');
    let r;
    let evaluates: Record<string, unknown>[] = [];
    try {
      r = await call({ method: 'metrics' });
      evaluates = spy.mock.calls
        .map(([data]) => JSON.parse(String(data)) as { method?: string; params?: Record<string, unknown> })
        .filter((m) => m.method === 'Runtime.evaluate')
        .map((m) => m.params ?? {});
    } finally {
      spy.mockRestore();
    }
    expect(r.success, r.error).toBe(true);
    const d = r.data as MetricsData;
    expect(d.metrics.nodes).toBeGreaterThan(0);
    expect(d.vitals).toBe(null);
    expect(d.vitalsError).toMatch(/separate JS world/);
    expect(evaluates).toEqual([]);
  }, 60_000);

  it('runs two overlapping calls one after the other', async () => {
    await open(servers.quiet.url);
    let results: Awaited<ReturnType<typeof call>>[] = [];
    const sent = await methodsSent(async () => {
      results = await Promise.all([call({ method: 'metrics' }), call({ method: 'metrics' })]);
    });
    expect(results.map((x) => x.success)).toEqual([true, true]);
    expect(sent.filter((m) => m.startsWith('Performance.'))).toEqual([
      'Performance.enable', 'Performance.getMetrics', 'Performance.disable',
      'Performance.enable', 'Performance.getMetrics', 'Performance.disable',
    ]);
  }, 60_000);

  it('moves the selection epoch on a tab switch and on a disconnect, not on a failed switch', async () => {
    const created = await fetch(`http://127.0.0.1:${browser.port}/json/new?about:blank`, { method: 'PUT' });
    const other = (await created.json()) as { id: string };
    const c = new ChromeCDPClient(browser.port);
    try {
      await c.connect();
      const first = c.selectionEpoch;
      await expect(c.connect('no-such-target')).rejects.toThrow(/not found/);
      expect(c.selectionEpoch).toBe(first);
      await c.connect(other.id);
      const switched = c.selectionEpoch;
      expect(switched).toBeGreaterThan(first);
      c.disconnect();
      expect(c.selectionEpoch).toBeGreaterThan(switched);
    } finally {
      c.disconnect();
      await fetch(`http://127.0.0.1:${browser.port}/json/close/${other.id}`);
    }
  }, 60_000);
});

/** Make the send of one CDP method throw, as a broken socket does: the command never reaches Chrome. */
function loseAnswersFor(method: string) {
  const real = WebSocket.prototype.send;
  return vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, data: unknown, ...rest: unknown[]) {
    if (typeof data === 'string' && (JSON.parse(data) as { method?: string }).method === method) {
      throw new Error(`injected: lost the answer to ${method}`);
    }
    return (real as (...a: unknown[]) => void).call(this, data, ...rest);
  });
}
