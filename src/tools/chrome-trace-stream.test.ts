import { describe, expect, it, vi } from 'vitest';
import { MAX_EVENT_BYTES, TraceEventScanner, scanTraceEvents, type ScanResult } from './chrome-trace-stream.js';

type Event = Record<string, unknown>;

/** Feeds text to a scanner in chunks of the given size and returns what it saw. */
function scan(text: string | Buffer, chunkSize = 64 * 1024, maxEventBytes?: number) {
  const events: Event[] = [];
  const scanner = new TraceEventScanner((e) => { events.push(e); }, maxEventBytes);
  const bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
  for (let i = 0; i < bytes.length && scanner.state === 'scanning'; i += chunkSize) {
    scanner.write(bytes.subarray(i, i + chunkSize));
  }
  scanner.end();
  return { events, state: scanner.state, oversized: scanner.oversized };
}

/** The events JSON.parse finds: the object elements of the array. */
const parsedEvents = (text: string): Event[] => {
  const v = JSON.parse(text) as unknown;
  const list = Array.isArray(v) ? v : (v as { traceEvents: unknown[] }).traceEvents;
  return list.filter((e): e is Event => typeof e === 'object' && e !== null && !Array.isArray(e));
};

const TRICKY = JSON.stringify({
  metadata: { 'trace-config': '{"x":[1,2]}', nested: [[[{ a: '}' }]]] },
  traceEvents: [
    { name: 'a}]"[{', ph: 'X', ts: 1, args: { s: '\\', t: '\\"', u: '\\\\"}', v: 'tab\there' } },
    { name: 'é😀\u0000\u001f', ph: 'I', ts: 2, args: { emoji: '😀😀', cjk: '中文', lone: 'x' } },
    { name: 'traceEvents', ph: 'M', args: { traceEvents: [{ name: 'inner' }] } },
    { name: 'deep', args: { a: { b: { c: [1, [2, [3, { d: '[' }]]] } } } },
  ],
  after: { traceEvents: [{ name: 'never' }] },
});

