/**
 * Product schema changes on GROUND TRUTH: real `.ray` bundles, a real application database, a real
 * shadow server, `prepare()` to plan and the product DDL step under `runApply` to apply.
 *
 * WHAT THESE ARMS PROVE, in one environment that evolves step by step:
 *  - an empty database is materialized from a bundle that carries no delta, and the ledger records it;
 *  - an additive nullable column arrives as a bundled delta, regenerated and matched by the target;
 *  - a destructive drop is refused until the bundle carries a reviewed allowlist, and the refusal
 *    names the store, the column and the review step, whatever the bundle's own `destructive` says;
 *  - a column added by hand is drift for the plan and for the apply step alike;
 *  - a delta, a from-digest or a to-digest that differs from what the target regenerates is refused;
 *  - a ledger row written by a newer runtime stops both the plan and the apply;
 * and after every step the ledger's latest row and the live schema agree.
 *
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run that did not run.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeBundle } from '@rayspec/bundle';
import { type BundleSpec, parseBundleSpec } from '@rayspec/bundle-closure';
import {
  CONTRACT_VERSION,
  EMPTY_PRODUCT_SCHEMA_DIGEST,
  type PrepareData,
  type ProductMigration,
  type ResultEnvelope,
  schemaValidator,
} from '@rayspec/bundle-contract';
import { type Db, generateProductSql, makeDb } from '@rayspec/db';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runApply } from './apply-operation.js';
import { applyMigrations } from './composition-root.js';
import { DeployApply, productDdlStep, RuntimeApplyError, schemaObservers } from './deploy-apply.js';
import { readProductLedger } from './product-ledger.js';
import {
  BUNDLED_DELTA_NAME,
  declaredStoresOf,
  productDelta,
  shadowProductDigests,
} from './product-schema-plan.js';
import { createRuntimeControl, runtimeVersion } from './runtime-control.js';
import { type CatalogQuery, readProductSchemaDigest } from './schema-head.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

const SUITE_DB = `rayspec_product_ledger_${process.pid}`;
const PREPARED_AT = new Date('2026-09-30T08:00:00.000Z');

function spec(columns: string): string {
  return `version: '1.0'
metadata:
  name: ledger-notes
  description: one store whose columns change from bundle to bundle
stores:
  - name: ledger_notes
    columns:
${columns}
api:
  - { method: POST, path: '/ledger-notes', action: { kind: store, store: ledger_notes, op: create } }
`;
}

/** The first release, an additive second one, a third that drops a column, and a fourth that adds one. */
const V1 = spec('      - { name: body, type: text }');
const V2 = spec(
  '      - { name: body, type: text }\n      - { name: tag, type: text, nullable: true }',
);
const V3 = spec('      - { name: tag, type: text, nullable: true }');
const V4 = spec(
  '      - { name: tag, type: text, nullable: true }\n      - { name: note, type: text, nullable: true }',
);

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const validEnvelope = schemaValidator('resultEnvelope');

function parsed(source: string): BundleSpec {
  const result = parseBundleSpec(Buffer.from(source));
  if (!result.ok) throw new Error(`the test spec does not parse: ${JSON.stringify(result.errors)}`);
  return result.value;
}

