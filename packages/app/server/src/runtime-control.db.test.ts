/**
 * `inspect()` and `prepare()` of the runtime-control adapter, on GROUND TRUTH against a throwaway
 * database and real `.ray` bundles.
 *
 * WHAT THESE ARMS PROVE. inspect reports the two-part schema head from the live ledger and catalog
 * (null before the first migration), the capabilities this process actually provides, the fence and
 * the environment revision, and nothing that names a host, a port, a user or a path. prepare reads
 * the bundle through the full reader pipeline and the LIVE schema: it computes the target product
 * head in a throwaway database and never in the live one, blocks on drift, on a changed schema head,
 * on a missing binding and on a delta it cannot evaluate, recomputes to the same plan digest from the
 * inputs apply will carry, states an expiry of exactly thirty minutes — and writes nothing to the
 * environment's database. Every envelope validates against the contract's envelope schema.
 *
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run that did not run.
 */
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeBundle } from '@rayspec/bundle';
import {
  type BindingDeclaration,
  CAPABILITIES,
  EMPTY_PRODUCT_SCHEMA_DIGEST,
  isPlanExpired,
  PLAN_LIFETIME_MS,
  type PrepareRequest,
  planDigest,
  type ResultEnvelope,
  schemaValidator,
} from '@rayspec/bundle-contract';
import { type Db, generateProductSql, makeDb } from '@rayspec/db';
import { parseSpec } from '@rayspec/spec';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from './composition-root.js';
import {
  CAPABILITY_MODULES,
  createRuntimeControl,
  type RuntimeControlOptions,
  runtimeVersion,
} from './runtime-control.js';
import { readProductSchemaDigest, runtimePlatformHead } from './schema-head.js';

/** The platform head a fresh chain reaches: the last migration this runtime ships. */
const RUNTIME_HEAD = runtimePlatformHead();

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

const SUITE_DB = `rayspec_runtime_control_${process.pid}`;
const PREPARED_AT = new Date('2026-09-30T08:00:00.400Z');

const SPEC = `version: '1.0'
metadata:
  name: plan-notes
  description: one store for the prepare arms
stores:
  - name: plan_notes
    columns:
      - { name: body, type: text }
api:
  - { method: POST, path: '/plan-notes', action: { kind: store, store: plan_notes, op: create } }
`;

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const validEnvelope = schemaValidator('resultEnvelope');

function expectValidEnvelope(envelope: ResultEnvelope<unknown>): void {
  const ok = validEnvelope(JSON.parse(JSON.stringify(envelope)));
  expect(ok, JSON.stringify(validEnvelope.errors)).toBe(true);
}

