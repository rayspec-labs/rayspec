/**
 * The section-aware parse — a top-level section an extension pack CLAIMS.
 *
 * The load is the pre-shape pipeline `parseSpec` already runs (YAML safe-load → version check →
 * reserved-document-key scan), shared verbatim. The lift takes every CLAIMED top-level key out of the
 * loaded document, parses the REMAINDER with the core grammar — so a key no pack claimed still meets
 * the unchanged `.strict()` top level and is refused exactly as today — and hands each lifted node to
 * the claiming pack's own validator.
 *
 * FAIL-THE-FIX, case by case: the lift is bounded to claimed keys (an unclaimed key is still
 * `unknown_field`, same message, same path), a claimed key never reaches the core grammar and never
 * lands in the validated `RaySpec`, a rejected section body is reported UNDER the section key, a
 * claim on a key a document grammar owns cannot take that key away from the grammar, and a validator
 * that fails to produce a verdict — by throwing, by answering with a non-verdict, or by refusing with
 * an issue that maps to nothing — REFUSES its section rather than escaping or being waved through.
 *
 * The corpus-wide "a document with no packs parses byte-identically" control is its own file
 * (`sections-accept-control.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RaySpec } from './grammar.js';
import { parseSpec } from './parse.js';
import { ProductSpec } from './product-grammar.js';
import {
  CORE_TOP_LEVEL_KEYS,
  parseSpecWithSections,
  readExtensionRefs,
  type SectionClaim,
  sectionValidatorFrom,
} from './sections.js';

/** A minimal valid backend document; each case appends exactly one top-level key to it. */
const BASE = `
version: '1.0'
metadata:
  name: base
`;

/** The pack-side grammar a claim carries in these tests (strict, like every core grammar level). */
const PackSection = z
  .object({ retentionDays: z.number().int().positive(), label: z.string().default('none') })
  .strict();

/** A validator that accepts anything — used where the point is what is NOT handed to it. */
const PassEverything = z.unknown();

/** One claim, built the way the loader builds it: a key, the pack that owns it, its validator. */
function claim(key: string, packId: string, schema: z.ZodType = PackSection): SectionClaim {
  return { key, packId, validate: sectionValidatorFrom(schema, key, packId) };
}

