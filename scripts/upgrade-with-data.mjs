#!/usr/bin/env node
/**
 * upgrade-with-data — an existing deployment, with data in it, upgraded from the PREVIOUS PUBLISHED
 * release to this working tree.
 *
 * WHY. Every other database check starts from an empty database. A real upgrade starts from the
 * database a released runtime created and has been writing to: its users, their password hashes,
 * their API keys, the application's rows. This harness builds exactly that with the released
 * package from npm, then boots the working tree on it and checks that nothing a user relies on was
 * lost or changed.
 *
 * WHAT IT DOES, against a throwaway database on the server DATABASE_URL names:
 *   1. Installs `rayspec@<previous>` from npm into a temporary directory (`--from <version>`,
 *      default: the version npm reports as latest), with install scripts disabled.
 *   2. Deploys an example application with that release's `rayspec deploy` (`--app`: `notes-ui`, the
 *      default; the `team-notes` reference application, release 1.0.0 as its build writes it; or the
 *      `asset-catalog` reference application, a compiled extension with a vendored dependency that
 *      calls one HTTPS host), registers a user, creates an organization, mints an API key and writes
 *      rows through the declared API.
 *   3. Records the rows and the credential rows exactly as they are stored.
 *   4. Deploys the same spec with this working tree's `rayspec deploy`: the platform chain upgrades
 *      the database in place.
 *   5. Checks that every recorded row is byte-identical, that the user logs in with the same
 *      password, that the API key still reads the rows, and that a new row can be written.
 *   6. Packs the application with this working tree and deploys it as a bundle onto the upgraded
 *      environment — a dry-run, then the reviewed plan — and checks rows and credentials again.
 *
 * With `--candidate <dir>` the release upgraded to is the one a consumer installed from release
 * candidate tarballs into `<dir>` (`scripts/check-consumer-install.mjs`) instead of this working
 * tree: steps 4 and 6 run its CLI, and its database roles setup and `@rayspec` packages are used.
 *
 * With `--roles` the upgrade also turns role separation on, as docs/database-isolation.md has an
 * operator do it: after the previous release stopped, the working tree's database roles setup
 * (`packages/kernel/db/sql/database-roles.sql`) prepares the database with roles of its own, and
 * steps 4 and 6 deploy with the runtime role in DATABASE_URL and the migration and snapshot roles
 * beside it. Each of those deploys must then serve through its supervisor: one application process
 * under the process the harness started, and only the runtime role connected to the database while
 * it serves. The roles are dropped at the end.
 *
 * It prints one JSON summary on stdout and exits 1 on the first failed check. The server logs of
 * each boot go to `--log-dir <dir>` when it is given; `--port <n>` picks the listen port. No password, API key, signing key or pepper
 * is printed: they are generated here and stay in this process and its children.
 *
 * Needs: DATABASE_URL (a server where a database may be created and dropped), the working tree
 * built (`pnpm build`), npm with access to the registry. SHADOW_DATABASE_URL is used for the plan
 * of the bundle deploy when set, and DATABASE_URL's server otherwise. `asset-catalog` also needs the
 * openssl command line: its classification service runs here, over HTTPS with a test certificate,
 * reached through an egress proxy that admits the one host the application declares.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import { startClassifier, startEgressProxy, testCertificates } from './journeys/lib.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKING_TREE_CLI = join(REPO, 'packages', 'app', 'cli', 'dist', 'index.js');

/**
 * The applications the harness upgrades: where the source is, how it becomes a directory holding
 * `rayspec.yaml`, the store and route its rows are written through, the body of a row, and the
 * stored columns compared. Optional: `release(app)` puts back what `prepare` took out for the
 * previous release before the working tree packs the application, `runtime(app, which)` makes the
 * `@rayspec` packages an extension imports resolvable from the application directory for the
 * runtime about to boot it, and `egress` names the one HTTPS host its handlers call.
 */
