import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { chromeTool } from './chrome.js';
import {
  chromeAvailable,
  launchTestBrowser,
  servePage,
  usePrivateTmpdir,
  type TestBrowser,
  type TestServer,
} from './chrome-test-browser.js';

// Browser profiles land in this file's own temp directory, removed after the last test.
const privateTmp = usePrivateTmpdir();
const call = (input: Record<string, unknown>) => chromeTool.handler(input, {});

it('runs in a private temp directory', () => {
  expect(tmpdir()).toBe(privateTmp());
  expect(basename(privateTmp())).toMatch(/^control-int-/);
});

const evaluate = async (expression: string): Promise<unknown> => {
  const r = await call({ method: 'evaluate', expression });
  expect(r.success, r.error).toBe(true);
  return (r.data as { result: unknown }).result;
};

// The script counts the input events the page really receives, so a test can tell a wheel
// gesture from a touch drag instead of trusting the tool's own echo of its arguments.
const TALL_PAGE = `<!doctype html><body style="margin:0">
<script>
  window.__input = { wheel: 0, touch: 0, mouse: 0 };
  addEventListener('wheel', () => window.__input.wheel++, { passive: true });
  addEventListener('pointerdown', (e) => { window.__input[e.pointerType === 'touch' ? 'touch' : 'mouse']++; }, { passive: true });
  addEventListener('touchstart', () => window.__input.touch++, { passive: true });
</script>
<div id="target" style="height:400px;overflow:hidden"><div style="height:2000px">inner</div></div>
<div style="height:5000px;background:linear-gradient(#fff,#888)"></div>
<div id="lower" style="position:absolute;top:1100px;left:0;width:100%;height:400px;overflow:auto"><div style="height:2000px"></div></div></body>`;

// A page that lies: it redefines Math.round to return a string that would be code if interpolated.
const HOSTILE_PAGE = `<!doctype html><body style="margin:0"><script>
  Math.round = () => '1);window.__pwned=1;(1';
</script><div style="height:5000px"></div></body>`;

