/**
 * DB-backed: row-level tenant isolation, proven against a real Postgres while connected AS THE RUNTIME
 * ROLE — the role a deployment in the isolated posture serves with — never as a superuser.
 *
 * The database is a throwaway one with three roles of its own, created by the shipped setup SQL. The
 * platform chain is applied as the migration role (as a boot does), two product-shaped tables with a
 * foreign key are created as the migration role (as product DDL is), and `applyTenantIsolation` runs
 * once. Then, as the runtime role, both with direct SQL and through the `TenantDb` chokepoint:
 *
 *   1. every tenant table has an enabled, forced tenant policy — enumerated from the catalog, not from
 *      a hand-written list — and the posture check reports the runtime role active;
 *   2. tenant A cannot read, update, delete or insert tenant B's rows, and cannot point a foreign key
 *      at B's row; the event stream of B is invisible to A;
 *   3. with no tenant context a read returns nothing and a write fails; a malformed context fails the
 *      statement; a context set in an earlier transaction is gone in the next one on the same
 *      connection;
 *   4. under concurrency, pooled connections never carry one request's tenant into another's;
 *   5. the runtime role cannot run DDL, cannot disable or drop a policy, cannot truncate, cannot change
 *      its own role attributes or preset a tenant, cannot switch to the migration role, and cannot
 *      write a migration ledger;
 *   6. the posture check names what is wrong when it is wrong, and `applyTenantIsolation` is a no-op
 *      on a database that has everything, and fixes a table added without a policy.
 *
 * A second throwaway database, migrated by a single superuser role (today's layout), proves the
 * chain's policies are inert there: nothing is enabled and the owner reads every row as before.
 *
 * Skips without DATABASE_URL; HARD-FAILS when the DB is required (CI / RAYSPEC_REQUIRE_DB_TESTS).
 */
import { randomUUID } from 'node:crypto';
import { eq, getTableName, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Db, makeDb } from './client.js';
import { migrationsDir } from './migrations.js';
import { CORE_TENANT_SCOPED_TABLES, runs } from './schema.js';
import { forTenant, TENANT_GUC } from './tenant-db.js';
import {
  applyTenantIsolation,
  listTenantTables,
  TENANT_POLICY_NAME,
  verifyTenantIsolation,
} from './tenant-isolation.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing-isolation.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'tenant-isolation.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip the row-level isolation proofs.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const RUN_A = `run-a-${randomUUID()}`;
const RUN_B = `run-b-${randomUUID()}`;
const PARENT_A = randomUUID();
const PARENT_B = randomUUID();

/** Product-shaped tables with a single-column foreign key onto the parent's id, as product DDL emits. */
const PRODUCT_DDL = `
CREATE TABLE notes_parents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  title text NOT NULL
);
CREATE TABLE notes_children (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  parent_id uuid,
  body text NOT NULL,
  CONSTRAINT notes_children_parent_fk FOREIGN KEY (parent_id) REFERENCES notes_parents(id) ON DELETE CASCADE
);
`;

function pgCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 5 && e !== undefined && e !== null; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

async function failure(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected the statement to fail, and it succeeded');
}

