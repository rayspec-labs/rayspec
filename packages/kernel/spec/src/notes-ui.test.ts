/**
 * The frontend-serving forcing function.
 *
 * Reads the throwaway `examples/notes-ui/rayspec.yaml` (authored OUTSIDE the platform) and asserts
 * `parseSpec` returns `ok:true` with a NON-EMPTY `frontend[]` and NO agents — proving the grammar +
 * lint accept a real backend that pairs a CRUD API with a bundled static web frontend, and that the
 * frontend route (`/`) coexisting with `/api/*` routes is NOT falsely flagged as a collision.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSpec } from './parse.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/kernel/spec/src -> repo-root/examples/notes-ui
const YAML_PATH = resolve(here, '../../../../examples/notes-ui/rayspec.yaml');

describe('forcing function — the notes-ui frontend-serving backend', () => {
  const raw = readFileSync(YAML_PATH, 'utf8');
  const result = parseSpec(raw);

  it('parses ok (grammar + lint accept a frontend mount alongside /api routes)', () => {
    if (!result.ok) {
      throw new Error(`parseSpec failed:\n${JSON.stringify(result.errors, null, 2)}`);
    }
    expect(result.ok).toBe(true);
  });

  it('declares a non-empty frontend[] (a root `/` SPA mount) and NO agents', () => {
    if (!result.ok) throw new Error('expected ok');
    const v = result.value;
    expect(v.frontend?.length).toBeGreaterThan(0);
    expect(v.frontend?.[0]?.route).toBe('/');
    expect(v.frontend?.[0]?.dir).toBe('web/dist');
    expect(v.frontend?.[0]?.spa).toBe(true);
    expect(v.agents).toEqual([]);
  });

  it('exposes CRUD store routes under /api/notes (declarative, no handler code)', () => {
    if (!result.ok) throw new Error('expected ok');
    const paths = result.value.api.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain('GET /api/notes');
    expect(paths).toContain('POST /api/notes');
    expect(paths).toContain('GET /api/notes/{id}');
  });
});
