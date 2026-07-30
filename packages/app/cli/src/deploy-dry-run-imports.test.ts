/**
 * `rayspec deploy --dry-run` — WHICH module graph a given document shape makes the process load.
 *
 * The dry-run is documented (docs/cli-reference.md) as a fast, DB-free, network-free check, and deploy.ts
 * keeps the boot machinery behind dynamic imports precisely so the non-serving paths never pay for it.
 * `@rayspec/server`'s barrel re-exports the product-boot graph (the durable engine, the model adapters,
 * the postgres driver), so no PRODUCT document must reach for it — neither one that composes nor one an
 * operator is still fixing, which is the document shape a `--dry-run` loop spends its time on. The
 * static-profile classification therefore runs only where the product grammar REJECTED the document AND
 * the document is not the product profile (`isStaticProfile` refuses that profile outright).
 *
 * The `@rayspec/server` mock factory below is the probe: it runs the FIRST time that module is imported,
 * so a counter inside it turns "did this document shape load the boot graph?" into an assertion. Its
 * `detectStaticProfile` deliberately answers "static" for ANY path, so a product document that consulted
 * it would come back with a staticProfile block — a second, independent RED for the same regression. The
 * REAL detection semantics are proven in the server package's static-profile suite and end-to-end through
 * the built CLI in deploy-static-profile.test.ts.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The load counter lives in a hoisted bag: vi.mock is hoisted above the imports, so nothing else is
// visible inside the factory.
const h = vi.hoisted(() => ({ serverLoads: 0 }));

/** The mounts the stubbed detection hands back — matched verbatim by the static case below. */
const STUB_MOUNTS = [{ route: '/', dir: 'web/dist', spa: true }] as const;

vi.mock('@rayspec/server', () => {
  h.serverLoads += 1;
  return {
    detectStaticProfile: (specPath: string) => ({ specPath, frontend: STUB_MOUNTS }),
  };
});

import { runDeploy } from './deploy.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const ACME_REL = 'examples/acme-notes/acme-notes.product.yaml';
/** The negative twin — a PRODUCT document that fails validation (an undeclared artifact contract). */
const ACME_INVALID_REL = 'examples/acme-notes/acme-notes.invalid.product.yaml';
const STATIC_REL = '_deploy_dry_run_imports_static.rayspec.yaml';
const STATIC_DOC = join(repoRoot, STATIC_REL);

/** A FRONTEND-ONLY document — the one shape the product grammar rejects and `deploy` still boots. */
const FRONTEND_ONLY_SPEC = `version: '1.0'
metadata:
  name: static-profile-ui
frontend:
  - { route: /, dir: web/dist, spa: true }
`;

// The read-spec jail resolves against the CWD; run from the repo root so the example path and the temp
// fixture written there are inside the jail.
let prevCwd: string;
beforeEach(() => {
  prevCwd = process.cwd();
  process.chdir(repoRoot);
});
afterEach(() => {
  process.chdir(prevCwd);
  rmSync(STATIC_DOC, { force: true });
});

describe('rayspec deploy --dry-run — the boot dependency graph stays off the composing path', () => {
  it('composing a product document never imports @rayspec/server', async () => {
    const before = h.serverLoads;
    const outcome = await runDeploy(['--dry-run', ACME_REL]);
    if (outcome.kind !== 'dry-run') throw new Error('unreachable');
    expect(outcome.result.composed?.product).toBe('acme_notes');
    // The document composed, so it is a product document — categorically never static, so the
    // classification (and the module behind it) is work this path must not do.
    expect(outcome.result.staticProfile).toBeUndefined();
    expect(h.serverLoads).toBe(before);
  });

  it('a product document that FAILS validation never imports @rayspec/server either', async () => {
    const before = h.serverLoads;
    const outcome = await runDeploy(['--dry-run', ACME_INVALID_REL]);
    if (outcome.kind !== 'dry-run') throw new Error('unreachable');
    // It carries `product:`, so it is the product profile — categorically never static, however many
    // grammar violations it has. The verdict is its violations, and it pays for nothing else.
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.errors.length).toBeGreaterThan(0);
    expect(outcome.result.staticProfile).toBeUndefined();
    expect(h.serverLoads).toBe(before);
  });

  it('a document the product grammar rejects IS classified through the shared detection', async () => {
    writeFileSync(STATIC_DOC, FRONTEND_ONLY_SPEC, 'utf8');
    const outcome = await runDeploy(['--dry-run', STATIC_REL]);
    if (outcome.kind !== 'dry-run') throw new Error('unreachable');
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.staticProfile?.frontendMounts).toEqual(STUB_MOUNTS);
    expect(h.serverLoads).toBeGreaterThan(0);
  });
});
