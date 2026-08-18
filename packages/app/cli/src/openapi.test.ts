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
import { OPENAPI_POSTURE_NOTICE, runOpenapi } from './openapi.js';

const here = dirname(fileURLToPath(import.meta.url));
const ACCEPTANCE = resolve(here, '../../../../examples/expense-claim/expense-claim.product.yaml');

/**
 * THE POSTURE NOTICE, BYTE-PINNED — and pinned IDENTICAL to the OTHER copy of it in the tree.
 *
 * The MIRROR of the block in `packages/compose/api-auth/src/engine/emit-openapi.test.ts`, and
 * deliberately duplicated rather than shared: CI splits the test lanes, so a pin that lived only in
 * the other package would leave THIS lane silent while this package's own copy of the sentence was
 * edited. Every other assertion on this constant is self-referential
 * (`toContain(OPENAPI_POSTURE_NOTICE)`) or a substring probe (`toContain('NOT internet-facing')`),
 * and both stay green while the words are softened.
 *
 * Why there are two copies at all — and why this test rather than a shared export — is written down
 * above the constant in `emit-openapi.ts`; the short version is that `@rayspec/cli` has no
 * dependency edge to `@rayspec/api-auth`, so the comparison is made over the SOURCE FILE instead of
 * over an import.
 */
const REPO_ROOT = resolve(here, '../../../..');
const OWN_COPY_REL = 'packages/app/cli/src/openapi.ts';
const API_AUTH_COPY_REL = 'packages/compose/api-auth/src/engine/emit-openapi.ts';

/** The exact text. Not derived from the source under test — that is the point of a byte-pin. */
const PINNED_NOTICE =
  'LOCAL / trusted posture / NOT internet-facing — this API is served by a LOCAL, single-node, pre-external-hardening RaySpec deployment. The separate hardening layer (per-tenant sandbox, RLS, KMS-DEK, DPoP) is the gate before any external exposure and is not built yet. Never put this behind a public address.';

/** Lift the whole `export const OPENAPI_POSTURE_NOTICE = …;` declaration out of a source file. */
function noticeDeclaration(rel: string): string {
  const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
  const match = /^export const OPENAPI_POSTURE_NOTICE =\n(?:.*\n)*?.*;\n/m.exec(src);
  // The floor: a pattern that matched nothing must FAIL here, never return '' and compare equal to
  // the other side's ''. Two files that both stopped declaring the constant is not agreement.
  expect(
    match,
    `${rel} no longer declares OPENAPI_POSTURE_NOTICE in the pinned form`,
  ).not.toBeNull();
  const declaration = (match as RegExpExecArray)[0];
  expect(declaration).toContain('OPENAPI_POSTURE_NOTICE');
  expect(declaration.length).toBeGreaterThan(200);
  return declaration;
}

/** Re-join the single-quoted segments of a declaration into the string it declares. */
function declaredValue(declaration: string): string {
  expect(declaration).not.toContain("\\'");
  const segments = [...declaration.matchAll(/'([^'\\]*)'/g)].map((m) => m[1] as string);
  expect(segments.length).toBeGreaterThan(0);
  return segments.join('');
}

describe('OPENAPI_POSTURE_NOTICE — pinned, and pinned identical across both copies', () => {
  it('is exactly the posture sentence, byte for byte', () => {
    expect(OPENAPI_POSTURE_NOTICE).toBe(PINNED_NOTICE);
  });

  it('is declared byte-identically in @rayspec/cli and @rayspec/api-auth', () => {
    expect(noticeDeclaration(OWN_COPY_REL)).toBe(noticeDeclaration(API_AUTH_COPY_REL));
  });

  it('both declarations on disk evaluate to the value this module exports', () => {
    expect(declaredValue(noticeDeclaration(OWN_COPY_REL))).toBe(OPENAPI_POSTURE_NOTICE);
    expect(declaredValue(noticeDeclaration(API_AUTH_COPY_REL))).toBe(OPENAPI_POSTURE_NOTICE);
  });
});

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

  /**
   * THE POSTURE NOTICE. The emitted document is the one artifact a client generator, an API-console
   * user or a downstream integrator may hold WITHOUT ever seeing this repository's README, its
   * SECURITY.md, or the boot banner — so it is the one place where a missing posture statement
   * reaches an audience that has no other copy. Both arms below exist because the description is a
   * conditional field: it was present only when the product declared one, so the doc that carried
   * the LEAST context was also the one that carried no warning at all.
   */
  it('the generated document states the LOCAL / NOT-internet-facing posture, keeping the declared description', async () => {
    writeFileSync(
      join(dir, 'described.product.yaml'),
      'version: "1.0"\nproduct: { id: d, name: Described, description: "Claims, described." }\n',
      'utf8',
    );
    const r = await runOpenapi(['described.product.yaml']);
    expect(r.ok).toBe(true);
    // The declared text SURVIVES — the notice is appended, never a replacement. A posture warning
    // that ate the product's own description would be traded for the thing it is meant to add.
    expect(r.openapi?.info.description).toContain('Claims, described.');
    expect(r.openapi?.info.description).toContain(OPENAPI_POSTURE_NOTICE);
    expect(OPENAPI_POSTURE_NOTICE).toContain('NOT internet-facing');
  });

  it('states the posture even when the product declares NO description', async () => {
    // The discrimination control for the arm above: this used to be the branch that emitted no
    // `description` key at all.
    writeFileSync(
      join(dir, 'plain.product.yaml'),
      'version: "1.0"\nproduct: { id: p, name: Plain }\n',
      'utf8',
    );
    const r = await runOpenapi(['plain.product.yaml']);
    expect(r.ok).toBe(true);
    // Asserted against the literal as well as the constant: `toBe(CONSTANT)` alone would pass with
    // both sides undefined, which is exactly the state this arm exists to refuse.
    expect(r.openapi?.info.description).toContain('NOT internet-facing');
    expect(r.openapi?.info.description).toBe(OPENAPI_POSTURE_NOTICE);
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
