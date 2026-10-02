/**
 * `rayspec resume` — release the source fence an export took, for the matching epoch only.
 *
 *   rayspec resume --deployment <id> --fence-epoch <n> [--state-dir <dir>] [--json]
 *
 * The deployment id must be the state directory's and the database's (`RAY_USAGE` otherwise), so a
 * wrong environment is never released. `resume()` then releases the fence only when it is held at
 * exactly `--fence-epoch` (`RAY_FENCE_MISMATCH` otherwise), grants the runtime role back exactly the
 * writes the barrier revoked, and every runtime process restarts its producers within a second.
 * Resuming a fence that is already open at that epoch changes nothing and says so (`released: false`).
 * A fence an import holds is never released here (`RAY_USAGE`): an imported target is released by its
 * cutover (`rayspec import --target <dir> --cutover-token <token>`), a failed one is discarded.
 *
 * A KILLED EXPORT leaves its plaintext capture in `<state-dir>/scratch/`. Before anything else,
 * resume removes it by the rule the next export would apply (only when no live process holds the
 * export's scratch lock; a running export is left alone) and closes the killed export's receipt, so
 * bringing the source back never keeps a plaintext snapshot on disk. What it removed is reported on
 * stderr.
 *
 * The configuration comes from the explicit process environment only, as for `export`. One `resume`
 * envelope on stdout, with or without `--json`.
 */
import { resolve } from 'node:path';
import { type ParseArgsConfig, parseArgs } from 'node:util';
import {
  type BundleError,
  type BundleErrorCode,
  bundleError,
  CONTRACT_VERSION,
} from '@rayspec/bundle-contract';
import type { Db } from '@rayspec/db';
import type { StateDirectory } from '@rayspec/server';
import { type Envelope, envelope } from './envelope.js';

export const RESUME_ARG_OPTIONS = {
  deployment: { type: 'string' },
  'state-dir': { type: 'string' },
  'fence-epoch': { type: 'string' },
} as const satisfies NonNullable<ParseArgsConfig['options']>;

/** Every code `resume` can report: the contract's list for the verb. */
export const RESUME_ERROR_CODES: ReadonlySet<BundleErrorCode> = new Set<BundleErrorCode>([
  'RAY_USAGE',
  'RAY_BINDINGS_FILE_INSECURE',
  'RAY_FENCE_MISMATCH',
  'RAY_LOCK_TIMEOUT',
  'RAY_INFRA_UNAVAILABLE',
  'RAY_INTERNAL',
]);

/** The actor a resume records. */
export const RESUME_ACTOR = 'rayspec-resume';

export interface ResumeCliData {
  deploymentId: string;
  fenceEpoch: number;
  released: boolean;
  environmentRevision: number;
}

export interface ResumeOptions {
  operationId: string;
  json: boolean;
  env?: NodeJS.ProcessEnv;
  /** Where progress lines go. Default: stderr. */
  progress?: (line: string) => void;
}

export interface ResumeOutcome {
  envelope: Envelope;
  summary: string[];
}

class Refused extends Error {
  readonly errors: BundleError[];
  constructor(errors: BundleError[]) {
    super(errors[0]?.message ?? 'refused');
    this.errors = errors;
  }
}

function refuse(code: Parameters<typeof bundleError>[0], message: string, extra = {}): never {
  throw new Refused([bundleError(code, message, extra)]);
}

const DEPLOYMENT_ID = /^[a-z0-9-]{1,64}$/;

