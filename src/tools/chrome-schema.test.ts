import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { ProfileInput, ScrollInput, TraceInput, chromeTool } from './chrome.js';

// zod is the contract; the JSON schema is what a client sees first. Where both state a bound, they must agree.

/** The schema under optional(), default() and refine(). */
function base(t: ZodTypeAny): ZodTypeAny {
  let cur = t as ZodTypeAny & { _def: { innerType?: ZodTypeAny; schema?: ZodTypeAny } };
  for (;;) {
    const next = cur._def.innerType ?? cur._def.schema;
    if (!next) return cur;
    cur = next as typeof cur;
  }
}

interface JsonProp {
  type?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  enum?: string[];
  items?: JsonProp;
  properties?: Record<string, JsonProp>;
  required?: string[];
}

const props = (chromeTool.inputSchema as { properties: Record<string, JsonProp> }).properties;

function expectNumberParity(zod: ZodTypeAny, json: JsonProp | undefined, name: string) {
  const checks = (base(zod)._def as { checks: { kind: string; value?: number; inclusive?: boolean }[] }).checks;
  const min = checks.find((c) => c.kind === 'min');
  const max = checks.find((c) => c.kind === 'max');
  // Every field checked here has both bounds in zod; without them the comparison would pass for free.
  expect(min && max, `${name} has a zod min and max`).toBeTruthy();
  const expected: Record<string, unknown> = { name, type: checks.some((c) => c.kind === 'int') ? 'integer' : 'number' };
  expected[min!.inclusive ? 'minimum' : 'exclusiveMinimum'] = min!.value;
  expected[max!.inclusive ? 'maximum' : 'exclusiveMaximum'] = max!.value;
  const j = json as Record<string, unknown> | undefined;
  expect(j, name).toBeDefined();
  const actual: Record<string, unknown> = { name, type: j!.type };
  for (const k of ['minimum', 'exclusiveMinimum', 'maximum', 'exclusiveMaximum']) if (j![k] !== undefined) actual[k] = j![k];
  expect(actual).toEqual(expected);
}

const scrollShape = ScrollInput.shape;
const numericScrollFields = ['distance', 'speed', 'repeat', 'repeatDelayMs'] as const;

describe('chrome JSON schema matches the zod bounds', () => {
  it('profile durationMs', () => {
    expectNumberParity(ProfileInput.shape.durationMs, props.durationMs, 'durationMs');
  });

  it.each(numericScrollFields)('scroll field %s, at the top level and inside profile.scroll', (field) => {
    expectNumberParity(scrollShape[field], props[field], field);
    expectNumberParity(scrollShape[field], props.scroll?.properties?.[field], `scroll.${field}`);
  });

  it('profile.scroll lists every scroll field, requires distance, and keeps the source enum', () => {
    const nested = props.scroll!;
    expect(Object.keys(nested.properties ?? {}).sort()).toEqual(Object.keys(scrollShape).filter((k) => k !== 'method').sort());
    expect(nested.required).toEqual(['distance']);
    expect(nested.properties!.source.enum).toEqual(base(scrollShape.source)._def.values);
  });

  it('outPath lengths', () => {
    const s = base(TraceInput.shape.outPath) as unknown as { minLength: number | null; maxLength: number | null };
    expect({ minLength: props.outPath.minLength, maxLength: props.outPath.maxLength }).toEqual({
      minLength: s.minLength,
      maxLength: s.maxLength,
    });
  });

  it('categories counts and item length', () => {
    const a = base(TraceInput.shape.categories) as unknown as {
      _def: { minLength: { value: number } | null; maxLength: { value: number } | null; type: ZodTypeAny };
    };
    const item = base(a._def.type) as unknown as { maxLength: number | null };
    expect({
      minItems: props.categories.minItems,
      maxItems: props.categories.maxItems,
      itemMax: props.categories.items?.maxLength,
    }).toEqual({ minItems: a._def.minLength?.value, maxItems: a._def.maxLength?.value, itemMax: item.maxLength });
  });

  it('says that action is required for trace', () => {
    expect((props.action as { description?: string }).description).toMatch(/required when method is trace/);
  });
});
