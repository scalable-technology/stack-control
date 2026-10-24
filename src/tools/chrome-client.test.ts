import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { METRICS_WORLD_NAME } from './chrome-metrics.js';
import { ChromeCDPClient } from './chrome.js';

/**
 * A stand-in for Chrome's debug port: /json/list names one target, and its socket answers every
 * command except those in `silent`, which it leaves hanging, as a busy or dying tab does.
 */
async function fakeChrome(silent: string[]) {
  const sockets: ServerSocket[] = [];
  const server: Server = createServer((req, res) => {
    const port = (server.address() as { port: number }).port;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/json/list'
      ? [{ id: 'T1', title: 'fake', url: 'about:blank', type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/T1` }]
      : {}));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as { id: number; method: string };
      if (!silent.includes(m.method)) socket.send(JSON.stringify({ id: m.id, result: {} }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  return {
    port: (server.address() as { port: number }).port,
    /** Chrome sends an event on every open socket. */
    emit: (event: Record<string, unknown>) => sockets.forEach((s) => s.send(JSON.stringify(event))),
    /** The tab dies: Chrome drops the socket. */
    dropSockets: () => sockets.forEach((s) => s.terminate()),
    close: async () => {
      sockets.forEach((s) => s.terminate());
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** The value, or 'still pending' if it has not settled within ms: a hang fails an assertion, not the test timeout. */
const within = async <T>(p: Promise<T>, ms: number): Promise<T | 'still pending'> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<'still pending'>((r) => (timer = setTimeout(() => r('still pending'), ms)))]);
  } finally {
    clearTimeout(timer);
  }
};

const timers = () => process.getActiveResourcesInfo().filter((k) => k === 'Timeout').length;

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function connected(silent: string[]) {
  const chrome = await fakeChrome(silent);
  cleanup.push(chrome.close);
  const client = new ChromeCDPClient(chrome.port);
  cleanup.push(() => client.disconnect());
  await client.connect();
  return { chrome, client };
}

describe('ChromeCDPClient: commands in flight when the connection ends', () => {
  it('rejects them at once, after teardown, when Chrome drops the socket', async () => {
    const { chrome, client } = await connected(['Hang.forever']);
    let tornDown = false;
    client.on('teardown', () => (tornDown = true));
    const started = Date.now();
    const pending = client.sendCommand('Hang.forever', {}, 600_000);
    let sawTeardown: boolean | undefined;
    const settled = pending.catch((error: Error) => {
      sawTeardown = tornDown;
      return error;
    });
    chrome.dropSockets();
    const error = await within(settled, 3000);
    expect(error).not.toBe('still pending');
    expect(Date.now() - started).toBeLessThan(2000);
    expect((error as Error).message).toBe('Connection to Chrome closed');
    // The recorder is reset on teardown, so code that awaited the command sees the reset.
    expect(sawTeardown).toBe(true);
  });

  it('rejects them at once on disconnect', async () => {
    const { client } = await connected(['Hang.forever']);
    const pending = client.sendCommand('Hang.forever', {}, 600_000).catch((e: Error) => e);
    const started = Date.now();
    client.disconnect();
    const error = await within(pending, 3000);
    expect(error).not.toBe('still pending');
    expect((error as Error).message).toBe('Connection to Chrome closed');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('clears the timer of each command it rejects, so nothing holds the event loop', async () => {
    // ws starts timers of its own for the close handshake: a client with nothing pending is the control.
    const control = (await connected([])).client;
    const controlBefore = timers();
    control.disconnect();
    const closeTimers = timers() - controlBefore;

    const { client } = await connected(['Hang.forever']);
    const before = timers();
    const pending = [1, 2, 3].map(() => client.sendCommand('Hang.forever', {}, 600_000).catch(() => {}));
    expect(timers()).toBe(before + 3);
    client.disconnect();
    expect(await within(Promise.all(pending), 3000)).not.toBe('still pending');
    expect(timers()).toBe(before + closeTimers);
  });

  it('clears the timer when the send itself throws', async () => {
    const { client } = await connected([]);
    const before = timers();
    const ws = (client as unknown as { ws: { send: (d: string) => void } }).ws;
    ws.send = () => {
      throw new Error('socket write failed');
    };
    await expect(client.sendCommand('Any.method', {}, 600_000)).rejects.toThrow('socket write failed');
    expect(timers()).toBe(before);
  });

  it('still times out a command that gets no answer on a live connection', async () => {
    const { client } = await connected(['Hang.forever']);
    await expect(client.sendCommand('Hang.forever', {}, 50)).rejects.toThrow('Command Hang.forever timed out after 0.05s');
  });
});

describe("ChromeCDPClient: the metrics world Chrome announced", () => {
  const context = (id: number, name = METRICS_WORLD_NAME) => ({
    id, uniqueId: `U-${id}`, name, origin: 'http://page', auxData: { frameId: 'T1', type: name === METRICS_WORLD_NAME ? 'isolated' : 'default' },
  });
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it('keeps it from the event before re-emitting it, and forgets it when the session ends', async () => {
    const { chrome, client } = await connected([]);
    let keptWhenEmitted: unknown;
    client.on('cdp', () => (keptWhenEmitted = client.metricsWorld()));
    chrome.emit({ method: 'Runtime.executionContextCreated', params: { context: context(5) } });
    await until(() => client.metricsWorld() !== undefined);
    expect(client.metricsWorld()).toEqual({ id: 5, uniqueId: 'U-5', name: METRICS_WORLD_NAME, type: 'isolated', frameId: 'T1' });
    expect(keptWhenEmitted).toEqual(client.metricsWorld());
    chrome.dropSockets();
    await until(() => client.metricsWorld() === undefined);
    expect(client.metricsWorld()).toBeUndefined();
  });

  it('forgets it on disconnect', async () => {
    const { chrome, client } = await connected([]);
    chrome.emit({ method: 'Runtime.executionContextCreated', params: { context: context(5) } });
    await until(() => client.metricsWorld() !== undefined);
    client.disconnect();
    expect(client.metricsWorld()).toBeUndefined();
  });

  it('keeps it, and nothing else, through 5000 other contexts', async () => {
    const { chrome, client } = await connected([]);
    chrome.emit({ method: 'Runtime.executionContextCreated', params: { context: context(1) } });
    await until(() => client.metricsWorld() !== undefined);
    let seen = 0;
    client.on('cdp', () => seen++);
    for (let id = 2; id <= 5001; id++) chrome.emit({ method: 'Runtime.executionContextCreated', params: { context: context(id, '') } });
    await until(() => seen >= 5000);
    expect(seen).toBe(5000);
    expect(client.metricsWorld()?.id).toBe(1);
    expect((client as unknown as { ownWorld: { size: number } }).ownWorld.size).toBe(1);
  });
});
