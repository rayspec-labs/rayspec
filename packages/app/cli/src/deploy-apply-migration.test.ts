/**
 * `rayspec deploy --apply-migration` — the DB-free unit surface: the arg grammar (`--apply-migration` /
 * `--allowlist` accepted; unknown flags rejected), the usage guards (a dry-run applies no migration; a
 * bare `--allowlist` is refused), the env-wiring `serveDeployment` performs BEFORE `assembleServer` (the
 * seam the gated deploy() engine reads), and the improved read-spec path-escape message.
 *
 * The real APPLY (an additive delta lands + data survives; a destructive delta with no allowlist is
 * BLOCKED) is proven on ground truth through the REAL CLI in deploy-apply-migration.db.test.ts.
 */
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture bag the hoisted `@rayspec/server` mock writes into (vi.mock is hoisted above the imports, so
// the shared state must be declared via vi.hoisted to be visible inside the factory).
const h = vi.hoisted(() => ({
  captured: null as null | Record<string, string | undefined>,
}));

// Stub the heavy boot dependencies `serveDeployment` dynamically imports so the env-wiring can be
// exercised with NO DB / NO port bind. `assembleServer` records the update env at CALL time — the whole
// point: a revert that stopped `serveDeployment` from setting the env (or set it AFTER assembleServer)
// makes the captured values wrong, REDding the ordering assertion below.
vi.mock('@rayspec/server', () => {
  class BootConfigError extends Error {}
  class DeployError extends Error {}
  return {
    assembleOptsFromEnv: () => ({}),
    assembleServer: vi.fn(async () => {
      h.captured = {
        RAYSPEC_SPEC_PATH: process.env.RAYSPEC_SPEC_PATH,
        RAYSPEC_UPDATE_MIGRATION: process.env.RAYSPEC_UPDATE_MIGRATION,
        RAYSPEC_UPDATE_ALLOWLIST: process.env.RAYSPEC_UPDATE_ALLOWLIST,
      };
      return { app: { fetch: () => new Response('ok') }, close: async () => {} };
    }),
    BootConfigError,
    bootBanner: () => 'banner',
    bootBaseUrl: () => 'http://127.0.0.1:0',
    DeployError,
    loadServerConfig: () => ({ port: 0 }),
  };
});
vi.mock('@hono/node-server', () => ({
  // Return a fake http server; do NOT invoke the banner callback (nothing under test needs it).
  serve: () => ({ close: (done?: () => void) => done?.() }),
}));
vi.mock('@rayspec/db/composition', () => ({ sealProductStores: () => {} }));

import { DeployCliError, parseDeployArgs, runDeploy, serveDeployment } from './deploy.js';
import { ReadSpecError, resolveSpecPath } from './read-spec.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
// A committed spec that exists + is readable (used only to get PAST the pre-flight read into the usage
// guards — its content is never composed here).
const ANY_SPEC_REL = 'examples/acme-notes/acme-notes.product.yaml';

// Snapshot the env keys serveDeployment mutates so each case starts clean and the suite leaves no trace.
const ENV_KEYS = [
  'RAYSPEC_SPEC_PATH',
  'RAYSPEC_UPDATE_MIGRATION',
  'RAYSPEC_UPDATE_ALLOWLIST',
  'PORT',
];
let savedEnv: Record<string, string | undefined>;
let prevCwd: string;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  h.captured = null;
  prevCwd = process.cwd();
  process.chdir(repoRoot); // the read-spec jail resolves against the CWD
});
afterEach(() => {
  process.chdir(prevCwd);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  // serveDeployment installs SIGINT/SIGTERM handlers; drop them so repeated calls don't accrete.
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
});

describe('parseDeployArgs — the --apply-migration / --allowlist grammar', () => {
  it('accepts --apply-migration <path> and --allowlist <path>', () => {
    const r = parseDeployArgs([
      'spec.yaml',
      '--apply-migration',
      'delta.sql',
      '--allowlist',
      'a.json',
    ]);
    expect(r.positionals).toEqual(['spec.yaml']);
    expect(r.applyMigration).toBe('delta.sql');
    expect(r.allowlist).toBe('a.json');
  });

  it('leaves both undefined when absent', () => {
    const r = parseDeployArgs(['spec.yaml']);
    expect(r.applyMigration).toBeUndefined();
    expect(r.allowlist).toBeUndefined();
  });

  it('an unknown flag is a usage error (DeployCliError → exit 2)', () => {
    expect(() => parseDeployArgs(['spec.yaml', '--bogus'])).toThrow(DeployCliError);
  });
});

describe('runDeploy — the --apply-migration usage guards', () => {
  it('--apply-migration combined with --dry-run is refused (a dry-run applies no migration)', async () => {
    await expect(
      runDeploy(['--dry-run', '--apply-migration', 'delta.sql', ANY_SPEC_REL]),
    ).rejects.toBeInstanceOf(DeployCliError);
  });

  it('a bare --allowlist (no --apply-migration) is refused (it would be silently ignored)', async () => {
    await expect(runDeploy([ANY_SPEC_REL, '--allowlist', 'a.json'])).rejects.toBeInstanceOf(
      DeployCliError,
    );
  });

  it('a delta path that escapes the CWD is refused by the jail', async () => {
    await expect(
      runDeploy([ANY_SPEC_REL, '--apply-migration', '../outside.sql']),
    ).rejects.toBeInstanceOf(DeployCliError);
  });
});

