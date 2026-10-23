import * as fs from 'node:fs';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TRACE_CATEGORIES,
  TRACE_GONE,
  TraceRecorder,
  TraceStartUncertainError,
  abandonTrace,
  openTraceSink,
  startTrace,
  stopTrace,
  validateOutPath,
  writeAll,
  type TraceCdp,
} from './chrome-trace-capture.js';

// Pass-through spies, so a test can count closes or step into the gap between a check and an open.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    closeSync: vi.fn(real.closeSync),
    lstatSync: vi.fn(real.lstatSync),
    openSync: vi.fn(real.openSync),
    renameSync: vi.fn(real.renameSync),
    rmSync: vi.fn(real.rmSync),
  };
});

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
  /** The first n Tracing.end calls get no answer: they reject, as a CDP timeout does. */
  endRejects?: number;
  /** Tracing.start gets no answer: it rejects, as a CDP timeout or a broken socket does. */
  startRejects?: boolean;
  /** tracingComplete never arrives: the wait rejects at its timeout, or when its signal aborts. */
  completeNever?: boolean;
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
  let endRejects = options.endRejects ?? 0;
  const cdp: TraceCdp = {
    sendCommand: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      sent.push({ method, params });
      if (method === 'Tracing.start' && options.startRejects) throw new Error('Command Tracing.start timed out after 30s');
      if (method === 'Tracing.end' && endRejects > 0) {
        endRejects--;
        throw new Error('Command Tracing.end timed out after 30s');
      }
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
      if (options.completeNever) {
        return new Promise<Record<string, unknown>>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), _timeoutMs);
          s?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        });
      }
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

  it('does not end the trace when the file cannot be created', async () => {
    const parent = tempDir();
    const blocker = join(parent, 'not-a-directory');
    writeFileSync(blocker, 'x');
    const { cdp, sent } = fake();
    await expect(stopTrace(cdp, { compress: false, dir: join(blocker, 'sub') })).rejects.toThrow();
    // The file is created first, so Chrome is never asked to end and no stream is held.
    expect(calls(sent, 'Tracing.end')).toEqual([]);
    expect(calls(sent, 'IO.close')).toEqual([]);
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

  it('reserves on start before Chrome answers, so an overlapping start is refused', async () => {
    const { cdp, sent } = fake();
    const rec = new TraceRecorder();
    const first = rec.start(cdp, { compress: false });
    const second = rec.start(cdp, { compress: false });
    await expect(second).rejects.toThrow(/already running/);
    const id = await first;
    expect(calls(sent, 'Tracing.start')).toHaveLength(1);
    expect(rec.running).toBe(true);
    expect(rec.isCurrent(id)).toBe(true);
  });

  it('refuses a stop for a trace that is gone and leaves the new one alone', async () => {
    const dir = tempDir();
    const f = fake();
    const rec = new TraceRecorder();
    const old = await rec.start(f.cdp, { compress: false });
    rec.reset();
    const next = await rec.start(f.cdp, { compress: false });
    await expect(rec.stop(f.cdp, { dir, id: old })).rejects.toThrow(
      'The trace this call started is no longer the active recording: Chrome ends a trace with its tab or connection, ' +
        'and another call may have stopped it. This call kept nothing.'
    );
    expect(calls(f.sent, 'Tracing.end')).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
    expect(rec.isCurrent(next)).toBe(true);
    const out = await rec.stop(f.cdp, { dir, id: next });
    expect(existsSync(out.path)).toBe(true);
    expect(rec.running).toBe(false);
  });

  it('does not clear a trace started while an older stop was still draining', async () => {
    const dir = tempDir();
    const rec = new TraceRecorder();
    let next: Promise<number> | undefined;
    const draining = fake({
      onRead: () => {
        // The old session went away mid-drain and someone started a new trace.
        rec.reset();
        next = rec.start(fake().cdp, { compress: false });
      },
    });
    await rec.start(draining.cdp, { compress: false });
    await rec.stop(draining.cdp, { dir });
    const id = await next!;
    expect(rec.running).toBe(true);
    expect(rec.isCurrent(id)).toBe(true);
  });

  it('keeps the trace running when Tracing.end gets no answer, and a second stop works', async () => {
    const dir = tempDir();
    const f = fake({ endRejects: 1 });
    const rec = new TraceRecorder();
    const id = await rec.start(f.cdp, { compress: false });
    await expect(rec.stop(f.cdp, { dir, id })).rejects.toThrow(
      /Stop did not complete; the trace may still be running\. Try stop again, or disconnect to end it/
    );
    expect(rec.running).toBe(true);
    expect(readdirSync(dir)).toEqual([]); // the file for the failed stop was removed
    const out = await rec.stop(f.cdp, { dir, id });
    expect(existsSync(out.path)).toBe(true);
    expect(calls(f.sent, 'Tracing.end')).toHaveLength(2);
    expect(rec.running).toBe(false);
  });

  it('treats the trace as over when Chrome answers Tracing.end with an error', async () => {
    const rec = new TraceRecorder();
    await rec.start(fake().cdp, { compress: false });
    await expect(rec.stop(fake({ endError: 'not tracing' }).cdp, { dir: tempDir() })).rejects.toThrow(
      /Chrome refused to end the trace: not tracing/
    );
    expect(rec.running).toBe(false);
  });

  it('keeps the trace when Tracing.start gets no answer, so a following stop ends it', async () => {
    const dir = tempDir();
    const f = fake({ startRejects: true });
    const rec = new TraceRecorder();
    const failed = await rec.start(f.cdp, { compress: false }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(TraceStartUncertainError);
    expect((failed as Error).message).toMatch(
      /^Start did not complete; the trace may be running\. Stop it with chrome\(\{ method: "trace", action: "stop" \}\), or disconnect to end it\. \(Command Tracing\.start timed out after 30s\)$/
    );
    expect(rec.running).toBe(true);
    const id = (failed as TraceStartUncertainError).id;
    expect(rec.isCurrent(id)).toBe(true);
    // A second start is refused: Chrome may be recording the first.
    await expect(rec.start(f.cdp, { compress: false })).rejects.toThrow(/already running/);
    const out = await rec.stop(f.cdp, { dir });
    expect(calls(f.sent, 'Tracing.end')).toHaveLength(1);
    expect(existsSync(out.path)).toBe(true);
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
    expect(rec.running).toBe(false);
  });

  it('measures an unanswered start from the moment the command was sent', async () => {
    const dir = tempDir();
    const rec = new TraceRecorder();
    let release!: () => void;
    const answered = new Promise<void>((r) => (release = r));
    const f = fake();
    (f.cdp.sendCommand as any).mockImplementationOnce(async () => {
      await answered;
      throw new Error('socket closed');
    });
    const failing = rec.start(f.cdp, { compress: false }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 120));
    release();
    expect(await failing).toBeInstanceOf(TraceStartUncertainError);
    const out = await rec.stop(f.cdp, { dir });
    expect(out.durationMs).toBeGreaterThanOrEqual(100);
  });

  it('forgets an unanswered start when the session is reset while it waits', async () => {
    const rec = new TraceRecorder();
    const f = fake();
    (f.cdp.sendCommand as any).mockImplementationOnce(async () => {
      rec.reset();
      throw new Error('socket closed');
    });
    const failed = await rec.start(f.cdp, { compress: false }).catch((e: unknown) => e);
    // Chrome ends a trace with its session, so nothing may be running: the plain error comes back.
    expect(failed).not.toBeInstanceOf(TraceStartUncertainError);
    expect((failed as Error).message).toBe('socket closed');
    expect(rec.running).toBe(false);
  });

  it('reset forgets a running trace', async () => {
    const rec = new TraceRecorder();
    await rec.start(fake().cdp, { compress: false });
    rec.reset();
    expect(rec.running).toBe(false);
    await expect(rec.stop(fake().cdp, { dir: tempDir() })).rejects.toThrow(/No trace is running/);
  });
});