describe('TraceEventScanner', () => {
  it.each([1, 2, 3, 7, 4096])('finds the same events at chunk size %d', (size) => {
    const r = scan(TRICKY, size);
    expect(r.state).toBe('done');
    expect(r.events).toEqual(parsedEvents(TRICKY));
    expect(r.events.map((e) => e.name)).toEqual(['a}]"[{', 'é😀\u0000\u001f', 'traceEvents', 'deep']);
  });

  it('decodes an escaped surrogate pair and a raw one split across every chunk boundary', () => {
    const text = '[{"a":"\\ud83d\\ude00","b":"😀x😀"}]';
    for (let size = 1; size <= text.length; size++) {
      const r = scan(text, size);
      expect(r.events, `chunk ${size}`).toEqual([{ a: '😀', b: '😀x😀' }]);
    }
  });

  it('takes the bare array form', () => {
    const text = JSON.stringify([{ name: 'a' }, { name: 'b' }]);
    expect(scan(text).events).toEqual([{ name: 'a' }, { name: 'b' }]);
  });

  it.each(['[]', '{"traceEvents":[]}', ' [ ] ', '{"metadata":{},"traceEvents":[  ]}'])('takes an empty array: %s', (text) => {
    const r = scan(text);
    expect(r.state).toBe('done');
    expect(r.events).toEqual([]);
  });

  it('reads metadata before and after traceEvents, and stops at the end of the array', () => {
    const before = '{"metadata":{"a":[1,{"b":"]"}]},"traceEvents":[{"n":1}],"z":1}';
    expect(scan(before)).toMatchObject({ state: 'done', events: [{ n: 1 }] });
    const after = '{"traceEvents":[{"n":1}],"metadata":{"traceEvents":[{"n":2}]}}';
    expect(scan(after)).toMatchObject({ state: 'done', events: [{ n: 1 }] });
  });

  it('does not take a traceEvents key nested inside another value for the top-level one', () => {
    const text = '{"meta":{"traceEvents":[{"name":"wrong"}]},"list":[{"traceEvents":[{"name":"wrong"}]}],"traceEvents":[{"name":"right"}]}';
    expect(scan(text).events).toEqual([{ name: 'right' }]);
    expect(scan('{"meta":{"traceEvents":[{"name":"wrong"}]}}').state).toBe('noEvents');
  });

  it('decodes an escaped key before comparing it', () => {
    expect(scan('{"trace\\u0045vents":[{"n":1}]}').events).toEqual([{ n: 1 }]);
    expect(scan('{"traceEventsX":[{"n":1}]}').state).toBe('noEvents');
  });

  it('accepts whitespace everywhere JSON allows it', () => {
    const text = ' \n\t{ \r\n "traceEvents" \t : \n [ \n { "a" : 1 } \n , \t {"b":[ 1 , 2 ]}\n ] \n } \n';
    expect(scan(text)).toMatchObject({ state: 'done', events: [{ a: 1 }, { b: [1, 2] }] });
  });

  it('skips elements that are not objects, of every kind', () => {
    const text = '[1,-2.5e3,true,false,null,"s{",[{"inner":1}],{"kept":1},{}]';
    expect(scan(text)).toMatchObject({ state: 'done', events: [{ kept: 1 }, {}] });
  });

  it('ignores trailing garbage after the array closes', () => {
    expect(scan('{"traceEvents":[{"n":1}]}garbage{[').events).toEqual([{ n: 1 }]);
    expect(scan('[{"n":1}] ]]] not json').state).toBe('done');
  });

  it.each([
    ['a missing comma', '[{"a":1} {"b":2}]'],
    ['a trailing comma', '[{"a":1},]'],
    ['a leading comma', '[,{"a":1}]'],
    ['an element JSON.parse refuses', '[{"a":}]'],
    ['a mismatched bracket in metadata', '{"m":[1},"traceEvents":[]}'],
    ['a key without a colon', '{"m" 1,"traceEvents":[]}'],
    ['a bad primitive element', '[tru]'],
    ['an empty file', ''],
    ['only whitespace', '  \n '],
  ])('says the trace is not valid JSON for %s', (_label, text) => {
    expect(scan(text).state).toBe('invalid');
  });

  it.each([
    ['a number', '42'],
    ['a string', '"traceEvents"'],
    ['an object without traceEvents', '{"a":[1,2,3]}'],
    ['traceEvents that is not an array', '{"traceEvents":{"a":1}}'],
    ['an empty object', '{}'],
  ])('says there is no traceEvents array for %s', (_label, text) => {
    expect(scan(text).state).toBe('noEvents');
  });

  it('calls a file cut at any point before the array closes not valid JSON', () => {
    const text = '{"metadata":{"a":"\\"}"},"traceEvents":[{"n":"x\\\\"},{"m":[1,2]}]}';
    const close = text.lastIndexOf(']') + 1;
    for (let cut = 0; cut < text.length; cut++) {
      const r = scan(text.slice(0, cut), 3);
      expect(r.state, `cut at ${cut}`).toBe(cut >= close ? 'done' : 'invalid');
    }
  });

  it('handles an element nested 10,000 deep without a stack overflow, and metadata as deep', () => {
    const deep = '['.repeat(10_000) + ']'.repeat(10_000);
    const text = `{"m":${deep},"traceEvents":[{"d":${deep}},{"n":1}]}`;
    const r = scan(text, 7);
    expect(r.state).toBe('done');
    expect(r.events).toHaveLength(2);
    expect(r.events[1]).toEqual({ n: 1 });
  });

  it('reads an 8MB string inside an element', () => {
    const big = 'x'.repeat(8 * 1024 * 1024);
    const r = scan(`[{"s":"${big}"},{"n":1}]`);
    expect(r.events).toHaveLength(2);
    expect((r.events[0].s as string).length).toBe(big.length);
  });

  it('parses an element of exactly the size limit and skips, counts, one byte over', () => {
    const pad = (n: number) => `{"s":"${'x'.repeat(n - 8)}"}`;
    expect(Buffer.byteLength(pad(MAX_EVENT_BYTES))).toBe(MAX_EVENT_BYTES);
    const at = scan(`[${pad(MAX_EVENT_BYTES)},{"n":1}]`);
    expect(at).toMatchObject({ state: 'done', oversized: 0 });
    expect(at.events).toHaveLength(2);
    const over = scan(`[${pad(MAX_EVENT_BYTES + 1)},{"n":1}]`);
    expect(over).toMatchObject({ state: 'done', oversized: 1, events: [{ n: 1 }] });
  });

  it('counts an oversized element made of many chunks without keeping them', () => {
    const r = scan(`[{"s":"${'x'.repeat(100)}"},{"n":1}]`, 7, 50);
    expect(r).toMatchObject({ state: 'done', oversized: 1, events: [{ n: 1 }] });
  });

  it('stops when the callback returns false', () => {
    const scanner = new TraceEventScanner(() => false);
    scanner.write(Buffer.from('[{"a":1},{"b":2}'));
    expect(scanner.state).toBe('stopped');
  });
});

/** A source of the given chunks, counting how many bytes were pulled from it. */
function counted(chunks: Iterable<Buffer>) {
  const seen = { bytes: 0, finished: false };
  async function* gen() {
    try {
      for (const c of chunks) {
        seen.bytes += c.length;
        yield c;
      }
    } finally {
      seen.finished = true;
    }
  }
  return { source: gen(), seen };
}

/** Endless repeats of one block, lazily: nothing this size is ever held. */
function* repeat(head: string, block: string, times = Infinity, tail = '') {
  yield Buffer.from(head);
  const b = Buffer.from(block);
  for (let i = 0; i < times; i++) yield b;
  yield Buffer.from(tail);
}

