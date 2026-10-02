/**
 * The quickstart journey: every command of docs/quickstart.md, executed in an empty directory
 * against the installed release, so the page cannot drift from the CLI.
 *
 * The page's ```bash blocks are read in order. Every line is run as written, by bash, except the
 * lines in SUBSTITUTIONS:
 *   - the two that reach the network do their work here in a local form: the install installs the
 *     packed tarballs (scripts/check-consumer-install.mjs), the clone copies the application from
 *     the working tree;
 *   - the database URLs and the base URL are pointed at this run's database and port.
 * Each substituted line must appear on the page exactly once, so a page that changes one of them
 * fails here until this table changes with it.
 *
 * The blocks up to the one that deploys (its last line is `npx rayspec deploy … --plan-digest …`)
 * run as one shell session, as in one terminal, and keep serving; the blocks after it run in a second
 * session, as in a second terminal, against the served deployment. Then the deployment is stopped.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { asAdmin, freePort, pause, withDbName } from './lib.mjs';

/** Lines of the page that do not run as written: what the harness does instead. */
export const SUBSTITUTIONS = [
  { line: 'npm install rayspec', harness: 'install' },
  {
    line: 'git clone --depth 1 --branch "v$VERSION" https://github.com/rayspec-labs/rayspec.git rayspec-src',
    harness: 'clone',
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
  return { first, second, harness, blocks: blocks.length };
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
    plan.harness.join(',') === 'install,clone',
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
  // The clone: the application's source from the working tree.
  cpSync(
    join(ctx.repo, 'examples', 'team-notes'),
    join(dir, 'rayspec-src', 'examples', 'team-notes'),
    { recursive: true },
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
  };
  const scripts = join(ctx.work, 'quickstart-scripts');
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, 'first.sh'), `set -euo pipefail\n${plan.first}\n`);
  writeFileSync(join(scripts, 'second.sh'), `set -euo pipefail\n${plan.second}\n`);

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
  } finally {
    if (first.exitCode === null) process.kill(-first.pid, 'SIGTERM');
    const code = await exited;
    ctx.children.delete(first);
    ctx.saveLog('quickstart-first', output);
    journey.note('quickstart blocks', plan.blocks);
    journey.note('deploy stopped with', code);
    await asAdmin(ctx.adminUrl, 'postgres', (sql) =>
      sql.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`),
    );
  }
}
