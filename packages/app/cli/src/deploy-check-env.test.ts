/**
 * `rayspec deploy --check-env`, driven through the REAL CLI — a spawned `node dist/index.js deploy
 * --check-env …` subprocess whose EXIT CODE, stdout JSON and (crucially) NETWORK SILENCE are the
 * assertions.
 *
 * WHY at this level. The whole point of the flag is that answering "what will this document need?" must
 * cost nothing: no socket, no database, no credential. That is a property of the PROCESS, not of a
 * function's return value, so it is proven on the shipped bin — the child is given a `DATABASE_URL`
 * pointing at a port nothing listens on, every `<VAR>_FILE` mount pointing at a path that does not
 * exist, and a `RAYSPEC_BLOB_ROOT` under a directory that was never created. A check that opened any of
 * them would hang, throw ENOENT, or refuse; it answers instead, in milliseconds.
 *
 * The exit code is produced in index.ts (`outcome.result.ok ? 0 : 1`), OUTSIDE `runDeploy`, so the
 * in-process suite in deploy.test.ts cannot reach it — the same reason deploy-dry-run-backend.test.ts
 * spawns the bin. The dist guard below is that suite's, verbatim in behaviour (self-skip locally,
 * un-skippable throw where CI requires the built bin); packages/app/cli/turbo.json hashes the same dist
 * entry into this package's test task, so one build invalidates the recorded skip for all of them.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const CLI_DIST = join(repoRoot, 'packages/app/cli/dist/index.js');

const distBuilt = existsSync(CLI_DIST);
if (process.env.CI && !distBuilt) {
  throw new Error(`built CLI not found at ${CLI_DIST} — run \`pnpm build\` before this suite`);
}
if (!distBuilt) {
  process.stderr.write(
    `deploy-check-env.test: SKIPPING — built CLI not found at ${CLI_DIST}.\n` +
      'This suite drives the REAL `node dist/index.js`; run `pnpm build` first.\n',
  );
}
const maybeDescribe = distBuilt ? describe : describe.skip;

/** A backend document whose boot demands COMPOUND: a playback stream route, a cron trigger, an agent. */
const COMPOUND_SPEC = `version: '1.0'
metadata: { name: check-env-fixture }
stores:
  - name: recordings
    columns: [{ name: title, type: text }]
api:
  - { method: GET, path: '/recordings', action: { kind: store, store: recordings, op: list } }
  - { method: POST, path: '/recordings/write', action: { kind: agent, agent: a1 } }
  - { method: GET, path: '/recordings/{id}/media', action: { kind: stream, handler: h1, mode: playback } }
agents:
  - { id: a1, name: a1, backend: anthropic, model: m, instructions: hi }
triggers:
  - name: nightly
    kind: cron
    schedule: '0 3 * * *'
    action: { kind: handler, handler: h2 }
handlers:
  - { id: h1, module: handlers/a.js, export: a, kind: route }
  - { id: h2, module: handlers/b.js, export: b, kind: trigger }
deployment:
  durableWorker: true
`;

/** The SAME document with an `openai` agent instead — it selects no anthropic backend at all. */
const OPENAI_ONLY_SPEC = `version: '1.0'
metadata: { name: check-env-openai-only }
stores:
  - name: recordings
    columns: [{ name: title, type: text }]
api:
  - { method: GET, path: '/recordings', action: { kind: store, store: recordings, op: list } }
  - { method: POST, path: '/recordings/write', action: { kind: agent, agent: a1 } }
agents:
  - { id: a1, name: a1, backend: openai, model: m, instructions: hi }
`;

/** A FRONTEND-ONLY document — the profile that must be told to set NONE of the platform secrets. */
const FRONTEND_ONLY_SPEC = `version: '1.0'
metadata: { name: static-profile-ui }
frontend:
  - { route: /, dir: web/dist, spa: true }
`;

