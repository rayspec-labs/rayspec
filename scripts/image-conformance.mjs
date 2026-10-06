#!/usr/bin/env node
/**
 * image-conformance — the runtime image of a release candidate, checked as an operator runs it.
 *
 * The image is the one in the OCI archive the release manifest names, loaded into the local engine
 * (`docker load`); the run first proves the loaded image is that one. Then:
 *
 *   1. ITS CONFIGURATION. linux/amd64; a USER that is not root; a health check; the version and
 *      source-commit labels of the release; Node at the patch the Dockerfile pins; the working
 *      directory /var/lib/rayspec; port 8080 on every address.
 *   2. INSIDE IT. The process runs as a user other than root, on Node at the pinned patch; /bin/sh
 *      is there (the supervisor of a role-separated deploy re-executes itself through it); the
 *      installation is owned by root and not one file of it or of the PostgreSQL client tools is
 *      writable by that user; /var/lib/rayspec is that user's, mode 0700; npm, npx, corepack and
 *      yarn are gone; `rayspec --version` names the release; `rayspec-serve` is on PATH; pg_dump and
 *      pg_restore are PostgreSQL 16. ffmpeg and ffprobe are the Debian version the Dockerfile pins,
 *      and the audio capability installed in the image stitches two Ogg-Opus chunks, encoded there,
 *      into one stream of their combined length, as that same user.
 *   3. THE CONTRACT CORPUS, through the image's own CLI (`scripts/corpus-conformance.mjs`, mounted
 *      read-only with the corpus).
 *   4. A REFERENCE APPLICATION SERVED BY IT. The team-notes application (release 1.0.0) is packed,
 *      planned and deployed by the image as its own user, against a PostgreSQL container prepared
 *      with the shipped database roles setup, with role separation on, `--ulimit core=0`, the
 *      bundle mounted read-only and the state on a volume. The container must turn healthy through
 *      its own health check, answer /livez and /health, register a user, write and read a note,
 *      serve through a supervisor and its one application process, and stop with exit 0 on SIGTERM.
 *
 *   node scripts/image-conformance.mjs --oci <archive> --image <loaded ref> --consumer <dir>
 *        [--generated <dir>] [--work <dir>] [--report <file>]
 *
 * `--consumer` is the tree `scripts/check-consumer-install.mjs` installed from the same tarballs
 * (it supplies the database roles setup and EXPECTATIONS.json); `--generated` holds the corpus cases
 * written at test time (`tsx scripts/gen-corpus.ts --uncommitted <dir>`). Every container, network
 * and volume the run starts carries its own name and is removed at the end. No provider credential
 * is read. Prints one JSON report; exit 0 when every check held, 1 otherwise, 2 on usage.
 */
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { POSTGRES_IMAGE } from './journeys/lib.mjs';
import { isEntryPoint } from './lib/entry.mjs';
import { readOciImage } from './release-manifest.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export const DOCKERFILE = join(REPO, 'deployments', 'runtime-image', 'Dockerfile');
/** The image's working directory, which holds the state directory and the blob root. */
export const STATE_DIR = '/var/lib/rayspec';

/** The Node patch the Dockerfile pins in its base image (`node:<x.y.z>-...@sha256:...`). */
export function pinnedNodeVersion(dockerfile) {
  const m = /^ARG NODE_IMAGE=node:(\d+\.\d+\.\d+)-[^@\s]+@sha256:[a-f0-9]{64}$/m.exec(dockerfile);
  return m === null ? null : m[1];
}

/**
 * The ffmpeg the Dockerfile pins: Debian's package version (`ARG FFMPEG_VERSION=<epoch>:<version>`)
 * and the moment of the archive it is installed from (`ARG DEBIAN_SNAPSHOT=<yyyymmddThhmmssZ>`).
 * Null unless both are pinned exactly.
 */
export function pinnedFfmpeg(dockerfile) {
  const version = /^ARG FFMPEG_VERSION=((?:\d+:)?\d[0-9A-Za-z.+~-]*)$/m.exec(dockerfile);
  const snapshot = /^ARG DEBIAN_SNAPSHOT=(\d{8}T\d{6}Z)$/m.exec(dockerfile);
  return version === null || snapshot === null
    ? null
    : { version: version[1], snapshot: snapshot[1] };
}

/**
 * The files the corpus run inside the image needs, mounted read-only at their path under
 * /conformance: the runner and every module it imports.
 */
