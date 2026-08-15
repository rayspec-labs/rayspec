/**
 * The boot wrappers that assemble the server themselves CONSULT `RAYSPEC_AGENT_TRACING` too.
 *
 * `applyServeAgentTracing` had one call site, `serve.ts` (issue #383), so a wrapper that reaches
 * `assembleServer` directly ran past it: an operator who set the opt-out on `examples/local-boot` or on
 * `deployments/acme-notes` still got the agent SDK's exporting default, and an unsupported value that
 * fail-closes by name on the two documented entrypoints was ignored there. Both wrappers print the boot
 * banner, so the resolved posture was at least visible — but only as a report of a decision the operator
 * could not make.
 *
 * TWO ARMS, and they prove different things:
 *
 *   (a) THE REFUSAL arm runs each wrapper as a real subprocess. It needs no database, no secret and no
 *       port, and that is itself the assertion: the posture is applied ahead of the config load, so an
 *       unusable value stops the boot naming the variable, while the accept control — the same spawn
 *       with the variable absent — walks past that step and stops on the boot inputs further along.
 *       Neither arm opens a socket. What `off` then does to the SDK is not re-measured here: both
 *       wrappers call the same `applyServeAgentTracing` whose SDK effect (`setTracingDisabled` on an
 *       already-constructed trace provider, with an env-write-only reject control) is measured against
 *       the installed `@openai/agents` in `packages/app/cli/src/serve-agent-tracing.sdk.test.ts`.
 *   (b) THE CALL-SITE arm is the mechanism behind a sentence the banner, `.env.example` and the CLI
 *       reference all now state: every boot that prints this banner reads the variable. It discovers
 *       the `bootBanner(` call sites by reading the tree and requires each to apply a posture, so a
 *       fifth boot wrapper that printed the banner without consulting the variable would RED here
 *       rather than quietly make that sentence false.
 *
 * The three per-example demo wrappers (`examples/<slug>/dev-boot.mjs`) are deliberately NOT in scope:
 * they print no banner and read no trace-export setting, which is what the shipped prose now says of
 * them.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..', '..', '..', '..');
const TSX = join(here, '..', 'node_modules', '.bin', 'tsx');

/** The refusal `loadServerConfig` raises — the step AFTER the one under test. */
const CONFIG_REFUSAL = 'required env var(s) missing';
/** The refusal `examples/local-boot` raises for its first boot input — its step after this one. */
const LOCAL_BOOT_REFUSAL = 'required env var DATABASE_URL is not set';

/** The two wrappers, their log prefix, and the refusal their NEXT step raises. */
const WRAPPERS = [
  {
    name: 'examples/local-boot/serve.ts',
    entry: join(REPO_ROOT, 'examples', 'local-boot', 'serve.ts'),
    prefix: '[local-boot]',
    nextRefusal: LOCAL_BOOT_REFUSAL,
  },
  {
    name: 'deployments/acme-notes/serve.mts',
    entry: join(REPO_ROOT, 'deployments', 'acme-notes', 'serve.mts'),
    prefix: '[acme-notes-serve]',
    nextRefusal: CONFIG_REFUSAL,
  },
] as const;

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/**
 * Boot one wrapper from a throwaway directory with a minimal environment. `RAYSPEC_SKIP_DOTENV=1` keeps
 * this checkout's own `.env` — the install-root candidate the shipped loader resolves for real — from
 * handing the child credentials and letting it boot for real.
 */
function boot(entry: string, tracing?: string): { status: number | null; stderr: string } {
  dir = mkdtempSync(join(tmpdir(), 'wrapper-tracing-'));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    RAYSPEC_SKIP_DOTENV: '1',
  };
  if (tracing !== undefined) env.RAYSPEC_AGENT_TRACING = tracing;
  const r = spawnSync(TSX, [entry], { cwd: dir, env, encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, stderr: r.stderr ?? '' };
}

describe.each(WRAPPERS)('$name — RAYSPEC_AGENT_TRACING is consulted', (wrapper) => {
  it('refuses a value it cannot act on, by name, before the boot inputs are read', () => {
    const { status, stderr } = boot(wrapper.entry, 'NoNsEnSe');

    expect(status).toBe(1);
    expect(stderr).toContain(
      `${wrapper.prefix} Boot aborted — RAYSPEC_AGENT_TRACING='NoNsEnSe' is not supported`,
    );
    // Ordering, not just outcome: the boot stopped at the tracing step, so it never reached the one
    // the control below stops at.
    expect(stderr).not.toContain(wrapper.nextRefusal);
    // An operator-actionable refusal, not a crash: the message only, no stack frames.
    expect(stderr).not.toMatch(/\n\s+at /);
  });

  it('walks past the tracing step when the variable is unset — the accept control', () => {
    // Without this arm the assertion above would also pass against a wrapper that refuses every boot.
    // It is also the DEFAULT control: unset must change nothing on these wrappers.
    const { status, stderr } = boot(wrapper.entry);

    expect(status).toBe(1);
    expect(stderr).toContain(wrapper.nextRefusal);
    expect(stderr).not.toContain('RAYSPEC_AGENT_TRACING');
  });
});

/** Source files under the repo, minus the trees no boot ships from. */
function sourceFiles(from: string): string[] {
  const skip = new Set(['node_modules', 'dist', '.git', '.turbo', 'coverage', 'release']);
  const out: string[] = [];
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
    const full = join(from, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(m?[jt]s)$/.test(entry.name) && !/\.test\.[^.]+$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every boot that PRINTS the trace-export line also DECIDES it. The banner's remediation half tells an
 * operator to set `RAYSPEC_AGENT_TRACING`; on a boot that never reads it that is an instruction that
 * does nothing, which is the defect this arm exists to keep closed.
 */
describe('bootBanner — every call site applies a trace-export posture', () => {
  // The module that DEFINES the banner is not a call site; everything else that names it is one.
  const DEFINITION = join(here, 'banner.ts');
  const callSites = sourceFiles(REPO_ROOT)
    .filter((file) => file !== DEFINITION)
    .filter((file) => {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      return /\bbootBanner\s*\(/.test(code);
    })
    .map((file) => relative(REPO_ROOT, file))
    .sort();

  it('found the call sites outside this package — the instrument control', () => {
    // A walk that reached only packages/ would make every assertion below vacuous for exactly the two
    // wrappers this file is about.
    expect(callSites).toEqual(
      expect.arrayContaining([
        'deployments/acme-notes/serve.mts',
        'examples/local-boot/serve.ts',
        'packages/app/cli/src/deploy.ts',
        'packages/app/server/src/serve.ts',
      ]),
    );
  });

  it.each(callSites)('%s applies a posture before it prints the banner', (site) => {
    const code = readFileSync(join(REPO_ROOT, site), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(code).toMatch(/\bapply(Serve|Deploy)AgentTracing\s*\(/);
  });
});
