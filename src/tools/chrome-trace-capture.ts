/**
 * control/chrome-trace-capture — record a Chrome trace to a file
 *
 * Tracing.start with transferMode ReturnAsStream, then on stop the stream is
 * read with IO.read and written to disk as it arrives, never held whole in
 * memory or sent back over MCP. Chrome gzips the stream when asked.
 */

import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CdpSender } from './cdp-object.js';

export interface TraceCdp extends CdpSender {
  /** Resolve with the params of the next CDP event of this method. Registers before returning. */
  waitForEvent(method: string, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

/**
 * What the DevTools Performance panel records, plus the frame and input events a
 * scroll investigation needs. Chosen by checking real traces, not by guess.
 */
export const DEFAULT_TRACE_CATEGORIES: string[] = [
  'devtools.timeline',
  'v8.execute',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-v8.cpu_profiler',
  'toplevel',
  'blink.user_timing',
  'latencyInfo',
  'loading',
  'input',
  'input.scrolling',
  'benchmark',
];

/** Chrome flushes its buffers before it reports the trace complete; large traces take a while. */
const COMPLETE_TIMEOUT_MS = 120_000;
const READ_CHUNK_BYTES = 1 << 20;
/** A trace file bigger than this is refused: a runaway page must not fill the disk. */
const MAX_TRACE_BYTES = 512 * 1024 * 1024;
/** Draining the stream may not take longer than this in total; checked between reads, so it can overrun by one read. */
const DRAIN_DEADLINE_MS = 5 * 60_000;
/** Chrome-side trace buffer: recording stops at this size, so an open recording is bounded. */
const TRACE_BUFFER_KB = 200 * 1024;

export interface StartOptions {
  categories?: string[];
  compress: boolean;
}

export interface StoppedTrace {
  path: string;
  bytes: number;
  compressed: boolean;
  dataLoss: boolean;
}

export async function startTrace(cdp: TraceCdp, options: StartOptions): Promise<void> {
  const r = await cdp.sendCommand('Tracing.start', {
    traceConfig: {
      includedCategories: options.categories ?? DEFAULT_TRACE_CATEGORIES,
      recordMode: 'recordUntilFull',
      traceBufferSizeInKb: TRACE_BUFFER_KB,
    },
    transferMode: 'ReturnAsStream',
    streamFormat: 'json',
    streamCompression: options.compress ? 'gzip' : 'none',
  });
  if (r.error) throw new Error(r.error.message);
}

/** Write the whole buffer; fs.writeSync may write fewer bytes than asked. Returns the length. */
export function writeAll(write: (buf: Buffer, offset: number) => number, buf: Buffer): number {
  let offset = 0;
  while (offset < buf.length) {
    const n = write(buf, offset);
    if (n <= 0) throw new Error('Writing the trace made no progress (disk full?)');
    offset += n;
  }
  return buf.length;
}

export async function stopTrace(
  cdp: TraceCdp,
  options: { compress: boolean; dir?: string; maxBytes?: number; deadlineMs?: number }
): Promise<StoppedTrace> {
  // Register for the completion event before ending, so a fast finish is not missed.
  const waiter = new AbortController();
  const complete = cdp.waitForEvent('Tracing.tracingComplete', COMPLETE_TIMEOUT_MS, waiter.signal);
  complete.catch(() => {});
  try {
    const end = await cdp.sendCommand('Tracing.end');
    if (end.error) throw new Error(end.error.message);
  } catch (error) {
    waiter.abort();
    throw error;
  }
  const done = await complete;

  const stream = done.stream;
  if (typeof stream !== 'string' || stream === '') {
    throw new Error('Chrome finished the trace without a stream handle');
  }

  // From here the Chrome-side stream is held, so everything below sits inside the cleanup.
  const maxBytes = options.maxBytes ?? MAX_TRACE_BYTES;
  const deadline = Date.now() + (options.deadlineMs ?? DRAIN_DEADLINE_MS);
  let fresh: string | undefined;
  let fd: number | undefined;
  try {
    // A new owner-only directory per trace (mkdtemp makes it 0700 with an unpredictable name):
    // traces hold URLs and source text, and nothing pre-existing is reused or trusted.
    fresh = mkdtempSync(join(options.dir ?? tmpdir(), 'control-trace-'));
    const path = join(fresh, options.compress ? 'trace.json.gz' : 'trace.json');
    fd = openSync(path, 'wx', 0o600);
    const out = fd;

    let bytes = 0;
    for (;;) {
      if (Date.now() > deadline) throw new Error('Reading the trace from Chrome took too long; giving up');
      const r = await cdp.sendCommand('IO.read', { handle: stream, size: READ_CHUNK_BYTES });
      if (r.error) throw new Error(r.error.message);
      const chunk = r.result as { data?: string; eof?: boolean; base64Encoded?: boolean };
      if (chunk.data) {
        const buf = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
        bytes += writeAll((b, offset) => writeSync(out, b, offset), buf);
        if (bytes > maxBytes) {
          throw new Error(`The trace exceeds ${Math.round(maxBytes / (1024 * 1024))}MB; record a shorter run`);
        }
      }
      if (chunk.eof) break;
    }
    closeSync(out);
    fd = undefined;
    return { path, bytes, compressed: options.compress, dataLoss: done.dataLossOccurred === true };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (fresh) rmSync(fresh, { recursive: true, force: true });
    throw error;
  } finally {
    await cdp.sendCommand('IO.close', { handle: stream }).catch(() => {});
  }
}

/**
 * One connection's recording: at most one trace at a time, remembered with how
 * it was started so stop writes the same format. Cleared when the connection
 * changes, because Chrome ends a trace with its session.
 */
export class TraceRecorder {
  private active: { startedAt: number; compress: boolean } | null = null;

  get running(): boolean {
    return this.active !== null;
  }

  async start(cdp: TraceCdp, options: StartOptions): Promise<void> {
    if (this.active) {
      const seconds = Math.round((Date.now() - this.active.startedAt) / 1000);
      throw new Error(
        `A trace is already running (started ${seconds}s ago). Stop it with chrome({ method: "trace", action: "stop" }) first.`
      );
    }
    await startTrace(cdp, options);
    this.active = { startedAt: Date.now(), compress: options.compress };
  }

  async stop(cdp: TraceCdp, options: { dir?: string } = {}): Promise<StoppedTrace & { durationMs: number }> {
    const trace = this.active;
    if (!trace) {
      throw new Error('No trace is running. Start one with chrome({ method: "trace", action: "start" }).');
    }
    // The recording ends when stop is called; flushing and downloading come after.
    const durationMs = Date.now() - trace.startedAt;
    try {
      const out = await stopTrace(cdp, { compress: trace.compress, dir: options.dir });
      return { ...out, durationMs };
    } finally {
      // Worked or not, Chrome has ended this trace.
      this.active = null;
    }
  }

  reset(): void {
    this.active = null;
  }
}
