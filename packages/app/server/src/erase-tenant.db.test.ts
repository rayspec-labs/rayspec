/**
 * Tenant DATA-ERASURE — the security-load-bearing DB test (fail-the-fix, non-blind, un-skippable).
 *
 * Drives the platform-generic `eraseTenant` DIRECTLY against a real throwaway DATABASE + a real fs
 * `BlobStore` + a real `AuditStore` (the team-lead's sanctioned direct approach), so EVERY invariant is
 * proven on GROUND TRUTH (rows actually gone / actually intact; blobs actually removed / actually
 * present; an audit row actually written):
 *
 *   1. CROSS-TENANT ISOLATION (the RED-first target): erase T1 → T1 rows + blobs GONE, T2 FULLY INTACT.
 *   2. FULL ERASURE + FK-ORDER: T1 rows across BOTH stores (parent+child, ON DELETE restrict) erase
 *      with NO FK violation; counts match the seed; an out-of-band audit record is written.
 *   3. FAIL-CLOSED: a non-UUID and a well-formed-but-nonexistent org ABORT (no partial delete).
 *   4. IDEMPOTENT: a 2nd erase deletes 0 / no-op.
 *   5. dryRun: counts what WOULD be deleted, deletes NOTHING (rows + blobs intact afterward).
 *   6. GATE OFF (default): a non-dryRun call performs ZERO deletes (gate-disabled dry-run semantics).
 *   7. NO BLOB BACKEND: erasure still deletes rows; reports blobs:'no-backend'.
 *   8. CORE-TABLE ERASURE: the platform CORE tenant-scoped run-journal/conversation tables
 *      (runs/journal_steps/conversation_items/run_events/idempotency_keys) are erased for T1 too, and
 *      T2's core rows stay FULLY INTACT (cross-tenant isolation on the core tables, not just product).
 *   9. AUDIT-REQUIRED: an enabled (real) erasure with NO audit store ABORTS (zero deletes).
 *  10. JOURNAL-SCRUB: `journalScrub:true` NULLs the raw payloads (`journal_steps.output`,
 *      `conversation_items.payload`) while KEEPING the rows + every idempotency/cost column (the unique
 *      journal index still bites), and reports the scrubbed counts distinctly.
 *  11. JOURNAL-SCRUB CROSS-TENANT: a T1 scrub leaves T2's raw payloads + ledger FULLY INTACT.
 *  12. JOURNAL-SCRUB PREVIEW: a `journalScrub` dry-run / gate-off run REPORTS the would-scrub counts but
 *      mutates NOTHING (the raw payloads stay present) — the irreversible-safety preview contract.
 *
 * DB ISOLATION: a whole throwaway DATABASE (not a schema) — the platform migration chain materializes
 * orgs + the platform tables; the generated product SQL materializes the two product stores. The
 * product tables are registered in the chokepoint via the @rayspec/db/testing seam (the LOCAL A1
 * stand-in) so `forTenant().delete/select/insert` reach them.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditStore, type EraseResult, eraseTenant, TenantEraseError } from '@rayspec/api-auth';
import {
  buildProductTables,
  type Db,
  forTenant,
  generateProductSql,
  makeDb,
  schema,
} from '@rayspec/db';
import { registerScopedTables } from '@rayspec/db/testing';
import type { BlobStoreFactory } from '@rayspec/platform';
import { makeFsBlobStoreFactory } from '@rayspec/platform';
import type { StoreSpec } from '@rayspec/spec';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from './composition-root.js';

// Two real tenants (org UUIDs — the chokepoint + the blob prefix both require a UUID).
const T1 = '00000000-0000-0000-0000-0000000000a1';
const T2 = '00000000-0000-0000-0000-0000000000b2';
// A well-formed UUID that is NOT an existing org (the fail-closed existence probe must abort on it).
const T_ABSENT = '00000000-0000-0000-0000-0000000000ff';

// Two product stores with a product→product FK (parent `documents` ← child `revisions`), ON DELETE
// RESTRICT so a WRONG (parent-first) delete order would raise an FK violation — the FK-order proof is
// fail-the-fix (reverse the children-first order and scenario 2 goes RED on the restrict constraint).
const STORES: StoreSpec[] = [
  {
    name: 'documents',
    columns: [{ name: 'title', type: 'text', nullable: false, unique: false }],
    foreignKeys: [],
  },
  {
    name: 'revisions',
    columns: [
      { name: 'document_id', type: 'uuid', nullable: false, unique: false },
      { name: 'body', type: 'text', nullable: true, unique: false },
    ],
    foreignKeys: [{ column: 'document_id', references: 'documents', onDelete: 'restrict' }],
  },
];

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

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

const SUITE_DB = `rayspec_erase_${process.pid}`;

// Ran-guard counter: a DELETE-isolation proof must NEVER silently self-skip in CI.
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let scenariosRan = 0;
const SCENARIO_COUNT = 12;

describe('eraseTenant — tenant-scoped product+blob hard-delete (real DB + fs blob + audit)', () => {
  const baseUrl = process.env.DATABASE_URL;
  const maybe = baseUrl ? it : it.skip;

  let db: Db;
  let appDbUrl = '';
  let blobRoot = '';
  let blobFactory: BlobStoreFactory;
  let audit: AuditStore;
  let unregister: (() => void) | undefined;
  const productTables = buildProductTables(STORES);

  beforeAll(async () => {
    if (!baseUrl) return;
    appDbUrl = withDbName(baseUrl, SUITE_DB);

    // Fresh empty throwaway APP database.
    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    db = makeDb(appDbUrl);
    await applyMigrations(db); // materialize orgs + the platform tables (clean bootstrap)

    // Materialize the two product stores (strip drizzle statement-breakpoints, apply all-or-nothing).
    const ddl = generateProductSql(STORES).replace(/-->\s*statement-breakpoint/g, '');
    await db.$client.begin(async (tx) => {
      await tx.unsafe(ddl);
    });

    // LOCAL A1 stand-in: register THESE exact product-table instances in the chokepoint Set.
    unregister = registerScopedTables([...productTables.values()]);

    // The two tenants (orgs rows — the tenant_id FK target + the existence probe).
    await db.$client.unsafe(
      'INSERT INTO orgs (id, name, slug) VALUES ($1,$2,$3),($4,$5,$6) ON CONFLICT DO NOTHING',
      [T1, 'Tenant One', 't1', T2, 'Tenant Two', 't2'],
    );

    blobRoot = mkdtempSync(join(tmpdir(), 'rayspec-erase-blob-'));
    blobFactory = makeFsBlobStoreFactory(blobRoot);
    audit = new AuditStore(db);
  }, 120_000);

  afterAll(async () => {
    unregister?.();
    if (blobRoot) rmSync(blobRoot, { recursive: true, force: true });
    if (db) await db.$client.end();
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  }, 60_000);

  // ── seed helpers ───────────────────────────────────────────────────────────────────────────────
  const documents = productTables.get('documents') as never;
  const revisions = productTables.get('revisions') as never;

  async function rowCount(tenantId: string, name: 'documents' | 'revisions'): Promise<number> {
    const t = productTables.get(name) as never;
    return (await forTenant(db, tenantId).select(t).all()).length;
  }
  async function blobPresent(tenantId: string, key: string): Promise<boolean> {
    const got = await blobFactory(tenantId).get(key);
    return !(typeof got === 'object' && got !== null && 'notFound' in got);
  }
  async function insertDocument(tenantId: string, title: string): Promise<string> {
    const rows = (await forTenant(db, tenantId)
      .insert(documents, { title })
      .returning()) as unknown as { id: string }[];
    return rows[0].id;
  }
  async function insertRevision(tenantId: string, documentId: string, body: string): Promise<void> {
    // buildProductTables maps the SQL column `document_id` to the drizzle property `documentId` (camelCase).
    await forTenant(db, tenantId).insert(revisions, { documentId: documentId, body });
  }

  // ── CORE tenant-scoped tables — the platform run-journal/conversation rows ─────────
  // These are registered in the chokepoint by DEFAULT (CORE_TENANT_SCOPED_TABLES ⊂ TENANT_SCOPED_TABLES),
  // so `forTenant().insert/select/delete` reach them with no test registration.
  const CORE_NAMES = [
    'runs',
    'journal_steps',
    'conversation_items',
    'run_events',
    'idempotency_keys',
    // the durable workflow journal is tenant-scoped (CORE_TENANT_SCOPED_TABLES), so tenant
    // erasure covers it too (GDPR completeness). Seeded with 0 rows here — the erase reports them at 0.
    'workflow_runs',
    'workflow_node_states',
    'workflow_artifacts',
  ] as const;
  type CoreName = (typeof CORE_NAMES)[number];
  const coreTable: Record<CoreName, never> = {
    runs: schema.runs as never,
    journal_steps: schema.journalSteps as never,
    conversation_items: schema.conversationItems as never,
    run_events: schema.runEvents as never,
    idempotency_keys: schema.idempotencyKeys as never,
    workflow_runs: schema.workflowRuns as never,
    workflow_node_states: schema.workflowNodeStates as never,
    workflow_artifacts: schema.workflowArtifacts as never,
  };
  async function coreRowCount(tenantId: string, name: CoreName): Promise<number> {
    return (await forTenant(db, tenantId).select(coreTable[name]).all()).length;
  }
  // Raw-payload read-backs for the journal-scrub scenarios (the row shapes we assert on).
  type JournalRow = {
    idempotencyKey: string;
    inputHash: string;
    status: string;
    output: unknown;
    costUsd: string;
    billedCostUsd: string;
    providerCostUsd: string | null;
    costDrift: boolean;
  };
  type ConvRow = { role: string; payload: unknown };
  async function journalRows(tenantId: string): Promise<JournalRow[]> {
    return (await forTenant(db, tenantId)
      .select(schema.journalSteps as never)
      .all()) as unknown as JournalRow[];
  }
  async function convRows(tenantId: string): Promise<ConvRow[]> {
    return (await forTenant(db, tenantId)
      .select(schema.conversationItems as never)
      .all()) as unknown as ConvRow[];
  }
  async function wipeCore(tenantId: string): Promise<void> {
    // run-family run_id is a plain text column (no enforced FK), so any order is safe.
    for (const name of CORE_NAMES) await forTenant(db, tenantId).delete(coreTable[name]).where();
  }
  /**
   * Seed a deterministic set of CORE rows for one tenant: `runs`=1, `journal_steps`=2, `conversation_items`
   * =2, `run_events`=1, `idempotency_keys`=1. run_id is the GLOBAL PK on `runs`, so it is tenant-prefixed
   * to stay unique across tenants. Returns the expected per-table counts (for the erase-result assertion).
   */
  async function seedCore(tenantId: string): Promise<Record<CoreName, number>> {
    const tdb = forTenant(db, tenantId);
    const runId = `${tenantId}-r0`;
    await tdb.insert(schema.runs as never, {
      runId,
      backend: 'openai',
      authMode: 'api-key',
      agentName: 'a',
      model: 'm',
      status: 'completed',
    });
    await tdb.insert(schema.journalSteps as never, [
      {
        runId,
        backend: 'openai',
        type: 'llm',
        idempotencyKey: `${tenantId}-k0`,
        inputHash: 'h',
        status: 'ok',
        authMode: 'api-key',
        // Raw output payload + distinctive cost ledger — so the scrub scenarios can assert the payload
        // is NULLed while the cost columns survive UNCHANGED.
        output: { secret: `${tenantId}-raw-llm-output` },
        costUsd: '0.0123',
        billedCostUsd: '0.0100',
        providerCostUsd: '0.0111',
        costDrift: true,
      },
      {
        runId,
        backend: 'openai',
        type: 'tool',
        idempotencyKey: `${tenantId}-k1`,
        inputHash: 'h',
        status: 'ok',
        authMode: 'api-key',
        output: { secret: `${tenantId}-raw-tool-output` },
        costUsd: '0.0055',
        billedCostUsd: '0.0000',
        providerCostUsd: null,
        costDrift: false,
      },
    ]);
    await tdb.insert(schema.conversationItems as never, [
      { runId, seq: '0', role: 'user', payload: { text: `${tenantId}-raw-user-msg` } },
      { runId, seq: '1', role: 'assistant', payload: { text: `${tenantId}-raw-assistant-msg` } },
    ]);
    await tdb.insert(schema.runEvents as never, {
      runId,
      seq: '0',
      type: 'run_started',
      data: {},
    });
    await tdb.insert(schema.idempotencyKeys as never, {
      scope: 'test',
      idemKey: `${tenantId}-ik0`,
      bodyHash: 'bh',
      snapshot: {},
    });
    return {
      runs: 1,
      journal_steps: 2,
      conversation_items: 2,
      run_events: 1,
      idempotency_keys: 1,
      // workflow journal tables — not seeded here, so the erase reports them at 0 (they are still
      // covered by tenant erasure; coreTotalRows stays 7 = 1 + 2 + 2 + 1 + 1).
      workflow_runs: 0,
      workflow_node_states: 0,
      workflow_artifacts: 0,
    };
  }

  // A fresh, known seed before EACH scenario (each scenario mutates the DB).
  beforeEach(async () => {
    if (!baseUrl) return;
    // Clear the out-of-band audit rows for the test tenants so the per-scenario audit-count assertions
    // start from zero (auth_audit is a global table — not tenant-scoped via forTenant, and the
    // product-row wipe below does not touch it).
    await db.$client.unsafe('DELETE FROM auth_audit WHERE actor_org_id IN ($1,$2)', [T1, T2]);
    // Wipe both tenants (children-first under the restrict FK), their CORE run-journal rows, and both
    // blob subtrees — so every scenario starts from a known-clean state (incl. scenario 8's core seeds).
    for (const t of [T1, T2]) {
      await forTenant(db, t).delete(revisions).where();
      await forTenant(db, t).delete(documents).where();
      await wipeCore(t);
      await blobFactory(t).deleteTenant(t);
    }
    // T1: 2 documents, 3 revisions (2 under the first document, 1 under the second), 2 blobs.
    const d1a = await insertDocument(T1, 'T1 document A');
    const d1b = await insertDocument(T1, 'T1 document B');
    await insertRevision(T1, d1a, 'T1 revision a0');
    await insertRevision(T1, d1a, 'T1 revision a1');
    await insertRevision(T1, d1b, 'T1 revision b0');
    await blobFactory(T1).put('rec/0', enc('T1 blob 0'));
    await blobFactory(T1).put('rec/1', enc('T1 blob 1'));
    // T2: 1 document, 1 revision, 1 blob (the cross-tenant witness — must survive a T1 erase).
    const d2a = await insertDocument(T2, 'T2 document A');
    await insertRevision(T2, d2a, 'T2 revision a0');
    await blobFactory(T2).put('rec/0', enc('T2 blob 0'));
  });

  maybe(
    '1. cross-tenant isolation — erase T1 → T1 gone, T2 FULLY INTACT (RED-first target)',
    async () => {
      const res = await eraseTenant({
        db,
        tenantId: T1,
        productTables,
        blob: blobFactory(T1),
        audit,
        enabled: true,
        stores: STORES,
      });
      expect(res.mode).toBe('deleted');
      expect(res.blobs).toBe('deleted');

      // T1 — rows + blobs GONE.
      expect(await rowCount(T1, 'documents')).toBe(0);
      expect(await rowCount(T1, 'revisions')).toBe(0);
      expect(await blobPresent(T1, 'rec/0')).toBe(false);
      expect(await blobPresent(T1, 'rec/1')).toBe(false);

      // T2 — rows + blob FULLY INTACT (the security invariant; a un-scoped delete makes this RED).
      expect(await rowCount(T2, 'documents')).toBe(1);
      expect(await rowCount(T2, 'revisions')).toBe(1);
      expect(await blobPresent(T2, 'rec/0')).toBe(true);
      scenariosRan++;
    },
  );

  maybe('2. full erasure + FK-order (no violation) + out-of-band audit record', async () => {
    const res = await eraseTenant({
      db,
      tenantId: T1,
      productTables,
      blob: blobFactory(T1),
      audit,
      enabled: true,
      stores: STORES,
    });
    // Counts match the seed across EVERY product table (children-first → no restrict FK violation).
    expect(res.tables).toEqual({ revisions: 3, documents: 2 });
    expect(res.totalRows).toBe(5);

    // The irreversible action left a durable, out-of-band audit row (scoped to the erased org).
    expect(await audit.countForTenantEvent(T1, 'tenant_data_erased')).toBe(1);
    const rows = await audit.readForTenant(T1);
    const erasure = rows.find((r) => r.event === 'tenant_data_erased');
    expect(erasure).toBeDefined();
    const meta = erasure?.meta as {
      totalRows: number;
      mode: string;
      tables: Record<string, number>;
    };
    expect(meta.mode).toBe('deleted');
    expect(meta.totalRows).toBe(5);
    expect(meta.tables).toEqual({ revisions: 3, documents: 2 });
    scenariosRan++;
  });

  maybe('3. fail-closed — non-UUID + nonexistent org ABORT (no partial delete)', async () => {
    // Non-UUID → forTenant's constructor throws (fail-closed) BEFORE any delete.
    await expect(
      eraseTenant({ db, tenantId: 'not-a-uuid', productTables, enabled: true, stores: STORES }),
    ).rejects.toThrow();
    // Well-formed but nonexistent org → the existence probe aborts with TenantEraseError.
    await expect(
      eraseTenant({ db, tenantId: T_ABSENT, productTables, enabled: true, stores: STORES }),
    ).rejects.toBeInstanceOf(TenantEraseError);
    // Nothing was deleted (T1 + T2 untouched).
    expect(await rowCount(T1, 'documents')).toBe(2);
    expect(await rowCount(T2, 'documents')).toBe(1);
    scenariosRan++;
  });

  maybe('4. idempotent — a 2nd erase deletes 0 / no-op', async () => {
    const first = await eraseTenant({
      db,
      tenantId: T1,
      productTables,
      blob: blobFactory(T1),
      audit,
      enabled: true,
      stores: STORES,
    });
    expect(first.totalRows).toBe(5);
    const second = await eraseTenant({
      db,
      tenantId: T1,
      productTables,
      blob: blobFactory(T1),
      audit,
      enabled: true,
      stores: STORES,
    });
    expect(second.mode).toBe('deleted');
    expect(second.totalRows).toBe(0);
    expect(second.tables).toEqual({ revisions: 0, documents: 0 });
    expect(second.blobs).toBe('deleted'); // a no-op deleteTenant on an absent subtree (idempotent)
    scenariosRan++;
  });

  maybe(
    '5. dryRun — counts what would be deleted, deletes NOTHING (rows + blobs intact)',
    async () => {
      const res = await eraseTenant({
        db,
        tenantId: T1,
        productTables,
        blob: blobFactory(T1),
        audit,
        enabled: true,
        dryRun: true,
        stores: STORES,
      });
      expect(res.mode).toBe('dry-run');
      expect(res.dryRunReason).toBe('dry-run-requested');
      expect(res.tables).toEqual({ revisions: 3, documents: 2 });
      expect(res.totalRows).toBe(5);
      expect(res.blobs).toBe('dry-run');
      // NOTHING deleted — rows + blobs still present.
      expect(await rowCount(T1, 'documents')).toBe(2);
      expect(await rowCount(T1, 'revisions')).toBe(3);
      expect(await blobPresent(T1, 'rec/0')).toBe(true);
      // No audit record for a dry-run (nothing irreversible happened).
      expect(await audit.countForTenantEvent(T1, 'tenant_data_erased')).toBe(0);
      scenariosRan++;
    },
  );

  maybe('6. gate OFF (default) — a non-dryRun call performs ZERO deletes', async () => {
    const res = await eraseTenant({
      db,
      tenantId: T1,
      productTables,
      blob: blobFactory(T1),
      audit,
      enabled: false, // the default operator gate
      stores: STORES,
    });
    expect(res.mode).toBe('dry-run');
    expect(res.dryRunReason).toBe('gate-disabled');
    expect(res.totalRows).toBe(5);
    // ZERO deletes — the irreversible action requires the explicit gate.
    expect(await rowCount(T1, 'documents')).toBe(2);
    expect(await rowCount(T1, 'revisions')).toBe(3);
    expect(await blobPresent(T1, 'rec/0')).toBe(true);
    scenariosRan++;
  });

  maybe('7. no blob backend — rows erased, blobs reported no-backend', async () => {
    const res: EraseResult = await eraseTenant({
      db,
      tenantId: T1,
      productTables,
      audit,
      enabled: true,
      stores: STORES,
      // no `blob` wired (a stores/api-only deploy)
    });
    expect(res.mode).toBe('deleted');
    expect(res.totalRows).toBe(5);
    expect(res.blobs).toBe('no-backend');
    expect(await rowCount(T1, 'documents')).toBe(0);
    // The blobs we seeded are untouched by an erase that had no blob backend — but T1's rows are gone.
    scenariosRan++;
  });

  maybe(
    '8. core-table erasure — T1 run-journal/conversation core rows GONE, T2 core FULLY INTACT',
    async () => {
      // Seed the CORE run-journal/conversation rows on TOP of the product seed (beforeEach) for BOTH tenants.
      const t1Core = await seedCore(T1);
      const t2Core = await seedCore(T2);

      const res = await eraseTenant({
        db,
        tenantId: T1,
        productTables,
        blob: blobFactory(T1),
        audit,
        enabled: true,
        stores: STORES,
      });
      expect(res.mode).toBe('deleted');
      // The core-table counts are reported DISTINCTLY from the product `tables`.
      expect(res.coreTables).toEqual(t1Core);
      expect(res.coreTotalRows).toBe(7); // 1 + 2 + 2 + 1 + 1
      // Product counts are unchanged (the product half stays its own dimension).
      expect(res.tables).toEqual({ revisions: 3, documents: 2 });
      expect(res.totalRows).toBe(5);

      // T1 — every core table is now EMPTY.
      for (const name of CORE_NAMES) expect(await coreRowCount(T1, name)).toBe(0);

      // T2 — every core table is FULLY INTACT (cross-tenant isolation on the CORE tables too; an
      // un-scoped core delete would make this RED).
      expect(await coreRowCount(T2, 'runs')).toBe(t2Core.runs);
      expect(await coreRowCount(T2, 'journal_steps')).toBe(t2Core.journal_steps);
      expect(await coreRowCount(T2, 'conversation_items')).toBe(t2Core.conversation_items);
      expect(await coreRowCount(T2, 'run_events')).toBe(t2Core.run_events);
      expect(await coreRowCount(T2, 'idempotency_keys')).toBe(t2Core.idempotency_keys);

      // The audit meta records the core counts distinctly from the product counts.
      const rows = await audit.readForTenant(T1);
      const erasure = rows.find((r) => r.event === 'tenant_data_erased');
      const meta = erasure?.meta as { coreTables: Record<string, number>; coreTotalRows: number };
      expect(meta.coreTables).toEqual(t1Core);
      expect(meta.coreTotalRows).toBe(7);
      scenariosRan++;
    },
  );

  maybe(
    '9. audit required — an enabled (real) erasure with NO audit store ABORTS (zero deletes)',
    async () => {
      await seedCore(T1); // also seed core so the "zero deletes" check spans both row classes
      await expect(
        eraseTenant({
          db,
          tenantId: T1,
          productTables,
          blob: blobFactory(T1),
          enabled: true, // a REAL erasure …
          stores: STORES,
          // … but NO `audit` wired — must fail closed.
        }),
      ).rejects.toBeInstanceOf(TenantEraseError);

      // ZERO deletes — product rows, core rows, and blobs ALL intact.
      expect(await rowCount(T1, 'documents')).toBe(2);
      expect(await rowCount(T1, 'revisions')).toBe(3);
      expect(await coreRowCount(T1, 'runs')).toBe(1);
      expect(await coreRowCount(T1, 'journal_steps')).toBe(2);
      expect(await blobPresent(T1, 'rec/0')).toBe(true);
      // No audit record was written (nothing happened).
      expect(await audit.countForTenantEvent(T1, 'tenant_data_erased')).toBe(0);
      scenariosRan++;
    },
  );

  maybe(
    '10. journalScrub — T1 raw payloads NULLed, journal STRUCTURE (idempotency + cost + status) intact',
    async () => {
      await seedCore(T1);

      // BEFORE: the raw payloads are present (so the null-after assertion is meaningful, not vacuous).
      const before = await journalRows(T1);
      expect(before.length).toBe(2);
      expect(before.every((r) => r.output !== null)).toBe(true);
      const convBefore = await convRows(T1);
      expect(convBefore.length).toBe(2);
      expect(convBefore.every((r) => r.payload !== null)).toBe(true);

      const res = await eraseTenant({
        db,
        tenantId: T1,
        productTables,
        blob: blobFactory(T1),
        audit,
        enabled: true,
        journalScrub: true,
        stores: STORES,
      });
      expect(res.mode).toBe('deleted');
      // The scrub is REPORTED distinctly: the two payload tables show scrubbed-row counts and are
      // ABSENT from coreTables (they were NOT deleted).
      expect(res.journalScrubbed).toEqual({ journal_steps: 2, conversation_items: 2 });
      expect(res.journalScrubbedTotal).toBe(4);
      expect(res.coreTables.journal_steps).toBeUndefined();
      expect(res.coreTables.conversation_items).toBeUndefined();

      // (a) SCRUB EFFECT — the raw payloads are NULL, the ROWS SURVIVE.
      const after = await journalRows(T1);
      expect(after.length).toBe(2); // rows kept (not deleted)
      expect(after.every((r) => r.output === null)).toBe(true); // raw output erased
      const convAfter = await convRows(T1);
      expect(convAfter.length).toBe(2);
      expect(convAfter.every((r) => r.payload === null)).toBe(true); // raw transcript erased

      // (b) STRUCTURE PRESERVED — the exactly-once markers + the whole cost ledger are UNCHANGED on the
      // surviving rows.
      const k0 = after.find((r) => r.idempotencyKey === `${T1}-k0`);
      const k1 = after.find((r) => r.idempotencyKey === `${T1}-k1`);
      expect(k0).toBeDefined();
      expect(k1).toBeDefined();
      expect(k0?.status).toBe('ok');
      expect(k0?.inputHash).toBe('h');
      expect(k0?.costUsd).toBe('0.0123');
      expect(k0?.billedCostUsd).toBe('0.0100');
      expect(k0?.providerCostUsd).toBe('0.0111');
      expect(k0?.costDrift).toBe(true);
      expect(k1?.billedCostUsd).toBe('0.0000');
      expect(k1?.providerCostUsd).toBe(null);

      // (c) the unique (tenant_id, run_id, idempotency_key) index STILL enforces exactly-once — a
      // duplicate insert on the SURVIVING scrubbed key must RAISE (the scrub kept the row + its index).
      await expect(
        forTenant(db, T1).insert(schema.journalSteps as never, {
          runId: `${T1}-r0`,
          backend: 'openai',
          type: 'llm',
          idempotencyKey: `${T1}-k0`, // collides with the surviving scrubbed row
          inputHash: 'h',
          status: 'ok',
          authMode: 'api-key',
        }),
      ).rejects.toThrow();

      // The OTHER core tables were hard-deleted as normal (ledger-preservation is scoped to the two
      // payload tables); the product rows + blobs were hard-deleted too.
      expect(await coreRowCount(T1, 'runs')).toBe(0);
      expect(await coreRowCount(T1, 'run_events')).toBe(0);
      expect(await coreRowCount(T1, 'idempotency_keys')).toBe(0);
      expect(await rowCount(T1, 'documents')).toBe(0);
      expect(await blobPresent(T1, 'rec/0')).toBe(false);

      // The out-of-band audit record carries the scrub counts distinctly.
      const rows = await audit.readForTenant(T1);
      const erasure = rows.find((r) => r.event === 'tenant_data_erased');
      const meta = erasure?.meta as {
        journalScrubbed?: Record<string, number>;
        journalScrubbedTotal?: number;
      };
      expect(meta.journalScrubbed).toEqual({ journal_steps: 2, conversation_items: 2 });
      expect(meta.journalScrubbedTotal).toBe(4);
      scenariosRan++;
    },
  );

  maybe(
    '11. journalScrub — FOREIGN tenant payloads FULLY INTACT (cross-tenant isolation on the scrub)',
    async () => {
      await seedCore(T1);
      await seedCore(T2);

      await eraseTenant({
        db,
        tenantId: T1,
        productTables,
        blob: blobFactory(T1),
        audit,
        enabled: true,
        journalScrub: true,
        stores: STORES,
      });

      // T1 — scrubbed (raw payloads NULL).
      const t1j = await journalRows(T1);
      expect(t1j.length).toBe(2);
      expect(t1j.every((r) => r.output === null)).toBe(true);

      // T2 — the raw payloads are UNTOUCHED (an un-scoped scrub UPDATE would make this RED).
      const t2j = await journalRows(T2);
      expect(t2j.length).toBe(2);
      expect(t2j.every((r) => r.output !== null)).toBe(true);
      const t2c = await convRows(T2);
      expect(t2c.length).toBe(2);
      expect(t2c.every((r) => r.payload !== null)).toBe(true);
      // T2's whole ledger + core rows survive untouched (the scrub of T1 deleted none of T2's rows).
      expect(await coreRowCount(T2, 'runs')).toBe(1);
      expect(await coreRowCount(T2, 'journal_steps')).toBe(2);
      expect(await coreRowCount(T2, 'run_events')).toBe(1);
      scenariosRan++;
    },
  );

  maybe(
    '12. journalScrub PREVIEW — dryRun + gate-off report the would-scrub counts but mutate NOTHING',
    async () => {
      await seedCore(T1);

      // BEFORE: the raw payloads are present, so "still non-null after the preview" is a real assertion.
      const before = await journalRows(T1);
      expect(before.length).toBe(2);
      expect(before.every((r) => r.output !== null)).toBe(true);
      const convBefore = await convRows(T1);
      expect(convBefore.length).toBe(2);
      expect(convBefore.every((r) => r.payload !== null)).toBe(true);

      // Asserts the preview contract for one call: reports the would-scrub counts, mutates NOTHING.
      async function assertPreviewMutatesNothing(
        res: EraseResult,
        expectReason: 'dry-run-requested' | 'gate-disabled',
      ): Promise<void> {
        expect(res.mode).toBe('dry-run');
        expect(res.dryRunReason).toBe(expectReason);
        // The would-scrub counts are correct + non-zero (the preview REPORTS what it would scrub) …
        expect(res.journalScrubbed).toEqual({ journal_steps: 2, conversation_items: 2 });
        expect(res.journalScrubbedTotal).toBe(4);
        // … and the payload tables stay ABSENT from coreTables (scrub targets, not delete targets).
        expect(res.coreTables.journal_steps).toBeUndefined();
        expect(res.coreTables.conversation_items).toBeUndefined();
        // GROUND TRUTH: the raw payloads (and their rows) are STILL PRESENT after the preview — a preview
        // that actually NULLed the payloads would flip these to `=== null` and go RED.
        const j = await journalRows(T1);
        expect(j.length).toBe(2);
        expect(j.every((r) => r.output !== null)).toBe(true);
        const c = await convRows(T1);
        expect(c.length).toBe(2);
        expect(c.every((r) => r.payload !== null)).toBe(true);
        // A preview writes NO audit record (nothing irreversible happened).
        expect(await audit.countForTenantEvent(T1, 'tenant_data_erased')).toBe(0);
      }

      // (A) explicit dryRun preview (gate ON): counts reported, nothing mutated.
      const dry = await eraseTenant({
        db,
        tenantId: T1,
        productTables,
        blob: blobFactory(T1),
        audit,
        enabled: true,
        dryRun: true,
        journalScrub: true,
        stores: STORES,
      });
      await assertPreviewMutatesNothing(dry, 'dry-run-requested');

      // (B) gate-off preview (the default operator gate): ALSO previews — counts reported, nothing mutated.
      const off = await eraseTenant({
        db,
        tenantId: T1,
        productTables,
        blob: blobFactory(T1),
        audit,
        enabled: false,
        journalScrub: true,
        stores: STORES,
      });
      await assertPreviewMutatesNothing(off, 'gate-disabled');
      scenariosRan++;
    },
  );
});

/**
 * Ran-guard: a SEPARATE, NON-skipped describe that FAILS the run when the DB
 * is REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) but the erasure scenarios did NOT run — a CI run that
 * lost DATABASE_URL would otherwise silently skip the cross-tenant DELETE-isolation proof (the
 * false-green class). Local dev without a DB still skips ergonomically.
 */
describe('eraseTenant — ran-guard (the DELETE-isolation proof must not silently skip in CI)', () => {
  it('the erasure scenarios ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      expect(scenariosRan).toBe(SCENARIO_COUNT);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
