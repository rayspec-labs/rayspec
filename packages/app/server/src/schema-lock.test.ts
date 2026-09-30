/**
 * The schema lock's bounded wait without a database: the statements it sends, the mapping of a wait
 * that ran out, and the fail-closed parse of RAYSPEC_SCHEMA_LOCK_TIMEOUT_MS. The lock itself is
 * exercised against a real database in schema-lock.db.test.ts.
 */
import { SCHEMA_LOCK_NAMESPACE, SCHEMA_LOCK_SLOT } from '@rayspec/bundle-contract';
import { describe, expect, it } from 'vitest';
import { BootConfigError } from './boot-config-error.js';
import { parseSchemaLockTimeoutMs } from './composition-root.js';
import { lockSchemaInTransaction, SchemaLockTimeoutError } from './schema-lock.js';

function recordingTx(failLockWith?: unknown) {
  const sent: { query: string; parameters?: unknown[] }[] = [];
  return {
    sent,
    tx: {
      async unsafe(query: string, parameters?: unknown[]) {
        sent.push(parameters === undefined ? { query } : { query, parameters });
        if (failLockWith !== undefined && query.includes('pg_advisory_xact_lock')) {
          throw failLockWith;
        }
        return [];
      },
    },
  };
}

describe('lockSchemaInTransaction', () => {
  it('bounds the wait, takes the shared pair, then restores the default lock timeout', async () => {
    const { sent, tx } = recordingTx();
    await lockSchemaInTransaction(tx, 1500);
    expect(sent).toEqual([
      { query: "SELECT set_config('lock_timeout', $1, true)", parameters: ['1500ms'] },
      {
        query: 'SELECT pg_advisory_xact_lock($1::int4, $2::int4)',
        parameters: [SCHEMA_LOCK_NAMESPACE, SCHEMA_LOCK_SLOT],
      },
      { query: 'SET LOCAL lock_timeout TO DEFAULT' },
    ]);
    expect([SCHEMA_LOCK_NAMESPACE, SCHEMA_LOCK_SLOT]).toEqual([1918990707, 1]);
  });

  it('turns lock_not_available into a retryable SchemaLockTimeoutError', async () => {
    const { tx } = recordingTx(Object.assign(new Error('canceling statement'), { code: '55P03' }));
    const refused = await lockSchemaInTransaction(tx, 200).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(SchemaLockTimeoutError);
    expect(refused).toMatchObject({ code: 'RAY_LOCK_TIMEOUT', retryable: true });
  });

  it('passes any other failure through unchanged', async () => {
    const other = Object.assign(new Error('connection lost'), { code: '08006' });
    const { tx } = recordingTx(other);
    await expect(lockSchemaInTransaction(tx, 200)).rejects.toBe(other);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
  ])('refuses a timeout of %s before sending anything', async (ms) => {
    const { sent, tx } = recordingTx();
    await expect(lockSchemaInTransaction(tx, ms)).rejects.toThrow(RangeError);
    expect(sent).toEqual([]);
  });
});

describe('parseSchemaLockTimeoutMs', () => {
  it('defaults to 60 seconds when unset or blank', () => {
    expect(parseSchemaLockTimeoutMs({})).toBe(60_000);
    expect(parseSchemaLockTimeoutMs({ RAYSPEC_SCHEMA_LOCK_TIMEOUT_MS: '  ' })).toBe(60_000);
  });

  it('accepts a whole number of milliseconds up to one hour', () => {
    expect(parseSchemaLockTimeoutMs({ RAYSPEC_SCHEMA_LOCK_TIMEOUT_MS: '250' })).toBe(250);
    expect(parseSchemaLockTimeoutMs({ RAYSPEC_SCHEMA_LOCK_TIMEOUT_MS: '3600000' })).toBe(3_600_000);
  });

  it.each(['0', '-5', '1.5', '1e3', 'soon', '3600001'])('aborts the boot on %s', (raw) => {
    expect(() => parseSchemaLockTimeoutMs({ RAYSPEC_SCHEMA_LOCK_TIMEOUT_MS: raw })).toThrow(
      BootConfigError,
    );
  });
});
