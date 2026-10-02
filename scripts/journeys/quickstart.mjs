/**
 * The quickstart journey: every command of docs/quickstart.md, executed in an empty directory
 * against the installed release, so the page cannot drift from the CLI.
 *
 * The page's ```bash blocks are read in order. Every line is run as written, by bash, except the
 * lines in SUBSTITUTIONS:
 *   - the two that reach the network do their work here in a local form: the install installs the
 *     packed tarballs (scripts/check-consumer-install.mjs); the clone, with its tag and its path as
 *     the page writes them, clones a local repository holding the application from the working
 *     tree, tagged `v<the packed version>`;
 *   - the database URLs and the base URL are pointed at this run's database and port.
 * Each substituted line must appear on the page exactly once, so a page that changes one of them
 * fails here until this table changes with it.
 *
 * The blocks up to the one that deploys (its last line is `npx rayspec deploy … --plan-digest …`)
 * run as one shell session, as in one terminal, and keep serving; the blocks after it run in a second
 * session, as in a second terminal, against the served deployment. Then the deployment is stopped,
 * and the restart the page names after it (`npx rayspec deploy <bundle>`, no plan digest) is run
 * with the first session's exports, as in the first terminal, and must serve again.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { asAdmin, freePort, pause, withDbName } from './lib.mjs';

/** Lines of the page that do not run as written: what the harness does instead. */
export const SUBSTITUTIONS = [
  { line: 'npm install rayspec', harness: 'install' },
  {
    line: 'git clone --depth 1 --branch "v$VERSION" https://github.com/rayspec-labs/rayspec.git rayspec-src',
    replace: 'git clone --depth 1 --branch "v$VERSION" "$QUICKSTART_REPOSITORY" rayspec-src',
  },
  {
    line: 'export DATABASE_URL=postgresql://rayspec:rayspec@localhost:5433/rayspec',
    replace: 'export DATABASE_URL="$QUICKSTART_DATABASE_URL"',
  },
  {
    line: 'export SHADOW_DATABASE_URL=postgresql://rayspec:rayspec@localhost:5433/rayspec_shadow',
    replace: 'export SHADOW_DATABASE_URL="$QUICKSTART_SHADOW_DATABASE_URL"',
  },
  { line: 'BASE=http://127.0.0.1:8080', replace: 'BASE="http://127.0.0.1:$PORT"' },
];

/** The ```bash blocks of a Markdown page, each as its lines. */
export function bashBlocks(markdown) {
  const blocks = [];
  let current = null;
  for (const line of markdown.split('\n')) {
    if (current === null) {
      if (line.trim() === '```bash') current = [];
    } else if (line.trim() === '```') {
      blocks.push(current);
      current = null;
    } else {
      current.push(line);
    }
  }
  if (current !== null) throw new Error('a ```bash block is not closed');
  return blocks;
}

/**
 * The page as two shell scripts — the session that ends serving, and the session after it — and
 * the harness steps each substituted line stands for. Throws when the page does not have exactly
 * one deploy that serves, or when a substituted line is missing or appears twice.
 */
export function quickstartPlan(markdown) {
  const blocks = bashBlocks(markdown);
  const serving = blocks
    .map((lines, i) => ({ i, last: lines.filter((l) => l.trim() !== '').at(-1) ?? '' }))
    .filter(({ last }) => last.startsWith('npx rayspec deploy ') && last.includes('--plan-digest'));
  if (serving.length !== 1) {
    throw new Error(`the page must deploy and serve in exactly one block, found ${serving.length}`);
  }
  const seen = new Map(SUBSTITUTIONS.map((s) => [s.line, 0]));
  const harness = [];
  const render = (lines) =>
    lines
      .map((line) => {
        const sub = SUBSTITUTIONS.find((s) => s.line === line.trim());
        if (sub === undefined) return line;
        seen.set(sub.line, seen.get(sub.line) + 1);
        if (sub.harness !== undefined) {
          harness.push(sub.harness);
          return `# ${sub.harness}: done by the harness`;
        }
        return sub.replace;
      })
      .join('\n');
  const split = serving[0].i;
  const first = blocks
    .slice(0, split + 1)
    .map(render)
    .join('\n');
  const second = blocks
    .slice(split + 1)
    .map(render)
    .join('\n');
  const wrong = [...seen].filter(([, n]) => n !== 1).map(([line, n]) => `${line} (${n} times)`);
  if (wrong.length > 0) {
    throw new Error(`each substituted line must appear once on the page: ${wrong.join('; ')}`);
  }
  if (second.trim() === '') throw new Error('nothing on the page uses the served deployment');
  // The restart the page names: inline code, outside every block, deploying the bundle with no digest.
  const restarts = [
    ...outsideBlocks(markdown).matchAll(/`(npx rayspec deploy [^`\s]+\.ray)`/g),
  ].map((m) => m[1]);
  if (restarts.length !== 1) {
    throw new Error(`the page must name one restart command, found ${restarts.length}`);
  }
  const exports = first.split('\n').filter((line) => line.startsWith('export '));
  const restart = `${exports.join('\n')}\n${restarts[0]}`;
  return { first, second, restart, harness, blocks: blocks.length };
}

/** The page's text outside its fenced blocks. */
function outsideBlocks(markdown) {
  let inside = false;
  const out = [];
  for (const line of markdown.split('\n')) {
    if (line.trim().startsWith('```')) inside = !inside;
    else if (!inside) out.push(line);
  }
  return out.join('\n');
}

