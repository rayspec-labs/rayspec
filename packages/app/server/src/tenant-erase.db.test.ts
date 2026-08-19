/**
 * `eraseTenantData` — the OPERATOR ENTRY POINT to the tenant data-erasure seam, against a real
 * database and the REAL composition root.
 *
 * WHAT THIS SUITE IS FOR. The seam itself is already covered from several directions
 * (`auth-only-erasure-boot.db.test.ts`, `workforce-erasure-boot.db.test.ts`, `erase-tenant.db.test.ts`).
 * What was never covered is the thing this item adds: a SHIPPED PATH to it. So every arm here asks
 * the question one layer up — does the fail-closed behaviour still hold when it is reached through
 * the new surface, and does the new surface leave a record of who reached for it?
 *
 * THE ARMS.
 *
 *   1. ACCEPT CONTROL — the seeded tenant really does hold run history, so the counts the later arms
 *      assert on are a fixture and not an empty enumeration that would pass vacuously.
 *   2. THE GATE'S FIVE NEAR-MISSES, THROUGH THE NEW SURFACE. `unset`, `"TRUE"`, `"1"`, `"yes"`,
 *      `"True"` — each driven as a GENUINE erase request (`dryRun: false`, i.e. the operator supplied
 *      `--confirm`). Every one must come back `mode:'dry-run'`, `dryRunReason:'gate-disabled'` with a
 *      non-zero would-delete count, and AFTER ALL FIVE the row census must be unchanged. This is the
 *      arm that fails against any convenience that resolves the gate anywhere but the composition root.
 *   3. THE PREVIEW IS COUNTS-ONLY EVEN WITH THE GATE ARMED. `RAYSPEC_ERASURE_ENABLED='true'` AND
 *      `dryRun: true` ⇒ `dryRunReason:'dry-run-requested'`, non-zero counts, census unchanged. With
 *      the gate on, the ONLY thing standing between this call and the deletes is the dry-run flag, so
 *      this is where that flag is actually proven — the negative assertion is falsifiable here
 *      because a mutation that plants a deletion into the preview path makes it fire.
 *   4. ARMED AND CONFIRMED ⇒ IT REALLY DELETES. `mode:'deleted'`, tenant A's four run-history tables
 *      go to zero.
 *   5. THE CROSS-TENANT WITNESS — tenant B is untouched by all seven calls above.
 *   6. THE JOURNAL RECORDS ATTEMPTS THE GATE REFUSED. After the five near-misses, `auth_audit` holds
 *      five `tenant_erase_requested` rows for tenant A and ZERO `tenant_data_erased` — the trace that
 *      exists for nobody today, since `eraseTenant`'s own record is written only on the delete path.
 *      Their `meta` carries the operator's stated reason and the RESOLVED gate (`false`), never the
 *      raw environment string.
 *   7. BOTH RECORDS SURVIVE THE ERASURE THEY DESCRIBE. After the real delete, the request rows AND
 *      the `tenant_data_erased` row are still readable — `auth_audit` is a global/auth table that
 *      tenant erasure deliberately does not touch, which is what makes the trail worth anything.
 *   8. AN UNREACHABLE DATABASE FAILS CLOSED as `BOOT_FAILED` — never a swallowed error that would
 *      read, to an operator and to a script, as a successful preview of an empty tenant.
 *
 * DB ISOLATION: a whole throwaway DATABASE, dropped on teardown. No document is set, so no durable
 * worker is launched and no scheduler pass can race the assertions. Each call boots and closes its
 * own server, which is exactly the shipped operator sequence: observe the preview, set the variable,
 * run again.
 */
import { type Db, makeDb } from '@rayspec/db';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from './composition-root.js';
import { eraseTenantData } from './tenant-erase.js';

const TENANT_A = '00000000-0000-4000-8000-00000000e5a1';
const TENANT_B = '00000000-0000-4000-8000-00000000e5b2';
const REASON = 'operator suite — subject erasure request TCK-4711';

