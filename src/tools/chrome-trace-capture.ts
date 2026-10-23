/**
 * control/chrome-trace-capture — record a Chrome trace to a file
 *
 * Tracing.start with transferMode ReturnAsStream, then on stop the stream is
 * read with IO.read and written to disk as it arrives, never held whole in
 * memory or sent back over MCP. Chrome gzips the stream when asked.
 */

import { randomBytes } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  lstatSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
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
  /** Present only when overwrite: true replaced a file that was there. */
  overwritten?: true;
}

export interface SinkOptions {
  compress: boolean;
  /** Parent of the fresh directory when no outPath is given (default: the OS temp directory). */
  dir?: string;
  /** An absolute path chosen by the caller. */
  outPath?: string;
  overwrite?: boolean;
}

/**
 * Where a trace is written. commit makes it final. abort removes what the sink created, except
 * a complete trace whose final replace the OS refused. It never throws; when the removal fails
 * it returns a one-line note naming what was left behind.
 */
export interface TraceSink {
  path: string;
  fd: number;
  /** True when commit will replace a file that was there when the sink was opened. */
  replaces: boolean;
  commit(): void;
  abort(): string | undefined;
}

const kindOf = (s: Stats) =>
  s.isSymbolicLink() ? 'a symlink' : s.isDirectory() ? 'a directory' : 'a special file';

/** The fd is closed exactly once, whatever mix of commit and abort follows. */
function closer(fd: number): () => void {
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    closeSync(fd);
  };
}

/**
 * abort runs while another error is on its way out: a close error must not skip the removal,
 * and neither may replace the error that caused the abort. A failed removal comes back as a
 * note, so the caller can say what was left on disk.
 */
function release(close: () => void, remove: () => void, path: string): string | undefined {
  try {
    close();
  } catch {
    // The removal below still runs.
  }
  try {
    remove();
    return undefined;
  } catch (error) {
    return `Could not remove the partial file ${path}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Check the path and create the file before Chrome is asked to end the trace, so a bad path
 * never costs the recording: it keeps running. After the end, a finished trace misses its path
 * in two ways. If the OS refuses the final replace (overwrite: true), the complete trace is kept
 * at the temp file the error names. If the final close fails (EIO), the file is removed and the
 * close error is thrown, because what reached the disk cannot be trusted.
 */
/**
 * The checks on a caller's outPath, with nothing created: profile runs them before it records,
 * so a bad path costs no recording. A pass is not a promise; openTraceSink opens with O_EXCL
 * (or writes beside and renames), so a file that appears afterwards is still caught.
 */
export function validateOutPath(options: { compress: boolean; outPath: string; overwrite?: boolean }): {
  target: string;
  parent: string;
  /** A regular file is there now (allowed only with overwrite: true). */
  exists: boolean;
} {
  const ext = options.compress ? '.json.gz' : '.json';
  if (!isAbsolute(options.outPath)) {
    throw new Error(
      `outPath must be an absolute path, got "${options.outPath}" (~ is not expanded and the server's working directory is not yours)`
    );
  }
  // Collapse .. first, so every check and message is about the path that is really written.
  const target = resolve(options.outPath);
  if (!target.endsWith(ext)) {
    throw new Error(
      `outPath must end in ${ext} for a trace started with compress: ${options.compress}; got ${target}`
    );
  }
  const parent = dirname(target);
  let parentStat: Stats;
  try {
    parentStat = statSync(parent);
  } catch {
    throw new Error(`The directory for outPath does not exist: ${parent}. Create it, or choose another path.`);
  }
  if (!parentStat.isDirectory()) throw new Error(`The parent of outPath is not a directory: ${parent}`);
  try {
    // Both the open beside the target and the rename need write and search on the directory.
    accessSync(parent, constants.W_OK | constants.X_OK);
  } catch {
    throw new Error(`The directory for outPath is not writable: ${parent}. Choose another path.`);
  }

  let existing: Stats | undefined;
  try {
    existing = lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing && !existing.isFile()) {
    // A rename would replace a symlink rather than write through it, which surprises people.
    throw new Error(`outPath already exists and is ${kindOf(existing)}, not a regular file; choose another path: ${target}`);
  }
  if (existing && options.overwrite !== true) {
    throw new Error(`outPath already exists: ${target}. Pass overwrite: true to replace it, or choose another path.`);
  }
  return { target, parent, exists: existing !== undefined };
}

