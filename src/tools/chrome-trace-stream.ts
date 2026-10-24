/**
 * control/chrome-trace-stream — the events of a trace file, one at a time, from a stream of bytes
 *
 * A trace is one JSON document: an object with a traceEvents array, or a bare array of events.
 * Parsing it whole holds the text and every event at once (a real 8s profile is 184MB of text and
 * about 1GB of memory). This scanner walks the bytes instead and hands each element of the event
 * array to JSON.parse on its own. What it holds besides what the caller keeps: the element being
 * read (at most MAX_EVENT_BYTES, in one growing buffer), its decoded text and parsed value while
 * it is parsed, and a bit per open bracket up to MAX_DEPTH levels (12.5KB).
 *
 * It reads raw UTF-8: every byte it looks at ({ } [ ] " \ , : and whitespace) is ASCII, and no
 * byte of a multi-byte character is in that range, so an element's bytes are decoded only once it
 * is whole. It is iterative (a depth counter and a bit per level, no recursion). It checks only
 * what it reads: strings, brackets up to MAX_DEPTH, the keys and colons and commas of the top
 * object, and the commas of the event array. JSON.parse checks each element. The top object's
 * other values are skipped with the bracket and string checks alone, so {"metadata":[tru],
 * "traceEvents":[...]} is read; and it stops at the end of the array, so whatever follows
 * (metadata, garbage, a missing closing brace) is not read either. A byte-order mark is not
 * JSON (JSON.parse refuses it), so a file that starts with one has no traceEvents array.
 */

/**
 * An element over this many bytes is skipped and counted, not parsed. Real events are a few KB
 * (a screenshot, the largest, a few hundred KB). Parsing one costs more than its text: the text
 * as a JS string and the parsed value. Measured at 4MB (node 22): nested empty arrays took up to
 * 230MB while parsed and 90-260ms, arrays 50,000 deep 320ms; strings and numbers under 20ms.
 */
export const MAX_EVENT_BYTES = 4 * 1024 * 1024;

/**
 * Brackets nested deeper than this are not matched, so the stack of open brackets stays 12.5KB
 * however deep a hostile file goes; an element that goes deeper is skipped and counted with the
 * oversized ones. Real events nest about 6 deep.
 */
export const MAX_DEPTH = 100_000;

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
  /** Elements skipped for being over the size or depth limit. */
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
  /** The bytes of an element that began in an earlier chunk: one buffer, grown by doubling. */
  private pending: Buffer | null = null;
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

  /** Buffers held for the element being read: 0 or 1, however many chunks it came in. */
  get pendingBuffers(): number {
    return this.pending ? 1 : 0;
  }

  /** The bytes the stack of open brackets takes. */
  get stackBytes(): number {
    return this.levels.length;
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
    this.pending = null;
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
    if (this.depth >= MAX_DEPTH) {
      this.depth++;
      this.drop();
      return;
    }
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
    if (this.depth >= MAX_DEPTH) return true; // not recorded, so not checked
    const wasArray = (this.levels[this.depth >> 3] & (1 << (this.depth & 7))) !== 0;
    return wasArray === isArray;
  }

  /** The element will not be parsed: let go of its bytes. */
  private drop(): void {
    this.tooLarge = true;
    this.pending = null;
  }

  /** Copies the part of an element in this chunk, unless the element is already too large to parse. */
  private keepPiece(chunk: Buffer, start: number, end: number): void {
    if (!this.capture || this.tooLarge) return;
    const length = this.valueBytes;
    this.valueBytes += end - start;
    if (this.valueBytes > this.maxEventBytes) return this.drop();
    if (!this.pending || this.pending.length < this.valueBytes) {
      // Doubling keeps the copying linear in the element's size, however small its chunks.
      const grown = Buffer.allocUnsafe(Math.min(this.maxEventBytes, Math.max(this.valueBytes, 2 * (this.pending?.length ?? 1024))));
      this.pending?.copy(grown, 0, 0, length);
      this.pending = grown;
    }
    chunk.copy(this.pending, length, start, end);
  }

  private finishValue(chunk: Buffer, start: number, end: number): void {
    if (this.state !== 'scanning') return;
    if (!this.capture) {
      this.mode = AFTER_VALUE;
      return;
    }
    this.mode = AFTER_ELEMENT;
    start = Math.max(start, 0);
    let text: string;
    if (this.pending === null && !this.tooLarge) {
      // The whole element is in this chunk: decoded from it, no copy.
      if (end - start > this.maxEventBytes) this.tooLarge = true;
      text = this.tooLarge ? '' : chunk.toString('utf8', start, end);
    } else {
      this.keepPiece(chunk, start, end);
      text = this.tooLarge ? '' : this.pending!.toString('utf8', 0, this.valueBytes);
    }
    this.pending = null;
    if (this.tooLarge) {
      this.oversized++;
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      // A syntax error, or a RangeError V8 throws for a value it cannot hold: either fails the whole scan.
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
  /** How long to wait for the source to confirm it closed; then the scan returns anyway. */
  closeWaitMs?: number;
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const STALLED = Symbol('stalled');

/**
 * Scans a source of bytes to the end of its event array. Async: it gives the event loop a turn
 * about every yieldBytes (1MB) scanned, and checks the deadline then and between chunks. What runs
 * between turns is the scan of up to 1MB plus the JSON.parse of the elements that end in it; one
 * parse is synchronous, bounded by MAX_EVENT_BYTES (measured worst: 320ms).
 * However the scan ends, the source is asked to close (its return()); the scan waits up to
 * closeWaitMs (2s) for that, and not at all when the source stalled, since a source stuck in an
 * await cannot close until it wakes. Whoever made the source owns what it holds open (a file
 * stream's fd). Throws what the source throws, or the callback.
 */
export async function scanTraceEvents(
  source: AsyncIterable<Buffer>,
  onEvent: (event: Record<string, unknown>) => boolean | void,
  options: ScanOptions
): Promise<ScanResult> {
  const { maxBytes, deadline, now = Date.now, tick = nextTurn, yieldBytes = 1024 * 1024, closeWaitMs = 2000 } = options;
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
    const closing = (async () => it.return?.())().catch(() => {});
    if (!stalled) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([closing, new Promise<void>((resolve) => { timer = setTimeout(resolve, closeWaitMs); })]);
      clearTimeout(timer);
    }
  }
  if (scanner.state === 'done') {
    return { end: 'done', events: scanner.events, bytes: scanner.position, oversized: scanner.oversized };
  }
  return { end: scanner.state === 'scanning' ? 'invalid' : scanner.state };
}
