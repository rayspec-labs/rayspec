/**
 * `rayspec deploy --dry-run` on a BACKEND-profile document, driven through the REAL CLI — a spawned
 * `node dist/index.js deploy --dry-run …` subprocess whose EXIT CODE and stdout JSON are the assertions.
 *
 * WHY at this level. The symptom this arm exists to fix is an exit code: a document `deploy` validates
 * and boots answered `exit 1` with product-grammar violations, and a caller gating on the verdict saw
 * only that. The exit code is produced in index.ts (`outcome.result.ok ? 0 : 1`), OUTSIDE `runDeploy`,
 * so the in-process suite in deploy.test.ts — which asserts on `outcome.result` — cannot reach it, and
 * neither can it prove the verdict reaches stdout as parseable JSON. Both directions are pinned here on
 * the shipped bin, the twin of the frontend-only case in deploy-static-profile.test.ts:
 *
 *   (a) a valid backend document → exit 0, `ok:true`, the `backendProfile` block;
 *   (b) a backend document with a dangling handler reference → exit 1 carrying the document's OWN
 *       `dangling_ref` and NOT the `no_code_in_yaml` product lint it used to be drowned in.
 *
 * No database and no boot secret are involved: a dry run opens no socket and touches no DB.
 *
 * The unit under test is the BUILT CLI (packages/app/cli/dist/index.js) — run `pnpm build` before this
 * suite. Its absence is handled EXACTLY as deploy-static-profile.test.ts handles it (self-skip locally,
 * un-skippable throw where CI requires the built bin); that file carries the full reasoning for the
 * shape, and packages/app/cli/turbo.json hashes the same dist entry into this package's test task, so
 * one build invalidates the recorded skip for both.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const CLI_DIST = join(repoRoot, 'packages/app/cli/dist/index.js');

// The dist guard — identical in behaviour to deploy-static-profile.test.ts's (see its header for the
// full reasoning): a self-skip is an ergonomic local default, but where the built bin is REQUIRED it
// must not become a false green.
const distBuilt = existsSync(CLI_DIST);
if (process.env.CI && !distBuilt) {
  throw new Error(`built CLI not found at ${CLI_DIST} — run \`pnpm build\` before this suite`);
}
if (!distBuilt) {
  process.stderr.write(
    `deploy-dry-run-backend.test: SKIPPING — built CLI not found at ${CLI_DIST}.\n` +
      'This suite drives the REAL `node dist/index.js`; run `pnpm build` first.\n',
  );
}
const maybeDescribe = distBuilt ? describe : describe.skip;

/** A BACKEND-profile document — a store, a handler-backed route and a bundled UI mount. */
const BACKEND_SPEC = `version: '1.0'
metadata: { name: notes-api }
stores:
  - name: notes
    columns: [{ name: body, type: text }]
api:
  - { method: POST, path: '/notes', action: { kind: handler, handler: add_note } }
handlers:
  - { id: add_note, module: handlers/notes.mjs, export: addNote, kind: route }
frontend:
  - { route: /, dir: web/dist, spa: true }
`;

/** The SAME document with the route pointing at a handler id nothing declares — `doctor`'s `dangling_ref`. */
const DANGLING_SPEC = BACKEND_SPEC.replace('handler: add_note }', 'handler: missing_handler }');

/** A FRONTEND-ONLY document — the ordering control: the static arm must still answer this one. */
const FRONTEND_ONLY_SPEC = `version: '1.0'
metadata: { name: static-profile-ui }
frontend:
  - { route: /, dir: web/dist, spa: true }
`;

let root = ''; // the fixture project: the three documents + a handler module + the built assets

