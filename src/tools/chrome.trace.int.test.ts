import { readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeTrace, type TraceEvent } from './chrome-trace.js';
import { chromeTool } from './chrome.js';
import {
  chromeAvailable,
  launchTestBrowser,
  servePage,
  type TestBrowser,
  type TestServer,
} from './chrome-test-browser.js';

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

  it('forgets a running trace when its tab closes under it', async () => {
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