/** The core run-history tables a document-free boot accumulates through the mounted run surface. */
const RUN_HISTORY_TABLES = ['runs', 'journal_steps', 'conversation_items', 'run_events'] as const;

/**
 * The five values that are NOT the gate. Four near-misses plus `undefined` for "unset". The exact
 * string `'true'` is deliberately absent — it belongs to arms 3 and 4.
 */
const NEAR_MISSES: readonly (string | undefined)[] = [undefined, 'TRUE', '1', 'yes', 'True'];

function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}
function withDbName(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

const SUITE_DB = `rayspec_tenant_erase_cmd_${process.pid}`;

const baseUrl = process.env.DATABASE_URL;
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// Un-skippable ran-guard (fires at collection): a data-protection proof must never silently
// self-skip to a false green.
if (requireDb && !baseUrl) {
  throw new Error(
    'tenant-erase.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip this DB-backed suite.',
  );
}
let armsRan = 0;
const ARM_COUNT = 8;

describe('rayspec tenant erase — the operator path to the erasure seam', () => {
  const maybe = baseUrl ? it : it.skip;

  let db: Db | undefined;
  let appDbUrl = '';
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'RAYSPEC_ERASURE_ENABLED',
  ] as const;

  /** Seed one run's worth of history — header, journal step, transcript part, event — for a tenant. */
  async function seedRunHistory(tenantId: string, label: string): Promise<void> {
    const sql = (db as Db).$client;
    const runId = `run-${label}`;
    await sql.unsafe(
      `INSERT INTO runs (run_id, tenant_id, backend, auth_mode, agent_name, model, status, final_text)
       VALUES ($1,$2,'openai','api-key','solo_agent','gpt-4o-mini','completed',$3)`,
      [runId, tenantId, `subject content in ${label}'s final text`],
    );
    await sql.unsafe(
      `INSERT INTO journal_steps (run_id, tenant_id, backend, type, idempotency_key, input_hash, output, status, auth_mode)
       VALUES ($1,$2,'openai','llm',$3,$4,$5::jsonb,'succeeded','api-key')`,
      [
        runId,
        tenantId,
        `idem-${label}`,
        `hash-${label}`,
        JSON.stringify({ text: `subject content in ${label}'s model output` }),
      ],
    );
    await sql.unsafe(
      `INSERT INTO conversation_items (run_id, tenant_id, seq, turn_index, role, kind, payload)
       VALUES ($1,$2,'1','0','user','text',$3::jsonb)`,
      [
        runId,
        tenantId,
        JSON.stringify({ kind: 'text', text: `subject content in ${label}'s turn` }),
      ],
    );
    await sql.unsafe(
      `INSERT INTO run_events (run_id, tenant_id, seq, type, data)
       VALUES ($1,$2,'1','run_completed',$3::jsonb)`,
      [runId, tenantId, JSON.stringify({ v: 1, type: 'run_completed' })],
    );
  }

  /** Ground-truth per-table row counts for one tenant, read OUTSIDE the erasure code path. */
  async function counts(tenantId: string): Promise<Record<string, number>> {
    const sql = (db as Db).$client;
    const out: Record<string, number> = {};
    for (const t of RUN_HISTORY_TABLES) {
      const rows = (await sql.unsafe(`SELECT count(*)::int AS n FROM "${t}" WHERE tenant_id = $1`, [
        tenantId,
      ])) as unknown as { n: number }[];
      out[t] = rows[0]?.n ?? -1;
    }
    return out;
  }

  /** The audit rows this command class writes, newest last, read straight off `auth_audit`. */
  async function auditRows(
    tenantId: string,
    event: string,
  ): Promise<{ request_id: string; meta: Record<string, unknown> }[]> {
    const sql = (db as Db).$client;
    return (await sql.unsafe(
      `SELECT request_id, meta FROM auth_audit WHERE actor_org_id = $1 AND event = $2 ORDER BY created_at ASC`,
      [tenantId, event],
    )) as unknown as { request_id: string; meta: Record<string, unknown> }[];
  }

  /** Set (or unset) the operator gate exactly as an operator would, in the ambient environment. */
  function setGate(value: string | undefined): void {
    if (value === undefined) delete process.env.RAYSPEC_ERASURE_ENABLED;
    else process.env.RAYSPEC_ERASURE_ENABLED = value;
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    appDbUrl = withDbName(baseUrl, SUITE_DB);

    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    db = makeDb(appDbUrl);
    await applyMigrations(db);
    for (const [id, slug] of [
      [TENANT_A, 'tenant-erase-cmd-a'],
      [TENANT_B, 'tenant-erase-cmd-b'],
    ] as const) {
      await db.$client.unsafe('INSERT INTO orgs (id, name, slug) VALUES ($1,$2,$3)', [
        id,
        `Tenant Erase Cmd ${slug}`,
        slug,
      ]);
    }
    await seedRunHistory(TENANT_A, 'cmd-a');
    await seedRunHistory(TENANT_B, 'cmd-b');

    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'tenant-erase-command-suite-pepper-only';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8817';
    // No document: the shape `serve.ts` calls the default, and the lightest real boot there is.
    delete process.env.RAYSPEC_SPEC_PATH;
    setGate(undefined);
  }, 180_000);

  afterAll(async () => {
    if (db) await db.$client.end();
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  }, 120_000);

  maybe('1. accept control — the target tenant really holds run history to erase', async () => {
    const before = await counts(TENANT_A);
    for (const t of RUN_HISTORY_TABLES) expect(before[t]).toBeGreaterThan(0);
    expect(await auditRows(TENANT_A, 'tenant_erase_requested')).toEqual([]);
    armsRan++;
  });

  maybe(
    '2. all FIVE non-`true` gate values refuse a CONFIRMED erasure, and nothing is removed',
    async () => {
      const before = await counts(TENANT_A);
      for (const value of NEAR_MISSES) {
        setGate(value);
        // `dryRun: false` is the CONFIRMED request — the operator typed --confirm and --reason. The
        // only thing left between this call and the deletes is the gate.
        const report = await eraseTenantData({
          orgId: TENANT_A,
          dryRun: false,
          journalScrub: false,
          reason: REASON,
        });
        expect(report.gate, `gate resolved true for ${JSON.stringify(value)}`).toBe(false);
        expect(report.result.mode, `mode for ${JSON.stringify(value)}`).toBe('dry-run');
        expect(report.result.dryRunReason).toBe('gate-disabled');
        // A preview that enumerates nothing would satisfy "deletes nothing" vacuously.
        expect(report.result.coreTables.runs).toBeGreaterThan(0);
        expect(report.result.coreTotalRows).toBeGreaterThan(0);
      }
      expect(await counts(TENANT_A)).toEqual(before);
      armsRan++;
    },
    240_000,
  );

  maybe(
    '3. gate ARMED but a PREVIEW asked for ⇒ counts only, and the census does not move',
    async () => {
      const before = await counts(TENANT_A);
      setGate('true');
      const report = await eraseTenantData({
        orgId: TENANT_A,
        dryRun: true,
        journalScrub: false,
        reason: REASON,
      });
      // The gate is ON here — proven by reading it back — so the dry-run flag is the ONLY thing
      // preventing the deletes, which is what makes this arm a real test of that flag.
      expect(report.gate).toBe(true);
      expect(report.result.mode).toBe('dry-run');
      expect(report.result.dryRunReason).toBe('dry-run-requested');
      expect(report.result.coreTables.runs).toBeGreaterThan(0);
      expect(await counts(TENANT_A)).toEqual(before);
      armsRan++;
    },
    120_000,
  );

  maybe('4. the journal recorded every REFUSED attempt, with the resolved gate', async () => {
    // Five near-misses + one armed preview = six recorded attempts, and NOT ONE delete so far.
    const requested = await auditRows(TENANT_A, 'tenant_erase_requested');
    expect(requested).toHaveLength(NEAR_MISSES.length + 1);
    expect(await auditRows(TENANT_A, 'tenant_data_erased')).toEqual([]);

    const refusals = requested.slice(0, NEAR_MISSES.length);
    for (const row of refusals) {
      expect(row.meta.requested).toBe('erase');
      // The RESOLVED gate, never the raw string the operator typed — a `"TRUE"` reads as false here.
      expect(row.meta.gate).toBe(false);
      expect(row.meta.reason).toBe(REASON);
      expect(row.meta.invoker).toBeDefined();
      // No secret material of any kind reaches the trail.
      expect(JSON.stringify(row.meta)).not.toContain('postgres://');
    }
    const preview = requested[NEAR_MISSES.length] as { meta: Record<string, unknown> };
    expect(preview.meta.requested).toBe('preview');
    expect(preview.meta.gate).toBe(true);
    armsRan++;
  });

  maybe(
    '5. armed AND confirmed ⇒ the run history is really gone',
    async () => {
      setGate('true');
      const report = await eraseTenantData({
        orgId: TENANT_A,
        dryRun: false,
        journalScrub: false,
        reason: REASON,
      });
      expect(report.gate).toBe(true);
      expect(report.result.mode).toBe('deleted');
      expect(report.result.dryRunReason).toBeUndefined();
      expect(report.result.coreTotalRows).toBeGreaterThan(0);
      const after = await counts(TENANT_A);
      for (const t of RUN_HISTORY_TABLES) expect(after[t]).toBe(0);
      armsRan++;
    },
    120_000,
  );

  maybe('6. the cross-tenant witness is untouched by all seven calls', async () => {
    const b = await counts(TENANT_B);
    for (const t of RUN_HISTORY_TABLES) expect(b[t]).toBeGreaterThan(0);
    armsRan++;
  });

  maybe('7. both audit records survive the erasure they describe', async () => {
    const requested = await auditRows(TENANT_A, 'tenant_erase_requested');
    // Six refused/preview attempts + the one that deleted.
    expect(requested).toHaveLength(NEAR_MISSES.length + 2);
    const last = requested[requested.length - 1] as { meta: Record<string, unknown> };
    expect(last.meta.requested).toBe('erase');
    expect(last.meta.gate).toBe(true);

    const erased = await auditRows(TENANT_A, 'tenant_data_erased');
    expect(erased).toHaveLength(1);
    expect((erased[0] as { meta: Record<string, unknown> }).meta.mode).toBe('deleted');
    armsRan++;
  });

  maybe(
    '8. an unreachable database FAILS CLOSED as BOOT_FAILED — never a report of an erasure that did not run',
    async () => {
      // A boot that cannot reach its database must not resolve. The failure mode this guards against
      // is not an exception (the driver supplies one) but a swallowed one: a `catch` that returned a
      // zero-count report would read to an operator, and to a script, as "there was nothing to
      // erase" — indistinguishable from a successful preview of an empty tenant. So the arm asserts
      // the CODE, not merely that something threw.
      //
      // Deliberately NOT also an assertion that the message carries no secret: postgres reports
      // `connect ECONNREFUSED host:port` and nothing more, so such an assertion would pass whether
      // or not `redactBootSecrets` ran — measured, by removing the redaction and watching it stay
      // green. The redactor is proven directly in `tenant-erase.test.ts`, where a mutation to it
      // cannot hide.
      const saved = process.env.DATABASE_URL;
      process.env.DATABASE_URL = 'postgres://erase-user:erase-secret-pass@127.0.0.1:1/nope';
      try {
        await expect(
          eraseTenantData({ orgId: TENANT_B, dryRun: true, journalScrub: false }),
        ).rejects.toMatchObject({ name: 'TenantEraseCommandError', code: 'BOOT_FAILED' });
      } finally {
        if (saved === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = saved;
      }
      armsRan++;
    },
    120_000,
  );

  maybe('ran-guard — every arm above actually executed', () => {
    expect(armsRan).toBe(ARM_COUNT);
  });
});
