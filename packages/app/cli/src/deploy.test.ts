/**
 * `rayspec deploy` — the DB-free unit surface: `--dry-run` compose (happy + fail-closed paths), the
 * usage-error mapping, and the STRUCTURAL guards that keep the command on the sanctioned path (it must
 * never build product tables itself, and must never import the kill-set `deploy()`).
 *
 * The long-running serve path + the real store registration are proven on ground truth in
 * deploy.db.test.ts (it boots acme-notes through the real CLI and hits a declared route over HTTP).
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeployCliError, runDeploy } from './deploy.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const ACME_REL = 'examples/acme-notes/acme-notes.product.yaml';
const DOCTORED = join(repoRoot, '_deploy_test_doctored.product.yaml');
const GARBAGE = join(repoRoot, '_deploy_test_garbage.product.yaml');

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

describe('rayspec deploy — structural guards (stays on the sanctioned path)', () => {
  const rawSrc = readFileSync(join(here, 'deploy.ts'), 'utf8');
  // Strip comments so a prose mention of the kill-set `deploy()` is not a false positive on the
  // call-site checks below (we assert the CODE never calls it, not that the file never names it).
  const code = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('NEVER builds product tables itself (its only registration surface is the assembleServer callback)', () => {
    // A CLI that called buildProductTables would over-register / pollute SCOPED — its sole registration
    // path must be `registerProductTables: registerProductStores` passed to assembleServer.
    expect(code).not.toMatch(/buildProductTables/);
    expect(code).toMatch(/registerProductTables:\s*registerProductStores/);
  });

  it('wraps assembleServer, NOT the kill-set deploy()', () => {
    expect(code).toMatch(/assembleServer/);
    // deploy() (the kill-set roll-out) is only referenced via the DeployError TYPE it exports — never
    // imported or called as a function in the CODE.
    expect(code).not.toMatch(/\bdeploy\s*\(/);
  });

  it('seals the sanctioned door after boot', () => {
    expect(code).toMatch(/sealProductStores\s*\(\s*\)/);
  });
});
