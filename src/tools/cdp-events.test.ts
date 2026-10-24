import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionContextMap, MAX_EXECUTION_CONTEXTS, waitForCdpEvent, waitForCdpEventMatching } from './cdp-events.js';

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

describe('ExecutionContextMap', () => {
  const created = (context: Record<string, unknown>) => ({ method: 'Runtime.executionContextCreated', params: { context } });
  const world = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    uniqueId: `U-${id}`,
    name: 'control-metrics',
    origin: 'http://page.example',
    auxData: { frameId: 'F1', isDefault: false, type: 'isolated' },
    ...extra,
  });

  it('keeps a trimmed record of each announced context, never its origin', () => {
    const m = new ExecutionContextMap();
    m.onEvent(created(world(3)));
    expect(m.get(3)).toEqual({ id: 3, uniqueId: 'U-3', name: 'control-metrics', type: 'isolated', frameId: 'F1' });
    expect(JSON.stringify(m.get(3))).not.toMatch(/page\.example|isDefault/);
  });

  it('lets a later context under the same number replace the earlier one', () => {
    const m = new ExecutionContextMap();
    m.onEvent(created(world(3)));
    m.onEvent(created(world(3, { uniqueId: 'PAGE', name: '', auxData: { frameId: 'F1', type: 'default' } })));
    expect(m.get(3)).toMatchObject({ uniqueId: 'PAGE', name: '', type: 'default' });
    expect(m.size).toBe(1);
  });

  it.each([
    ['missing', undefined],
    ['not a string', 7],
    ['empty', ''],
    ['10k characters', 'u'.repeat(10_000)],
  ])('skips a context whose unique id is %s, and forgets what had its number', (_label, uniqueId) => {
    const m = new ExecutionContextMap();
    m.onEvent(created(world(3)));
    m.onEvent(created(world(3, { uniqueId })));
    expect(m.get(3)).toBeUndefined();
  });

  it('keeps a 200-character unique id', () => {
    const m = new ExecutionContextMap();
    m.onEvent(created(world(3, { uniqueId: 'u'.repeat(200) })));
    expect(m.get(3)?.uniqueId).toBe('u'.repeat(200));
  });

  it('stores an over-long or non-string name, type or frame id as empty, so it matches nothing', () => {
    const m = new ExecutionContextMap();
    m.onEvent(created(world(3, { name: 'control-metrics' + 'x'.repeat(10_000) })));
    m.onEvent(created(world(4, { name: 5, auxData: { frameId: 'f'.repeat(201), type: 't'.repeat(33) } })));
    m.onEvent(created(world(5, { auxData: null })));
    expect(m.get(3)!.name).toBe('');
    expect(m.get(4)).toMatchObject({ name: '', frameId: '', type: '' });
    expect(m.get(5)).toMatchObject({ frameId: '', type: '' });
    expect(JSON.stringify([m.get(3), m.get(4)]).length).toBeLessThan(300);
  });

  it('ignores a context that is not an object or has no finite numeric id', () => {
    const m = new ExecutionContextMap();
    for (const context of [null, 'x', { ...world(1), id: '1' }, { ...world(1), id: NaN }, { ...world(1), id: Infinity }]) {
      m.onEvent({ method: 'Runtime.executionContextCreated', params: { context: context as Record<string, unknown> } });
    }
    m.onEvent({ method: 'Runtime.executionContextCreated' });
    expect(m.size).toBe(0);
  });

  it('removes a destroyed context by numeric id, and by unique id', () => {
    const m = new ExecutionContextMap();
    m.onEvent(created(world(3)));
    m.onEvent(created(world(4)));
    m.onEvent({ method: 'Runtime.executionContextDestroyed', params: { executionContextId: 3 } });
    m.onEvent({ method: 'Runtime.executionContextDestroyed', params: { executionContextUniqueId: 'U-4' } });
    expect(m.get(3)).toBeUndefined();
    expect(m.get(4)).toBeUndefined();
  });

  it('forgets everything on executionContextsCleared and on clear', () => {
    const m = new ExecutionContextMap();
    m.onEvent(created(world(3)));
    m.onEvent({ method: 'Runtime.executionContextsCleared', params: {} });
    expect(m.size).toBe(0);
    m.onEvent(created(world(4)));
    m.clear();
    expect(m.size).toBe(0);
  });

  it(`holds at most ${MAX_EXECUTION_CONTEXTS} contexts, dropping the oldest first`, () => {
    const m = new ExecutionContextMap();
    for (let id = 1; id <= MAX_EXECUTION_CONTEXTS + 5; id++) m.onEvent(created(world(id)));
    expect(m.size).toBe(MAX_EXECUTION_CONTEXTS);
    for (let id = 1; id <= 5; id++) expect(m.get(id)).toBeUndefined();
    expect(m.get(6)).toBeDefined();
    expect(m.get(MAX_EXECUTION_CONTEXTS + 5)).toBeDefined();
  });

  it('ignores other events', () => {
    const m = new ExecutionContextMap();
    m.onEvent({ method: 'Network.requestWillBeSent', params: { context: world(1) } });
    expect(m.size).toBe(0);
  });
});

describe('ExecutionContextMap: a protected name', () => {
  const created = (id: number, name: string) => ({
    method: 'Runtime.executionContextCreated',
    params: { context: { id, uniqueId: `U-${id}`, name, auxData: { frameId: 'F1', type: 'isolated' } } },
  });

  it('never evicts a context with that name; the others go oldest first', () => {
    const m = new ExecutionContextMap({ protectedName: 'ours-nonce' });
    m.onEvent(created(1, 'ours-nonce'));
    for (let id = 2; id <= MAX_EXECUTION_CONTEXTS + 10; id++) m.onEvent(created(id, ''));
    expect(m.size).toBe(MAX_EXECUTION_CONTEXTS);
    expect(m.get(1)?.name).toBe('ours-nonce');
    for (let id = 2; id <= 11; id++) expect(m.get(id)).toBeUndefined();
    expect(m.get(12)).toBeDefined();
    expect(m.get(MAX_EXECUTION_CONTEXTS + 10)).toBeDefined();
  });

  it('evicts the oldest when every context has the protected name', () => {
    const m = new ExecutionContextMap({ protectedName: 'p' });
    for (let id = 1; id <= MAX_EXECUTION_CONTEXTS + 1; id++) m.onEvent(created(id, 'p'));
    expect(m.size).toBe(MAX_EXECUTION_CONTEXTS);
    expect(m.get(1)).toBeUndefined();
    expect(m.get(2)).toBeDefined();
  });

  it('protects nothing without the option', () => {
    const m = new ExecutionContextMap();
    m.onEvent(created(1, ''));
    for (let id = 2; id <= MAX_EXECUTION_CONTEXTS + 1; id++) m.onEvent(created(id, 'x'));
    expect(m.get(1)).toBeUndefined();
  });
});