export const CORPUS_RUNNER_FILES = [
  ['scripts/corpus-conformance.mjs', '/conformance/corpus-conformance.mjs'],
  ['scripts/lib/entry.mjs', '/conformance/lib/entry.mjs'],
];

/** The script run inside the image for its own facts; it prints one JSON object. */
export const INSIDE_PROBE = `
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const writable = [];
let walked = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    walked++;
    if (entry.isSymbolicLink()) continue;
    try { fs.accessSync(p, fs.constants.W_OK); writable.push(p); } catch {}
    if (entry.isDirectory()) walk(p);
  }
}
for (const root of ['/opt/rayspec', '/opt/pgtools']) {
  try { fs.accessSync(root, fs.constants.W_OK); writable.push(root); } catch {}
  walk(root);
}
const onPath = (name) => (process.env.PATH || '').split(':').some((d) => { try { fs.accessSync(path.join(d, name), fs.constants.X_OK); return true; } catch { return false; } });
let shell = false;
try { fs.accessSync('/bin/sh', fs.constants.X_OK); shell = true; } catch {}
const owner = (p) => { try { const st = fs.statSync(p); return { uid: st.uid, mode: st.mode & 0o7777 }; } catch { return null; } };
const version = spawnSync('rayspec', ['--version'], { encoding: 'utf8' });
const tool = (name) => spawnSync(name, ['--version'], { encoding: 'utf8' }).stdout.trim();
console.log(JSON.stringify({
  uid: process.getuid(),
  node: process.version,
  cwd: process.cwd(),
  stateDir: owner('/var/lib/rayspec'),
  installation: owner('/opt/rayspec'),
  shell,
  walked,
  writable: writable.slice(0, 20),
  writableCount: writable.length,
  packageManagers: ['npm', 'npx', 'corepack', 'yarn', 'yarnpkg'].filter(onPath),
  rayspecVersion: (() => { try { return JSON.parse(version.stdout).version; } catch { return null; } })(),
  rayspecServe: onPath('rayspec-serve'),
  pgDump: tool('pg_dump'),
  pgRestore: tool('pg_restore'),
}));
`;

/** The audio capability as the image installed it; its root exports `remuxChunks`. */
export const AUDIO_RUNTIME = '/opt/rayspec/node_modules/@rayspec/audio-runtime/dist/index.js';

/**
 * The script run inside the image for its media tools; it prints one JSON object. Two one-second
 * Ogg-Opus chunks are encoded with the image's ffmpeg, each a stream of its own as a recording
 * client uploads them, and handed to the capability's own `remuxChunks`, which runs ffmpeg's concat
 * demuxer and probes the result with ffprobe.
 */
export const MEDIA_PROBE = `
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const banner = (name) => {
  const res = spawnSync(name, ['-version'], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.split('\\n')[0] : null;
};
(async () => {
  const facts = { ffmpeg: banner('ffmpeg'), ffprobe: banner('ffprobe'), chunks: 0, remux: null, error: null };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'media-probe-'));
  try {
    const chunks = [];
    for (const frequency of [440, 660]) {
      const file = path.join(work, frequency + '.opus');
      const made = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', 'sine=frequency=' + frequency + ':duration=1', '-c:a', 'libopus', file], { encoding: 'utf8' });
      if (made.status !== 0) throw new Error('ffmpeg encoded no chunk: ' + (made.stderr || made.error));
      chunks.push(new Uint8Array(fs.readFileSync(file)));
    }
    facts.chunks = chunks.length;
    const { remuxChunks } = await import('${AUDIO_RUNTIME}');
    const stitched = await remuxChunks(chunks);
    facts.remux = { bytes: stitched.bytes.length, durationS: stitched.durationS };
    await stitched.cleanup();
  } catch (err) {
    facts.error = String((err && err.message) || err);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log(JSON.stringify(facts));
})();
`;

/**
 * The judgement of the media probe's facts against the ffmpeg the Dockerfile pins. Debian's ffmpeg
 * names its package version without the epoch (`ffmpeg version 7.1.5-0+deb13u1`).
 */