describe('runDeploy — the delta/allowlist paths get the FULL spec-path jail (realpath RE-jail + size cap)', () => {
  let jailDir = '';
  let outsideDir = '';

  beforeAll(() => {
    // realpathSync so the CWD we chdir into is the REAL path (macOS /var → /private/var) — else the
    // read-spec symlink jail would (correctly) reject the in-jail spec itself as escaping the CWD.
    jailDir = realpathSync(mkdtempSync(join(tmpdir(), 'rayspec-delta-jail-')));
    outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'rayspec-delta-outside-')));
    // A readable regular spec INSIDE the jail (only needs to pass the pre-flight read; never composed).
    writeFileSync(join(jailDir, 'spec.yaml'), "version: '1.0'\nmetadata: { name: x }\n");
    // The reviewed delta's REAL target lives OUTSIDE the jail; a symlink INSIDE the jail points at it —
    // the LEXICAL jail (resolveSpecPath) sees an in-CWD path and passes, so ONLY readSpecFile's realpath
    // RE-jail catches the escape (this is the gap the realpath re-jail closes; the boot's plain readFileSync would
    // otherwise FOLLOW the symlink out of the cwd with no re-jail).
    writeFileSync(
      join(outsideDir, 'secret-delta.sql'),
      'ALTER TABLE parts ADD COLUMN note text;\n',
    );
    symlinkSync(join(outsideDir, 'secret-delta.sql'), join(jailDir, 'delta.sql'));
    // An OVERSIZED in-jail delta (> MAX_SPEC_BYTES = 1 MiB) — the size cap must reject it like the spec.
    writeFileSync(join(jailDir, 'huge.sql'), `-- ${'x'.repeat(1024 * 1024 + 16)}\n`);
  });

  afterAll(() => {
    for (const d of [jailDir, outsideDir]) if (d) rmSync(d, { recursive: true, force: true });
  });

  it('a delta symlink whose REAL target escapes the CWD is refused (secret-free), like the spec path', async () => {
    process.chdir(jailDir);
    let err: unknown;
    try {
      await runDeploy(['spec.yaml', '--apply-migration', 'delta.sql']);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DeployCliError);
    const msg = (err as Error).message;
    // The realpath RE-jail message (identical wording to the spec path's), naming only operator-known
    // paths — no DB URL / secret. The lexical jail alone would NOT have caught this symlink.
    expect(msg).toMatch(/resolves to a target outside the working directory/);
    expect(msg).not.toMatch(/postgres|password|secret/i);
  });

  it('an OVERSIZED delta (> 1 MiB) is refused by the size cap, like the spec path', async () => {
    process.chdir(jailDir);
    await expect(runDeploy(['spec.yaml', '--apply-migration', 'huge.sql'])).rejects.toBeInstanceOf(
      DeployCliError,
    );
  });
});

describe('serveDeployment — wires the update env BEFORE assembleServer', () => {
  it('sets RAYSPEC_UPDATE_MIGRATION + RAYSPEC_UPDATE_ALLOWLIST from the flags', async () => {
    await serveDeployment('/abs/spec.yaml', undefined, '/abs/delta.sql', '/abs/allow.json');
    expect(h.captured).not.toBeNull();
    // Captured AT assembleServer call-time: proves the env was set BEFORE the boot (a revert that drops
    // the wiring — or moves it after assembleServer — leaves these undefined).
    expect(h.captured?.RAYSPEC_SPEC_PATH).toBe('/abs/spec.yaml');
    expect(h.captured?.RAYSPEC_UPDATE_MIGRATION).toBe('/abs/delta.sql');
    expect(h.captured?.RAYSPEC_UPDATE_ALLOWLIST).toBe('/abs/allow.json');
  });

  it('leaves the update env UNSET when --apply-migration is absent', async () => {
    await serveDeployment('/abs/plain.yaml');
    expect(h.captured?.RAYSPEC_SPEC_PATH).toBe('/abs/plain.yaml');
    expect(h.captured?.RAYSPEC_UPDATE_MIGRATION).toBeUndefined();
    expect(h.captured?.RAYSPEC_UPDATE_ALLOWLIST).toBeUndefined();
  });
});

describe('read-spec path-escape message — names the concrete fix', () => {
  it('the escaping-path error tells the operator how to fix it (secret-free)', () => {
    let err: unknown;
    try {
      resolveSpecPath(['../outside.yaml']);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ReadSpecError);
    const msg = (err as Error).message;
    expect(msg).toMatch(/run rayspec from the directory that contains the spec/);
    expect(msg).toMatch(/move the spec inside the current working directory/);
  });
});
