/**
 * `rayspec deploy` — WHAT AN OPERATOR SEES when a boot fails, in both directions.
 *
 * A fail-closed refusal (a bad RAYSPEC_PRODUCT_TENANT_ID, an unsupported RAYSPEC_MEDIA_PREP, a missing
 * boot secret) is an operator-actionable DIAGNOSIS, not a crash: the entrypoint prints the message and
 * NOTHING else — no frames, no absolute paths from the machine that built the artifact. Anything
 * OUTSIDE that named set is genuinely unexpected and keeps its stack, or a maintainer has nothing to
 * debug. Both arms are asserted here so neither can silently regress into the other.
 *
 * DB-free: the ONLY thing stubbed is `assembleServer`. The static-profile detection, `loadServerConfig`,
 * the error classes and the catch block in deploy.ts are the real ones, so `instanceof` decides on the
 * real class identities. The WORDING of each refusal belongs to the code that raises it
 * (@rayspec/server's product boot); what this suite pins is how `rayspec deploy` renders it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { BootConfigError, ProductBootError } from '@rayspec/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The error `assembleServer` throws, set per test. vi.mock is hoisted above the imports, so the factory
// can only reach it through a hoisted bag.
const h = vi.hoisted(() => ({ bootError: undefined as unknown }));

vi.mock('@rayspec/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@rayspec/server')>();
  // Everything else stays REAL — including the exported error classes, so the instances thrown below
  // are the same identities deploy.ts's catch tests against. Only the assemble step is replaced: it is
  // where every boot refusal is raised, and running it for real would need a database.
  return {
    ...actual,
    assembleServer: () => {
      throw h.bootError;
    },
  };
});

import { serveDeployment } from './deploy.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
/** A PRODUCT document — the shape that takes the normal (non-static) boot, the one that refuses below. */
const ACME_SPEC = join(repoRoot, 'examples/acme-notes/acme-notes.product.yaml');

/** Dummy boot secrets: `loadServerConfig` shape-checks them and never uses them (assembleServer throws). */
const DUMMY_ENV = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  RAYSPEC_JWT_SIGNING_KEY: 'dummy-not-a-real-pem',
  RAYSPEC_API_KEY_PEPPER: 'dummy-pepper',
} as const;

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const [k, v] of Object.entries(DUMMY_ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  saved.RAYSPEC_SPEC_PATH = process.env.RAYSPEC_SPEC_PATH;
  // The searched-.env suffix asserted below is suppressed by RAYSPEC_SKIP_DOTENV=1 — make the ambient
  // state deterministic (unset), and let the one test that sets it restore via `saved`.
  saved.RAYSPEC_SKIP_DOTENV = process.env.RAYSPEC_SKIP_DOTENV;
  delete process.env.RAYSPEC_SKIP_DOTENV;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  h.bootError = undefined;
});

/** The stderr `rayspec deploy` writes for `err`, plus the code it exits with. */
async function bootRefusal(
  err: unknown,
): Promise<{ stderr: string; exitCode: number | undefined }> {
  h.bootError = err;
  const written: string[] = [];
  // console.error formats its arguments exactly like this and appends the newline — reassembling both
  // is what makes "and NOTHING else" an assertion about the operator's stderr rather than about a
  // convenient substring.
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    written.push(`${format(...args)}\n`);
  });
  let exitCode: number | undefined;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
  }) as never);
  try {
    await serveDeployment(ACME_SPEC);
  } finally {
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { stderr: written.join(''), exitCode };
}

/**
 * The trailing suffix a MISSING-REQUIRED-VARIABLE refusal gains: the `.env` candidate paths the CLI's
 * auto-loader searches, in precedence order ($PWD first, install root second), deduplicated when the
 * two coincide. Re-derived here from first principles — `resolve(cwd, '.env')` + the repo-root `.env`
 * this suite already computes — so the assertion does not lean on the helper under test.
 */
const SEARCHED_SUFFIX = ` (searched: ${[
  ...new Set([resolve(process.cwd(), '.env'), join(repoRoot, '.env')]),
].join(', ')})`;

/**
 * One sample per fail-closed class the deploy boot can surface. Each is a REAL instance of the class
 * @rayspec/server exports, carrying the refusal text that class raises for the named env (abridged
 * where the live message continues with recovery steps — the full wording is owned by the code that
 * raises it, and is not what this suite is about). `searched: true` marks the missing-REQUIRED-variable
 * refusals — the ones whose print gains the searched-.env suffix; every other refusal (an invalid
 * value, an unsupported option) must stay bare, which the exact-equality assertion below pins.
 */
const CLEAN_PRINT: ReadonlyArray<{
  readonly name: string;
  readonly err: Error;
  readonly searched?: true;
}> = [
  {
    name: 'a non-UUID RAYSPEC_PRODUCT_TENANT_ID',
    err: new ProductBootError(
      "RAYSPEC_PRODUCT_TENANT_ID='definitely-not-a-uuid' is not a valid org UUID. Every workflow " +
        'run, capability event and authenticated principal of this deployment binds to that org id ' +
        '(8-4-4-4-12 UUID). Fail-closed.',
    ),
  },
  {
    name: 'a well-formed RAYSPEC_PRODUCT_TENANT_ID naming no live org',
    err: new ProductBootError(
      "RAYSPEC_PRODUCT_TENANT_ID='99999999-9999-4999-8999-999999999999' does not name a live org " +
        '(a soft-deleted org counts as absent). Fail-closed.',
    ),
  },
  {
    name: 'an unsupported RAYSPEC_MEDIA_PREP',
    err: new ProductBootError(
      "RAYSPEC_MEDIA_PREP 'sox' is not supported (wired: ffmpeg | off; unset or blank ⇒ ffmpeg). Fail-closed.",
    ),
  },
  {
    name: 'a missing boot secret',
    err: new BootConfigError(
      'Boot aborted — required env var(s) missing: RAYSPEC_API_KEY_PEPPER. Refusing to start ' +
        '(fail-closed).',
    ),
    searched: true,
  },
  {
    name: 'a missing extraction-backend credential',
    err: new ProductBootError(
      "OPENAI_API_KEY is required (the OpenAI API key (extraction backend 'openai')). Fail-closed.",
    ),
    searched: true,
  },
];

