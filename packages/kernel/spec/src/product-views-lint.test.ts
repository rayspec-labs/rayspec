/**
 * unit tests — `viewPathParams` extracts `{param}` names from a declared view route path with a
 * bounded, strictly-linear scan (the `[^}/]{1,128}` quantifier bound). Pure + network-free.
 */

import { describe, expect, it } from 'vitest';
import { viewPathParams } from './product-views-lint.js';

describe('viewPathParams — bounded `{param}` extraction', () => {
  it('extracts every param from a legitimate path EXACTLY as before', () => {
    expect(viewPathParams('/sessions')).toEqual([]);
    expect(viewPathParams('/sessions/{session_id}/notes')).toEqual(['session_id']);
    expect(viewPathParams('/sessions/{session_id}/{track}/transcript')).toEqual([
      'session_id',
      'track',
    ]);
    expect(viewPathParams('/{a}{b}')).toEqual(['a', 'b']);
    // A long-but-realistic param (well under the 128-char bound) is still extracted.
    const long = `p_${'x'.repeat(100)}`;
    expect(viewPathParams(`/r/{${long}}`)).toEqual([long]);
  });

  it('a long unclosed-brace input does not hang the scan (bounded quantifier)', () => {
    // FAIL-THE-FIX guard for the bound: pathological 200k-char run stays linear.
    const pathological = `/x/{${'a'.repeat(200_000)}`;
    const start = Date.now();
    const out = viewPathParams(pathological);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(out).toEqual([]); // no closing brace ⇒ no param
  });

  it('an over-128-char param name is not extracted (the security bound; never a valid spec path)', () => {
    // FAIL-THE-FIX: the old unbounded `[^}/]+` captured ANY length; the bound stops at 128 so a
    // 200-char "name" no longer matches. A neighbouring in-bound param still extracts.
    const huge = 'a'.repeat(200);
    expect(viewPathParams(`/r/{${huge}}`)).toEqual([]);
    expect(viewPathParams(`/r/{ok}/s/{${huge}}`)).toEqual(['ok']);
  });
});
