/**
 * Grammar-addition tests (the `stream` RouteAction member + the `extensions[]` section).
 *
 * NOT blind: each case starts from a known-good base, injects exactly ONE defect (or proves one
 * acceptance), and asserts (a) the parse outcome and (b) the specific closed `SpecErrorCode` where a
 * rejection is expected. A field-flip in the grammar BREAKS the corresponding case (fail-the-fix):
 *   - drop `.strict()` on the stream arm → the unknown-key case stops rejecting.
 *   - relax the exact-version refine → the caret/tilde/range cases stop rejecting.
 *   - drop `mode` from the stream arm or widen the enum → the bad-mode case stops rejecting.
 *   - drop the lint stream-handler resolution → the unresolvable-handler case stops rejecting.
 *   - make `extensions` non-optional → the minimal-spec acceptance breaks.
 *
 * These cover the five acceptance points for these grammar additions.
 */
import { describe, expect, it } from 'vitest';
import type { SpecErrorCode } from './errors.js';
import { parseSpec } from './parse.js';

/** Assert the parse failed AND at least one error carries the expected closed code. */
function expectRejection(yaml: string, code: SpecErrorCode): void {
  const res = parseSpec(yaml);
  expect(res.ok).toBe(false);
  if (res.ok) return; // narrow
  const codes = res.errors.map((e) => e.code);
  expect(codes).toContain(code);
}

/** Assert the parse SUCCEEDED (surface violations on failure for debuggability). */
function expectOk(yaml: string): ReturnType<typeof parseSpec> {
  const res = parseSpec(yaml);
  if (!res.ok) throw new Error(`expected ok:\n${JSON.stringify(res.errors, null, 2)}`);
  return res;
}

/**
 * A known-good base with BOTH a stream-ingest and a stream-playback route, two route-kind handlers,
 * and an extensions[] section (an exact-pin pack). Each test mutates exactly one thing.
 */
const BASE = `
version: '1.0'
metadata:
  name: p5-base
api:
  - method: POST
    path: /uploads/{id}/chunks/{idx}
    action: { kind: stream, handler: ingest_h, mode: ingest }
  - method: GET
    path: /uploads/{id}/playback
    action: { kind: stream, handler: playback_h, mode: playback }
handlers:
  - { id: ingest_h, module: handlers/ingest.ts, export: ingest, kind: route }
  - { id: playback_h, module: handlers/playback.ts, export: playback, kind: route }
extensions:
  - id: pack_a
    module: ./packs/a
    version: 1.2.3
    config:
      anything: goes
`;

describe('base sanity (so each case isolates ONE change)', () => {
  it('the base spec (stream routes + extensions) parses ok', () => {
    const res = expectOk(BASE);
    if (!res.ok) return;
    expect(res.value.api).toHaveLength(2);
    expect(res.value.extensions).toHaveLength(1);
  });
});

// ---- (1) ACCEPTS stream (both modes) + extensions[] -------------------------------------------
describe('accepts stream routes + extensions[]', () => {
  it('accepts a stream-INGEST route', () => {
    const res = expectOk(BASE);
    if (!res.ok) return;
    const r = res.value.api.find((x) => x.action.kind === 'stream' && x.action.mode === 'ingest');
    expect(r).toBeDefined();
    if (r?.action.kind !== 'stream') throw new Error('expected stream');
    expect(r.action.handler).toBe('ingest_h');
  });

  it('accepts a stream-PLAYBACK route', () => {
    const res = expectOk(BASE);
    if (!res.ok) return;
    const r = res.value.api.find((x) => x.action.kind === 'stream' && x.action.mode === 'playback');
    expect(r).toBeDefined();
    if (r?.action.kind !== 'stream') throw new Error('expected stream');
    expect(r.action.handler).toBe('playback_h');
  });

  it('accepts the extensions[] section (exact pin + opaque config preserved)', () => {
    const res = expectOk(BASE);
    if (!res.ok) return;
    expect(res.value.extensions[0]).toEqual({
      id: 'pack_a',
      module: './packs/a',
      version: '1.2.3',
      config: { anything: 'goes' },
    });
  });

  it('accepts an extension WITHOUT config (config is optional)', () => {
    const yaml = `
version: '1.0'
metadata:
  name: ext-no-config
extensions:
  - { id: p, module: ./p, version: 0.9.0 }
`;
    const res = expectOk(yaml);
    if (!res.ok) return;
    expect(res.value.extensions[0]?.config).toBeUndefined();
  });
});