export function judgeMedia(facts, pinned) {
  const version = pinned === null ? null : pinned.version.replace(/^\d+:/, '');
  const names = (banner, tool) =>
    version !== null &&
    typeof banner === 'string' &&
    banner.startsWith(`${tool} version ${version} `);
  return [
    [`ffmpeg is ${version}, the version the Dockerfile pins`, names(facts.ffmpeg, 'ffmpeg')],
    [`ffprobe is ${version}, the version the Dockerfile pins`, names(facts.ffprobe, 'ffprobe')],
    [
      'the audio capability stitches two Ogg-Opus chunks into one stream of their length',
      facts.error === null &&
        facts.chunks === 2 &&
        facts.remux !== null &&
        facts.remux.bytes > 0 &&
        facts.remux.durationS > 1.5 &&
        facts.remux.durationS < 2.5,
    ],
  ];
}

/** The judgement of the inside probe's facts against the release version and the pinned Node. */
export function judgeInside(facts, version, nodeVersion) {
  return [
    ['the process runs as a user other than root', facts.uid !== 0],
    [`Node is ${nodeVersion}, the pinned patch`, facts.node === `v${nodeVersion}`],
    ['/bin/sh is present for the supervisor', facts.shell === true],
    ['the installation was walked', facts.walked > 100],
    ['the installation is owned by root', facts.installation?.uid === 0],
    ['no file of the installation is writable by the runtime user', facts.writableCount === 0],
    [
      `${STATE_DIR} is the working directory, the runtime user's, mode 0700`,
      facts.cwd === STATE_DIR &&
        facts.stateDir?.uid === facts.uid &&
        facts.stateDir?.mode === 0o700,
    ],
    ['npm, npx, corepack and yarn are removed', facts.packageManagers.length === 0],
    [`rayspec --version names ${version}`, facts.rayspecVersion === version],
    ['rayspec-serve is on PATH', facts.rayspecServe === true],
    ['pg_dump is PostgreSQL 16', /^pg_dump \(PostgreSQL\) 16\./.test(facts.pgDump)],
    ['pg_restore is PostgreSQL 16', /^pg_restore \(PostgreSQL\) 16\./.test(facts.pgRestore)],
  ];
}

/**
 * The judgement of the loaded image's configuration against the archive it came from and the Node
 * patch the Dockerfile pins.
 */
export function judgeConfig(inspect, archive, nodeVersion) {
  const config = inspect.Config ?? {};
  const env = new Map(
    (config.Env ?? []).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]),
  );
  return [
    [
      'the loaded image is the one in the archive',
      inspect.Id === archive.configDigest || inspect.Id === archive.digest,
    ],
    ['linux/amd64', inspect.Os === 'linux' && inspect.Architecture === 'amd64'],
    [
      'a USER other than root',
      typeof config.User === 'string' &&
        config.User !== '' &&
        config.User !== 'root' &&
        !/^0(?::|$)/.test(config.User),
    ],
    [
      'a health check',
      Array.isArray(config.Healthcheck?.Test) && config.Healthcheck.Test.length > 1,
    ],
    [
      'the version and source-commit labels of the archive',
      config.Labels?.['org.opencontainers.image.version'] ===
        archive.labels['org.opencontainers.image.version'] &&
        config.Labels?.['org.opencontainers.image.revision'] ===
          archive.labels['org.opencontainers.image.revision'],
    ],
    [
      `Node ${nodeVersion}, the patch the Dockerfile pins`,
      typeof nodeVersion === 'string' &&
        env.get('NODE_VERSION') === nodeVersion &&
        archive.nodeVersion === nodeVersion,
    ],
    [`the working directory is ${STATE_DIR}`, config.WorkingDir === STATE_DIR],
    [
      'port 8080 on every address of the container',
      env.get('PORT') === '8080' &&
        env.get('RAYSPEC_HOST') === '0.0.0.0' &&
        Object.hasOwn(config.ExposedPorts ?? {}, '8080/tcp'),
    ],
  ];
}