export function openTraceSink(options: SinkOptions): TraceSink {
  const ext = options.compress ? '.json.gz' : '.json';

  if (options.outPath === undefined) {
    // A new owner-only directory per trace (mkdtemp makes it 0700 with an unpredictable name):
    // traces hold URLs and source text, and nothing pre-existing is reused or trusted.
    const fresh = mkdtempSync(join(options.dir ?? tmpdir(), 'control-trace-'));
    const path = join(fresh, `trace${ext}`);
    let fd: number;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (error) {
      try {
        rmSync(fresh, { recursive: true, force: true });
      } catch {
        // The create error is the one that explains this; a failed cleanup must not replace it.
      }
      throw error;
    }
    const close = closer(fd);
    return {
      path,
      fd,
      replaces: false,
      commit: close,
      abort: () => release(close, () => rmSync(fresh, { recursive: true, force: true }), fresh),
    };
  }

  const { target, parent, exists } = validateOutPath({ ...options, outPath: options.outPath });

  if (options.overwrite !== true) {
    // O_EXCL: fails if anything, even a symlink, appeared since the check.
    const fd = openSync(target, 'wx', 0o600);
    const close = closer(fd);
    return {
      path: target,
      fd,
      replaces: false,
      commit: close,
      // Created by us a moment ago, so ours to remove.
      abort: () => release(close, () => rmSync(target, { force: true }), target),
    };
  }

  // Write beside the target and rename over it on success: the old file is untouched until then,
  // and rename replaces whatever is at the path without following it.
  const temp = join(parent, `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  const close = closer(fd);
  let kept = false;
  return {
    path: target,
    fd,
    replaces: exists,
    commit: () => {
      close();
      try {
        renameSync(temp, target);
      } catch (error) {
        // The trace is complete and Chrome has ended it; deleting it now would lose the recording.
        kept = true;
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Replacing ${target} was refused (${reason}). The trace is complete and kept at ${temp}; ` +
            'move it into place yourself, or stop the next trace to another path.'
        );
      }
    },
    abort: () =>
      release(
        close,
        () => {
          if (!kept) rmSync(temp, { force: true });
        },
        temp
      ),
  };
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

/**
 * Tracing.end got no answer (timeout or a broken transport), so Chrome may still be tracing.
 * The recorder keeps the trace as running: stop can be tried again, and a disconnect ends it,
 * because Chrome ends a trace with its session.
 */
export class TraceStillRunningError extends Error {}

const mayStillRun = (error: unknown) =>
  error instanceof TraceStillRunningError || (error instanceof Error && error.cause instanceof TraceStillRunningError);

