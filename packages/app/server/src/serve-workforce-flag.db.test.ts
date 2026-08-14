/**
 * The experimental `workforce:` opt-in at the `rayspec-serve` ENTRYPOINT.
 *
 * The CLI arms (doctor, plan, deploy --dry-run) are covered in-process by
 * `packages/app/cli/src/workforce-flag.test.ts`, and the parse gate's own message names serve
 * alongside them — but nothing exercised serve itself, and serve is the only entry point that
 * reaches the gate through `deployDeclaredSpec` rather than through a CLI command's own parse call.
 * Every arm of the CLI suite would stay green against a serve path that never threaded the flag.
 *
 * WHY A SPAWNED ENTRYPOINT (and a database). `serve.ts` guards on `isProcessEntrypoint()` and exits
 * the process, so it cannot be driven in-process; and its workforce gate sits inside the deploy
 * pipeline, AFTER the config load and the migration chain — so unlike the tracing suite next door
 * this one needs a real DATABASE_URL to reach the step under test at all.
 *
 * The two arms DISCRIMINATE rather than merely refusing: with the flag unset the boot stops at the
 * parse with the one typed code, and with the flag set the same spawn walks PAST the parse and
 * stops at the next gate (the workforce's task-tenant precondition). Without the second arm the
 * first would also pass against an entrypoint that refuses every boot.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'serve-workforce-flag.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — refusing to silently skip.',
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const TSX = join(here, '..', 'node_modules', '.bin', 'tsx');
const SERVE = join(here, 'serve.ts');

/** The gate AFTER the one under test — reaching it proves the parse accepted the section. */
const NEXT_GATE = 'the spec declares a workforce but RAYSPEC_CRON_TENANT_ID is unset';

const WORKFORCE_YAML = `version: '1.0'
metadata:
  name: serve-workforce-flag
deployment:
  durableWorker: true
agents:
  - id: lead_agent
    name: lead_agent
    backend: openai
    model: gpt-4o-mini
    instructions: Coordinate.
workforce:
  id: helpdesk
  name: Helpdesk
  orchestrator: lead
  employees:
    - id: lead
      agent: lead_agent
      title: Lead
      role: orchestrator
`;

/** The same document with the section removed — the byte-identity control. */
const PLAIN_YAML = WORKFORCE_YAML.slice(0, WORKFORCE_YAML.indexOf('workforce:\n'));

function specPath(name: string, yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'rayspec-serve-wf-'));
  const file = join(dir, name);
  writeFileSync(file, yaml, 'utf8');
  return file;
}

/**
 * Boot the shipped entrypoint with the three secrets and a database, but deliberately WITHOUT
 * `RAYSPEC_CRON_TENANT_ID` — the next gate along, which is what the accept control lands on. The
 * child runs with `RAYSPEC_SKIP_DOTENV=1` and a minimal environment so the repo-root `.env` cannot
 * hand it anything this test did not choose.
 */
function boot(
  specFile: string,
  flag?: string,
  opts: { readonly backendKey?: boolean } = {},
): { status: number | null; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    RAYSPEC_SKIP_DOTENV: '1',
    RAYSPEC_SPEC_PATH: specFile,
    DATABASE_URL: process.env.DATABASE_URL,
    RAYSPEC_API_KEY_PEPPER: 'serve-flag-test-pepper',
    RAYSPEC_JWT_SIGNING_KEY: process.env.RAYSPEC_JWT_SIGNING_KEY,
  };
  if (opts.backendKey !== false) {
    // The declared agent's backend must be configured or the boot stops one gate EARLIER, before
    // the spec parse this suite is about. The key is never used: no boot here reaches a run.
    env.OPENAI_API_KEY = 'sk-not-a-real-key-no-call-is-made';
  }
  if (flag !== undefined) env.RAYSPEC_EXPERIMENTAL_WORKFORCE = flag;
  const r = spawnSync(TSX, [SERVE], { env, encoding: 'utf8', timeout: 180_000 });
  return { status: r.status, stderr: r.stderr ?? '' };
}

describe.skipIf(!hasDb)('rayspec-serve — the experimental workforce opt-in (db)', () => {
  it('refuses a workforce document with the ONE typed code when the flag is unset', () => {
    const { status, stderr } = boot(specPath('workforce.yaml', WORKFORCE_YAML));
    expect(status).toBe(1);
    expect(stderr).toContain('experimental_section_disabled');
    expect(stderr).toContain('"path": "workforce"');
    // Ordering, not just outcome: the boot stopped AT the parse, so it never reached the gate
    // the accept control below stops at.
    expect(stderr).not.toContain(NEXT_GATE);
  }, 240_000);

  it('walks past the parse when the flag is set — the accept control', () => {
    const { status, stderr } = boot(specPath('workforce.yaml', WORKFORCE_YAML), '1');
    expect(status).toBe(1);
    expect(stderr).toContain(NEXT_GATE);
    expect(stderr).not.toContain('experimental_section_disabled');
  }, 240_000);

  it('a document WITHOUT the section refuses identically with the flag set or unset', () => {
    // A workforce-free boot SUCCEEDS and then listens forever, so the arms are taken one gate
    // short of that: the declared agent's backend key is withheld, and both spawns must stop on
    // the same refusal — neither mentioning the parse gate nor the workforce gate. That is the
    // flag's no-op claim measured where it can actually be observed at this entry point.
    const off = boot(specPath('plain.yaml', PLAIN_YAML), undefined, { backendKey: false });
    const on = boot(specPath('plain.yaml', PLAIN_YAML), '1', { backendKey: false });
    expect(off.status).toBe(1);
    expect(off.stderr).toContain("select backend 'openai', which is not configured");
    expect(on.stderr).toBe(off.stderr);
    for (const { stderr } of [off, on]) {
      expect(stderr).not.toContain('experimental_section_disabled');
      expect(stderr).not.toContain(NEXT_GATE);
    }
  }, 240_000);
});