/**
 * A local git repository holding the application under the path the page clones, committed and
 * tagged `v<version>`: what the page's clone reaches here instead of the published repository.
 */
function localRepository(ctx, dir) {
  mkdirSync(dir, { recursive: true });
  cpSync(join(ctx.repo, 'examples', 'team-notes'), join(dir, 'examples', 'team-notes'), {
    recursive: true,
    filter: (path) => !path.split(/[\\/]/).includes('dist'),
  });
  const git = (args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=journey', '-c', 'user.email=journey@example.test', ...args],
      { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
    );
  git(['init', '--quiet']);
  git(['add', '--all']);
  git(['commit', '--quiet', '--no-verify', '-m', 'the application']);
  git(['tag', `v${ctx.version}`]);
  return pathToFileURL(dir).href;
}

/** Whether this checkout's own tag for `version` holds the application the page clones. */
function publishedTagHoldsApplication(repo, version) {
  const run = spawnSync(
    'git',
    ['-C', repo, 'cat-file', '-e', `v${version}:examples/team-notes/build.mjs`],
    { stdio: 'ignore' },
  );
  return run.status === 0;
}

/** Serve `script` with bash in `dir`, and wait for /health on `port`; the child and its output. */
async function serveScript(ctx, script, dir, env, port) {
  const child = spawn('bash', [script], { cwd: dir, env, detached: true });
  ctx.children.add(child);
  const state = { output: '' };
  child.stdout.on('data', (d) => {
    state.output += String(d);
  });
  child.stderr.on('data', (d) => {
    state.output += String(d);
  });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  const deadline = Date.now() + 300_000;
  let serving = false;
  while (child.exitCode === null && Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).status === 200) {
        serving = true;
        break;
      }
    } catch {
      // not serving yet
    }
    await pause(250);
  }
  return {
    child,
    state,
    serving,
    async stop() {
      if (child.exitCode === null) process.kill(-child.pid, 'SIGTERM');
      const code = await exited;
      ctx.children.delete(child);
      return code;
    },
  };
}

