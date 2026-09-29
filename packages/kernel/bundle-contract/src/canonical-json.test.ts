/**
 * Canonical JSON: exact output vectors, every refused value, and the strict parser's reasons and
 * their order.
 */
import { describe, expect, it } from 'vitest';
import {
  CanonicalJsonError,
  canonicalJson,
  canonicalJsonFile,
  compareCodePoints,
  MAX_JSON_DEPTH,
  parseJsonDocument,
} from './canonical-json.js';

const enc = (s: string) => new TextEncoder().encode(s);
const parse = (s: string | Uint8Array, canonical = true) =>
  parseJsonDocument(typeof s === 'string' ? enc(s) : s, {
    maxBytes: 1 << 20,
    maxDepth: MAX_JSON_DEPTH,
    canonical,
  });
const reasonOf = (s: string | Uint8Array, canonical = true) => {
  const r = parse(s, canonical);
  return r.ok ? 'ok' : r.failure.reason;
};
const nested = (n: number, inner = '') => `${'['.repeat(n)}${inner}${']'.repeat(n)}`;

describe('canonicalJson output', () => {
  it('sorts keys by code point, not by UTF-16 unit and not in integer-key enumeration order', () => {
    // U+1F600 is the surrogate pair D83D DE00: first in UTF-16 order, last in code-point order.
    expect(canonicalJson({ '\u{1F600}': 1, '\uE000': 2, a: 3, '\uFFFF': 4 })).toBe(
      '{"a":3,"\uE000":2,"\uFFFF":4,"\u{1F600}":1}',
    );
    // JavaScript enumerates integer-like keys first and numerically; canonical order is textual.
    expect(canonicalJson({ b: 0, 10: 1, 2: 2, 1: 3, A: 4 })).toBe(
      '{"1":3,"10":1,"2":2,"A":4,"b":0}',
    );
  });

  it('writes compact separators, keeps array order and nests', () => {
    expect(canonicalJson({ z: [3, 1, 2], a: { y: null, x: [true, false] } })).toBe(
      '{"a":{"x":[true,false],"y":null},"z":[3,1,2]}',
    );
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson({})).toBe('{}');
  });

  it('escapes exactly the characters the contract lists, with lowercase hex', () => {
    const value = '"\\/\b\t\n\f\r\u0000\u001f\u007f é\u{1F600}';
    expect(canonicalJson(value)).toBe('"\\"\\\\/\\b\\t\\n\\f\\r\\u0000\\u001f\u007f é\u{1F600}"');
  });

  it('writes integers in shortest form over the whole safe range', () => {
    expect(canonicalJson([0, -1, 9007199254740991, -9007199254740991])).toBe(
      '[0,-1,9007199254740991,-9007199254740991]',
    );
  });

  it('a file is the text plus exactly one LF', () => {
    expect(canonicalJsonFile({ a: 1 })).toBe('{"a":1}\n');
  });

  it('accepts 64 nested containers and refuses 65', () => {
    let v: unknown = 1;
    for (let i = 0; i < MAX_JSON_DEPTH; i++) v = [v];
    expect(canonicalJson(v)).toBe(nested(64, '1'));
    expect(() => canonicalJson([v])).toThrow(CanonicalJsonError);
  });

  it.each([
    ['a fraction', { n: 1.5 }, '/n'],
    ['NaN', [Number.NaN], '/0'],
    ['Infinity', [Number.POSITIVE_INFINITY], '/0'],
    ['-0', { n: -0 }, '/n'],
    ['2^53', { n: 2 ** 53 }, '/n'],
    ['undefined', { u: undefined }, '/u'],
    ['a bigint', { b: 1n }, '/b'],
    ['a symbol', [Symbol('s')], '/0'],
    ['a function', { f: () => 1 }, '/f'],
    ['a Date', { d: new Date(0) }, '/d'],
    ['a Map', { m: new Map() }, '/m'],
    ['an array hole', { h: Object.assign(new Array(3), { 0: 1, 2: 2 }) }, '/h/1'],
    ['a non-NFC string', { s: 'cafe\u0301' }, '/s'],
    ['a non-NFC key', { 'cafe\u0301': 1 }, '/cafe\u0301'],
    ['a lone surrogate', { s: '\uD800' }, '/s'],
    ['a key needing pointer escapes', { 'a/b~': 1.5 }, '/a~1b~0'],
  ])('refuses %s and names where', (_label, value, path) => {
    let caught: unknown;
    try {
      canonicalJson(value);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CanonicalJsonError);
    expect((caught as CanonicalJsonError).path).toBe(path);
  });

  it('refuses a cycle instead of recursing without end', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(CanonicalJsonError);
  });

  it('writes an own __proto__ member as data', () => {
    const parsed = JSON.parse('{"__proto__":{"x":1},"a":1}');
    expect(canonicalJson(parsed)).toBe('{"__proto__":{"x":1},"a":1}');
  });
});

describe('compareCodePoints', () => {
  it('orders like the UTF-8 bytes of the strings', () => {
    const keys = ['\u{1F600}', '\uE000', 'b', 'a', 'ab', '', '\uFFFF', '\u{10000}', 'Z'];
    const byBytes = [...keys].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
    expect([...keys].sort(compareCodePoints)).toEqual(byBytes);
  });
});

