#!/usr/bin/env node
/**
 * Regression test for the reference journeys' own logic — the parts that decide what runs, not the
 * journeys themselves (those need a database and run as `pnpm test:journeys`).
 *
 *   (Q) the committed quickstart page plans: the install is done by the harness, the clone keeps the
 *       page's tag and path and reaches a local repository, every other command runs as written, the
 *       deploy that serves ends the first session, the second session uses it, and the restart the
 *       page names runs with the first session's exports and no plan digest.
 *   (M) a page that drops or repeats a substituted line refuses, naming it.
 *   (S) a page without a serving deploy, or with two, refuses; an unclosed block refuses; a page that
 *       names no restart, or two, refuses.
 *   (A) the arguments: every journey by default, an unknown one or a positional refuses.
 *   (R) the script refuses usage errors and a missing DATABASE_URL with exit 2, before any work.
 *   (D) the digests compare values, not key order, and notice a changed value.
 *   (J) a failed check ends a journey with its name.
 *   (C) a pre-release runtime: the built extension's @rayspec ranges are set to the candidate's own
 *       caret range and the change is returned; a release version changes nothing.
 *   (I) the image form: the three application journeys by default, the quickstart refused, a network
 *       only with an image; the stand-in CLI runs `docker run` with the journey's arguments, working
 *       directory and user, passes every variable by name and never its value, drops the ones the
 *       image has its own of, returns the container's exit code and passes SIGTERM to the container.
 *
 * Standalone (no test framework is wired for the gate scripts): `node <thisfile>`; exit 0 = pass.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonical,
  IMAGE_ENV_DROPPED,
  imageCliSource,
  Journey,
  JourneyFailure,
  platformRangesForRuntime,
  rowsDigest,
} from './journeys/lib.mjs';
import { bashBlocks, quickstartPlan, SUBSTITUTIONS } from './journeys/quickstart.mjs';
import { JOURNEYS, parseJourneyArgs } from './reference-journeys.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'reference-journeys.mjs');
const PAGE = readFileSync(join(here, '..', 'docs', 'quickstart.md'), 'utf8');

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`ok   ${label}`);
};

// (Q)
check('(Q) the quickstart page plans with the harness doing the install', () => {
  const plan = quickstartPlan(PAGE);
  assert.deepEqual(plan.harness, ['install']);
  assert.ok(
    plan.first.includes(
      'git clone --depth 1 --branch "v$VERSION" "$QUICKSTART_REPOSITORY" rayspec-src',
    ),
    'the clone keeps the tag and the path, and reaches the local repository',
  );
  assert.ok(plan.first.includes('node rayspec-src/examples/team-notes/build.mjs --release=v1'));
  const restart = plan.restart.split('\n');
  assert.equal(restart.at(-1), 'npx rayspec deploy team-notes-1.0.0.ray');
  assert.ok(restart.slice(0, -1).every((l) => l.startsWith('export ')));
  assert.ok(restart.includes('export DATABASE_URL="$QUICKSTART_DATABASE_URL"'));
  assert.ok(restart.some((l) => l.startsWith('export RAYSPEC_JWT_SIGNING_KEY_FILE=')));
  assert.ok(plan.blocks >= 5, `${plan.blocks} blocks`);
  const firstLines = plan.first.split('\n');
  assert.ok(
    firstLines.some((l) => l.startsWith('npx rayspec pack --spec team-notes/rayspec.yaml')),
  );
  assert.ok(firstLines.some((l) => l.startsWith('npx rayspec bundle verify ')));
  assert.equal(
    firstLines
      .filter((l) => l.trim() !== '')
      .at(-1)
      ?.startsWith('npx rayspec deploy '),
    true,
    'the first session ends with the serving deploy',
  );
  assert.ok(plan.first.includes('export DATABASE_URL="$QUICKSTART_DATABASE_URL"'));
  assert.ok(!plan.first.includes('localhost:5433'), 'the page database URLs are replaced');
  assert.ok(plan.second.includes('BASE="http://127.0.0.1:$PORT"'));
  assert.ok(plan.second.includes('/api/notes'));
  // Every line of the page that is not substituted is in one of the two scripts, as written.
  const substituted = new Set(SUBSTITUTIONS.map((s) => s.line));
  for (const line of bashBlocks(PAGE).flat()) {
    if (substituted.has(line.trim())) continue;
    assert.ok(`${plan.first}\n${plan.second}`.split('\n').includes(line), line);
  }
});

// (M)
check('(M) a page that drops or repeats a substituted line refuses, naming it', () => {
  const dropped = PAGE.replace('npm install rayspec\n', 'npm install rayspec@latest\n');
  assert.notEqual(dropped, PAGE, 'precondition: the page holds the install line');
  assert.throws(() => quickstartPlan(dropped), /npm install rayspec \(0 times\)/);
  const repeated = PAGE.replace(
    'BASE=http://127.0.0.1:8080\n',
    'BASE=http://127.0.0.1:8080\nBASE=http://127.0.0.1:8080\n',
  );
  assert.notEqual(repeated, PAGE, 'precondition: the page holds the base URL line');
  assert.throws(() => quickstartPlan(repeated), /BASE=http:\/\/127\.0\.0\.1:8080 \(2 times\)/);
});

// (S)
check('(S) no serving deploy, two of them, or an unclosed block refuse', () => {
  const serve = /^npx rayspec deploy team-notes-1\.0\.0\.ray --plan-digest .*$/m;
  assert.ok(serve.test(PAGE), 'precondition: the page holds the serving deploy');
  assert.throws(
    () => quickstartPlan(PAGE.replace(serve, 'echo no deploy')),
    /exactly one block, found 0/,
  );
  const line = PAGE.match(serve)[0];
  const twice = PAGE.replace('```bash\nBASE=', `\`\`\`bash\n${line}\n\`\`\`\n\n\`\`\`bash\nBASE=`);
  assert.notEqual(twice, PAGE);
  assert.throws(() => quickstartPlan(twice), /exactly one block, found 2/);
  assert.throws(() => bashBlocks('```bash\nls\n'), /not closed/);
  const restart = '`npx rayspec deploy team-notes-1.0.0.ray`';
  assert.ok(PAGE.includes(restart), 'precondition: the page names the restart');
  assert.throws(
    () => quickstartPlan(PAGE.replace(restart, 'the deploy')),
    /one restart command, found 0/,
  );
  assert.throws(
    () => quickstartPlan(PAGE.replace(restart, `${restart} or ${restart}`)),
    /one restart command, found 2/,
  );
});

// (A)
check('(A) every journey by default; an unknown journey or a positional refuses', () => {
  const all = parseJourneyArgs([]);
  assert.deepEqual(all.apps, Object.keys(JOURNEYS));
  assert.deepEqual(Object.keys(JOURNEYS), [
    'team-notes',
    'document-intake',
    'asset-catalog',
    'quickstart',
  ]);
  assert.deepEqual(parseJourneyArgs(['--app', 'quickstart', '--app', 'team-notes']).apps, [
    'quickstart',
    'team-notes',
  ]);
  assert.match(parseJourneyArgs(['--app', 'nope']).error, /unknown --app nope/);
  assert.ok('error' in parseJourneyArgs(['stray']));
  assert.ok('error' in parseJourneyArgs(['--unknown-flag']));
});

// (R)
check('(R) usage errors and a missing DATABASE_URL exit 2 before any work', () => {
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  const usage = spawnSync(process.execPath, [SCRIPT, '--app', 'nope'], { env, encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /unknown --app/);
  const noDb = spawnSync(process.execPath, [SCRIPT, '--app', 'team-notes'], {
    env,
    encoding: 'utf8',
  });
  assert.equal(noDb.status, 2);
  assert.match(noDb.stderr, /DATABASE_URL is not set/);
  assert.equal(noDb.stdout, '');
});

// (D)
check('(D) digests compare values, not key or row order, and notice a changed value', () => {
  assert.equal(
    canonical({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }),
    canonical({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }),
  );
  assert.notEqual(canonical({ a: [1, 2] }), canonical({ a: [2, 1] }));
  const rows = [
    { id: '1', title: 'Grüße', content: null },
    { id: '2', title: 'b', content: 'x' },
  ];
  const columns = ['id', 'title', 'content'];
  assert.equal(rowsDigest(rows, columns), rowsDigest([...rows].reverse(), columns));
  assert.notEqual(
    rowsDigest(rows, columns),
    rowsDigest([rows[0], { ...rows[1], content: 'y' }], columns),
  );
  assert.notEqual(rowsDigest(rows, columns), rowsDigest(rows.slice(0, 1), columns));
});

// (J)
check('(J) a failed check ends the journey with its name and records it', () => {
  const journey = new Journey('sample', () => {});
  journey.check('first passes', true);
  assert.throws(
    () => journey.check('second fails', false, 'why'),
    (err) => {
      assert.ok(err instanceof JourneyFailure);
      assert.equal(err.message, 'sample: second fails — why');
      return true;
    },
  );
  assert.deepEqual(journey.checks, [
    { name: 'first passes', ok: true },
    { name: 'second fails', ok: false },
  ]);
});

// (I)
check('(I) the image form runs the application journeys and refuses the quickstart', () => {
  const args = parseJourneyArgs(['--image', 'rayspec-candidate:1.9.0-rc.0']);
  assert.deepEqual(args.apps, ['team-notes', 'document-intake', 'asset-catalog']);
  assert.deepEqual(args.image, { ref: 'rayspec-candidate:1.9.0-rc.0', network: 'host' });
  assert.match(
    parseJourneyArgs(['--image', 'x', '--app', 'quickstart']).error,
    /quickstart journey runs the installed tree/,
  );
  assert.match(
    parseJourneyArgs(['--image-network', 'bridge']).error,
    /--image-network needs --image/,
  );
  assert.equal(
    parseJourneyArgs(['--image', 'x', '--image-network', 'container:h']).image.network,
    'container:h',
  );
});

// (C)
check('(C) a pre-release runtime gets the extension ranges it needs, and a release none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rayspec-journeys-range-'));
  try {
    const path = join(dir, 'package.json');
    const original = {
      name: 'catalog-pack',
      dependencies: {
        '@rayspec/platform': '^1.8.0',
        '@rayspec/handler-sdk': '^1.8.0',
        'mime-types': '3.0.2',
      },
    };
    writeFileSync(path, `${JSON.stringify(original, null, 2)}\n`);
    assert.deepEqual(platformRangesForRuntime(path, '1.9.0'), []);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), original);
    assert.deepEqual(platformRangesForRuntime(path, '1.9.0-rc.0'), [
      { name: '@rayspec/platform', from: '^1.8.0', to: '^1.9.0-rc.0' },
      { name: '@rayspec/handler-sdk', from: '^1.8.0', to: '^1.9.0-rc.0' },
    ]);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).dependencies, {
      '@rayspec/platform': '^1.9.0-rc.0',
      '@rayspec/handler-sdk': '^1.9.0-rc.0',
      'mime-types': '3.0.2',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const scratch = mkdtempSync(join(tmpdir(), 'rayspec-journeys-image-'));
const realScratch = realpathSync(scratch);
try {
  // A `docker` stand-in: `run` records its arguments and the values of the variables it was asked
  // to pass, then waits for a signal or exits with the code in FAKE_EXIT; `kill` records itself.
  const bin = join(scratch, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  const log = join(scratch, 'docker.log');
  writeFileSync(
    join(bin, 'docker'),
    [
      `#!${process.execPath}`,
      "const { appendFileSync } = require('node:fs');",
      'const argv = process.argv.slice(2);',
      'const passed = [];',
      "for (let i = 0; i < argv.length; i++) if (argv[i] === '-e' && !argv[i + 1].includes('=')) passed.push(argv[i + 1]);",
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, values: Object.fromEntries(passed.map((k) => [k, process.env[k]])) }) + '\\n');`,
      "if (argv[0] === 'run' && process.env.FAKE_WAIT === '1') setTimeout(() => {}, 60000);",
      "else process.exit(Number(process.env.FAKE_EXIT ?? '0'));",
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'docker'), 0o755);
  const wrapper = join(scratch, 'rayspec-in-image.cjs');
  writeFileSync(
    wrapper,
    imageCliSource({
      image: 'rayspec-candidate:1.9.0-rc.0',
      network: 'host',
      label: 'rayspec-journey-run=test',
      mounts: [scratch],
      user: '1001:1001',
      home: scratch,
    }),
  );
  const baseEnv = { PATH: `${bin}:${process.env.PATH}`, HOME: '/home/someone' };
  const entries = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));

  check('(I) the stand-in passes arguments, directory, user and variables by name', () => {
    const run = spawnSync(process.execPath, [wrapper, 'bundle', 'verify', 'a b.ray', '--json'], {
      cwd: scratch,
      env: {
        ...baseEnv,
        DATABASE_URL: 'postgres://u:secret-value@127.0.0.1/db',
        RAYSPEC_PG_DUMP: '/usr/bin/pg_dump',
        FAKE_EXIT: '3',
      },
      encoding: 'utf8',
    });
    assert.equal(run.status, 3, 'the container exit code is the exit code');
    const [{ argv, values }] = entries();
    assert.deepEqual(argv.slice(0, 2), ['run', '--rm']);
    assert.deepEqual(argv.slice(-5), [
      'rayspec-candidate:1.9.0-rc.0',
      'bundle',
      'verify',
      'a b.ray',
      '--json',
    ]);
    for (const [flag, value] of [
      ['--network', 'host'],
      ['--user', '1001:1001'],
      // Real paths: on macOS the temporary directory is reached through the /var link.
      ['-w', realScratch],
      ['--label', 'rayspec-journey-run=test'],
      ['-v', `${realScratch}:${realScratch}`],
      ['--ulimit', 'core=0'],
    ]) {
      assert.equal(argv[argv.indexOf(flag) + 1], value, flag);
    }
    assert.ok(!argv.some((a) => a.includes('secret-value')), 'no value on the command line');
    assert.equal(values.DATABASE_URL, 'postgres://u:secret-value@127.0.0.1/db');
    for (const name of IMAGE_ENV_DROPPED) assert.ok(!(name in values), `${name} is dropped`);
    assert.ok(argv.includes(`HOME=${scratch}`));
  });

  check(
    '(I) a mount and a working directory reached through a symbolic link are real paths',
    () => {
      writeFileSync(log, '');
      const target = join(realScratch, 'linked-target');
      mkdirSync(target, { recursive: true });
      const link = join(scratch, 'linked');
      symlinkSync(target, link);
      const linked = join(scratch, 'rayspec-in-image-linked.cjs');
      writeFileSync(
        linked,
        imageCliSource({
          image: 'rayspec-candidate:1.9.0-rc.0',
          network: 'host',
          label: 'rayspec-journey-run=test',
          mounts: [link],
          user: '1001:1001',
          home: link,
        }),
      );
      const run = spawnSync(process.execPath, [linked, '--version'], {
        cwd: link,
        env: baseEnv,
        encoding: 'utf8',
      });
      assert.equal(run.status, 0, run.stderr);
      const [{ argv }] = entries();
      assert.notEqual(link, target, 'the case needs a mount that is a link');
      assert.equal(argv[argv.indexOf('-w') + 1], target);
      assert.equal(argv[argv.indexOf('-v') + 1], `${target}:${target}`);
    },
  );

  await new Promise((resolveCheck, rejectCheck) => {
    writeFileSync(log, '');
    const child = spawn(process.execPath, [wrapper, 'deploy', 'x.ray'], {
      cwd: scratch,
      env: { ...baseEnv, FAKE_WAIT: '1' },
      stdio: 'ignore',
    });
    setTimeout(() => child.kill('SIGTERM'), 500);
    const guard = setTimeout(() => {
      child.kill('SIGKILL');
      rejectCheck(new Error('(I) the stand-in did not pass SIGTERM on'));
    }, 10000);
    // The fake `docker run` waits; the stand-in's `docker kill` is recorded. Ending the wait is the
    // test's job here, as the real container's exit would be.
    const poll = setInterval(() => {
      const kill = entries().find((e) => e.argv[0] === 'kill');
      if (kill === undefined) return;
      clearInterval(poll);
      clearTimeout(guard);
      try {
        assert.deepEqual(kill.argv.slice(0, 3), ['kill', '--signal', 'TERM']);
        const run = entries().find((e) => e.argv[0] === 'run');
        assert.equal(kill.argv[3], run.argv[run.argv.indexOf('--name') + 1]);
        // The container is named after the stand-in's process id, so a SIGKILL of the stand-in,
        // which it cannot pass on, can still reach its container (Context.killContainer).
        assert.equal(kill.argv[3], `rayspec-journey-${child.pid}`);
        child.kill('SIGKILL');
        passed += 1;
        console.log('ok   (I) SIGTERM reaches the container through docker kill');
        resolveCheck();
      } catch (err) {
        rejectCheck(err);
      }
    }, 100);
  });
} finally {
  spawnSync('pkill', ['-f', join(scratch, 'bin', 'docker')]);
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`ALL CASES PASSED (${passed})`);
