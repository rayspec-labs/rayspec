/**
 * unit tests — `viewPathParams` extracts `{param}` names from a declared view route path with a
 * single forward, strictly-linear, no-regex scan (length-safe for any name). Pure + network-free.
 */

import { describe, expect, it } from 'vitest';
import { viewPathParams } from './product-views-lint.js';

describe('viewPathParams — `{param}` extraction (linear, no-regex scan)', () => {
  it('extracts every param from a legitimate path EXACTLY as before', () => {
    expect(viewPathParams('/sessions')).toEqual([]);
    expect(viewPathParams('/sessions/{session_id}/notes')).toEqual(['session_id']);
    expect(viewPathParams('/sessions/{session_id}/{track}/transcript')).toEqual([
      'session_id',
      'track',
    ]);
    expect(viewPathParams('/{a}{b}')).toEqual(['a', 'b']);
    const long = `p_${'x'.repeat(100)}`;
    expect(viewPathParams(`/r/{${long}}`)).toEqual([long]);
  });

  it('a long unclosed-brace input does not hang the scan (linear scan)', () => {
    // FAIL-THE-FIX guard: a pathological 200k-char run stays linear (single forward scan, no backtracking).
    const pathological = `/x/{${'a'.repeat(200_000)}`;
    const start = Date.now();
    const out = viewPathParams(pathological);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(out).toEqual([]); // no closing brace ⇒ no param
  });

  it('a 129+-char param name is still extracted — the scan is length-SAFE, not length-capped (fail-the-fix)', () => {
    // A route path has no param-name length cap anywhere, so a 129+ char name is schema-legal and MUST
    // still be extracted. FAIL-THE-FIX: a `[^}/]{1,128}` bounded regex silently drops it; the no-regex
    // scan extracts it. A neighbouring in-bound param still extracts alongside.
    const long129 = 'a'.repeat(129);
    expect(viewPathParams(`/r/{${long129}}`)).toEqual([long129]);
    // ~65 emoji already exceed 128 UTF-16 code units (2 units each) — still extracted.
    const emoji = '😀'.repeat(65);
    expect(viewPathParams(`/r/{${emoji}}/s/{ok}`)).toEqual([emoji, 'ok']);
    expect(viewPathParams(`/r/{ok}/s/{${long129}}`)).toEqual(['ok', long129]);
  });
});
