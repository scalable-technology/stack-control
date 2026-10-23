import { existsSync, readdirSync, readFileSync, rmSync, statSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TRACE_CATEGORIES,
  TraceRecorder,
  startTrace,
  stopTrace,
  type TraceCdp,
} from './chrome-trace-capture.js';

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'trace-capture-test-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface FakeOptions {
  chunks?: { data: string; eof: boolean; base64Encoded?: boolean }[];
  complete?: Record<string, unknown>;
  readError?: string;
  endError?: string;
}

/** A fake CDP: records commands, serves a scripted stream. */
function fake(options: FakeOptions = {}) {
  const chunks = [...(options.chunks ?? [{ data: Buffer.from('{"traceEvents":[]}').toString('base64'), eof: true, base64Encoded: true }])];
  const sent: { method: string; params?: Record<string, unknown> }[] = [];
  let waiting = false;
  const cdp: TraceCdp = {
    sendCommand: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      sent.push({ method, params });
      if (method === 'Tracing.end' && options.endError) return { error: { message: options.endError } };
      if (method === 'IO.read') {
        if (options.readError) return { error: { message: options.readError } };
        const next = chunks.shift();
        return { result: next ?? { data: '', eof: true } };
      }
      return { result: {} };
    }),
    waitForEvent: vi.fn(async (method: string) => {
      waiting = true;
      expect(method).toBe('Tracing.tracingComplete');
      return options.complete ?? { stream: 'stream-1', dataLossOccurred: false };
    }),
  };
  return { cdp, sent, waitedBeforeEnd: () => waiting };
}

const calls = <T extends { method: string }>(sent: T[], method: string) => sent.filter((s) => s.method === method);

describe('startTrace', () => {
  it('starts a streamed json trace with the default categories', async () => {
    const { cdp, sent } = fake();
    await startTrace(cdp, { compress: false });
    const start = calls(sent, 'Tracing.start')[0].params as Record<string, any>;
    expect(start.transferMode).toBe('ReturnAsStream');
    expect(start.streamFormat).toBe('json');
    expect(start.streamCompression).toBe('none');
    expect(start.traceConfig.includedCategories).toEqual(DEFAULT_TRACE_CATEGORIES);
    expect(DEFAULT_TRACE_CATEGORIES.length).toBeGreaterThan(5);
  });

  it('asks Chrome to gzip the stream when compress is set, and honours custom categories', async () => {
    const { cdp, sent } = fake();
    await startTrace(cdp, { compress: true, categories: ['devtools.timeline', 'cc'] });
    const start = calls(sent, 'Tracing.start')[0].params as Record<string, any>;
    expect(start.streamCompression).toBe('gzip');
    expect(start.traceConfig.includedCategories).toEqual(['devtools.timeline', 'cc']);
  });

  it('throws Chrome\'s message when Tracing.start fails', async () => {
    const { cdp } = fake();
    (cdp.sendCommand as any).mockImplementationOnce(async () => ({ error: { message: 'Tracing already started' } }));
    await expect(startTrace(cdp, { compress: false })).rejects.toThrow('Tracing already started');
  });
});

