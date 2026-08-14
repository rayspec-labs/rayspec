/**
 * Ask the INSTALLED agent SDK what it will actually do, after replaying the module order
 * `rayspec deploy` takes. Run as a CHILD PROCESS by deploy-agent-tracing.sdk.test.ts.
 *
 * It has to be a separate process for one reason: `@openai/agents-core`'s config reports tracing as
 * disabled whenever `NODE_ENV === 'test'`, which is exactly what vitest sets. Inside a vitest worker
 * both arms would answer "off" and the assertion would be satisfied by a build that exports every
 * prompt it sees. The parent spawns this with `NODE_ENV=production` so the two arms can differ.
 *
 * PROBE_ORDER selects which boot shape to replay:
 *   serve             — `rayspec deploy <spec>`: the trace posture is applied before the boot closure
 *                       (and therefore before the agent SDK) is imported.
 *   closure-first     — `rayspec deploy --apply-migration …`: the pre-flight imports `@rayspec/server`
 *                       FIRST, so the SDK's global trace provider already exists — and has already
 *                       snapshotted the kill-switch — by the time the posture is applied.
 *   serve-entrypoint  — `rayspec-serve`: that entrypoint imports the composition root STATICALLY, so
 *                       the closure — and the provider — always exist by the time `main()` runs and
 *                       calls `applyServeAgentTracing`. There is no other order available to it.
 *   serve-entrypoint-env-only
 *                     — the REJECT CONTROL for the order above: import the closure, then write the
 *                       SDK's kill-switch and nothing else. That is all an env-write-only fix could do
 *                       at this entrypoint, and the provider has already snapshotted the value.
 *   untouched         — the CONTROL: import the closure and apply nothing. The SDK's own default.
 *
 * The verdict is read off the SDK, not off an environment variable: `createTrace()` returns a
 * `NoopTrace` exactly when the export is off, and a `Trace` when it is live. Creating a trace notifies
 * no processor and sends nothing, so the probe itself never reaches the network.
 */
import { createRequire } from 'node:module';

const order = process.env.PROBE_ORDER;
const serveEntrypoint = order === 'serve-entrypoint' || order === 'serve-entrypoint-env-only';

if (order === 'closure-first' || serveEntrypoint) await import('@rayspec/server');

let selected = null;
if (order === 'serve-entrypoint') {
  const { applyServeAgentTracing } = await import('@rayspec/server/agent-tracing');
  // `undefined` — the variable stated no intention and this boot changed nothing — reports as null.
  selected = (await applyServeAgentTracing()) ?? null;
} else if (order === 'serve-entrypoint-env-only') {
  // Deliberately only half of what the code under test does. Named literally rather than imported:
  // this arm exists to fail if the SDK's env switch alone were enough at this order.
  process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
} else if (order !== 'untouched') {
  const { applyDeployAgentTracing } = await import('@rayspec/server/agent-tracing');
  selected = await applyDeployAgentTracing();
}

// The serve path's own import of the boot closure — it happens either way, and after the posture is
// applied on the `serve` shape.
await import('@rayspec/server');

const { observedAgentTracing } = await import('@rayspec/server/agent-tracing');

// Reach the SDK through the package that declares it, and read the trace class NAME rather than using
// `instanceof`: this is a deliberately independent read of the same global provider, so it must not
// borrow the module instance (or the helper) that the code under test uses.
const requireFromServer = createRequire(import.meta.resolve('@rayspec/server'));
const { getGlobalTraceProvider } = requireFromServer('@openai/agents');
const trace = getGlobalTraceProvider().createTrace({ name: 'probe' });

process.stdout.write(
  `${JSON.stringify({
    selected,
    trace: trace.constructor.name,
    observed: await observedAgentTracing(),
    sdkSwitch: process.env.OPENAI_AGENTS_DISABLE_TRACING ?? null,
    nodeEnv: process.env.NODE_ENV ?? null,
  })}\n`,
);