function parse(args: readonly string[]): {
  deploymentId: string;
  stateDir: string;
  fenceEpoch: number;
} {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: RESUME_ARG_OPTIONS,
    }));
  } catch (e) {
    refuse('RAY_USAGE', `invalid arguments: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (positionals.length > 0) refuse('RAY_USAGE', 'resume takes no positional argument');
  const deploymentId = values.deployment as string | undefined;
  if (deploymentId === undefined || !DEPLOYMENT_ID.test(deploymentId)) {
    refuse('RAY_USAGE', '--deployment <id> is required: the deploymentId in deployment.json', {
      path: '/deployment',
    });
  }
  const epoch = values['fence-epoch'] as string | undefined;
  const fenceEpoch =
    epoch !== undefined && /^(0|[1-9][0-9]{0,15})$/.test(epoch) ? Number(epoch) : -1;
  if (!Number.isSafeInteger(fenceEpoch) || fenceEpoch < 0) {
    refuse('RAY_USAGE', '--fence-epoch <n> is required: the epoch the export reported', {
      path: '/fence-epoch',
    });
  }
  const stateDir = (values['state-dir'] as string | undefined) ?? '.rayspec-state';
  if (stateDir === '') refuse('RAY_USAGE', '--state-dir needs a directory');
  return { deploymentId, stateDir, fenceEpoch };
}

/** Run `rayspec resume ...`. Never throws for a refusal. */
export async function runResume(
  args: readonly string[],
  options: ResumeOptions,
): Promise<ResumeOutcome> {
  const env = options.env ?? process.env;
  const progress = options.progress ?? ((line: string) => process.stderr.write(`${line}\n`));
  const server = await import('@rayspec/server');
  server.installOutputRedaction();
  let control: Db | null = null;
  let workflowControl: Db | null = null;
  /** The state directory and the killed export whose receipt is still to be closed. */
  let interrupted: { dir: StateDirectory; operationId: string } | null = null;
  const closeInterrupted = async (db: Db | null): Promise<void> => {
    if (interrupted === null) return;
    const { dir, operationId } = interrupted;
    interrupted = null;
    await server
      .closeInterruptedExport(dir, operationId, options.operationId, db)
      .catch(() => null);
  };
  const answer = (data: ResumeCliData | null, errors: BundleError[]): ResumeOutcome => {
    const result = envelope('resume', options.operationId, data, errors);
    const first = result.errors[0];
    return {
      envelope: result,
      summary:
        first !== undefined
          ? [`refused: ${first.code}${first.reason ? ` (${first.reason})` : ''} — ${first.message}`]
          : data === null
            ? []
            : [
                data.released
                  ? `released the fence of deployment ${data.deploymentId} at epoch ${data.fenceEpoch}; the source accepts writes again`
                  : `the fence of deployment ${data.deploymentId} was already open at epoch ${data.fenceEpoch}; nothing changed`,
              ],
    };
  };
  try {
    const p = parse(args);
    let stateDir: StateDirectory | null;
    try {
      stateDir = await server.openStateDirectory(resolve(p.stateDir), { create: false });
    } catch (err) {
      if (err instanceof server.StateDirectoryError) throw new Refused([err.error]);
      throw err;
    }
    let recorded: Awaited<ReturnType<StateDirectory['readDeployment']>> = null;
    try {
      recorded = stateDir === null ? null : await stateDir.readDeployment();
    } catch (err) {
      if (err instanceof server.StateDirectoryError) throw new Refused([err.error]);
      throw err;
    }
    if (recorded === null || recorded.deploymentId !== p.deploymentId) {
      refuse(
        'RAY_USAGE',
        recorded === null
          ? 'there is no deployment state directory at --state-dir'
          : '--deployment is not the deployment of this state directory',
        { path: '/deployment' },
      );
    }
    const dir = stateDir;
    if (dir === null) refuse('RAY_USAGE', 'there is no deployment state directory at --state-dir');

    // What a killed export left behind, its plaintext included, goes first.
    let cleared: Awaited<ReturnType<typeof server.clearInterruptedExportScratch>>;
    try {
      cleared = await server.clearInterruptedExportScratch(dir, options.operationId);
    } catch (err) {
      if (err instanceof server.StateDirectoryError) throw new Refused([err.error]);
      throw err;
    }
    if (cleared.exportRunning) {
      progress('an export of this deployment is running; its scratch directory was left alone');
    } else if (cleared.removedEntries > 0 || cleared.cleanedUpAfter !== null) {
      progress(
        `removed what an interrupted export${cleared.cleanedUpAfter === null ? '' : ` (${cleared.cleanedUpAfter})`} ` +
          'left in the scratch directory',
      );
    }
    if (cleared.cleanedUpAfter !== null) {
      interrupted = { dir, operationId: cleared.cleanedUpAfter };
    }

    let config: ReturnType<typeof server.loadExportSourceConfig>;
    try {
      config = server.loadExportSourceConfig(env, () => {});
    } catch (err) {
      if (err instanceof server.BootConfigError) {
        refuse(
          'RAY_USAGE',
          `${err.message.replace(/^[^—]*— /, '')} A resume reads its configuration from the ` +
            'explicit process environment only; no .env file is loaded',
        );
      }
      throw err;
    }
    const controlUrl = config.migrationDatabaseUrl ?? config.databaseUrl;
    const controlWorkflowUrl =
      config.migrationDbosSystemDatabaseUrl ?? config.dbosSystemDatabaseUrl;
    const runtimeRole =
      config.migrationDatabaseUrl === undefined
        ? undefined
        : decodeURIComponent(new URL(config.databaseUrl).username);
    control = server.openControlDatabase(controlUrl);
    let identity: Awaited<ReturnType<typeof server.readEnvironmentIdentity>>;
    try {
      identity = await server.readEnvironmentIdentity(control);
      workflowControl = await server.openWorkflowSystemDatabase(control, controlWorkflowUrl);
    } catch {
      refuse(
        'RAY_INFRA_UNAVAILABLE',
        'the environment database could not be read; check that DATABASE_URL names a reachable ' +
          'database and retry',
      );
    }
    if (identity.deploymentId !== p.deploymentId) {
      refuse(
        'RAY_USAGE',
        'the database named by the environment belongs to another deployment than --deployment',
        { path: '/deployment' },
      );
    }
    await closeInterrupted(control);
    const rc = server.createRuntimeControl({
      db: control,
      ...(runtimeRole !== undefined && runtimeRole !== '' ? { runtimeRole } : {}),
      ...(workflowControl !== null ? { workflowSystemDb: workflowControl } : {}),
    });
    const resumed = await rc.resume({
      contractVersion: CONTRACT_VERSION,
      operationId: options.operationId,
      actor: RESUME_ACTOR,
      fenceEpoch: p.fenceEpoch,
    });
    if (!resumed.ok || resumed.data === null) return answer(null, resumed.errors);
    return answer(
      {
        deploymentId: p.deploymentId,
        fenceEpoch: resumed.data.fenceEpoch,
        released: resumed.data.released,
        environmentRevision: resumed.data.environmentRevision,
      },
      [],
    );
  } catch (err) {
    if (err instanceof Refused) return answer(null, err.errors);
    throw err;
  } finally {
    // A refusal before the environment was reached still closes the killed export's local receipt.
    await closeInterrupted(null);
    await workflowControl?.$client.end().catch(() => {});
    await control?.$client.end().catch(() => {});
  }
}
