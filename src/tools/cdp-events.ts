/**
 * Wait for one CDP event on an emitter that re-emits every event as 'cdp' and
 * announces the end of its connection as 'teardown'.
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

/** What is kept of one Runtime.executionContextCreated: never origin or anything else of the page's. */
export interface ExecutionContextRecord {
  id: number;
  uniqueId: string;
  /** '' when Chrome sent no string or a longer one than any world of ours has. */
  name: string;
  type: string;
  frameId: string;
}

/** The page controls how many frames, so how many contexts, exist; past this the oldest is dropped. */
export const MAX_EXECUTION_CONTEXTS = 1000;
const MAX_UNIQUE_ID = 200;
const MAX_NAME = 64;
const MAX_TYPE = 32;
const MAX_FRAME_ID = 200;

/** A string of Chrome's within max characters, or '' (which matches nothing of ours). */
const short = (value: unknown, max: number): string => (typeof value === 'string' && value.length <= max ? value : '');

/**
 * The live execution contexts of one session, by numeric id, from the Runtime events Chrome sends.
 * A lookup answers what Chrome last announced for an id: a world it rebuilt on navigation, announced
 * before anyone asked, or a page world that took over a number. Losing an entry (evicted, skipped)
 * only turns a lookup into a miss.
 */
export class ExecutionContextMap {
  private contexts = new Map<number, ExecutionContextRecord>();

  get size(): number {
    return this.contexts.size;
  }

  get(id: number): ExecutionContextRecord | undefined {
    return this.contexts.get(id);
  }

  clear(): void {
    this.contexts.clear();
  }

  /** Feed one CDP event; any other event is ignored. */
  onEvent(event: { method?: string; params?: Record<string, unknown> }): void {
    const params = event.params ?? {};
    switch (event.method) {
      case 'Runtime.executionContextCreated': {
        const c = params.context as Record<string, unknown> | null | undefined;
        if (typeof c !== 'object' || c === null || typeof c.id !== 'number' || !Number.isFinite(c.id)) return;
        // A new context under this number replaces whatever had it, even when it cannot be kept.
        this.contexts.delete(c.id);
        const uniqueId = short(c.uniqueId, MAX_UNIQUE_ID);
        if (uniqueId === '') return;
        const aux = (typeof c.auxData === 'object' && c.auxData !== null ? c.auxData : {}) as Record<string, unknown>;
        if (this.contexts.size >= MAX_EXECUTION_CONTEXTS) this.contexts.delete(this.contexts.keys().next().value as number);
        this.contexts.set(c.id, {
          id: c.id,
          uniqueId,
          name: short(c.name, MAX_NAME),
          type: short(aux.type, MAX_TYPE),
          frameId: short(aux.frameId, MAX_FRAME_ID),
        });
        return;
      }
      case 'Runtime.executionContextDestroyed': {
        if (typeof params.executionContextId === 'number') this.contexts.delete(params.executionContextId);
        if (typeof params.executionContextUniqueId === 'string') {
          for (const [id, record] of this.contexts) {
            if (record.uniqueId === params.executionContextUniqueId) this.contexts.delete(id);
          }
        }
        return;
      }
      case 'Runtime.executionContextsCleared':
        this.contexts.clear();
        return;
    }
  }
}
