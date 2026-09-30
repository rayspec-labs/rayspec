/**
 * THE DATABASE WRITE BARRIER a quiesce holds, in the two forms the contract accepts.
 *
 * `database-write-role` — with role separation, the runtime connects as its own role that owns no
 * table. The barrier REVOKES that role's INSERT, UPDATE, DELETE and TRUNCATE on every table, in the
 * same transaction that records exactly which privileges it held, and a resume GRANTs back exactly
 * those. The application cannot undo it: only a table's owner can grant on it, and the runtime role
 * owns nothing. The connection that runs the barrier (the snapshot reader) keeps every privilege it
 * had. The one table left writable is the process heartbeat (`runtime_control_processes`), so a
 * fenced process can still report that it drained; it holds no application data and is never
 * exported.
 *
 * The barrier is checked, never assumed. Membership counts whether or not it is inherited: a member of
 * a role can `SET ROLE` to it and use its privileges, so every check covers the runtime role AND every
 * role it is a member of. The barrier is refused (and nothing is revoked) when the role does not
 * exist, when it or a role it belongs to is a superuser, bypasses row security or may create roles
 * (a role that can create roles can grant itself membership), or owns any table; and after the REVOKE
 * every table is re-checked with `has_table_privilege` for the role and each role it belongs to, which
 * also sees privileges held through PUBLIC. A write privilege that survives means the barrier is
 * `unavailable`, and the transaction that tried is rolled back.
 *
 * `database-stopped-source` — without role separation nothing the runtime can do stops its own
 * writes, so the only barrier is a source that is not running: the operator attests that every
 * runtime process is stopped, and no session other than the caller's own is connected to either
 * database. The caller's own sessions are the ones tagged with its application name (`rayspec-control-`
 * plus a random suffix, `openControlDatabase`), so a pool the caller opened some other way counts as
 * someone else's session and the barrier is not held.
 */
import { randomBytes } from 'node:crypto';
import { makeDb } from '@rayspec/db';

/** A postgres.js handle, as far as this module uses it. */
export interface BarrierTx {
  unsafe(query: string, parameters?: unknown[]): PromiseLike<unknown>;
}

/** The write privileges the barrier revokes and restores. */
export const WRITE_PRIVILEGES = ['DELETE', 'INSERT', 'TRUNCATE', 'UPDATE'] as const;
export type WritePrivilege = (typeof WRITE_PRIVILEGES)[number];

/** The one table the barrier leaves writable: the process heartbeat. */
export const BARRIER_EXEMPT_TABLE = 'public.runtime_control_processes';

/** One table's write privileges the role held directly, recorded so a resume restores exactly them. */
export interface RecordedGrant {
  schema: string;
  table: string;
  privileges: WritePrivilege[];
}

/** Why a barrier could not be held. Names no host, user or path. */
export class BarrierUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'BarrierUnavailableError';
  }
}

/** Application names of the caller's own control sessions start with this. */
export const CONTROL_APPLICATION_PREFIX = 'rayspec-control-';

const SCHEMAS_FILTER = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'`;

/**
 * Open a control connection pool whose sessions are tagged as the caller's own, so the stopped-source
 * check can tell them from a runtime's.
 */
export function openControlDatabase(url: string, maxPoolSize = 2): ReturnType<typeof makeDb> {
  return makeDb(url, maxPoolSize, {
    applicationName: `${CONTROL_APPLICATION_PREFIX}${randomBytes(8).toString('hex')}`,
  });
}

async function rows<T>(tx: BarrierTx, query: string, params: unknown[] = []): Promise<T[]> {
  return (await tx.unsafe(query, params)) as T[];
}

function isWritePrivilege(value: unknown): value is WritePrivilege {
  return typeof value === 'string' && (WRITE_PRIVILEGES as readonly string[]).includes(value);
}

/**
 * Revoke `role`'s write privileges on every table of the connected database, inside `tx`, and return
 * what it held. Throws `BarrierUnavailableError` when the barrier cannot be held; the caller rolls
 * `tx` back.
 */