describe('TraceRecorder: stop to a chosen path', () => {
  const NEW = '{"traceEvents":[{"name":"new"}]}';
  const newTrace = (options: FakeOptions = {}) => fake({ chunks: [{ data: b64(NEW), eof: true, base64Encoded: true }], ...options });
  const recording = async (compress: boolean, options: FakeOptions = {}) => {
    const f = newTrace(options);
    const rec = new TraceRecorder();
    await rec.start(f.cdp, { compress });
    return { rec, ...f };
  };
  /** A refused path must not touch Chrome: the recording keeps running for a second try. */
  const expectStillRecording = (rec: TraceRecorder, sent: { method: string }[]) => {
    expect(calls(sent, 'Tracing.end')).toEqual([]);
    expect(rec.running).toBe(true);
  };

  it.each([
    [true, 'out.json', '.json.gz'],
    [true, 'out.txt', '.json.gz'],
    [false, 'out.json.gz', '.json'],
    [false, 'out.JSON', '.json'],
  ])('compress %s: refuses %s, names %s, and a second stop with a good path works', async (compress, name, ext) => {
    const dir = tempDir();
    const { rec, cdp, sent } = await recording(compress);
    await expect(rec.stop(cdp, { outPath: join(dir, name) })).rejects.toThrow(`must end in ${ext}`);
    expectStillRecording(rec, sent);
    expect(readdirSync(dir)).toEqual([]);

    const good = join(dir, `good${ext}`);
    const out = await rec.stop(cdp, { outPath: good });
    expect(out.path).toBe(good);
    expect(readFileSync(good, 'utf8')).toBe(NEW);
    expect(rec.running).toBe(false);
  });

  it.each(['relative-trace-out.json', '~/trace-out.json', './trace-out.json'])('refuses the relative path %s', async (p) => {
    const { rec, cdp, sent } = await recording(false);
    await expect(rec.stop(cdp, { outPath: p })).rejects.toThrow(/absolute path/);
    expectStillRecording(rec, sent);
    expect(existsSync(resolve(p))).toBe(false);
  });

  it('collapses .. before checking, and returns the resolved path', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'sub'));
    const { rec, cdp } = await recording(false);
    const out = await rec.stop(cdp, { outPath: `${dir}/sub/../out.json` });
    expect(out.path).toBe(join(dir, 'out.json'));
    expect(readFileSync(join(dir, 'out.json'), 'utf8')).toBe(NEW);
    expect(readdirSync(join(dir, 'sub'))).toEqual([]);

    // The parent is the resolved one, so a missing segment that .. cancels does not matter.
    const again = await recording(false);
    const second = await again.rec.stop(again.cdp, { outPath: `${dir}/nope/../out2.json` });
    expect(second.path).toBe(join(dir, 'out2.json'));
    expect(readFileSync(join(dir, 'out2.json'), 'utf8')).toBe(NEW);
  });

  it('refuses a missing parent directory, and a parent that is a file', async () => {
    const dir = tempDir();
    const { rec, cdp, sent } = await recording(false);
    await expect(rec.stop(cdp, { outPath: join(dir, 'missing', 'out.json') })).rejects.toThrow(/does not exist/);
    expectStillRecording(rec, sent);
    writeFileSync(join(dir, 'file'), 'x');
    await expect(rec.stop(cdp, { outPath: join(dir, 'file', 'out.json') })).rejects.toThrow(/not a directory/);
    expectStillRecording(rec, sent);
    expect(readdirSync(dir)).toEqual(['file']);
  });

  it('refuses an existing file without overwrite and leaves it as it was', async () => {
    const dir = tempDir();
    const target = join(dir, 'out.json');
    writeFileSync(target, 'old');
    const { rec, cdp, sent } = await recording(false);
    await expect(rec.stop(cdp, { outPath: target })).rejects.toThrow(/already exists.*overwrite: true/);
    expectStillRecording(rec, sent);
    expect(readFileSync(target, 'utf8')).toBe('old');
  });

  it('overwrite: true replaces the file, leaves no temp file, and says it overwrote', async () => {
    const dir = tempDir();
    const target = join(dir, 'out.json');
    writeFileSync(target, 'old', { mode: 0o644 });
    const { rec, cdp } = await recording(false);
    const out = await rec.stop(cdp, { outPath: target, overwrite: true });
    expect(readFileSync(target, 'utf8')).toBe(NEW);
    expect(readdirSync(dir)).toEqual(['out.json']);
    expect(out.overwritten).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('overwrite: true onto a new path does not claim it overwrote', async () => {
    const dir = tempDir();
    const target = join(dir, 'out.json');
    const { rec, cdp } = await recording(false);
    const out = await rec.stop(cdp, { outPath: target, overwrite: true });
    expect(readFileSync(target, 'utf8')).toBe(NEW);
    expect('overwritten' in out).toBe(false);
    expect(readdirSync(dir)).toEqual(['out.json']);
  });

  it('refuses a symlink at the path even with overwrite, and leaves the link and its target alone', async () => {
    const dir = tempDir();
    const elsewhere = join(tempDir(), 'theirs.json');
    writeFileSync(elsewhere, 'theirs');
    const target = join(dir, 'out.json');
    symlinkSync(elsewhere, target);
    const { rec, cdp, sent } = await recording(false);
    await expect(rec.stop(cdp, { outPath: target, overwrite: true })).rejects.toThrow(/not a regular file/);
    expectStillRecording(rec, sent);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readlinkSync(target)).toBe(elsewhere);
    expect(readFileSync(elsewhere, 'utf8')).toBe('theirs');
    expect(readdirSync(dir)).toEqual(['out.json']);
  });

  it('refuses a dangling symlink without overwrite', async () => {
    const dir = tempDir();
    const target = join(dir, 'out.json');
    const nowhere = join(dir, 'nowhere.json');
    symlinkSync(nowhere, target);
    const { rec, cdp, sent } = await recording(false);
    await expect(rec.stop(cdp, { outPath: target })).rejects.toThrow(/already exists/);
    expectStillRecording(rec, sent);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(existsSync(nowhere)).toBe(false);
  });

  it('refuses a directory at the path even with overwrite', async () => {
    const dir = tempDir();
    const target = join(dir, 'out.json');
    mkdirSync(target);
    const { rec, cdp, sent } = await recording(false);
    await expect(rec.stop(cdp, { outPath: target, overwrite: true })).rejects.toThrow(/not a regular file/);
    expectStillRecording(rec, sent);
    expect(statSync(target).isDirectory()).toBe(true);
    expect(readdirSync(dir)).toEqual(['out.json']);
  });

  it('writes the file owner-only (0600) with either strategy', async () => {
    const dir = tempDir();
    for (const overwrite of [false, true]) {
      const target = join(dir, `out-${overwrite}.json.gz`);
      if (overwrite) writeFileSync(target, 'old', { mode: 0o644 });
      const { rec, cdp } = await recording(true);
      await rec.stop(cdp, { outPath: target, overwrite });
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(readFileSync(target, 'utf8')).toBe(NEW);
    }
  });

  it('removes the file it created when the stream fails after Chrome ended the trace', async () => {
    const dir = tempDir();
    const target = join(dir, 'out.json');
    const rec = new TraceRecorder();
    await rec.start(fake().cdp, { compress: false });
    // The first chunk lands on disk before the second read fails.
    const chunked = fake({
      chunks: [{ data: b64('{"traceEvents":['), eof: false, base64Encoded: true }],
      onRead: (n) => {
        if (n === 1) {
          expect(readFileSync(target, 'utf8')).toBe('{"traceEvents":[');
          throw new Error('stream gone');
        }
      },
    });
    await expect(rec.stop(chunked.cdp, { outPath: target })).rejects.toThrow('stream gone');
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    expect(rec.running).toBe(false); // Chrome has ended it
    expect(calls(chunked.sent, 'Tracing.end')).toHaveLength(1);
  });

  it('keeps the old file intact when the stream fails during an overwrite', async () => {
    const dir = tempDir();
    const target = join(dir, 'out.json');
    writeFileSync(target, 'old');
    const rec = new TraceRecorder();
    await rec.start(fake().cdp, { compress: false });
    const chunked = fake({
      chunks: [{ data: b64('{"traceEvents":['), eof: false, base64Encoded: true }],
      onRead: (n) => {
        if (n === 1) {
          // The first chunk is in the temp file beside the target, not over it.
          const temps = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
          expect(temps).toHaveLength(1);
          expect(readFileSync(join(dir, temps[0]), 'utf8')).toBe('{"traceEvents":[');
          expect(readFileSync(target, 'utf8')).toBe('old');
          throw new Error('stream gone');
        }
      },
    });
    await expect(rec.stop(chunked.cdp, { outPath: target, overwrite: true })).rejects.toThrow('stream gone');
    expect(readFileSync(target, 'utf8')).toBe('old');
    expect(readdirSync(dir)).toEqual(['out.json']);
  });

  it('keeps the complete trace in its temp file when the OS refuses the final replace', async () => {
    const dir = tempDir();
    const target = join(dir, 'out.json');
    writeFileSync(target, 'old');
    const { rec, cdp } = await recording(false);
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error(`EPERM: operation not permitted, rename -> '${target}'`), { code: 'EPERM' });
    });
    const error = await rec.stop(cdp, { outPath: target, overwrite: true }).then(
      () => { throw new Error('stop should have failed'); },
      (e: Error) => e
    );
    const temps = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(temps).toHaveLength(1);
    const temp = join(dir, temps[0]);
    expect(readFileSync(temp, 'utf8')).toBe(NEW);
    expect(statSync(temp).mode & 0o777).toBe(0o600);
    expect(error.message).toContain('EPERM');
    expect(error.message).toContain('complete');
    expect(error.message).toContain(temp);
    expect(readFileSync(target, 'utf8')).toBe('old');
    expect(rec.running).toBe(false); // Chrome ended the trace
  });

  it('still removes its file and reports the first error when closing fails during abort', async () => {
    const dir = tempDir();
    const target = join(dir, 'out.json');
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const rec = new TraceRecorder();
    await rec.start(fake().cdp, { compress: false });
    const chunked = fake({
      chunks: [{ data: b64('{"traceEvents":['), eof: false, base64Encoded: true }],
      onRead: (n) => {
        if (n === 1) {
          expect(readFileSync(target, 'utf8')).toBe('{"traceEvents":[');
          // The abort's close fails after releasing the fd, as an EIO from close can.
          vi.mocked(fs.closeSync).mockImplementationOnce((fd) => {
            actual.closeSync(fd);
            throw Object.assign(new Error('EIO: i/o error, close'), { code: 'EIO' });
          });
          throw new Error('stream gone');
        }
      },
    });
    await expect(rec.stop(chunked.cdp, { outPath: target })).rejects.toThrow('stream gone');
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('names the partial file it could not remove, alongside the first error', async () => {
    const dir = tempDir();
    const target = join(dir, 'out.json');
    const rec = new TraceRecorder();
    await rec.start(fake().cdp, { compress: false });
    const original = new Error('stream gone');
    const chunked = fake({
      chunks: [{ data: b64('{"traceEvents":['), eof: false, base64Encoded: true }],
      onRead: (n) => {
        if (n === 1) {
          vi.mocked(fs.rmSync).mockImplementationOnce(() => {
            throw Object.assign(new Error(`EACCES: permission denied, rm '${target}'`), { code: 'EACCES' });
          });
          throw original;
        }
      },
    });
    const error = await rec.stop(chunked.cdp, { outPath: target }).then(
      () => { throw new Error('stop should have failed'); },
      (e: Error) => e
    );
    expect(error.message).toContain('stream gone');
    expect(error.message).toContain(`Could not remove the partial file ${target}: EACCES`);
    expect(error.cause).toBe(original);
    // The note is true: the partial file really is still there.
    expect(readFileSync(target, 'utf8')).toBe('{"traceEvents":[');
  });

  it('removes the file and throws the close error when the final close fails', async () => {
    const dir = tempDir();
    const target = join(dir, 'out.json');
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const rec = new TraceRecorder();
    await rec.start(fake().cdp, { compress: false });
    const f = newTrace({
      onRead: () => {
        // Every chunk is in; the close in commit fails after releasing the fd.
        vi.mocked(fs.closeSync).mockImplementationOnce((fd) => {
          actual.closeSync(fd);
          throw Object.assign(new Error('EIO: i/o error, close'), { code: 'EIO' });
        });
      },
    });
    await expect(rec.stop(f.cdp, { outPath: target })).rejects.toThrow(/^EIO: i\/o error, close$/);
    expect(existsSync(target)).toBe(false);
  });
});

