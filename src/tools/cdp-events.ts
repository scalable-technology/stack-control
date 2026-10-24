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
 * the type and the frame id. Origin and every other field of the event are dropped.
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
 * The last isolated world with our name that Chrome announced on one session, from its Runtime
 * events, and nothing about any other context: a page controls how many of those exist. Chrome keeps
 * one world per frame and name and rebuilds it on navigation, so this is the world createIsolatedWorld
 * answers with. It is forgotten when Chrome says it is gone, when a newer world of ours is announced
 * that cannot be kept, and when any other context is announced under its number: that number now
 * names something else.
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
      case 'Runtime.executionContextDestroyed':
        if (
          this.world !== undefined &&
          (params.executionContextId === this.world.id || params.executionContextUniqueId === this.world.uniqueId)
        ) {
          this.world = undefined;
        }
        return;
      case 'Runtime.executionContextsCleared':
        this.world = undefined;
        return;
    }
  }
}