export async function revokeWrites(tx: BarrierTx, role: string): Promise<RecordedGrant[]> {
  const [roleRow] = await rows<{ n: number }>(
    tx,
    'SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1',
    [role],
  );
  if ((roleRow?.n ?? 0) === 0) throw new BarrierUnavailableError('the runtime role does not exist');
  // The role itself and every role it can SET ROLE to (MEMBER, not USAGE: an uninherited membership
  // still lets it switch).
  const [powerful] = await rows<{ n: number }>(
    tx,
    `SELECT count(*)::int AS n FROM pg_roles m
      WHERE pg_has_role($1, m.oid, 'MEMBER')
        AND (m.rolsuper OR m.rolbypassrls OR m.rolcreaterole)`,
    [role],
  );
  if ((powerful?.n ?? 0) > 0) {
    throw new BarrierUnavailableError(
      'the runtime role, or a role it is a member of, is a superuser, bypasses row security or may ' +
        'create roles, so no privilege can fence it',
    );
  }
  const owned = await rows<{ n: number }>(
    tx,
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND ${SCHEMAS_FILTER} AND pg_has_role($1, c.relowner, 'MEMBER')`,
    [role],
  );
  if ((owned[0]?.n ?? 0) > 0) {
    throw new BarrierUnavailableError(
      'the runtime role owns a table (or can act as its owner), so it could grant itself back',
    );
  }
  const held = await rows<{ schema: string; table: string; privileges: unknown[] }>(
    tx,
    `SELECT n.nspname::text AS schema, c.relname::text AS table,
            array_agg(DISTINCT a.privilege_type ORDER BY a.privilege_type) AS privileges
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE c.relkind IN ('r', 'p') AND ${SCHEMAS_FILTER}
        AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)
        AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
      GROUP BY 1, 2 ORDER BY 1, 2`,
    [role],
  );
  const recorded: RecordedGrant[] = [];
  for (const g of held) {
    if (`${g.schema}.${g.table}` === BARRIER_EXEMPT_TABLE) continue;
    const privileges = g.privileges.filter(isWritePrivilege);
    if (privileges.length === 0) continue;
    recorded.push({ schema: g.schema, table: g.table, privileges });
    const [stmt] = await rows<{ stmt: string }>(
      tx,
      "SELECT format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE %I.%I FROM %I', $1::text, $2::text, $3::text) AS stmt",
      [g.schema, g.table, role],
    );
    if (stmt !== undefined) await tx.unsafe(stmt.stmt);
  }
  const surviving = await rows<{ n: number }>(
    tx,
    `SELECT count(*)::int AS n
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN pg_roles m
      WHERE c.relkind IN ('r', 'p') AND ${SCHEMAS_FILTER}
        AND (n.nspname || '.' || c.relname) <> $2
        AND pg_has_role($1, m.oid, 'MEMBER')
        AND (has_table_privilege(m.oid, c.oid, 'INSERT') OR has_table_privilege(m.oid, c.oid, 'UPDATE')
             OR has_table_privilege(m.oid, c.oid, 'DELETE')
             OR has_table_privilege(m.oid, c.oid, 'TRUNCATE'))`,
    [role, BARRIER_EXEMPT_TABLE],
  );
  if ((surviving[0]?.n ?? 0) > 0) {
    throw new BarrierUnavailableError(
      'the runtime role keeps a write privilege after the revoke (through PUBLIC, a role it can ' +
        'switch to, or because the control connection may not revoke it)',
    );
  }
  return recorded;
}

/** Grant back exactly the recorded privileges, inside `tx`. */
export async function restoreWrites(
  tx: BarrierTx,
  role: string,
  grants: readonly RecordedGrant[],
): Promise<void> {
  for (const g of grants) {
    const privileges = g.privileges.filter(isWritePrivilege);
    if (privileges.length === 0) continue;
    const [stmt] = await rows<{ stmt: string }>(
      tx,
      "SELECT format('GRANT %s ON TABLE %I.%I TO %I', $1::text, $2::text, $3::text, $4::text) AS stmt",
      [privileges.join(', '), g.schema, g.table, role],
    );
    if (stmt !== undefined) await tx.unsafe(stmt.stmt);
  }
}

/** Parse recorded grants read back from the fence record; anything malformed is dropped. */
export function readRecordedGrants(value: unknown): RecordedGrant[] {
  if (!Array.isArray(value)) return [];
  const out: RecordedGrant[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const g = entry as Record<string, unknown>;
    if (
      typeof g.schema !== 'string' ||
      typeof g.table !== 'string' ||
      !Array.isArray(g.privileges)
    ) {
      continue;
    }
    out.push({
      schema: g.schema,
      table: g.table,
      privileges: g.privileges.filter(isWritePrivilege),
    });
  }
  return out;
}

/**
 * How many sessions other than the caller's own are connected to any of `databases`. The caller's
 * own: this backend, and every session carrying this connection's application name when that name is
 * a control tag.
 */
export async function otherSessions(tx: BarrierTx, databases: readonly string[]): Promise<number> {
  const [row] = await rows<{ n: number }>(
    tx,
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = ANY($1::text[]) AND pid <> pg_backend_pid() AND backend_type = 'client backend'
        AND NOT (current_setting('application_name') LIKE $2
                 AND application_name = current_setting('application_name'))`,
    [databases, `${CONTROL_APPLICATION_PREFIX}%`],
  );
  return row?.n ?? 0;
}
