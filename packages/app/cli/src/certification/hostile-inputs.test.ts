/**
 * Hostile archives and hostile migration bundles, end to end through the real built CLI, against an
 * environment in the hardened posture (test-support/posture-deployment.ts).
 *
 *  1. Every hostile application archive of the contract's corpus is handed to `rayspec deploy
 *     <file.ray> --dry-run` against the serving deployment's own state directory and databases. Each
 *     is refused with the code the contract states for it, before anything is extracted: the active
 *     version, the version directories, the plan records, the temporary directory and the database
 *     are as they were, and the deployment keeps serving.
 *  2. The contract's hostile migration bundles — built from a real export of that deployment and
 *     changed one property at a time, with every other digest and inventory consistent — are handed
 *     to `rayspec import --dry-run` against an empty target with roles of its own. Each is refused
 *     with the code the contract states, and nothing reaches the target.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { writeBundle } from '@rayspec/bundle';
import {
  canonicalJsonFile,
  MIGRATION_CIPHERTEXT_PATH,
  SNAPSHOT_ROOT_NAME,
  schemaValidator,
} from '@rayspec/bundle-contract';
import type { RuntimeRoleLane } from '@rayspec/db/testing';
import { writeMigrationBundle } from '@rayspec/server';
import { Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from '../../../../kernel/bundle-closure/src/test-support/app.js';
import {
  CLI_DIST,
  CONTRACT_ROOT,
  type CorpusCase,
  casePath,
  loadExpectations,
  type ParsedJson,
  rawZip,
} from '../test-support/bundles.js';
import {
  decryptParts,
  rebuildMigrationBundle,
  type SnapshotParts,
  zipEntries,
} from '../test-support/migration-bundles.js';
import { type LaneRoles, prepareRoleDatabases } from '../test-support/migration-source.js';
import { pgToolPath } from '../test-support/pg-tools.js';
import {
  asAdmin,
  PASSWORD,
  type PostureDeployment,
  request,
  startPostureDeployment,
} from '../test-support/posture-deployment.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (dbRequired && !baseUrl) {
  throw new Error('hostile-inputs: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS)');
}

const ARMS = 2;
let armsRan = 0;
const valid = schemaValidator('resultEnvelope');
const expectations = loadExpectations();

const TARGET_DB = `rayspec_cert_hostile_target_${process.pid}`;
const TARGET_SYS = `${TARGET_DB}_dbos_sys`;

/** The decryption cases of the contract, with what each must be refused with. */
interface DecryptionCase {
  id: string;
  description: string;
  expect: { ok: boolean; code: string; reason?: string; exit: number };
}
const decryptionCases = (
  JSON.parse(
    readFileSync(join(CONTRACT_ROOT, 'contract', 'fixtures', 'EXPECTATIONS.json'), 'utf8'),
  ) as { decryptionCases: DecryptionCase[] }
).decryptionCases;
const decryption = (id: string): DecryptionCase => {
  const found = decryptionCases.find((c) => c.id === id);
  if (found === undefined) throw new Error(`the contract has no decryption case ${id}`);
  return found;
};

