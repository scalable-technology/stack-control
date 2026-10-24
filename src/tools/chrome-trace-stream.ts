/**
 * control/chrome-trace-stream — the events of a trace file, one at a time, from a stream of bytes
 *
 * A trace is one JSON document: an object with a traceEvents array, or a bare array of events.
 * Parsing it whole holds the text and every event at once (a real 8s profile is 184MB of text and
 * about 1GB of memory). This scanner walks the bytes instead and hands each element of the event
 * array to JSON.parse on its own, so memory is what the caller keeps.
 *
 * It reads raw UTF-8: every byte it looks at ({ } [ ] " \ , : and whitespace) is ASCII, and no
 * byte of a multi-byte character is in that range, so an element's bytes are decoded only once it
 * is whole. It is iterative (a depth counter and a bit per level, no recursion), checks strings,
 * brackets and the array's commas, and leaves the rest of each element to JSON.parse. The top
 * object's other values are skipped with the same checks. It stops at the end of the array:
 * whatever follows (metadata, garbage) is not read.
 */

/** An element over this many bytes is skipped and counted, not parsed. A real event is a few KB. */
export const MAX_EVENT_BYTES = 16 * 1024 * 1024;

export type ScanState = 'scanning' | 'done' | 'invalid' | 'noEvents' | 'stopped';

// What the scanner expects next, outside a value.
const START = 0; // the document's first value
const KEY = 1; // a key of the top object, or its end
const KEY_TEXT = 2; // inside a key
const COLON = 3;
const VALUE = 4; // a value of the top object
const AFTER_VALUE = 5; // a comma or the end of the top object
const ELEMENT = 6; // an element of the event array, or its end
const AFTER_ELEMENT = 7; // a comma or the end of the event array
const IN_VALUE = 8; // inside a value: skipping one of the top object's, or reading an element

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON_BYTE = 0x3a;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

const isSpace = (b: number) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;

/** A key that spells traceEvents with escapes is at most 11 escapes of 6 bytes; a longer one cannot be it. */
const MAX_KEY_BYTES = 128;
const TRACE_EVENTS = Buffer.from('traceEvents');

export class TraceEventScanner {
  state: ScanState = 'scanning';
  /** Object elements handed to the callback. */
  events = 0;
  /** Elements skipped for being over the size limit. */
  oversized = 0;
  /** Bytes read up to the end of the array, or up to now. */
  position = 0;

  private mode = START;
  /** First element or key: a closing bracket is allowed, a comma was not just read. */
  private first = true;
  /** Where IN_VALUE goes when the value ends. */
  private capture = false;

  // The value being read.
  private depth = 0;
  /** One bit per open level: 1 for an array, 0 for an object. */
  private levels = new Uint8Array(64);
  private inString = false;
  private escaped = false;
  private primitive = false;
  private pieces: Buffer[] = [];
  private valueBytes = 0;
  private tooLarge = false;

  // The key being read.
  private key: number[] = [];
  private keyEscaped = false;
  private keyIsEvents = false;

  constructor(
    private readonly onEvent: (event: Record<string, unknown>) => boolean | void,
    private readonly maxEventBytes = MAX_EVENT_BYTES
  ) {}