describe('parseJsonDocument', () => {
  it('accepts canonical file bytes and returns the value', () => {
    const r = parse('{"a":[1,{"b":null}],"c":"x"}\n');
    expect(r).toEqual({ ok: true, value: { a: [1, { b: null }], c: 'x' } });
  });

  it.each([
    ['whitespace', '{"a": 1}\n'],
    ['unsorted keys', '{"b":1,"a":2}\n'],
    ['no trailing LF', '{"a":1}'],
    ['two trailing LFs', '{"a":1}\n\n'],
    ['an unneeded escape', '{"a":"\\u0041"}\n'],
    ['an escaped slash', '{"a":"\\/"}\n'],
    ['a lone surrogate escape', '{"a":"\\ud800"}\n'],
    ['-0', '{"a":-0}\n'],
    ['2^53', '{"a":9007199254740992}\n'],
    // 2^60 re-serializes byte for byte in JavaScript, so only the explicit range check sees it.
    ['2^60', '{"a":1152921504606846976}\n'],
  ])('refuses %s as not-canonical', (_label, text) => {
    expect(reasonOf(text)).toBe('not-canonical');
  });

  it('without the canonical requirement, accepts formatting but still refuses unsafe numbers', () => {
    expect(reasonOf('{ "b": 1, "a": 2 }', false)).toBe('ok');
    expect(reasonOf('{"a":1152921504606846976}', false)).toBe('not-canonical');
    expect(reasonOf('{"a":"\\ud800"}', false)).toBe('not-canonical');
  });

  it.each([
    ['1.0', 'float'],
    ['1e0', 'float'],
    ['1E+2', 'float'],
    ['-0.0', 'float'],
    ['01', 'invalid-json'],
    ['+1', 'invalid-json'],
    ['.5', 'invalid-json'],
    ['1.', 'invalid-json'],
    ['NaN', 'invalid-json'],
  ])('reads the number token %s as %s', (token, reason) => {
    expect(reasonOf(`{"a":${token}}\n`)).toBe(reason);
  });

  it.each([
    ['empty input', ''],
    ['whitespace only', ' \n'],
    ['a trailing comma', '{"a":1,}\n'],
    ['an unterminated string', '{"a":"x}\n'],
    ['a raw control character', '{"a":"x\ty"}\n'],
    ['a bad escape', '{"a":"\\x"}\n'],
    ['a short unicode escape', '{"a":"\\u12"}\n'],
    ['trailing content', '{"a":1}\nx'],
    ['a bare word', '{"a":tru}\n'],
    ['single quotes', "{'a':1}\n"],
    ['a missing colon', '{"a" 1}\n'],
  ])('refuses %s as invalid-json', (_label, text) => {
    expect(reasonOf(text)).toBe('invalid-json');
  });

  it('refuses a byte order mark before looking at the rest', () => {
    expect(reasonOf(new Uint8Array([0xef, 0xbb, 0xbf, ...enc('{"a":1}\n')]))).toBe('bom');
  });

  it.each([
    ['a stray 0xff', [0x7b, 0xff, 0x7d]],
    ['an overlong slash', [0x22, 0xc0, 0xaf, 0x22]],
    ['an encoded surrogate', [0x22, 0xed, 0xa0, 0x80, 0x22]],
    ['a truncated sequence', [0x22, 0xe2, 0x82, 0x22]],
  ])('refuses %s as invalid-utf8', (_label, bytes) => {
    expect(reasonOf(new Uint8Array(bytes))).toBe('invalid-utf8');
  });

  it('refuses a document above the byte limit before decoding it', () => {
    const r = parseJsonDocument(new Uint8Array([0xff, 0xff, 0xff]), {
      maxBytes: 2,
      maxDepth: 64,
      canonical: true,
    });
    expect(r).toEqual({
      ok: false,
      failure: { code: 'RAY_LIMIT_EXCEEDED', reason: 'manifest-size' },
    });
  });

  it('measures depth before syntax, and ignores brackets inside strings', () => {
    expect(reasonOf(`${nested(65)}\n`)).toBe('json-depth');
    expect(reasonOf(`${'['.repeat(65)}\n`)).toBe('json-depth');
    // A syntax error before the deep part does not hide the depth: depth is judged first.
    expect(reasonOf(`[1,,${nested(70)}]\n`)).toBe('json-depth');
    expect(reasonOf(`${nested(64)}\n`)).toBe('ok');
    expect(reasonOf(`["${'['.repeat(100)}"]\n`)).toBe('ok');
    expect(reasonOf(`${'{"a":'.repeat(65)}1${'}'.repeat(65)}\n`)).toBe('json-depth');
  });

  it('reports the first failing check in the stated order', () => {
    // Syntax is judged before duplicates, duplicates before numbers, numbers before NFC.
    expect(reasonOf('{"a":1,"a":2,}\n')).toBe('invalid-json');
    expect(reasonOf('{"a":1.5,"a":2}\n')).toBe('duplicate-key');
    expect(reasonOf('{"a":1.5,"b":"cafe\u0301"}\n')).toBe('float');
    expect(reasonOf('{"a":-0,"b":"cafe\u0301"}\n')).toBe('non-nfc');
  });

  it('finds duplicate and non-NFC keys at any depth', () => {
    expect(reasonOf('{"a":[{"k":1,"k":1}]}\n')).toBe('duplicate-key');
    expect(reasonOf('{"a":{"cafe\u0301":1}}\n')).toBe('non-nfc');
  });

  it('builds a __proto__ key as an own member without touching any prototype', () => {
    const r = parse('{"__proto__":{"polluted":true},"a":1}\n');
    expect(r.ok).toBe(true);
    const value = (r as { value: Record<string, unknown> }).value;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.hasOwn(value, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
