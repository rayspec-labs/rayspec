/**
 * The FORCING-FUNCTION test (spec layer) — the synthetic stream/blob backend deployment spec.
 *
 * S0 introduced the `stream` RouteAction member + the optional `extensions[]` section. S4 CONVERTED
 * the synthetic stream backend to the PACK mechanism: the deployment `rayspec.yaml` is now THIN —
 * `version` + `metadata` + ONE `extensions[]` ref to a `defineExtension` pack that carries the whole
 * stream surface. So at the SPEC layer (the lowest layer — no dependency on `@rayspec/platform`'s
 * `loadExtensions`), this asserts the THIN deployment spec parses ok and carries the `extensions[]`
 * reference with an EXACT version pin. The MERGED stream surface (the stream routes + the pointer
 * store resolved THROUGH the pack) is asserted in the api-auth acceptance test (stream-pack.db.test.ts
 * + stream-ingest/playback), which is the layer that owns `loadExtensions`.
 *
 * (The `stream` RouteAction grammar member's expressiveness is still proven against a real-shaped
 * route by the api-auth stream tests, whose merged spec carries it; here we prove the THIN deployment
 * spec + the `extensions[]` grammar are expressive for a pack-delivered backend.)
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSpec } from './parse.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/spec/src -> repo-root/examples/stream-backend
const YAML_PATH = resolve(here, '../../../../examples/stream-backend/rayspec.yaml');

describe('forcing function — the synthetic stream/blob backend deployment spec', () => {
  const raw = readFileSync(YAML_PATH, 'utf8');
  const result = parseSpec(raw);

  it('parses ok (the thin pack-delivered deployment spec is expressive)', () => {
    if (!result.ok) {
      // Surface the actual violations on failure so a regression is debuggable.
      throw new Error(`parseSpec failed:\n${JSON.stringify(result.errors, null, 2)}`);
    }
    expect(result.ok).toBe(true);
  });

  it('references the stream PACK via extensions[] with an EXACT version pin + a directory module', () => {
    if (!result.ok) throw new Error('expected ok');
    const ext = result.value.extensions.find((e) => e.id === 'stream_pack');
    expect(ext).toBeDefined();
    expect(ext?.version).toBe('1.0.0'); // an EXACT pin (no caret/tilde/range)
    // A DIRECTORY module path (resolved + path-jailed by loadExtensions at deploy — NOT an npm specifier).
    expect(ext?.module).toBe('./packs/stream-pack');
  });

  it('is THIN — the stream surface (stores/handlers/api) comes from the pack, not inline', () => {
    if (!result.ok) throw new Error('expected ok');
    // The deployment spec declares NO inline stores/handlers/api — they are contributed by the pack
    // (merged by loadExtensions at deploy). This is the S4 conversion: the surface rides the pack.
    expect(result.value.stores).toEqual([]);
    expect(result.value.handlers).toEqual([]);
    expect(result.value.api).toEqual([]);
    expect(result.value.extensions).toHaveLength(1);
  });
});