describeDb('row-level tenant isolation, connected as the runtime role', () => {
  let iso: IsolatedTestDatabase;
  let migrator: ReturnType<typeof postgres>;
  let runtime: ReturnType<typeof postgres>;
  let runtimeDb: Db;

  beforeAll(async () => {
    iso = await createIsolatedTestDatabase(process.env.DATABASE_URL as string);
    migrator = postgres(iso.urls.migration, { max: 2, onnotice: () => {} });
    await migrate(drizzle(migrator), { migrationsFolder: migrationsDir() });
    await migrator.unsafe(PRODUCT_DDL);
    await migrator.begin((tx) => applyTenantIsolation(tx, { runtimeRole: iso.roles.runtime }));

    // Seed both tenants as the migration role (it bypasses row security, as a restore would).
    await migrator.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'A', $3), ($2, 'B', $4)`, [
      TENANT_A,
      TENANT_B,
      `a-${TENANT_A}`,
      `b-${TENANT_B}`,
    ]);
    await migrator.unsafe(
      `INSERT INTO runs (run_id, tenant_id, backend, auth_mode, agent_name, model, status)
       VALUES ($1, $2, 'fake', 'api-key', 'agent', 'model', 'completed'),
              ($3, $4, 'fake', 'api-key', 'agent', 'model', 'completed')`,
      [RUN_A, TENANT_A, RUN_B, TENANT_B],
    );
    await migrator.unsafe(
      `INSERT INTO notes_parents (id, tenant_id, title) VALUES ($1, $2, 'a'), ($3, $4, 'b')`,
      [PARENT_A, TENANT_A, PARENT_B, TENANT_B],
    );
    await migrator.unsafe(
      `INSERT INTO invites (tenant_id, token_hash, email, role, expires_at)
       VALUES ($1, 'hash-of-b', 'b@example.test', 'member', now() + interval '1 day')`,
      [TENANT_B],
    );

    runtime = postgres(iso.urls.runtime, { max: 1, onnotice: () => {} });
    runtimeDb = makeDb(iso.urls.runtime, 2);
  }, 60_000);

  afterAll(async () => {
    await runtimeDb?.$client.end();
    await runtime?.end();
    await migrator?.end();
    await iso?.drop();
  });

  // ── 1. every tenant table is covered, from the catalog ───────────────────────────────────────

  it('every table with a tenant_id column has an enabled, forced tenant policy (catalog, not a list)', async () => {
    const tables = await listTenantTables(runtime);
    const names = tables.map((t) => t.table);
    // The catalog is the source; the core list and the two product tables are a lower bound.
    for (const core of CORE_TENANT_SCOPED_TABLES) {
      expect(names).toContain(getTableName(core));
    }
    expect(names).toEqual(expect.arrayContaining(['notes_parents', 'notes_children']));
    expect(tables.filter((t) => !t.rowSecurity || !t.forced || !t.policy)).toEqual([]);
    const [policies] = (await runtime.unsafe(
      `SELECT count(*)::int AS n FROM pg_policy WHERE polname = $1`,
      [TENANT_POLICY_NAME],
    )) as unknown as { n: number }[];
    expect(policies?.n).toBe(tables.length);
  });

  it('the posture check reports the runtime role active, with no finding', async () => {
    const report = await verifyTenantIsolation(runtime);
    expect(report).toMatchObject({ role: iso.roles.runtime, active: true, findings: [] });
    expect(report.tenantTables).toBeGreaterThanOrEqual(CORE_TENANT_SCOPED_TABLES.length + 2);
  });

  // ── 2. cross-tenant reads, writes and references ─────────────────────────────────────────────

  it('direct SQL under tenant A reads only A and cannot update, delete or insert B', async () => {
    await runtime.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('${TENANT_GUC}', $1, true)`, [TENANT_A]);
      const all = (await tx.unsafe('SELECT run_id, tenant_id FROM runs')) as unknown as {
        run_id: string;
      }[];
      expect(all.map((r) => r.run_id)).toEqual([RUN_A]);
      // An explicit predicate on B's id finds nothing.
      expect(await tx.unsafe('SELECT 1 FROM runs WHERE run_id = $1', [RUN_B])).toHaveLength(0);
      expect(
        await tx.unsafe(`UPDATE runs SET status = 'hijacked' WHERE run_id = $1 RETURNING 1`, [
          RUN_B,
        ]),
      ).toHaveLength(0);
      expect(
        await tx.unsafe('DELETE FROM runs WHERE run_id = $1 RETURNING 1', [RUN_B]),
      ).toHaveLength(0);
    });
    const insert = await failure(
      runtime.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('${TENANT_GUC}', $1, true)`, [TENANT_A]);
        await tx.unsafe(
          `INSERT INTO runs (run_id, tenant_id, backend, auth_mode, agent_name, model, status)
           VALUES ($1, $2, 'fake', 'api-key', 'agent', 'model', 'running')`,
          [`planted-${randomUUID()}`, TENANT_B],
        );
      }),
    );
    expect(pgCode(insert)).toBe('42501');
    // A's own row cannot be moved to B.
    const move = await failure(
      runtime.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('${TENANT_GUC}', $1, true)`, [TENANT_A]);
        await tx.unsafe('UPDATE runs SET tenant_id = $1 WHERE run_id = $2', [TENANT_B, RUN_A]);
      }),
    );
    expect(pgCode(move)).toBe('42501');
    // B's row is untouched (checked as the migration role, which sees everything).
    const [b] = (await migrator.unsafe('SELECT status FROM runs WHERE run_id = $1', [
      RUN_B,
    ])) as unknown as { status: string }[];
    expect(b?.status).toBe('completed');
  });

  it("tenant A cannot reference tenant B's row through a foreign key; its own row it can", async () => {
    const refused = await failure(
      runtime.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('${TENANT_GUC}', $1, true)`, [TENANT_A]);
        await tx.unsafe(
          `INSERT INTO notes_children (tenant_id, parent_id, body) VALUES ($1, $2, 'x')`,
          [TENANT_A, PARENT_B],
        );
      }),
    );
    expect(pgCode(refused)).toBe('23503');
    expect((refused as { constraint_name?: string }).constraint_name).toBe(
      'notes_children_parent_fk',
    );
    // Re-pointing an existing child at B's row is refused the same way.
    const repoint = await failure(
      runtime.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('${TENANT_GUC}', $1, true)`, [TENANT_A]);
        const [child] = (await tx.unsafe(
          `INSERT INTO notes_children (tenant_id, parent_id, body) VALUES ($1, $2, 'mine') RETURNING id`,
          [TENANT_A, PARENT_A],
        )) as unknown as { id: string }[];
        await tx.unsafe('UPDATE notes_children SET parent_id = $1 WHERE id = $2', [
          PARENT_B,
          child?.id,
        ]);
      }),
    );
    expect(pgCode(repoint)).toBe('23503');
    await runtime.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('${TENANT_GUC}', $1, true)`, [TENANT_A]);
      await tx.unsafe(
        `INSERT INTO notes_children (tenant_id, parent_id, body) VALUES ($1, $2, 'ok')`,
        [TENANT_A, PARENT_A],
      );
    });
  });

  it('through the chokepoint: A sees only A, the ownership probe still names B foreign', async () => {
    const a = forTenant(runtimeDb, TENANT_A);
    const rows = await a.select(runs).all();
    expect(rows.map((r) => r.runId)).toEqual([RUN_A]);
    // Even without the chokepoint's predicate, the raw handle reaches no tenant row without context.
    expect(await a.unscoped().select().from(runs)).toEqual([]);
    const updated = await a
      .update(runs, { status: 'hijacked' })
      .where(eq(runs.runId, RUN_B))
      .returning({ id: runs.runId });
    expect(updated).toEqual([]);
    expect(await a.runHeaderOwnership(RUN_A)).toBe('owned');
    expect(await a.runHeaderOwnership(RUN_B)).toBe('foreign');
    expect(await a.runHeaderOwnership(`absent-${randomUUID()}`)).toBe('absent');
  });

  it("the event stream: A's reader never receives B's events, and B's cursor state is not A's", async () => {
    const a = forTenant(runtimeDb, TENANT_A);
    const b = forTenant(runtimeDb, TENANT_B);
    await b.appendEvents([{ topic: 'secret', payload: { of: 'b' } }]);
    await a.appendEvents([{ topic: 'mine', payload: { of: 'a' } }]);
    const pageA = await a.readEventPage({ after: 0, limit: 50 });
    expect(pageA.events.map((e) => e.topic)).toEqual(['mine']);
    expect(pageA.lastSeq).toBe(1);
    const pageB = await b.readEventPage({ after: 0, limit: 50 });
    expect(pageB.events.map((e) => e.topic)).toEqual(['secret']);
    // Directly: with A's context, B's events and stream row do not exist.
    await runtime.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('${TENANT_GUC}', $1, true)`, [TENANT_A]);
      expect(
        await tx.unsafe('SELECT 1 FROM tenant_events WHERE tenant_id = $1', [TENANT_B]),
      ).toHaveLength(0);
      expect(
        await tx.unsafe('SELECT 1 FROM tenant_event_streams WHERE tenant_id = $1', [TENANT_B]),
      ).toHaveLength(0);
    });
  });

  it('an invite is resolved by its token hash alone, and its row stays behind the policy', async () => {
    const [found] = (await runtime.unsafe('SELECT rayspec_invite_tenant($1) AS tenant', [
      'hash-of-b',
    ])) as unknown as { tenant: string | null }[];
    expect(found?.tenant).toBe(TENANT_B);
    const [none] = (await runtime.unsafe('SELECT rayspec_invite_tenant($1) AS tenant', [
      'not-a-hash',
    ])) as unknown as { tenant: string | null }[];
    expect(none?.tenant).toBeNull();
    expect(await runtime.unsafe('SELECT * FROM invites')).toHaveLength(0);
  });

  // ── 3. absent, forged and stale context ──────────────────────────────────────────────────────

  it('with no tenant context a read returns nothing and a write fails', async () => {
    expect(await runtime.unsafe('SELECT * FROM runs')).toHaveLength(0);
    expect(await runtime.unsafe('SELECT * FROM notes_parents')).toHaveLength(0);
    const write = await failure(
      runtime.unsafe(
        `INSERT INTO runs (run_id, tenant_id, backend, auth_mode, agent_name, model, status)
         VALUES ($1, $2, 'fake', 'api-key', 'agent', 'model', 'running')`,
        [`nocontext-${randomUUID()}`, TENANT_A],
      ),
    );
    expect(pgCode(write)).toBe('42501');
    expect(await runtime.unsafe(`UPDATE runs SET status = 'x' RETURNING 1`)).toHaveLength(0);
  });

  it('a forged context that is not a tenant id fails the statement instead of matching anything', async () => {
    const forged = await failure(
      runtime.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('${TENANT_GUC}', $1, true)`, [
          `${TENANT_A}' OR true --`,
        ]);
        await tx.unsafe('SELECT * FROM runs');
      }),
    );
    expect(pgCode(forged)).toBe('22P02');
    // A well-formed id of no tenant matches nothing.
    await runtime.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('${TENANT_GUC}', $1, true)`, [randomUUID()]);
      expect(await tx.unsafe('SELECT * FROM runs')).toHaveLength(0);
    });
  });

  it('a context set in an earlier transaction is gone in the next one on the same connection', async () => {
    // `runtime` has ONE connection, so both statements below run on the same session.
    await runtime.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('${TENANT_GUC}', $1, true)`, [TENANT_A]);
      expect(await tx.unsafe('SELECT * FROM runs')).toHaveLength(1);
    });
    const [after] = (await runtime.unsafe(
      `SELECT pg_backend_pid() AS pid, current_setting('${TENANT_GUC}', true) AS tenant`,
    )) as unknown as { pid: number; tenant: string | null }[];
    expect(after?.tenant ?? '').toBe('');
    expect(await runtime.unsafe('SELECT * FROM runs')).toHaveLength(0);
  });

  // ── 4. pooled connections under concurrency ──────────────────────────────────────────────────

  it('under concurrency, a pooled connection never carries one tenant into another request', async () => {
    const tenants = [TENANT_A, TENANT_B];
    const expected = new Map([
      [TENANT_A, RUN_A],
      [TENANT_B, RUN_B],
    ]);
    // 80 interleaved reads over a pool of two connections: every connection serves both tenants.
    const results = await Promise.all(
      Array.from({ length: 80 }, async (_, i) => {
        const tenant = tenants[i % 2] as string;
        const seen = await forTenant(runtimeDb, tenant).select(runs).all();
        return { tenant, seen: seen.map((r) => r.runId) };
      }),
    );
    for (const r of results) expect(r.seen).toEqual([expected.get(r.tenant)]);
    // Afterwards neither pooled connection holds a tenant, and a bare read sees no row.
    const leftovers = await Promise.all(
      Array.from({ length: 6 }, () =>
        runtimeDb.execute(
          sql`select current_setting(${TENANT_GUC}, true) as tenant, (select count(*)::int from runs) as n`,
        ),
      ),
    );
    for (const rowsOf of leftovers) {
      const row = (rowsOf as unknown as { tenant: string | null; n: number }[])[0];
      expect(row?.tenant ?? '').toBe('');
      expect(row?.n).toBe(0);
    }
  });

  // ── 5. the runtime role cannot change the rules ──────────────────────────────────────────────

  it.each([
    ['create a table', 'CREATE TABLE public.planted (id int)'],
    ['create a schema', 'CREATE SCHEMA planted'],
    ['create a temporary table', 'CREATE TEMPORARY TABLE planted (id int)'],
    ['alter a table', 'ALTER TABLE runs ADD COLUMN planted int'],
    ['drop a table', 'DROP TABLE notes_children'],
    ['disable row security', 'ALTER TABLE runs DISABLE ROW LEVEL SECURITY'],
    ['stop forcing row security', 'ALTER TABLE runs NO FORCE ROW LEVEL SECURITY'],
    ['drop the policy', `DROP POLICY ${TENANT_POLICY_NAME} ON runs`],
    ['replace the policy', `CREATE POLICY open_door ON runs USING (true)`],
    ['truncate a tenant table', 'TRUNCATE runs'],
    ['write the product ledger', `DELETE FROM product_migration_ledger`],
  ])('the runtime role cannot %s', async (_label, statement) => {
    const err = await failure(runtime.unsafe(statement));
    expect(pgCode(err)).toBe('42501');
  });

  it('the runtime role cannot change its own role attributes, preset a tenant, or become another role', async () => {
    const role = iso.roles.runtime;
    for (const statement of [
      `ALTER ROLE "${role}" BYPASSRLS`,
      `ALTER ROLE "${role}" SUPERUSER`,
      `ALTER ROLE "${role}" CREATEROLE`,
      `ALTER ROLE "${role}" CREATEDB`,
      `ALTER ROLE "${role}" SET ${TENANT_GUC} = '${TENANT_B}'`,
      `SET ROLE "${iso.roles.migration}"`,
      `GRANT "${iso.roles.migration}" TO "${role}"`,
    ]) {
      const err = await failure(runtime.unsafe(statement));
      expect(pgCode(err), statement).toBe('42501');
    }
    const [attrs] = (await runtime.unsafe(
      'SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user',
    )) as unknown as { rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean }[];
    expect(attrs).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false });
  });

  it('a session default the runtime role may still set on itself makes the posture check fail', async () => {
    // Postgres lets any role preset an ordinary setting for its own future sessions. None of them
    // lifts a policy (`row_security = off` makes a policed statement fail, not pass), but the check
    // does not accept one on the settings that bear on isolation.
    const role = iso.roles.runtime;
    for (const setting of ['row_security = off', 'search_path = pg_catalog']) {
      await runtime.unsafe(`ALTER ROLE "${role}" SET ${setting}`);
      try {
        const report = await verifyTenantIsolation(runtime);
        expect(report.active, setting).toBe(false);
        expect(report.findings.map((f) => f.check)).toEqual(['setting-default']);
      } finally {
        await runtime.unsafe(`ALTER ROLE "${role}" RESET ALL`);
      }
    }
    expect((await verifyTenantIsolation(runtime)).active).toBe(true);
  });

  // ── 6. the posture check and the idempotent enable step ──────────────────────────────────────

  it('the enable step changes nothing on a database that has everything', async () => {
    const changes = await migrator.begin((tx) =>
      applyTenantIsolation(tx, { runtimeRole: iso.roles.runtime }),
    );
    expect(changes.policiesCreated).toEqual([]);
    expect(changes.rowSecurityEnabled).toEqual([]);
    expect(changes.rowSecurityForced).toEqual([]);
    expect(changes.referenceTriggersCreated).toEqual([]);
    expect(changes.tenantTables.length).toBeGreaterThanOrEqual(CORE_TENANT_SCOPED_TABLES.length);
  });

  it('a new tenant table without a policy fails the posture check until the enable step covers it', async () => {
    await migrator.unsafe(
      'CREATE TABLE late_store (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES orgs(id))',
    );
    try {
      const before = await verifyTenantIsolation(runtime);
      expect(before.active).toBe(false);
      expect(before.findings).toEqual([
        expect.objectContaining({
          check: 'tenant-table-policy',
          detail: expect.stringContaining('public.late_store'),
        }),
      ]);
      const changes = await migrator.begin((tx) => applyTenantIsolation(tx));
      expect(changes.policiesCreated).toEqual(['public.late_store']);
      expect((await verifyTenantIsolation(runtime)).active).toBe(true);
    } finally {
      await migrator.unsafe('DROP TABLE late_store');
    }
  });

  it('the posture check refuses a superuser, a bypassing role, and a role that owns a table', async () => {
    const admin = postgres(iso.urls.admin, { max: 1, onnotice: () => {} });
    try {
      const superuser = await verifyTenantIsolation(admin);
      expect(superuser.active).toBe(false);
      expect(superuser.findings.map((f) => f.check)).toContain('role-attributes');

      const snapshot = await verifyTenantIsolation(admin, { role: iso.roles.snapshot });
      expect(snapshot.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            check: 'role-attributes',
            detail: expect.stringContaining('bypasses row security'),
          }),
        ]),
      );

      const migration = await verifyTenantIsolation(admin, { role: iso.roles.migration });
      expect(migration.findings.map((f) => f.check)).toEqual(
        expect.arrayContaining(['role-attributes', 'owns-objects', 'can-create']),
      );

      await admin.unsafe(`ALTER TABLE notes_children OWNER TO "${iso.roles.runtime}"`);
      try {
        const owner = await verifyTenantIsolation(runtime);
        expect(owner.active).toBe(false);
        // An owner may also truncate its table, which the check names separately.
        expect(owner.findings).toEqual([
          expect.objectContaining({
            check: 'owns-objects',
            detail: expect.stringContaining('public.notes_children'),
          }),
          expect.objectContaining({ check: 'truncate-privilege' }),
        ]);
      } finally {
        await admin.unsafe(`ALTER TABLE notes_children OWNER TO "${iso.roles.migration}"`);
      }

      await admin.unsafe(`ALTER ROLE "${iso.roles.runtime}" SET ${TENANT_GUC} = '${TENANT_A}'`);
      try {
        const preset = await verifyTenantIsolation(runtime);
        expect(preset.findings.map((f) => f.check)).toEqual(['setting-default']);
      } finally {
        await admin.unsafe(`ALTER ROLE "${iso.roles.runtime}" RESET ${TENANT_GUC}`);
      }
      expect((await verifyTenantIsolation(runtime)).active).toBe(true);
    } finally {
      await admin.end();
    }
  });
});

