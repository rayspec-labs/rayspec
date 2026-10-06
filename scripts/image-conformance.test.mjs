#!/usr/bin/env node
/**
 * Regression test for the judgements of the runtime-image check (`image-conformance.mjs`), without
 * a container engine: what the loaded image's configuration and the probe inside it must show.
 *
 *   - the configuration passes for the image of the archive and fails, check by check, for another
 *     image, another platform, a root or missing USER, no health check, other labels, another Node
 *     patch than the Dockerfile pins, another working directory, and another port or address;
 *   - the inside facts pass for the expected image and fail, check by check, for root, another
 *     Node, a missing /bin/sh, an installation not owned by root, a writable installation file, a
 *     state directory of another owner or mode, a package manager left in, another version, a
 *     missing rayspec-serve and client tools of another PostgreSQL major;
 *   - the pinned Node patch is read from the Dockerfile, and nothing else passes for one;
 *   - the pinned ffmpeg is read from the Dockerfile, which installs exactly it from the Debian
 *     archive of the pinned moment, without recommended packages, and checks it during the build;
 *   - the media facts pass for the pinned ffmpeg and a stitched recording of the chunks' length,
 *     and fail, check by check, for a missing or other ffmpeg or ffprobe, a refused remux, a chunk
 *     that was never encoded, and a recording that is empty or of another length;
 *   - the probe script is the one the check runs, and walks both installation roots; the media
 *     probe calls the audio capability the image installed;
 *   - the corpus run in the image mounts every module the runner imports.
 *
 * Standalone: `node <thisfile>`; exit 0 = pass.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUDIO_RUNTIME,
  CORPUS_RUNNER_FILES,
  DOCKERFILE,
  INSIDE_PROBE,
  judgeConfig,
  judgeInside,
  judgeMedia,
  MEDIA_PROBE,
  pinnedFfmpeg,
  pinnedNodeVersion,
} from './image-conformance.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '1.9.0-rc.0';
const NODE = '22.23.3';
const archive = {
  nodeVersion: NODE,
  digest: `sha256:${'1a'.repeat(32)}`,
  configDigest: `sha256:${'2b'.repeat(32)}`,
  labels: {
    'org.opencontainers.image.version': VERSION,
    'org.opencontainers.image.revision': '3c'.repeat(20),
  },
};
const inspect = {
  Id: archive.configDigest,
  Os: 'linux',
  Architecture: 'amd64',
  Config: {
    User: 'rayspec:rayspec',
    Env: ['PATH=/usr/bin', `NODE_VERSION=${NODE}`, 'RAYSPEC_HOST=0.0.0.0', 'PORT=8080'],
    ExposedPorts: { '8080/tcp': {} },
    WorkingDir: '/var/lib/rayspec',
    Healthcheck: { Test: ['CMD', 'node', '/opt/rayspec/healthcheck.mjs'] },
    Labels: { ...archive.labels },
  },
};
const facts = {
  uid: 10001,
  node: `v${NODE}`,
  cwd: '/var/lib/rayspec',
  stateDir: { uid: 10001, mode: 0o700 },
  installation: { uid: 0, mode: 0o755 },
  shell: true,
  walked: 50000,
  writableCount: 0,
  packageManagers: [],
  rayspecVersion: VERSION,
  rayspecServe: true,
  pgDump: 'pg_dump (PostgreSQL) 16.14 (Debian 16.14-1.pgdg13+1)',
  pgRestore: 'pg_restore (PostgreSQL) 16.14 (Debian 16.14-1.pgdg13+1)',
};

const failing = (judged) => judged.filter(([, ok]) => !ok).map(([name]) => name);
let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`ok   ${label}`);
};

check('the configuration of the archive image passes', () => {
  assert.deepEqual(failing(judgeConfig(inspect, archive, NODE)), []);
  assert.deepEqual(failing(judgeConfig({ ...inspect, Id: archive.digest }, archive, NODE)), []);
});

check('every configuration defect is its own failed check', () => {
  const cases = [
    [{ ...inspect, Id: `sha256:${'9f'.repeat(32)}` }, 'the loaded image is the one in the archive'],
    [{ ...inspect, Architecture: 'arm64' }, 'linux/amd64'],
    [{ ...inspect, Config: { ...inspect.Config, User: '' } }, 'a USER other than root'],
    [{ ...inspect, Config: { ...inspect.Config, User: '0:0' } }, 'a USER other than root'],
    [{ ...inspect, Config: { ...inspect.Config, User: 'root' } }, 'a USER other than root'],
    [
      { ...inspect, Config: { ...inspect.Config, Healthcheck: { Test: ['NONE'] } } },
      'a health check',
    ],
    [
      {
        ...inspect,
        Config: {
          ...inspect.Config,
          Labels: { ...archive.labels, 'org.opencontainers.image.version': '1.8.0' },
        },
      },
      'the version and source-commit labels of the archive',
    ],
    [
      {
        ...inspect,
        Config: {
          ...inspect.Config,
          Env: ['NODE_VERSION=22.22.0', 'RAYSPEC_HOST=0.0.0.0', 'PORT=8080'],
        },
      },
      `Node ${NODE}, the patch the Dockerfile pins`,
    ],
    [
      { ...inspect, Config: { ...inspect.Config, WorkingDir: '/' } },
      'the working directory is /var/lib/rayspec',
    ],
    [
      {
        ...inspect,
        Config: {
          ...inspect.Config,
          Env: [`NODE_VERSION=${NODE}`, 'RAYSPEC_HOST=127.0.0.1', 'PORT=8080'],
        },
      },
      'port 8080 on every address of the container',
    ],
    [
      { ...inspect, Config: { ...inspect.Config, ExposedPorts: { '3000/tcp': {} } } },
      'port 8080 on every address of the container',
    ],
  ];
  for (const [image, name] of cases) {
    assert.deepEqual(failing(judgeConfig(image, archive, NODE)), [name]);
  }
  // The archive itself names another Node than the one pinned.
  assert.deepEqual(failing(judgeConfig(inspect, { ...archive, nodeVersion: '22.22.0' }, NODE)), [
    `Node ${NODE}, the patch the Dockerfile pins`,
  ]);
  assert.ok(
    failing(judgeConfig(inspect, archive, null)).length > 0,
    'no pinned patch never passes',
  );
});

check('the inside facts of the expected image pass', () => {
  assert.deepEqual(failing(judgeInside(facts, VERSION, NODE)), []);
});

check('every inside defect is its own failed check', () => {
  const cases = [
    [{ uid: 0, stateDir: { uid: 0, mode: 0o700 } }, 'the process runs as a user other than root'],
    [{ node: 'v22.22.0' }, `Node is ${NODE}, the pinned patch`],
    [{ installation: { uid: 10001, mode: 0o755 } }, 'the installation is owned by root'],
    [{ installation: null }, 'the installation is owned by root'],
    [
      { stateDir: { uid: 0, mode: 0o700 } },
      "/var/lib/rayspec is the working directory, the runtime user's, mode 0700",
    ],
    [
      { stateDir: { uid: 10001, mode: 0o755 } },
      "/var/lib/rayspec is the working directory, the runtime user's, mode 0700",
    ],
    [{ cwd: '/' }, "/var/lib/rayspec is the working directory, the runtime user's, mode 0700"],
    [{ shell: false }, '/bin/sh is present for the supervisor'],
    [{ walked: 3 }, 'the installation was walked'],
    [{ writableCount: 1 }, 'no file of the installation is writable by the runtime user'],
    [{ packageManagers: ['npm'] }, 'npm, npx, corepack and yarn are removed'],
    [{ rayspecVersion: '1.8.0' }, `rayspec --version names ${VERSION}`],
    [{ rayspecServe: false }, 'rayspec-serve is on PATH'],
    [{ pgDump: 'pg_dump (PostgreSQL) 15.8' }, 'pg_dump is PostgreSQL 16'],
    [{ pgRestore: '' }, 'pg_restore is PostgreSQL 16'],
  ];
  for (const [change, name] of cases) {
    assert.deepEqual(failing(judgeInside({ ...facts, ...change }, VERSION, NODE)), [name]);
  }
});

check('the probe walks both installation roots and reports through one JSON line', () => {
  assert.match(INSIDE_PROBE, /'\/opt\/rayspec', '\/opt\/pgtools'/);
  assert.match(INSIDE_PROBE, /console\.log\(JSON\.stringify\(/);
  const syntax = spawnSync(process.execPath, ['--check', '-'], {
    input: INSIDE_PROBE,
    encoding: 'utf8',
  });
  assert.equal(syntax.status, 0, syntax.stderr);
});

check('the pinned Node patch is read from the Dockerfile', () => {
  const pinned = pinnedNodeVersion(readFileSync(DOCKERFILE, 'utf8'));
  assert.match(pinned ?? '', /^22\.\d+\.\d+$/);
  const digest = 'ab'.repeat(32);
  assert.equal(
    pinnedNodeVersion(`ARG NODE_IMAGE=node:22.23.3-trixie-slim@sha256:${digest}\n`),
    NODE,
  );
  assert.equal(pinnedNodeVersion('ARG NODE_IMAGE=node:22-trixie-slim\n'), null);
  assert.equal(pinnedNodeVersion(`ARG NODE_IMAGE=node:22.23.3-trixie-slim\n`), null);
});

check('the pinned ffmpeg is read from the Dockerfile, which installs and checks it', () => {
  const dockerfile = readFileSync(DOCKERFILE, 'utf8');
  const pinned = pinnedFfmpeg(dockerfile);
  assert.match(pinned?.version ?? '', /^\d+:\d+\.\d+(\.\d+)?-[0-9A-Za-z.+~]+$/);
  assert.match(pinned?.snapshot ?? '', /^\d{8}T\d{6}Z$/);
  assert.deepEqual(
    pinnedFfmpeg('ARG FFMPEG_VERSION=7:7.1.5-0+deb13u1\nARG DEBIAN_SNAPSHOT=20261001T000000Z\n'),
    { version: '7:7.1.5-0+deb13u1', snapshot: '20261001T000000Z' },
  );
  assert.equal(pinnedFfmpeg('ARG FFMPEG_VERSION=7:7.1.5-0+deb13u1\n'), null);
  assert.equal(pinnedFfmpeg('ARG DEBIAN_SNAPSHOT=20261001T000000Z\n'), null);
  assert.equal(
    pinnedFfmpeg('ARG FFMPEG_VERSION=latest\nARG DEBIAN_SNAPSHOT=20261001T000000Z\n'),
    null,
  );
  assert.equal(
    pinnedFfmpeg('ARG FFMPEG_VERSION=7:7.1.5-0+deb13u1\nARG DEBIAN_SNAPSHOT=2026-10-01\n'),
    null,
  );
  // The install names the pinned version and archive, leaves out what Debian only recommends,
  // removes the package lists, and proves both tools and the stitch during the build.
  assert.match(dockerfile, /snapshot\.debian\.org\/archive\/%s\/%s/);
  assert.match(dockerfile, /"\$\{DEBIAN_SNAPSHOT\}"/);
  assert.match(
    dockerfile,
    /apt-get install -y --no-install-recommends "ffmpeg=\$\{FFMPEG_VERSION\}"/,
  );
  assert.match(dockerfile, /rm -rf \/var\/lib\/apt\/lists\/\*/);
  assert.match(dockerfile, /^ {4}ffmpeg -version; \\$/m);
  assert.match(dockerfile, /^ {4}ffprobe -version; \\$/m);
  assert.match(dockerfile, /-f concat -safe 0 -i "\$work\/list\.txt" -c copy/);
  assert.match(dockerfile, /-c:a libopus/);
});