const APPS = {
  'notes-ui': {
    prepare(app) {
      cpSync(join(REPO, 'examples', 'notes-ui'), app, { recursive: true });
    },
    table: 'notes',
    path: '/api/notes',
    note: (title) => ({ title, body: `${title} body` }),
    columns: 'id, tenant_id, title, body, created_at',
  },
  'team-notes': {
    // The release spec less `metadata.id` and `metadata.version`, which a previous release does not
    // know (it refuses them as unknown fields): the spec a deployment of that release runs. The
    // bundle the harness packs names both with --id and --version instead.
    prepare(app) {
      execFileSync(
        process.execPath,
        [join(REPO, 'examples', 'team-notes', 'build.mjs'), '--release=v1', `--out=${app}`],
        { stdio: ['ignore', 'ignore', 'inherit'] },
      );
      const spec = join(app, 'rayspec.yaml');
      const lines = readFileSync(spec, 'utf8').split('\n');
      const kept = lines.filter((l) => !/^ {2}(?:id|version): /.test(l));
      if (lines.length - kept.length !== 2)
        fail('the team-notes spec does not name its id and version');
      writeFileSync(spec, kept.join('\n'));
    },
    table: 'notes',
    path: '/api/notes',
    note: (title) => ({ title, content: `${title} — Grüße, 東京` }),
    columns: 'id, tenant_id, title, content, created_by, created_at, deleted_at',
  },
  'asset-catalog': {
    // The release build less what a previous release does not know: `metadata.id`,
    // `metadata.version` and `deployment.egressHosts` in the spec (it refuses unknown fields), and
    // the `uses` right list on the extension's handler fragments (its handler grammar is strict).
    // The compiled extension and its vendored dependencies are otherwise the release's.
    prepare(app) {
      buildAssetCatalog(app);
      const spec = join(app, 'rayspec.yaml');
      const lines = readFileSync(spec, 'utf8').split('\n');
      const kept = lines.filter(
        (l) => !/^ {2}(?:id|version): /.test(l) && !/^ {2}egressHosts: /.test(l),
      );
      if (lines.length - kept.length !== 3) {
        fail('the asset-catalog spec does not name its id, version and egress hosts');
      }
      const deployment = kept.indexOf('deployment:');
      if (deployment < 0) fail('the asset-catalog spec has no deployment section');
      // The section held only the egress hosts and their comment: drop it whole.
      let end = deployment + 1;
      while (end < kept.length && /^ {2}#/.test(kept[end] ?? '')) end += 1;
      kept.splice(deployment, end - deployment);
      writeFileSync(spec, kept.join('\n'));
      const entry = join(app, 'packs', 'catalog-pack', 'index.js');
      const source = readFileSync(entry, 'utf8');
      const stripped = source.replace(/\s*uses: \[\],?/g, '');
      if ((source.match(/uses: \[\]/g) ?? []).length !== 2 || /uses:/.test(stripped)) {
        fail('the compiled asset-catalog extension does not declare uses on its two handlers');
      }
      writeFileSync(entry, stripped);
    },
    release(app) {
      const fresh = join(work, 'asset-catalog-release');
      buildAssetCatalog(fresh);
      for (const file of ['rayspec.yaml', join('packs', 'catalog-pack', 'index.js')]) {
        cpSync(join(fresh, file), join(app, file));
      }
    },
    runtime(app, which) {
      const modules = join(app, 'node_modules', '@rayspec');
      rmSync(join(app, 'node_modules'), { recursive: true, force: true });
      if (which === 'none') return;
      mkdirSync(modules, { recursive: true });
      for (const [name, dir] of [
        ['platform', join('kernel', 'platform')],
        ['handler-sdk', join('kernel', 'handler-sdk')],
      ]) {
        symlinkSync(
          which === 'previous'
            ? join(work, 'previous', 'node_modules', '@rayspec', name)
            : candidate !== null
              ? join(candidate, 'node_modules', '@rayspec', name)
              : join(REPO, 'packages', dir),
          join(modules, name),
        );
      }
    },
    egress: 'classifier.example.com',
    table: 'catalog_items',
    path: '/api/items',
    note: (title) => ({ name: title, file_name: `${title.split(' ').join('-')}.pdf` }),
    columns: 'id, tenant_id, name, file_name, content_type, category, created_by, created_at',
  },
};

/** The asset-catalog release build, written to `out`. */
function buildAssetCatalog(out) {
  execFileSync(
    process.execPath,
    [join(REPO, 'examples', 'asset-catalog', 'build.mjs'), `--out=${out}`],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl)
  fail('DATABASE_URL is not set: it names the server the throwaway database is created on');
const { values: flags } = parseArgs({
  options: {
    from: { type: 'string' },
    app: { type: 'string', default: 'notes-ui' },
    'log-dir': { type: 'string' },
    port: { type: 'string' },
    roles: { type: 'boolean', default: false },
    candidate: { type: 'string' },
  },
});
/**
 * With `--candidate <dir>`, the side upgraded to is the release a consumer installed from the
 * candidate tarballs into `<dir>` (`scripts/check-consumer-install.mjs`), never the workspace: its
 * CLI, its database roles setup and its `@rayspec` packages for an extension.
 */
const candidate = flags.candidate === undefined ? null : resolve(flags.candidate);
function candidateCli(dir) {
  const launcher = join(dir, 'node_modules', 'rayspec', 'package.json');
  if (!existsSync(launcher)) fail(`--candidate ${dir} holds no installed rayspec`);
  return join(
    dir,
    'node_modules',
    'rayspec',
    JSON.parse(readFileSync(launcher, 'utf8')).bin.rayspec,
  );
}
const CLI = candidate === null ? WORKING_TREE_CLI : candidateCli(candidate);
if (!existsSync(CLI)) {
  fail(`the working tree is not built (${CLI} is missing): run pnpm build first`);
}
const APP = APPS[flags.app];
if (APP === undefined) {
  fail(`--app ${flags.app} is not one of: ${Object.keys(APPS).join(', ')}`);
}
const logDir = flags['log-dir'];
/**
 * A TCP port on 127.0.0.1 that nothing listens on at the moment of the call. Never one derived from
 * the process id: a server left over from an earlier run can hold such a port.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const assigned = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() =>
        assigned > 0 ? resolve(assigned) : reject(new Error('no port was assigned')),
      );
    });
  });
}
const port = flags.port !== undefined ? Number(flags.port) : await freePort();
const suiteDb = `rayspec_upgrade_${process.pid}`;
const appUrl = withDbName(baseUrl, suiteDb);
const shadowUrl = process.env.SHADOW_DATABASE_URL ?? baseUrl;
const work = mkdtempSync(join(tmpdir(), 'rayspec-upgrade-'));
const children = new Set();
/** The local services an application calls (its HTTPS host and the egress proxy), closed at the end. */
const services = [];
const summary = { app: flags.app, roles: flags.roles, from: null, to: null, checks: [] };
/** With `--roles`: the roles the database is prepared with, named for this run, and their passwords. */
const roleSuffix = randomBytes(4).toString('hex');
const roles = {
  migration: `rsu_${roleSuffix}_migrator`,
  runtime: `rsu_${roleSuffix}_runtime`,
  snapshot: `rsu_${roleSuffix}_snapshot`,
};
const rolePasswords = {
  migration: randomBytes(16).toString('hex'),
  runtime: randomBytes(16).toString('hex'),
  snapshot: randomBytes(16).toString('hex'),
};

function fail(message) {
  process.stderr.write(`UPGRADE-WITH-DATA: FAIL — ${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

function check(name, ok, detail = '') {
  summary.checks.push({ name, ok });
  if (!ok) fail(`${name}${detail === '' ? '' : `: ${detail}`}`);
}

function withDbName(url, name) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

function log(line) {
  process.stderr.write(`[upgrade-with-data] ${line}\n`);
}

/**
 * The environment every boot gets: the explicit configuration and nothing from this process, and
 * for an application that calls a host, the proxy and the certificate authority it reaches it by.
 */
function bootEnv(secrets, egress) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    DATABASE_URL: appUrl,
    SHADOW_DATABASE_URL: shadowUrl,
    RAYSPEC_JWT_SIGNING_KEY: secrets.jwt,
    RAYSPEC_API_KEY_PEPPER: secrets.pepper,
    RAYSPEC_SKIP_DOTENV: '1',
    ALLOWED_ORIGINS: '',
    ...(egress === null
      ? {}
      : {
          NODE_USE_ENV_PROXY: '1',
          HTTPS_PROXY: `http://127.0.0.1:${egress.proxy.port}`,
          NO_PROXY: '127.0.0.1,localhost',
          NODE_EXTRA_CA_CERTS: egress.caFile,
        }),
  };
}