  /** Reads a chunk, or as much of it as it needs: it stops at the end of the array or a fault. */
  write(chunk: Buffer): void {
    const n = chunk.length;
    let i = 0;
    let valueStart = this.mode === IN_VALUE ? 0 : -1;
    while (i < n && this.state === 'scanning') {
      if (this.mode === IN_VALUE) {
        const end = this.scanValue(chunk, i);
        if (end < 0) {
          i = n;
          break;
        }
        // end is one past the value's last byte; a bare token ends at the byte after it, which is not its own.
        this.finishValue(chunk, valueStart, end);
        valueStart = -1;
        i = end;
        continue;
      }
      const b = chunk[i];
      switch (this.mode) {
        case START:
          if (isSpace(b)) break;
          if (b === OPEN_BRACE) this.mode = KEY;
          else if (b === OPEN_BRACKET) this.mode = ELEMENT;
          else this.state = 'noEvents';
          this.first = true;
          break;
        case KEY:
          if (isSpace(b)) break;
          if (b === QUOTE) {
            this.mode = KEY_TEXT;
            this.key = [];
            this.keyEscaped = false;
            this.escaped = false;
          } else if (b === CLOSE_BRACE && this.first) {
            this.state = 'noEvents';
          } else {
            this.state = 'invalid';
          }
          break;
        case KEY_TEXT:
          if (this.escaped) {
            this.escaped = false;
          } else if (b === BACKSLASH) {
            this.escaped = this.keyEscaped = true;
          } else if (b === QUOTE) {
            this.keyIsEvents = this.isTraceEventsKey();
            this.mode = COLON;
            break;
          }
          if (this.key.length <= MAX_KEY_BYTES) this.key.push(b);
          break;
        case COLON:
          if (isSpace(b)) break;
          if (b === COLON_BYTE) this.mode = VALUE;
          else this.state = 'invalid';
          break;
        case VALUE:
          if (isSpace(b)) break;
          if (this.keyIsEvents && b === OPEN_BRACKET) {
            this.mode = ELEMENT;
            this.first = true;
            break;
          }
          this.startValue(false);
          valueStart = i;
          continue; // the value reads its own first byte
        case AFTER_VALUE:
          if (isSpace(b)) break;
          if (b === COMMA) {
            this.mode = KEY;
            this.first = false;
          } else if (b === CLOSE_BRACE) {
            this.state = 'noEvents';
          } else {
            this.state = 'invalid';
          }
          break;
        case ELEMENT:
          if (isSpace(b)) break;
          if (b === CLOSE_BRACKET && this.first) {
            this.state = 'done';
          } else if (b === COMMA || b === CLOSE_BRACKET) {
            this.state = 'invalid';
          } else {
            this.startValue(true);
            valueStart = i;
            continue;
          }
          break;
        case AFTER_ELEMENT:
          if (isSpace(b)) break;
          if (b === COMMA) {
            this.mode = ELEMENT;
            this.first = false;
          } else if (b === CLOSE_BRACKET) {
            this.state = 'done';
          } else {
            this.state = 'invalid';
          }
          break;
      }
      i++;
    }
    if (this.state === 'scanning' && this.mode === IN_VALUE) this.keepPiece(chunk, valueStart, n);
    this.position += i;
  }

  /** The input ended. Anything short of the end of the array is not a whole document. */
  end(): void {
    if (this.state === 'scanning') this.state = 'invalid';
  }

  private isTraceEventsKey(): boolean {
    const key = Buffer.from(this.key);
    if (!this.keyEscaped) return key.equals(TRACE_EVENTS);
    if (key.length > MAX_KEY_BYTES) return false;
    try {
      return JSON.parse(`"${key.toString('utf8')}"`) === 'traceEvents';
    } catch {
      this.state = 'invalid';
      return false;
    }
  }

  private startValue(capture: boolean): void {
    this.mode = IN_VALUE;
    this.capture = capture;
    this.depth = 0;
    this.inString = false;
    this.escaped = false;
    this.primitive = false;
    this.pieces = [];
    this.valueBytes = 0;
    this.tooLarge = false;
  }

  /**
   * Walks the value from i. Returns one past its end, or -1 when the chunk ends first. The first
   * byte of a value is read here too, so it starts at depth 0 outside a string.
   */
  private scanValue(chunk: Buffer, i: number): number {
    const n = chunk.length;
    if (this.depth === 0 && !this.inString && !this.primitive) {
      const b = chunk[i];
      if (b === OPEN_BRACE || b === OPEN_BRACKET) {
        this.push(b === OPEN_BRACKET);
      } else if (b === QUOTE) {
        this.inString = true;
      } else {
        this.primitive = true;
      }
      i++;
    }
    if (this.primitive) {
      for (; i < n; i++) {
        const b = chunk[i];
        if (b === COMMA || b === CLOSE_BRACKET || b === CLOSE_BRACE || isSpace(b)) return i;
      }
      return -1;
    }
    for (; i < n; i++) {
      const b = chunk[i];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (b === BACKSLASH) this.escaped = true;
        else if (b === QUOTE) {
          this.inString = false;
          if (this.depth === 0) return i + 1; // a string value
        }
      } else if (b === QUOTE) {
        this.inString = true;
      } else if (b === OPEN_BRACE || b === OPEN_BRACKET) {
        this.push(b === OPEN_BRACKET);
      } else if (b === CLOSE_BRACE || b === CLOSE_BRACKET) {
        if (!this.pop(b === CLOSE_BRACKET)) {
          this.state = 'invalid';
          return i;
        }
        if (this.depth === 0) return i + 1;
      }
    }
    return -1;
  }

  private push(isArray: boolean): void {
    const byte = this.depth >> 3;
    if (byte >= this.levels.length) {
      const grown = new Uint8Array(this.levels.length * 2);
      grown.set(this.levels);
      this.levels = grown;
    }
    const bit = 1 << (this.depth & 7);
    this.levels[byte] = isArray ? this.levels[byte] | bit : this.levels[byte] & ~bit;
    this.depth++;
  }

  /** Closes a level; false when the bracket does not match the one that opened it. */
  private pop(isArray: boolean): boolean {
    if (this.depth === 0) return false;
    this.depth--;
    const wasArray = (this.levels[this.depth >> 3] & (1 << (this.depth & 7))) !== 0;
    return wasArray === isArray;
  }

  /** Holds the part of an element in this chunk, unless the element is already too large to parse. */
  private keepPiece(chunk: Buffer, start: number, end: number): void {
    if (!this.capture) return;
    this.valueBytes += end - start;
    if (this.valueBytes > this.maxEventBytes) {
      this.tooLarge = true;
      this.pieces = [];
    }
    if (!this.tooLarge) this.pieces.push(chunk.subarray(start, end));
  }

  private finishValue(chunk: Buffer, start: number, end: number): void {
    if (this.state !== 'scanning') return;
    if (!this.capture) {
      this.mode = AFTER_VALUE;
      return;
    }
    this.mode = AFTER_ELEMENT;
    this.keepPiece(chunk, Math.max(start, 0), end);
    if (this.tooLarge) {
      this.oversized++;
      return;
    }
    const pieces = this.pieces;
    this.pieces = [];
    let value: unknown;
    try {
      value = JSON.parse((pieces.length === 1 ? pieces[0] : Buffer.concat(pieces)).toString('utf8'));
    } catch {
      this.state = 'invalid';
      return;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
    this.events++;
    if (this.onEvent(value as Record<string, unknown>) === false) this.state = 'stopped';
  }
}