export async function quickstart(ctx, journey) {
  if (ctx.tarballs === undefined) {
    journey.check(
      'the quickstart needs the tarballs (run without --consumer, or pass --tarballs)',
      false,
    );
  }
  const page = readFileSync(join(ctx.repo, 'docs', 'quickstart.md'), 'utf8');
  const plan = quickstartPlan(page);
  journey.check(
    'the page installs, clones, and deploys from a bundle',
    plan.harness.join(',') === 'install',
    plan.harness.join(','),
  );
  const dir = join(ctx.work, 'quickstart');
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // The install: the packed tarballs, into the empty directory, the way a consumer installs them.
  journey.step('installing the release into an empty directory');
  const installed = spawnSync(
    process.execPath,
    [
      join(ctx.repo, 'scripts', 'check-consumer-install.mjs'),
      '--tarballs',
      ctx.tarballs,
      '--out',
      dir,
    ],
    { cwd: ctx.work, encoding: 'utf8' },
  );
  journey.check(
    'npm install rayspec (from the packed tarballs)',
    installed.status === 0,
    installed.stderr,
  );
  // The clone: the page's own command, against a local repository tagged at the packed version.
  const repository = localRepository(ctx, join(ctx.work, 'quickstart-repository'));
  journey.note(
    `the published tag v${ctx.version} holds examples/team-notes`,
    publishedTagHoldsApplication(ctx.repo, ctx.version),
  );

  const db = `rsj_quickstart_${process.pid}`;
  await asAdmin(ctx.adminUrl, 'postgres', async (sql) => {
    await sql.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    await sql.unsafe(`CREATE DATABASE "${db}"`);
  });
  const port = await freePort();
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
    PORT: String(port),
    QUICKSTART_DATABASE_URL: withDbName(ctx.adminUrl, db),
    QUICKSTART_SHADOW_DATABASE_URL: ctx.shadowUrl,
    QUICKSTART_REPOSITORY: repository,
  };
  const scripts = join(ctx.work, 'quickstart-scripts');
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, 'first.sh'), `set -euo pipefail\n${plan.first}\n`);
  writeFileSync(join(scripts, 'second.sh'), `set -euo pipefail\n${plan.second}\n`);
  writeFileSync(join(scripts, 'restart.sh'), `set -euo pipefail\n${plan.restart}\n`);

  let output = '';
  const first = spawn('bash', [join(scripts, 'first.sh')], { cwd: dir, env, detached: true });
  ctx.children.add(first);
  first.stdout.on('data', (d) => {
    output += String(d);
  });
  first.stderr.on('data', (d) => {
    output += String(d);
  });
  const exited = new Promise((r) => first.on('exit', (code) => r(code)));
  try {
    journey.step('running the page up to the deploy');
    const deadline = Date.now() + 300_000;
    for (;;) {
      if (first.exitCode !== null) {
        ctx.saveLog('quickstart-first', output);
        journey.check(
          'the page deploys and serves',
          false,
          `exited ${first.exitCode}: ${output.slice(-2000)}`,
        );
      }
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).status === 200) break;
      } catch {
        // not serving yet
      }
      if (Date.now() > deadline)
        journey.check('the page deploys and serves within 300 s', false, output.slice(-2000));
      await pause(250);
    }
    journey.check('the page deploys and serves', true);
    journey.check(
      'the page packed the bundle and kept the plan it deployed',
      existsSync(join(dir, 'team-notes-1.0.0.ray')) && existsSync(join(dir, 'plan.json')),
    );

    journey.step('running the page against the deployment');
    const second = spawnSync('bash', [join(scripts, 'second.sh')], {
      cwd: dir,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    });
    ctx.saveLog('quickstart-second', `${second.stdout}\n${second.stderr}`);
    journey.check(
      'every command of the second terminal succeeds',
      second.status === 0,
      second.stderr,
    );
    journey.check(
      'the UI reports the application version 1.0.0',
      /"application":\s*"team-notes"/.test(second.stdout) &&
        /"version":\s*"1\.0\.0"/.test(second.stdout),
      second.stdout,
    );
    journey.check(
      'the note written is listed',
      (second.stdout.match(/"title":"First note"/g) ?? []).length === 2,
      second.stdout,
    );
    journey.check(
      'the boot secrets the page mints are used as written, with no normalization warning',
      !output.includes('changed by normalization'),
      output.slice(-2000),
    );

    // Ctrl-C, then the restart the page names: the same bundle, no plan digest.
    journey.step('stopping, and restarting as the page says');
    process.kill(-first.pid, 'SIGINT');
    const stoppedWith = await exited;
    let stillServing = true;
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
    } catch {
      stillServing = false;
    }
    journey.note('the first session ended on Ctrl-C with', stoppedWith);
    journey.check('the deployment stops on Ctrl-C', !stillServing, output.slice(-2000));
    const restarted = await serveScript(ctx, join(scripts, 'restart.sh'), dir, env, port);
    try {
      journey.check(
        'the restart without a plan digest serves again',
        restarted.serving,
        restarted.state.output.slice(-2000),
      );
      // The user the page registered signs in again and reads the note written before.
      const base = `http://127.0.0.1:${port}`;
      const post = (path, body, token) =>
        fetch(`${base}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body ?? {}),
        }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
      const login = await post('/v1/auth/login', {
        email: 'you@example.test',
        password: 'a-long-enough-password',
      });
      const [org] = await asAdmin(ctx.adminUrl, db, (sql) =>
        sql.unsafe("SELECT id FROM orgs WHERE name = 'My team'"),
      );
      const switched = await post(`/v1/orgs/${org?.id}/switch`, {}, login.body.accessToken);
      const notes = await fetch(`${base}/api/notes?limit=10`, {
        headers: { authorization: `Bearer ${switched.body.accessToken}` },
      }).then(async (r) => ({ status: r.status, text: await r.text() }));
      journey.check(
        'after the restart the user signs in and the note written before is listed',
        login.status === 200 &&
          notes.status === 200 &&
          (notes.text.match(/"title":"First note"/g) ?? []).length === 1,
        `${login.status} ${switched.status} ${notes.status}`,
      );
    } finally {
      ctx.saveLog('quickstart-restart', restarted.state.output);
      await restarted.stop();
    }
  } finally {
    if (first.exitCode === null && first.signalCode === null) process.kill(-first.pid, 'SIGTERM');
    await exited;
    ctx.children.delete(first);
    ctx.saveLog('quickstart-first', output);
    journey.note('quickstart blocks', plan.blocks);
    await asAdmin(ctx.adminUrl, 'postgres', (sql) =>
      sql.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`),
    );
  }
}