/** `db`'s connection as one of the prepared roles. */
function roleUrl(db, role) {
  const u = new URL(withDbName(baseUrl, db));
  u.username = roles[role];
  u.password = rolePasswords[role];
  return u.toString();
}

/**
 * Turn role separation on for the database the previous release wrote, as an operator does: run the
 * working tree's database roles setup in it (and in its workflow system database, when the previous
 * release made one) and give each role a password. Returns what the boots add to their environment.
 */
async function prepareRoles() {
  const setup = readFileSync(
    candidate === null
      ? join(REPO, 'packages', 'kernel', 'db', 'sql', 'database-roles.sql')
      : join(candidate, 'node_modules', '@rayspec', 'db', 'sql', 'database-roles.sql'),
    'utf8',
  );
  const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1, onnotice: () => {} });
  const sysDb = `${suiteDb}_dbos_sys`;
  let databases;
  try {
    const found = await admin.unsafe('SELECT 1 FROM pg_database WHERE datname = $1', [sysDb]);
    databases = [
      [suiteDb, 'application'],
      ...(found.length > 0 ? [[sysDb, 'workflow-system']] : []),
    ];
  } finally {
    await admin.end();
  }
  for (const [db, kind] of databases) {
    const sql = postgres(withDbName(baseUrl, db), { max: 1, onnotice: () => {} });
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(
          `SELECT set_config('rayspec.migration_role', $1, true), set_config('rayspec.runtime_role', $2, true),
                  set_config('rayspec.snapshot_role', $3, true), set_config('rayspec.database_kind', $4, true)`,
          [roles.migration, roles.runtime, roles.snapshot, kind],
        );
        await tx.unsafe(setup);
      });
      if (kind === 'application') {
        for (const key of ['migration', 'runtime', 'snapshot']) {
          const [statement] = await sql.unsafe(
            "SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS stmt",
            [roles[key], rolePasswords[key]],
          );
          await sql.unsafe(statement.stmt);
        }
      }
    } finally {
      await sql.end();
    }
  }
  return {
    DATABASE_URL: roleUrl(suiteDb, 'runtime'),
    RAYSPEC_MIGRATION_DATABASE_URL: roleUrl(suiteDb, 'migration'),
    RAYSPEC_SNAPSHOT_DATABASE_URL: roleUrl(suiteDb, 'snapshot'),
    ...(databases.length > 1 ? { DBOS_SYSTEM_DATABASE_URL: roleUrl(sysDb, 'runtime') } : {}),
  };
}