describe('openTraceSink', () => {
  const closes = (fd: number) => vi.mocked(fs.closeSync).mock.calls.filter(([n]) => n === fd).length;

  it('throws the create error even when removing the fresh directory also fails', () => {
    const dir = tempDir();
    vi.mocked(fs.openSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('EMFILE: too many open files, open'), { code: 'EMFILE' });
    });
    vi.mocked(fs.rmSync).mockImplementationOnce(() => {
      throw new Error('EBUSY: resource busy, rm');
    });
    expect(() => openTraceSink({ compress: false, dir })).toThrow(/EMFILE/);
  });

  it('refuses a path that is already taken by the time it opens it', () => {
    const dir = tempDir();
    const target = join(dir, 'out.json');
    const first = openTraceSink({ compress: false, outPath: target });
    expect(() => openTraceSink({ compress: false, outPath: target })).toThrow(/already exists/);
    fs.writeSync(first.fd, 'mine');
    first.commit();
    expect(readFileSync(target, 'utf8')).toBe('mine');
  });

  it('does not truncate a file that appears between the check and the open', () => {
    const dir = tempDir();
    const target = join(dir, 'out.json');
    // The check sees nothing; someone else creates the file before the open.
    vi.mocked(fs.lstatSync).mockImplementationOnce(((p: fs.PathLike) => {
      writeFileSync(target, 'theirs');
      throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${String(p)}'`), { code: 'ENOENT' });
    }) as typeof fs.lstatSync);
    expect(() => openTraceSink({ compress: false, outPath: target })).toThrow(/EEXIST|already exists/);
    expect(readFileSync(target, 'utf8')).toBe('theirs');
  });

  it('closes each file exactly once on success, on abort and when commit fails', () => {
    // fd numbers are reused once closed, so the count is reset before each sink.
    const dir = tempDir();
    vi.mocked(fs.closeSync).mockClear();
    const plain = openTraceSink({ compress: false, dir });
    plain.commit();
    plain.abort();
    expect(closes(plain.fd)).toBe(1);

    vi.mocked(fs.closeSync).mockClear();
    const chosen = openTraceSink({ compress: false, outPath: join(dir, 'a.json') });
    chosen.abort();
    chosen.abort();
    expect(closes(chosen.fd)).toBe(1);
    expect(existsSync(join(dir, 'a.json'))).toBe(false);

    writeFileSync(join(dir, 'b.json'), 'old');
    vi.mocked(fs.closeSync).mockClear();
    const replace =openTraceSink({ compress: false, outPath: join(dir, 'b.json'), overwrite: true });
    // The target turns into a non-empty directory, so the final rename fails.
    rmSync(join(dir, 'b.json'));
    mkdirSync(join(dir, 'b.json'));
    writeFileSync(join(dir, 'b.json', 'x'), 'x');
    expect(() => replace.commit()).toThrow(/refused.*kept at/);
    replace.abort();
    expect(closes(replace.fd)).toBe(1);
    // A refused replace keeps the finished temp file, even through a later abort.
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toHaveLength(1);
  });

  it('closes once when a stopTrace fails mid-write', async () => {
    const dir = tempDir();
    vi.mocked(fs.closeSync).mockClear();
    const sink = openTraceSink({ compress: false, outPath: join(dir, 'out.json') });
    const { cdp } = fake({
      chunks: [{ data: b64('{"traceEvents":['), eof: false, base64Encoded: true }],
      onRead: (n) => { if (n === 1) throw new Error('stream gone'); },
    });
    await expect(stopTrace(cdp, { compress: false, sink })).rejects.toThrow('stream gone');
    expect(closes(sink.fd)).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('validateOutPath', () => {
  it.skipIf(process.getuid?.() === 0)('refuses a parent it cannot write to, and creates nothing', () => {
    const dir = tempDir();
    const locked = join(dir, 'locked');
    mkdirSync(locked, 0o500);
    try {
      expect(() => validateOutPath({ compress: false, outPath: join(locked, 'a.json') })).toThrow(/not writable/);
      expect(readdirSync(locked)).toEqual([]);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });

  it('resolves a free path and creates nothing', () => {
    const dir = tempDir();
    expect(validateOutPath({ compress: true, outPath: `${dir}/sub/../a.json.gz` })).toEqual({
      target: join(dir, 'a.json.gz'), parent: dir, exists: false,
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each([
    ['a relative path', (_dir: string) => ({ compress: true, outPath: 'a.json.gz' }), /absolute path/],
    ['the wrong extension', (dir: string) => ({ compress: true, outPath: join(dir, 'a.json') }), /must end in \.json\.gz/],
    ['a missing parent', (dir: string) => ({ compress: false, outPath: join(dir, 'missing', 'a.json') }), /does not exist/],
    ['a parent that is a file', (dir: string) => ({ compress: false, outPath: join(dir, 'file', 'a.json') }), /not a directory/],
    ['a taken path without overwrite', (dir: string) => ({ compress: false, outPath: join(dir, 'taken.json') }), /already exists.*overwrite: true/],
    ['a directory', (dir: string) => ({ compress: false, outPath: join(dir, 'd.json'), overwrite: true }), /is a directory/],
    ['a symlink', (dir: string) => ({ compress: false, outPath: join(dir, 'link.json'), overwrite: true }), /is a symlink/],
  ])('refuses %s and changes nothing', (_label, options, why) => {
    const dir = tempDir();
    writeFileSync(join(dir, 'file'), 'f');
    writeFileSync(join(dir, 'taken.json'), 'mine');
    mkdirSync(join(dir, 'd.json'));
    symlinkSync(join(dir, 'taken.json'), join(dir, 'link.json'));
    const before = readdirSync(dir).sort();
    expect(() => validateOutPath(options(dir))).toThrow(why);
    expect(readdirSync(dir).sort()).toEqual(before);
    expect(readFileSync(join(dir, 'taken.json'), 'utf8')).toBe('mine');
  });

  it('accepts a regular file with overwrite and leaves it, and the directory, as they were', () => {
    const dir = tempDir();
    const target = join(dir, 'b.json');
    writeFileSync(target, 'old');
    expect(validateOutPath({ compress: false, outPath: target, overwrite: true })).toEqual({ target, parent: dir, exists: true });
    expect(readFileSync(target, 'utf8')).toBe('old');
    expect(readdirSync(dir)).toEqual(['b.json']);
  });
});

describe('abandonTrace', () => {
  const tracesIn = () => readdirSync(tmpdir()).filter((n) => n.startsWith('control-trace-'));

  it('closes the stream Chrome produces for its best-effort end, without reading it', async () => {
    const f = fake({ endRejects: 1, complete: { stream: 's9', dataLossOccurred: false } });
    const rec = new TraceRecorder();
    const id = await rec.start(f.cdp, { compress: false });
    const message = await abandonTrace(rec, f.cdp, id, 'Scroll failed.');
    expect(message).toMatch(/Chrome then ended the trace; nothing was kept\.$/);
    expect(calls(f.sent, 'IO.close').map((c) => c.params)).toEqual([{ handle: 's9' }]);
    expect(calls(f.sent, 'IO.read')).toEqual([]);
  });

  it('gives up on a completion that never comes within its bound, and says nothing new', async () => {
    const f = fake({ endRejects: 1, completeNever: true });
    const rec = new TraceRecorder();
    const id = await rec.start(f.cdp, { compress: false });
    const startedAt = Date.now();
    const message = await abandonTrace(rec, f.cdp, id, 'Scroll failed.', 50);
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(message).toMatch(/Chrome then ended the trace; nothing was kept\.$/);
    expect(calls(f.sent, 'IO.close')).toEqual([]);
    expect(rec.running).toBe(false);
  });

  it('touches nothing when the trace it started is gone', async () => {
    const f = fake();
    const rec = new TraceRecorder();
    const old = await rec.start(f.cdp, { compress: false });
    rec.reset();
    const other = await rec.start(f.cdp, { compress: false });
    expect(await abandonTrace(rec, f.cdp, old, 'Scroll failed.')).toBe(`Scroll failed. ${TRACE_GONE}`);
    expect(calls(f.sent, 'Tracing.end')).toEqual([]);
    expect(rec.isCurrent(other)).toBe(true);
  });

  it('stops privately and says where the partial trace is', async () => {
    const f = fake();
    const rec = new TraceRecorder();
    const id = await rec.start(f.cdp, { compress: false });
    const message = await abandonTrace(rec, f.cdp, id, 'Scroll failed.');
    const path = /^Scroll failed\. The partial trace was kept at (\S+)\.$/.exec(message)?.[1];
    expect(path, message).toBeDefined();
    dirs.push(dirname(path!));
    expect(existsSync(path!)).toBe(true);
    expect(rec.running).toBe(false);
  });

  it('says what Chrome refused and sends nothing more when Chrome answers the end with an error', async () => {
    const f = fake({ endError: 'not tracing' });
    const rec = new TraceRecorder();
    const id = await rec.start(f.cdp, { compress: false });
    const before = tracesIn();
    const message = await abandonTrace(rec, f.cdp, id, 'Scroll failed.');
    expect(message).toBe('Scroll failed. Stopping the trace also failed: Chrome refused to end the trace: not tracing');
    expect(calls(f.sent, 'Tracing.end')).toHaveLength(1);
    expect(rec.running).toBe(false);
    expect(tracesIn()).toEqual(before);
  });

  it('keeps the trace running and says so when Chrome answers neither end', async () => {
    const f = fake({ endRejects: 2 });
    const rec = new TraceRecorder();
    const id = await rec.start(f.cdp, { compress: false });
    const message = await abandonTrace(rec, f.cdp, id, 'Scroll failed.');
    expect(message).toMatch(/the trace may still be running\. Try chrome\(\{ method: "trace", action: "stop" \}\) again, or disconnect/);
    expect(message).not.toMatch(/nothing was kept|partial trace was kept/);
    expect(calls(f.sent, 'Tracing.end')).toHaveLength(2);
    expect(rec.isCurrent(id)).toBe(true);
  });

  it('stops a trace whose start got no answer, by the id the start error carries', async () => {
    const f = fake({ startRejects: true });
    const rec = new TraceRecorder();
    const failed = (await rec.start(f.cdp, { compress: false }).catch((e: unknown) => e)) as TraceStartUncertainError;
    expect(failed).toBeInstanceOf(TraceStartUncertainError);
    const message = await abandonTrace(rec, f.cdp, failed.id, 'Start failed.');
    const path = /^Start failed\. The partial trace was kept at (\S+)\.$/.exec(message)?.[1];
    expect(path, message).toBeDefined();
    dirs.push(dirname(path!));
    expect(calls(f.sent, 'Tracing.end')).toHaveLength(1);
    expect(rec.running).toBe(false);
  });

  it('forgets the trace once Chrome answers the second end', async () => {
    const f = fake({ endRejects: 1 });
    const rec = new TraceRecorder();
    const id = await rec.start(f.cdp, { compress: false });
    const message = await abandonTrace(rec, f.cdp, id, 'Scroll failed.');
    expect(message).toMatch(/Chrome then ended the trace; nothing was kept\.$/);
    expect(calls(f.sent, 'Tracing.end')).toHaveLength(2);
    expect(rec.running).toBe(false);
  });
});
