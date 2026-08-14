/**
 * `rayspec-serve` — the counterproof for the trace-export posture at the OTHER entrypoint (issue #383).
 *
 * WHY IT LIVES BESIDE THE DEPLOY PROBE. The measurement is the same one `deploy-agent-tracing.sdk.test.ts`
 * takes and needs the same two things: the REAL installed `@openai/agents`, and a child process at
 * `NODE_ENV=production` (that SDK's config reports tracing disabled whenever `NODE_ENV === 'test'`,
 * which is exactly what vitest sets — in-process every arm would answer "off" whatever the code did).
 * It shares that file's fixture, `__fixtures__/agent-tracing-probe.mjs`, which resolves
 * `@rayspec/server` through this package's dependency on it, so the arms below run against the built
 * server closure rather than against a copy of it.
 *
 * WHAT IS ASSERTED IS THE SDK'S OWN ANSWER, not a banner string and not an environment variable:
 * `getGlobalTraceProvider().createTrace(...)` hands back a `NoopTrace` exactly when the export is off
 * and a `Trace` when it is live. `rayspec-serve` imports the composition root — and through it the agent
 * SDK — STATICALLY, so the provider has already snapshotted the SDK's kill-switch before `main()` runs;
 * the `env-only` arm is the reject control for exactly that, and it is why the posture is applied with
 * `setTracingDisabled` and not with an environment write alone.
 *
 * What this file does NOT prove is that `serve.ts` calls the reader at all — that is measured against
 * the entrypoint itself in `packages/app/server/src/serve-agent-tracing.test.ts`.
 *
 * No DB, no port bind, no network: the probe creates a trace object and never starts it, so no
 * processor is notified and nothing is exported.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const PROBE = join(here, '__fixtures__/agent-tracing-probe.mjs');

interface Probe {
  /** What the reader selected, or null when it applied nothing (unset/blank, or an env-only arm). */
  selected: 'openai' | 'off' | null;
  /** The class the SDK's global provider handed back — the discriminator. */
  trace: string;
  /** What the boot banner would state, read off that same provider. */
  observed: 'openai' | 'off';
  /** The SDK's env switch as the probe process saw it — reported, never asserted on alone. */
  sdkSwitch: string | null;
  nodeEnv: string | null;
}

/** Spawn the probe in `order`, with `RAYSPEC_AGENT_TRACING` set to `tracing` (or left unset). */
function run(
  order: string,
  tracing?: string,
): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, PROBE_ORDER: order, NODE_ENV: 'production' };
  delete env.OPENAI_AGENTS_DISABLE_TRACING;
  delete env.RAYSPEC_AGENT_TRACING;
  if (tracing !== undefined) env.RAYSPEC_AGENT_TRACING = tracing;
  const r = spawnSync(process.execPath, [PROBE], { env, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** The same spawn, for the arms that expect the probe to complete. */
function probe(order: string, tracing?: string): Probe {
  const r = run(order, tracing);
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') as Probe;
}

describe('rayspec-serve honours an EXPLICIT RAYSPEC_AGENT_TRACING — asked of the SDK', () => {
  it("turns the export off for 'off', at the only module order this entrypoint has", () => {
    const p = probe('serve-entrypoint', 'off');
    expect(p.nodeEnv).toBe('production'); // if this were 'test' the SDK would disable itself
    expect(p.selected).toBe('off');
    expect(p.trace).toBe('NoopTrace');
    expect(p.observed).toBe('off'); // …and the banner, which reads this provider, states exactly that
  });

  it('leaves the export ARMED when the environment switch is written and nothing else — the reject control', () => {
    // The whole reason the posture is applied with the SDK's programmatic switch. `serve.ts` imports
    // the composition root statically, so the provider exists — and has snapshotted the kill-switch —
    // before any code of ours runs. If this arm ever reported `NoopTrace`, the arm above would be
    // satisfied by a fix that writes a variable and changes nothing.
    const p = probe('serve-entrypoint-env-only', 'off');
    expect(p.sdkSwitch).toBe('1');
    expect(p.trace).toBe('Trace');
    expect(p.observed).toBe('openai');
  });

  it("leaves the export ARMED for 'openai' — the accept control for the arm above", () => {
    const p = probe('serve-entrypoint', 'openai');
    expect(p.selected).toBe('openai');
    expect(p.trace).toBe('Trace');
    expect(p.observed).toBe('openai');
  });

  it('changes NOTHING when the variable is unset — this entrypoint keeps its default', () => {
    // The load-bearing control. `resolveAgentTracing` collapses unset and `off` into `off`; calling it
    // from this entrypoint would therefore flip the DEFAULT here, which is a different decision. The
    // unset arm must stay indistinguishable from the arm that applies no posture at all.
    const unset = probe('serve-entrypoint');
    const untouched = probe('untouched');
    expect(unset.selected).toBeNull();
    expect({ trace: unset.trace, observed: unset.observed, sdkSwitch: unset.sdkSwitch }).toEqual({
      trace: untouched.trace,
      observed: untouched.observed,
      sdkSwitch: untouched.sdkSwitch,
    });
    expect(unset.trace).toBe('Trace'); // …and that shared default is the SDK's, which exports
  });

  it('treats a BLANK value as unset — it states no intention, so it moves nothing', () => {
    const p = probe('serve-entrypoint', '   ');
    expect(p.selected).toBeNull();
    expect(p.trace).toBe('Trace');
    expect(p.sdkSwitch).toBeNull();
  });

  it('REFUSES a value it cannot act on, naming the variable and the value', () => {
    const r = run('serve-entrypoint', 'NoNsEnSe');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("RAYSPEC_AGENT_TRACING='NoNsEnSe' is not supported");
    expect(r.stderr).toContain('BootConfigError');
  });
});
