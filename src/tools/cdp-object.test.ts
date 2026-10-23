import { describe, expect, it, vi } from 'vitest';
import { withRemoteObject, type CdpSender } from './cdp-object.js';

const fakeCdp = (objectId: string | undefined) => {
  const sendCommand = vi.fn(async (method: string, _params?: Record<string, unknown>) =>
    method === 'Runtime.evaluate' ? { result: { result: objectId ? { objectId } : {} } } : { result: {} }
  );
  return { cdp: { sendCommand } as CdpSender, sendCommand };
};

const released = (sendCommand: ReturnType<typeof fakeCdp>['sendCommand']) =>
  sendCommand.mock.calls.filter(([m]) => m === 'Runtime.releaseObject').map(([, p]) => p);

describe('withRemoteObject', () => {
  it('evaluates to a handle, passes its id to the callback and returns the result', async () => {
    const { cdp, sendCommand } = fakeCdp('obj-1');
    const out = await withRemoteObject(cdp, '[1]', async (id) => `used ${id}`);
    expect(out).toBe('used obj-1');
    expect(sendCommand).toHaveBeenCalledWith('Runtime.evaluate', { expression: '[1]', returnByValue: false });
  });

  it('releases the handle after the callback returns', async () => {
    const { cdp, sendCommand } = fakeCdp('obj-1');
    await withRemoteObject(cdp, '[1]', async () => 1);
    expect(released(sendCommand)).toEqual([{ objectId: 'obj-1' }]);
  });

  it('releases the handle when the callback throws, and rethrows', async () => {
    const { cdp, sendCommand } = fakeCdp('obj-1');
    await expect(withRemoteObject(cdp, '[1]', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(released(sendCommand)).toEqual([{ objectId: 'obj-1' }]);
  });

  it('does not release, and says so, when the page gave no handle', async () => {
    const { cdp, sendCommand } = fakeCdp(undefined);
    await expect(withRemoteObject(cdp, '[1]', async () => 1)).rejects.toThrow(/no remote object/i);
    expect(released(sendCommand)).toEqual([]);
  });

  it('still returns the callback result when releasing fails', async () => {
    const sendCommand = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
      if (method === 'Runtime.releaseObject') throw new Error('target closed');
      return { result: { result: { objectId: 'obj-1' } } };
    });
    await expect(withRemoteObject({ sendCommand } as CdpSender, '[1]', async () => 7)).resolves.toBe(7);
  });
});
