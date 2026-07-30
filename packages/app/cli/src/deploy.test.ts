/**
 * `rayspec deploy` — the DB-free unit surface: `--dry-run` compose (happy + fail-closed paths), the
 * usage-error mapping, and the STRUCTURAL guards that keep the command on the sanctioned path (it must
 * never build product tables itself, and must never import the frozen-surface `deploy()`).
 *
 * The long-running serve path + the real store registration are proven on ground truth in
 * deploy.db.test.ts (it boots acme-notes through the real CLI and hits a declared route over HTTP).
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerProductStores } from '@rayspec/db/composition';
import { assembleOptsFromEnv, loadServerConfig } from '@rayspec/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeployCliError, runDeploy } from './deploy.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const ACME_REL = 'examples/acme-notes/acme-notes.product.yaml';
const DOCTORED = join(repoRoot, '_deploy_test_doctored.product.yaml');
const GARBAGE = join(repoRoot, '_deploy_test_garbage.product.yaml');
const STATIC_REL = '_deploy_test_static.rayspec.yaml';
const STATIC_DOC = join(repoRoot, STATIC_REL);

/** A FRONTEND-ONLY document — the shape `deploy` boots as the static profile (no DB, no boot secret). */
const FRONTEND_ONLY_SPEC = `version: '1.0'
metadata:
  name: static-profile-ui
frontend:
  - { route: /, dir: web/dist, spa: true }
`;

// The read-spec jail resolves against the CWD; run every dry-run from the repo root so the example
// path (and the temp fixtures written at the root) are inside the jail.
let prevCwd: string;
beforeEach(() => {
  prevCwd = process.cwd();
  process.chdir(repoRoot);
});
afterEach(() => {
  process.chdir(prevCwd);
  rmSync(DOCTORED, { force: true });
  rmSync(GARBAGE, { force: true });
  rmSync(STATIC_DOC, { force: true });
});

describe('rayspec deploy --dry-run', () => {
  it('composes the neutral acme-notes product (ok:true, real store bindings, no DB touched)', async () => {
    const outcome = await runDeploy(['--dry-run', ACME_REL]);
    expect(outcome.kind).toBe('dry-run');
    if (outcome.kind !== 'dry-run') throw new Error('unreachable');
    const r = outcome.result;
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.composed?.product).toBe('acme_notes');
    // The store bindings come from the REAL deriveProductStores (capability + derived stores).
    expect(r.composed?.stores).toEqual(
      expect.arrayContaining([
        'audio_sessions',
        'audio_tracks',
        'note_artifacts',
        'track_transcripts',
      ]),
    );
    expect(r.composed?.triggerEvents).toEqual(['audio_input.finalized_session']);
    expect(r.composed?.workflows).toEqual(['process_session']);
    // The honest boundary is always surfaced.
    expect(r.notProven.length).toBeGreaterThan(0);
  });

  it('fail-closes on an UNWIRED capability with the compose error (ok:false)', async () => {
    // Inject a capability with no wired Tier-B runtime — grammar-valid, but compose rejects it.
    const doctored = readFileSync(join(repoRoot, ACME_REL), 'utf8').replace(
      '  - id: audio_input\n',
      '  - id: notification\n    tier: B\n    status: available\n    contracts:\n      - notification.send\n  - id: audio_input\n',
    );
    writeFileSync(DOCTORED, doctored, 'utf8');
    const outcome = await runDeploy(['--dry-run', '_deploy_test_doctored.product.yaml']);
    if (outcome.kind !== 'dry-run') throw new Error('unreachable');
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.composed).toBeUndefined();
    expect(outcome.result.errors.join(' ')).toMatch(/did not compose.*notification.*no wired/);
  });

  it('fail-closes on a spec that does not validate (ok:false, parse errors surfaced)', async () => {
    writeFileSync(GARBAGE, 'version: "1.0"\nproduct: not-an-object\n', 'utf8');
    const outcome = await runDeploy(['--dry-run', '_deploy_test_garbage.product.yaml']);
    if (outcome.kind !== 'dry-run') throw new Error('unreachable');
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.errors.join(' ')).toMatch(/did not validate/);
  });

  it('a missing spec path is a usage error (DeployCliError → exit 2)', async () => {
    await expect(runDeploy(['--dry-run'])).rejects.toBeInstanceOf(DeployCliError);
  });

  it('an unknown flag is a usage error', async () => {
    await expect(runDeploy(['--dry-run', '--bogus', ACME_REL])).rejects.toBeInstanceOf(
      DeployCliError,
    );
  });

  it('a spec path escaping the CWD is refused (fail-closed jail)', async () => {
    await expect(runDeploy(['--dry-run', '../etc/passwd'])).rejects.toBeInstanceOf(DeployCliError);
  });
});

/**
 * `--dry-run` against a FRONTEND-ONLY (static-profile) document — the doc `deploy` itself boots on the
 * DB-less static branch. Composing it was never the question: it is not a product document, so the
 * verdict has to report the profile it would boot instead of rejecting the shape.
 */