function docker(args, options = {}) {
  const res = spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

async function api(base, method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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

async function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        oci: { type: 'string' },
        image: { type: 'string' },
        consumer: { type: 'string' },
        generated: { type: 'string' },
        work: { type: 'string' },
        report: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    process.stderr.write(`usage: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  for (const flag of ['oci', 'image', 'consumer']) {
    if (values[flag] === undefined) {
      process.stderr.write(`usage: --${flag} is required\n`);
      return 2;
    }
  }
  const image = values.image;
  const consumer = resolve(values.consumer);
  const work =
    values.work === undefined
      ? mkdtempSync(join(tmpdir(), 'rayspec-image-'))
      : resolve(values.work);
  mkdirSync(work, { recursive: true });
  const suffix = randomBytes(4).toString('hex');
  const names = {
    network: `rayspec-image-check-${suffix}`,
    pg: `rayspec-image-check-pg-${suffix}`,
    app: `rayspec-image-check-app-${suffix}`,
    volume: `rayspec-image-check-state-${suffix}`,
  };
  const report = { image, checks: [], ok: false };
  const log = (line) => process.stderr.write(`[image-conformance] ${line}\n`);
  const check = (name, ok, detail) => {
    report.checks.push({ name, ok: Boolean(ok) });
    log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`);
    if (!ok) throw new Error(`${name}${detail === undefined ? '' : ` — ${detail}`}`);
  };
  try {
    // 1. The configuration of the loaded image, against the archive.
    const archive = readOciImage(resolve(values.oci));
    report.digest = archive.digest;
    report.version = archive.labels['org.opencontainers.image.version'];
    const nodeVersion = pinnedNodeVersion(readFileSync(DOCKERFILE, 'utf8'));
    check('the Dockerfile pins a Node patch', nodeVersion !== null);
    report.nodeVersion = nodeVersion;
    const inspected = docker(['image', 'inspect', image]);
    check('the image is loaded', inspected.status === 0, inspected.stderr.trim());
    for (const [name, ok] of judgeConfig(JSON.parse(inspected.stdout)[0], archive, nodeVersion)) {
      check(name, ok);
    }

    // 2. Inside it.
    const inside = docker(['run', '--rm', '--entrypoint', 'node', image, '-e', INSIDE_PROBE]);
    check('the inside probe runs', inside.status === 0, inside.stderr.trim().slice(0, 400));
    const facts = JSON.parse(inside.stdout.trim().split('\n').at(-1));
    report.inside = facts;
    for (const [name, ok] of judgeInside(facts, report.version, nodeVersion)) check(name, ok);
    const pinned = pinnedFfmpeg(readFileSync(DOCKERFILE, 'utf8'));
    check('the Dockerfile pins ffmpeg and the archive it comes from', pinned !== null);
    report.ffmpeg = pinned;
    const media = docker(['run', '--rm', '--entrypoint', 'node', image, '-e', MEDIA_PROBE]);
    check('the media probe runs', media.status === 0, media.stderr.trim().slice(0, 400));
    const mediaFacts = JSON.parse(media.stdout.trim().split('\n').at(-1));
    report.media = mediaFacts;
    for (const [name, ok] of judgeMedia(mediaFacts, pinned))
      check(name, ok, mediaFacts.error ?? undefined);

    // 3. The contract corpus through the image's CLI.
    const corpusArgs = [
      'run',
      '--rm',
      '--entrypoint',
      'node',
      ...CORPUS_RUNNER_FILES.flatMap(([file, at]) => ['-v', `${join(REPO, file)}:${at}:ro`]),
      '-v',
      `${join(REPO, 'packages', 'kernel', 'bundle-contract', 'corpus')}:/conformance/corpus:ro`,
      ...(values.generated === undefined
        ? []
        : ['-v', `${resolve(values.generated)}:/conformance/generated:ro`]),
      image,
      '/conformance/corpus-conformance.mjs',
      '--cli',
      '/opt/rayspec/node_modules/rayspec/dist/bin.js',
      '--expectations',
      '/opt/rayspec/node_modules/@rayspec/bundle-contract/contract/fixtures/EXPECTATIONS.json',
      '--corpus',
      '/conformance/corpus',
      ...(values.generated === undefined ? [] : ['--generated', '/conformance/generated']),
    ];
    const corpus = docker(corpusArgs);
    let corpusReport = null;
    try {
      corpusReport = JSON.parse(corpus.stdout);
    } catch {
      corpusReport = null;
    }
    report.corpus =
      corpusReport === null ? null : { ...corpusReport, failed: corpusReport.failed.slice(0, 20) };
    check(
      'the contract corpus holds through the image CLI',
      corpus.status === 0 && corpusReport?.ok === true,
      corpusReport === null ? corpus.stderr.slice(0, 400) : `${corpusReport.failed.length} failed`,
    );

    // 4. A reference application served by the image.
    check('a network of its own', docker(['network', 'create', names.network]).status === 0);
    const pgPassword = randomBytes(12).toString('hex');
    const pg = docker(
      [
        'run',
        '-d',
        '--name',
        names.pg,
        '--network',
        names.network,
        '--network-alias',
        'pg',
        '-e',
        'POSTGRES_USER=rayspec',
        '-e',
        'POSTGRES_PASSWORD',
        '-e',
        'POSTGRES_DB=app',
        POSTGRES_IMAGE,
      ],
      { env: { ...process.env, POSTGRES_PASSWORD: pgPassword } },
    );
    check('a PostgreSQL 16 container', pg.status === 0, pg.stderr.trim());
    const psql = (db, sql) =>
      docker(
        ['exec', '-i', names.pg, 'psql', '-U', 'rayspec', '-d', db, '-v', 'ON_ERROR_STOP=1', '-q'],
        { input: sql },
      );
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      ready = psql('app', 'SELECT 1').status === 0;
      if (!ready) await pause(1000);
    }
    check('PostgreSQL accepts connections', ready);
    check('a shadow database', psql('postgres', 'CREATE DATABASE shadow;').status === 0);
    const roles = {
      migration: `rsi_${suffix}_migrator`,
      runtime: `rsi_${suffix}_runtime`,
      snapshot: `rsi_${suffix}_snapshot`,
    };
    const passwords = Object.fromEntries(
      Object.keys(roles).map((k) => [k, randomBytes(12).toString('hex')]),
    );
    const setup = readFileSync(
      join(consumer, 'node_modules', '@rayspec', 'db', 'sql', 'database-roles.sql'),
      'utf8',
    );
    const prepared = psql(
      'app',
      [
        'BEGIN;',
        `SELECT set_config('rayspec.migration_role', '${roles.migration}', true), set_config('rayspec.runtime_role', '${roles.runtime}', true), set_config('rayspec.snapshot_role', '${roles.snapshot}', true), set_config('rayspec.database_kind', 'application', true);`,
        setup,
        'COMMIT;',
        ...Object.entries(roles).map(
          ([k, role]) => `ALTER ROLE "${role}" PASSWORD '${passwords[k]}';`,
        ),
      ].join('\n'),
    );
    check(
      'the shipped database roles setup prepares the database',
      prepared.status === 0,
      prepared.stderr.slice(0, 400),
    );
    const url = (role, db = 'app') => `postgres://${roles[role]}:${passwords[role]}@pg:5432/${db}`;

    const app = join(work, 'team-notes');
    const built = spawnSync(
      process.execPath,
      [join(REPO, 'examples', 'team-notes', 'build.mjs'), '--release=v1', `--out=${app}`],
      { encoding: 'utf8' },
    );
    check('build the team-notes application', built.status === 0, built.stderr);
    const out = join(work, 'bundle');
    mkdirSync(out, { recursive: true });
    // The image's user writes the bundle here; the directory is the run's own scratch space.
    chmodSync(out, 0o777);
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const secretEnv = {
      ...process.env,
      SHADOW_DATABASE_URL: `postgres://rayspec:${pgPassword}@pg:5432/shadow`,
      DATABASE_URL: url('runtime'),
      RAYSPEC_MIGRATION_DATABASE_URL: url('migration'),
      RAYSPEC_SNAPSHOT_DATABASE_URL: url('snapshot'),
      RAYSPEC_JWT_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      RAYSPEC_API_KEY_PEPPER: randomBytes(32).toString('base64'),
      RAYSPEC_BLOB_ROOT: '/var/lib/rayspec/blobs',
      ALLOWED_ORIGINS: '',
    };
    const passEnv = (...keys) => keys.flatMap((k) => ['-e', k]);
    const packed = docker(
      [
        'run',
        '--rm',
        '--network',
        names.network,
        '-v',
        `${app}:/srv/app:ro`,
        '-v',
        `${out}:/srv/out`,
        ...passEnv('SHADOW_DATABASE_URL'),
        image,
        'pack',
        '--spec',
        '/srv/app/rayspec.yaml',
        '--output',
        '/srv/out/team-notes.ray',
        '--json',
      ],
      { env: secretEnv },
    );
    check('the image packs the application', packed.status === 0, packed.stdout.slice(0, 400));
    const appEnv = passEnv(
      'SHADOW_DATABASE_URL',
      'DATABASE_URL',
      'RAYSPEC_MIGRATION_DATABASE_URL',
      'RAYSPEC_SNAPSHOT_DATABASE_URL',
      'RAYSPEC_JWT_SIGNING_KEY',
      'RAYSPEC_API_KEY_PEPPER',
      'RAYSPEC_BLOB_ROOT',
      'ALLOWED_ORIGINS',
    );
    const common = [
      '--network',
      names.network,
      '--ulimit',
      'core=0',
      '-v',
      `${out}:/srv/app:ro`,
      '-v',
      `${names.volume}:/var/lib/rayspec`,
      ...appEnv,
    ];
    const dry = docker(
      [
        'run',
        '--rm',
        ...common,
        image,
        'deploy',
        '/srv/app/team-notes.ray',
        '--dry-run',
        '--state-dir',
        '/var/lib/rayspec/state',
        '--json',
      ],
      { env: secretEnv },
    );
    let plan = null;
    try {
      plan = JSON.parse(dry.stdout);
    } catch {
      plan = null;
    }
    check(
      'the image plans the deploy',
      dry.status === 0 && plan?.ok === true,
      (dry.stdout || dry.stderr).slice(0, 400),
    );
    check(
      'the plan has no blocker',
      plan.data.plan.blockers.length === 0,
      JSON.stringify(plan.data.plan.blockers),
    );
    const port = 20000 + Math.floor(Math.random() * 20000);
    const started = docker(
      [
        'run',
        '-d',
        '--name',
        names.app,
        '-p',
        `127.0.0.1:${port}:8080`,
        ...common,
        image,
        'deploy',
        '/srv/app/team-notes.ray',
        '--plan-digest',
        plan.data.planDigest,
        '--state-dir',
        '/var/lib/rayspec/state',
      ],
      { env: secretEnv },
    );
    check('the image deploys the bundle', started.status === 0, started.stderr.trim());
    let health = '';
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      health = docker([
        'inspect',
        '--format',
        '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',
        names.app,
      ]).stdout.trim();
      if (health === 'running healthy' || !health.startsWith('running')) break;
      await pause(2000);
    }
    report.health = health;
    if (health !== 'running healthy')
      report.appLog = docker(['logs', '--tail', '60', names.app]).stderr.slice(-4000);
    check(
      'the container turns healthy through its own health check',
      health === 'running healthy',
      health,
    );
    const base = `http://127.0.0.1:${port}`;
    check('/livez answers 200', (await fetch(`${base}/livez`)).status === 200);
    check('/health answers 200', (await fetch(`${base}/health`)).status === 200);
    const email = `image-${suffix}@example.test`;
    const password = randomBytes(18).toString('base64url');
    const registered = await api(base, 'POST', '/v1/auth/register', { body: { email, password } });
    check('register a user', [200, 201].includes(registered.status), registered.text.slice(0, 200));
    const org = await api(base, 'POST', '/v1/orgs', {
      token: registered.json.accessToken,
      body: { name: 'Image check' },
    });
    check('create an organization', org.status === 201, org.text.slice(0, 200));
    const switched = await api(base, 'POST', `/v1/orgs/${org.json.id}/switch`, {
      token: registered.json.accessToken,
    });
    check('switch into it', switched.status === 200, switched.text.slice(0, 200));
    const token = switched.json.accessToken;
    const created = await api(base, 'POST', '/api/notes', {
      token,
      body: { title: 'from the image', content: 'Grüße, 東京' },
    });
    check('write a note', created.status === 201, created.text.slice(0, 200));
    const listed = await api(base, 'GET', '/api/notes', { token });
    check(
      'read it back',
      listed.status === 200 && listed.text.includes('from the image'),
      listed.text.slice(0, 200),
    );
    const top = docker(['top', names.app, '-o', 'pid,ppid,args']);
    const nodes = top.stdout.split('\n').filter((l) => /\bnode\b/.test(l));
    report.processes = nodes.length;
    check(
      'it serves through a supervisor and one application process',
      nodes.length === 2,
      top.stdout,
    );
    check('docker stop ends it', docker(['stop', '--time', '60', names.app]).status === 0);
    const exit = docker(['inspect', '--format', '{{.State.ExitCode}}', names.app]).stdout.trim();
    check('it exits 0 on SIGTERM', exit === '0', exit);
    report.ok = true;
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
  } finally {
    for (const container of [names.app, names.pg]) docker(['rm', '-f', '-v', container]);
    docker(['volume', 'rm', '-f', names.volume]);
    docker(['network', 'rm', names.network]);
    if (values.work === undefined) {
      spawnSync('chmod', ['-R', 'u+w', work]);
      rmSync(work, { recursive: true, force: true });
    }
  }
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (values.report !== undefined) writeFileSync(resolve(values.report), text);
  process.stdout.write(text);
  return report.ok ? 0 : 1;
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
