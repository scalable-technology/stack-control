import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnWorldSlot, contextRecord, waitForCdpEvent, waitForCdpEventMatching } from './cdp-events.js';

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

describe('waitForCdpEventMatching', () => {
  const created = (name: string) => ({ method: 'Runtime.executionContextCreated', params: { context: { name } } });
  const named = (want: string) => (p: Record<string, unknown>) => (p.context as { name?: unknown }).name === want;

  it('ignores events the predicate refuses and resolves with the first it accepts', async () => {
    const e = new EventEmitter();
    const p = waitForCdpEventMatching(e, 'Runtime.executionContextCreated', named('ours'), 1000);
    e.emit('cdp', created(''));
    e.emit('cdp', { method: 'Other.event', params: { context: { name: 'ours' } } });
    e.emit('cdp', created('ours'));
    e.emit('cdp', created('ours-later'));
    await expect(p).resolves.toEqual({ context: { name: 'ours' } });
    expect(listeners(e)).toBe(0);
  });

  it('is already listening when it returns, and only for that method', async () => {
    const e = new EventEmitter();
    const seen: string[] = [];
    const p = waitForCdpEventMatching(e, 'X.y', (params) => { seen.push(String(params.n)); return params.n === 2; }, 1000);
    expect(e.listenerCount('cdp')).toBe(1);
    e.emit('cdp', { method: 'X.z', params: { n: 2 } });
    e.emit('cdp', { method: 'X.y', params: { n: 1 } });
    e.emit('cdp', { method: 'X.y', params: { n: 2 } });
    await expect(p).resolves.toEqual({ n: 2 });
    expect(seen).toEqual(['1', '2']);
  });

  it('counts a predicate that throws as a no, without throwing into the emitter', async () => {
    const e = new EventEmitter();
    const p = waitForCdpEventMatching(e, 'X.y', (params) => { if (params.bad) throw new Error('page data'); return true; }, 1000);
    expect(() => e.emit('cdp', { method: 'X.y', params: { bad: true } })).not.toThrow();
    expect(listeners(e)).toBe(2);
    e.emit('cdp', { method: 'X.y', params: { good: true } });
    await expect(p).resolves.toEqual({ good: true });
  });

  it('rejects on timeout when nothing matches, and removes its listeners', async () => {
    vi.useFakeTimers();
    const e = new EventEmitter();
    const p = waitForCdpEventMatching(e, 'X.y', () => false, 2000);
    const assertion = expect(p).rejects.toThrow(/Timed out after 2s waiting for X\.y/);
    e.emit('cdp', { method: 'X.y', params: {} });
    await vi.advanceTimersByTimeAsync(1999);
    expect(listeners(e)).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(listeners(e)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects on teardown and removes its listeners and timer', async () => {
    vi.useFakeTimers();
    const e = new EventEmitter();
    const p = waitForCdpEventMatching(e, 'X.y', () => false, 2000);
    e.emit('teardown');
    await expect(p).rejects.toThrow(/Connection closed while waiting for X\.y/);
    expect(listeners(e)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects on abort and removes its listeners and timer', async () => {
    vi.useFakeTimers();
    const e = new EventEmitter();
    const c = new AbortController();
    const p = waitForCdpEventMatching(e, 'X.y', () => false, 2000, c.signal);
    c.abort();
    await expect(p).rejects.toThrow(/Stopped waiting for X\.y/);
    expect(listeners(e)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('OwnWorldSlot', () => {
  const OURS = 'control-metrics-0123456789ab';
  const created = (context: unknown) => ({ method: 'Runtime.executionContextCreated', params: { context } as Record<string, unknown> });
  const world = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    uniqueId: `U-${id}`,
    name: OURS,
    origin: 'http://page.example',
    auxData: { frameId: 'F1', isDefault: false, type: 'isolated' },
    ...extra,
  });
  const page = (id: number) => world(id, { uniqueId: `P-${id}`, name: '', auxData: { frameId: 'F1', isDefault: true, type: 'default' } });
  const slotWith = (...contexts: unknown[]) => {
    const s = new OwnWorldSlot(OURS);
    for (const c of contexts) s.onEvent(created(c));
    return s;
  };

  it('keeps a trimmed record of our world, never its origin', () => {
    const s = slotWith(world(3));
    expect(s.get()).toEqual({ id: 3, uniqueId: 'U-3', name: OURS, type: 'isolated', frameId: 'F1' });
    expect(JSON.stringify(s.get())).not.toMatch(/page\.example|isDefault/);
    expect(s.size).toBe(1);
  });

  it('takes a newer announcement of our world in place of the older one (a new document)', () => {
    expect(slotWith(world(3), world(9)).get()?.uniqueId).toBe('U-9');
  });

  it.each([
    ['another name', world(3, { name: 'control-metrics' })],
    ['our name with type default', world(3, { auxData: { frameId: 'F1', type: 'default' } })],
    ['our name with no auxData', world(3, { auxData: undefined })],
    ['the page world', page(3)],
    ['a context that is not an object', 'x'],
    ['a context without a finite id', world(Number.NaN)],
  ])('does not take %s', (_label, context) => {
    const s = slotWith(context);
    expect(s.get()).toBeUndefined();
    expect(s.size).toBe(0);
  });

  it.each([
    ['missing', undefined],
    ['not a string', 7],
    ['empty', ''],
    ['10k characters', 'u'.repeat(10_000)],
  ])('does not take our world with a unique id %s, and forgets the older one', (_label, uniqueId) => {
    expect(slotWith(world(3, { uniqueId })).get()).toBeUndefined();
    // A newer world of ours exists that cannot be addressed: the older one is no longer the world.
    expect(slotWith(world(2), world(3, { uniqueId })).get()).toBeUndefined();
  });

  it('keeps a 200-character unique id, and an over-long frame id as empty', () => {
    expect(slotWith(world(3, { uniqueId: 'u'.repeat(200) })).get()?.uniqueId).toBe('u'.repeat(200));
    expect(slotWith(world(3, { auxData: { frameId: 'f'.repeat(201), type: 'isolated' } })).get()?.frameId).toBe('');
  });

  it("forgets our world when another context is announced under its number (the number was reused)", () => {
    expect(slotWith(world(3), page(3)).get()).toBeUndefined();
    expect(slotWith(world(3), world(3, { name: 'other' })).get()).toBeUndefined();
  });

  it('keeps our world through contexts under other numbers', () => {
    expect(slotWith(world(3), page(4), world(5, { name: 'other' })).get()?.id).toBe(3);
  });

  it('holds nothing for a flood of 5000 other contexts', () => {
    const s = slotWith(world(1));
    for (let id = 2; id <= 5001; id++) s.onEvent(created(page(id)));
    expect(s.get()).toEqual({ id: 1, uniqueId: 'U-1', name: OURS, type: 'isolated', frameId: 'F1' });
    expect(s.size).toBe(1);
    const empty = new OwnWorldSlot(OURS);
    for (let id = 2; id <= 5001; id++) empty.onEvent(created(page(id)));
    expect(empty.size).toBe(0);
  });

  it('forgets our world when it is destroyed, by numeric id or by unique id, and not for another', () => {
    const destroyed = (params: Record<string, unknown>) => ({ method: 'Runtime.executionContextDestroyed', params });
    const s = slotWith(world(3));
    s.onEvent(destroyed({ executionContextId: 4, executionContextUniqueId: 'U-4' }));
    expect(s.get()?.id).toBe(3);
    s.onEvent(destroyed({ executionContextId: 3 }));
    expect(s.get()).toBeUndefined();
    const t = slotWith(world(3));
    t.onEvent(destroyed({ executionContextUniqueId: 'U-3' }));
    expect(t.get()).toBeUndefined();
  });

  it('matches a destroyed context by its unique id when Chrome gives one, never by a reused number', () => {
    const destroyed = (params: Record<string, unknown>) => ({ method: 'Runtime.executionContextDestroyed', params });
    // Our rebuilt world B holds number 3; the old renderer's context A, also number 3, dies late.
    const s = slotWith(world(3, { uniqueId: 'U-B' }));
    s.onEvent(destroyed({ executionContextId: 3, executionContextUniqueId: 'U-A' }));
    expect(s.get()?.uniqueId).toBe('U-B');
    s.onEvent(destroyed({ executionContextId: 3, executionContextUniqueId: 'U-B' }));
    expect(s.get()).toBeUndefined();
    // Without a unique id (or with one that is not a string), the number is all there is.
    const t = slotWith(world(3, { uniqueId: 'U-B' }));
    t.onEvent(destroyed({ executionContextId: 3 }));
    expect(t.get()).toBeUndefined();
    const u = slotWith(world(3, { uniqueId: 'U-B' }));
    u.onEvent(destroyed({ executionContextId: 3, executionContextUniqueId: 42 }));
    expect(u.get()).toBeUndefined();
  });

  it('never holds a record with another name or type, whatever is announced', () => {
    const s = new OwnWorldSlot(OURS);
    const stream = [
      world(1), world(2, { name: 'control-metrics' }), page(3), world(4, { auxData: { frameId: 'F1', type: 'default' } }),
      world(5, { name: OURS + 'x' }), world(6, { name: 'CONTROL' }), world(1, { auxData: { frameId: 'F2', type: 'isolated' } }),
      world(7, { auxData: { frameId: 'F1', type: 'Isolated' } }), page(8),
    ];
    let held = 0;
    for (const c of stream) {
      s.onEvent(created(c));
      const w = s.get();
      if (w) {
        held++;
        expect(w.name).toBe(OURS);
        expect(w.type).toBe('isolated');
      }
    }
    expect(held).toBeGreaterThan(0);
    expect(s.get()).toMatchObject({ id: 1, frameId: 'F2' });
  });

  it('forgets our world on executionContextsCleared and on clear', () => {
    const s = slotWith(world(3));
    s.onEvent({ method: 'Runtime.executionContextsCleared', params: {} });
    expect(s.get()).toBeUndefined();
    const t = slotWith(world(3));
    t.clear();
    expect(t.get()).toBeUndefined();
  });

  it('ignores other events', () => {
    expect(new OwnWorldSlot(OURS).get()).toBeUndefined();
    const s = new OwnWorldSlot(OURS);
    s.onEvent({ method: 'Network.requestWillBeSent', params: { context: world(1) } });
    expect(s.get()).toBeUndefined();
  });
});

describe('contextRecord', () => {
  it('trims an announcement to ids, name, type and frame, or nothing without a usable id', () => {
    const context = { id: 3, uniqueId: '1.2', name: 'n', origin: 'o', auxData: { frameId: 'F', type: 't', isDefault: false } };
    expect(contextRecord({ context })).toEqual({ id: 3, uniqueId: '1.2', name: 'n', type: 't', frameId: 'F' });
    expect(contextRecord({ context: { ...context, uniqueId: '' } })).toBeUndefined();
    expect(contextRecord({ context: { ...context, id: '3' } })).toBeUndefined();
    expect(contextRecord({})).toBeUndefined();
  });
});