// ---- (2) REJECTS unknown/absent mode + extra keys (fail-closed) -------------------------------
describe('fail-closed rejections (mode + strict unknown keys)', () => {
  it('rejects an UNKNOWN mode value (schema_violation)', () => {
    const yaml = BASE.replace('mode: ingest', 'mode: sideways');
    expectRejection(yaml, 'schema_violation');
  });

  it('rejects an ABSENT mode on a stream route (schema_violation)', () => {
    // Remove the `, mode: ingest` from the inline-map ingest action.
    const yaml = BASE.replace(
      'action: { kind: stream, handler: ingest_h, mode: ingest }',
      'action: { kind: stream, handler: ingest_h }',
    );
    expectRejection(yaml, 'schema_violation');
  });

  it('rejects an EXTRA key on the stream action object (unknown_field — .strict())', () => {
    const yaml = BASE.replace(
      'action: { kind: stream, handler: ingest_h, mode: ingest }',
      'action: { kind: stream, handler: ingest_h, mode: ingest, store: x }',
    );
    expectRejection(yaml, 'unknown_field');
  });

  it('rejects an EXTRA key on an ExtensionRef (unknown_field — .strict())', () => {
    const yaml = BASE.replace('    version: 1.2.3', '    version: 1.2.3\n    bogus: nope');
    expectRejection(yaml, 'unknown_field');
  });
});

// ---- (3) EXACT version pin (zero caret/tilde/range) -------------------------------------------
describe('extensions[] version must be an EXACT pin (fail-closed)', () => {
  // The allowlist (.regex strict-exact-semver) must reject EVERY non-exact form — not just the
  // range chars the old blocklist enumerated. These include the forms the old blocklist LEAKED:
  // uppercase-X wildcards (1.2.X / 1.X / X), floating dist-tags (latest/stable/beta), and partial
  // versions (1 / 1.2). A regression to a blocklist false-accepts these → the case goes red.
  for (const bad of [
    '^1.2.3',
    '~1.2.3',
    '>=1.0.0',
    '<2.0.0',
    '=1.2.3',
    '1.2.x',
    '1.x',
    '*',
    '1.2.X',
    '1.X',
    'X',
    'latest',
    'stable',
    'beta',
    '1',
    '1.2',
  ]) {
    it(`rejects a non-exact version pin: ${JSON.stringify(bad)}`, () => {
      // Quote the value so YAML keeps it a string (e.g. `*` / `>=…` are not bare scalars).
      const yaml = BASE.replace('    version: 1.2.3', `    version: '${bad}'`);
      expectRejection(yaml, 'schema_violation');
    });
  }

  it('rejects an OR-range pin (`1.0.0 || 2.0.0`)', () => {
    const yaml = BASE.replace('    version: 1.2.3', "    version: '1.0.0 || 2.0.0'");
    expectRejection(yaml, 'schema_violation');
  });

  it('rejects a HYPHEN-range pin (`1.0.0 - 2.0.0`)', () => {
    const yaml = BASE.replace('    version: 1.2.3', "    version: '1.0.0 - 2.0.0'");
    expectRejection(yaml, 'schema_violation');
  });

  it('rejects a pin with surrounding whitespace (` 1.2.3 `)', () => {
    const yaml = BASE.replace('    version: 1.2.3', "    version: ' 1.2.3 '");
    expectRejection(yaml, 'schema_violation');
  });

  it('ACCEPTS a bare exact version (1.2.3)', () => {
    // BASE already uses 1.2.3; assert it round-trips (the accept side of the exact-pin pair).
    const res = expectOk(BASE);
    if (!res.ok) return;
    expect(res.value.extensions[0]?.version).toBe('1.2.3');
  });

  it('ACCEPTS an exact prerelease/build pin (1.2.3-rc.1) — still an exact pin', () => {
    const yaml = BASE.replace('    version: 1.2.3', '    version: 1.2.3-rc.1');
    const res = expectOk(yaml);
    if (!res.ok) return;
    expect(res.value.extensions[0]?.version).toBe('1.2.3-rc.1');
  });

  // The old blocklist false-REJECTED legit exact pins whose prerelease/build metadata contains the
  // letter `x` (it banned the char `x` anywhere). The allowlist accepts them — they ARE exact pins.
  it('ACCEPTS an exact pin whose PRERELEASE metadata contains `x` (1.0.0-linux.1)', () => {
    const yaml = BASE.replace('    version: 1.2.3', '    version: 1.0.0-linux.1');
    const res = expectOk(yaml);
    if (!res.ok) return;
    expect(res.value.extensions[0]?.version).toBe('1.0.0-linux.1');
  });

  it('ACCEPTS an exact pin whose BUILD metadata contains `x` (2.0.0+exp.sha)', () => {
    const yaml = BASE.replace('    version: 1.2.3', '    version: 2.0.0+exp.sha');
    const res = expectOk(yaml);
    if (!res.ok) return;
    expect(res.value.extensions[0]?.version).toBe('2.0.0+exp.sha');
  });
});