describe.skipIf(!baseUrl)('the runtime-control adapter', () => {
  let dbUrl = '';
  let shadowUrl = '';
  let dir = '';
  let db: Db;
  let bundle = '';
  let bundleSha = '';
  let bindingBundle = '';
  let bindingBundleSha = '';
  let signedBundle = '';
  let signedBundleSha = '';
  let signerPublicKey: ReturnType<typeof generateKeyPairSync>['publicKey'];

  async function sql<T = Record<string, unknown>>(text: string): Promise<T[]> {
    const client = postgres(dbUrl, { max: 1 });
    try {
      return (await client.unsafe(text)) as unknown as T[];
    } finally {
      await client.end();
    }
  }

  /** Everything prepare could conceivably have written, read back for a before/after comparison. */
  async function writableFootprint(): Promise<unknown> {
    const [row] = await sql<{
      relations: string | null;
      advisory_locks: number;
      control: boolean;
    }>(`
      SELECT (SELECT string_agg(relname, ',' ORDER BY relname) FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public') AS relations,
             (SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory') AS advisory_locks,
             to_regclass('public.runtime_control_state') IS NOT NULL AS control`);
    if (row?.control !== true) return { ...row, stateRows: null, receipts: null };
    const [counts] = await sql(`
      SELECT (SELECT count(*)::int FROM runtime_control_state) AS state_rows,
             (SELECT count(*)::int FROM runtime_control_receipts) AS receipts`);
    return { ...row, ...counts };
  }

  async function planScratchDatabases(): Promise<number> {
    const client = postgres(withDbName(shadowUrl, 'postgres'), { max: 1 });
    try {
      const rows = (await client.unsafe(
        "SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'rayspec_plan_%'",
      )) as unknown as { n: number }[];
      return rows[0]?.n ?? -1;
    } finally {
      await client.end();
    }
  }

  /** The live schema head, as a caller learns it before it prepares. */
  async function liveHead() {
    return (await adapter().inspect(base())).data?.schemaHead ?? null;
  }

  function adapter(extra: Partial<RuntimeControlOptions> = {}) {
    return createRuntimeControl({ db, now: () => PREPARED_AT, ...extra });
  }

  function base() {
    return {
      contractVersion: '1.0.0-draft.2' as const,
      operationId: randomUUID(),
      actor: 'supervisor:test',
    };
  }

  function prepareRequest(overrides: Partial<PrepareRequest> = {}): PrepareRequest {
    return {
      ...base(),
      bundleSha256: bundleSha,
      bundlePath: bundle,
      bindingRevision: [],
      expectedSchemaHead: null,
      ...overrides,
    };
  }

  async function writeAppBundle(
    name: string,
    bindings: BindingDeclaration[] = [],
    signingKey?: ReturnType<typeof generateKeyPairSync>['privateKey'],
  ): Promise<{ path: string; sha: string }> {
    const path = join(dir, name);
    const written = await writeBundle(
      path,
      {
        manifest: {
          formatVersion: 1,
          kind: 'application',
          application: { id: 'plan-notes', version: '1.0.0' },
          runtime: { version: runtimeVersion() },
          target: { os: 'linux', arch: 'x64', nodeMajor: 22 },
          spec: 'payload/rayspec.yaml',
          requires: ['declarative-api', 'declarative-stores'],
          bindings,
          permissions: { egressHosts: [], execution: 'none' },
        },
        files: [
          { path: 'payload/rayspec.yaml', bytes: Buffer.from(SPEC) },
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
        ],
      },
      signingKey === undefined ? {} : { signingKey },
    );
    if (!written.ok)
      throw new Error(`writing the test bundle failed: ${JSON.stringify(written.errors)}`);
    return { path, sha: written.value.archiveSha256 };
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
    dir = mkdtempSync(join(tmpdir(), 'rayspec-runtime-control-'));
    ({ path: bundle, sha: bundleSha } = await writeAppBundle('notes.ray'));
    ({ path: bindingBundle, sha: bindingBundleSha } = await writeAppBundle('notes-bindings.ray', [
      {
        name: 'APP_WEBHOOK_TOKEN',
        kind: 'secret',
        required: true,
        description: 'The token the application signs its webhooks with.',
      },
    ]));
    const signer = generateKeyPairSync('ed25519');
    signerPublicKey = signer.publicKey;
    ({ path: signedBundle, sha: signedBundleSha } = await writeAppBundle(
      'notes-signed.ray',
      [],
      signer.privateKey,
    ));
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

  it('inspect on an empty database: no schema head, a fresh environment, no topology', async () => {
    const request = base();
    const result = await adapter().inspect(request);
    expectValidEnvelope(result);
    expect(result.ok).toBe(true);
    expect(result.operation).toBe('runtime.inspect');
    expect(result.operationId).toBe(request.operationId);
    const data = result.data!;
    expect(data.schemaHead).toBeNull();
    expect(data.fence).toEqual({ state: 'open', fenceEpoch: 0 });
    expect(data.environmentRevision).toBe(1);
    expect(data.runtimeVersion).toBe(runtimeVersion());
    expect(data.contractVersion).toBe('1.0.0-draft.2');
    expect(data.target).toEqual({
      os: process.platform,
      arch: process.arch,
      nodeMajor: Number(process.versions.node.split('.')[0]),
    });
    expect(data.executionLevels).toEqual(['none', 'in-process']);
    expect(data.applicationId).toBeNull();
    expect(data.releaseManifestSha256).toBeNull();
    expect(data.managedPosture).toEqual({ supported: false, receiptSha256: null });
    // Every available id resolves in this process; a planned one is never reported.
    const available = CAPABILITIES.filter((c) => c.status === 'available').map((c) => c.id);
    expect(data.capabilities).toEqual(available);
    expect(data.capabilities).not.toContain('extraction-deterministic');
    // No secret and no topology: nothing of the connection string, and no path.
    const text = JSON.stringify(result);
    const url = new URL(dbUrl);
    for (const leak of [url.hostname, url.port, url.username, url.password, SUITE_DB, dir, '/']) {
      if (leak === '/') expect(text).not.toMatch(/"\/[A-Za-z]/);
      else expect(text).not.toContain(leak);
    }
    // inspect is read-only: nothing exists afterwards that did not exist before.
    expect(
      await sql("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'"),
    ).toEqual([{ n: 0 }]);
    armsRan += 1;
  }, 60_000);

  it('inspect reports only the capabilities whose module resolves in this process', async () => {
    const without = await adapter({
      resolvesModule: (specifier) => specifier !== '@rayspec/adapter-codex',
    }).inspect(base());
    expect(without.data?.capabilities).not.toContain('agent-backend-codex');
    expect(without.data?.capabilities).toContain('agent-backend-openai');
    // Every id the vocabulary marks available has a module that provides it.
    for (const c of CAPABILITIES.filter((x) => x.status === 'available')) {
      expect(CAPABILITY_MODULES[c.id], c.id).toBeDefined();
    }
    armsRan += 1;
  }, 60_000);

  it('refuses a malformed request with RAY_USAGE and a fresh operation id', async () => {
    const inspected = await adapter().inspect({ ...base(), operationId: 'nope' });
    expectValidEnvelope(inspected);
    expect(inspected.ok).toBe(false);
    expect(inspected.errors[0]).toMatchObject({ code: 'RAY_USAGE', path: '/operationId' });
    expect(inspected.operationId).toMatch(/^[0-9a-f-]{36}$/);
    const prepared = await adapter().prepare(prepareRequest({ bundlePath: 'relative.ray' }));
    expectValidEnvelope(prepared);
    expect(prepared.errors[0]).toMatchObject({ code: 'RAY_USAGE', path: '/bundlePath' });
    armsRan += 1;
  }, 60_000);

  it('prepare on an empty database computes the target head in a throwaway database', async () => {
    const before = await writableFootprint();
    const result = await adapter({ shadowDatabaseUrl: shadowUrl }).prepare(prepareRequest());
    expectValidEnvelope(result);
    expect(result.ok).toBe(true);
    const { plan } = result.data!;
    expect(plan.blockers).toEqual([]);
    expect(plan.schemaImpact.from).toBeNull();
    expect(plan.schemaImpact.to.platform).toBe(RUNTIME_HEAD);
    expect(plan.schemaImpact.to.product).not.toBe(EMPTY_PRODUCT_SCHEMA_DIGEST);
    expect(await writableFootprint()).toEqual(before);
    expect(await planScratchDatabases()).toBe(0);
    armsRan += 1;
  }, 120_000);

  it('after the platform chain: inspect reports the two-part head', async () => {
    await applyMigrations(db);
    const result = await adapter().inspect(base());
    expectValidEnvelope(result);
    expect(result.data?.schemaHead).toEqual({
      platform: RUNTIME_HEAD,
      product: EMPTY_PRODUCT_SCHEMA_DIGEST,
    });
    armsRan += 1;
  }, 60_000);

  it('prepare without a shadow database: a plan with a delta, blocked, stored nowhere', async () => {
    const before = await writableFootprint();
    const request = prepareRequest({
      expectedSchemaHead: {
        platform: RUNTIME_HEAD,
        product: EMPTY_PRODUCT_SCHEMA_DIGEST,
      },
    });
    const result = await adapter().prepare(request);
    expectValidEnvelope(result);
    expect(result.ok).toBe(true);
    expect(result.operationId).toBe(request.operationId);
    const data = result.data!;
    const { plan } = data;
    expect(plan.blockers.map((b) => b.code)).toEqual(['RAY_MIGRATION_REQUIRED']);
    const stores = (parseSpec(SPEC) as { ok: true; value: { stores: never[] } }).value.stores;
    expect(plan.schemaImpact).toEqual({
      from: { platform: RUNTIME_HEAD, product: EMPTY_PRODUCT_SCHEMA_DIGEST },
      to: { platform: RUNTIME_HEAD, product: EMPTY_PRODUCT_SCHEMA_DIGEST },
      productDeltaSha256: sha256(generateProductSql(stores)),
      destructive: false,
      allowlisted: false,
    });
    expect(plan.warnings.map((w) => w.code)).toEqual([
      'RAY_W_UNSIGNED',
      'RAY_W_PRODUCT_SCHEMA_UNLEDGERED',
    ]);
    expect(plan.permissionChanges).toEqual({
      executionFrom: null,
      executionTo: 'none',
      egressAdded: [],
      egressRemoved: [],
      capabilitiesAdded: ['declarative-api', 'declarative-stores'],
      capabilitiesRemoved: [],
    });
    expect(plan.storageRequirements.bundleBytes).toBe(statSync(bundle).size);
    expect(plan.applicationId).toBe('plan-notes');

    // The expiry is exactly thirty minutes after preparedAt, and the plan expires then.
    expect(data.preparedAt).toBe('2026-09-30T08:00:00Z');
    expect(data.expiresAt).toBe('2026-09-30T08:30:00Z');
    expect(isPlanExpired(data.preparedAt, new Date(Date.parse(data.expiresAt) - 1))).toBe(false);
    expect(
      isPlanExpired(data.preparedAt, new Date(Date.parse(data.preparedAt) + PLAN_LIFETIME_MS)),
    ).toBe(true);
    // apply recomputes the digest from the inputs it carries again, and gets the same one.
    expect(data.environmentRevision).toBe(1);
    expect(
      planDigest({
        bundleSha256: bundleSha,
        releaseManifestSha256: null,
        schemaHeadFrom: plan.schemaImpact.from,
        schemaHeadTo: plan.schemaImpact.to,
        productDeltaSha256: plan.schemaImpact.productDeltaSha256,
        bindingRevisions: [],
        grants: {
          execution: 'none',
          egressHosts: [],
          capabilities: ['declarative-api', 'declarative-stores'],
        },
        environmentRevision: 1,
        preparedAt: data.preparedAt,
      }),
    ).toBe(data.planDigest);
    // prepare stores no plan and writes nothing: no state row, no receipt, no table, no lock.
    expect(await writableFootprint()).toEqual(before);
    armsRan += 1;
  }, 60_000);

  it('prepare with a shadow database predicts the head the delta really produces', async () => {
    const result = await adapter({ shadowDatabaseUrl: shadowUrl }).prepare(
      prepareRequest({ expectedSchemaHead: await liveHead() }),
    );
    expectValidEnvelope(result);
    const { plan } = result.data!;
    expect(plan.blockers).toEqual([]);
    expect(await planScratchDatabases()).toBe(0);
    const predicted = plan.schemaImpact.to.product;
    expect(predicted).not.toBe(EMPTY_PRODUCT_SCHEMA_DIGEST);
    // Now run the same delta for real against the live database, as apply will.
    const stores = (parseSpec(SPEC) as { ok: true; value: { stores: never[] } }).value.stores;
    await db.$client.begin(async (tx) => {
      await tx.unsafe(generateProductSql(stores).replace(/-->\s*statement-breakpoint/g, ''));
    });
    const query = async (text: string, params: unknown[] = []) =>
      (await db.$client.unsafe(text, params as never[])) as unknown as Record<string, unknown>[];
    expect(await readProductSchemaDigest(query)).toBe(predicted);
    armsRan += 1;
  }, 120_000);

  it('once materialized: no delta, the head unchanged, and a changed head blocks a stale plan', async () => {
    const live = (await adapter().inspect(base())).data!.schemaHead!;
    const result = await adapter().prepare(prepareRequest({ expectedSchemaHead: live }));
    expectValidEnvelope(result);
    const { plan } = result.data!;
    expect(plan.blockers).toEqual([]);
    expect(plan.schemaImpact).toMatchObject({ from: live, to: live, productDeltaSha256: null });

    // The head the caller last saw is no longer the live one: the plan would be stale.
    const stale = await adapter().prepare(
      prepareRequest({
        expectedSchemaHead: {
          platform: RUNTIME_HEAD,
          product: EMPTY_PRODUCT_SCHEMA_DIGEST,
        },
      }),
    );
    expect(stale.data!.plan.blockers.map((b) => [b.code, b.path])).toEqual([
      ['RAY_PLAN_STALE', '/expectedSchemaHead'],
    ]);
    armsRan += 1;
  }, 60_000);

  it('prepare detects drift in the live schema, and a changed head, as blockers', async () => {
    const before = (await liveHead())!;
    // A column the spec declares as text, changed by hand.
    await sql('ALTER TABLE plan_notes ALTER COLUMN body TYPE varchar(64)');
    const after = (await liveHead())!;
    expect(after.product).not.toBe(before.product);

    const drifted = await adapter().prepare(prepareRequest({ expectedSchemaHead: before }));
    expectValidEnvelope(drifted);
    expect(drifted.ok).toBe(true);
    expect(drifted.data!.plan.blockers.map((b) => b.code)).toEqual([
      'RAY_PLAN_STALE',
      'RAY_SCHEMA_DRIFT',
    ]);
    // When that live shape is the one the last apply recorded, the gap is a delta to review.
    await sql(
      `INSERT INTO runtime_control_state (id, binding_revision_key, applied_product_schema)
       VALUES (1, '${'0'.repeat(64)}', '${after.product}')`,
    );
    const recorded = await adapter().prepare(prepareRequest({ expectedSchemaHead: after }));
    expect(recorded.data!.plan.blockers.map((b) => b.code)).toEqual(['RAY_MIGRATION_REQUIRED']);
    await sql('ALTER TABLE plan_notes ALTER COLUMN body TYPE text');

    // The spec matches again. Recorded as applied, a column added by hand is drift even though every
    // declared store still matches: the head moved outside apply.
    const matching = (await liveHead())!;
    await sql(`UPDATE runtime_control_state SET applied_product_schema = '${matching.product}'`);
    expect(
      (await adapter().prepare(prepareRequest({ expectedSchemaHead: matching }))).data!.plan
        .blockers,
    ).toEqual([]);
    await sql('ALTER TABLE plan_notes ADD COLUMN edited_by_hand text');
    const added = await adapter().prepare(prepareRequest({ expectedSchemaHead: await liveHead() }));
    expect(added.data!.plan.blockers.map((b) => b.code)).toEqual(['RAY_SCHEMA_DRIFT']);
    await sql('ALTER TABLE plan_notes DROP COLUMN edited_by_hand');
    armsRan += 1;
  }, 60_000);

  it('the plan carries binding satisfaction and the grants the active application holds', async () => {
    await sql(`UPDATE runtime_control_state
                  SET active_grants = '{"execution":"none","egressHosts":[],"capabilities":["declarative-api","static-frontend"]}'::jsonb,
                      application_id = 'plan-notes', application_version = '0.9.0',
                      application_digest = '${'e'.repeat(64)}', environment_revision = 4`);
    const head = await liveHead();
    const missing = await adapter().prepare(
      prepareRequest({
        bundlePath: bindingBundle,
        bundleSha256: bindingBundleSha,
        expectedSchemaHead: head,
      }),
    );
    expectValidEnvelope(missing);
    const plan = missing.data!.plan;
    expect(plan.requiredBindings).toEqual([
      { name: 'APP_WEBHOOK_TOKEN', kind: 'secret', required: true, satisfied: false },
    ]);
    expect(plan.blockers.map((b) => [b.code, b.path])).toEqual([
      ['RAY_BINDING_MISSING', '/bindings/0'],
    ]);
    expect(plan.permissionChanges).toMatchObject({
      executionFrom: 'none',
      capabilitiesAdded: ['declarative-stores'],
      capabilitiesRemoved: ['static-frontend'],
    });
    expect(missing.data!.environmentRevision).toBe(4);

    const supplied = await adapter().prepare(
      prepareRequest({
        bundlePath: bindingBundle,
        bundleSha256: bindingBundleSha,
        bindingRevision: [{ name: 'APP_WEBHOOK_TOKEN', revisionId: 'rev-1' }],
        expectedSchemaHead: head,
      }),
    );
    expect(supplied.data!.plan.requiredBindings[0]?.satisfied).toBe(true);
    expect(supplied.data!.plan.blockers).toEqual([]);
    const rotated = await adapter().prepare(
      prepareRequest({
        bundlePath: bindingBundle,
        bundleSha256: bindingBundleSha,
        bindingRevision: [{ name: 'APP_WEBHOOK_TOKEN', revisionId: 'rev-2' }],
        expectedSchemaHead: head,
      }),
    );
    // A rotated secret is a different plan; the value itself appears nowhere.
    expect(rotated.data!.planDigest).not.toBe(supplied.data!.planDigest);

    const inspected = await adapter().inspect(base());
    expect(inspected.data).toMatchObject({
      applicationId: 'plan-notes',
      applicationVersion: '0.9.0',
      applicationDigest: 'e'.repeat(64),
      environmentRevision: 4,
    });
    armsRan += 1;
  }, 60_000);

  it('prepare refuses the wrong bytes, a linked path and an untrusted signature', async () => {
    const mismatch = await adapter().prepare(prepareRequest({ bundleSha256: 'f'.repeat(64) }));
    expectValidEnvelope(mismatch);
    expect(mismatch.ok).toBe(false);
    expect(mismatch.errors[0]).toMatchObject({
      code: 'RAY_DIGEST_MISMATCH',
      reason: 'bundle-sha256',
    });

    const linked = join(dir, 'linked.ray');
    symlinkSync(bundle, linked);
    const viaLink = await adapter().prepare(prepareRequest({ bundlePath: linked }));
    expect(viaLink.errors[0]).toMatchObject({ code: 'RAY_USAGE' });

    const untrusted = await adapter().prepare(
      prepareRequest({ bundlePath: signedBundle, bundleSha256: signedBundleSha }),
    );
    expect(untrusted.ok).toBe(false);
    expect(untrusted.errors[0]).toMatchObject({
      code: 'RAY_SIGNATURE_INVALID',
      reason: 'untrusted-key',
    });
    const trusted = await adapter({ trustedKeys: [signerPublicKey] }).prepare(
      prepareRequest({ bundlePath: signedBundle, bundleSha256: signedBundleSha }),
    );
    expect(trusted.ok).toBe(true);
    expect(trusted.data!.plan.warnings.map((w) => w.code)).not.toContain('RAY_W_UNSIGNED');
    armsRan += 1;
  }, 60_000);

  it('a ledger newer than this runtime is drift for inspect and a blocker for prepare', async () => {
    await sql(
      "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('from-a-newer-runtime', 9999999999999)",
    );
    const inspected = await adapter().inspect(base());
    expectValidEnvelope(inspected);
    expect(inspected.ok).toBe(false);
    expect(inspected.errors[0]?.code).toBe('RAY_SCHEMA_DRIFT');
    const prepared = await adapter().prepare(prepareRequest());
    expect(prepared.data!.plan.blockers.map((b) => b.code)).toContain('RAY_SCHEMA_DRIFT');
    expect(prepared.data!.plan.schemaImpact.from).toBeNull();
    armsRan += 1;
  }, 60_000);
});

// The un-skippable ran-guard: a REQUIRED DB run that silently skipped is a false green.
it('DB-backed arms actually ran when the environment requires them', () => {
  if (dbRequired) expect(armsRan).toBe(12);
  else expect(true).toBe(true);
});