/** Poll until the tab shows this url, fully loaded; throws after about 5s. */
const loaded = async (url: string) => {
  for (let i = 0; i < 50; i++) {
    if ((await evaluate(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`)) === true) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} did not finish loading`);
};

const scrollY = async () => (await evaluate('window.scrollY')) as number;
// Reset to the top. A gesture's momentum outlives the CDP call that returned, and scrolling to
// the top while it is still running leaves the next gesture scrolling further than asked, so
// let the browser go idle first.
const toTop = async () => {
  await new Promise((r) => setTimeout(r, 1200));
  // Reset page state a previous test may have changed.
  await evaluate('(() => { const t = document.getElementById("target"); t.style.overflow = "hidden"; t.scrollTop = 0; document.getElementById("lower").scrollTop = 0; })()');
  await evaluate('window.scrollTo(0, 0)');
  let stable = 0;
  for (let i = 0; i < 40 && stable < 3; i++) {
    await new Promise((r) => setTimeout(r, 80));
    stable = (await scrollY()) === 0 ? stable + 1 : 0;
  }
  expect(await scrollY()).toBe(0);
};

describe('chrome scroll: input validation', () => {
  it.each([
    [{ method: 'scroll' }, 'distance'],
    [{ method: 'scroll', distance: 100, speed: 0 }, 'speed'],
    [{ method: 'scroll', distance: 100, repeat: -1 }, 'repeat'],
    [{ method: 'scroll', distance: 1e9 }, 'distance'],
    [{ method: 'scroll', distance: 100, source: 'pen' }, 'source'],
    [{ method: 'scroll', distance: 100, speed: 800.5 }, 'speed'],
  ])('rejects %j and names the field %s', async (input, field) => {
    const r = await call(input);
    expect(r.success).toBe(false);
    // The path is in the zod message: this fails if scroll is not a known method at all.
    expect(r.error).toMatch(new RegExp(`"${field}"`));
  });

  it('refuses a gesture that would run for more than a minute, before touching the browser', async () => {
    await call({ method: 'disconnect' });
    // 100000px at 1px/s is more than a day; 5000px at 50px/s is 100s.
    for (const input of [
      { method: 'scroll', distance: 100000, speed: 1 },
      { method: 'scroll', distance: 5000, speed: 50 },
      { method: 'scroll', distance: 3000, speed: 800, repeat: 100, repeatDelayMs: 10000 },
    ]) {
      const r = await call(input);
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/too long/i);
    }
  });

  it('allows a long but bounded gesture past the duration check', async () => {
    await call({ method: 'disconnect' });
    const r = await call({ method: 'scroll', distance: 2400, speed: 480 }); // 5s
    expect(r.error).toMatch(/Not connected/);
  });

  it('says to connect first when there is no connection', async () => {
    await call({ method: 'disconnect' });
    const r = await call({ method: 'scroll', distance: 100 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Not connected/);
  });
});

describe.skipIf(!chromeAvailable)('chrome scroll: real input in headless Chrome', () => {
  let browser: TestBrowser;
  let server: TestServer;

  beforeAll(async () => {
    browser = await launchTestBrowser();
    server = await servePage(TALL_PAGE);
    const c = await call({ method: 'connect', port: browser.port });
    expect(c.success, c.error).toBe(true);
    const n = await call({ method: 'navigate', url: server.url });
    expect(n.success, n.error).toBe(true);
    for (let i = 0; i < 50; i++) {
      if ((await evaluate('document.readyState === "complete" && document.body.scrollHeight')) as number > 5000) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('fixture page did not load');
  }, 60_000);

  afterAll(async () => {
    await call({ method: 'disconnect' });
    // Browser first: a server's close waits on the connections Chrome holds open.
    await browser?.close();
    await server?.close();
  }, 30_000);

  it('scrolls down by the requested distance with a real wheel gesture', async () => {
    await toTop();
    const r = await call({ method: 'scroll', distance: 800 });
    expect(r.success, r.error).toBe(true);
    expect(Math.abs((await scrollY()) - 800)).toBeLessThanOrEqual(5);
    expect(r.data).toMatchObject({ source: 'mouse', scrollTopBefore: 0, scroller: 'document', settled: true });
    expect(Math.abs((r.data as { scrolledPx: number }).scrolledPx - 800)).toBeLessThanOrEqual(5);
  }, 30_000);

  it('scrolls back up with a negative distance', async () => {
    await toTop();
    await call({ method: 'scroll', distance: 1000 });
    const r = await call({ method: 'scroll', distance: -400 });
    expect(r.success, r.error).toBe(true);
    expect(Math.abs((await scrollY()) - 600)).toBeLessThanOrEqual(5);
    // Starting from ~1000, the result is a change of about -400, not the new position.
    const d = r.data as { scrolledPx: number; scrollTopBefore: number };
    expect(Math.abs(d.scrollTopBefore - 1000)).toBeLessThanOrEqual(5);
    expect(Math.abs(d.scrolledPx + 400)).toBeLessThanOrEqual(5);
  }, 30_000);

  it('reports what actually scrolled when the page ends first', async () => {
    await toTop();
    const max = (await evaluate('document.documentElement.scrollHeight - innerHeight')) as number;
    const r = await call({ method: 'scroll', distance: max + 3000, speed: 6000 });
    expect(r.success, r.error).toBe(true);
    const d = r.data as { scrolledPx: number };
    expect(Math.abs(d.scrolledPx - max)).toBeLessThanOrEqual(5);
    expect(d.scrolledPx).toBeLessThan(max + 3000);
  }, 30_000);

  it('repeats the gesture: distance 300 with repeat 1 scrolls about 600', async () => {
    await toTop();
    const r = await call({ method: 'scroll', distance: 300, repeat: 1, repeatDelayMs: 100, speed: 3000 });
    expect(r.success, r.error).toBe(true);
    expect(Math.abs((await scrollY()) - 600)).toBeLessThanOrEqual(10);
  }, 30_000);

  it('sends wheel events for a mouse gesture and touch events for a touch gesture', async () => {
    await toTop();
    await evaluate('window.__input = { wheel: 0, touch: 0, mouse: 0 }');
    const mouse = await call({ method: 'scroll', distance: 400, speed: 3000 });
    expect(mouse.success, mouse.error).toBe(true);
    const afterMouse = (await evaluate('({ ...window.__input })')) as Record<string, number>;
    expect(afterMouse.wheel).toBeGreaterThan(0);
    expect(afterMouse.touch).toBe(0);

    await toTop();
    await evaluate('window.__input = { wheel: 0, touch: 0, mouse: 0 }');
    const touch = await call({ method: 'scroll', distance: 400, source: 'touch', speed: 3000 });
    expect(touch.success, touch.error).toBe(true);
    const afterTouch = (await evaluate('({ ...window.__input })')) as Record<string, number>;
    expect(afterTouch.touch).toBeGreaterThan(0);
    expect(afterTouch.wheel).toBe(0);
    expect(await scrollY()).toBeGreaterThan(300);
  }, 60_000);

  it('takes longer at a lower speed', async () => {
    await toTop();
    const slow = await call({ method: 'scroll', distance: 400, speed: 400 });
    await toTop();
    const fast = await call({ method: 'scroll', distance: 400, speed: 4000 });
    const slowMs = (slow.data as { gestureMs: number }).gestureMs;
    const fastMs = (fast.data as { gestureMs: number }).gestureMs;
    expect(slowMs).toBeGreaterThan(fastMs + 400);
  }, 60_000);

  it('aims the gesture at the element named by selector', async () => {
    await toTop();
    // #target is a 400px-tall box with its own overflow; the gesture must hit it, not the page.
    await evaluate('document.getElementById("target").style.overflow = "auto"');
    await evaluate('document.getElementById("target").scrollTop = 0');
    const r = await call({ method: 'scroll', distance: 300, selector: '#target', speed: 3000 });
    expect(r.success, r.error).toBe(true);
    const inner = (await evaluate('document.getElementById("target").scrollTop')) as number;
    expect(inner).toBeGreaterThan(200);
    expect(await scrollY()).toBe(0);
    // The result describes the element that scrolled, not the document.
    const d = r.data as { scroller: string; scrolledPx: number; scrollTopBefore: number; scrollTopAfter: number };
    expect(d.scroller).toBe('div#target');
    expect(d.scrollTopBefore).toBe(0);
    expect(Math.abs(d.scrollTopAfter - inner)).toBeLessThanOrEqual(1);
    expect(Math.abs(d.scrolledPx - 300)).toBeLessThanOrEqual(5);
  }, 30_000);

  it('keeps measuring the scroller it started with when another box moves under the point', async () => {
    await toTop();
    // At the center point the document is the scroller. After 900px of document scroll, the
    // nested #lower box (top: 1100px) sits under that same point; it must not be measured.
    const r = await call({ method: 'scroll', distance: 900, speed: 3000 });
    expect(r.success, r.error).toBe(true);
    const d = r.data as { scroller: string; scrolledPx: number; scrollTopBefore: number };
    expect(d.scroller).toBe('document');
    expect(Math.abs(d.scrolledPx - 900)).toBeLessThanOrEqual(5);
    expect(await evaluate('document.getElementById("lower").scrollTop')).toBe(0);
  }, 30_000);

  it('latches a gesture to the nested box: the document stays put and says so', async () => {
    await toTop();
    await evaluate('document.getElementById("target").style.overflow = "auto"');
    // 2500px at a 1600px-range box: Chrome latches the whole gesture to the box, so nothing chains.
    const r = await call({ method: 'scroll', distance: 2500, selector: '#target', speed: 6000 });
    expect(r.success, r.error).toBe(true);
    const d = r.data as { scroller: string; scrolledPx: number; documentScrolledPx?: number };
    expect(d.scroller).toBe('div#target');
    expect(Math.abs(d.scrolledPx - 1600)).toBeLessThanOrEqual(5);
    expect(d.documentScrolledPx).toBe(0);
  }, 60_000);

  it('reports the document when a nested box under the point cannot scroll that way', async () => {
    await toTop();
    await call({ method: 'scroll', distance: 1000, speed: 3000 });
    // #lower now sits under the point at its top; wheeling up cannot move it, so the page moves.
    const r = await call({ method: 'scroll', distance: -400, speed: 3000 });
    expect(r.success, r.error).toBe(true);
    const d = r.data as { scroller: string; scrolledPx: number; documentScrolledPx?: number };
    expect(d.scroller).toBe('document');
    expect(Math.abs(d.scrolledPx + 400)).toBeLessThanOrEqual(5);
    expect(d.documentScrolledPx).toBeUndefined();
  }, 60_000);

  it('names the selector when nothing matches', async () => {
    const r = await call({ method: 'scroll', distance: 100, selector: '#nope' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/#nope/);
  }, 30_000);
});

// A page that lies about scroll positions rather than the gesture point.
const HOSTILE_POSITIONS_PAGE = `<!doctype html><body style="margin:0"><script>
  Object.defineProperty(Element.prototype, 'scrollTop', { get() { return 'not a number'; }, set() {} });
</script><div style="height:5000px"></div></body>`;

describe.skipIf(!chromeAvailable)('chrome scroll: a page that lies', () => {
  let browser: TestBrowser;
  let server: TestServer;

  beforeAll(async () => {
    browser = await launchTestBrowser();
    server = await servePage(HOSTILE_PAGE);
    const c = await call({ method: 'connect', port: browser.port });
    expect(c.success, c.error).toBe(true);
    await call({ method: 'navigate', url: server.url });
    for (let i = 0; i < 50; i++) {
      if ((await evaluate('document.readyState === "complete" && !!window.__pwnedProbe === false')) === true) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 60_000);

  afterAll(async () => {
    await call({ method: 'disconnect' });
    // Browser first: a server's close waits on the connections Chrome holds open.
    await browser?.close();
    await server?.close();
  }, 30_000);

  it('returns an error, not an exception, when the page lies about scroll positions', async () => {
    const liar = await servePage(HOSTILE_POSITIONS_PAGE);
    try {
      await call({ method: 'navigate', url: liar.url });
      await loaded(liar.url);
      const r = await call({ method: 'scroll', distance: 300 });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/non-numeric scroll position/i);
    } finally {
      // Put the shared tab back on this describe's page for the tests that follow.
      await call({ method: 'navigate', url: server.url });
      await loaded(server.url);
      await liar.close();
    }
  }, 30_000);

  it('rejects a non-numeric gesture point instead of running it as code', async () => {
    const r = await call({ method: 'scroll', distance: 300 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/gesture point/i);
    expect(await evaluate('window.__pwned')).toBeUndefined();
  }, 30_000);
});

describe.skipIf(!chromeAvailable)('chrome connection: commands in flight when it ends', () => {
  let browser: TestBrowser;
  const HANG = 'new Promise(() => {})';

  beforeAll(async () => {
    browser = await launchTestBrowser();
  }, 60_000);

  afterAll(async () => {
    await call({ method: 'disconnect' });
    await browser?.close();
  }, 30_000);

  /** A new tab, connected. */
  const freshTab = async (): Promise<string> => {
    const created = await fetch(`http://127.0.0.1:${browser.port}/json/new?about:blank`, { method: 'PUT' });
    const tab = (await created.json()) as { id: string };
    const c = await call({ method: 'connect', port: browser.port, targetId: tab.id });
    expect(c.success, c.error).toBe(true);
    return tab.id;
  };

  /** Starts an evaluate that never settles; resolves, once its command is on the socket, with the call (boxed, so it is not awaited). */
  const hangingEvaluate = async () => {
    const real = WebSocket.prototype.send;
    let sent!: () => void;
    const onSocket = new Promise<void>((r) => (sent = r));
    const spy = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, data: unknown, ...rest: unknown[]) {
      if (typeof data === 'string' && data.includes(HANG)) sent();
      return (real as (...a: unknown[]) => void).call(this, data, ...rest);
    });
    const pending = call({ method: 'evaluate', expression: HANG });
    try {
      await onSocket;
    } finally {
      spy.mockRestore();
    }
    return { pending };
  };

  const within = async <T>(p: Promise<T>, ms: number): Promise<T | 'still pending'> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([p, new Promise<'still pending'>((r) => (timer = setTimeout(() => r('still pending'), ms)))]);
    } finally {
      clearTimeout(timer);
    }
  };

  it('ends an evaluate in flight at once when its tab closes', async () => {
    const id = await freshTab();
    const { pending } = await hangingEvaluate();
    const startedAt = Date.now();
    await fetch(`http://127.0.0.1:${browser.port}/json/close/${id}`);
    const r = await within(pending, 5000);
    expect(r).not.toBe('still pending');
    expect(Date.now() - startedAt).toBeLessThan(5000);
    const result = r as Awaited<typeof pending>;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Connection to Chrome closed/);
  }, 60_000);

  it('ends an evaluate in flight at once on disconnect', async () => {
    await freshTab();
    const { pending } = await hangingEvaluate();
    const startedAt = Date.now();
    await call({ method: 'disconnect' });
    const r = await within(pending, 5000);
    expect(r).not.toBe('still pending');
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect((r as Awaited<typeof pending>).error).toMatch(/Connection to Chrome closed/);
  }, 60_000);
});