/**
 * With `--roles`, that the deploy `served` holds the migration role in a supervisor: exactly one
 * application process runs under it, and the database sees only the runtime role while it serves.
 */
async function checkSupervised(when, served, sql) {
  let children = [];
  try {
    children = execFileSync('pgrep', ['-P', String(served.pid)], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.trim() !== '');
  } catch {
    children = [];
  }
  check(`${when}: the deploy serves through one application process`, children.length === 1);
  const users = await sql.unsafe(
    `SELECT DISTINCT usename FROM pg_stat_activity
      WHERE datname = current_database() AND usename IS NOT NULL AND usename <> current_user`,
  );
  check(
    `${when}: only the runtime role is connected while it serves`,
    JSON.stringify(users.map((u) => u.usename)) === JSON.stringify([roles.runtime]),
    JSON.stringify(users.map((u) => u.usename)),
  );
}

/** Start a deploy that serves, and wait until /health answers 200. */
async function serve(label, command, args, cwd, env) {
  const child = spawn(process.execPath, [command, ...args, '--port', String(port)], { cwd, env });
  children.add(child);
  let output = '';
  let stdout = '';
  child.stdout.on('data', (d) => {
    output += String(d);
    stdout += String(d);
  });
  child.stderr.on('data', (d) => {
    output += String(d);
  });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (child.exitCode !== null) {
      await exited;
      save(label, output);
      fail(`the ${label} deploy exited ${child.exitCode} before it served`);
    }
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).status === 200) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      save(label, output);
      fail(`the ${label} deploy did not serve within 180 s`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    pid: child.pid,
    async stop() {
      child.kill('SIGTERM');
      const code = await exited;
      children.delete(child);
      save(label, output);
      return { code, stdout };
    },
  };
}