const PINNED = { version: '7:7.1.5-0+deb13u1', snapshot: '20261001T000000Z' };
const media = {
  ffmpeg: 'ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers',
  ffprobe: 'ffprobe version 7.1.5-0+deb13u1 Copyright (c) 2007-2026 the FFmpeg developers',
  chunks: 2,
  remux: { bytes: 21000, durationS: 2.0135 },
  error: null,
};

check('the media facts of the expected image pass', () => {
  assert.deepEqual(failing(judgeMedia(media, PINNED)), []);
});

check('every media defect is its own failed check', () => {
  const version = '7.1.5-0+deb13u1';
  const ffmpeg = `ffmpeg is ${version}, the version the Dockerfile pins`;
  const ffprobe = `ffprobe is ${version}, the version the Dockerfile pins`;
  const stitch =
    'the audio capability stitches two Ogg-Opus chunks into one stream of their length';
  const cases = [
    [{ ffmpeg: null }, ffmpeg],
    [{ ffmpeg: 'ffmpeg version 7.1.4-0+deb13u1 Copyright' }, ffmpeg],
    [{ ffmpeg: 'ffmpeg version 7.1.5-0+deb13u10 Copyright' }, ffmpeg],
    [{ ffprobe: null }, ffprobe],
    [{ ffprobe: media.ffmpeg }, ffprobe],
    [{ remux: null, error: "remux: ffmpeg failed to start ('ffmpeg' — ENOENT)" }, stitch],
    [{ error: 'remux: ffprobe found 2 audio stream(s)' }, stitch],
    [{ chunks: 0, remux: null, error: 'ffmpeg encoded no chunk' }, stitch],
    [{ remux: { bytes: 0, durationS: 2 } }, stitch],
    [{ remux: { bytes: 21000, durationS: 1.0 } }, stitch],
    [{ remux: { bytes: 21000, durationS: 4.0 } }, stitch],
  ];
  for (const [change, name] of cases) {
    assert.deepEqual(failing(judgeMedia({ ...media, ...change }, PINNED)), [name]);
  }
  assert.equal(failing(judgeMedia(media, null)).length, 2, 'no pinned ffmpeg never passes');
});

