/**
 * control/chrome-trace-capture — record a Chrome trace to a file
 *
 * Tracing.start with transferMode ReturnAsStream, then on stop the stream is
 * read with IO.read and written to disk as it arrives, never held whole in
 * memory or sent back over MCP. Chrome gzips the stream when asked.
 */

import { randomBytes } from 'node:crypto';
import { closeSync, lstatSync, mkdtempSync, openSync, renameSync, rmSync, statSync, writeSync, type Stats } from 'node:fs';
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
      rmSync(fresh, { recursive: true, force: true });
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
    try {
      const end = await cdp.sendCommand('Tracing.end');
      if (end.error) throw new Error(end.error.message);
    } catch (error) {
      waiter.abort();
      throw error;
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
    throw new Error(`${message} ${note}`, { cause: error });
  } finally {
    if (stream !== undefined) await cdp.sendCommand('IO.close', { handle: stream }).catch(() => {});
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

  async stop(
    cdp: TraceCdp,
    options: { dir?: string; outPath?: string; overwrite?: boolean } = {}
  ): Promise<StoppedTrace & { durationMs: number }> {
    const trace = this.active;
    if (!trace) {
      throw new Error('No trace is running. Start one with chrome({ method: "trace", action: "start" }).');
    }
    // The recording ends when stop is called; flushing and downloading come after.
    const durationMs = Date.now() - trace.startedAt;
    // Outside the try: a bad path leaves the trace running, so the caller can fix it and stop again.
    const sink = openTraceSink({ compress: trace.compress, ...options });
    try {
      const out = await stopTrace(cdp, { compress: trace.compress, sink });
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
