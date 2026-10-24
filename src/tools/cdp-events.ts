/**
 * Wait for one CDP event on an emitter that re-emits every event as 'cdp' and
 * announces the end of its connection as 'teardown'; and keep, from those
 * events, the one isolated world of ours that Chrome announced (OwnWorldSlot).
 */

import type { EventEmitter } from 'node:events';

/**
 * Resolve with the params of the next event of this method. The listener is
 * registered before this returns, so an event that arrives right after the
 * caller's next command is not missed. Rejects on timeout, on teardown of the
 * connection, or when the signal aborts; every path removes what it added.
 */
export function waitForCdpEvent(
  emitter: EventEmitter,
  method: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  return waitForCdpEventMatching(emitter, method, () => true, timeoutMs, signal);
}

/**
 * waitForCdpEvent for the first event of this method whose params the predicate accepts. Params are
 * Chrome's data: a predicate that throws on them counts as a no, and the event goes on to the client.
 */
export function waitForCdpEventMatching(
  emitter: EventEmitter,
  method: string,
  predicate: (params: Record<string, unknown>) => boolean,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onEvent = (event: { method?: string; params?: Record<string, unknown> }) => {
      if (event.method !== method) return;
      const params = event.params ?? {};
      let matches = false;
      try {
        matches = predicate(params);
      } catch {
        matches = false;
      }
      if (!matches) return;
      cleanup();
      resolve(params);
    };
    const onTeardown = () => {
      cleanup();
      reject(new Error(`Connection closed while waiting for ${method}`));
    };
    const onAbort = () => {
      cleanup();
      reject(new Error(`Stopped waiting for ${method}`));
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      emitter.off('cdp', onEvent);
      emitter.off('teardown', onTeardown);
      signal?.removeEventListener('abort', onAbort);
    };

    if (signal?.aborted) return onAbort();
    emitter.on('cdp', onEvent);
    emitter.on('teardown', onTeardown);
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${method}`));
    }, timeoutMs);
  });
}

/**
 * What is kept of our world's Runtime.executionContextCreated: the numeric and unique ids, the name,
 * the type and the frame id. Origin and every other field of the event are dropped. Name and type
 * are kept only so the slot's invariant (it holds our name and type 'isolated', nothing else) can be
 * tested through them; nothing downstream checks them again.
 */
export interface ExecutionContextRecord {
  id: number;
  uniqueId: string;
  name: string;
  type: string;
  /** '' when Chrome sent no string or a longer one than a frame id is. */
  frameId: string;
}

const MAX_UNIQUE_ID = 200;
const MAX_FRAME_ID = 200;

/** A string of Chrome's within max characters, or '' (which matches nothing of ours). */
const short = (value: unknown, max: number): string => (typeof value === 'string' && value.length <= max ? value : '');

/**
 * The record of one Runtime.executionContextCreated params, or undefined without a finite numeric id
 * or a usable unique id. Name and type are kept only to be compared with ours.
 */
export function contextRecord(params: Record<string, unknown>): ExecutionContextRecord | undefined {
  const c = params.context as Record<string, unknown> | null | undefined;
  if (typeof c !== 'object' || c === null || typeof c.id !== 'number' || !Number.isFinite(c.id)) return undefined;
  const uniqueId = short(c.uniqueId, MAX_UNIQUE_ID);
  if (uniqueId === '') return undefined;
  const aux = (typeof c.auxData === 'object' && c.auxData !== null ? c.auxData : {}) as Record<string, unknown>;
  return {
    id: c.id,
    uniqueId,
    name: typeof c.name === 'string' ? c.name : '',
    type: typeof aux.type === 'string' ? aux.type : '',
    frameId: short(aux.frameId, MAX_FRAME_ID),
  };
}

/**
 * Our isolated world on one session, from its Runtime events, and nothing about any other context: a
 * page controls how many of those exist. Chrome keeps one world per frame and name and rebuilds it on
 * navigation. This assumes the client makes the named world in ONE frame (the target's main frame),
 * so the last one announced is the one createIsolatedWorld answers with; a world of that name in a
 * second frame would replace the record, and the caller's frame check would then refuse it. It also
 * assumes, as puppeteer does, that Chrome sends executionContextsCleared before it announces the
 * rebuilt world, never after.
 *
 * The rule: an announcement with our name, type 'isolated' and a usable unique id becomes the record.
 * The record is dropped when a world of ours with no usable unique id is announced, when any other
 * context is announced under its number (the number now names something else), when Chrome destroys
 * it (matched by unique id when the event has one, else by number), on executionContextsCleared, and
 * when the session ends (clear).
 */
export class OwnWorldSlot {
  private world: ExecutionContextRecord | undefined;

  constructor(private readonly name: string) {}

  /** 1 while a world is kept, else 0: nothing else is ever held. */
  get size(): number {
    return this.world ? 1 : 0;
  }

  get(): ExecutionContextRecord | undefined {
    return this.world;
  }

  clear(): void {
    this.world = undefined;
  }

  /** Feed one CDP event; any other event is ignored. */
  onEvent(event: { method?: string; params?: Record<string, unknown> }): void {
    const params = event.params ?? {};
    switch (event.method) {
      case 'Runtime.executionContextCreated': {
        const record = contextRecord(params);
        const c = params.context as { id?: unknown; name?: unknown; auxData?: { type?: unknown } | null } | null | undefined;
        const named = typeof c === 'object' && c !== null && c.name === this.name && c.auxData?.type === 'isolated';
        if (named && record) this.world = record;
        else if (named || (this.world !== undefined && c?.id === this.world.id)) this.world = undefined;
        return;
      }
      case 'Runtime.executionContextDestroyed': {
        // Unique ids are never reused; numbers are, so a late death of an old context under our
        // number must not take our rebuilt world with it. The number is used only without one.
        const gone =
          typeof params.executionContextUniqueId === 'string'
            ? params.executionContextUniqueId === this.world?.uniqueId
            : params.executionContextId === this.world?.id;
        if (gone) this.world = undefined;
        return;
      }
      case 'Runtime.executionContextsCleared':
        this.world = undefined;
        return;
    }
  }
}
