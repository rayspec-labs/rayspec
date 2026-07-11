/**
 * `rayspec openapi` — the view-surface OpenAPI emitter. Drives `runOpenapi`
 * against a temp-dir spec (the command jails paths to CWD, like `doctor`), over BOTH the real acceptance
 * product and a minimal doc, and asserts it rejects a backend doc with no views.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runOpenapi } from './openapi.js';

const here = dirname(fileURLToPath(import.meta.url));
const ACCEPTANCE = resolve(here, '../../../../examples/expense-claim/expense-claim.product.yaml');

let dir: string;
let prevCwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayspec-openapi-'));
  prevCwd = process.cwd();
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe('rayspec openapi', () => {
  it('emits the OpenAPI 3.1 view surface of the real acceptance product (both GET views)', () => {
    writeFileSync(join(dir, 'expense.product.yaml'), readFileSync(ACCEPTANCE, 'utf8'), 'utf8');
    return runOpenapi(['expense.product.yaml']).then((r) => {
      expect(r.ok).toBe(true);
      const doc = r.openapi!;
      expect(doc.openapi).toBe('3.1.0');
      expect(doc.info.title).toContain('Expense Claim Auto-Coder');
      // Both declared GET views become OpenAPI paths with a `get` operation.
      expect(Object.keys(doc.paths).sort()).toEqual(['/claims', '/claims/{claim_ref}']);
      expect(doc.paths['/claims/{claim_ref}']?.get).toHaveProperty('responses');
      expect(doc.paths['/claims']?.get).toHaveProperty('responses');
      // The path param is declared on the detail route.
      expect(JSON.stringify(doc.paths['/claims/{claim_ref}']?.get)).toContain('claim_ref');
      // A components object is always present (schemas may be inlined per-response).
      expect(doc.components).toHaveProperty('schemas');
    });
  });

  it('emits a valid (empty-paths) document for a product doc with no views', async () => {
    writeFileSync(
      join(dir, 'noviews.product.yaml'),
      'version: "1.0"\nproduct: { id: nv, name: NoViews }\n',
      'utf8',
    );
    const r = await runOpenapi(['noviews.product.yaml']);
    expect(r.ok).toBe(true);
    expect(r.openapi?.openapi).toBe('3.1.0');
    expect(Object.keys(r.openapi!.paths)).toHaveLength(0);
  });

  it('REJECTS a backend doc fail-closed (no declarative views section)', async () => {
    writeFileSync(
      join(dir, 'classic.yaml'),
      'version: "1.0"\nmetadata: { name: classic }\n',
      'utf8',
    );
    const r = await runOpenapi(['classic.yaml']);
    expect(r.ok).toBe(false);
    expect(r.errors?.[0]?.code).toBe('unsupported_version');
    expect(r.openapi).toBeUndefined();
  });

  it('surfaces parse errors for an invalid product doc (ok:false, no openapi)', async () => {
    writeFileSync(
      join(dir, 'bad.product.yaml'),
      'version: "1.0"\nproduct: { id: bad, name: Bad }\nviews: [{ id: x }]\n',
      'utf8',
    );
    const r = await runOpenapi(['bad.product.yaml']);
    expect(r.ok).toBe(false);
    expect(r.errors?.length ?? 0).toBeGreaterThan(0);
  });
});