/** Every path under `root` with its size and modification time: what a refusal must not change. */
function treeOf(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const st = statSync(path);
      out.push(`${relative(root, path)} ${entry.isDirectory() ? 'dir' : st.size} ${st.mtimeMs}`);
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * The hostile archives: every case the passive reader itself refuses at its default limits. A case
 * built for a limit the contract lowers first (`readerLimits`) is the reader suite's: no deploy
 * flag lowers a limit, so through the deploy those bytes are an ordinary archive.
 */
const hostileArchives: CorpusCase[] = expectations.cases.filter(
  (c) =>
    c.expect.find((e) => e.operation === 'bundle.inspect')?.ok === false &&
    (c.construction as { readerLimits?: unknown }).readerLimits === undefined,
);

describe.skipIf(!baseUrl)('hostile archives and migration bundles through the real CLI', () => {
  const adminUrl = baseUrl ?? '';
  let d: PostureDeployment;
  let target: { lane: RuntimeRoleLane; roles: LaneRoles };
  let work = '';

  beforeAll(async () => {
    if (!baseUrl) return;
    d = await startPostureDeployment(adminUrl, `rayspec_cert_hostile_${process.pid}`);
    target = await prepareRoleDatabases(adminUrl, TARGET_DB, TARGET_SYS);
    work = temporaryDirectory('posture-hostile-');
  }, 600_000);

  afterAll(async () => {
    if (work !== '') spawnSync('chmod', ['-R', 'u+w', work]);
    await d?.dispose();
    await asAdmin(adminUrl, 'postgres', async (sql) => {
      for (const name of [TARGET_DB, TARGET_SYS]) {
        await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      }
    }).catch(() => {});
    await target?.lane.drop().catch(() => {});
    removeTemporaryDirectories();
    if (dbRequired) expect(armsRan).toBe(ARMS);
  }, 180_000);

  /** One CLI run to completion with the deployment's environment (or `env`). */
  function cli(args: string[], env: NodeJS.ProcessEnv = d.env) {
    const run = spawnSync(process.execPath, [CLI_DIST, ...args], {
      cwd: work,
      env,
      encoding: 'utf8',
      timeout: 180_000,
    });
    let envelope: ParsedJson = {};
    try {
      envelope = JSON.parse(run.stdout) as ParsedJson;
    } catch {
      envelope = { unparsed: run.stdout };
    }
    for (const secret of d.secrets) {
      expect(`${run.stdout}${run.stderr}`.includes(secret), 'a secret reached the output').toBe(
        false,
      );
    }
    return { status: run.status, envelope, stderr: run.stderr };
  }

  it('refuses every hostile application archive of the contract corpus before anything is extracted, applied or written', async () => {
    expect(hostileArchives.length).toBeGreaterThan(80);
    const dbState = () =>
      d.admin(
        (sql) =>
          sql.unsafe(
            `SELECT (SELECT count(*) FROM runtime_control_receipts)::int AS receipts,
                    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                      WHERE n.nspname = 'public')::int AS relations,
                    (SELECT environment_revision::text FROM runtime_control_state WHERE id = 1) AS revision`,
          ) as unknown as Promise<unknown[]>,
      );
    const tmp = process.env.TMPDIR ?? '';
    const before = {
      state: treeOf(d.stateDir),
      db: await dbState(),
      tmp: tmp === '' ? [] : readdirSync(tmp).sort(),
    };
    const cases = join(work, 'archives');
    mkdirSync(cases);
    const outcomes: string[] = [];
    for (const c of hostileArchives) {
      // Named `.ray`, whatever the corpus file is called, so the deploy takes the bundle path.
      const path = join(cases, `${c.id}.ray`);
      copyFileSync(casePath(expectations, c, cases), path);
      const inspect = c.expect.find((e) => e.operation === 'bundle.inspect');
      const run = cli([
        'deploy',
        path,
        '--dry-run',
        '--bindings-file',
        d.bindings,
        '--state-dir',
        d.stateDir,
      ]);
      expect(valid(run.envelope), `${c.id}: ${run.stderr}`).toBe(true);
      expect(run.envelope.ok, c.id).toBe(false);
      expect(run.status, c.id).toBe(inspect?.exit);
      expect(run.envelope.errors[0]?.code, `${c.id}: ${c.description}`).toBe(inspect?.code);
      // The deploy reads a `.ray` only when it starts with a ZIP signature (a local header or an
      // end record) and refuses any other as `not-a-zip` before the reader runs (the contract's own
      // deploy case of a garbage `.ray`); every other refusal is the reader's, reason included.
      const head = readFileSync(path).subarray(0, 4);
      const zipHead = head.length === 4 && [0x04034b50, 0x06054b50].includes(head.readUInt32LE(0));
      const reason = zipHead ? inspect?.reason : 'not-a-zip';
      if (reason !== undefined) expect(run.envelope.errors[0]?.reason, c.id).toBe(reason);
      outcomes.push(`${c.id} ${run.envelope.errors[0]?.code}`);
    }
    expect(outcomes).toHaveLength(hostileArchives.length);
    // Nothing was extracted, planned or recorded, here or in the temporary directory.
    expect(treeOf(d.stateDir)).toEqual(before.state);
    expect(await dbState()).toEqual(before.db);
    if (tmp !== '') {
      const leftovers = readdirSync(tmp)
        .sort()
        .filter((n) => !before.tmp.includes(n) && !n.startsWith('posture-'));
      expect(leftovers).toEqual([]);
    }
    // The deployment still serves.
    expect((await request(d.base, '/livez')).status).toBe(200);
    armsRan += 1;
  }, 900_000);

  it('refuses every hostile migration bundle of the contract before anything reaches the target', async () => {
    // A real export of the deployment: one organization whose owner has a password.
    const owner = await request(d.base, '/v1/auth/register', {
      body: { email: 'owner@hostile.example', password: PASSWORD, orgName: 'Hostile' },
    });
    expect(owner.status, owner.text).toBe(201);
    const note = await request(d.base, '/notes', {
      token: owner.body.accessToken as string,
      body: { body: 'a row' },
    });
    expect(note.status).toBe(201);
    for (const name of ['first', 'second']) {
      const res = await request(d.base, `/uploads/${name}`, {
        token: owner.body.accessToken as string,
        raw: Buffer.from(`${name} object bytes`),
      });
      expect(res.status, res.text).toBe(200);
    }
    const [{ major }] = (await asAdmin(adminUrl, 'postgres', (sql) =>
      sql.unsafe("SELECT current_setting('server_version_num')::int / 10000 AS major"),
    )) as unknown as [{ major: number }];
    const pgDump = pgToolPath('pg_dump', major, work).path;
    const pgRestore = pgToolPath('pg_restore', major, work).path;
    const identity = await generateX25519Identity();
    const recipient = await identityToRecipient(identity);
    const exportedPath = join(work, 'migration.ray');
    const exported = cli(
      [
        'export',
        '--deployment',
        d.deploymentId,
        '--recipient',
        recipient,
        '--output',
        exportedPath,
        '--run-history',
        'excluded',
        '--confirm-quiesce',
        '--state-dir',
        d.stateDir,
      ],
      { ...d.env, RAYSPEC_PG_DUMP: pgDump },
    );
    expect(exported.status, exported.stderr).toBe(0);
    const parts: SnapshotParts = await decryptParts(exportedPath, identity);
    const outer = JSON.parse(
      zipEntries(readFileSync(exportedPath)).get('ray.json')?.toString('utf8') ?? '{}',
    ) as ParsedJson;
    const appTarget = outer.target as { os: string; arch: string; nodeMajor: number };

    const identityFile = join(work, 'identity.txt');
    writeFileSync(identityFile, `${identity}\n`);
    chmodSync(identityFile, 0o600);
    const targetEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: process.env.TMPDIR ?? '',
      DATABASE_URL: target.roles.app.runtime,
      RAYSPEC_MIGRATION_DATABASE_URL: target.roles.app.migration,
      DBOS_SYSTEM_DATABASE_URL: target.roles.sys.runtime,
      RAYSPEC_BLOB_ROOT: join(work, 'target-blobs'),
      RAYSPEC_PG_RESTORE: pgRestore,
    };
    mkdirSync(join(work, 'target-blobs'));
    const stateDir = join(work, 'target-state');
    const contents = async (db: string): Promise<number> => {
      const [row] = (await asAdmin(adminUrl, db, (sql) =>
        sql.unsafe(
          `SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
                      AND n.nspname NOT LIKE 'pg\\_%')::int AS n`,
        ),
      )) as unknown as [{ n: number }];
      return row.n;
    };

    /** The outer bundle around `ciphertext`, every inventory entry consistent with it. */
    const outerAround = async (name: string, ciphertext: Uint8Array): Promise<string> => {
      const dir = join(work, name);
      mkdirSync(dir);
      const path = join(dir, 'migration.ray');
      const written = await writeBundle(path, {
        manifest: {
          formatVersion: 1,
          kind: 'migration',
          application: outer.application,
          runtime: outer.runtime,
          target: appTarget,
          migration: outer.migration,
        },
        files: [{ path: MIGRATION_CIPHERTEXT_PATH, bytes: ciphertext }],
      });
      expect(written.ok, JSON.stringify(written)).toBe(true);
      return path;
    };
    /** The migration bundle around an inner archive written byte for byte, to the real recipient. */
    const aroundInner = async (name: string, inner: Buffer): Promise<string> => {
      const dir = join(work, `${name}-inner`);
      mkdirSync(dir);
      writeFileSync(join(dir, 'snapshot.zip'), inner);
      mkdirSync(join(dir, 'work'), { mode: 0o700 });
      const path = join(dir, 'migration.ray');
      const written = await writeMigrationBundle(path, {
        application: outer.application,
        runtime: outer.runtime,
        target: appTarget,
        innerArchive: join(dir, 'snapshot.zip'),
        recipient,
        workDir: join(dir, 'work'),
      });
      expect(written.ok, JSON.stringify(written)).toBe(true);
      return path;
    };
    /**
     * The real inner archive with entries changed, added or a snapshot.json of its own, in the
     * entries' order; the inventory in snapshot.json is computed again unless `snapshot` is given raw.
     */
    const innerWith = (change: {
      files?: Record<string, Buffer>;
      extra?: { name: string; data: Buffer };
      snapshot?: (doc: ParsedJson) => ParsedJson;
    }): Buffer => {
      const original = zipEntries(parts.inner);
      const files = new Map<string, Buffer>();
      for (const [name, data] of original) {
        if (name !== SNAPSHOT_ROOT_NAME) files.set(name, change.files?.[name] ?? data);
      }
      const doc = JSON.parse(
        original.get(SNAPSHOT_ROOT_NAME)?.toString('utf8') ?? '{}',
      ) as ParsedJson;
      doc.inventory = [...files].map(([path, data]) => ({
        path,
        size: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
      }));
      const snapshot = Buffer.from(
        canonicalJsonFile(change.snapshot === undefined ? doc : change.snapshot(doc)),
        'utf8',
      );
      const entries = [...original.keys()].map((name) => ({
        name,
        data: name === SNAPSHOT_ROOT_NAME ? snapshot : (files.get(name) as Buffer),
      }));
      if (change.extra !== undefined) entries.push(change.extra);
      return rawZip(entries);
    };

    const ciphertext = zipEntries(readFileSync(exportedPath)).get(MIGRATION_CIPHERTEXT_PATH);
    if (ciphertext === undefined) throw new Error('the export holds no ciphertext');
    const index = JSON.parse(
      parts.files.get('payload/object-index.json')?.toString('utf8') ?? '{}',
    ) as { objects: ParsedJson[] } & ParsedJson;
    expect(index.objects.length).toBeGreaterThanOrEqual(2);
    const objects = parts.files.get('payload/objects.bin') as Buffer;

    const wrongIdentity = join(work, 'wrong-identity.txt');
    writeFileSync(wrongIdentity, `${await generateX25519Identity()}\n`);
    chmodSync(wrongIdentity, 0o600);
    const passphrase = new Encrypter();
    passphrase.setPassphrase(['a', 'passphrase', 'recipient'].join('-'));

    const cases: { id: string; bundle: string; identity?: string; before?: () => Promise<void> }[] =
      [
        { id: 'migration-wrong-identity', bundle: exportedPath, identity: wrongIdentity },
        {
          id: 'migration-truncated-ciphertext',
          bundle: await outerAround('truncated', ciphertext.subarray(0, ciphertext.length - 16)),
        },
        {
          id: 'migration-passphrase-recipient',
          bundle: await outerAround('passphrase', await passphrase.encrypt(parts.inner)),
        },
        {
          id: 'migration-inner-traversal',
          bundle: await aroundInner(
            'traversal',
            innerWith({ extra: { name: 'payload/../evil.txt', data: Buffer.from('evil') } }),
          ),
        },
        {
          id: 'migration-inner-identity-policy-string',
          bundle: await aroundInner(
            'identity-policy',
            innerWith({ snapshot: (doc) => ({ ...doc, identityPolicy: 'reset' }) }),
          ),
        },
        {
          id: 'migration-inner-outer-mismatch',
          bundle: await rebuildMigrationBundle(parts, {
            recipient,
            target: appTarget,
            outer: { id: 'another-application' },
          }),
        },
        {
          id: 'migration-inner-application-digest',
          bundle: await aroundInner(
            'application-digest',
            innerWith({ snapshot: (doc) => ({ ...doc, applicationDigest: '0'.repeat(64) }) }),
          ),
        },
        {
          id: 'migration-object-digest',
          bundle: await aroundInner(
            'object-digest',
            innerWith({
              files: {
                'payload/object-index.json': Buffer.from(
                  canonicalJsonFile({
                    ...index,
                    objects: index.objects.map((o, i) =>
                      i === 0 ? { ...o, sha256: 'f'.repeat(64) } : o,
                    ),
                  }),
                ),
              },
            }),
          ),
        },
        {
          id: 'migration-object-range-gap',
          bundle: await aroundInner(
            'object-range',
            innerWith({
              files: {
                'payload/object-index.json': Buffer.from(
                  canonicalJsonFile({
                    ...index,
                    objects: index.objects.map((o, i) =>
                      i === 0 ? o : { ...o, storedOffset: (o.storedOffset as number) + 1 },
                    ),
                  }),
                ),
                'payload/objects.bin': Buffer.concat([
                  objects.subarray(0, index.objects[1]?.storedOffset as number),
                  Buffer.from([0]),
                  objects.subarray(index.objects[1]?.storedOffset as number),
                ]),
              },
            }),
          ),
        },
        {
          id: 'migration-target-not-empty',
          bundle: exportedPath,
          before: async () => {
            await asAdmin(adminUrl, TARGET_DB, (sql) =>
              sql.unsafe('CREATE TABLE public.already_here (id int)'),
            );
          },
        },
      ];

    for (const c of cases) {
      const contract = decryption(c.id);
      await c.before?.();
      const run = cli(
        [
          'import',
          c.bundle,
          '--target',
          stateDir,
          '--identity-file',
          c.identity ?? identityFile,
          '--dry-run',
        ],
        targetEnv,
      );
      expect(valid(run.envelope), `${c.id}: ${run.stderr}`).toBe(true);
      expect(run.status, `${c.id}: ${contract.description}\n${run.stderr}`).toBe(
        contract.expect.exit,
      );
      expect(run.envelope.errors[0]?.code, `${c.id}: ${contract.description}`).toBe(
        contract.expect.code,
      );
      if (contract.expect.reason !== undefined) {
        expect(run.envelope.errors[0]?.reason, c.id).toBe(contract.expect.reason);
      }
      // Nothing reached the target: no relation beyond the one a case put there itself.
      expect(await contents(TARGET_DB), c.id).toBe(c.id === 'migration-target-not-empty' ? 1 : 0);
      expect(await contents(TARGET_SYS), c.id).toBe(0);
    }
    // The contract's case whose limit cannot be lowered from the command line is proven by the
    // reader's own suite (the extracted-size budget), not here.
    const covered = new Set(cases.map((c) => c.id));
    expect(decryptionCases.map((c) => c.id).filter((id) => !covered.has(id))).toEqual([
      'migration-inner-size-bomb',
    ]);
    armsRan += 1;
  }, 900_000);
});