describe.skipIf(!baseUrl)('product schema changes through the ledger', () => {
  let dbUrl = '';
  let shadowUrl = '';
  let dir = '';
  let db: Db;
  let query: CatalogQuery;

  async function sql<T = Record<string, unknown>>(text: string): Promise<T[]> {
    const client = postgres(dbUrl, { max: 1 });
    try {
      return (await client.unsafe(text)) as unknown as T[];
    } finally {
      await client.end();
    }
  }

  function adapter() {
    return createRuntimeControl({ db, now: () => PREPARED_AT, shadowDatabaseUrl: shadowUrl });
  }

  interface Carried {
    delta: string;
    allowlist?: string;
    manifest?: Partial<ProductMigration>;
  }

  let written = 0;
  async function bundle(source: string, carried?: Carried): Promise<{ path: string; sha: string }> {
    written += 1;
    const path = join(dir, `ledger-${written}.ray`);
    const files = [
      { path: 'payload/rayspec.yaml', bytes: Buffer.from(source) },
      {
        path: 'payload/sbom.cdx.json',
        bytes: Buffer.from(
          '{"bomFormat":"CycloneDX","components":[],"specVersion":"1.5","version":1}\n',
        ),
      },
      {
        path: 'payload/THIRD-PARTY-NOTICES.txt',
        bytes: Buffer.from('No third-party components are redistributed in this bundle.\n'),
      },
    ];
    let productMigration: ProductMigration | undefined;
    if (carried !== undefined) {
      files.push({
        path: 'payload/migrations/product-delta.sql',
        bytes: Buffer.from(carried.delta),
      });
      if (carried.allowlist !== undefined) {
        files.push({
          path: 'payload/migrations/product-allowlist.json',
          bytes: Buffer.from(carried.allowlist),
        });
      }
      productMigration = {
        fromProductSchemaDigest: 'a'.repeat(64),
        toProductSchemaDigest: 'b'.repeat(64),
        deltaPath: 'payload/migrations/product-delta.sql',
        ...(carried.allowlist === undefined
          ? {}
          : { allowlistPath: 'payload/migrations/product-allowlist.json' }),
        destructive: false,
        ...carried.manifest,
      };
    }
    const result = await writeBundle(path, {
      manifest: {
        formatVersion: 1,
        kind: 'application',
        application: { id: 'ledger-notes', version: `1.0.${written}` },
        runtime: { version: runtimeVersion() },
        target: { os: 'linux', arch: 'x64', nodeMajor: 22 },
        spec: 'payload/rayspec.yaml',
        requires: ['declarative-api', 'declarative-stores'],
        bindings: [],
        permissions: { egressHosts: [], execution: 'none' },
        ...(productMigration === undefined ? {} : { productMigration }),
      },
      files,
    });
    if (!result.ok)
      throw new Error(`writing the test bundle failed: ${JSON.stringify(result.errors)}`);
    return { path, sha: result.value.archiveSha256 };
  }

  /**
   * What `rayspec pack --against` carries for a change from `from` to `to`: the regenerated delta
   * and the digests a fresh materialization of `from` has before and after it.
   */
  async function packed(from: string, to: string, allowlist?: string): Promise<Carried> {
    const old = declaredStoresOf(parsed(from));
    const delta = productDelta(old, declaredStoresOf(parsed(to))).migrationSql;
    const baseline = productDelta({ stores: [] }, old).migrationSql;
    const digests = await shadowProductDigests(shadowUrl, [baseline], delta);
    return {
      delta,
      ...(allowlist === undefined ? {} : { allowlist }),
      manifest: {
        fromProductSchemaDigest: digests.before,
        toProductSchemaDigest: digests.after,
      },
    };
  }

  async function prepare(b: { path: string; sha: string }): Promise<ResultEnvelope<PrepareData>> {
    const head =
      (
        await adapter().inspect({
          contractVersion: CONTRACT_VERSION,
          operationId: randomUUID(),
          actor: 'test',
        })
      ).data?.schemaHead ?? null;
    const result = await adapter().prepare({
      contractVersion: CONTRACT_VERSION,
      operationId: randomUUID(),
      actor: 'supervisor:test',
      bundleSha256: b.sha,
      bundlePath: b.path,
      bindingRevision: [],
      expectedSchemaHead: head,
    });
    expect(
      validEnvelope(JSON.parse(JSON.stringify(result))),
      JSON.stringify(validEnvelope.errors),
    ).toBe(true);
    return result;
  }

  /** Apply the plan's product delta as an apply whose plan digest is recomputed by `prepare`. */
  async function apply(b: { path: string; sha: string }, source: string) {
    const prepared = (await prepare(b)).data!;
    const delta = prepared.plan.schemaImpact.productDeltaSha256;
    expect(delta).not.toBeNull();
    const regenerated = await regeneratedDelta(source);
    expect(sha256(regenerated)).toBe(delta);
    return await runApply({
      db,
      request: {
        contractVersion: CONTRACT_VERSION,
        operationId: randomUUID(),
        actor: 'supervisor:test',
        planDigest: prepared.planDigest,
        expectedEnvironmentRevision: prepared.environmentRevision,
        idempotencyKey: randomUUID().replaceAll('-', ''),
      },
      plan: {
        recompute: async () => (await prepare(b)).data!.planDigest,
        blockers: prepared.plan.blockers,
      },
      observers: schemaObservers(query),
      steps: [
        productDdlStep({
          name: BUNDLED_DELTA_NAME,
          sql: regenerated,
          declared: declaredStoresOf(parsed(source)),
          expectedAfter: prepared.plan.schemaImpact.to.product,
        }),
      ],
    });
  }

  /** The delta the target regenerates for `source` from the ledger's latest row. */
  async function regeneratedDelta(source: string): Promise<string> {
    const ledger = await readProductLedger(query);
    const from = ledger.state === 'ledgered' ? ledger.head.declared : { stores: [] };
    return productDelta(from, declaredStoresOf(parsed(source))).migrationSql;
  }

  /** The ledger's latest row describes the live schema exactly. */
  async function expectLedgerAgrees(rows: number): Promise<void> {
    const ledger = await readProductLedger(query);
    expect(ledger.state).toBe('ledgered');
    if (ledger.state !== 'ledgered') return;
    expect(ledger.rows).toHaveLength(rows);
    expect(ledger.head.productSchemaAfter).toBe(await readProductSchemaDigest(query));
    for (const [i, row] of ledger.rows.entries()) {
      if (i > 0) expect(row.productSchemaBefore).toBe(ledger.rows[i - 1]!.productSchemaAfter);
    }
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    dbUrl = withDbName(baseUrl, SUITE_DB);
    shadowUrl = process.env.SHADOW_DATABASE_URL ?? baseUrl;
    const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }
    db = makeDb(dbUrl);
    query = async (text, params = []) =>
      (await db.$client.unsafe(text, params as never[])) as unknown as Record<string, unknown>[];
    await applyMigrations(db);
    dir = mkdtempSync(join(tmpdir(), 'rayspec-product-ledger-'));
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end().catch(() => {});
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (!baseUrl) return;
    const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('materializes an empty database from a bundle without a delta, and records it', async () => {
    expect(await readProductLedger(query)).toEqual({ state: 'empty' });
    const first = await bundle(V1);
    const { plan } = (await prepare(first)).data!;
    expect(plan.blockers).toEqual([]);
    expect(plan.warnings.map((w) => w.code)).not.toContain('RAY_W_PRODUCT_SCHEMA_UNLEDGERED');
    const stores = declaredStoresOf(parsed(V1)).stores;
    // The first materialization is exactly what the legacy deploy generates.
    expect(plan.schemaImpact.productDeltaSha256).toBe(sha256(generateProductSql(stores)));
    expect(plan.schemaImpact).toMatchObject({ destructive: false, allowlisted: false });

    const applied = await apply(first, V1);
    expect(applied.ok, JSON.stringify(applied.errors)).toBe(true);
    expect(await readProductSchemaDigest(query)).toBe(plan.schemaImpact.to.product);
    await expectLedgerAgrees(1);
    const ledger = await readProductLedger(query);
    if (ledger.state !== 'ledgered') throw new Error('not ledgered');
    expect(ledger.head.productSchemaBefore).toBe(EMPTY_PRODUCT_SCHEMA_DIGEST);
    expect(ledger.head.migrationName).toBe(BUNDLED_DELTA_NAME);
    // The row names the apply operation that ran it, and that operation's receipts exist.
    const [receipt] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM runtime_control_receipts
        WHERE operation_id = '${ledger.head.operationId}' AND step = 'product-ddl' AND event = 'step-finished'`,
    );
    expect(receipt?.n).toBe(1);

    // The same bundle again: nothing to change, nothing to review.
    const again = (await prepare(first)).data!.plan;
    expect(again.blockers).toEqual([]);
    expect(again.schemaImpact.productDeltaSha256).toBeNull();
    armsRan += 1;
  }, 120_000);

  it('adds a nullable column through a bundled delta the target regenerates', async () => {
    const carried = await packed(V1, V2);
    expect(carried.delta).toContain('ADD COLUMN "tag" text');
    const second = await bundle(V2, carried);
    const { plan } = (await prepare(second)).data!;
    expect(plan.blockers).toEqual([]);
    expect(plan.schemaImpact).toMatchObject({
      productDeltaSha256: sha256(carried.delta),
      destructive: false,
      allowlisted: false,
    });
    expect(plan.schemaImpact.from?.product).toBe(carried.manifest?.fromProductSchemaDigest);
    expect(plan.schemaImpact.to.product).toBe(carried.manifest?.toProductSchemaDigest);

    await sql(
      "INSERT INTO orgs (id, name, slug) VALUES ('00000000-0000-4000-8000-0000000000a1', 'Ledger', 'ledger')",
    );
    await sql(
      "INSERT INTO ledger_notes (tenant_id, body) VALUES ('00000000-0000-4000-8000-0000000000a1', 'kept')",
    );
    const applied = await apply(second, V2);
    expect(applied.ok, JSON.stringify(applied.errors)).toBe(true);
    expect(await readProductSchemaDigest(query)).toBe(carried.manifest?.toProductSchemaDigest);
    // The row written before the change survives it.
    expect(await sql('SELECT body, tag FROM ledger_notes')).toEqual([{ body: 'kept', tag: null }]);
    await expectLedgerAgrees(2);
    armsRan += 1;
  }, 120_000);

  it('refuses a destructive drop until a reviewed allowlist covers it, naming what it drops', async () => {
    // The bundle calls its delta harmless; the server's scanner decides.
    const carried = await packed(V2, V3);
    const unreviewed = await bundle(V3, carried);
    const refused = (await prepare(unreviewed)).data!.plan;
    expect(refused.blockers.map((b) => b.code)).toEqual(['RAY_MIGRATION_REQUIRED']);
    expect(refused.blockers[0]?.message).toContain('drop-column on ledger_notes.body');
    expect(refused.blockers[0]?.message).toContain('rayspec plan <new-spec> --against');
    expect(refused.blockers[0]?.message).toContain('--allowlist <file.json>');
    expect(refused.schemaImpact).toMatchObject({ destructive: true, allowlisted: false });
    const blocked = await apply(unreviewed, V3);
    expect(blocked.errors[0]).toMatchObject({
      code: 'RAY_POLICY_DENIED',
      reason: 'plan-has-blockers',
    });
    expect(
      await sql(
        "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'ledger_notes' AND column_name = 'body'",
      ),
    ).toEqual([{ n: 1 }]);

    // A malformed allowlist clears nothing.
    const malformed = await bundle(V3, { ...carried, allowlist: '[{"kind":"drop-column"}]' });
    expect((await prepare(malformed)).data!.plan.blockers.map((b) => b.code)).toEqual([
      'RAY_MIGRATION_REQUIRED',
      'RAY_MIGRATION_REQUIRED',
    ]);

    // The reviewed allowlist, as `rayspec plan --against` proposes it.
    const proposed = productDelta(
      declaredStoresOf(parsed(V2)),
      declaredStoresOf(parsed(V3)),
    ).proposedAllowlist;
    expect(proposed.map((e) => e.kind)).toEqual(['drop-column']);
    const reviewed = await bundle(V3, {
      ...carried,
      allowlist: JSON.stringify(proposed.map((e) => ({ ...e, reason: 'body moved to tag' }))),
    });
    const approved = (await prepare(reviewed)).data!.plan;
    expect(approved.blockers).toEqual([]);
    expect(approved.schemaImpact).toMatchObject({ destructive: true, allowlisted: true });
    const applied = await apply(reviewed, V3);
    expect(applied.ok, JSON.stringify(applied.errors)).toBe(true);
    await expectLedgerAgrees(3);
    armsRan += 1;
  }, 180_000);

  it('refuses a delta, a from-digest or a to-digest the target does not regenerate', async () => {
    const carried = await packed(V3, V4);
    const tampered = await bundle(V4, {
      ...carried,
      delta: carried.delta.replace('"note" text', '"note" varchar(10)'),
    });
    expect((await prepare(tampered)).data!.plan.blockers.map((b) => b.code)).toContain(
      'RAY_MIGRATION_MISMATCH',
    );
    const wrongTo = await bundle(V4, {
      ...carried,
      manifest: { ...carried.manifest, toProductSchemaDigest: 'c'.repeat(64) },
    });
    expect((await prepare(wrongTo)).data!.plan.blockers.map((b) => b.code)).toEqual([
      'RAY_MIGRATION_MISMATCH',
    ]);
    const wrongFrom = await bundle(V4, {
      ...carried,
      manifest: { ...carried.manifest, fromProductSchemaDigest: EMPTY_PRODUCT_SCHEMA_DIGEST },
    });
    expect((await prepare(wrongFrom)).data!.plan.blockers.map((b) => b.code)).toEqual([
      'RAY_MIGRATION_REQUIRED',
    ]);
    // A changed spec with no delta at all, and a delta where the stores did not change.
    const bare = await bundle(V4);
    expect((await prepare(bare)).data!.plan.blockers.map((b) => b.code)).toEqual([
      'RAY_MIGRATION_REQUIRED',
    ]);
    const needless = await bundle(V3, carried);
    expect((await prepare(needless)).data!.plan.blockers.map((b) => b.code)).toEqual([
      'RAY_MIGRATION_MISMATCH',
    ]);
    // Matching bytes and digests pass: the refusals above are about the differences only.
    expect((await prepare(await bundle(V4, carried))).data!.plan.blockers).toEqual([]);
    await expectLedgerAgrees(3);
    armsRan += 1;
  }, 180_000);

  it('refuses drift introduced by hand, in the plan and in the apply step', async () => {
    await sql('ALTER TABLE ledger_notes ADD COLUMN added_by_hand integer');
    const drifted = (await prepare(await bundle(V3))).data!.plan;
    expect(drifted.blockers.map((b) => b.code)).toEqual(['RAY_SCHEMA_DRIFT']);
    expect(drifted.blockers[0]?.message).toContain(
      'column ledger_notes.added_by_hand exists but no applied change added it',
    );
    const deployApply = new DeployApply({ db, migratePlatform: () => applyMigrations(db) });
    const refused = await deployApply
      .productMigration(
        { name: 'more.sql', sql: 'CREATE TABLE "ledger_more" ("id" integer PRIMARY KEY);' },
        { stores: [] },
      )
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(refused).toBeInstanceOf(RuntimeApplyError);
    expect(refused).toMatchObject({ code: 'RAY_SCHEMA_DRIFT' });
    expect(await sql("SELECT to_regclass('public.ledger_more') IS NULL AS absent")).toEqual([
      { absent: true },
    ]);
    await sql('ALTER TABLE ledger_notes DROP COLUMN added_by_hand');
    expect((await prepare(await bundle(V3))).data!.plan.blockers).toEqual([]);
    await expectLedgerAgrees(3);
    armsRan += 1;
  }, 120_000);

  it('keeps the ledger rows as they were written', async () => {
    await expect(sql('DELETE FROM product_migration_ledger')).rejects.toThrow(/append-only/);
    await expect(sql('UPDATE product_migration_ledger SET ddl = ddl')).rejects.toThrow(
      /append-only/,
    );
    await expect(sql('TRUNCATE product_migration_ledger')).rejects.toThrow(/append-only/);
    await expectLedgerAgrees(3);
    armsRan += 1;
  }, 60_000);

  it('never runs the DDL a ledger row records: a hand-written change does not reproduce', async () => {
    // A change applied through the legacy path from a hand-written migration: recorded, not generated.
    await new DeployApply({ db, migratePlatform: () => applyMigrations(db) }).productMigration(
      { name: 'hand-written.sql', sql: 'CREATE TABLE "ledger_side" ("id" integer PRIMARY KEY);' },
      declaredStoresOf(parsed(V3)),
    );
    await expectLedgerAgrees(4);
    const plan = (await prepare(await bundle(V4, await packed(V3, V4)))).data!.plan;
    const drift = plan.blockers.find((b) => b.code === 'RAY_SCHEMA_DRIFT');
    // Had the recorded DDL run on the shadow server, the throwaway database would have reproduced
    // the live schema and there would be no drift.
    expect(drift?.message).toContain('do not reproduce the live product schema');
    armsRan += 1;
  }, 120_000);

  it('never plans or applies on top of a ledger a newer runtime wrote', async () => {
    const live = await readProductSchemaDigest(query);
    await sql(
      `INSERT INTO product_migration_ledger (ledger_format_version, operation_id, migration_name, ddl,
         ddl_sha256, product_schema_before, product_schema_after, schema_after, declared_stores)
       VALUES (2, '${randomUUID()}', 'newer.sql', 'SELECT 1', '${sha256('SELECT 1')}', '${live}',
         '${live}', '{}', '{}')`,
    );
    const plan = (await prepare(await bundle(V3))).data!.plan;
    expect(plan.blockers.map((b) => b.code)).toEqual(['RAY_SCHEMA_DRIFT']);
    expect(plan.blockers[0]?.message).toContain('a newer runtime applied a product change');
    const refused = await new DeployApply({ db, migratePlatform: () => applyMigrations(db) })
      .productMigration(
        { name: 'older.sql', sql: 'CREATE TABLE "ledger_older" ("id" integer PRIMARY KEY);' },
        { stores: [] },
      )
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(refused).toMatchObject({ code: 'RAY_SCHEMA_DRIFT' });
    expect(await sql("SELECT to_regclass('public.ledger_older') IS NULL AS absent")).toEqual([
      { absent: true },
    ]);
    armsRan += 1;
  }, 120_000);
});

// The un-skippable ran-guard: a REQUIRED DB run that silently skipped is a false green.
it('DB-backed arms actually ran when the environment requires them', () => {
  if (dbRequired) expect(armsRan).toBe(8);
  else expect(true).toBe(true);
});
