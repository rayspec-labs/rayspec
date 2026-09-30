/**
 * LIVENESS AND READINESS.
 *
 * `GET /livez` answers 200 while the process can answer at all and checks nothing else: a load
 * balancer or supervisor that restarts on a failed liveness probe must not restart a process whose
 * database is merely down, because a restart does not fix that.
 *
 * `GET /health` is readiness: every dependency the running application needs, each a probe that
 * answers `null` when it is fine and a short cause when it is not. The public body carries only
 * the check names with their booleans (and the fields it always carried); the causes are for the
 * runtime-control `health()` operation, and even there name no host, connection string or path.
 *
 *  - `database` — a round trip to the application database.
 *  - `schema` — the platform schema is the one this runtime ships: not missing, not behind, and not
 *    migrated by a newer runtime.
 *  - `bindings` — every boot secret that was supplied as a `<VAR>_FILE` mount is still a readable
 *    regular file (its content is not read again), so a rotation that removed a mounted secret is
 *    seen before the next restart fails on it.
 *  - `assets` — the declared frontend mounts are servable.
 *  - `worker` — the durable worker is running.
 *  - `workflow-system-database` — a round trip to the durable worker's system database.
 *
 * A readiness failure never triggers anything destructive; it only answers 503.
 */
import { randomUUID } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import type { HealthData } from '@rayspec/bundle-contract';
import type { Env, Hono } from 'hono';
import { type CatalogQuery, readPlatformHead, runtimePlatformHead } from './schema-head.js';

export type HealthCheck = HealthData['checks'][number];
export type HealthCheckName = HealthCheck['name'];

/** One readiness dependency: `null` when fine, else a short cause without secrets or topology. */
export interface ReadinessProbe {
  readonly name: HealthCheckName;
  check(): Promise<string | null>;
}

/** The path of the liveness probe. */
export const LIVENESS_PATH = '/livez';

/** How long one readiness probe may take before it counts as failed. */
export const READINESS_PROBE_TIMEOUT_MS = 2_000;

/** Run every probe (each bounded by the timeout) and report them in the order given. */
export async function runReadiness(
  probes: readonly ReadinessProbe[],
  timeoutMs = READINESS_PROBE_TIMEOUT_MS,
): Promise<HealthCheck[]> {
  return Promise.all(
    probes.map(async (probe): Promise<HealthCheck> => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('the check did not answer in time'), timeoutMs);
      });
      try {
        const detail = await Promise.race([probe.check().catch(() => 'the check failed'), timeout]);
        return { name: probe.name, ok: detail === null, detail };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

/** Register `GET /livez`: 200 `{live: true}` while the process answers. */
export function registerLivenessRoute<E extends Env>(app: Hono<E>): void {
  app.get(LIVENESS_PATH, (c) => c.json({ live: true }, 200));
}

/** The database round trip. */
export function databaseProbe(roundTrip: () => Promise<unknown>): ReadinessProbe {
  return {
    name: 'database',
    async check() {
      try {
        await roundTrip();
        return null;
      } catch {
        return 'the application database could not be reached';
      }
    },
  };
}

/** The platform schema is the one this runtime ships. */
export function schemaProbe(query: CatalogQuery): ReadinessProbe {
  return {
    name: 'schema',
    async check() {
      const head = await readPlatformHead(query);
      if (head.state === 'empty') return 'no platform migration is applied';
      if (head.state === 'unknown') {
        return 'the database was migrated by a newer runtime than this one';
      }
      if (head.tag !== runtimePlatformHead()) {
        return 'the platform schema is behind the one this runtime ships';
      }
      return null;
    },
  };
}

/** A boot secret that was supplied as a file mount. */
export interface SecretFile {
  /** The `<VAR>_FILE` variable that named it: what a failure reports. */
  readonly variable: string;
  readonly path: string;
}

/** Every boot secret mounted as a file is still a readable regular file. */
export function bindingsProbe(files: readonly SecretFile[]): ReadinessProbe {
  return {
    name: 'bindings',
    async check() {
      const missing: string[] = [];
      for (const file of files) {
        try {
          if (!statSync(file.path).isFile()) throw new Error('not a file');
          accessSync(file.path, constants.R_OK);
        } catch {
          missing.push(file.variable);
        }
      }
      return missing.length === 0
        ? null
        : `a mounted secret is no longer readable: ${missing.sort().join(', ')}`;
    },
  };
}

/** A fixed boot-time answer (the frontend mounts' readiness, computed once). */
export function staticProbe(name: HealthCheckName, detail: string | null): ReadinessProbe {
  return { name, check: async () => detail };
}

/** The durable worker is running, and its system database answers. */
export function durableWorkerReadiness(executor: {
  readonly running: boolean;
  status(jobId: string): Promise<unknown>;
}): ReadinessProbe[] {
  return [
    {
      name: 'worker',
      check: async () => (executor.running ? null : 'the durable worker is not running'),
    },
    {
      name: 'workflow-system-database',
      check: async () => {
        try {
          // A status read of an id no job has: a round trip to the system database, nothing more.
          await executor.status(randomUUID());
          return null;
        } catch {
          return 'the workflow system database could not be reached';
        }
      },
    },
  ];
}