describe('rayspec deploy — a fail-closed boot refusal prints the diagnosis and nothing else', () => {
  for (const { name, err, searched } of CLEAN_PRINT) {
    it(`${name} → one prefixed line, exit 1, no frames`, async () => {
      const { stderr, exitCode } = await bootRefusal(err);
      // A missing-REQUIRED-variable refusal additionally names the .env paths the auto-loader
      // searched (paths only — whether or not each file existed, never a value); everything else
      // prints the message alone.
      expect(stderr).toBe(`[rayspec deploy] ${err.message}${searched ? SEARCHED_SUFFIX : ''}\n`);
      expect(exitCode).toBe(1);
      // Restated as the operator reads it: no stack frame, and nothing from the build machine's
      // filesystem. Implied by the equality above; spelled out so a weakened equality still REDs.
      // (The searched suffix deliberately names paths on the RUNNING machine — the diagnostic — so
      // the no-local-path half applies only to the refusals that carry no suffix.)
      expect(stderr).not.toMatch(/\n\s+at /);
      if (!searched) expect(stderr).not.toContain(repoRoot);
    });
  }

  it('a ProductBootError refusal names the variable the operator has to fix', async () => {
    const { stderr } = await bootRefusal(CLEAN_PRINT[0].err);
    expect(stderr.startsWith('[rayspec deploy] Boot aborted (Product-YAML) — ')).toBe(true);
    expect(stderr).toContain('RAYSPEC_PRODUCT_TENANT_ID=');
  });

  it('RAYSPEC_SKIP_DOTENV=1 → the missing-variable refusal stays bare (nothing was searched)', async () => {
    // With the auto-load opted out, claiming "(searched: …)" would be false — the suffix must vanish.
    process.env.RAYSPEC_SKIP_DOTENV = '1';
    const missingSecret = CLEAN_PRINT.find((c) => c.name === 'a missing boot secret');
    if (!missingSecret) throw new Error('the missing-boot-secret sample is gone from CLEAN_PRINT');
    const { stderr, exitCode } = await bootRefusal(missingSecret.err);
    expect(stderr).toBe(`[rayspec deploy] ${missingSecret.err.message}\n`);
    expect(exitCode).toBe(1);
  });
});

describe('rayspec deploy — an unexpected boot error still hands a maintainer its stack', () => {
  it('an error outside the fail-closed classes keeps its frames', async () => {
    const boom = new Error('a provider library threw something nobody planned for');
    const { stderr, exitCode } = await bootRefusal(boom);
    expect(exitCode).toBe(1);
    expect(stderr.startsWith('[rayspec deploy] boot failed:')).toBe(true);
    expect(stderr).toContain(boom.message);
    // The point of the arm: frames, from this file, so the throw site is locatable.
    expect(stderr).toMatch(/\n\s+at /);
    expect(stderr).toContain(here);
  });

  it('a non-Error throw is still reported (nothing is swallowed)', async () => {
    const { stderr, exitCode } = await bootRefusal('a bare string throw');
    expect(exitCode).toBe(1);
    expect(stderr).toBe('[rayspec deploy] boot failed: a bare string throw\n');
  });
});

/**
 * The two entrypoints boot the SAME product spec and must give the same refusal the same treatment.
 * They cannot share the catch block (deploy.ts reaches @rayspec/server through a dynamic import to keep
 * the boot graph off `rayspec doctor`'s load path), so the only thing holding them together is that the
 * class lists match — which is exactly what drifted before. Compare them at the source.
 */
describe('rayspec deploy / rayspec-serve — the fail-closed class lists agree', () => {
  /**
   * The classes a catch block clean-prints: every `err instanceof X`, minus the `Error` stack guard.
   * DEDUPLICATED — deploy.ts clean-prints `BootConfigError` from two places, because the trace-export
   * posture is resolved (and can be refused) before the boot closure is even imported. What has to
   * agree between the two entrypoints is the SET of classes, not how many times each is named.
   */
  const failClosedClasses = (file: string): string[] =>
    [
      ...new Set(
        [...readFileSync(file, 'utf8').matchAll(/\berr instanceof (\w+)/g)]
          .map((m) => m[1] as string)
          .filter((name) => name !== 'Error'),
      ),
    ].sort();

  const EXPECTED = ['BootConfigError', 'BootTimeoutError', 'DeployError', 'ProductBootError'];

  it('both entrypoints name the same four classes', () => {
    // Asserted against the explicit list, not just against each other: two files that both stopped
    // matching the `err instanceof` shape would agree on nothing and pass.
    expect(failClosedClasses(join(here, 'deploy.ts'))).toEqual(EXPECTED);
    expect(failClosedClasses(join(repoRoot, 'packages/app/server/src/serve.ts'))).toEqual(EXPECTED);
  });
});