export type ScanResult =
  | { end: 'done'; events: number; bytes: number; oversized: number }
  | { end: 'invalid' | 'noEvents' | 'tooBig' | 'timeout' | 'stopped' };

export interface ScanOptions {
  /** Bytes the array must end within; more gives tooBig, and nothing past it is pulled. */
  maxBytes: number;
  /** On the clock of now: past it, the scan stops with timeout, even while the source is silent. */
  deadline: number;
  now?: () => number;
  /** How the scan gives the event loop a turn; a test can count or delay it. */
  tick?: () => Promise<void>;
  /** Bytes read between ticks. */
  yieldBytes?: number;
  maxEventBytes?: number;
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const STALLED = Symbol('stalled');

/**
 * Scans a source of bytes to the end of its event array. Async, and it yields every yieldBytes
 * (1MB), so a large or hostile file never holds the event loop for long; a sync loop could not
 * be stopped. The source is closed when the scan ends, however it ends. Throws what the source throws.
 */
export async function scanTraceEvents(
  source: AsyncIterable<Buffer>,
  onEvent: (event: Record<string, unknown>) => boolean | void,
  options: ScanOptions
): Promise<ScanResult> {
  const { maxBytes, deadline, now = Date.now, tick = nextTurn, yieldBytes = 1024 * 1024 } = options;
  const scanner = new TraceEventScanner(onEvent, options.maxEventBytes);
  const it = source[Symbol.asyncIterator]();
  let pulled = 0;
  let stalled = false;

  const next = async (): Promise<IteratorResult<Buffer> | typeof STALLED> => {
    const remaining = deadline - now();
    if (remaining === Infinity) return it.next();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<typeof STALLED>((resolve) => {
      timer = setTimeout(() => resolve(STALLED), Math.max(0, remaining));
    });
    try {
      return await Promise.race([it.next(), late]);
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    for (;;) {
      if (now() > deadline) return { end: 'timeout' };
      const r = await next();
      if (r === STALLED) {
        stalled = true;
        return { end: 'timeout' };
      }
      if (r.done) break;
      let chunk = r.value;
      const room = maxBytes - pulled;
      const over = chunk.length > room;
      if (over) chunk = chunk.subarray(0, Math.max(0, room));
      for (let at = 0; at < chunk.length && scanner.state === 'scanning'; at += yieldBytes) {
        if (at > 0) {
          await tick();
          if (now() > deadline) return { end: 'timeout' };
        }
        scanner.write(chunk.subarray(at, at + yieldBytes));
      }
      pulled += chunk.length;
      if (scanner.state !== 'scanning') break;
      if (over) return { end: 'tooBig' };
      // Chunks smaller than yieldBytes tick once their sum reaches it.
      if (Math.floor(pulled / yieldBytes) > Math.floor((pulled - chunk.length) / yieldBytes)) await tick();
    }
    scanner.end();
  } finally {
    // A source stuck in an await cannot run its cleanup until it wakes: ask, but do not wait for it.
    const closing = Promise.resolve(it.return?.()).catch(() => {});
    if (!stalled) await closing;
  }
  if (scanner.state === 'done') {
    return { end: 'done', events: scanner.events, bytes: scanner.position, oversized: scanner.oversized };
  }
  return { end: scanner.state === 'scanning' ? 'invalid' : scanner.state };
}
