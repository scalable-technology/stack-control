import { readdirSync, readFileSync, rmSync, statSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TRACE_CATEGORIES,
  TraceRecorder,
  startTrace,
  stopTrace,
  writeAll,
  type TraceCdp,
} from './chrome-trace-capture.js';

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'trace-capture-test-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Chunk {
  data: string;
  eof: boolean;
  base64Encoded?: boolean;
}

interface FakeOptions {
  chunks?: Chunk[];
  complete?: Record<string, unknown>;
  readError?: string;
  endError?: string;
  /** Runs when IO.read call number n (0-based) arrives, before its chunk is returned. */
  onRead?: (n: number) => void;
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

/** A fake CDP: records commands, serves a scripted stream. */
function fake(options: FakeOptions = {}) {
  const chunks = [...(options.chunks ?? [{ data: b64('{"traceEvents":[]}'), eof: true, base64Encoded: true }])];
  const sent: { method: string; params?: Record<string, unknown> }[] = [];
  let waiting = false;
  let signal: AbortSignal | undefined;
  let reads = 0;
  const cdp: TraceCdp = {
    sendCommand: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      sent.push({ method, params });
      if (method === 'Tracing.end' && options.endError) return { error: { message: options.endError } };
      if (method === 'IO.read') {
        options.onRead?.(reads++);
        if (options.readError) return { error: { message: options.readError } };
        const next = chunks.shift();
        return { result: next ?? { data: '', eof: true } };
      }
      return { result: {} };
    }),
    waitForEvent: vi.fn(async (method: string, _timeoutMs: number, s?: AbortSignal) => {
      waiting = true;
      signal = s;
      expect(method).toBe('Tracing.tracingComplete');
      return options.complete ?? { stream: 'stream-1', dataLossOccurred: false };
    }),
  };
  return { cdp, sent, waitedBeforeEnd: () => waiting, signal: () => signal };
}

const calls = <T extends { method: string }>(sent: T[], method: string) => sent.filter((s) => s.method === method);

describe('writeAll', () => {
  it('keeps writing until every byte is out, across short writes', () => {
    const out: number[] = [];
    const written = writeAll((buf, off) => {
      const n = Math.min(3, buf.length - off);
      out.push(...buf.subarray(off, off + n));
      return n;
    }, Buffer.from('abcdefghij'));
    expect(written).toBe(10);
    expect(Buffer.from(out).toString()).toBe('abcdefghij');
  });

  it('throws on a write that makes no progress instead of looping or losing bytes', () => {
    // The fake gives up after a few calls: a regression must fail this test, not spin forever.
    let calls = 0;
    const stuck = () => {
      if (++calls > 50) throw new Error('runaway loop: no progress was never detected');
      return 0;
    };
    expect(() => writeAll(stuck, Buffer.from('abc'))).toThrow(/no progress/i);
    expect(calls).toBe(1);
  });

  it('writes nothing for an empty buffer', () => {
    expect(writeAll(() => { throw new Error('should not be called'); }, Buffer.alloc(0))).toBe(0);
  });
});

describe('startTrace', () => {
  it('starts a streamed json trace with the default categories and a bounded buffer', async () => {
    const { cdp, sent } = fake();
    await startTrace(cdp, { compress: false });
    const start = calls(sent, 'Tracing.start')[0].params as Record<string, any>;
    expect(start.transferMode).toBe('ReturnAsStream');
    expect(start.streamFormat).toBe('json');
    expect(start.streamCompression).toBe('none');
    expect(start.traceConfig.includedCategories).toEqual(DEFAULT_TRACE_CATEGORIES);
    expect(start.traceConfig.recordMode).toBe('recordUntilFull');
    expect(start.traceConfig.traceBufferSizeInKb).toBeGreaterThan(0);
    expect(start.traceConfig.traceBufferSizeInKb).toBeLessThanOrEqual(512 * 1024);
    expect(DEFAULT_TRACE_CATEGORIES.length).toBeGreaterThan(5);
  });

  it('asks Chrome to gzip the stream when compress is set, and honours custom categories', async () => {
    const { cdp, sent } = fake();
    await startTrace(cdp, { compress: true, categories: ['devtools.timeline', 'cc'] });
    const start = calls(sent, 'Tracing.start')[0].params as Record<string, any>;
    expect(start.streamCompression).toBe('gzip');
    expect(start.traceConfig.includedCategories).toEqual(['devtools.timeline', 'cc']);
  });

  it("throws Chrome's message when Tracing.start fails", async () => {
    const { cdp } = fake();
    (cdp.sendCommand as any).mockImplementationOnce(async () => ({ error: { message: 'Tracing already started' } }));
    await expect(startTrace(cdp, { compress: false })).rejects.toThrow('Tracing already started');
  });
});

