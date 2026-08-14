/**
 * The `rayspec-serve` entrypoint CONSULTS `RAYSPEC_AGENT_TRACING`, and does it before anything else
 * this boot does (issue #383).
 *
 * WHY A SPAWNED ENTRYPOINT AND NOT A UNIT. What `applyServeAgentTracing` does to the SDK is measured
 * against the real installed `@openai/agents`, in a child process at `NODE_ENV=production`, in
 * `packages/app/cli/src/serve-agent-tracing.sdk.test.ts` — the SDK reports tracing disabled under
 * vitest's own `NODE_ENV=test`, so that measurement cannot be taken here. What that file cannot show is
 * that `serve.ts` calls the reader AT ALL: every arm there would stay green against an unwired fix.
 * This file closes that by running the shipped entrypoint (`tsx src/serve.ts`, the package's own
 * `serve` script) and reading its refusal.
 *
 * IT NEEDS NO DATABASE, NO SECRET AND NO PORT, and that is itself the assertion. The refusal under test
 * is raised BEFORE `loadServerConfig`, so the two arms below discriminate: with an unusable value the
 * boot names the variable, and with the variable absent the same spawn walks past the tracing step and
 * refuses further along, on the three missing boot secrets. Neither arm ever opens a socket. The child
 * runs with `RAYSPEC_SKIP_DOTENV=1` and a minimal environment so the repo-root `.env` this suite's
 * vitest config loads cannot hand it credentials and let it boot for real.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const TSX = join(here, '..', 'node_modules', '.bin', 'tsx');
const SERVE = join(here, 'serve.ts');

/** The missing-secret refusal `loadServerConfig` raises — the step AFTER the one under test. */
const CONFIG_REFUSAL = 'required env var(s) missing';

function boot(tracing?: string): { status: number | null; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    RAYSPEC_SKIP_DOTENV: '1',
  };
  if (tracing !== undefined) env.RAYSPEC_AGENT_TRACING = tracing;
  const r = spawnSync(TSX, [SERVE], { env, encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr ?? '' };
}

describe('rayspec-serve — RAYSPEC_AGENT_TRACING is consulted at the entrypoint', () => {
  it('refuses a value it cannot act on, by name, before the config load', () => {
    const { status, stderr } = boot('NoNsEnSe');
    expect(status).toBe(1);
    expect(stderr).toContain(
      "[rayspec-serve] Boot aborted — RAYSPEC_AGENT_TRACING='NoNsEnSe' is not supported",
    );
    // Ordering, not just outcome: the boot stopped at the tracing step, so it never reached the
    // secret gate that the control below stops at.
    expect(stderr).not.toContain(CONFIG_REFUSAL);
  });

  it('walks past the tracing step when the variable is unset — the accept control', () => {
    // Without this arm the assertion above would also pass against an entrypoint that refuses every
    // boot. It is also the DEFAULT control: unset must change nothing at this entrypoint.
    const { status, stderr } = boot();
    expect(status).toBe(1);
    expect(stderr).toContain(CONFIG_REFUSAL);
    expect(stderr).not.toContain('RAYSPEC_AGENT_TRACING');
  });

  it('walks past a BLANK value the same way — it states no intention', () => {
    const { status, stderr } = boot('   ');
    expect(status).toBe(1);
    expect(stderr).toContain(CONFIG_REFUSAL);
    expect(stderr).not.toContain('RAYSPEC_AGENT_TRACING');
  });
});
