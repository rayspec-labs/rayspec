/**
 * unit tests — `viewPathParams` extracts `{param}` names from a declared view route path with a
 * single forward, strictly-linear, no-regex scan (length-safe for any name). Pure + network-free.
 */

import { describe, expect, it } from 'vitest';
import type { SpecError } from './errors.js';
import { parseProductSpec } from './product-parse.js';
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

describe('a view route may not claim a path the platform reserves', () => {
  /**
   * Issue #441's floor half, for the profile the `rayspec.yaml` lint never sees. A Product-YAML
   * document is parsed by `parseProductSpec`, not `parseSpec`, so `lintSpec`'s reserved-route rule
   * never ran on it — `doctor`, `plan` and `deploy --dry-run` all answered `{"ok": true}` for a view
   * route on `/health`, and the collision surfaced only when the registrar refused during roll-out,
   * after the migrate step had committed the document's product DDL.
   */
  const doc = (path: string): string =>
    'version: "1.0"\nproduct:\n  id: p\n  name: P\n' +
    'contracts:\n  note.response:\n    type: object\n    properties:\n' +
    '      note_ref: { type: string }\n      note_text: { type: [string, "null"] }\n' +
    '    required: [note_ref]\n' +
    'stores:\n  - name: notes\n    columns:\n' +
    '      - { name: note_ref, type: text }\n' +
    '      - { name: note_text, type: text, nullable: true }\n' +
    '    key: [note_ref]\n' +
    'views:\n  - id: v\n    route:\n' +
    `      method: GET\n      path: "${path}"\n` +
    '    auth: bearer_tenant\n' +
    '    params:\n      note_ref: { in: path, shape: safe_id }\n' +
    '    source: { kind: store, ref: notes }\n' +
    '    read:\n      mode: single\n' +
    '      filter:\n        note_ref: { param: note_ref }\n' +
    '      shape:\n        fields:\n' +
    '          note_ref: { kind: param, param: note_ref }\n' +
    '          note_text: { kind: column, column: note_text, type: string, default: "" }\n' +
    '      absent:\n        fields:\n' +
    '          note_ref: { kind: param, param: note_ref }\n' +
    '          note_text: { kind: const, value: null }\n' +
    '    absent_state: empty_200\n' +
    '    response_contract: note.response\n';

  const reservedErrors = (path: string): SpecError[] => {
    const res = parseProductSpec(doc(path));
    return res.ok ? [] : res.errors.filter((e) => e.code === 'reserved_route_path');
  };

  it('refuses a LITERAL reserved path, at the view route', () => {
    const errs = reservedErrors('/health/{note_ref}');
    expect(errs).toHaveLength(1);
    expect(errs[0]?.path).toBe('views[0].route.path');
    expect(errs[0]?.message).toMatch(/is under a path this deployment reserves/);
  });

  it('refuses a LEADING PLACEHOLDER in the words that name the remedy', () => {
    // Not the literal sentence: `/{note_ref}/notes` is under no reserved path — it MATCHES one,
    // because the router fills the parameter with whatever the request supplies, `v1` included.
    const errs = reservedErrors('/{note_ref}/notes');
    expect(errs).toHaveLength(1);
    expect(errs[0]?.message).toMatch(/begins with a PARAMETER or WILDCARD/);
    expect(errs[0]?.message).toMatch(/LITERAL first segment/);
  });

  it('ACCEPT CONTROL: an ordinary view route parses clean', () => {
    // Without this the two arms above would look identical to a rule that refuses every view.
    const res = parseProductSpec(doc('/notes/{note_ref}'));
    expect(res.ok, res.ok ? '' : JSON.stringify(res.errors)).toBe(true);
  });
});
