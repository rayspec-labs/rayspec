/**
 * BOOT-LOG HYGIENE for a failed extension-service database write — DB-backed, against a real driver
 * error rather than a hand-built lookalike.
 *
 * A service that fails on a write during boot aborts the whole deployment, and the abort message is
 * the one log an operator is most likely to paste into a ticket, a chat or a support thread. The
 * refusal has to keep naming the STATEMENT — an operator cannot diagnose a write they cannot see —
 * and must not carry the BIND VALUES, which are arbitrary data the extension chose to persist.
 *
 * WHY THE ERROR HERE IS REAL. The ORM wraps a driver failure in an error whose `message` embeds the
 * statement AND the values, and which carries them again as enumerable own properties, so it leaks
 * three ways at once: through `.message`, through `String(err)`, and through anything that inspects
 * the object (`console.error(msg, err)`). A fabricated error would agree with whatever this suite
 * assumed; this one is produced by making Postgres reject a real parameterized statement, so the
 * shape under test is the shape a deployment actually raises.
 *
 * THE CANARY IS THE ACCEPT CONTROL'S OTHER HALF. Every assertion below is "this string is absent",
 * and an absence proves nothing unless the string is provably present in the unredacted material —
 * so each case also asserts the canary IS in the raw error it started from. A test that only checked
 * absence would keep passing if the fixture silently stopped putting the value in the statement.
 */
import { operatorSafeDbErrorMessage } from '@rayspec/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestDb } from '../test-support/test-db.js';
import { bootPackServices, type LoadedPackService, PackServiceError } from './pack-services.js';

/** The value that must never reach a log. Distinctive enough that a substring match is decisive. */
const CANARY = 'CANARY-a1b2c3-must-not-reach-a-log';

const db = makeTestDb();

/** A table of this suite's own, so nothing here depends on another suite's rows. */
const TABLE = 'pack_log_hygiene_probe';

/**
 * Provoke a REAL wrapped driver error: a parameterized insert, through the ORM, that violates the
 * primary key — with the canary bound as a value rather than spliced into the statement.
 */
async function realWrappedQueryError(): Promise<unknown> {
  const { sql } = await import('drizzle-orm');
  try {
    await db.execute(
      sql.raw(`INSERT INTO ${TABLE} (id, payload) VALUES ('dup', '${CANARY.replace(/'/g, "''")}')`),
    );
  } catch {
    // The raw form is only the seed for the duplicate below; its own failure is not the subject.
  }
  try {
    await db.execute(
      sql`INSERT INTO ${sql.identifier(TABLE)} (id, payload) VALUES (${'dup'}, ${CANARY})`,
    );
  } catch (e) {
    return e;
  }
  throw new Error('expected the duplicate-key insert to fail');
}

describe('a failed extension-service write does not print its bind values', () => {
  beforeAll(async () => {
    await db.$client.unsafe(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (id text primary key, payload text not null)`,
    );
    await db.$client.unsafe(
      `INSERT INTO ${TABLE} (id, payload) VALUES ('dup', 'seed') ON CONFLICT DO NOTHING`,
    );
  });

  afterAll(async () => {
    await db.$client.unsafe(`DROP TABLE IF EXISTS ${TABLE}`);
    await db.$client.end();
  });

  it('the raw ORM error DOES carry the value — the control this suite rests on', async () => {
    const raw = await realWrappedQueryError();
    const message = raw instanceof Error ? raw.message : String(raw);
    // If any of these three stopped holding, the redaction below would be testing nothing.
    expect(message).toContain(CANARY);
    expect(String(raw)).toContain(CANARY);
    expect(JSON.stringify(Object.entries(raw as object))).toContain(CANARY);
  });

  it('the operator-safe rendering withholds the values and keeps the statement', async () => {
    const raw = await realWrappedQueryError();
    const safe = operatorSafeDbErrorMessage(raw);

    expect(safe).not.toContain(CANARY);
    // The statement survives — an operator has to be able to see WHICH write failed.
    expect(safe).toContain(TABLE);
    expect(safe).toContain('INSERT INTO');
    // Withheld VISIBLY: a reader must not conclude the statement ran without parameters.
    expect(safe).toMatch(/withheld/i);
    expect(safe).toMatch(/\b2 bind values\b/);
    // The driver's own primary message is what tells an operator WHY it failed.
    expect(safe).toContain('duplicate key value');
  });

  it('a boot abort names the extension, the service and the statement — never the values', async () => {
    const raw = await realWrappedQueryError();
    const failing: LoadedPackService = {
      packId: 'probe-extension',
      name: 'ledger-writer',
      module: 'services/ledger-writer.ts',
      boot: () => Promise.reject(raw),
      shutdown: () => Promise.resolve(),
    };

    const thrown = await bootPackServices([failing], () => ({}) as never).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(thrown).toBeInstanceOf(PackServiceError);
    const message = (thrown as PackServiceError).message;
    expect(message).not.toContain(CANARY);
    // Everything an operator needs to act is still there.
    expect(message).toContain('probe-extension');
    expect(message).toContain('ledger-writer');
    expect(message).toContain('services/ledger-writer.ts');
    expect(message).toContain(TABLE);
    expect(message).toMatch(/withheld/i);
    // And the whole rendered abort — not just its message — stays clean.
    expect(String(thrown)).not.toContain(CANARY);
  });

  it('an error carrying no statement is passed through unchanged', () => {
    expect(operatorSafeDbErrorMessage(new Error('a plain refusal'))).toBe('a plain refusal');
    expect(operatorSafeDbErrorMessage('not an error at all')).toBe('not an error at all');
  });
});
