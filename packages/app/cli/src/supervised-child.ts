/**
 * The application process of a supervised `rayspec deploy` (`@rayspec/server` supervisor.ts).
 *
 * With role separation, the `rayspec deploy` the operator started keeps the migration role and never
 * imports the application; it starts this module with an environment that never held a privileged
 * connection and tells it, over their private channel, what to serve: the spec document a
 * `rayspec deploy <spec.yaml>` was given, or the version a `rayspec deploy <file.ray>` staged. This
 * process then boots and serves exactly as the single process did — the rehearsal, the banner, the
 * signals, the drain, the `--json` envelope — and the supervisor runs each schema change of the boot
 * for it. Started by hand, it exits 70.
 */
import type { SupervisorConnection } from '@rayspec/server';
import type { DeployReporting } from './deploy.js';
import type { BundleServeInstruction } from './deploy-bundle.js';

/** What a supervised `rayspec deploy <spec.yaml>` serves: the deploy's own arguments. */
export interface DeployServeInstruction {
  kind: 'deploy';
  specPath: string;
  port?: string;
  host?: string;
  migrationPath?: string;
  allowlistPath?: string;
  reporting: DeployReporting;
}

function isDeployInstruction(value: unknown): value is DeployServeInstruction {
  const v = value as Partial<DeployServeInstruction> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    v.kind === 'deploy' &&
    typeof v.specPath === 'string' &&
    typeof v.reporting === 'object' &&
    v.reporting !== null
  );
}

function isBundleInstruction(value: unknown): value is BundleServeInstruction {
  const v = value as Partial<BundleServeInstruction> | null;
  return typeof v === 'object' && v !== null && v.kind === 'bundle';
}

async function serveSupervised(): Promise<void> {
  const { connectToSupervisor, NoSupervisorError } = await import('@rayspec/server');
  let supervisor: SupervisorConnection;
  try {
    supervisor = await connectToSupervisor();
  } catch (err) {
    if (err instanceof NoSupervisorError) {
      console.error(`[rayspec deploy] ${err.message}`);
      process.exit(err.exitCode);
    }
    throw err;
  }
  const instruction = supervisor.instruction;
  if (isDeployInstruction(instruction)) {
    const { serveDeployment } = await import('./deploy.js');
    await serveDeployment(
      instruction.specPath,
      instruction.port,
      instruction.migrationPath,
      instruction.allowlistPath,
      instruction.host,
      instruction.reporting,
      { supervisor },
    );
    return;
  }
  if (isBundleInstruction(instruction)) {
    const { serveStagedBundle } = await import('./deploy-bundle.js');
    await serveStagedBundle(instruction, supervisor);
    return;
  }
  console.error('[rayspec deploy] the supervisor sent an instruction this runtime does not know');
  process.exit(70);
}

serveSupervised().catch((err: unknown) => {
  console.error('[rayspec deploy] boot failed:', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
