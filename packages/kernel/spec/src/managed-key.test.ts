/**
 * The reserved `managed:` top-level key — accepted and carried verbatim.
 *
 * The top level of the document grammar is `.strict()`, so every key it does not name is a parse
 * error. `managed:` is the one exception the grammar OWNER reserves for itself: it parses, and it
 * survives into the validated document unchanged. These tests pin those two facts at the parse
 * boundary, plus the two properties the reservation must not cost — a document that omits the key
 * still parses without it (no default is invented), and every OTHER unknown top-level key is refused
 * exactly as before.
 *
 * The THIRD fact — that carrying the key changes no runtime behaviour — cannot be pinned from this
 * package, which sits below every consumer. It is pinned where the one predicate that enumerates
 * top-level keys lives: `static-profile.test.ts` and `boot-env-demands.test.ts` in `@rayspec/server`
 * assert that a frontend-only document carrying `managed:` is still a static profile and still
 * demands none of the three platform secrets.
 */
import { describe, expect, it } from 'vitest';
import { parseSpec } from './parse.js';

/** A minimal document: the two required sections and nothing else. */
const MINIMAL = `
version: '1.0'
metadata:
  name: reserved-key
`;

/** Parse, or fail the test with the aggregated errors rather than a bare `undefined` further down. */
function parseOk(yaml: string) {
  const res = parseSpec(yaml);
  if (!res.ok) throw new Error(`expected a clean parse:\n${JSON.stringify(res.errors, null, 2)}`);
  return res.value;
}

describe('the reserved `managed:` top-level key', () => {
  it('parses, and carries its contents through unchanged', () => {
    const value = parseOk(
      `${MINIMAL}managed:\n  owner: platform\n  nested:\n    list: [1, 2]\n    flag: true\n`,
    );
    expect(value.managed).toEqual({ owner: 'platform', nested: { list: [1, 2], flag: true } });
  });

  it('accepts an empty mapping (the key present with nothing under it)', () => {
    expect(parseOk(`${MINIMAL}managed: {}\n`).managed).toEqual({});
  });

  it('is absent — not defaulted — when the document omits it', () => {
    const value = parseOk(MINIMAL);
    expect(value.managed).toBeUndefined();
    expect(Object.hasOwn(value, 'managed')).toBe(false);
  });

  it('must be a mapping: a scalar is a schema_violation, not a silent pass', () => {
    const res = parseSpec(`${MINIMAL}managed: nope\n`);
    expect(res.ok).toBe(false);
    if (res.ok) return; // narrow
    expect(res.errors.map((e) => e.code)).toContain('schema_violation');
  });

  it('buys no general passthrough: another unknown top-level key is still rejected', () => {
    const res = parseSpec(`${MINIMAL}managed:\n  owner: platform\nbogusSection: []\n`);
    expect(res.ok).toBe(false);
    if (res.ok) return; // narrow
    expect(res.errors.map((e) => e.code)).toContain('unknown_field');
  });
});