const options = (extra: Partial<Parameters<typeof scanTraceEvents>[2]> = {}) => ({
  maxBytes: 64 * 1024 * 1024,
  deadline: Infinity,
  ...extra,
});

describe('scanTraceEvents', () => {
  const EVENT = '{"name":"RunTask","ph":"X","ts":1,"dur":2,"pid":1,"tid":2},';

  it('reads a whole source and reports how many events and bytes it saw', async () => {
    const { source, seen } = counted(repeat('{"traceEvents":[', EVENT, 1000, '{"n":1}]}'));
    let n = 0;
    const r = await scanTraceEvents(source, () => { n++; }, options());
    // bytes ends at the array's closing bracket: the final } is not read.
    expect(r).toEqual({ end: 'done', events: 1001, bytes: seen.bytes - 1, oversized: 0 });
    expect(n).toBe(1001);
    expect(seen.finished).toBe(true);
  });

  it('stops pulling a 1GB stream at the byte cap', async () => {
    // 1GB if read whole: 16M events of 64 bytes.
    const { source, seen } = counted(repeat('[', EVENT.repeat(1000), 16_000));
    const started = Date.now();
    const r = await scanTraceEvents(source, () => {}, options({ maxBytes: 8 * 1024 * 1024 }));
    expect(r).toEqual({ end: 'tooBig' });
    expect(seen.bytes).toBeLessThanOrEqual(8 * 1024 * 1024 + 64 * 1000);
    expect(seen.finished).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('stops a stream that never ends at the byte cap', async () => {
    const { source, seen } = counted(repeat('[', ' '.repeat(4096)));
    expect(await scanTraceEvents(source, () => {}, options({ maxBytes: 1024 * 1024 }))).toEqual({ end: 'tooBig' });
    expect(seen.finished).toBe(true);
  });

  it('accepts a source whose array closes exactly at the cap, even with more bytes after it', async () => {
    const text = '[{"a":1}]';
    const { source } = counted([Buffer.from(text + '   garbage')]);
    expect(await scanTraceEvents(source, () => {}, options({ maxBytes: text.length }))).toMatchObject({ end: 'done', events: 1 });
    const { source: short } = counted([Buffer.from(text)]);
    expect(await scanTraceEvents(short, () => {}, options({ maxBytes: text.length - 1 }))).toEqual({ end: 'tooBig' });
  });

  it('stops at the deadline on its clock', async () => {
    let t = 0;
    const { source, seen } = counted(repeat('[', EVENT.repeat(100)));
    const r = await scanTraceEvents(source, () => {}, options({ deadline: 50, now: () => (t += 1) }));
    expect(r).toEqual({ end: 'timeout' });
    expect(seen.finished).toBe(true);
    expect(t).toBeLessThan(200);
  });

  it('stops at the deadline when the source stalls without data', async () => {
    async function* stalled() {
      yield Buffer.from('[');
      await new Promise(() => {});
    }
    const started = Date.now();
    const r = await scanTraceEvents(stalled(), () => {}, options({ deadline: Date.now() + 100 }));
    expect(r).toEqual({ end: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('yields to the event loop about once per yieldBytes, so other work runs during a long scan', async () => {
    const tick = vi.fn(() => new Promise<void>((r) => setImmediate(r)));
    const { source } = counted(repeat('[', EVENT.repeat(1000), 80, '{}]')); // about 5MB
    let ran = false;
    setImmediate(() => { ran = true; });
    let ranBeforeEnd = false;
    const r = await scanTraceEvents(source, () => { if (ran) ranBeforeEnd = true; }, options({ tick, yieldBytes: 1024 * 1024 }));
    expect(r).toMatchObject({ end: 'done' });
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(tick.mock.calls.length).toBeLessThanOrEqual(6);
    expect(ranBeforeEnd).toBe(true);
  });

  it('passes on what the callback stops', async () => {
    const { source, seen } = counted(repeat('[', EVENT, Infinity));
    let n = 0;
    expect(await scanTraceEvents(source, () => ++n < 10, options())).toEqual({ end: 'stopped' });
    expect(n).toBe(10);
    expect(seen.finished).toBe(true);
  });

  it.each([
    ['[{"a":1}', 'invalid'],
    ['{"a":1}', 'noEvents'],
  ] as const)('ends %s as %s', async (text, end) => {
    const { source } = counted([Buffer.from(text)]);
    expect(await scanTraceEvents(source, () => {}, options())).toEqual({ end } satisfies ScanResult);
  });

  it('throws what the source throws', async () => {
    async function* broken() {
      yield Buffer.from('[');
      throw new Error('disk gone');
    }
    await expect(scanTraceEvents(broken(), () => {}, options())).rejects.toThrow('disk gone');
  });
});
