/**
 * Hostile input: the validators return a code from the closed vocabulary for anything they are
 * given, never throw, never pollute a prototype and never echo document content.
 */
import { describe, expect, it } from 'vitest';
import { canonicalJsonFile } from './canonical-json.js';
import { ERROR_CODES, isBundleErrorCode } from './errors.js';
import { schemaValidator } from './schemas.js';
import { loadExpectations } from './test-support/contract-files.js';
import { validateManifest, validateReceipt, validateSnapshot } from './validate.js';

const expectations = loadExpectations();
const baseText = canonicalJsonFile(expectations.bases.application.manifest);
const enc = (s: string) => new TextEncoder().encode(s);
const VALIDATORS = { validateManifest, validateSnapshot, validateReceipt };

type Outcome =
  | { ok: true }
  | { ok: false; errors: { code: string; reason?: string; message: string }[] };
const outcome = (r: Outcome) =>
  r.ok ? 'ok' : { code: r.errors[0]!.code, reason: r.errors[0]!.reason };

/** Insert a member into the canonical base text right after the opening brace. */
const withLeadingMember = (member: string) => `{${member},${baseText.slice(1)}`;

/** The canonical base manifest with one more own top-level member, in sorted position. */
const withMember = (key: string, value: unknown) => {
  const m = JSON.parse(baseText) as Record<string, unknown>;
  Object.defineProperty(m, key, { value, enumerable: true, writable: true, configurable: true });
  return canonicalJsonFile(m);
};

describe('hostile nesting', () => {
  it.each(
    Object.entries(VALIDATORS),
  )('%s refuses 100,000 nested arrays as json-depth', (_n, validate) => {
    expect(outcome(validate('['.repeat(100_000) + ']'.repeat(100_000)))).toEqual({
      code: 'RAY_LIMIT_EXCEEDED',
      reason: 'json-depth',
    });
  });

  it('refuses deep objects inside an otherwise valid manifest', () => {
    const deep = `${'{"a":'.repeat(70)}1${'}'.repeat(70)}`;
    expect(outcome(validateManifest(withLeadingMember(`"a":${deep}`)))).toEqual({
      code: 'RAY_LIMIT_EXCEEDED',
      reason: 'json-depth',
    });
  });

  it('refuses unbalanced openers without recursing', () => {
    expect(outcome(validateManifest('{"a":'.repeat(200_000)))).toMatchObject({
      reason: 'json-depth',
    });
  });
});

describe('hostile sizes', () => {
  it('refuses a manifest above 1 MiB before parsing it', () => {
    const huge = withLeadingMember(`"a":"${'x'.repeat(1024 * 1024)}"`);
    expect(outcome(validateManifest(huge))).toEqual({
      code: 'RAY_LIMIT_EXCEEDED',
      reason: 'manifest-size',
    });
  });

  it('refuses a long string under the limit by schema, without echoing it', () => {
    const secret = 'S3CR3T'.repeat(100_000);
    const text = baseText.replace(
      '"bindings":[]',
      `"bindings":[{"description":"${secret}","kind":"secret","name":"A","required":true}]`,
    );
    const r = validateManifest(text);
    expect(outcome(r)).toEqual({ code: 'RAY_MANIFEST_INVALID', reason: 'schema' });
    expect(JSON.stringify(r)).not.toContain('S3CR3T');
  });

  it('keeps a hostile member name out of an overlong error path', () => {
    const r = validateManifest(withMember(`k${'x'.repeat(10_000)}`, 1));
    expect(outcome(r)).toEqual({ code: 'RAY_MANIFEST_INVALID', reason: 'schema' });
    if (!r.ok) {
      expect(r.errors[0]!.path).toBe('');
      expect(r.errors[0]!.message.length).toBeLessThan(200);
    }
  });

  it('a limit set above its default is a usage error, not an exception', () => {
    expect(outcome(validateManifest(baseText, { limits: { manifestBytes: 2 ** 40 } }))).toEqual({
      code: 'RAY_USAGE',
      reason: undefined,
    });
  });
});