export async function stopTrace(
  cdp: TraceCdp,
  options: { compress: boolean; dir?: string; maxBytes?: number; deadlineMs?: number; sink?: TraceSink }
): Promise<StoppedTrace> {
  // The file exists before Chrome is asked to end: if it cannot be made, the recording is untouched.
  const sink = options.sink ?? openTraceSink({ compress: options.compress, dir: options.dir });
  let stream: string | undefined;
  try {
    // Register for the completion event before ending, so a fast finish is not missed.
    const waiter = new AbortController();
    const complete = cdp.waitForEvent('Tracing.tracingComplete', COMPLETE_TIMEOUT_MS, waiter.signal);
    complete.catch(() => {});
    let end: Awaited<ReturnType<TraceCdp['sendCommand']>>;
    try {
      end = await cdp.sendCommand('Tracing.end');
    } catch (error) {
      waiter.abort();
      throw new TraceStillRunningError(
        `Stop did not complete; the trace may still be running. Try stop again, or disconnect to end it. (${
          error instanceof Error ? error.message : String(error)
        })`,
        { cause: error }
      );
    }
    if (end.error) {
      // Chrome answered: whatever it was doing, it is not recording this trace any more.
      waiter.abort();
      throw new Error(`Chrome refused to end the trace: ${end.error.message}`);
    }
    const done = await complete;

    if (typeof done.stream !== 'string' || done.stream === '') {
      throw new Error('Chrome finished the trace without a stream handle');
    }
    // From here the Chrome-side stream is held, so it is closed in the finally below.
    const handle = done.stream;
    stream = handle;

    const maxBytes = options.maxBytes ?? MAX_TRACE_BYTES;
    const deadline = Date.now() + (options.deadlineMs ?? DRAIN_DEADLINE_MS);
    let bytes = 0;
    for (;;) {
      if (Date.now() > deadline) throw new Error('Reading the trace from Chrome took too long; giving up');
      const r = await cdp.sendCommand('IO.read', { handle, size: READ_CHUNK_BYTES });
      if (r.error) throw new Error(r.error.message);
      const chunk = r.result as { data?: string; eof?: boolean; base64Encoded?: boolean };
      if (chunk.data) {
        const buf = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
        bytes += writeAll((b, offset) => writeSync(sink.fd, b, offset), buf);
        if (bytes > maxBytes) {
          throw new Error(`The trace exceeds ${Math.round(maxBytes / (1024 * 1024))}MB; record a shorter run`);
        }
      }
      if (chunk.eof) break;
    }
    sink.commit();
    return {
      path: sink.path,
      bytes,
      compressed: options.compress,
      dataLoss: done.dataLossOccurred === true,
      ...(sink.replaces ? { overwritten: true as const } : {}),
    };
  } catch (error) {
    const note = sink.abort();
    if (!note) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw mayStillRun(error)
      ? new TraceStillRunningError(`${message} ${note}`, { cause: error })
      : new Error(`${message} ${note}`, { cause: error });
  } finally {
    if (stream !== undefined) await cdp.sendCommand('IO.close', { handle: stream }).catch(() => {});
  }
}

interface ActiveTrace {
  id: number;
  /** Set when Chrome has answered Tracing.start; null while it is starting. */
  startedAt: number | null;
  compress: boolean;
}

/** An id mismatch shows only that this call's recording is not the active one, not why. */
export const TRACE_GONE =
  'The trace this call started is no longer the active recording: Chrome ends a trace with its tab or connection, ' +
  'and another call may have stopped it. This call kept nothing.';

/**
 * One connection's recording: at most one trace at a time, remembered with how
 * it was started so stop writes the same format. Cleared when the connection
 * changes, because Chrome ends a trace with its session. Each start has an id,
 * so a caller can stop the trace it started and never a newer one.
 */
export class TraceRecorder {
  private active: ActiveTrace | null = null;
  private nextId = 1;

  get running(): boolean {
    return this.active !== null;
  }

  /** True while the trace with this id is the one recording. */
  isCurrent(id: number): boolean {
    return this.active?.id === id;
  }

  async start(cdp: TraceCdp, options: StartOptions): Promise<number> {
    if (this.active) {
      const since = this.active.startedAt ?? Date.now();
      const seconds = Math.round((Date.now() - since) / 1000);
      throw new Error(
        `A trace is already running (started ${seconds}s ago). Stop it with chrome({ method: "trace", action: "stop" }) first.`
      );
    }
    // Reserved before the await, so a second start that overlaps this one is refused.
    const trace: ActiveTrace = { id: this.nextId++, startedAt: null, compress: options.compress };
    this.active = trace;
    try {
      await startTrace(cdp, options);
    } catch (error) {
      if (this.active === trace) this.active = null;
      throw error;
    }
    trace.startedAt = Date.now();
    return trace.id;
  }