describe('a claimed top-level section is validated by the claiming pack', () => {
  it('parses, and the validated node is returned under its key', () => {
    const res = parseSpecWithSections(`${BASE}acme_notes:\n  retentionDays: 30\n`, [
      claim('acme_notes', 'acme-notes'),
    ]);
    if (!res.ok) throw new Error(`expected a clean parse:\n${JSON.stringify(res.errors, null, 2)}`);
    // The pack's own defaults are applied by the pack's own grammar, not by core.
    expect(res.value.sections).toEqual({ acme_notes: { retentionDays: 30, label: 'none' } });
  });

  it('the claimed key never reaches the core grammar — it is absent from the validated document', () => {
    const res = parseSpecWithSections(`${BASE}acme_notes:\n  retentionDays: 30\n`, [
      claim('acme_notes', 'acme-notes'),
    ]);
    if (!res.ok) throw new Error(`expected a clean parse:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(Object.hasOwn(res.value.spec, 'acme_notes')).toBe(false);
    // …and the rest of the document is the document `parseSpec` would have produced.
    const plain = parseSpec(BASE);
    if (!plain.ok) throw new Error('the base document must parse');
    expect(res.value.spec).toEqual(plain.value);
  });

  it('a section body the pack refuses is reported UNDER the section key', () => {
    const res = parseSpecWithSections(`${BASE}acme_notes:\n  retentionDays: -1\n`, [
      claim('acme_notes', 'acme-notes'),
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.code).toBe('schema_violation');
    expect(res.errors[0]?.path).toBe('acme_notes.retentionDays');
  });

  it("a pack grammar's own unknown-key rejection lands as `unknown_field` under the section key", () => {
    const res = parseSpecWithSections(`${BASE}acme_notes:\n  retentionDays: 30\n  bogus: 1\n`, [
      claim('acme_notes', 'acme-notes'),
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toEqual([
      {
        code: 'unknown_field',
        message: "unknown field 'bogus' (unknown keys are rejected)",
        path: 'acme_notes.bogus',
      },
    ]);
  });

  it('a claimed key that the document does not carry is simply absent (no default, no error)', () => {
    const res = parseSpecWithSections(BASE, [claim('acme_notes', 'acme-notes')]);
    if (!res.ok) throw new Error(`expected a clean parse:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(res.value.sections).toEqual({});
  });
});

describe('the lift is bounded — everything else meets the unchanged strict top level', () => {
  it('an UNCLAIMED top-level key is refused exactly as today (same code, message and path)', () => {
    const yaml = `${BASE}not_claimed:\n  a: 1\n`;
    const withSections = parseSpecWithSections(yaml, [claim('acme_notes', 'acme-notes')]);
    const today = parseSpec(yaml);
    expect(withSections.ok).toBe(false);
    expect(today.ok).toBe(false);
    if (withSections.ok || today.ok) return;
    expect(withSections.errors).toEqual(today.errors);
  });

  it('one claimed and one unclaimed key: the claimed one is validated, the other still refused', () => {
    const res = parseSpecWithSections(`${BASE}acme_notes:\n  retentionDays: 30\nnot_claimed: 1\n`, [
      claim('acme_notes', 'acme-notes'),
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toEqual([
      {
        code: 'unknown_field',
        message: "unknown field 'not_claimed' (unknown keys are rejected)",
        path: 'not_claimed',
      },
    ]);
  });

  it('a claim on a key the CORE grammar owns cannot take that key away from the grammar', () => {
    // Defence in depth: the loader refuses such a claim (naming the pack), so this can only be
    // reached by a claim list built in code. The core grammar wins — `stores` is parsed by core.
    const yaml = `${BASE}stores:\n  - name: widgets\n    columns:\n      - { name: label, type: text }\n`;
    const res = parseSpecWithSections(yaml, [claim('stores', 'acme-notes')]);
    if (!res.ok) throw new Error(`expected a clean parse:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(res.value.spec.stores).toHaveLength(1);
    expect(res.value.spec.stores[0]?.name).toBe('widgets');
    expect(res.value.sections).toEqual({});
  });
});

describe('the core top-level key list is DERIVED from the grammars, never re-listed', () => {
  it('is exactly the union of the two document profiles’ shape keys', () => {
    const union = [...new Set([...Object.keys(RaySpec.shape), ...Object.keys(ProductSpec.shape)])];
    expect([...CORE_TOP_LEVEL_KEYS].sort()).toEqual(union.sort());
  });

  it('carries the keys a claim must never be allowed to take', () => {
    for (const key of ['version', 'metadata', 'stores', 'api', 'extensions', 'managed']) {
      expect(CORE_TOP_LEVEL_KEYS).toContain(key);
    }
  });

  // `detectSpecKind` routes on `product` alone, and `validateAnySpec` — the entry doctor/plan/deploy
  // reach — dispatches on its verdict. A pack that could claim `product` would therefore hand a
  // backend document to the product parser, and the pack's own section would never be validated by
  // its owner. The product profile's other sections are denied for the same reason: they belong to a
  // grammar, so they are not a pack's to own.
  it('denies the product profile’s keys too — `product` is the profile discriminant', () => {
    for (const key of ['product', 'views', 'capabilities', 'artifacts', 'contracts', 'workflows']) {
      expect(CORE_TOP_LEVEL_KEYS).toContain(key);
    }
  });

  it('a claim on `product` cannot lift it away from the document grammars', () => {
    const yaml = `${BASE}product:\n  retentionDays: 30\n`;
    const res = parseSpecWithSections(yaml, [claim('product', 'acme-notes', PassEverything)]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // Refused by the backend grammar exactly as it is without any claim — never lifted, never
    // validated by the pack, and never left in a document a profile detector would re-classify.
    expect(res.errors).toEqual(parseSpec(yaml).ok ? [] : parseSpec(yaml).errors);
    expect(res.errors.map((e) => e.path)).toContain('product');
  });
});

/**
 * THE FAIL-CLOSED ENVELOPE around foreign code. A claim's validator is the default export of a
 * module loaded out of a pack directory, admitted on the structural evidence that it has a
 * `safeParse` method. Each case below is a way that evidence is not enough — and each must end as a
 * REFUSED section, never as an exception out of the parse and never as an accepted document.
 */
describe('a validator that does not produce a verdict refuses its section', () => {
  const YAML = `${BASE}acme_notes:\n  retentionDays: 30\n`;

  /** Drive one hand-written schema module through the full parse and return the result. */
  function withSchema(schema: unknown): ReturnType<typeof parseSpecWithSections> {
    return parseSpecWithSections(YAML, [
      {
        key: 'acme_notes',
        packId: 'acme-notes',
        validate: sectionValidatorFrom(schema as never, 'acme_notes', 'acme-notes'),
      },
    ]);
  }

  it('a `safeParse` that THROWS is a refusal, not an exception out of the parse', () => {
    const res = withSchema({
      safeParse() {
        throw new TypeError('the pack validator blew up');
      },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.code).toBe('schema_violation');
    expect(res.errors[0]?.path).toBe('acme_notes');
    expect(res.errors[0]?.message).toContain("extension pack 'acme-notes'");
    expect(res.errors[0]?.message).toContain('threw');
  });

  it('a `safeParse` that throws on a null body refuses that section rather than crashing', () => {
    const res = parseSpecWithSections(`${BASE}acme_notes:\n`, [
      {
        key: 'acme_notes',
        packId: 'acme-notes',
        validate: sectionValidatorFrom(
          {
            safeParse: (value: unknown) => ({
              success: true,
              data: (value as { retentionDays: number }).retentionDays,
            }),
          } as never,
          'acme_notes',
          'acme-notes',
        ),
      },
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors[0]?.code).toBe('schema_violation');
    expect(res.errors[0]?.path).toBe('acme_notes');
  });

  it.each([
    ['undefined', () => undefined],
    ['null', () => null],
    ['a string', () => 'yes'],
    ['an object with no `success`', () => ({ data: 1 })],
  ])('a `safeParse` that returns %s is a refusal', (_label, safeParse) => {
    const res = withSchema({ safeParse });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors[0]?.code).toBe('schema_violation');
    expect(res.errors[0]?.path).toBe('acme_notes');
    expect(res.errors[0]?.message).toContain("extension pack 'acme-notes'");
  });

  // The fail-OPEN shape: `issueToSpecErrors` fans an `unrecognized_keys` issue out over `keys`, so an
  // issue of that code carrying none maps to ZERO SpecErrors. A rejection that costs no error would
  // leave the section out of `sections` with nothing in the error list — an `ok:true` parse of a
  // document its owning pack rejected.
  it.each([
    ['no `keys` field', { code: 'unrecognized_keys', path: [], message: "unknown key 'bogus'" }],
    ['an empty `keys`', { code: 'unrecognized_keys', path: [], keys: [], message: 'nope' }],
  ])('a rejection whose issues map to NO error still refuses the document: %s', (_label, issue) => {
    const res = withSchema({ safeParse: () => ({ success: false, error: { issues: [issue] } }) });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.path).toBe('acme_notes');
    // The rejection's own sentence is carried through, so the refusal is never silent.
    expect(res.errors[0]?.message.length).toBeGreaterThan(0);
  });

  it('a hand-built claim that throws is refused too (the envelope is not only for pack modules)', () => {
    const res = parseSpecWithSections(YAML, [
      {
        key: 'acme_notes',
        packId: 'acme-notes',
        validate: () => {
          throw new Error('hand-built claim blew up');
        },
      },
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors[0]?.code).toBe('schema_violation');
    expect(res.errors[0]?.message).toContain('hand-built claim blew up');
  });

  it('a hand-built claim that refuses with an EMPTY error list still fails the parse', () => {
    const res = parseSpecWithSections(YAML, [
      { key: 'acme_notes', packId: 'acme-notes', validate: () => ({ ok: false, errors: [] }) },
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.path).toBe('acme_notes');
  });
});

describe('`readExtensionRefs` reports a malformed `extensions[]` instead of reading none', () => {
  it('an EXACT-pin violation comes back as the grammar’s own error, pathed at the entry', () => {
    const loaded = {
      version: '1.0',
      metadata: { name: 'base' },
      extensions: [{ id: 'acme-notes', module: './pack', version: '^1.0.0' }],
    };
    const res = readExtensionRefs(loaded);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // Byte-identical to what the strict shape parse reports for the same entry — one implementation.
    const viaCoreParse = parseSpec(
      `${BASE}extensions:\n  - id: acme-notes\n    module: ./pack\n    version: '^1.0.0'\n`,
    );
    expect(viaCoreParse.ok).toBe(false);
    if (viaCoreParse.ok) return;
    expect(res.errors).toEqual(viaCoreParse.errors);
  });

  it('an absent or well-formed `extensions[]` reads as refs', () => {
    const none = readExtensionRefs({ version: '1.0' });
    expect(none.ok && none.value).toEqual([]);
    const one = readExtensionRefs({
      extensions: [{ id: 'acme-notes', module: './pack', version: '1.0.0' }],
    });
    expect(one.ok && one.value.map((r) => r.id)).toEqual(['acme-notes']);
  });
});
