/**
 * control/chrome-trace-capture — record a Chrome trace to a file
 *
 * Tracing.start with transferMode ReturnAsStream, then on stop the stream is
 * read with IO.read and written to disk as it arrives, never held whole in
 * memory or sent back over MCP. Chrome gzips the stream when asked.
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CdpSender } from './cdp-object.js';

export interface TraceCdp extends CdpSender {
  /** Resolve with the params of the next CDP event of this method. Registers before returning. */
  waitForEvent(method: string, timeoutMs: number): Promise<Record<string, unknown>>;
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

export const DEFAULT_TRACE_DIR = join(tmpdir(), 'control-traces');

/** Chrome flushes its buffers before it reports the trace complete; large traces take a while. */
const COMPLETE_TIMEOUT_MS = 120_000;
const READ_CHUNK_BYTES = 1 << 20;

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
    traceConfig: { includedCategories: options.categories ?? DEFAULT_TRACE_CATEGORIES },
    transferMode: 'ReturnAsStream',
    streamFormat: 'json',
    streamCompression: options.compress ? 'gzip' : 'none',
  });
  if (r.error) throw new Error(r.error.message);
}

export async function stopTrace(
  cdp: TraceCdp,
  options: { compress: boolean; dir?: string }
): Promise<StoppedTrace> {
  // Register for the completion event before ending, so a fast finish is not missed.
  const complete = cdp.waitForEvent('Tracing.tracingComplete', COMPLETE_TIMEOUT_MS);
  complete.catch(() => {});
  const end = await cdp.sendCommand('Tracing.end');
  if (end.error) throw new Error(end.error.message);
  const done = await complete;

  const stream = done.stream;
  if (typeof stream !== 'string' || stream === '') {
    throw new Error('Chrome finished the trace without a stream handle');
  }

  const dir = options.dir ?? DEFAULT_TRACE_DIR;
  // Owner-only: traces hold URLs and source text.
  if (mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined) chmodSync(dir, 0o700);
  const path = join(dir, `trace-${Date.now()}-${randomBytes(4).toString('hex')}${options.compress ? '.json.gz' : '.json'}`);
  const fd = openSync(path, 'wx', 0o600);

  let bytes = 0;
  try {
    for (;;) {
      const r = await cdp.sendCommand('IO.read', { handle: stream, size: READ_CHUNK_BYTES });
      if (r.error) throw new Error(r.error.message);
      const chunk = r.result as { data?: string; eof?: boolean; base64Encoded?: boolean };
      if (chunk.data) {
        const buf = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
        writeSync(fd, buf);
        bytes += buf.length;
      }
      if (chunk.eof) break;
    }
  } catch (error) {
    closeSync(fd);
    rmSync(path, { force: true });
    throw error;
  } finally {
    await cdp.sendCommand('IO.close', { handle: stream }).catch(() => {});
  }
  closeSync(fd);

  return { path, bytes, compressed: options.compress, dataLoss: done.dataLossOccurred === true };
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
    try {
      const out = await stopTrace(cdp, { compress: trace.compress, dir: options.dir });
      return { ...out, durationMs: Date.now() - trace.startedAt };
    } finally {
      // Worked or not, Chrome has ended this trace.
      this.active = null;
    }
  }

  reset(): void {
    this.active = null;
  }
}