// ---- (4) stream handler ref is LINT-resolved --------------------------------------------------
describe('stream handler ref is lint-resolved', () => {
  it('rejects a stream route whose handler id is UNRESOLVABLE (dangling_ref)', () => {
    const yaml = BASE.replace('handler: ingest_h, mode: ingest', 'handler: ghost_h, mode: ingest');
    expectRejection(yaml, 'dangling_ref');
  });

  it('rejects a stream route whose handler is the WRONG kind (tool, not route)', () => {
    // Add a tool-kind handler and point the stream route at it — lint requires route-kind.
    const yaml = `
version: '1.0'
metadata:
  name: wrong-kind
api:
  - method: POST
    path: /x
    action: { kind: stream, handler: a_tool, mode: ingest }
handlers:
  - { id: a_tool, module: handlers/t.ts, export: t, kind: tool }
`;
    expectRejection(yaml, 'dangling_ref');
  });

  it('ACCEPTS a stream route whose handler resolves to a route-kind handler', () => {
    const res = expectOk(BASE); // ingest_h / playback_h are both route-kind
    expect(res.ok).toBe(true);
  });

  it('rejects two extension refs sharing an id (duplicate_name)', () => {
    const yaml = BASE.replace(
      'extensions:\n  - id: pack_a',
      'extensions:\n  - { id: pack_a, module: ./packs/dup, version: 0.0.1 }\n  - id: pack_a',
    );
    expectRejection(yaml, 'duplicate_name');
  });
});

// ---- (5) absent extensions[] = no-op (minimal spec still valid) -------------------------------
describe('absent extensions[] is a no-op', () => {
  it('a minimal spec (version + metadata, NO extensions) parses ok with extensions == []', () => {
    const res = expectOk("version: '1.0'\nmetadata:\n  name: minimal\n");
    if (!res.ok) return;
    expect(res.value.extensions).toEqual([]);
  });

  it('the pre-existing backend (no stream, no extensions) is unaffected', () => {
    // A spec without any stream route or extensions section must still parse — additive/optional.
    const yaml = `
version: '1.0'
metadata:
  name: legacy
stores:
  - name: items
    columns:
      - { name: label, type: text }
api:
  - { method: GET, path: '/items', action: { kind: store, store: items, op: list } }
`;
    const res = expectOk(yaml);
    if (!res.ok) return;
    expect(res.value.extensions).toEqual([]);
    expect(res.value.api[0]?.action.kind).toBe('store');
  });
});
