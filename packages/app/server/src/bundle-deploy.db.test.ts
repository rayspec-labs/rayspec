/**
 * `applyBundle` on GROUND TRUTH: a real `.ray` bundle, a real state directory and a real database.
 *
 * WHAT THESE ARMS PROVE, on one environment:
 *  - a plan past its lifetime is refused before the apply reads or writes the database;
 *  - a plan that expires while the apply runs is refused by the apply itself: the product schema, the
 *    ledger and the active version stay as they were;
 *  - a plan that is valid applies: the product schema, its ledger row and the active version;
 *  - a state directory whose deployment id is not the one the database records is refused, and
 *    neither the database nor the active version changes.
 *
 * Skips without DATABASE_URL; the un-skippable ran-guard hard-fails a REQUIRED run that did not run.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeBundle } from '@rayspec/bundle';
import {
  CONTRACT_VERSION,
  formatTimestamp,
  PLAN_LIFETIME_MS,
  type PrepareData,
} from '@rayspec/bundle-contract';
import { type Db, makeDb } from '@rayspec/db';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyBundle,
  bindingRevisions,
  initialBindingRevisionKey,
  liveSchemaHead,
} from './bundle-deploy.js';
import { applyMigrations } from './composition-root.js';
import { openStateDirectory, type StateDirectory } from './deployment-state.js';
import { preparePlan, type ReadApplicationBundle, runtimeVersion } from './runtime-control.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

const SUITE_DB = `rayspec_bundle_apply_${process.pid}`;
const PREPARED_AT = new Date('2026-09-30T08:00:00.000Z');
/** Inside the plan's lifetime, and past it. */
const VALID = new Date(PREPARED_AT.getTime() + 60_000);
const EXPIRED = new Date(PREPARED_AT.getTime() + PLAN_LIFETIME_MS + 1);
const PEPPER = 'bundle-apply-suite-pepper';
const DEPLOYMENT = '0123456789abcdef';

const SPEC = `version: '1.0'
metadata:
  name: apply-notes
  description: one store the apply creates
stores:
  - name: apply_notes
    columns:
      - { name: body, type: text }
api:
  - { method: POST, path: '/apply-notes', action: { kind: store, store: apply_notes, op: create } }
`;

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

