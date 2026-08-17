/**
 * The reserved-path rule is visible to the READ-ONLY FLOOR — `doctor`, `plan` and `deploy --dry-run`
 * over the SAME document, in one place.
 *
 * A declared `api[]` route may not claim a path the platform registers itself: the auth/run surface
 * (`/v1/`), the OIDC mount (`/oidc/`), the two readiness probes (`/health/`, `/recovery-scope/`) or a
 * declared static frontend mount. The boot refuses such a document; the rule is STATIC — it resolves
 * nothing, opens no socket and reads no database — so the floor an author iterates against answers it
 * too, and answers it in the boot's own words.
 *
 * Each command is driven at its own entry point (`runDoctor` / `runPlan` / `runDeploy --dry-run`), so
 * the three verdicts are independent readings of the same document rather than one shared call.
 *
 * ACCEPT CONTROL: the same fixtures with the route moved one character out of the reserved set
 * (`/healthy`) and the mount at the ROOT (which stays exempt and served) must still pass all three —
 * a rule that refused everything would satisfy the refusals above while breaking every real document.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDeploy } from './deploy.js';
import { runDoctor } from './doctor.js';
import { runPlan } from './plan.js';

/** A document whose declared route claims the generic readiness probe path. */
const CLAIMS_HEALTH = `version: '1.0'
metadata: { name: claims-health }
stores:
  - name: notes
    columns: [{ name: body, type: text }]
api:
  - { method: GET, path: '/health', action: { kind: store, store: notes, op: list } }
`;

/** The same document with the route one character outside the reserved set — the ACCEPT control. */
const CLAIMS_HEALTHY = CLAIMS_HEALTH.replace("'/health'", "'/healthy'").replace(
  'claims-health',
  'claims-healthy',
);

/** A document whose declared route sits UNDER a declared non-root static frontend mount. */
const UNDER_MOUNT = `version: '1.0'
metadata: { name: under-mount }
stores:
  - name: notes
    columns: [{ name: body, type: text }]
api:
  - { method: GET, path: '/app/notes', action: { kind: store, store: notes, op: list } }
frontend:
  - { route: /app, dir: web/dist, spa: true }
`;

/** The same routes under a ROOT mount, which stays exempt and served — the second ACCEPT control. */
const UNDER_ROOT_MOUNT = UNDER_MOUNT.replace('route: /app,', 'route: /,').replace(
  'under-mount',
  'under-root-mount',
);

let dir = '';
let prevCwd = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayspec-reserved-route-'));
  // A readable directory of built assets, so the only thing `doctor` can complain about is the route.
  mkdirSync(join(dir, 'web', 'dist'), { recursive: true });
  writeFileSync(join(dir, 'web', 'dist', 'index.html'), '<!doctype html>\n', 'utf8');
  writeFileSync(join(dir, 'claims-health.yaml'), CLAIMS_HEALTH, 'utf8');
  writeFileSync(join(dir, 'claims-healthy.yaml'), CLAIMS_HEALTHY, 'utf8');
  writeFileSync(join(dir, 'under-mount.yaml'), UNDER_MOUNT, 'utf8');
  writeFileSync(join(dir, 'under-root-mount.yaml'), UNDER_ROOT_MOUNT, 'utf8');
  // The read-spec jail resolves against the CWD; run every command from the fixture directory.
  prevCwd = process.cwd();
  process.chdir(dir);
});

afterAll(() => {
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

/**
 * `deploy --dry-run` over one fixture, unwrapped to the verdict the CLI prints. Its `errors` are the
 * flattened `spec did not validate: <code> at <path>: <message>` lines, so the finding is read out of
 * the text rather than off a field.
 */
async function dryRun(file: string): Promise<{ ok: boolean; errors: readonly string[] }> {
  const outcome = await runDeploy(['--dry-run', file]);
  if (outcome.kind !== 'dry-run') throw new Error(`expected a dry-run verdict for ${file}`);
  return { ok: outcome.result.ok, errors: outcome.result.errors };
}

describe('the floor refuses a declared route that claims a platform path', () => {
  it('doctor reports the collision in the boot wording, at the offending route', async () => {
    const r = await runDoctor(['claims-health.yaml']);
    expect(r.ok).toBe(false);
    const found = r.errors.find((e) => e.code === 'reserved_route_path');
    expect(found).toBeDefined();
    expect(found?.path).toBe('api[0].path');
    expect(found?.message).toContain('under a RESERVED platform prefix');
    expect(found?.message).toContain('/health/');
    expect(found?.message).toContain('GET /health');
  });

  it('plan refuses at the validate phase with the same finding', async () => {
    const r = await runPlan(['claims-health.yaml'], { shadowDatabaseUrl: undefined });
    expect(r.ok).toBe(false);
    expect(r.phase).toBe('validate');
    expect(r.errors.map((e) => e.code)).toContain('reserved_route_path');
  });

  it('deploy --dry-run refuses with the same finding', async () => {
    const r = await dryRun('claims-health.yaml');
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('reserved_route_path at api[0].path');
    expect(r.errors.join('\n')).toContain('under a RESERVED platform prefix');
  });
});

describe('the floor refuses a declared route under a declared static frontend mount', () => {
  it('doctor names the mount prefix the route would shadow', async () => {
    const r = await runDoctor(['under-mount.yaml']);
    expect(r.ok).toBe(false);
    const found = r.errors.find((e) => e.code === 'reserved_route_path');
    expect(found).toBeDefined();
    expect(found?.path).toBe('api[0].path');
    expect(found?.message).toContain('/app/');
  });

  it('plan and deploy --dry-run refuse the same document', async () => {
    const planned = await runPlan(['under-mount.yaml'], { shadowDatabaseUrl: undefined });
    expect(planned.ok).toBe(false);
    expect(planned.errors.map((e) => e.code)).toContain('reserved_route_path');
    const dry = await dryRun('under-mount.yaml');
    expect(dry.ok).toBe(false);
    expect(dry.errors.join('\n')).toContain('reserved_route_path');
  });
});

describe('accept control — a document one character outside the rule still passes all three', () => {
  it('`/healthy` is not under `/health/`', async () => {
    const doctored = await runDoctor(['claims-healthy.yaml']);
    expect(doctored.errors).toEqual([]);
    expect(doctored.ok).toBe(true);
    const planned = await runPlan(['claims-healthy.yaml'], { shadowDatabaseUrl: undefined });
    expect(planned.ok).toBe(true);
    expect(await dryRun('claims-healthy.yaml')).toEqual({ ok: true, errors: [] });
  });

  it('a mount at the ROOT reserves nothing — every declared route stays servable', async () => {
    const doctored = await runDoctor(['under-root-mount.yaml']);
    expect(doctored.errors).toEqual([]);
    expect(doctored.ok).toBe(true);
    const planned = await runPlan(['under-root-mount.yaml'], { shadowDatabaseUrl: undefined });
    expect(planned.ok).toBe(true);
    expect(await dryRun('under-root-mount.yaml')).toEqual({ ok: true, errors: [] });
  });
});
