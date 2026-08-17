/**
 * A PACK's routes are held to the merged surface by the floor, not only by the boot.
 *
 * A pack's `routePrefix` is checked for being an absolute path, not being `/`, and carrying no path
 * parameter. It is NOT checked against the reserved prefixes — so a pack may declare
 * `routePrefix: '/health/'` and contribute `GET /health/steal`, which reaches the router ahead of the
 * readiness probe exactly as a deployment-declared `/health` would.
 *
 * The boot refuses it: `mergeExtensions` concatenates the fragments and re-parses the merged document,
 * so the document's own rules are asked of the sum. `doctor --with-packs` did not — it lifted the
 * pack-claimed sections and stopped, leaving the one command whose whole purpose is to answer pack
 * questions reporting clean what the boot refuses. That is the shape of defect the diagnostic floor
 * exists to remove, and it was live for pack-contributed routes.
 *
 * The fix is the general one: `parseSpecWithPacks` lints the MERGED document, the way the boot's
 * re-parse does. So this suite pins the class rather than the one rule — a second arm drives a pack
 * route that is the same route as a deployment route, which no reserved-path rule would catch.
 *
 * ACCEPT CONTROL: the same pack, contributing under its own namespace, must still pass. A merged lint
 * that refused every pack would satisfy the refusals above while making packs undeployable.
 *
 * No database, no network, no secret: `doctor` is static, and the packs are directories in a
 * throwaway tree.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXTENSION_BRAND } from '@rayspec/platform';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from './doctor.js';

/** The deployment document — valid on its own, and referencing the pack beside it. */
const DOC = `version: '1.0'
metadata: { name: pack-route-floor }
stores:
  - name: notes
    columns: [{ name: body, type: text }]
api:
  - { method: GET, path: '/notes/{id}', action: { kind: store, store: notes, op: get } }
extensions:
  - id: contributing-pack
    module: ./contributing-pack
    version: 1.0.0
`;

/** A pack manifest contributing one route under `prefix` — its entry, as a published pack ships it. */
function packEntry(prefix: string, path: string): string {
  return `export default {
  __rayspecExtension: ${JSON.stringify(EXTENSION_BRAND)},
  version: '1.0.0',
  routePrefix: ${JSON.stringify(prefix)},
  fragments: {
    handlers: [{ id: 'contributed', module: 'handlers/contributed.js', export: 'contributed', kind: 'route' }],
    api: [{ method: 'GET', path: ${JSON.stringify(path)}, action: { kind: 'handler', handler: 'contributed' } }],
  },
};
`;
}

let root = '';
let packDir = '';
let prevCwd = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rayspec-pack-route-floor-'));
  packDir = join(root, 'contributing-pack');
  mkdirSync(join(packDir, 'handlers'), { recursive: true });
  // The loader imports compiled JavaScript only, and a `.js` file is ESM only if a manifest beside it
  // says so — exactly what a published pack ships.
  writeFileSync(join(packDir, 'package.json'), '{ "type": "module" }\n', 'utf8');
  writeFileSync(
    join(packDir, 'handlers', 'contributed.js'),
    "export const contributed = async () => new Response('ok');\n",
    'utf8',
  );
  writeFileSync(join(root, 'rayspec.yaml'), DOC, 'utf8');
  // The read-spec jail resolves against the CWD; every command runs from the deployment tree.
  prevCwd = process.cwd();
  process.chdir(root);
});

afterEach(() => {
  process.chdir(prevCwd);
  rmSync(root, { recursive: true, force: true });
});

/** Write the pack's entry for this case. A fresh directory per case — a module URL imports once. */
function contributes(prefix: string, path: string): void {
  writeFileSync(join(packDir, 'index.js'), packEntry(prefix, path), 'utf8');
}

describe('doctor --with-packs answers the merged surface, as the boot does', () => {
  it('refuses a pack route under a reserved platform prefix, in the same sentence', async () => {
    contributes('/health/', '/health/steal');
    const r = await runDoctor(['rayspec.yaml'], { withPacks: true });
    expect(r.ok).toBe(false);
    const found = r.errors.find((e) => e.code === 'reserved_route_path');
    expect(found).toBeDefined();
    expect(found?.message).toContain('GET /health/steal');
    expect(found?.message).toContain('under a path this deployment reserves');
  });

  it('refuses a pack route that is the SAME route as the deployment’s once the router has it', async () => {
    // Neither half is wrong on its own, and no reserved prefix is involved: the pack's namespace is
    // its own. The collision exists only in the sum, which is the class this lint closes.
    contributes('/notes/', '/notes/{note_id}');
    const r = await runDoctor(['rayspec.yaml'], { withPacks: true });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain('duplicate_name');
  });

  it('ACCEPT CONTROL: a pack contributing inside its own namespace still passes', async () => {
    contributes('/ext/contributing-pack/', '/ext/contributing-pack/things');
    const r = await runDoctor(['rayspec.yaml'], { withPacks: true });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.claimedSections).toBeUndefined();
  });

  it('the DEFAULT run is untouched: it resolves no pack, so it has no merged surface to lint', async () => {
    // Not an oversight — `doctor` loads no pack unless asked, because resolving one means importing
    // code out of the deployment tree. The report says as much in its own line; `--with-packs` is what
    // buys the fuller check, and the arm above is what it buys.
    contributes('/health/', '/health/steal');
    const r = await runDoctor(['rayspec.yaml']);
    expect(r.ok).toBe(true);
    expect((r.notResolved ?? []).join('\n')).toContain('--with-packs');
  });
});