/**
 * A document declaring the EXPERIMENTAL `workforce:` section — the fail-closed opt-in arms below.
 * Deliberately minimal: one agent, one orchestrator seat, nothing that adds a boot demand of its
 * own beyond the agent's backend credential, so the accept arm's demand list stays legible.
 */
const WORKFORCE_SPEC = `version: '1.0'
metadata: { name: check-env-workforce }
deployment:
  durableWorker: true
agents:
  - { id: a1, name: a1, backend: openai, model: m, instructions: hi }
workforce:
  id: helpdesk
  name: Helpdesk
  orchestrator: lead
  employees:
    - id: lead
      agent: a1
      title: Lead
      role: orchestrator
`;

let root = '';

beforeAll(() => {
  if (!distBuilt) return;
  root = mkdtempSync(join(tmpdir(), 'rayspec-cli-check-env-'));
  writeFileSync(join(root, 'compound.rayspec.yaml'), COMPOUND_SPEC, 'utf8');
  writeFileSync(join(root, 'openai-only.rayspec.yaml'), OPENAI_ONLY_SPEC, 'utf8');
  writeFileSync(join(root, 'frontend-only.rayspec.yaml'), FRONTEND_ONLY_SPEC, 'utf8');
  writeFileSync(join(root, 'workforce.rayspec.yaml'), WORKFORCE_SPEC, 'utf8');
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/**
 * Run the built CLI's `deploy --check-env` on a fixture document. The environment is built EXPLICITLY
 * (never inherited), so no ambient boot secret and no repo-root `.env` can reach the child.
 */
async function checkEnv(
  args: readonly string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; out: string; err: string; ms: number }> {
  const started = Date.now();
  const child = spawn(process.execPath, [CLI_DIST, 'deploy', ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      RAYSPEC_SKIP_DOTENV: '1',
      ...extraEnv,
    },
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
  return { code, out, err, ms: Date.now() - started };
}

maybeDescribe('rayspec deploy --check-env — the demands, through the built CLI', () => {
  it('exits 1 naming every unmet demand, with what raised each one', async () => {
    const { code, out, err } = await checkEnv(['--check-env', './compound.rayspec.yaml']);
    expect(code, `--- stdout ---\n${out}\n--- stderr ---\n${err}`).toBe(1);
    const verdict = JSON.parse(out);
    expect(verdict.ok).toBe(false);
    expect(verdict.mode).toBe('check-env');
    expect(verdict.profile).toBe('rayspec');
    expect(verdict.missing).toEqual([
      'DATABASE_URL',
      'RAYSPEC_JWT_SIGNING_KEY',
      'RAYSPEC_API_KEY_PEPPER',
      'RAYSPEC_BLOB_ROOT',
      'RAYSPEC_MEDIA_SIGNING_KEY',
      'RAYSPEC_CRON_TENANT_ID',
      'RAYSPEC_ANTHROPIC_CONFIG_ROOT',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ]);
    // Every row says what raised it, and the three secrets name their <VAR>_FILE equivalent.
    const byName = Object.fromEntries(
      (verdict.required as { name: string }[]).map((r) => [r.name, r]),
    );
    expect(byName.DATABASE_URL.fileVariant).toBe('DATABASE_URL_FILE');
    expect(byName.RAYSPEC_BLOB_ROOT.because[0]).toContain("declares a 'stream' route");
    expect(byName.RAYSPEC_CRON_TENANT_ID.because[0]).toContain('cron/manual trigger(s)');
    expect(byName.RAYSPEC_ANTHROPIC_CONFIG_ROOT.because[0]).toContain(
      "declared agent(s) [a1] select backend 'anthropic'",
    );
    // The anthropic credential is ONE demand with a choice, never two independent ones.
    expect(byName.CLAUDE_CODE_OAUTH_TOKEN.orAnyOf).toEqual([
      { name: 'ANTHROPIC_API_KEY', set: false },
    ]);
  });

  it('exits 0 once the environment meets every demand', async () => {
    const { code, out, err } = await checkEnv(['--check-env', './compound.rayspec.yaml'], {
      DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/db',
      RAYSPEC_JWT_SIGNING_KEY: 'pem',
      RAYSPEC_API_KEY_PEPPER: 'pepper',
      RAYSPEC_BLOB_ROOT: '/tmp/does-not-exist-blob-root',
      RAYSPEC_MEDIA_SIGNING_KEY: 'k',
      RAYSPEC_CRON_TENANT_ID: 'not-a-uuid',
      RAYSPEC_ANTHROPIC_CONFIG_ROOT: '/tmp/does-not-exist-anthropic',
      ANTHROPIC_API_KEY: 'k',
    });
    expect(code, `--- stdout ---\n${out}\n--- stderr ---\n${err}`).toBe(0);
    const verdict = JSON.parse(out);
    expect(verdict.ok).toBe(true);
    expect(verdict.missing).toEqual([]);
    // …and it is HONEST that a set value is not a valid one: the media key is one byte, the cron
    // tenant is not a UUID, and both directories are absent. Every one of those still refuses a boot.
    expect((verdict.notChecked as string[]).join(' ')).toContain('no VALUE is validated');
  });

  it('tells a frontend-only document it needs NONE of the three platform secrets', async () => {
    const { code, out } = await checkEnv(['--check-env', './frontend-only.rayspec.yaml']);
    expect(code).toBe(0);
    const verdict = JSON.parse(out);
    expect(verdict.profile).toBe('static');
    expect(verdict.required).toEqual([]);
    expect((verdict.notChecked as string[]).join(' ')).toContain(
      'reads NONE of the three platform secrets',
    );
  });

  it('states the pack boundary rather than hiding it', async () => {
    const { out } = await checkEnv(['--check-env', './compound.rayspec.yaml']);
    const notChecked = (JSON.parse(out).notChecked as string[]).join(' ');
    expect(notChecked).toContain('no extension pack is loaded');
    // BOTH directions, and BOTH of the adding ones: a pack removes a demand by supplying a blob
    // backend, and adds one with a contributed ROUTE as well as with a contributed agent. The route
    // direction is the one a document can hit while declaring no api section of its own at all.
    expect(notChecked).toContain('REMOVE one');
    expect(notChecked).toContain('pack-contributed api route adds the RAYSPEC_BLOB_ROOT demand');
    expect(notChecked).toContain("RAYSPEC_MEDIA_SIGNING_KEY demand (mode:'playback')");
    expect(notChecked).toContain('pack-contributed agent adds its backend credential demand');
  });

  it("does not invent a refusal for a posture flag this document's boot never reads", async () => {
    // RAYSPEC_ANTHROPIC_REUSE_LOGIN is read in ONE place: the anthropic backend's construction. This
    // document selects `openai`, so an unrecognised value is not a refusal for it — the boot builds
    // the factory and serves. A verdict that reds here would be a demand the boot does not raise,
    // reported by the command that exists to pre-empt real ones.
    const { code, out, err } = await checkEnv(['--check-env', './openai-only.rayspec.yaml'], {
      DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/db',
      RAYSPEC_JWT_SIGNING_KEY: 'pem',
      RAYSPEC_API_KEY_PEPPER: 'pepper',
      OPENAI_API_KEY: 'k',
      RAYSPEC_ANTHROPIC_REUSE_LOGIN: 'maybe',
    });
    expect(code, `--- stdout ---\n${out}\n--- stderr ---\n${err}`).toBe(0);
    const verdict = JSON.parse(out);
    expect(verdict.ok).toBe(true);
    expect(verdict.errors).toEqual([]);
  });

  it('names the .env files its auto-loader searched — the usual cause of a disputed "unset"', async () => {
    const { out } = await checkEnv(['--check-env', './compound.rayspec.yaml']);
    // RAYSPEC_SKIP_DOTENV=1 in the child: nothing was searched, so claiming otherwise would be false.
    expect(JSON.parse(out).searchedDotenv).toEqual([]);
    const loaded = await checkEnv(['--check-env', './compound.rayspec.yaml'], {
      RAYSPEC_SKIP_DOTENV: '0',
    });
    expect((JSON.parse(loaded.out).searchedDotenv as string[]).length).toBeGreaterThan(0);
  });

  // ── The EXPERIMENTAL workforce opt-in, on a path an operator actually runs before shipping ──
  //
  // `--check-env` reaches the gate through `checkBootEnv` -> `parseSpec(specText,
  // experimentalSpecOptionsFromEnv(env))` (@rayspec/server boot-env-demands.ts), i.e. the SAME
  // derivation doctor/plan/deploy/serve use — but nothing proved it: this file contained no
  // occurrence of "workforce" or "experimental" at all, and none of the suites that mention
  // RAYSPEC_EXPERIMENTAL_WORKFORCE drove `--check-env`.
  //
  // The environment here is the harness's, built EXPLICITLY and never inherited, so the flag-unset
  // arm is hermetic by construction: no ambient export in a developer's shell can reach the child.
  //
  // The two arms DISCRIMINATE. Both exit 1 — for entirely different reasons — so asserting the exit
  // code alone would pass against a `--check-env` that refused every document. The refusal stops AT
  // the parse (profile `unknown`, the typed code, and NO demands enumerated); the accept walks PAST
  // it and answers the real question (profile `rayspec`, no spec errors, the demands this document
  // actually raises).
  it('refuses a workforce document with the ONE typed code when the flag is unset', async () => {
    const { code, out, err } = await checkEnv(['--check-env', './workforce.rayspec.yaml']);
    expect(code, `--- stdout ---\n${out}\n--- stderr ---\n${err}`).toBe(1);
    const verdict = JSON.parse(out);
    expect(verdict.ok).toBe(false);
    expect(verdict.mode).toBe('check-env');
    // The document never became a known profile, because it never parsed.
    expect(verdict.profile).toBe('unknown');
    const errors = (verdict.errors as string[]).join('\n');
    expect(errors).toContain('experimental_section_disabled');
    expect(errors).toContain('at workforce');
    // Ordering, not just outcome: it stopped at the PARSE, so it enumerated no demand at all.
    expect(verdict.required).toEqual([]);
    expect(verdict.missing).toEqual([]);
  });

  it('walks PAST the parse under the flag and answers the real demands — the accept control', async () => {
    const { code, out, err } = await checkEnv(['--check-env', './workforce.rayspec.yaml'], {
      RAYSPEC_EXPERIMENTAL_WORKFORCE: '1',
    });
    // Still exit 1 — but now because the ENVIRONMENT is unmet, not because the document was refused.
    expect(code, `--- stdout ---\n${out}\n--- stderr ---\n${err}`).toBe(1);
    const verdict = JSON.parse(out);
    expect(verdict.profile).toBe('rayspec');
    expect(verdict.errors).toEqual([]);
    // It got far enough to enumerate this document's real boot demands, including the declared
    // agent's backend credential.
    expect(verdict.missing).toEqual([
      'DATABASE_URL',
      'RAYSPEC_JWT_SIGNING_KEY',
      'RAYSPEC_API_KEY_PEPPER',
      'OPENAI_API_KEY',
    ]);
  });
});

maybeDescribe('rayspec deploy --check-env — it opens no socket, no database, no credential', () => {
  it('answers against an unreachable DATABASE_URL without ever connecting', async () => {
    // Port 1 on loopback: a connect attempt is refused immediately, and a DNS/TLS attempt would be
    // slower still. A run that answers here — fast, exit 0 — never opened it.
    const { code, out, ms } = await checkEnv(['--check-env', './compound.rayspec.yaml'], {
      DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/db',
      RAYSPEC_JWT_SIGNING_KEY: 'pem',
      RAYSPEC_API_KEY_PEPPER: 'pepper',
      RAYSPEC_BLOB_ROOT: '/tmp/x',
      RAYSPEC_MEDIA_SIGNING_KEY: 'k',
      RAYSPEC_CRON_TENANT_ID: 'x',
      RAYSPEC_ANTHROPIC_CONFIG_ROOT: '/tmp/y',
      ANTHROPIC_API_KEY: 'k',
    });
    expect(code).toBe(0);
    expect(JSON.parse(out).ok).toBe(true);
    expect(ms).toBeLessThan(30_000);
  });

  it('honours a <VAR>_FILE mount pointing at a path that does not exist — the file is never read', async () => {
    // A BOOT given these would abort ("points at '…', which is missing or not a regular file"). The
    // check counts each mount as set FROM THE VARIABLE ALONE — the plain variables are absent here, so
    // a satisfied verdict can only have come from the mount — and states that boundary outright.
    const { code, out } = await checkEnv(['--check-env', './compound.rayspec.yaml'], {
      DATABASE_URL_FILE: '/definitely/not/a/real/path/db.txt',
      RAYSPEC_JWT_SIGNING_KEY_FILE: '/definitely/not/a/real/path/jwt.pem',
      RAYSPEC_API_KEY_PEPPER_FILE: '/definitely/not/a/real/path/pepper.txt',
      RAYSPEC_BLOB_ROOT: '/tmp/x',
      RAYSPEC_MEDIA_SIGNING_KEY: 'k',
      RAYSPEC_CRON_TENANT_ID: 'x',
      RAYSPEC_ANTHROPIC_CONFIG_ROOT: '/tmp/y',
      ANTHROPIC_API_KEY: 'k',
    });
    expect(code).toBe(0);
    const verdict = JSON.parse(out);
    const byName = Object.fromEntries(
      (verdict.required as { name: string; set: boolean }[]).map((r) => [r.name, r]),
    );
    expect(byName.DATABASE_URL.set).toBe(true);
    expect(byName.RAYSPEC_JWT_SIGNING_KEY.set).toBe(true);
    expect(byName.RAYSPEC_API_KEY_PEPPER.set).toBe(true);
    expect((verdict.notChecked as string[]).join(' ')).toContain('the file is never opened');
  });

  it('prints no environment VALUE — only set/unset', async () => {
    const secret = 'S3CR3T-sentinel-value';
    const { out } = await checkEnv(['--check-env', './compound.rayspec.yaml'], {
      DATABASE_URL: `postgresql://u:${secret}@127.0.0.1:1/db`,
      RAYSPEC_JWT_SIGNING_KEY: secret,
      RAYSPEC_API_KEY_PEPPER: secret,
      ANTHROPIC_API_KEY: secret,
      // The posture flag is the ONE variable whose value the verdict judges, and an unrecognised one
      // is the case that judges it — so the sentinel is planted THERE too, on the only path that
      // could ever have echoed. Without this the claim holds only where nothing reads a value.
      RAYSPEC_ANTHROPIC_REUSE_LOGIN: secret,
    });
    expect(out).not.toContain(secret);
    const verdict = JSON.parse(out);
    expect(verdict.required[0].set).toBe(true);
    expect(verdict.errors).toHaveLength(1);
  });
});

maybeDescribe('rayspec deploy --check-env — usage', () => {
  it('refuses to be combined with --dry-run (each emits its own one-shot verdict)', async () => {
    const { code, err } = await checkEnv(['--check-env', '--dry-run', './compound.rayspec.yaml']);
    expect(code).toBe(2);
    expect(err).toContain('--dry-run and --check-env cannot be combined');
  });

  it('refuses a reviewed migration delta (it opens no DB, so it would be dropped)', async () => {
    const { code, err } = await checkEnv([
      '--check-env',
      '--apply-migration',
      './delta.sql',
      './compound.rayspec.yaml',
    ]);
    expect(code).toBe(2);
    expect(err).toContain('cannot be combined with --check-env');
  });

  it('is documented in the scoped help', async () => {
    const { code, out } = await checkEnv(['--help']);
    expect(code).toBe(0);
    expect(out).toContain('rayspec deploy --check-env <spec.yaml>');
  });
});
