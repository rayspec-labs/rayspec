/**
 * The two-phase parse — a top-level section an extension pack CLAIMS.
 *
 * Phase A is the pre-shape pipeline `parseSpec` already runs (YAML safe-load → version check →
 * reserved-document-key scan), shared verbatim. Phase B lifts every CLAIMED top-level key out of the
 * loaded document, parses the REMAINDER with the core grammar — so a key no pack claimed still meets
 * the unchanged `.strict()` top level and is refused exactly as today — and hands each lifted node to
 * the claiming pack's own validator.
 *
 * FAIL-THE-FIX, case by case: the lift is bounded to claimed keys (an unclaimed key is still
 * `unknown_field`, same message, same path), a claimed key never reaches the core grammar and never
 * lands in the validated `RaySpec`, a rejected section body is reported UNDER the section key, and a
 * claim on a key the core grammar owns cannot take that key away from the grammar.
 *
 * The corpus-wide "a document with no packs parses byte-identically" control is its own file
 * (`sections-accept-control.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RaySpec } from './grammar.js';
import { parseSpec } from './parse.js';
import {
  CORE_TOP_LEVEL_KEYS,
  parseSpecWithSections,
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

/** One claim, built the way the loader builds it: a key, the pack that owns it, its validator. */
function claim(key: string, packId: string, schema = PackSection): SectionClaim {
  return { key, packId, validate: sectionValidatorFrom(schema, key) };
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

describe('the core top-level key list is DERIVED from the grammar, never re-listed', () => {
  it('is exactly the RaySpec shape keys', () => {
    expect([...CORE_TOP_LEVEL_KEYS].sort()).toEqual(Object.keys(RaySpec.shape).sort());
  });

  it('carries the keys a claim must never be allowed to take', () => {
    for (const key of ['version', 'metadata', 'stores', 'api', 'extensions', 'managed']) {
      expect(CORE_TOP_LEVEL_KEYS).toContain(key);
    }
  });
});
