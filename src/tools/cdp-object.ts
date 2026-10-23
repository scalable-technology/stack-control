/**
 * Hold a remote object (by handle) for the length of one callback, then release it.
 * An unreleased handle keeps the object, and anything it reaches, alive in the page
 * for as long as the debugger session lasts.
 */

export interface CdpSender {
  sendCommand(
    method: string,
    params?: Record<string, unknown>
  ): Promise<{ result?: unknown; error?: { message: string } }>;
}

export async function withRemoteObject<T>(
  cdp: CdpSender,
  expression: string,
  use: (objectId: string) => Promise<T>
): Promise<T> {
  const found = await cdp.sendCommand('Runtime.evaluate', { expression, returnByValue: false });
  const objectId = (found.result as { result?: { objectId?: string } } | undefined)?.result?.objectId;
  if (!objectId) throw new Error('The page returned no remote object for the expression');
  try {
    return await use(objectId);
  } finally {
    // Best effort: the page may have navigated or the target closed, which already drops the handle.
    await cdp.sendCommand('Runtime.releaseObject', { objectId }).catch(() => {});
  }
}
