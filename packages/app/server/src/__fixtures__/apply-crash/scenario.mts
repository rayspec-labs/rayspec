/**
 * The applies the crash suite runs, shared by the child process it kills (`child.mts`) and the
 * suite itself, which restarts and reconciles. Each is a real apply over a real database; only the
 * steps are small.
 *
 *  - `marker`: one effect step that inserts a row into `apply_probe`, with an observer that counts
 *    the rows — so a restart can tell whether the insert happened.
 *  - `external`: one effect step with an outside effect (a line appended to a file) and no observer:
 *    what it did cannot be read back, so an interruption leaves it unknown.
 *
 * The plan digest covers the product schema digest and the environment revision, so an unrelated
 * schema change or another apply makes a prepared plan stale.
 *
 * An `.mts` file, like the other server fixtures, so the package build leaves it out of `dist`.
 */
import { appendFileSync } from 'node:fs';
import { CONTRACT_VERSION, digestOf } from '@rayspec/bundle-contract';
import type { Db } from '@rayspec/db';
import type { ApplyControl, ApplyStep, StateObservers } from '../../apply-operation.js';
import { readProductSchemaDigest } from '../../schema-head.js';

export function query(db: Db) {
  return async (sql: string, params: unknown[] = []) =>
    (await db.$client.unsafe(sql, params as never[])) as unknown as Record<string, unknown>[];
}

export async function liveRevision(db: Db): Promise<number> {
  const rows = await query(db)(
    'SELECT environment_revision::text AS r FROM runtime_control_state WHERE id = 1',
  );
  return rows[0] === undefined ? 1 : Number(rows[0].r);
}

/** The probe plan's digest over the live state. */
export async function probePlan(db: Db, label: string): Promise<string> {
  return digestOf({
    label,
    product: await readProductSchemaDigest(query(db)),
    environmentRevision: await liveRevision(db),
  });
}

export function control(
  operationId: string,
  planDigest: string,
  expectedEnvironmentRevision: number,
  idempotencyKey: string,
): ApplyControl {
  return {
    contractVersion: CONTRACT_VERSION,
    operationId,
    actor: 'operator:apply-crash',
    planDigest,
    expectedEnvironmentRevision,
    idempotencyKey,
  };
}

export function observers(db: Db): StateObservers {
  return {
    probe: async () => {
      const rows = await query(db)('SELECT count(*)::text AS n FROM apply_probe');
      return String(rows[0]?.n);
    },
  };
}

/** Insert `marker` into the probe table; pending while the table holds no row. */
export function markerStep(db: Db, marker: string): ApplyStep {
  return {
    kind: 'effect',
    name: 'mark',
    observer: 'probe',
    expectedAfter: '1',
    pending: async () => {
      const rows = await query(db)('SELECT count(*)::text AS n FROM apply_probe');
      return rows[0]?.n === '0';
    },
    run: async () => {
      await db.$client.unsafe('INSERT INTO apply_probe (marker) VALUES ($1)', [marker]);
      return {};
    },
  };
}

/** Append a line to `file`: an effect nothing can read back. */
export function externalStep(file: string, line: string): ApplyStep {
  return {
    kind: 'effect',
    name: 'notify-external',
    run: async () => {
      appendFileSync(file, `${line}\n`);
      return {};
    },
  };
}
