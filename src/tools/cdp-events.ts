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
  return new Promise((resolve, reject) => {
    const onEvent = (event: { method?: string; params?: Record<string, unknown> }) => {
      if (event.method !== method) return;
      cleanup();
      resolve(event.params ?? {});
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