describe('rayspec deploy --dry-run — a frontend-only (static-profile) document', () => {
  beforeEach(() => {
    writeFileSync(STATIC_DOC, FRONTEND_ONLY_SPEC, 'utf8');
  });

  it('answers ok:true, naming the static profile and the mounts it would serve', async () => {
    const outcome = await runDeploy(['--dry-run', STATIC_REL]);
    if (outcome.kind !== 'dry-run') throw new Error('unreachable');
    const r = outcome.result;
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    // A static profile declares no store/route/trigger/workflow — there is nothing to compose, so the
    // compose summary is absent and the static block carries the answer instead.
    expect(r.composed).toBeUndefined();
    expect(r.staticProfile?.profile).toBe('static');
    expect(r.staticProfile?.frontendMounts).toEqual([{ route: '/', dir: 'web/dist', spa: true }]);
    // The three facts stated outright rather than left to inference.
    const notes = (r.staticProfile?.notes ?? []).join(' ');
    expect(notes).toMatch(/no database/);
    expect(notes).toMatch(/no migration/);
    expect(notes).toMatch(/nothing to compose/);
    // The honest boundary is still carried (a document-only check binds no port).
    expect(r.notProven.length).toBeGreaterThan(0);
  });

  it('leaves a product document on the compose path (no static block, same boundary)', async () => {
    const outcome = await runDeploy(['--dry-run', ACME_REL]);
    if (outcome.kind !== 'dry-run') throw new Error('unreachable');
    expect(outcome.result.staticProfile).toBeUndefined();
    expect(outcome.result.composed?.product).toBe('acme_notes');
    expect(outcome.result.notProven).toEqual(
      expect.arrayContaining(['the migration (no DB was touched)']),
    );
  });

  it('--apply-migration with --dry-run stays refused against it (a dry-run applies no migration)', async () => {
    await expect(
      runDeploy(['--dry-run', '--apply-migration', 'delta.sql', STATIC_REL]),
    ).rejects.toBeInstanceOf(DeployCliError);
  });
});

describe('rayspec deploy — structural guards (stays on the sanctioned path)', () => {
  const rawSrc = readFileSync(join(here, 'deploy.ts'), 'utf8');
  // Strip comments so a prose mention of the frozen-surface `deploy()` is not a false positive on the
  // call-site checks below (we assert the CODE never calls it, not that the file never names it).
  const code = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('NEVER builds product tables itself; it wires the SHARED opts builder (assembleOptsFromEnv), not a bare registrar', () => {
    // A CLI that called buildProductTables would over-register / pollute SCOPED. Its registration flows
    // through the SAME `assembleOptsFromEnv` builder rayspec-serve uses (which wires registerProductStores
    // + the env-driven agent-backend factory) — NOT a hand-rolled bare `{ registerProductTables }`, which
    // would DROP the agent factory so a backend-profile spec WITH agents would boot without its agents.
    expect(code).not.toMatch(/buildProductTables/);
    expect(code).toMatch(/assembleServer\(\s*config,\s*assembleOptsFromEnv\(config\)\s*\)/);
    // REDs if the CLI reverts to the pre-parity bare registrar (the form that dropped the agent factory).
    expect(code).not.toMatch(/registerProductTables:\s*registerProductStores/);
  });

  it('wraps assembleServer, NOT the frozen-surface deploy()', () => {
    expect(code).toMatch(/assembleServer/);
    // deploy() (the frozen-surface roll-out) is only referenced via the DeployError TYPE it exports — never
    // imported or called as a function in the CODE.
    expect(code).not.toMatch(/\bdeploy\s*\(/);
  });

  it('seals the sanctioned door after boot', () => {
    expect(code).toMatch(/sealProductStores\s*\(\s*\)/);
  });

  it('binds the RESOLVED host (hostname: config.host) and logs the real bind, never a hard-coded loopback', () => {
    // The loopback-default wiring must reach the listener: `rayspec deploy` passes `hostname: config.host`
    // to serve() and logs the ACTUAL bound address (bootBaseUrl(info.address)). A boot test can't catch a
    // dropped hostname — an all-interfaces bind also answers on 127.0.0.1 — so guard the wiring at the
    // source, in parity with the rayspec-serve entrypoint's guard in @rayspec/server.
    expect(code).toMatch(/hostname:\s*config\.host/);
    expect(code).toMatch(/bootBaseUrl\(\s*info\.address/);
  });
});

/**
 * The FUNCTIONAL fail-the-fix for the agent-boot parity: `serveDeployment` composes
 * `assembleServer(config, assembleOptsFromEnv(config))` (asserted structurally above). Here we prove the
 * builder the CLI hands to assembleServer actually yields the env-driven agent factory for a
 * backend-profile spec WITH agents — so `rayspec deploy <such-spec>` boots its declared agents (parity
 * with rayspec-serve). DB-free: `assembleOptsFromEnv` only reads the spec file + constructs the adapter
 * (no network, no DB); `loadServerConfig` shape-checks three dummy boot secrets.
 */
describe('rayspec deploy — wires the agent-backend factory for a backend-profile spec with agents', () => {
  // A committed backend-profile example that declares an `openai` agent (the same doc the README/smoke use).
  const LEAD_QUALIFIER = join(repoRoot, 'examples/lead-qualifier/lead-qualifier.rayspec.yaml');
  const baseConfig = loadServerConfig({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    RAYSPEC_JWT_SIGNING_KEY: 'dummy-not-a-real-pem',
    RAYSPEC_API_KEY_PEPPER: 'dummy-pepper',
  });

  it('a backend-profile spec WITH an agent → the sanctioned validating registrar + an agent factory', () => {
    const opts = assembleOptsFromEnv(
      { ...baseConfig, specPath: LEAD_QUALIFIER },
      { OPENAI_API_KEY: 'sk-dummy-not-a-real-key' },
    );
    // The SAME sanctioned validating registrar (registerProductStores) rayspec-serve wires — by identity.
    expect(opts.registerProductTables).toBe(registerProductStores);
    // The env-driven agent-backend factory — the whole point of the parity fix; a bare
    // `{ registerProductTables }` (the pre-fix CLI form) would leave this undefined.
    expect(opts.agentBackendsFactory).toBeTypeOf('function');
  });
});