describe.skipIf(!baseUrl)('applyBundle', () => {
  let dbUrl = '';
  let shadowUrl = '';
  let dir = '';
  let db: Db;
  let stateDir: StateDirectory;
  let bundlePath = '';
  let bundleSha = '';
  let planDigest = '';

  async function sql<T = Record<string, unknown>>(text: string): Promise<T[]> {
    return (await db.$client.unsafe(text)) as unknown as T[];
  }

  async function productTable(): Promise<string | null> {
    const rows = await sql<{ t: string | null }>(
      "SELECT to_regclass('public.apply_notes')::text AS t",
    );
    return rows[0]?.t ?? null;
  }

  async function ledgerRows(): Promise<number> {
    const present = await sql<{ t: string | null }>(
      "SELECT to_regclass('public.product_migration_ledger')::text AS t",
    );
    if (present[0]?.t === null) return 0;
    return (await sql<{ n: number }>('SELECT count(*)::int AS n FROM product_migration_ledger'))[0]!
      .n;
  }

  /** Apply the prepared plan with `now` answering each call from `times`, the last one repeated. */
  function apply(times: Date[], deploymentId = DEPLOYMENT, over: { db?: Db } = {}) {
    let call = 0;
    return applyBundle({
      db: over.db ?? db,
      runtime: { shadowDatabaseUrl: shadowUrl },
      bundlePath,
      bundleSha256: bundleSha,
      planDigest,
      preparedAt: formatTimestamp(PREPARED_AT),
      bindingValues: new Map(),
      initialBindingRevisionKey: initialBindingRevisionKey(PEPPER),
      stateDir,
      deploymentId,
      migratePlatform: () => applyMigrations(db),
      operationId: randomUUID(),
      now: () => times[Math.min(call++, times.length - 1)]!,
    });
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
    dir = mkdtempSync(join(tmpdir(), 'rayspec-bundle-apply-'));
    bundlePath = join(dir, 'apply-notes.ray');
    const written = await writeBundle(bundlePath, {
      manifest: {
        formatVersion: 1,
        kind: 'application',
        application: { id: 'apply-notes', version: '1.0.0' },
        runtime: { version: runtimeVersion() },
        target: { os: 'linux', arch: 'x64', nodeMajor: 22 },
        spec: 'payload/rayspec.yaml',
        requires: ['declarative-api', 'declarative-stores'],
        bindings: [],
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
    });
    if (!written.ok) throw new Error(JSON.stringify(written.errors));
    bundleSha = written.value.archiveSha256;

    const stateRoot = join(dir, 'state');
    const opened = await openStateDirectory(stateRoot, { create: true });
    if (opened === null) throw new Error('the state directory was not created');
    stateDir = opened;
    await stateDir.createDeployment({
      deploymentFormatVersion: 1,
      deploymentId: DEPLOYMENT,
      createdAt: formatTimestamp(PREPARED_AT),
      applicationId: 'apply-notes',
    });

    const prepared = await prepare();
    await stateDir.stageVersion(
      bundlePath,
      bundleSha,
      (prepared.bundle as ReadApplicationBundle).manifest,
    );
  }, 180_000);

  /** Prepare the plan as the dry-run does, on the live database at PREPARED_AT. */
  async function prepare() {
    const prepared = await preparePlan(
      {
        contractVersion: CONTRACT_VERSION,
        operationId: randomUUID(),
        actor: 'supervisor:test',
        bundleSha256: bundleSha,
        bundlePath,
        bindingRevision: bindingRevisions(new Map(), initialBindingRevisionKey(PEPPER)),
        expectedSchemaHead: await liveSchemaHead(db),
      },
      { db, shadowDatabaseUrl: shadowUrl },
      { preparedAt: formatTimestamp(PREPARED_AT) },
    );
    expect(prepared.envelope.ok, JSON.stringify(prepared.envelope.errors)).toBe(true);
    planDigest = (prepared.envelope.data as PrepareData).planDigest;
    return prepared;
  }

  afterAll(async () => {
    await db?.$client.end().catch(() => {});
    if (dir !== '') {
      // Version directories are read-only; make them removable.
      const writable = (path: string): void => {
        chmodSync(path, statSync(path).isDirectory() ? 0o700 : 0o600);
        if (statSync(path).isDirectory()) {
          for (const entry of readdirSync(path)) writable(join(path, entry));
        }
      };
      writable(dir);
      rmSync(dir, { recursive: true, force: true });
    }
    if (!baseUrl) return;
    const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('refuses a plan past its lifetime before it reads or writes the database', async () => {
    // A database handle that fails any use: the refusal must come first.
    const untouchable = {
      $client: {
        unsafe: () => {
          throw new Error('the database was used');
        },
        begin: () => {
          throw new Error('the database was used');
        },
      },
    } as unknown as Db;
    const refused = await apply([EXPIRED], DEPLOYMENT, { db: untouchable });
    expect(refused.envelope.ok).toBe(false);
    expect(refused.envelope.errors[0]).toMatchObject({
      code: 'RAY_PLAN_STALE',
      message: 'the plan has expired; prepare a new plan',
    });
    expect(await stateDir.readActive()).toBeNull();
    armsRan += 1;
  });

  it('refuses a plan that expires while the apply runs, changing no product schema', async () => {
    // Valid when the apply starts, expired by the time the apply checks the plan's freshness.
    const refused = await apply([VALID, EXPIRED]);
    expect(refused.envelope.ok).toBe(false);
    expect(refused.envelope.errors[0]).toMatchObject({
      code: 'RAY_PLAN_STALE',
      message: 'the plan has expired; prepare a new plan',
    });
    expect(await productTable()).toBeNull();
    expect(await ledgerRows()).toBe(0);
    expect(await stateDir.readActive()).toBeNull();
    armsRan += 1;
  }, 120_000);

  it('applies a plan while it is valid', async () => {
    // The refused apply above created the runtime-control tables, so the plan is prepared again.
    await prepare();
    const applied = await apply([VALID]);
    expect(applied.envelope.ok, JSON.stringify(applied.envelope.errors)).toBe(true);
    expect(applied.productLedgerRow).toBe(1);
    expect(await productTable()).toBe('apply_notes');
    expect(await ledgerRows()).toBe(1);
    expect((await stateDir.readActive())?.bundleSha256).toBe(bundleSha);
    const state = await sql<{ deployment_id: string }>(
      'SELECT deployment_id FROM runtime_control_state WHERE id = 1',
    );
    expect(state[0]?.deployment_id).toBe(DEPLOYMENT);
    armsRan += 1;
  }, 120_000);

  it('refuses a state directory of another deployment, changing nothing', async () => {
    const before = await sql<{ r: number }>(
      'SELECT environment_revision::int AS r FROM runtime_control_state WHERE id = 1',
    );
    const active = await stateDir.readActive();
    const refused = await apply([VALID], 'fedcba9876543210');
    expect(refused.envelope.ok).toBe(false);
    expect(refused.envelope.errors[0]?.code).toBe('RAY_USAGE');
    expect(refused.envelope.errors[0]?.message).toContain('belongs to another deployment');
    expect(
      await sql('SELECT environment_revision::int AS r FROM runtime_control_state WHERE id = 1'),
    ).toEqual(before);
    expect(await stateDir.readActive()).toEqual(active);
    expect(await ledgerRows()).toBe(1);
    armsRan += 1;
  }, 120_000);
});

// The un-skippable ran-guard: a REQUIRED DB run that silently skipped is a false green.
it('DB-backed arms actually ran when the environment requires them', () => {
  if (dbRequired) expect(armsRan).toBe(4);
  else expect(true).toBe(true);
});
