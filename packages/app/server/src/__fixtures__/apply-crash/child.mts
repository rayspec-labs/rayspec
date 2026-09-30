/**
 * A REAL process for the apply crash suite: it runs one apply against the database and, at the
 * checkpoint the suite names, prints `CHECKPOINT <point>` and stops there, holding whatever it holds
 * (the lease, an open transaction) until the suite kills it with SIGKILL. Nothing is cleaned up on
 * the way out, exactly as for a process that dies.
 *
 * Environment: `APPLY_DB_URL`; `APPLY_SCENARIO` — `marker`, `external`, `legacy-product` or
 * `legacy-platform`; `APPLY_KILL_AT` — `after-intent`, `after-step-started` or `after-step-effect`;
 * `APPLY_OPERATION_ID` and `APPLY_KEY` for the probe applies; `APPLY_EXTERNAL_FILE` for `external`.
 * Prints `DONE <envelope>` if the checkpoint is never reached.
 */
import { makeDb } from '@rayspec/db';
import { type ApplyCheckpoint, runApply } from '../../apply-operation.js';
import { applyMigrations } from '../../composition-root.js';
import { DeployApply } from '../../deploy-apply.js';
import {
  control,
  externalStep,
  liveRevision,
  markerStep,
  observers,
  probePlan,
} from './scenario.mjs';

const env = process.env;
const db = makeDb(env.APPLY_DB_URL as string, 4);
const killAt = env.APPLY_KILL_AT as ApplyCheckpoint;
const scenario = env.APPLY_SCENARIO;
const LEASE_TTL_MS = 1_500;

async function onCheckpoint(point: ApplyCheckpoint): Promise<void> {
  if (point !== killAt) return;
  process.stdout.write(`CHECKPOINT ${point}\n`);
  // Keep the process (and its open transaction) alive until it is killed.
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}

async function main(): Promise<void> {
  if (scenario === 'marker' || scenario === 'external') {
    const planDigest = await probePlan(db, 'probe');
    const result = await runApply({
      db,
      request: control(
        env.APPLY_OPERATION_ID as string,
        planDigest,
        await liveRevision(db),
        env.APPLY_KEY as string,
      ),
      plan: { recompute: () => probePlan(db, 'probe') },
      steps: [
        scenario === 'marker'
          ? markerStep(db, 'child')
          : externalStep(env.APPLY_EXTERNAL_FILE as string, 'child'),
      ],
      observers: observers(db),
      leaseTtlMs: LEASE_TTL_MS,
      onCheckpoint,
    });
    process.stdout.write(`DONE ${JSON.stringify(result)}\n`);
    return;
  }
  const deployApply = new DeployApply({
    db,
    migratePlatform: () => applyMigrations(db),
    specSource: 'apply-crash',
    leaseTtlMs: LEASE_TTL_MS,
    onCheckpoint,
  });
  if (scenario === 'legacy-platform') {
    await deployApply.platformChain();
  } else {
    await deployApply.productMigration(
      {
        name: '0000_product_stores.sql',
        sql:
          'CREATE TABLE "crash_a" ("id" text PRIMARY KEY);\n--> statement-breakpoint\n' +
          'CREATE TABLE "crash_b" ("id" text PRIMARY KEY, "a" text REFERENCES "crash_a" ("id"));',
      },
      { stores: [] },
    );
  }
  process.stdout.write('DONE {}\n');
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`FAILED ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(3);
  },
);
