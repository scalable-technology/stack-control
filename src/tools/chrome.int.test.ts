import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
<div style="height:5000px;background:linear-gradient(#fff,#888)"></div></body>`;

const scrollY = async () => (await evaluate('window.scrollY')) as number;
// Reset to the top. A gesture's momentum outlives the CDP call that returned, and scrolling to
// the top while it is still running leaves the next gesture scrolling further than asked, so
// let the browser go idle first.
const toTop = async () => {
  await new Promise((r) => setTimeout(r, 1200));
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
  ])('rejects %j and names the field %s', async (input, field) => {
    const r = await call(input);
    expect(r.success).toBe(false);
    // The path is in the zod message: this fails if scroll is not a known method at all.
    expect(r.error).toMatch(new RegExp(`"${field}"`));
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
    await server?.close();
    await browser?.close();
  }, 30_000);

  it('scrolls down by the requested distance with a real wheel gesture', async () => {
    await toTop();
    const r = await call({ method: 'scroll', distance: 800 });
    expect(r.success, r.error).toBe(true);
    expect(Math.abs((await scrollY()) - 800)).toBeLessThanOrEqual(5);
    expect(r.data).toMatchObject({ source: 'mouse', scrollTopBefore: 0 });
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
  }, 30_000);

  it('names the selector when nothing matches', async () => {
    const r = await call({ method: 'scroll', distance: 100, selector: '#nope' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/#nope/);
  }, 30_000);
});
