/**
 * The SIGNAL-RELEASE BOOT SCRIPT — a real composed server (assembleServer + the durable worker +
 * the task dispatcher + the real workforce HTTP routes) for an agent-free spec. Run as a child
 * process by workforce-signal-e2e.db.test.ts via `node --import tsx`, exactly as the acceptance
 * story's boot script is, so the CLI under test speaks to a REAL deployment over real HTTP rather
 * than an in-process handle.
 *
 * NO turn handlers are injected, deliberately. That suite constructs its park through the engine's
 * own review path and then PAUSES the workforce, so nothing is ever dispatched: what it proves is
 * the operator console's release of a park, and a dispatcher racing the assertions would only add
 * a way for the proof to be flaky. Signal delivery is unaffected by the pause — `deliverSignal`
 * writes the signal row and takes the park's wake transition with no reference to the control
 * state — which is exactly why the pause is a safe way to make the story deterministic.
 *
 * Everything else (DATABASE_URL, secrets, spec path, port, tenant) arrives through the
 * environment, the same contract the production entrypoints read.
 */
import { serve } from '@hono/node-server';
import { registerProductStores } from '@rayspec/db/composition';
import { assembleServer, loadServerConfig } from '@rayspec/server';

const config = loadServerConfig();
const server = await assembleServer(config, {
  registerProductTables: registerProductStores,
  // A truthy backends map is what constructs the durable worker for an agent-free spec (without
  // one the whole workforce surface fail-closes 501). The resolver never runs: no agent is ever
  // enqueued, and the workforce is paused for the length of the story.
  agentBackendsFactory: () => ({}) as never,
});

serve({ fetch: server.app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`[workforce-signal-e2e] serving on ${info.address}:${info.port}`);
});