  /**
   * With an id, stops only that trace: if it is gone (reset with its session, or replaced),
   * it throws and touches nothing. Without one, stops whatever is running (trace stop).
   */
  async stop(
    cdp: TraceCdp,
    options: { dir?: string; outPath?: string; overwrite?: boolean; id?: number } = {}
  ): Promise<StoppedTrace & { durationMs: number }> {
    const { id, ...sinkOptions } = options;
    const trace = this.active;
    if (id !== undefined && trace?.id !== id) {
      throw new Error(TRACE_GONE);
    }
    if (!trace) {
      throw new Error('No trace is running. Start one with chrome({ method: "trace", action: "start" }).');
    }
    if (trace.startedAt === null) throw new Error('The trace is still starting; try stop again in a moment.');
    // The recording ends when stop is called; flushing and downloading come after.
    const durationMs = Date.now() - trace.startedAt;
    // Outside the try: a bad path leaves the trace running, so the caller can fix it and stop again.
    const sink = openTraceSink({ compress: trace.compress, ...sinkOptions });
    let stillRunning = false;
    try {
      const out = await stopTrace(cdp, { compress: trace.compress, sink });
      return { ...out, durationMs };
    } catch (error) {
      stillRunning = mayStillRun(error);
      throw error;
    } finally {
      // Chrome has ended this trace unless Tracing.end got no answer. Only this trace is cleared:
      // a newer one, started after a reset while this stop drained, is not ours.
      if (!stillRunning && this.active === trace) this.active = null;
    }
  }

  /** Forget the trace with this id, if it is still the current one. */
  release(id: number): void {
    if (this.active?.id === id) this.active = null;
  }

  reset(): void {
    this.active = null;
  }
}

/**
 * Ends a recording whose caller failed after it started (profile). It acts only on the trace with
 * this id: a reset means Chrome ended it with its session, and a trace running now is someone
 * else's. What could be written goes to a fresh private directory, unsummarized. It never says a
 * trace ended or that nothing was kept unless Chrome answered; the message names which case it was.
 */
export async function abandonTrace(
  recorder: TraceRecorder,
  cdp: TraceCdp,
  id: number,
  failure: string,
  /** How long to wait for the stream of the best-effort end, so it can be closed. */
  completeTimeoutMs = 5000
): Promise<string> {
  if (!recorder.isCurrent(id)) return `${failure} ${TRACE_GONE}`;
  try {
    const out = await recorder.stop(cdp, { id });
    return `${failure} The partial trace was kept at ${out.path}.`;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    // Cleared by the stop: Chrome answered, and the stop's message says what became of the file.
    if (!recorder.isCurrent(id)) return `${failure} Stopping the trace also failed: ${why}`;
    // Still ours and maybe still tracing: the private file could not be made, or Tracing.end got no answer.
    // Registered before the end, so the stream Chrome hands back can be closed; it is never read.
    const waiter = new AbortController();
    const complete = cdp.waitForEvent('Tracing.tracingComplete', completeTimeoutMs, waiter.signal);
    complete.catch(() => {});
    const end = await cdp.sendCommand('Tracing.end').catch(() => undefined);
    if (end === undefined || end.error) {
      waiter.abort();
    } else {
      // A completion that does not come within the bound has no stream we could close.
      const done = await complete.catch(() => undefined);
      if (typeof done?.stream === 'string' && done.stream !== '') {
        await cdp.sendCommand('IO.close', { handle: done.stream }).catch(() => {});
      }
    }
    if (end === undefined) {
      return (
        `${failure} Stopping the trace also failed (${why}), and Chrome did not answer a request to end it: ` +
        'the trace may still be running. Try chrome({ method: "trace", action: "stop" }) again, or disconnect to end it.'
      );
    }
    // Chrome answered, so it is not recording this trace any more.
    recorder.release(id);
    return (
      `${failure} Stopping the trace also failed (${why}). Chrome then ended the trace` +
      `${end.error ? ` (it answered: ${end.error.message})` : ''}; nothing was kept.`
    );
  }
}
