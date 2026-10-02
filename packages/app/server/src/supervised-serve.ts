/**
 * The application process of a supervised `rayspec-serve` (supervisor.ts): started by the
 * `rayspec-serve` the operator ran, which holds the migration role, with an environment that never
 * held a privileged connection. It boots and serves exactly as a single-role `rayspec-serve` does,
 * with every schema change of its boot run by its supervisor. Started by hand, it exits 70.
 */
import { applyServeAgentTracing } from './agent-tracing.js';
import { loadServerConfig } from './composition-root.js';
import { exitOnBootFailure, serveConfigured } from './serve.js';
import { connectToSupervisor, NoSupervisorError } from './supervised-channel.js';

async function serveSupervised(): Promise<void> {
  const supervisor = await connectToSupervisor();
  // The supervisor applied the same posture before it started this process; the agent SDK this
  // process loads snapshots it again.
  await applyServeAgentTracing();
  // The supervisor read the same configuration and reported its warnings already.
  const config = loadServerConfig(process.env, () => {});
  await serveConfigured({ ...config, roleSeparation: 'supervised' }, supervisor);
}

serveSupervised().catch((err: unknown) => {
  if (err instanceof NoSupervisorError) {
    console.error(`[rayspec-serve] ${err.message}`);
    process.exit(err.exitCode);
  }
  exitOnBootFailure(err);
});