beforeAll(() => {
  if (!distBuilt) return; // every describe below is skipped; build no fixture for a skipped run
  root = mkdtempSync(join(tmpdir(), 'rayspec-cli-dry-run-backend-'));
  mkdirSync(join(root, 'web', 'dist'), { recursive: true });
  mkdirSync(join(root, 'handlers'), { recursive: true });
  writeFileSync(
    join(root, 'web', 'dist', 'index.html'),
    '<!doctype html><title>ui</title>',
    'utf8',
  );
  // The module is never LOADED by a dry run (that is one of the things `notProven` says it does not
  // prove); it exists so the fixture is a document an operator could actually boot.
  writeFileSync(
    join(root, 'handlers', 'notes.mjs'),
    'export async function addNote() {\n  return { status: 201, body: {} };\n}\n',
    'utf8',
  );
  writeFileSync(join(root, 'backend.rayspec.yaml'), BACKEND_SPEC, 'utf8');
  writeFileSync(join(root, 'dangling.rayspec.yaml'), DANGLING_SPEC, 'utf8');
  writeFileSync(join(root, 'frontend-only.rayspec.yaml'), FRONTEND_ONLY_SPEC, 'utf8');
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/**
 * Run the built CLI's `deploy --dry-run` on a fixture document and return its exit code + both streams.
 * The environment is built EXPLICITLY (never inherited) so no ambient boot secret and no repo-root
 * `.env` can reach the child — a dry run must need none of them.
 */
async function dryRun(
  spec: string,
  cwd: string = root,
): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn(process.execPath, [CLI_DIST, 'deploy', '--dry-run', spec], {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', RAYSPEC_SKIP_DOTENV: '1' },
  });
  let out = '';
  let err = '';
  child.stdout?.on('data', (d) => {
    out += String(d);
  });
  child.stderr?.on('data', (d) => {
    err += String(d);
  });
  const code = await new Promise<number | null>((r) => {
    child.on('exit', (c) => r(c));
  });
  return { code, out, err };
}

maybeDescribe('rayspec deploy --dry-run — a backend document, through the built CLI', () => {
  it('exits 0 with ok:true and the backendProfile block on stdout', async () => {
    const { code, out, err } = await dryRun('./backend.rayspec.yaml');
    expect(code, `--- stdout ---\n${out}\n--- stderr ---\n${err}`).toBe(0);
    const verdict = JSON.parse(out);
    expect(verdict.ok).toBe(true);
    expect(verdict.mode).toBe('dry-run');
    expect(verdict.errors).toEqual([]);
    // Judged by the backend grammar — none of the product lint the product ruleset produced for it.
    expect(out).not.toMatch(/no_code_in_yaml/);
    expect(verdict.backendProfile).toEqual({
      profile: 'rayspec',
      stores: ['notes'],
      routes: ['POST /notes'],
      agents: [],
      handlers: ['add_note'],
      // A backend document MAY also serve a bundled UI; the mounts boot gates on are named, not dropped.
      frontendMounts: [{ route: '/', dir: 'web/dist', spa: true }],
    });
    // Nothing composed, and this is not the static profile — both blocks stay absent.
    expect(verdict.composed).toBeUndefined();
    expect(verdict.staticProfile).toBeUndefined();
    // ok:true means the document VALIDATES; every boot refusal it can still meet is named in the
    // verdict itself, INCLUDING the frontend-mount gate this profile's boot applies fail-closed.
    const notProven = verdict.notProven.join(' ');
    expect(notProven).toMatch(/stream.*blob backend/);
    expect(notProven).toMatch(/handler modules resolve/);
    expect(notProven).toMatch(/STT_PROVIDER \/ TTS_PROVIDER/);
    expect(notProven).toMatch(/frontend directories hold servable built assets/);
  }, 60_000);

  it('exits 1 reporting the document own dangling_ref, never the product lint', async () => {
    const { code, out, err } = await dryRun('./dangling.rayspec.yaml');
    expect(code, `--- stdout ---\n${out}\n--- stderr ---\n${err}`).toBe(1);
    const verdict = JSON.parse(out);
    expect(verdict.ok).toBe(false);
    expect(verdict.backendProfile).toBeUndefined();
    expect(verdict.errors.join(' ')).toMatch(/dangling_ref.*missing_handler/);
    expect(verdict.errors.join(' ')).not.toMatch(/no_code_in_yaml/);
  }, 60_000);

  it('omits frontendMounts entirely when the document declares no frontend', async () => {
    // ADDITIVE-ness of the mount echo: a backend document without a `frontend:` section keeps the
    // payload it had, so nothing gained an empty array.
    writeFileSync(
      join(root, 'no-ui.rayspec.yaml'),
      BACKEND_SPEC.slice(0, BACKEND_SPEC.indexOf('frontend:')),
      'utf8',
    );
    const { code, out, err } = await dryRun('./no-ui.rayspec.yaml');
    expect(code, `--- stdout ---\n${out}\n--- stderr ---\n${err}`).toBe(0);
    const verdict = JSON.parse(out);
    expect(verdict.ok).toBe(true);
    expect(verdict.backendProfile.handlers).toEqual(['add_note']);
    expect('frontendMounts' in verdict.backendProfile).toBe(false);
  }, 60_000);

  it('still answers a frontend-only document with its staticProfile block (the ordering control)', async () => {
    // `detectSpecKind` calls both profiles 'rayspec', so a backend arm placed ahead of the static
    // classification would swallow this verdict. Asserted on the shipped bin, not only in-process.
    const { code, out, err } = await dryRun('./frontend-only.rayspec.yaml');
    expect(code, `--- stdout ---\n${out}\n--- stderr ---\n${err}`).toBe(0);
    const verdict = JSON.parse(out);
    expect(verdict.ok).toBe(true);
    expect(verdict.backendProfile).toBeUndefined();
    expect(verdict.staticProfile.profile).toBe('static');
    expect(verdict.staticProfile.frontendMounts).toEqual([
      { route: '/', dir: 'web/dist', spa: true },
    ]);
  }, 60_000);

  it('leaves a product document on the compose path (exit 0, composed, no backend block)', async () => {
    // The other control: the arm added for the backend profile must change nothing for the profile
    // that always had one. Run from the repo root — the shipped example lives inside its spec-path jail.
    const { code, out, err } = await dryRun(
      './examples/acme-notes/acme-notes.product.yaml',
      repoRoot,
    );
    expect(code, `--- stdout ---\n${out}\n--- stderr ---\n${err}`).toBe(0);
    const verdict = JSON.parse(out);
    expect(verdict.ok).toBe(true);
    expect(verdict.composed.product).toBe('acme_notes');
    expect(verdict.backendProfile).toBeUndefined();
    expect(verdict.staticProfile).toBeUndefined();
  }, 60_000);
});