describe('stopTrace', () => {
  it('waits for tracingComplete before ending, reads the stream to eof and closes it', async () => {
    const dir = tempDir();
    const a = Buffer.from('{"traceEvents":[').toString('base64');
    const b = Buffer.from('{"name":"RunTask"}]}').toString('base64');
    const { cdp, sent, waitedBeforeEnd } = fake({
      chunks: [
        { data: a, eof: false, base64Encoded: true },
        { data: b, eof: true, base64Encoded: true },
      ],
    });
    let waitedAtEnd = false;
    const original = cdp.sendCommand as any;
    (cdp.sendCommand as any) = vi.fn(async (m: string, p?: any) => {
      if (m === 'Tracing.end') waitedAtEnd = waitedBeforeEnd();
      return original(m, p);
    });
    const out = await stopTrace(cdp, { compress: false, dir });
    expect(waitedAtEnd).toBe(true); // the listener was registered before Tracing.end was sent
    expect(calls(sent, 'IO.read')).toHaveLength(2);
    expect(calls(sent, 'IO.close')[0].params).toEqual({ handle: 'stream-1' });
    expect(readFileSync(out.path, 'utf8')).toBe('{"traceEvents":[{"name":"RunTask"}]}');
    expect(out.bytes).toBe(statSync(out.path).size);
    expect(out.compressed).toBe(false);
    expect(out.dataLoss).toBe(false);
    expect(out.path.endsWith('.json')).toBe(true);
  });

  it('writes the file mode 0600 inside a directory mode 0700', async () => {
    const parent = tempDir();
    const dir = join(parent, 'traces');
    const out = await stopTrace(fake().cdp, { compress: false, dir });
    expect(statSync(out.path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('names a compressed trace .json.gz and keeps the gzip bytes Chrome sent', async () => {
    const dir = tempDir();
    const { gzipSync } = await import('node:zlib');
    const gz = gzipSync('{"traceEvents":[]}');
    const { cdp } = fake({ chunks: [{ data: gz.toString('base64'), eof: true, base64Encoded: true }] });
    const out = await stopTrace(cdp, { compress: true, dir });
    expect(out.path.endsWith('.json.gz')).toBe(true);
    expect(out.compressed).toBe(true);
    expect(gunzipSync(readFileSync(out.path)).toString()).toBe('{"traceEvents":[]}');
  });

  it('reads a non-base64 stream as utf8', async () => {
    const dir = tempDir();
    const { cdp } = fake({ chunks: [{ data: '{"traceEvents":[]}', eof: true, base64Encoded: false }] });
    const out = await stopTrace(cdp, { compress: false, dir });
    expect(readFileSync(out.path, 'utf8')).toBe('{"traceEvents":[]}');
  });

  it('reports data loss from Chrome', async () => {
    const dir = tempDir();
    const out = await stopTrace(fake({ complete: { stream: 's', dataLossOccurred: true } }).cdp, { compress: false, dir });
    expect(out.dataLoss).toBe(true);
  });

  it('gives distinct paths to two traces', async () => {
    const dir = tempDir();
    const a = await stopTrace(fake().cdp, { compress: false, dir });
    const b = await stopTrace(fake().cdp, { compress: false, dir });
    expect(a.path).not.toBe(b.path);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('deletes the partial file and throws when the stream fails mid-read', async () => {
    const dir = tempDir();
    await expect(stopTrace(fake({ readError: 'stream gone' }).cdp, { compress: false, dir })).rejects.toThrow('stream gone');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('closes the stream even when reading fails', async () => {
    const dir = tempDir();
    const { cdp, sent } = fake({ readError: 'stream gone' });
    await stopTrace(cdp, { compress: false, dir }).catch(() => {});
    expect(calls(sent, 'IO.close')).toHaveLength(1);
  });

  it('throws when Chrome finishes without a stream, and writes nothing', async () => {
    const dir = tempDir();
    await expect(
      stopTrace(fake({ complete: { dataLossOccurred: false } }).cdp, { compress: false, dir })
    ).rejects.toThrow(/stream/i);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it('throws Chrome\'s message when Tracing.end fails', async () => {
    const dir = tempDir();
    await expect(stopTrace(fake({ endError: 'not tracing' }).cdp, { compress: false, dir })).rejects.toThrow('not tracing');
  });

  it('writes a trace of many chunks without holding it whole', async () => {
    const dir = tempDir();
    const chunk = Buffer.alloc(300_000, 'a').toString('base64');
    const chunks = Array.from({ length: 20 }, (_, i) => ({ data: chunk, eof: i === 19, base64Encoded: true }));
    const out = await stopTrace(fake({ chunks }).cdp, { compress: false, dir });
    expect(out.bytes).toBe(300_000 * 20);
  });
});

describe('TraceRecorder', () => {
  it('starts, reports it is running, and stops into a file with a duration', async () => {
    const dir = tempDir();
    const { cdp } = fake();
    const rec = new TraceRecorder();
    expect(rec.running).toBe(false);
    await rec.start(cdp, { compress: false });
    expect(rec.running).toBe(true);
    const out = await rec.stop(cdp, { dir });
    expect(rec.running).toBe(false);
    expect(out.path.endsWith('.json')).toBe(true);
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('refuses a second start and says how long the first has run', async () => {
    const { cdp, sent } = fake();
    const rec = new TraceRecorder();
    await rec.start(cdp, { compress: true });
    await expect(rec.start(cdp, { compress: true })).rejects.toThrow(/already running \(started \d+s ago\)/);
    expect(calls(sent, 'Tracing.start')).toHaveLength(1); // the second start never reached Chrome
  });

  it('refuses to stop when nothing is recording', async () => {
    await expect(new TraceRecorder().stop(fake().cdp, { dir: tempDir() })).rejects.toThrow(/No trace is running/);
  });

  it('does not mark a trace as running when Tracing.start fails', async () => {
    const { cdp } = fake();
    (cdp.sendCommand as any).mockImplementationOnce(async () => ({ error: { message: 'busy' } }));
    const rec = new TraceRecorder();
    await expect(rec.start(cdp, { compress: false })).rejects.toThrow('busy');
    expect(rec.running).toBe(false);
  });

  it('stops being "running" even when stopping fails', async () => {
    const rec = new TraceRecorder();
    await rec.start(fake().cdp, { compress: false });
    await expect(rec.stop(fake({ readError: 'stream gone' }).cdp, { dir: tempDir() })).rejects.toThrow('stream gone');
    expect(rec.running).toBe(false);
  });

  it('stops with the compression it started with', async () => {
    const dir = tempDir();
    const rec = new TraceRecorder();
    await rec.start(fake().cdp, { compress: true });
    const out = await rec.stop(fake().cdp, { dir });
    expect(out.compressed).toBe(true);
    expect(out.path.endsWith('.json.gz')).toBe(true);
  });

  it('reset forgets a running trace', async () => {
    const rec = new TraceRecorder();
    await rec.start(fake().cdp, { compress: false });
    rec.reset();
    expect(rec.running).toBe(false);
    await expect(rec.stop(fake().cdp, { dir: tempDir() })).rejects.toThrow(/No trace is running/);
  });
});