check('the media probe calls the audio capability the image installed', () => {
  assert.equal(AUDIO_RUNTIME, '/opt/rayspec/node_modules/@rayspec/audio-runtime/dist/index.js');
  assert.ok(MEDIA_PROBE.includes(`await import('${AUDIO_RUNTIME}')`));
  assert.match(MEDIA_PROBE, /remuxChunks\(chunks\)/);
  assert.match(MEDIA_PROBE, /console\.log\(JSON\.stringify\(facts\)\)/);
  const syntax = spawnSync(process.execPath, ['--check', '-'], {
    input: MEDIA_PROBE,
    encoding: 'utf8',
  });
  assert.equal(syntax.status, 0, syntax.stderr);
});

check('the corpus run in the image mounts every module the runner imports', () => {
  const [[runner, at]] = CORPUS_RUNNER_FILES;
  const source = readFileSync(join(REPO, runner), 'utf8');
  const relative = [...source.matchAll(/^import .* from '(\.[^']+)';$/gm)].map((m) => m[1]);
  assert.ok(relative.length > 0, 'the runner imports a module of its own');
  const mounted = new Map(CORPUS_RUNNER_FILES);
  for (const spec of relative) {
    const file = join(dirname(runner), spec);
    assert.equal(
      mounted.get(file),
      join(dirname(at), spec),
      `${file} is mounted beside the runner`,
    );
  }
});

console.log(`ALL CASES PASSED (${passed})`);