describe('hostile member names', () => {
  /** Every character a terminal shows as itself: no control, escape or bidirectional character. */
  const PRINTABLE = /^[\x20-\x7e]*$/;
  const TERMINAL = '\u001b]0;pwn\u0007\u001b[2J';
  const BIDI = '\u202egnp.exe';

  it.each([
    ['a terminal escape at the root', withMember(`${TERMINAL}${'K'.repeat(100)}`, 1), ''],
    ['a bidirectional override at the root', withMember(BIDI, 1), ''],
    [
      'a terminal escape inside a binding',
      baseText.replace(
        '"bindings":[]',
        // The escape sorts before every letter, so canonical order puts it first.
        `"bindings":[{${JSON.stringify(`${TERMINAL}K`)}:1,"description":"x","kind":"secret","name":"A","required":true}]`,
      ),
      '/bindings/0',
    ],
    [
      'a bidirectional override inside a binding',
      baseText.replace(
        '"bindings":[]',
        `"bindings":[{"description":"x","kind":"secret","name":"A","required":true,${JSON.stringify(BIDI)}:1}]`,
      ),
      '/bindings/0',
    ],
  ])('keeps %s out of the message and the path', (_label, text, parent) => {
    const r = validateManifest(text);
    expect(outcome(r)).toEqual({ code: 'RAY_MANIFEST_INVALID', reason: 'schema' });
    if (r.ok) return;
    const [error] = r.errors;
    expect(error!.path).toBe(parent);
    expect(error!.message).toMatch(PRINTABLE);
    expect(error!.message).not.toContain('pwn');
    expect(error!.message).not.toContain('gnp');
  });

  it('reports a short printable member name in the path only', () => {
    const r = validateManifest(withMember('extraMember', 1));
    expect(r.ok ? 'ok' : { path: r.errors[0]!.path, message: r.errors[0]!.message }).toEqual({
      path: '/extraMember',
      message: 'ray.json fails its JSON Schema (additionalProperties)',
    });
  });

  it('a long member name gives a result that fits the result envelope', () => {
    // 3,000 characters: under the old pointer cap, over the envelope's message limit.
    const r = validateManifest(withMember(`k${'x'.repeat(2999)}`, 1));
    expect(outcome(r)).toEqual({ code: 'RAY_MANIFEST_INVALID', reason: 'schema' });
    if (r.ok) return;
    const envelope = {
      contractVersion: '1.0.0-draft.2',
      ok: false,
      operation: 'bundle.verify',
      operationId: '00000000-0000-4000-8000-000000000000',
      data: null,
      errors: r.errors,
      warnings: [],
    };
    const validate = schemaValidator('resultEnvelope');
    expect(validate(envelope), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('prototype-polluting keys', () => {
  it.each([
    ['__proto__', { polluted: true }],
    ['constructor', { prototype: { polluted: true } }],
    ['prototype', { polluted: true }],
  ])('a top-level %s member is an unknown member, and nothing is polluted', (key, value) => {
    const r = validateManifest(withMember(key, value));
    expect(r.ok ? 'ok' : { reason: r.errors[0]!.reason, path: r.errors[0]!.path }).toEqual({
      reason: 'schema',
      path: `/${key}`,
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('a nested __proto__ member is refused by the closed schema', () => {
    const text = baseText.replace(
      '"application":{',
      '"application":{"__proto__":{"polluted":true},',
    );
    const r = validateManifest(text);
    expect(r.ok ? 'ok' : r.errors[0]!.path).toBe('/application/__proto__');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('a __proto__ binding name is refused by its pattern', () => {
    const text = baseText.replace(
      '"bindings":[]',
      '"bindings":[{"description":"x","kind":"secret","name":"__proto__","required":true}]',
    );
    expect(outcome(validateManifest(text))).toEqual({
      code: 'RAY_MANIFEST_INVALID',
      reason: 'schema',
    });
  });
});

describe('non-canonical values', () => {
  it.each([
    ['a non-NFC value', '"description":"café"', 'non-nfc'],
    ['a non-NFC key', '"café":1', 'non-nfc'],
    ['a float', '"a":1.5', 'float'],
    ['an exponent', '"a":1E+2', 'float'],
    ['-0', '"a":-0', 'not-canonical'],
    ['2^60', '"a":1152921504606846976', 'not-canonical'],
    ['a lone surrogate escape', '"a":"\\udc00"', 'not-canonical'],
    ['a duplicate key', '"a":1,"a":1', 'duplicate-key'],
  ])('refuses %s with the stated reason', (_label, member, reason) => {
    expect(outcome(validateManifest(withLeadingMember(member)))).toEqual({
      code: 'RAY_MANIFEST_INVALID',
      reason,
    });
  });

  it('refuses text holding a lone surrogate instead of silently replacing it', () => {
    const text = baseText.replace('format-fixture', 'format-fixture\uD800');
    expect(outcome(validateManifest(text))).toEqual({
      code: 'RAY_MANIFEST_INVALID',
      reason: 'invalid-utf8',
    });
  });
});

// biome-ignore lint/suspicious/noExplicitAny: variants edit the parsed base manifest member by member.
type Loose = Record<string, any>;

describe('duplicate names', () => {
  const manifest = expectations.bases.application.manifest as Record<string, unknown>;
  const variant = (change: (m: Loose) => void) => {
    const m = structuredClone(manifest) as Loose;
    change(m);
    return canonicalJsonFile(m);
  };

  it.each([
    ['a repeated capability', (m: Loose) => m.requires.push('static-frontend'), 'schema'],
    [
      'a repeated egress host',
      (m: Loose) => (m.permissions.egressHosts = ['a.example.com', 'a.example.com']),
      'schema',
    ],
    [
      'a repeated binding',
      (m: Loose) =>
        (m.bindings = [
          { name: 'A_B', kind: 'secret', required: true, description: 'x' },
          { name: 'A_B', kind: 'config', required: false, description: 'y' },
        ]),
      'binding-duplicate',
    ],
    [
      'a repeated inventory path',
      (m: Loose) => m.inventory.push(m.inventory[3]),
      'inventory-duplicate',
    ],
  ])('refuses %s', (_label, change, reason) => {
    expect(outcome(validateManifest(variant(change)))).toEqual({
      code: 'RAY_MANIFEST_INVALID',
      reason,
    });
  });
});

describe('anything at all', () => {
  it.each(
    Object.entries(VALIDATORS),
  )('%s answers a non-document without throwing', (_n, validate) => {
    for (const input of [undefined, null, 1, {}, [], new ArrayBuffer(4), Symbol('x')]) {
      const r = validate(input as unknown as string);
      expect(r.ok).toBe(false);
      expect(outcome(r)).toEqual({ code: 'RAY_MANIFEST_INVALID', reason: 'invalid-json' });
    }
  });

  it.each(
    Object.entries(VALIDATORS),
  )('%s answers null options as no options, without throwing', (_n, validate) => {
    const text = baseText;
    const call = validate as (input: string, options: unknown) => unknown;
    expect(() => call(text, null)).not.toThrow();
    expect(call(text, null)).toEqual(call(text, {}));
  });

  it('reports an option that throws when read as an internal error', () => {
    const options = {
      get archiveSize(): number {
        throw new Error('boom');
      },
    };
    expect(outcome(validateManifest(baseText, options))).toEqual({
      code: 'RAY_INTERNAL',
      reason: undefined,
    });
  });

  it.each(
    Object.entries(VALIDATORS),
  )('%s answers every mutation of a valid document with a vocabulary code', (_n, validate) => {
    // A seeded generator, so a failure reproduces.
    let seed = 0x2545f491;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    const source = enc(baseText);
    for (let i = 0; i < 2000; i++) {
      const bytes = Uint8Array.from(source);
      const edits = 1 + Math.floor(next() * 4);
      for (let k = 0; k < edits; k++)
        bytes[Math.floor(next() * bytes.length)] = Math.floor(next() * 256);
      const r = validate(
        bytes.subarray(
          0,
          Math.floor(next() * 4) === 0 ? Math.floor(next() * bytes.length) : bytes.length,
        ),
      );
      if (r.ok) continue;
      const [error] = r.errors;
      expect(isBundleErrorCode(error!.code)).toBe(true);
      expect(error!.code).not.toBe('RAY_INTERNAL');
      const reasons = ERROR_CODES[error!.code as keyof typeof ERROR_CODES]
        .reasons as readonly string[];
      if (error!.reason !== undefined) expect(reasons).toContain(error!.reason);
    }
  });
});
