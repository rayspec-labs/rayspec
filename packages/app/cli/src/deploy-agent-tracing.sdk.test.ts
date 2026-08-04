/**
 * `rayspec deploy` — the counterproof for the trace-export default, measured against the INSTALLED
 * agent SDK rather than against an environment variable (issue #287).
 *
 * WHY THIS FILE EXISTS SEPARATELY. Asserting `OPENAI_AGENTS_DISABLE_TRACING === '1'` proves only that
 * a variable moved. `@openai/agents-core` builds its global trace provider while `@openai/agents` is
 * being evaluated, and that constructor SNAPSHOTS the kill-switch — so a build can set the variable,
 * satisfy an env assertion, print `Trace export: OFF` in the banner and still POST every prompt and
 * tool argument to `https://api.openai.com/v1/traces/ingest`. The only assertion that discriminates is
 * the SDK's own: `getGlobalTraceProvider().createTrace(...)` is a `NoopTrace` when the export is off
 * and a `Trace` when it is live.
 *
 * WHY A CHILD PROCESS. That SDK's config treats `NODE_ENV === 'test'` as tracing-disabled, and vitest
 * sets exactly that — in-process, both arms would answer "off" no matter what the code did. Each arm
 * below spawns `__fixtures__/agent-tracing-probe.mjs` with `NODE_ENV=production`, replaying one of the
 * module orders `rayspec deploy` actually takes, and reads the SDK's answer back.
 *
 * No DB, no port bind, no network: the probe creates a trace object and never starts it, so no
 * processor is notified and nothing is exported.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const PROBE = join(here, '__fixtures__/agent-tracing-probe.mjs');

interface Probe {
  /** What `applyDeployAgentTracing` selected, or null when the arm applied nothing. */
  selected: 'openai' | 'off' | null;
  /** The class the SDK's global provider handed back — the discriminator. */
  trace: string;
  /** What the boot banner would state, read off that same provider. */
  observed: 'openai' | 'off';
  /** The SDK's env switch as the probe process saw it — reported, never asserted on alone. */
  sdkSwitch: string | null;
  nodeEnv: string | null;
}

/**
 * `order` selects the deploy shape to replay:
 *  - `serve`         — `rayspec deploy <spec>`: posture applied before the boot closure is imported;
 *  - `closure-first` — `rayspec deploy --apply-migration …`: the pre-flight imports `@rayspec/server`
 *    (and through it the agent SDK) FIRST, so the provider already exists when the posture is applied;
 *  - `untouched`     — no posture applied at all: the SDK's own default.
 */
function probe(order: 'serve' | 'closure-first' | 'untouched', tracing?: string): Probe {
  const env: NodeJS.ProcessEnv = { ...process.env, PROBE_ORDER: order, NODE_ENV: 'production' };
  delete env.OPENAI_AGENTS_DISABLE_TRACING;
  delete env.RAYSPEC_AGENT_TRACING;
  if (tracing !== undefined) env.RAYSPEC_AGENT_TRACING = tracing;
  const out = execFileSync(process.execPath, [PROBE], { env, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as Probe;
}

describe('the deploy path stops the agent trace export — asked of the SDK, not of process.env', () => {
  it('leaves the SDK EXPORTING when nothing applies a posture — the reject control', () => {
    // Without this arm every assertion below would be satisfied by an SDK that never exports anything,
    // and the suite would be green against a fix that does nothing. `Trace` is the shipped default.
    const p = probe('untouched');
    expect(p.nodeEnv).toBe('production'); // if this were 'test' the SDK would disable itself
    expect(p.trace).toBe('Trace');
    expect(p.observed).toBe('openai');
  });

  it('turns the export off on the normal deploy order, with nothing set', () => {
    const p = probe('serve');
    expect(p.selected).toBe('off');
    expect(p.trace).toBe('NoopTrace');
    expect(p.observed).toBe('off'); // …and the banner states exactly this
  });

  it('turns the export off even when the boot closure — and the SDK — loaded FIRST', () => {
    // The shape `rayspec deploy --apply-migration` takes. Writing the environment variable cannot
    // reach a provider that has already snapshotted it, so this arm fails on an ordering-only fix.
    const p = probe('closure-first');
    expect(p.selected).toBe('off');
    expect(p.trace).toBe('NoopTrace');
    expect(p.observed).toBe('off');
  });

  it('keeps the export ON when the operator affirmatively selected it — the accept control', () => {
    for (const order of ['serve', 'closure-first'] as const) {
      const p = probe(order, 'openai');
      expect(p.selected, order).toBe('openai');
      expect(p.trace, order).toBe('Trace');
      expect(p.observed, order).toBe('openai');
    }
  });

  it('reports the SDK posture as `off` even where the variable alone would say otherwise', () => {
    // The banner value is a live read of the provider, not a read-back of the variable this boot
    // wrote. Both are reported by the probe; only the provider decides.
    const p = probe('closure-first');
    expect(p.sdkSwitch).toBe('1');
    expect(p.observed).toBe('off');
    expect(p.trace).toBe('NoopTrace');
  });
});
