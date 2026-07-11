import { describe, expect, it } from 'vitest';
import {
  CanonicalJsonDepthError,
  canonicalJson,
  canonicalJsonByteLength,
  MAX_CANONICAL_JSON_DEPTH,
  recordPayloadHash,
} from './canonical-json.js';

/** `depth` nested arrays around a scalar (the HS-1 hostile shape: tiny bytes, deep recursion). */
function nestedArrays(depth: number): unknown {
  let v: unknown = 1;
  for (let i = 0; i < depth; i += 1) v = [v];
  return v;
}

describe('canonicalJson / recordPayloadHash', () => {
  it('is key-order independent (objects, recursively) but array-order sensitive', () => {
    const a = { b: 1, a: { y: [1, 2], x: 'v' } };
    const b = { a: { x: 'v', y: [1, 2] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(recordPayloadHash(a)).toBe(recordPayloadHash(b));
    expect(recordPayloadHash({ v: [1, 2] })).not.toBe(recordPayloadHash({ v: [2, 1] }));
  });

  it('distinguishes values, types, and structure', () => {
    expect(recordPayloadHash({ a: 1 })).not.toBe(recordPayloadHash({ a: '1' }));
    expect(recordPayloadHash({ a: null })).not.toBe(recordPayloadHash({}));
  });

  it('drops undefined-valued keys (JSON semantics) and measures UTF-8 bytes', () => {
    expect(canonicalJson({ a: 1, gone: undefined })).toBe('{"a":1}');
    expect(canonicalJsonByteLength({ s: 'é' })).toBe(Buffer.byteLength('{"s":"é"}', 'utf8'));
  });

  it('HS-1: bounds nesting depth with the TYPED error — never a stack-overflow RangeError', () => {
    // The hostile shape the finding names: ~3000 nested arrays, ~6KB — far under the byte cap.
    // Before the bound this blew the call stack INSIDE the size computation (RangeError → 500).
    expect(() => canonicalJson(nestedArrays(3000))).toThrow(CanonicalJsonDepthError);

    // The exact boundary: MAX levels canonicalize; one more is the typed fail-closed rejection.
    expect(() => canonicalJson(nestedArrays(MAX_CANONICAL_JSON_DEPTH))).not.toThrow();
    expect(() => canonicalJson(nestedArrays(MAX_CANONICAL_JSON_DEPTH + 1))).toThrow(
      CanonicalJsonDepthError,
    );

    // Objects count as container levels too (mixed nesting).
    let deepObj: unknown = 1;
    for (let i = 0; i < MAX_CANONICAL_JSON_DEPTH + 1; i += 1) deepObj = { k: deepObj };
    expect(() => canonicalJson(deepObj)).toThrow(CanonicalJsonDepthError);

    // Scalars and flat containers are untouched by the bound.
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson({ a: [1, 2, 3] })).toBe('{"a":[1,2,3]}');
  });
});
