#!/usr/bin/env node
/**
 * Regression test for the judgements of the runtime-image check (`image-conformance.mjs`), without
 * a container engine: what the loaded image's configuration and the probe inside it must show.
 *
 *   - the configuration passes for the image of the archive and fails, check by check, for another
 *     image, another platform, a root or missing USER, no health check, or other labels;
 *   - the inside facts pass for the expected image and fail, check by check, for root, a missing
 *     /bin/sh, a writable installation file, a package manager left in, another version, a missing
 *     rayspec-serve and client tools of another PostgreSQL major;
 *   - the probe script is the one the check runs, and walks both installation roots.
 *
 * Standalone: `node <thisfile>`; exit 0 = pass.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { INSIDE_PROBE, judgeConfig, judgeInside } from './image-conformance.mjs';

const VERSION = '1.9.0-rc.0';
const archive = {
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
    Healthcheck: { Test: ['CMD', 'node', '/opt/rayspec/healthcheck.mjs'] },
    Labels: { ...archive.labels },
  },
};
const facts = {
  uid: 10001,
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
  assert.deepEqual(failing(judgeConfig(inspect, archive)), []);
  assert.deepEqual(failing(judgeConfig({ ...inspect, Id: archive.digest }, archive)), []);
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
  ];
  for (const [image, name] of cases) assert.deepEqual(failing(judgeConfig(image, archive)), [name]);
});

check('the inside facts of the expected image pass', () => {
  assert.deepEqual(failing(judgeInside(facts, VERSION)), []);
});

check('every inside defect is its own failed check', () => {
  const cases = [
    [{ uid: 0 }, 'the process runs as a user other than root'],
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
    assert.deepEqual(failing(judgeInside({ ...facts, ...change }, VERSION)), [name]);
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

console.log(`ALL CASES PASSED (${passed})`);