describe('stopTrace', () => {
  it('waits for tracingComplete before ending, reads the stream to eof and closes it', async () => {
    const dir = tempDir();
    const { cdp, sent, waitedBeforeEnd } = fake({
      chunks: [
        { data: b64('{"traceEvents":['), eof: false, base64Encoded: true },
        { data: b64('{"name":"RunTask"}]}'), eof: true, base64Encoded: true },
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

  it('puts each trace in its own fresh directory (0700) with the file mode 0600', async () => {
    const parent = tempDir();
    const a = await stopTrace(fake().cdp, { compress: false, dir: parent });
    const b = await stopTrace(fake().cdp, { compress: false, dir: parent });
    for (const out of [a, b]) {
      expect(dirname(out.path)).not.toBe(parent);
      expect(dirname(dirname(out.path))).toBe(parent);
      expect(statSync(out.path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(out.path)).mode & 0o777).toBe(0o700);
    }
    expect(dirname(a.path)).not.toBe(dirname(b.path));
    expect(readdirSync(parent)).toHaveLength(2);
  });

  it('names a compressed trace .json.gz and keeps the gzip bytes Chrome sent', async () => {
    const dir = tempDir();
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
    const out = await stopTrace(fake({ complete: { stream: 's', dataLossOccurred: true } }).cdp, { compress: false, dir: tempDir() });
    expect(out.dataLoss).toBe(true);
  });

  it('writes each chunk to disk before it asks for the next', async () => {
    const dir = tempDir();
    const sizesAtRead: number[] = [];
    const chunk = Buffer.alloc(1000, 'a').toString('base64');
    const sizeOnDisk = () => {
      const fresh = readdirSync(dir).map((d) => join(dir, d)).filter((p) => statSync(p).isDirectory());
      return fresh.length ? readdirSync(fresh[0]).reduce((n, f) => n + statSync(join(fresh[0], f)).size, 0) : 0;
    };
    const { cdp } = fake({
      chunks: Array.from({ length: 4 }, (_, i) => ({ data: chunk, eof: i === 3, base64Encoded: true })),
      onRead: () => sizesAtRead.push(sizeOnDisk()),
    });
    await stopTrace(cdp, { compress: false, dir });
    // Before read k is answered, the k chunks before it are already on disk.
    expect(sizesAtRead).toEqual([0, 1000, 2000, 3000]);
  });

  it('writes a trace of many chunks', async () => {
    const dir = tempDir();
    const chunk = Buffer.alloc(300_000, 'a').toString('base64');
    const chunks = Array.from({ length: 20 }, (_, i) => ({ data: chunk, eof: i === 19, base64Encoded: true }));
    const out = await stopTrace(fake({ chunks }).cdp, { compress: false, dir });
    expect(out.bytes).toBe(300_000 * 20);
  });

  it('deletes the partial trace and its directory, and throws, when the stream fails mid-read', async () => {
    const dir = tempDir();
    await expect(stopTrace(fake({ readError: 'stream gone' }).cdp, { compress: false, dir })).rejects.toThrow('stream gone');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('closes the stream even when reading fails', async () => {
    const { cdp, sent } = fake({ readError: 'stream gone' });
    await stopTrace(cdp, { compress: false, dir: tempDir() }).catch(() => {});
    expect(calls(sent, 'IO.close')).toHaveLength(1);
  });

  it('closes the stream when the file cannot be created', async () => {
    const parent = tempDir();
    const blocker = join(parent, 'not-a-directory');
    writeFileSync(blocker, 'x');
    const { cdp, sent } = fake();
    await expect(stopTrace(cdp, { compress: false, dir: join(blocker, 'sub') })).rejects.toThrow();
    expect(calls(sent, 'IO.close')).toEqual([{ method: 'IO.close', params: { handle: 'stream-1' } }]);
  });

  it('stops at a size ceiling: deletes what it wrote, closes the stream and says so', async () => {
    const dir = tempDir();
    const chunk = Buffer.alloc(60, 'a').toString('base64');
    const { cdp, sent } = fake({
      chunks: Array.from({ length: 5 }, (_, i) => ({ data: chunk, eof: i === 4, base64Encoded: true })),
    });
    await expect(stopTrace(cdp, { compress: false, dir, maxBytes: 100 })).rejects.toThrow(/exceeds/i);
    expect(readdirSync(dir)).toEqual([]);
    expect(calls(sent, 'IO.close')).toHaveLength(1);
    expect(calls(sent, 'IO.read').length).toBeLessThan(5); // it stopped reading
  });

  it('gives up on a stream that takes too long to drain', async () => {
    const dir = tempDir();
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 400));
    const chunk = b64('x');
    const { cdp, sent } = fake({
      chunks: Array.from({ length: 50 }, () => ({ data: chunk, eof: false, base64Encoded: true })),
    });
    await expect(stopTrace(cdp, { compress: false, dir, deadlineMs: 1000 })).rejects.toThrow(/too long/i);
    expect(readdirSync(dir)).toEqual([]);
    expect(calls(sent, 'IO.close')).toHaveLength(1);
  });

  it('throws when Chrome finishes without a stream, and writes nothing', async () => {
    const dir = tempDir();
    await expect(
      stopTrace(fake({ complete: { dataLossOccurred: false } }).cdp, { compress: false, dir })
    ).rejects.toThrow(/stream/i);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("throws Chrome's message when Tracing.end fails, and cancels the pending wait", async () => {
    const f = fake({ endError: 'not tracing' });
    await expect(stopTrace(f.cdp, { compress: false, dir: tempDir() })).rejects.toThrow('not tracing');
    expect(f.signal()?.aborted).toBe(true);
  });

  it('does not cancel the wait when ending works', async () => {
    const f = fake();
    await stopTrace(f.cdp, { compress: false, dir: tempDir() });
    expect(f.signal()?.aborted).toBe(false);
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

  it('measures the recording up to the moment stop was called, not the download after', async () => {
    const dir = tempDir();
    const times = [10_000, 12_000, 99_000, 99_000, 99_000, 99_000, 99_000]; // start, stop begins, then slow I/O
    let i = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => times[Math.min(i++, times.length - 1)]);
    const rec = new TraceRecorder();
    await rec.start(fake().cdp, { compress: false });
    const out = await rec.stop(fake().cdp, { dir });
    expect(out.durationMs).toBe(2000);
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
