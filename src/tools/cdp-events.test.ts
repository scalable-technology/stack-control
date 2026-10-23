import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForCdpEvent } from './cdp-events.js';

afterEach(() => {
  vi.useRealTimers();
});

const listeners = (e: EventEmitter) => e.listenerCount('cdp') + e.listenerCount('teardown');

describe('waitForCdpEvent', () => {
  it('resolves with the params of the next event of that method and ignores others', async () => {
    const e = new EventEmitter();
    const p = waitForCdpEvent(e, 'Tracing.tracingComplete', 1000);
    e.emit('cdp', { method: 'Network.requestWillBeSent', params: { a: 1 } });
    e.emit('cdp', { method: 'Tracing.tracingComplete', params: { stream: 's1' } });
    await expect(p).resolves.toEqual({ stream: 's1' });
  });

  it('is already listening when it returns, so an immediate event is not missed', async () => {
    const e = new EventEmitter();
    const p = waitForCdpEvent(e, 'X.y', 1000);
    expect(e.listenerCount('cdp')).toBe(1);
    e.emit('cdp', { method: 'X.y' });
    await expect(p).resolves.toEqual({});
  });

  it('removes its listeners after resolving', async () => {
    const e = new EventEmitter();
    const p = waitForCdpEvent(e, 'X.y', 1000);
    e.emit('cdp', { method: 'X.y', params: {} });
    await p;
    expect(listeners(e)).toBe(0);
  });

  it('rejects on timeout and removes its listeners', async () => {
    vi.useFakeTimers();
    const e = new EventEmitter();
    const p = waitForCdpEvent(e, 'X.y', 5000);
    const assertion = expect(p).rejects.toThrow(/Timed out after 5s waiting for X\.y/);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(listeners(e)).toBe(0);
  });

  it('rejects when the connection is torn down and removes its listeners', async () => {
    const e = new EventEmitter();
    const p = waitForCdpEvent(e, 'X.y', 1000);
    e.emit('teardown');
    await expect(p).rejects.toThrow(/Connection closed while waiting for X\.y/);
    expect(listeners(e)).toBe(0);
  });

  it('rejects when the signal aborts, removes its listeners and stops its timer', async () => {
    vi.useFakeTimers();
    const e = new EventEmitter();
    const c = new AbortController();
    const p = waitForCdpEvent(e, 'X.y', 60_000, c.signal);
    c.abort();
    await expect(p).rejects.toThrow(/Stopped waiting for X\.y/);
    expect(listeners(e)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects at once, registering nothing, when the signal is already aborted', async () => {
    vi.useFakeTimers();
    const e = new EventEmitter();
    const c = new AbortController();
    c.abort();
    await expect(waitForCdpEvent(e, 'X.y', 1000, c.signal)).rejects.toThrow(/Stopped waiting/);
    expect(listeners(e)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes its abort listener once it has settled', async () => {
    const e = new EventEmitter();
    const c = new AbortController();
    const remove = vi.spyOn(c.signal, 'removeEventListener');
    const p = waitForCdpEvent(e, 'X.y', 1000, c.signal);
    e.emit('cdp', { method: 'X.y', params: {} });
    await p;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('does not treat an abort after resolving as anything', async () => {
    const e = new EventEmitter();
    const c = new AbortController();
    const p = waitForCdpEvent(e, 'X.y', 1000, c.signal);
    e.emit('cdp', { method: 'X.y', params: { ok: true } });
    await expect(p).resolves.toEqual({ ok: true });
    expect(() => c.abort()).not.toThrow();
  });
});
