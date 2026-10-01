/**
 * `rayspec import` on GROUND TRUTH: the real built CLI in child processes, a SOURCE deployment
 * served by `rayspec deploy <file.ray>` with role separation and exported by `rayspec export`
 * (test-support/migration-source.ts), and a TARGET: two empty databases on the same server, with a
 * migration, runtime and snapshot role of their own prepared by the database roles setup, and an
 * empty blob root. Every restore runs as the target's migration role, never a superuser.
 *
 * In order, on one target:
 *  1. The dry run of the exported bundle is eligible and restores nothing.
 *  2. A wrong identity, a flipped ciphertext byte and a flipped byte in the inner archive are
 *     refused before anything reaches the target.
 *  3. Dumps an export never writes — an extension, a role, a SECURITY DEFINER function, `COPY FROM
 *     PROGRAM` — are refused by the allowlist; nothing of them runs, nothing reaches the target.
 *  4. A dump that restores two organizations is refused and its restore discarded.
 *  5. A non-empty target (a table, a blob) is refused, in the dry run and the import.
 *  6. A snapshot of another runtime is refused.
 *  7. A target whose roles do not give the runtime role its writes on the restored workflow system
 *     database is refused after the restore: marked failed, fenced, and emptied by
 *     `--discard-failed`.
 *  8. An import killed during the restore leaves the target marked failed: the next import refuses
 *     it and closes the killed run's receipt; `--discard-failed` empties it.
 *  9. SIGINT during the restore ends `pg_restore` (exit 6); the target is discarded the same way.
 * 10. The full round trip: every row of both databases and every file equals the source's —
 *     non-ASCII text, NULLs, JSON, a foreign key, two users with their password hashes — the
 *     credential tables are empty, every transition is in the receipts, the target is fenced with its
 *     runtime role unable to write, and the source is untouched.
 * 11. The cutover: `rayspec resume` releases the target's fence, the application deployed there with
 *     new boot secrets serves the imported rows, a member signs in with the password they had, and a
 *     token the source issued is refused.
 *
 * `pg_dump`/`pg_restore`: the host's when their major is the server's, else the pinned image through
 * docker. Skips without DATABASE_URL; a REQUIRED run (CI, RAYSPEC_REQUIRE_DB_TESTS) fails instead,
 * and the ran-guard fails a required run whose arms did not all run.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { writeBundle } from '@rayspec/bundle';
import {
  MIGRATION_CIPHERTEXT_PATH,
  PLATFORM_TABLES,
  SNAPSHOT_PATHS,
  schemaValidator,
} from '@rayspec/bundle-contract';
import type { RuntimeRoleLane } from '@rayspec/db/testing';
import { listFsBlobs } from '@rayspec/platform';
import type { DumpTocEntry } from '@rayspec/server';
import { generateX25519Identity } from 'age-encryption';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  removeTemporaryDirectories,
  temporaryDirectory,
  writeTree,
} from '../../../kernel/bundle-closure/src/test-support/app.js';
import { runPack } from './pack.js';
import { CLI_DIST, type ParsedJson } from './test-support/bundles.js';
import {
  decryptParts,
  forgeDump,
  rebuildMigrationBundle,
  type SnapshotParts,
  zipEntries,
} from './test-support/migration-bundles.js';
import {
  asAdmin,
  buildMigrationSource,
  INGEST,
  type LaneRoles,
  type MigrationSource,
  NON_ASCII,
  prepareRoleDatabases,
  SOURCE_SPEC,
  SOURCE_TENANT,
  TICK,
  withDbName,
} from './test-support/migration-source.js';
import { holdingPgRestore } from './test-support/pg-tools.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (dbRequired && !baseUrl) {
  throw new Error(
    'import.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip this DB-backed suite.',
  );
}
let armsRan = 0;
const ARMS = 11;

const SOURCE_DB = `rayspec_import_src_${process.pid}`;
const TARGET_DB = `rayspec_import_tgt_${process.pid}`;
const TARGET_SYS = `${TARGET_DB}_dbos_sys`;
const TWO_ORGS_DB = `${SOURCE_DB}_two_orgs`;
const valid = schemaValidator('resultEnvelope');
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CliRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  envelope: ParsedJson;
  stdout: string;
  stderr: string;
  leaked: number;
}

async function freePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const probe = createServer();
    probe.on('error', rej);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => res(port));
    });
  });
}

describe.skipIf(!baseUrl)('rayspec import — a source, an export and one target', () => {
  const adminUrl = baseUrl ?? '';
  let source: MigrationSource;
  let target: { lane: RuntimeRoleLane; roles: LaneRoles };
  let parts: SnapshotParts;
  let workDir = '';
  let stateDir = '';
  let blobRoot = '';
  let identityFile = '';
  let bindingsFile = '';
  let appTarget: { os: string; arch: string; nodeMajor: number };
  const children: ChildProcess[] = [];

  const secrets = (): string[] =>
    [
      ...source.secrets,
      ...[target.roles.app.migration, target.roles.app.runtime, target.roles.sys.runtime].map((u) =>
        decodeURIComponent(new URL(u).password),
      ),
      source.identity,
    ].filter((s) => s !== '');

  function targetEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      DATABASE_URL: target.roles.app.runtime,
      RAYSPEC_MIGRATION_DATABASE_URL: target.roles.app.migration,
      DBOS_SYSTEM_DATABASE_URL: target.roles.sys.runtime,
      RAYSPEC_BLOB_ROOT: blobRoot,
      RAYSPEC_PG_RESTORE: source.pgRestore,
      ...extra,
    };
  }

  function start(
    args: string[],
    env: NodeJS.ProcessEnv,
  ): { child: ChildProcess; done: Promise<CliRun> } {
    const child = spawn(process.execPath, [CLI_DIST, ...args], {
      cwd: workDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    const done = new Promise<CliRun>((resolve) => {
      child.on('exit', (code, signal) => {
        let envelope: ParsedJson = {};
        try {
          envelope = JSON.parse(stdout) as ParsedJson;
        } catch {
          envelope = { unparsed: stdout };
        }
        const leaked = secrets().filter((s) => `${stdout}${stderr}`.includes(s)).length;
        resolve({ code, signal, envelope, stdout, stderr, leaked });
      });
    });
    return { child, done };
  }

  async function cli(args: string[], env: NodeJS.ProcessEnv = targetEnv()): Promise<CliRun> {
    const run = await start(args, env).done;
    expect(run.leaked, 'a secret reached the output').toBe(0);
    expect(valid(run.envelope), `${JSON.stringify(valid.errors)}\n${run.stderr}`).toBe(true);
    return run;
  }

  const importArgs = (bundle: string, extra: string[] = []) => [
    'import',
    bundle,
    '--target',
    stateDir,
    '--identity-file',
    identityFile,
    ...extra,
  ];

  /** Everything in a database an import could have left: relations, functions, schemas, extensions. */
  async function contents(db: string): Promise<number> {
    const [row] = (await asAdmin(adminUrl, db, (sql) =>
      sql.unsafe(
        `SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%')
              + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%')
              + (SELECT count(*) FROM pg_extension WHERE extname <> 'plpgsql')
              + (SELECT count(*) FROM pg_namespace n WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'public')
                  AND n.nspname NOT LIKE 'pg\\_%') AS n`,
      ),
    )) as unknown as [{ n: string }];
    return Number(row.n);
  }

  async function expectTargetUntouched(): Promise<void> {
    expect(await contents(TARGET_DB)).toBe(0);
    expect(await contents(TARGET_SYS)).toBe(0);
    expect(existsSync(blobRoot) ? readdirSync(blobRoot) : []).toEqual([]);
    const held = existsSync(stateDir)
      ? readdirSync(stateDir).filter((e) => e !== 'receipts' && e !== 'scratch')
      : [];
    expect(held).toEqual([]);
    if (existsSync(join(stateDir, 'scratch')))
      expect(readdirSync(join(stateDir, 'scratch'))).toEqual([]);
  }

  /** A table's rows in a stable text form, for comparing source and target. */
  async function rowsOf(db: string, schema: string, table: string): Promise<string[]> {
    return asAdmin(adminUrl, db, async (sql) =>
      (
        (await sql.unsafe(
          `SELECT t::text AS row FROM "${schema}"."${table}" t ORDER BY t::text`,
        )) as unknown as { row: string }[]
      ).map((r) => r.row),
    );
  }

  async function fenceOf(db: string): Promise<{ state: string; epoch: number } | null> {
    return asAdmin(adminUrl, db, async (sql) => {
      const [row] = await sql.unsafe(
        'SELECT fence_state AS state, fence_epoch::int AS epoch FROM runtime_control_state WHERE id = 1',
      );
      return (row as { state: string; epoch: number } | undefined) ?? null;
    });
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    source = await buildMigrationSource(adminUrl, SOURCE_DB);
    target = await prepareRoleDatabases(adminUrl, TARGET_DB, TARGET_SYS);
    workDir = temporaryDirectory('import-target-');
    stateDir = join(workDir, 'target-state');
    blobRoot = join(workDir, 'blobs');
    identityFile = join(workDir, 'identity.txt');
    writeFileSync(identityFile, `# created by the import suite\n${source.identity}\n`);
    chmodSync(identityFile, 0o600);
    bindingsFile = join(workDir, 'bindings.json');
    writeFileSync(
      bindingsFile,
      JSON.stringify({
        bindingsFormatVersion: 1,
        bindings: [{ name: 'OPENAI_API_KEY', value: ['inert', 'target', randomUUID()].join('-') }],
      }),
    );
    chmodSync(bindingsFile, 0o600);
    parts = await decryptParts(source.bundle, source.identity);
    const app = (
      JSON.parse(
        spawnSync(process.execPath, [CLI_DIST, 'bundle', 'inspect', source.appBundle, '--json'], {
          encoding: 'utf8',
        }).stdout,
      ) as ParsedJson
    ).data;
    appTarget = app.target;
  }, 600_000);

  afterAll(async () => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    for (const dir of [workDir, source?.deployDir ?? '']) {
      if (dir !== '') spawnSync('chmod', ['-R', 'u+w', dir]);
    }
    if (!baseUrl) return;
    await source?.dispose().catch(() => {});
    await asAdmin(adminUrl, 'postgres', async (sql) => {
      for (const name of [TARGET_DB, TARGET_SYS, TWO_ORGS_DB]) {
        await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      }
    }).catch(() => {});
    await target?.lane.drop().catch(() => {});
    removeTemporaryDirectories();
    if (dbRequired) expect(armsRan).toBe(ARMS);
  }, 180_000);

  it('the dry run of the exported bundle is eligible and restores nothing', async () => {
    const run = await cli(importArgs(source.bundle, ['--dry-run']));
    expect(run.code, run.stderr).toBe(0);
    expect(run.envelope.operation).toBe('import.dry-run');
    expect(run.envelope.data).toMatchObject({
      bundleSha256: source.exported.sha256,
      eligible: true,
      applicationId: parts.snapshot.applicationId,
      applicationVersion: parts.snapshot.applicationVersion,
      sourceRuntime: parts.snapshot.sourceRuntime,
      schemaHead: parts.snapshot.schemaHead,
      fenceEpoch: source.exported.fenceEpoch,
      workflowSystemDatabase: 'included',
      blockers: [],
    });
    await expectTargetUntouched();
    armsRan += 1;
  }, 180_000);

  it('refuses a wrong identity, a flipped ciphertext byte and a flipped inner byte before anything reaches the target', async () => {
    const wrong = join(workDir, 'wrong-identity.txt');
    writeFileSync(wrong, `${await generateX25519Identity()}\n`);
    chmodSync(wrong, 0o600);
    const wrongRun = await cli([...importArgs(source.bundle).slice(0, -1), wrong]);
    expect(wrongRun.code).toBe(2);
    expect(wrongRun.envelope.errors[0]).toMatchObject({ code: 'RAY_DECRYPTION_FAILED' });

    // A ciphertext byte flipped under an inventory that states the flipped bytes' digest: the reader
    // passes it, the decryption refuses it.
    const ciphertext = zipEntries(readFileSync(source.bundle)).get(MIGRATION_CIPHERTEXT_PATH)!;
    const flipped = Buffer.from(ciphertext);
    flipped[flipped.length - 30] = flipped[flipped.length - 30]! ^ 0x01;
    const flippedDir = temporaryDirectory('import-flipped-');
    writeFileSync(join(flippedDir, 'migration.age'), flipped);
    const flippedBundle = join(flippedDir, 'migration.ray');
    const written = await writeBundle(flippedBundle, {
      manifest: {
        formatVersion: 1,
        kind: 'migration',
        application: {
          id: parts.snapshot.applicationId,
          version: parts.snapshot.applicationVersion,
        },
        runtime: { version: parts.snapshot.sourceRuntime },
        target: appTarget,
        migration: { encryption: 'age-v1-x25519', ciphertextPath: MIGRATION_CIPHERTEXT_PATH },
      },
      files: [{ path: MIGRATION_CIPHERTEXT_PATH, file: join(flippedDir, 'migration.age') }],
    });
    expect(written.ok).toBe(true);
    const flippedRun = await cli(importArgs(flippedBundle, ['--bindings-file', bindingsFile]));
    expect(flippedRun.code).toBe(2);
    expect(flippedRun.envelope.errors[0]).toMatchObject({ code: 'RAY_DECRYPTION_FAILED' });

    // A byte flipped inside the inner archive (in the application dump), encrypted again.
    const innerFlipped = await rebuildMigrationBundle(parts, {
      recipient: source.recipient,
      target: appTarget,
      damageInner: (inner) => {
        const at = inner.indexOf(parts.files.get(SNAPSHOT_PATHS.database)!.subarray(0, 64)) + 200;
        inner[at] = inner[at]! ^ 0x01;
      },
    });
    const innerRun = await cli(importArgs(innerFlipped, ['--bindings-file', bindingsFile]));
    expect(innerRun.code).toBe(2);
    expect(innerRun.envelope.errors[0]).toMatchObject({
      code: 'RAY_INVALID_ARCHIVE',
      reason: 'crc-mismatch',
    });
    await expectTargetUntouched();
    armsRan += 1;
  }, 240_000);

  it('refuses dumps that create an extension, a role or a SECURITY DEFINER function, or copy from a program, and runs none of it', async () => {
    const marker = join(workDir, 'program-ran');
    const dump = parts.files.get(SNAPSHOT_PATHS.database)!;
    const role = `rs_import_evil_${process.pid}`;
    const cases: [string, (entries: DumpTocEntry[]) => DumpTocEntry[], string][] = [
      [
        'extension',
        (entries) => [
          ...entries,
          {
            ...entries.find((e) => e.desc === 'SCHEMA')!,
            dumpId: 900_001,
            desc: 'EXTENSION',
            tag: 'pgcrypto',
            namespace: null,
            owner: '',
            defn: 'CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;\n',
          },
        ],
        'unsupported-extension',
      ],
      [
        'role',
        (entries) =>
          entries.map((e) =>
            e.desc === 'TABLE' && e.tag === 'orgs'
              ? { ...e, defn: `${e.defn}CREATE ROLE ${role} SUPERUSER LOGIN;\n` }
              : e,
          ),
        'privileged-statement',
      ],
      [
        'security definer',
        (entries) => [
          ...entries,
          {
            ...entries.find((e) => e.desc === 'FUNCTION')!,
            dumpId: 900_002,
            tag: 'grant_everything()',
            defn:
              'CREATE FUNCTION public.grant_everything() RETURNS void\n    LANGUAGE sql SECURITY DEFINER\n' +
              '    AS $$ SELECT 1 $$;\n',
          },
        ],
        'privileged-statement',
      ],
      [
        'copy from program',
        (entries) =>
          entries.map((e) =>
            e.desc === 'TABLE DATA' && e.tag === 'import_projects'
              ? { ...e, copyStmt: `COPY public.import_projects FROM PROGRAM 'touch ${marker}';\n` }
              : e,
          ),
        'privileged-statement',
      ],
    ];
    for (const [name, change, reason] of cases) {
      const forged = await forgeDump(dump, change);
      const bundle = await rebuildMigrationBundle(parts, {
        recipient: source.recipient,
        target: appTarget,
        files: { [SNAPSHOT_PATHS.database]: forged },
      });
      const dry = await cli(importArgs(bundle, ['--dry-run']));
      expect(dry.code, `${name}\n${dry.stderr}`).toBe(4);
      expect(dry.envelope.errors[0], name).toMatchObject({ code: 'RAY_POLICY_DENIED', reason });
      const run = await cli(importArgs(bundle, ['--bindings-file', bindingsFile]));
      expect(run.code, `${name}\n${run.stderr}`).toBe(4);
      expect(run.envelope.errors[0], name).toMatchObject({ code: 'RAY_POLICY_DENIED', reason });
      await expectTargetUntouched();
    }
    expect(existsSync(marker)).toBe(false);
    const [roles] = (await asAdmin(adminUrl, 'postgres', (sql) =>
      sql.unsafe('SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1', [role]),
    )) as unknown as [{ n: number }];
    expect(roles.n).toBe(0);
    armsRan += 1;
  }, 600_000);

  it('refuses a dump that restores two organizations, whatever snapshot.json says, and discards the restore', async () => {
    // A copy of the source with a second organization, dumped the way an export dumps.
    await asAdmin(adminUrl, 'postgres', (sql) =>
      sql.unsafe(`CREATE DATABASE "${TWO_ORGS_DB}" TEMPLATE "${SOURCE_DB}"`),
    );
    await asAdmin(adminUrl, TWO_ORGS_DB, (sql) =>
      sql.unsafe("INSERT INTO orgs (id, name, slug) VALUES ($1, 'Second', 'second')", [
        '00000000-0000-4000-8000-00000000b0b0',
      ]),
    );
    const excluded = new Set(parts.snapshot.excludedDataCategories);
    const excludedTables = PLATFORM_TABLES.filter((t) => excluded.has(t.category)).map(
      (t) => `--exclude-table-data=${t.schema}.${t.table}`,
    );
    const dumpFile = join(temporaryDirectory('import-two-orgs-'), 'database.dump');
    const u = new URL(withDbName(adminUrl, TWO_ORGS_DB));
    const dumped = spawnSync(
      source.pgDump,
      ['--format=custom', '--no-password', `--file=${dumpFile}`, ...excludedTables],
      {
        env: {
          PATH: process.env.PATH ?? '',
          PGHOST: u.hostname,
          PGPORT: u.port,
          PGUSER: decodeURIComponent(u.username),
          PGPASSWORD: decodeURIComponent(u.password),
          PGDATABASE: TWO_ORGS_DB,
        },
        encoding: 'utf8',
      },
    );
    expect(dumped.status, dumped.stderr).toBe(0);
    const bundle = await rebuildMigrationBundle(parts, {
      recipient: source.recipient,
      target: appTarget,
      files: { [SNAPSHOT_PATHS.database]: readFileSync(dumpFile) },
      snapshot: {
        tableCounts: parts.snapshot.tableCounts.map((t) =>
          t.database === 'application' && t.table === 'orgs' ? { ...t, rows: 2 } : t,
        ),
      },
    });
    expect(parts.snapshot.applicationTenantCount).toBe(1);
    const run = await cli(importArgs(bundle, ['--bindings-file', bindingsFile]));
    expect(run.code, run.stderr).toBe(3);
    expect(run.envelope.errors[0]).toMatchObject({ code: 'RAY_MULTI_TENANT_UNSUPPORTED' });
    expect(run.envelope.errors[0].message).toContain('discarded');
    // The application database is empty again; the workflow system database the restore had
    // filled first is emptied with it.
    await expectTargetUntouched();
    const receipt = JSON.parse(
      readFileSync(join(stateDir, 'receipts', `import-${run.envelope.operationId}.json`), 'utf8'),
    ) as ParsedJson;
    expect((receipt.transitions as ParsedJson[]).map((t) => t.state)).toEqual([
      'IMPORTING',
      'BLOCKED',
    ]);
    expect(receipt.outcome).toBe('blocked');
    armsRan += 1;
  }, 300_000);

  it('refuses a target that is not empty, in the dry run and the import', async () => {
    await asAdmin(adminUrl, TARGET_DB, (sql) =>
      sql.unsafe('CREATE TABLE public.left_over (id int)'),
    );
    try {
      const dry = await cli(importArgs(source.bundle, ['--dry-run']));
      expect(dry.code).toBe(4);
      expect(dry.envelope.errors[0]).toMatchObject({ code: 'RAY_TARGET_NOT_EMPTY' });
      expect(dry.envelope.data).toMatchObject({ eligible: false });
      const run = await cli(importArgs(source.bundle, ['--bindings-file', bindingsFile]));
      expect(run.code).toBe(4);
      expect(run.envelope.errors[0]).toMatchObject({ code: 'RAY_TARGET_NOT_EMPTY' });
    } finally {
      await asAdmin(adminUrl, TARGET_DB, (sql) => sql.unsafe('DROP TABLE public.left_over'));
    }
    mkdirSync(join(blobRoot, SOURCE_TENANT), { recursive: true });
    writeFileSync(join(blobRoot, SOURCE_TENANT, 'stray'), 'left over');
    try {
      const run = await cli(importArgs(source.bundle, ['--dry-run']));
      expect(run.code).toBe(4);
      expect(run.envelope.errors[0]).toMatchObject({ code: 'RAY_TARGET_NOT_EMPTY' });
    } finally {
      rmSync(join(blobRoot, SOURCE_TENANT), { recursive: true });
    }
    await expectTargetUntouched();
    armsRan += 1;
  }, 180_000);

  it('refuses a snapshot taken by another runtime', async () => {
    const app = temporaryDirectory('import-other-runtime-');
    writeTree(app, {
      'rayspec.yaml': SOURCE_SPEC,
      'package.json': JSON.stringify({ name: 'import-app', private: true, type: 'module' }),
      'handlers/tick.js': TICK,
      'handlers/ingest.js': INGEST,
    });
    const packed = await runPack(
      ['--spec', join(app, 'rayspec.yaml'), '--output', join(app, 'app.ray')],
      { operationId: randomUUID(), cliVersion: '1.7.9' },
    );
    expect(packed.envelope.ok, JSON.stringify(packed.envelope.errors)).toBe(true);
    const otherApp = readFileSync(join(app, 'app.ray'));
    const bundle = await rebuildMigrationBundle(parts, {
      recipient: source.recipient,
      target: appTarget,
      files: { [SNAPSHOT_PATHS.application]: otherApp },
      snapshot: {
        sourceRuntime: '1.7.9',
        exportToolVersion: '1.7.9',
        applicationDigest: createHash('sha256').update(otherApp).digest('hex'),
      },
    });
    const run = await cli(importArgs(bundle, ['--dry-run']));
    expect(run.code, run.stderr).toBe(3);
    expect(run.envelope.errors[0]).toMatchObject({ code: 'RAY_RUNTIME_UNSUPPORTED' });
    await expectTargetUntouched();
    armsRan += 1;
  }, 180_000);

  it('refuses a target whose roles do not grant the runtime role its writes, after the restore: marked failed, fenced, discarded', async () => {
    const roles = target.lane.roles;
    const alter = (verb: 'REVOKE' | 'GRANT') =>
      asAdmin(adminUrl, TARGET_SYS, (sql) =>
        sql.unsafe(
          `ALTER DEFAULT PRIVILEGES FOR ROLE "${roles.migration}" ${verb} INSERT, UPDATE, DELETE ON TABLES ` +
            `${verb === 'REVOKE' ? 'FROM' : 'TO'} "${roles.runtime}"`,
        ),
      );
    await alter('REVOKE');
    try {
      const run = await cli(importArgs(source.bundle, ['--bindings-file', bindingsFile]));
      expect(run.code, run.stderr).toBe(4);
      expect(run.envelope.errors[0]).toMatchObject({
        code: 'RAY_POLICY_DENIED',
        reason: 'posture-refused',
      });
      expect(run.envelope.errors[0].message).toContain('--discard-failed');
      // Marked failed in the state directory, and fenced in the database.
      expect(JSON.parse(readFileSync(join(stateDir, 'import.json'), 'utf8'))).toMatchObject({
        operationId: run.envelope.operationId,
        state: 'BLOCKED',
      });
      expect(await fenceOf(TARGET_DB)).toMatchObject({ state: 'fenced' });
      const again = await cli(importArgs(source.bundle, ['--dry-run']));
      expect(again.code).toBe(4);
      expect(again.envelope.errors[0]).toMatchObject({ code: 'RAY_TARGET_NOT_EMPTY' });
      const discarded = await cli(['import', '--target', stateDir, '--discard-failed']);
      expect(discarded.code, discarded.stderr).toBe(0);
      await expectTargetUntouched();
    } finally {
      await alter('GRANT');
    }
    armsRan += 1;
  }, 600_000);

  /** Start an import whose restore of the application database holds until it is stopped. */
  async function importHeldInRestore(name: string) {
    const marker = join(workDir, `${name}.started`);
    const release = join(workDir, `${name}.release`);
    const holding = holdingPgRestore(
      source.pgRestore,
      workDir,
      marker,
      release,
      `--dbname=${TARGET_DB}`,
    );
    const started = start(
      importArgs(source.bundle, ['--bindings-file', bindingsFile]),
      targetEnv({ RAYSPEC_PG_RESTORE: holding }),
    );
    const deadline = Date.now() + 180_000;
    while (!existsSync(marker)) {
      if (started.child.exitCode !== null || Date.now() > deadline) {
        throw new Error(`the restore never started\n${(await started.done).stderr}`);
      }
      await pause(100);
    }
    return { started, restorePid: Number(readFileSync(marker, 'utf8')) };
  }

  async function gone(pid: number): Promise<void> {
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      try {
        process.kill(pid, 0);
        await pause(100);
      } catch {
        return;
      }
    }
    expect(() => process.kill(pid, 0)).toThrow();
  }

  it('an import killed during the restore leaves the target marked failed; the next import refuses it; --discard-failed empties it', async () => {
    const { started, restorePid } = await importHeldInRestore('killed');
    started.child.kill('SIGKILL');
    const killed = await started.done;
    expect(killed.signal).toBe('SIGKILL');
    expect(killed.leaked).toBe(0);
    await gone(restorePid);
    const killedId = /operationId: ([0-9a-f-]{36})/.exec(killed.stderr)?.[1];
    expect(killedId).toBeDefined();
    // The workflow system database was restored; the application database was not; the plaintext
    // stays in the scratch directory, and the target is marked as being imported into.
    expect(await contents(TARGET_SYS)).toBeGreaterThan(0);
    expect(await contents(TARGET_DB)).toBe(0);
    expect(
      readdirSync(join(stateDir, 'scratch')).some((e) => e.startsWith('rayspec-import-')),
    ).toBe(true);
    expect(JSON.parse(readFileSync(join(stateDir, 'import.json'), 'utf8'))).toMatchObject({
      operationId: killedId,
      state: 'IMPORTING',
    });

    const next = await cli(importArgs(source.bundle, ['--bindings-file', bindingsFile]));
    expect(next.code).toBe(4);
    expect(next.envelope.errors[0]).toMatchObject({ code: 'RAY_TARGET_NOT_EMPTY' });
    expect(next.envelope.errors[0].message).toContain('--discard-failed');
    expect(next.stderr).toContain(`interrupted import (${killedId})`);
    expect(readdirSync(join(stateDir, 'scratch'))).toEqual([]);
    expect(JSON.parse(readFileSync(join(stateDir, 'import.json'), 'utf8'))).toMatchObject({
      state: 'BLOCKED',
    });
    const closed = JSON.parse(
      readFileSync(join(stateDir, 'receipts', `import-${killedId}.json`), 'utf8'),
    ) as ParsedJson;
    expect(closed.outcome).toBe('blocked');
    expect((closed.transitions as ParsedJson[]).at(-1)).toMatchObject({
      state: 'BLOCKED',
      interrupted: true,
      error: { code: 'RAY_INTERRUPTED' },
    });

    const discarded = await cli(['import', '--target', stateDir, '--discard-failed']);
    expect(discarded.code, discarded.stderr).toBe(0);
    await expectTargetUntouched();
    const again = await cli(importArgs(source.bundle, ['--dry-run']));
    expect(again.code).toBe(0);
    expect(again.envelope.data.eligible).toBe(true);
    armsRan += 1;
  }, 600_000);

  it('SIGINT during the restore ends pg_restore and leaves a target --discard-failed empties', async () => {
    const { started, restorePid } = await importHeldInRestore('interrupted');
    started.child.kill('SIGINT');
    const run = await started.done;
    expect(run.leaked).toBe(0);
    expect(run.code, run.stderr).toBe(6);
    expect(valid(run.envelope)).toBe(true);
    expect(run.envelope.errors[0].code).toBe('RAY_INTERRUPTED');
    expect(run.envelope.errors[0].message).toContain('--discard-failed');
    await gone(restorePid);
    expect(JSON.parse(readFileSync(join(stateDir, 'import.json'), 'utf8'))).toMatchObject({
      state: 'BLOCKED',
    });
    expect(readdirSync(join(stateDir, 'scratch'))).toEqual([]);
    const discarded = await cli(['import', '--target', stateDir, '--discard-failed']);
    expect(discarded.code, discarded.stderr).toBe(0);
    await expectTargetUntouched();
    armsRan += 1;
  }, 600_000);

  let imported: CliRun;

  it('imports the bundle: every row and file equals the source, credentials are reset, the target is fenced and the source untouched', async () => {
    const sourceFence = await fenceOf(source.db);
    const sourceBlobs = (await listFsBlobs(source.blobRoot, { phase: 'quiesced' })).objects;
    imported = await cli(importArgs(source.bundle, ['--bindings-file', bindingsFile]));
    const run = imported;
    expect(run.code, run.stderr).toBe(0);
    const data = run.envelope.data as ParsedJson;
    expect(data).toMatchObject({
      bundleSha256: source.exported.sha256,
      status: 'ready-for-cutover',
      applicationDigest: parts.snapshot.applicationDigest,
      schemaHead: parts.snapshot.schemaHead,
      verification: {
        checksums: 'match',
        tableCounts: 'match',
        objects: 'match',
        referenceIntegrity: 'match',
      },
      credentialReset: {
        sessions: 'reset',
        apiKeys: 'reset',
        invites: 'reset',
        oidcArtifacts: 'reset',
        passwordHashes: 'preserved',
        forcedLogin: true,
      },
    });
    const deploymentId = data.deploymentId as string;
    expect(deploymentId).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.parse(readFileSync(join(stateDir, 'deployment.json'), 'utf8')).deploymentId).toBe(
      deploymentId,
    );
    expect(run.stderr).toContain(`rayspec resume --deployment ${deploymentId} --fence-epoch 1`);
    expect(run.stderr).toMatch(/cutover token [0-9a-f]{64}/);

    // Every row of both databases: the included ones equal the source's, the excluded ones are empty.
    const excluded = new Set(parts.snapshot.excludedDataCategories);
    const excludedTables = new Set(
      PLATFORM_TABLES.filter((t) => excluded.has(t.category)).map((t) => `${t.schema}.${t.table}`),
    );
    for (const t of parts.snapshot.tableCounts) {
      const [src, tgt] =
        t.database === 'application' ? [source.db, TARGET_DB] : [source.sysDb, TARGET_SYS];
      const restored = await rowsOf(tgt, t.schema, t.table);
      // The runtime-control tables hold the target's own state and receipts, written by the import
      // after it verified the counts; nothing of the source's arrived in them.
      if (t.database === 'application' && t.table.startsWith('runtime_control_')) {
        expect(t.rows, `${t.schema}.${t.table}`).toBe(0);
        continue;
      }
      expect(restored.length, `${t.database} ${t.schema}.${t.table}`).toBe(t.rows);
      if (t.database === 'application' && excludedTables.has(`${t.schema}.${t.table}`)) {
        expect(restored, `${t.schema}.${t.table}`).toEqual([]);
        continue;
      }
      expect(restored, `${t.database} ${t.schema}.${t.table}`).toEqual(
        await rowsOf(src, t.schema, t.table),
      );
    }
    // What the seed put there, spelled out.
    const notes = await asAdmin(adminUrl, TARGET_DB, (sql) =>
      sql.unsafe('SELECT body, score, details FROM import_notes ORDER BY body'),
    );
    expect(notes.map((n) => n.body)).toContain(NON_ASCII);
    expect(notes.filter((n) => n.score === null)).toHaveLength(1);
    expect(notes.find((n) => n.body === NON_ASCII)?.details).toEqual({ tag: 'ü', list: [1, null] });
    const users = await asAdmin(adminUrl, TARGET_DB, (sql) =>
      sql.unsafe('SELECT email, password_hash FROM users ORDER BY email'),
    );
    expect(users).toHaveLength(2);
    expect(users).toEqual(
      await asAdmin(adminUrl, source.db, (sql) =>
        sql.unsafe('SELECT email, password_hash FROM users ORDER BY email'),
      ),
    );
    for (const table of [
      'sessions',
      'api_keys',
      'invites',
      'oidc_models',
      'auth_audit',
      'idempotency_keys',
    ]) {
      expect(await rowsOf(TARGET_DB, 'public', table), table).toEqual([]);
    }
    expect((await rowsOf(source.db, 'public', 'sessions')).length).toBeGreaterThan(0);

    // Every file, byte for byte.
    const restoredBlobs = (await listFsBlobs(blobRoot, { phase: 'quiesced' })).objects;
    expect(
      restoredBlobs.map((o) => [o.tenantId, o.key, o.sha256, o.storedSize, o.contentType]),
    ).toEqual(sourceBlobs.map((o) => [o.tenantId, o.key, o.sha256, o.storedSize, o.contentType]));
    for (const [i, o] of restoredBlobs.entries()) {
      expect(readFileSync(o.file).equals(readFileSync(sourceBlobs[i]!.file)), o.key).toBe(true);
    }
    expect(restoredBlobs.some((o) => o.size === 0)).toBe(true);

    // The target is fenced, its runtime role cannot write, and the ledgers stay closed to it.
    expect(await fenceOf(TARGET_DB)).toEqual({ state: 'fenced', epoch: 1 });
    const runtime = postgres(target.roles.app.runtime, { max: 1, onnotice: () => {} });
    try {
      await expect(
        runtime.begin(async (tx) => {
          await tx.unsafe(`SELECT set_config('app.current_tenant', '${SOURCE_TENANT}', true)`);
          await tx.unsafe("INSERT INTO import_ticks (tenant_id, trigger_name) VALUES ($1, 'x')", [
            SOURCE_TENANT,
          ]);
        }),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await runtime.end();
    }
    const [owner] = (await asAdmin(adminUrl, TARGET_DB, (sql) =>
      sql.unsafe("SELECT tableowner FROM pg_tables WHERE tablename = 'import_notes'"),
    )) as unknown as [{ tableowner: string }];
    expect(owner.tableowner).toBe(target.lane.roles.migration);

    // The receipts: every transition, locally and in the target's environment.
    const operationId = run.envelope.operationId as string;
    const receiptPath = join(stateDir, 'receipts', `import-${operationId}.json`);
    const fd = openSync(receiptPath, 'r');
    let receiptText: string;
    try {
      expect(fstatSync(fd).mode & 0o777).toBe(0o600);
      receiptText = readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
    const receipt = JSON.parse(receiptText) as ParsedJson;
    expect(receipt).toMatchObject({
      operation: 'import',
      operationId,
      actor: 'rayspec-import',
      deploymentId,
      outcome: 'ready-for-cutover',
    });
    expect((receipt.transitions as ParsedJson[]).map((t) => t.state)).toEqual([
      'IMPORTING',
      'VERIFYING',
      'READY_FOR_CUTOVER',
    ]);
    expect(receipt.cutover.token).toMatchObject({
      migrationBundleSha256: source.exported.sha256,
      targetDeploymentId: deploymentId,
      sourceFenceEpoch: source.exported.fenceEpoch,
      targetFenceEpoch: 1,
    });
    for (const s of [...secrets(), stateDir, NON_ASCII, 'import_notes']) {
      expect(receiptText.includes(s), s.slice(0, 12)).toBe(false);
    }
    const rows = await asAdmin(adminUrl, TARGET_DB, (sql) =>
      sql.unsafe(
        `SELECT event, step, outcome FROM runtime_control_receipts
          WHERE operation_id = $1 AND operation_kind = 'import' ORDER BY id`,
        [operationId],
      ),
    );
    expect(rows.map((r) => [r.event, r.step, r.outcome])).toEqual([
      ['step-finished', 'IMPORTING', null],
      ['step-finished', 'VERIFYING', null],
      ['outcome', 'READY_FOR_CUTOVER', 'succeeded'],
    ]);
    // The target's receipts are its own: the import's, and the fence it took under the same id.
    const [others] = (await asAdmin(adminUrl, TARGET_DB, (sql) =>
      sql.unsafe(
        'SELECT count(*)::int AS n FROM runtime_control_receipts WHERE operation_id <> $1',
        [operationId],
      ),
    )) as unknown as [{ n: number }];
    expect(others.n).toBe(0);

    // The source is untouched: the same fence, the same blobs.
    expect(await fenceOf(source.db)).toEqual(sourceFence);
    expect(
      (await listFsBlobs(source.blobRoot, { phase: 'quiesced' })).objects.map((o) => o.sha256),
    ).toEqual(sourceBlobs.map((o) => o.sha256));
    // A second import into the same target is refused.
    const twice = await cli(importArgs(source.bundle, ['--dry-run']));
    expect(twice.code).toBe(4);
    expect(twice.envelope.errors[0]).toMatchObject({ code: 'RAY_TARGET_NOT_EMPTY' });
    armsRan += 1;
  }, 600_000);

  it('the cutover: resume releases the target, the application serves the imported rows, passwords sign in, source tokens do not', async () => {
    const deploymentId = imported.envelope.data.deploymentId as string;
    const resumed = await cli([
      'resume',
      '--deployment',
      deploymentId,
      '--fence-epoch',
      '1',
      '--state-dir',
      stateDir,
    ]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(resumed.envelope.data).toMatchObject({ released: true });

    const { privateKey } = await generateKeyPair('RS256', {
      extractable: true,
      modulusLength: 2048,
    });
    const port = await freePort();
    const deployEnv = {
      ...targetEnv(),
      SHADOW_DATABASE_URL: process.env.SHADOW_DATABASE_URL ?? adminUrl,
      RAYSPEC_JWT_SIGNING_KEY: await exportPKCS8(privateKey),
      RAYSPEC_API_KEY_PEPPER: ['target', 'pepper', randomUUID()].join('-'),
      RAYSPEC_CRON_TENANT_ID: SOURCE_TENANT,
    };
    const dry = spawnSync(
      process.execPath,
      [
        CLI_DIST,
        'deploy',
        source.appBundle,
        '--dry-run',
        '--bindings-file',
        bindingsFile,
        '--state-dir',
        stateDir,
      ],
      { cwd: workDir, env: deployEnv, encoding: 'utf8', timeout: 180_000 },
    );
    expect(dry.status, dry.stderr).toBe(0);
    const plan = JSON.parse(dry.stdout) as ParsedJson;
    expect(plan.data.plan.schemaImpact.from).toEqual(parts.snapshot.schemaHead);
    const served = spawn(
      process.execPath,
      [
        CLI_DIST,
        'deploy',
        source.appBundle,
        '--plan-digest',
        plan.data.planDigest,
        '--port',
        String(port),
        '--bindings-file',
        bindingsFile,
        '--state-dir',
        stateDir,
      ],
      {
        cwd: workDir,
        env: { ...deployEnv, ALLOWED_ORIGINS: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    children.push(served);
    let out = '';
    served.stdout?.on('data', (d) => {
      out += String(d);
    });
    served.stderr?.on('data', (d) => {
      out += String(d);
    });
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (served.exitCode !== null) throw new Error(`deploy exited\n${out}`);
      try {
        if ((await fetch(`http://127.0.0.1:${port}/livez`)).status === 200) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error(`deploy did not serve\n${out}`);
      await pause(250);
    }
    try {
      const base = `http://127.0.0.1:${port}`;
      // A token the source issued is signed with the source's key: refused.
      const old = await fetch(`${base}/notes`, {
        headers: { authorization: `Bearer ${source.sourceToken}` },
      });
      expect(old.status).toBe(401);
      // A member signs in with the password they had at the source.
      const owner = source.members[0]!;
      const login = await fetch(`${base}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: owner.email, password: owner.password }),
      });
      expect(login.status).toBe(200);
      let token = ((await login.json()) as { accessToken: string }).accessToken;
      const switched = await fetch(`${base}/v1/orgs/${SOURCE_TENANT}/switch`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(switched.status).toBe(200);
      token = ((await switched.json()) as { accessToken: string }).accessToken;
      const listed = await fetch(`${base}/notes`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(listed.status).toBe(200);
      expect(JSON.stringify(await listed.json())).toContain(NON_ASCII);
      // The target accepts writes now; the source stays fenced.
      const posted = await fetch(`${base}/projects`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'after the cutover' }),
      });
      expect(posted.status).toBe(201);
      expect((await fenceOf(source.db))?.state).toBe('fenced');
    } finally {
      served.kill('SIGTERM');
      await new Promise((r) => served.on('exit', r));
    }
    armsRan += 1;
  }, 600_000);
});