describeDb('a single-role database keeps working exactly as before', () => {
  let name: string;
  let owner: ReturnType<typeof postgres>;

  beforeAll(async () => {
    name = `rayspec_single_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const server = postgres(process.env.DATABASE_URL as string, { max: 1, onnotice: () => {} });
    try {
      await server.unsafe(`CREATE DATABASE "${name}"`);
    } finally {
      await server.end();
    }
    const url = new URL(process.env.DATABASE_URL as string);
    url.pathname = `/${name}`;
    owner = postgres(url.toString(), { max: 1, onnotice: () => {} });
    await migrate(drizzle(owner), { migrationsFolder: migrationsDir() });
  }, 60_000);

  afterAll(async () => {
    await owner?.end();
    const server = postgres(process.env.DATABASE_URL as string, { max: 1, onnotice: () => {} });
    try {
      await server.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await server.end();
    }
  });

  it('the chain creates the policies but enables none, and the owner reads every tenant without context', async () => {
    const tables = await listTenantTables(owner);
    expect(tables.length).toBe(CORE_TENANT_SCOPED_TABLES.length);
    expect(tables.every((t) => t.policy && !t.rowSecurity && !t.forced)).toBe(true);
    const a = randomUUID();
    const b = randomUUID();
    await owner.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'A', $3), ($2, 'B', $4)`, [
      a,
      b,
      `a-${a}`,
      `b-${b}`,
    ]);
    await owner.unsafe(
      `INSERT INTO idempotency_keys (tenant_id, scope, idem_key, body_hash, snapshot)
       VALUES ($1, 's', 'k', 'h', '{}'), ($2, 's', 'k', 'h', '{}')`,
      [a, b],
    );
    expect(await owner.unsafe('SELECT * FROM idempotency_keys')).toHaveLength(2);
  });
});
