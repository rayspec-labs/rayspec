/**
 * `rayspec pack --against` on GROUND TRUTH: the bundle pack writes is prepared by a real runtime
 * against a real environment, and the delta and digests pack computed are exactly the ones the target
 * regenerates.
 *
 *  - The environment is materialized from the previous spec by the legacy deploy path, which records
 *    it in the product migration ledger.
 *  - An additive change packed `--against` that spec plans with no blocker: the target regenerates
 *    the same delta, from the same product schema digest, to the same one; applied, the ledger and the
 *    live schema agree.
 *  - A destructive change packs only with a reviewed allowlist, carries it, says `destructive`, and
 *    plans with no blocker on the target.
 *  - A bundle packed against a spec the environment does not run is refused by the target.
 *
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run that did not run.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { inspectBundle } from '@rayspec/bundle';
import { parseBundleSpec } from '@rayspec/bundle-closure';
import { CONTRACT_VERSION } from '@rayspec/bundle-contract';
import { generateProductSql } from '@rayspec/db';
import { type Db, makeDb } from '@rayspec/db/testing';
import {
  applyMigrations,
  BUNDLED_DELTA_NAME,
  createRuntimeControl,
  DeployApply,
  declaredStoresOf,
  productDdlStep,
  readProductLedger,
  readProductSchemaDigest,
  runApply,
  schemaObservers,
} from '@rayspec/server';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backendSpec,
  removeTemporaryDirectories,
  temporaryDirectory,
  writeTree,
} from '../../../kernel/bundle-closure/src/test-support/app.js';
import { runPack } from './pack.js';
import { CLI_VERSION } from './test-support/bundles.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

const SUITE_DB = `rayspec_pack_against_${process.pid}`;
const PREPARED_AT = new Date();

const stores = (columns: string) =>
  backendSpec(
    `stores:\n  - name: packed_notes\n    columns:\n${columns}\n` +
      "api:\n  - { method: POST, path: '/notes', action: { kind: store, store: packed_notes, op: create } }\n",
  );
const V1 = stores('      - { name: body, type: text }');
const V2 = stores(
  '      - { name: body, type: text }\n      - { name: tag, type: text, nullable: true }',
);
const V3 = stores('      - { name: tag, type: text, nullable: true }');

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

describe.skipIf(!baseUrl)('pack --against, prepared by the target', () => {
  let db: Db;
  let shadowUrl = '';

  const query = async (text: string, params: unknown[] = []) =>
    (await db.$client.unsafe(text, params as never[])) as unknown as Record<string, unknown>[];

  async function pack(next: string, previous: string, allowlist?: string) {
    const root = temporaryDirectory('pack-against-db-');
    writeTree(root, {
      'rayspec.yaml': next,
      'previous.yaml': previous,
      ...(allowlist === undefined ? {} : { 'allow.json': allowlist }),
    });
    const output = join(temporaryDirectory('pack-against-out-'), 'app.ray');
    const outcome = await runPack(
      [
        '--spec',
        join(root, 'rayspec.yaml'),
        '--output',
        output,
        '--against',
        join(root, 'previous.yaml'),
        ...(allowlist === undefined ? [] : ['--allowlist', join(root, 'allow.json')]),
      ],
      {
        operationId: randomUUID(),
        cliVersion: CLI_VERSION,
        env: { SHADOW_DATABASE_URL: shadowUrl },
      },
    );
    expect(outcome.envelope.ok, JSON.stringify(outcome.envelope.errors)).toBe(true);
    const data = outcome.envelope.data as { sha256: string };
    const read = await inspectBundle(output, { captureProductMigration: true });
    if (!read.ok) throw new Error(JSON.stringify(read.errors));
    return { path: output, sha: data.sha256, manifest: read.value.manifest, read: read.value };
  }

  async function prepare(bundle: { path: string; sha: string }) {
    const control = createRuntimeControl({
      db,
      shadowDatabaseUrl: shadowUrl,
      // Every capability the bundles require resolves; the plan is prepared at one fixed time, so
      // the apply's recomputed digest is the one prepared.
      resolvesModule: () => true,
      now: () => PREPARED_AT,
    });
    const head = (
      await control.inspect({
        contractVersion: CONTRACT_VERSION,
        operationId: randomUUID(),
        actor: 'test',
      })
    ).data?.schemaHead;
    const result = await control.prepare({
      contractVersion: CONTRACT_VERSION,
      operationId: randomUUID(),
      actor: 'test',
      bundleSha256: bundle.sha,
      bundlePath: bundle.path,
      bindingRevision: [],
      expectedSchemaHead: head ?? null,
    });
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    return { control, data: result.data! };
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    shadowUrl = process.env.SHADOW_DATABASE_URL ?? baseUrl;
    const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }
    db = makeDb(withDbName(baseUrl, SUITE_DB));
    await applyMigrations(db);
    // The environment runs V1, deployed through the legacy path.
    const parsed = parseBundleSpec(Buffer.from(V1));
    if (!parsed.ok) throw new Error('V1 does not parse');
    const declared = declaredStoresOf(parsed.value);
    await new DeployApply({ db, migratePlatform: () => applyMigrations(db) }).productMigration(
      { name: '0000_product_stores.sql', sql: generateProductSql(declared.stores) },
      declared,
    );
  }, 120_000);

  afterAll(async () => {
    removeTemporaryDirectories();
    await db?.$client.end().catch(() => {});
    if (!baseUrl) return;
    const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('carries the delta and the digests the target regenerates, and applies them', async () => {
    const bundle = await pack(V2, V1);
    const migration =
      bundle.manifest.kind === 'application' ? bundle.manifest.productMigration : undefined;
    expect(migration).toMatchObject({
      deltaPath: 'payload/migrations/product-delta.sql',
      destructive: false,
    });
    expect(migration?.fromProductSchemaDigest).toBe(await readProductSchemaDigest(query));
    const { data } = await prepare(bundle);
    expect(data.plan.blockers).toEqual([]);
    expect(data.plan.schemaImpact.to.product).toBe(migration?.toProductSchemaDigest);

    const parsed = parseBundleSpec(Buffer.from(V2));
    if (!parsed.ok) throw new Error('V2 does not parse');
    const applied = await runApply({
      db,
      request: {
        contractVersion: CONTRACT_VERSION,
        operationId: randomUUID(),
        actor: 'test',
        planDigest: data.planDigest,
        expectedEnvironmentRevision: data.environmentRevision,
        idempotencyKey: randomUUID().replaceAll('-', ''),
      },
      plan: { recompute: async () => (await prepare(bundle)).data.planDigest },
      observers: schemaObservers(query),
      steps: [
        productDdlStep({
          name: BUNDLED_DELTA_NAME,
          sql: bundle.read.productMigrationFiles!.delta.toString('utf8'),
          declared: declaredStoresOf(parsed.value),
          expectedAfter: data.plan.schemaImpact.to.product,
        }),
      ],
    });
    expect(applied.ok, JSON.stringify(applied.errors)).toBe(true);
    const ledger = await readProductLedger(query);
    expect(ledger.state === 'ledgered' && ledger.rows.length).toBe(2);
    expect(ledger.state === 'ledgered' && ledger.head.productSchemaAfter).toBe(
      migration?.toProductSchemaDigest,
    );
    expect(await readProductSchemaDigest(query)).toBe(migration?.toProductSchemaDigest);
    armsRan += 1;
  }, 180_000);

  it('carries a reviewed destructive delta with its allowlist, and the target accepts it', async () => {
    const allowlist = JSON.stringify([
      {
        kind: 'drop-column',
        match: 'ALTER TABLE "packed_notes" DROP COLUMN "body"',
        reason: 'the body moved to tag',
      },
    ]);
    const bundle = await pack(V3, V2, allowlist);
    const migration =
      bundle.manifest.kind === 'application' ? bundle.manifest.productMigration : undefined;
    expect(migration).toMatchObject({
      allowlistPath: 'payload/migrations/product-allowlist.json',
      destructive: true,
    });
    expect(bundle.read.productMigrationFiles?.allowlist?.toString('utf8')).toBe(allowlist);
    const { data } = await prepare(bundle);
    expect(data.plan.blockers).toEqual([]);
    expect(data.plan.schemaImpact).toMatchObject({ destructive: true, allowlisted: true });
    armsRan += 1;
  }, 180_000);

  it('is refused by a target that does not run the spec it was packed against', async () => {
    // Packed against V1, but the environment now runs V2.
    const stale = await pack(
      V3,
      V1,
      JSON.stringify([
        {
          kind: 'drop-column',
          match: 'ALTER TABLE "packed_notes" DROP COLUMN "body"',
          reason: 'the body moved to tag',
        },
      ]),
    );
    const { data } = await prepare(stale);
    const codes = data.plan.blockers.map((b) => b.code);
    // It migrates from the V1 digest, and its delta also adds the column V2 already has.
    expect(codes).toContain('RAY_MIGRATION_REQUIRED');
    expect(codes).toContain('RAY_MIGRATION_MISMATCH');
    armsRan += 1;
  }, 180_000);
});

// The un-skippable ran-guard: a REQUIRED DB run that silently skipped is a false green.
it('DB-backed arms actually ran when the environment requires them', () => {
  if (dbRequired) expect(armsRan).toBe(3);
  else expect(true).toBe(true);
});
