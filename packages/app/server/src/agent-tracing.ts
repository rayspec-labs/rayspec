/**
 * The agent trace-export posture (issue #287).
 *
 * WHY THIS IS ITS OWN LEAF MODULE, published as the `@rayspec/server/agent-tracing` subpath.
 * `@openai/agents-core` builds its global trace provider at MODULE-EVALUATION time —
 * `@openai/agents/dist/index.js` runs `setDefaultOpenAITracingExporter()` at top level, which reaches
 * `getGlobalTraceProvider()` and constructs a `TraceProvider` — and that constructor SNAPSHOTS the
 * kill-switch once (`this.#disabled = tracing.disabled`). Every later gate reads the snapshot; the
 * OpenAI exporter re-reads nothing. So a process that has already imported the boot closure
 * (`@rayspec/server` → `product-boot` → `@rayspec/adapter-openai` → `@openai/agents`) cannot turn the
 * export off by writing an environment variable afterwards — the value it would read was read
 * already. Importing THIS module pulls none of that in, so `rayspec deploy` can decide, and write the
 * variable, before the first import of the closure.
 *
 * Ordering alone is still a fragile guarantee — it holds only as long as no future call site loads the
 * closure first — so `applyDeployAgentTracing` does not rely on it: after writing the variable it also
 * drives the SDK's OWN programmatic switch (`setTracingDisabled`), which flips an ALREADY-CONSTRUCTED
 * provider. Whichever order the process actually took, the outcome is the same.
 *
 * On the adapter boundary: this module runs no agent and maps nothing vendor-shaped, so it does not
 * speak past the neutral `Backend` interface the adapters own. What it touches is a PROCESS-GLOBAL
 * property of an SDK the boot closure loads unavoidably — the alternative would be reaching into that
 * SDK's internal global-symbol registry, which is strictly worse than calling its published API.
 */
import { BootConfigError } from './boot-config-error.js';

// Re-exported so a caller that applies the posture BEFORE loading `@rayspec/server` can still name the
// class its refusal arrives as. It is the identical class object the barrel exports — both paths reach
// the same `boot-config-error.js` — so `instanceof` holds across the two imports.
export { BootConfigError };

/**
 * The resolved agent trace-export posture:
 *  - `'openai'` — agent traces (which carry prompts and tool arguments) are exported to OpenAI;
 *  - `'off'`    — no trace leaves this process.
 */
export type AgentTracingPosture = 'openai' | 'off';

/**
 * The SDK's OWN trace kill-switch. `@openai/agents-core` reads it through `tracing.disabled`
 * (`dist/config.js`), treating the exact strings `'true'` and `'1'` as enabled. It is read ONCE, when
 * the global trace provider is constructed — which is why writing it is only half of
 * `applyDeployAgentTracing`, and why the banner never re-derives the posture from it.
 *
 * It is written onto `process.env` deliberately: unlike a boot secret this value SHOULD be inherited
 * by child processes, so an agent CLI this deployment spawns does not export what the parent declined.
 */
const SDK_DISABLE_TRACING_ENV = 'OPENAI_AGENTS_DISABLE_TRACING';

/** The name of the throw-away trace `observedAgentTracing` creates to read the provider's state. */
const POSTURE_PROBE_TRACE_NAME = 'rayspec.boot.trace-export-probe';

/**
 * Resolve `RAYSPEC_AGENT_TRACING` — the AFFIRMATIVE switch for the agent trace export.
 *
 *  - `openai`        ⇒ export agent traces to OpenAI;
 *  - `off`           ⇒ do not;
 *  - unset OR BLANK  ⇒ `off`. Blank counts as unset DELIBERATELY: a `RAYSPEC_AGENT_TRACING=`
 *    (or an unsubstituted `${…}`) states no intention, and the unstated intention here resolves to the
 *    protective posture rather than to a refused boot — the resolved posture is on the banner either
 *    way, so a blank value cannot quietly do the surprising thing;
 *  - anything else   ⇒ fail-closed by NAME, in the house form (mirrors `RAYSPEC_MEDIA_PREP`). A typo
 *    must not read as "not `openai`, so off": silence is the whole defect class here.
 *
 * It is an AFFIRMATIVE switch, not a negation of the SDK's own: the operator states an intention, and
 * the repository is not bound to a third-party SDK's variable name.
 */
export function resolveAgentTracing(env: NodeJS.ProcessEnv): AgentTracingPosture {
  const raw = env.RAYSPEC_AGENT_TRACING?.trim();
  if (raw === undefined || raw === '' || raw === 'off') return 'off';
  if (raw === 'openai') return 'openai';
  throw new BootConfigError(
    `Boot aborted — RAYSPEC_AGENT_TRACING='${raw}' is not supported (wired: openai | off; unset ⇒ ` +
      'off). It selects whether agent traces — which carry prompts and tool arguments — are exported ' +
      'to OpenAI. Fail-closed.',
  );
}

/**
 * Apply the `rayspec deploy` path's trace-export DEFAULT, and return the posture it selected.
 *
 * Scope is deliberate. `deploy` is the strongest available signal that the code running here belongs
 * to someone other than the operator, and exporting a third party's prompts and tool arguments to a
 * third party unasked is what this closes. A developer tracing their OWN agent through `rayspec-serve`
 * or the local dev wrapper sees their own prompts — that was never the risk case, and this does not
 * touch it.
 *
 * Turning the export OFF is done TWICE, and the two are not redundant:
 *  1. write `OPENAI_AGENTS_DISABLE_TRACING=1`, which decides the posture for a provider that has NOT
 *     been constructed yet (and for any child process this deployment spawns);
 *  2. call the SDK's `setTracingDisabled(true)`, which is the only thing that can move a provider that
 *     HAS been constructed — its `#disabled` field is a snapshot of (1) taken at construction.
 * Step (2) is why this is correct on every deploy shape, including `--apply-migration`, whose
 * pre-flight loads the boot closure before the serve path runs.
 *
 * Selecting `openai` sets nothing and un-sets nothing: the SDK's default is already to export, and an
 * operator who ALSO set the SDK's own kill-switch keeps it (the banner then honestly reports `off`).
 */
export async function applyDeployAgentTracing(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentTracingPosture> {
  const selected = resolveAgentTracing(env);
  if (selected === 'off') {
    env[SDK_DISABLE_TRACING_ENV] = '1';
    const { setTracingDisabled } = await import('@openai/agents');
    setTracingDisabled(true);
  }
  return selected;
}

/**
 * The OBSERVED trace-export posture: what the SDK will actually do, asked of the SDK.
 *
 * This is the value the boot banner states. It is a live read, not a re-derivation — it creates a
 * throw-away trace through the SDK's global provider and reports `off` exactly when that provider
 * hands back a `NoopTrace`, the same object `run()` would receive. Creating a trace notifies no
 * processor and exports nothing (`TraceProvider.createTrace` only constructs; `Trace.start()` is what
 * dispatches), so the probe itself cannot emit anything.
 *
 * Deriving the banner from `OPENAI_AGENTS_DISABLE_TRACING` instead would make it tautological: the
 * boot writes that variable and would then read its own write back, so a mechanism that had stopped
 * working would still print `OFF`. Asking the provider cannot go wrong in that direction.
 */
export async function observedAgentTracing(): Promise<AgentTracingPosture> {
  const { getGlobalTraceProvider, NoopTrace } = await import('@openai/agents');
  const probe = getGlobalTraceProvider().createTrace({ name: POSTURE_PROBE_TRACE_NAME });
  return probe instanceof NoopTrace ? 'off' : 'openai';
}