function save(label, output) {
  if (!logDir) return;
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, `${label}.log`), output);
}

async function api(method, path, { bearer, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

/** Every row of the tables a user relies on, as stored: an ordered digest per table. */
async function storedRows(sql) {
  const tables = {
    [APP.table]: `SELECT ${APP.columns} FROM ${APP.table} ORDER BY id`,
    users: 'SELECT id, email, password_hash FROM users ORDER BY id',
    orgs: 'SELECT id, name, slug FROM orgs ORDER BY id',
    memberships: 'SELECT org_id, user_id, role, status FROM memberships ORDER BY org_id, user_id',
    api_keys:
      'SELECT id, org_id, key_prefix, key_hash, scopes, revoked_at FROM api_keys ORDER BY id',
  };
  const out = {};
  for (const [name, query] of Object.entries(tables)) {
    const rows = await sql.unsafe(query);
    out[name] = {
      count: rows.length,
      sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    };
  }
  return out;
}

async function main() {
  const from =
    flags.from ?? execFileSync('npm', ['view', 'rayspec', 'version'], { encoding: 'utf8' }).trim();
  const to = JSON.parse(
    readFileSync(
      candidate === null
        ? join(REPO, 'packages', 'app', 'cli', 'package.json')
        : join(candidate, 'node_modules', 'rayspec', 'package.json'),
      'utf8',
    ),
  ).version;
  summary.from = from;
  summary.to = `${to} (${candidate === null ? 'working tree' : 'candidate install'})`;
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(from)) fail('--from is not a version');

  // 1. The previous release, from npm, with install scripts disabled.
  const previous = join(work, 'previous');
  mkdirSync(previous);
  writeFileSync(join(previous, 'package.json'), '{"private":true}\n');
  log(`installing rayspec@${from} from npm`);
  execFileSync(
    'npm',
    ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--no-save', `rayspec@${from}`],
    { cwd: previous, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const previousCli = join(previous, 'node_modules', 'rayspec', 'dist', 'bin.js');
  check('the previous release is installed', existsSync(previousCli));

  // A throwaway database, the application and fresh secrets.
  const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${suiteDb}" WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE "${suiteDb}"`);
  await admin.end();
  const app = join(work, 'app');
  APP.prepare(app);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const secrets = {
    jwt: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    pepper: randomBytes(32).toString('hex'),
  };
  let egress = null;
  if (APP.egress !== undefined) {
    const certs = testCertificates(join(work, 'tls'), APP.egress);
    const classifier = await startClassifier(certs);
    services.push(classifier);
    const proxy = await startEgressProxy(classifier.port, () => [APP.egress]);
    services.push(proxy);
    egress = { proxy, caFile: certs.caFile };
  }
  const env = bootEnv(secrets, egress);
  const sql = postgres(appUrl, { max: 2, onnotice: () => {} });

  try {
    // 2. The previous release deploys the example; a user writes data through it.
    log(`deploying with rayspec ${from}`);
    APP.runtime?.(app, 'previous');
    const old = await serve('previous', previousCli, ['deploy', 'rayspec.yaml'], app, env);
    const email = `upgrade-${randomBytes(4).toString('hex')}@example.com`;
    const password = randomBytes(18).toString('base64url');
    const registered = await api('POST', '/v1/auth/register', { body: { email, password } });
    check(
      'register on the previous release',
      [200, 201].includes(registered.status),
      registered.text,
    );
    const org = await api('POST', '/v1/orgs', {
      bearer: registered.json.accessToken,
      body: { name: 'Upgrade', slug: `upgrade-${randomBytes(3).toString('hex')}` },
    });
    check('create an organization on the previous release', org.status === 201, org.text);
    const switched = await api('POST', `/v1/orgs/${org.json.id}/switch`, {
      bearer: registered.json.accessToken,
    });
    check('switch into the organization', switched.status === 200, switched.text);
    const token = switched.json.accessToken;
    const minted = await api('POST', `/v1/orgs/${org.json.id}/api-keys`, {
      bearer: token,
      body: { name: 'upgrade', scopes: ['store:read'] },
    });
    check('mint an API key on the previous release', minted.status === 201, minted.text);
    const apiKey = minted.json.plaintext;
    const titles = ['first note', 'second note', 'third note'];
    for (const title of titles) {
      const created = await api('POST', APP.path, { bearer: token, body: APP.note(title) });
      check(`write "${title}" on the previous release`, created.status === 201, created.text);
    }
    const stopped = await old.stop();
    check('the previous release stops cleanly', stopped.code === 0);

    // 3. What is stored before the upgrade.
    const before = await storedRows(sql);
    const headBefore = await sql.unsafe(
      'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
    );
    // With --roles, the operator turns role separation on with the upgrade.
    let upgradeEnv = env;
    if (flags.roles) {
      log('preparing the database roles');
      upgradeEnv = { ...env, ...(await prepareRoles()) };
    }

    // 4. The working tree boots the same spec on that database.
    log('deploying the same spec with the working tree');
    APP.runtime?.(app, 'working-tree');
    const upgraded = await serve('upgraded', CLI, ['deploy', 'rayspec.yaml'], app, upgradeEnv);
    if (flags.roles) await checkSupervised('after the upgrade', upgraded, sql);
    const headAfter = await sql.unsafe(
      'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
    );
    summary.platformMigrations = { before: headBefore[0].n, after: headAfter[0].n };
    check('the platform chain moved forward', headAfter[0].n >= headBefore[0].n);

    // 5. Rows, credentials and behavior.
    const after = await storedRows(sql);
    for (const table of Object.keys(before)) {
      check(
        `${table}: every stored row is unchanged`,
        JSON.stringify(after[table]) === JSON.stringify(before[table]),
      );
    }
    await verifyServing('after the upgrade', {
      email,
      password,
      orgId: org.json.id,
      apiKey,
      titles,
    });
    const added = await api('POST', APP.path, {
      bearer: (await login(email, password, org.json.id)).token,
      body: APP.note('written after the upgrade'),
    });
    check('write a note after the upgrade', added.status === 201, added.text);
    titles.push('written after the upgrade');
    check('the upgraded deployment stops cleanly', (await upgraded.stop()).code === 0);

    // 6. The same application as a bundle, deployed onto the upgraded environment.
    log('packing the application and deploying it as a bundle');
    APP.runtime?.(app, 'none');
    APP.release?.(app);
    const packed = execFileSync(
      process.execPath,
      [
        CLI,
        'pack',
        '--spec',
        'rayspec.yaml',
        '--output',
        `${flags.app}.ray`,
        '--id',
        flags.app,
        '--version',
        '1.0.0',
      ],
      { cwd: app, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    check('pack the application', JSON.parse(packed).ok === true);
    const planned = JSON.parse(
      execFileSync(process.execPath, [CLI, 'deploy', `${flags.app}.ray`, '--dry-run'], {
        cwd: app,
        env: upgradeEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
    check('plan the bundle deploy', planned.ok === true, JSON.stringify(planned.errors));
    check(
      'the plan has no blocker',
      planned.data.plan.blockers.length === 0,
      JSON.stringify(planned.data.plan.blockers),
    );
    const bundled = await serve(
      'bundle',
      CLI,
      ['deploy', `${flags.app}.ray`, '--plan-digest', planned.data.planDigest],
      app,
      upgradeEnv,
    );
    if (flags.roles) await checkSupervised('after the bundle deploy', bundled, sql);
    await verifyServing('after the bundle deploy', {
      email,
      password,
      orgId: org.json.id,
      apiKey,
      titles,
    });
    const bundleStop = await bundled.stop();
    check('the bundle deployment stops cleanly', bundleStop.code === 0);
    // stdout is the one envelope: the durable runtime's startup lines go to stderr.
    let envelope = {};
    try {
      envelope = JSON.parse(bundleStop.stdout);
    } catch {
      envelope = {};
    }
    check(
      'the bundle deploy reports its envelope, alone on stdout',
      envelope.ok === true && envelope.operation === 'deploy',
    );
    const final = await storedRows(sql);
    check(
      'users, orgs, memberships and api_keys are unchanged by the bundle deploy',
      ['users', 'orgs', 'memberships', 'api_keys'].every(
        (t) => JSON.stringify(final[t]) === JSON.stringify(before[t]),
      ),
    );
  } finally {
    await sql.end().catch(() => {});
  }
}

async function login(email, password, orgId) {
  const res = await api('POST', '/v1/auth/login', { body: { email, password } });
  check('log in with the password set before the upgrade', res.status === 200, res.text);
  const switched = await api('POST', `/v1/orgs/${orgId}/switch`, { bearer: res.json.accessToken });
  check('switch into the organization', switched.status === 200, switched.text);
  return { token: switched.json.accessToken };
}

async function verifyServing(when, { email, password, orgId, apiKey, titles }) {
  const { token } = await login(email, password, orgId);
  const byUser = await api('GET', APP.path, { bearer: token });
  check(
    `the user reads every note ${when}`,
    byUser.status === 200 && titles.every((t) => byUser.text.includes(t)),
    byUser.text,
  );
  const byKey = await api('GET', APP.path, { bearer: apiKey });
  check(
    `the API key reads every note ${when}`,
    byKey.status === 200 && titles.every((t) => byKey.text.includes(t)),
    String(byKey.status),
  );
  const live = await fetch(`http://127.0.0.1:${port}/livez`);
  check(`/livez answers ${when}`, live.status === 200);
}

async function cleanup() {
  for (const child of children) child.kill('SIGKILL');
  for (const service of services.splice(0)) await service.close().catch(() => {});
  try {
    const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1, onnotice: () => {} });
    for (const db of [suiteDb, `${suiteDb}_dbos_sys`]) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    }
    if (flags.roles) {
      for (const role of Object.values(roles)) await admin.unsafe(`DROP ROLE IF EXISTS "${role}"`);
    }
    await admin.end();
  } catch {
    // the database server is gone; nothing left to drop
  }
  execFileSync('chmod', ['-R', 'u+w', work]);
  rmSync(work, { recursive: true, force: true });
}

const started = Date.now();
try {
  await main();
  summary.ok = true;
} catch (err) {
  summary.ok = false;
  summary.error = err instanceof Error ? err.message : String(err);
  process.exitCode = 1;
} finally {
  await cleanup();
  summary.seconds = Math.round((Date.now() - started) / 1000);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
