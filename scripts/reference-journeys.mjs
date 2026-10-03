#!/usr/bin/env node
/**
 * reference-journeys — the reference applications driven end to end through the release a consumer
 * installs, never through the workspace.
 *
 * WHY. The suites of @rayspec/cli run the built CLI of the workspace, where every `@rayspec/*`
 * package resolves through a workspace link. A consumer installs the published tarballs into an
 * empty directory and gets whatever those tarballs carry: a file missing from a package's `files`, a
 * dependency declared only in the workspace, a path that reaches into a sibling package — none of it
 * shows in the workspace, all of it breaks the consumer. These journeys run each reference
 * application's whole life on that installed tree.
 *
 * WHAT IT DOES.
 *   1. Packs the workspace (`node scripts/publish.mjs --pack`), or takes `--tarballs <dir>` packed
 *      before, and installs every tarball into an empty directory with
 *      `scripts/check-consumer-install.mjs`, the way a consumer installs them.
 *      `--consumer <dir>` reuses a tree that script installed before, and skips both.
 *   2. Runs the journeys (`--app` picks one; default all), each with the installed `rayspec` only:
 *        team-notes       scripts/journeys/team-notes.mjs
 *        document-intake  scripts/journeys/document-intake.mjs
 *        asset-catalog    scripts/journeys/asset-catalog.mjs
 *        quickstart       scripts/journeys/quickstart.mjs (every command of docs/quickstart.md)
 *   3. Prints one JSON summary on stdout — every check by name, the counts and digests each journey
 *      established, the seconds each took — and exits 1 on the first failed check.
 *
 *   node scripts/reference-journeys.mjs [--app <name>] [--tarballs <dir>] [--work <dir>]
 *                                       [--consumer <dir>] [--log-dir <dir>] [--keep]
 *                                       [--image <ref> [--image-network <network>]]
 *
 * `--image` runs every `rayspec` command of the three application journeys in a container of that
 * runtime image instead of the installed tree (journeys/lib.mjs `imageCliSource`): same arguments,
 * paths, environment and exit codes, as the journey's own user, on `--image-network` (default
 * `host`, which needs a Linux host: the journey's servers, proxies and database are on 127.0.0.1).
 * The quickstart journey has no image form.
 *
 * Needs: `pnpm build` (for the pack), npm, DATABASE_URL naming a superuser of a PostgreSQL server
 * where databases and roles may be created and dropped (each environment gets its own), and
 * `pg_dump`/`pg_restore` of the server's major on PATH or Docker to run them from the pinned image.
 * SHADOW_DATABASE_URL is the server pack and the deploy plans compute schema changes on (default
 * DATABASE_URL). The custom-handler journey needs the openssl command line. `--work` (default a new
 * temporary directory) holds the tarballs, the installed tree, every environment's state and blobs;
 * it is removed at the end unless `--keep`. No provider credential is read: every application runs
 * without one.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assetCatalog } from './journeys/asset-catalog.mjs';
import { documentIntake } from './journeys/document-intake.mjs';
import { Context, Journey, JourneyFailure } from './journeys/lib.mjs';
import { quickstart } from './journeys/quickstart.mjs';
import { teamNotes } from './journeys/team-notes.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const JOURNEYS = {
  'team-notes': teamNotes,
  'document-intake': documentIntake,
  'asset-catalog': assetCatalog,
  quickstart,
};

function log(line) {
  process.stderr.write(`[reference-journeys] ${line}\n`);
}

/** Parse the arguments; a usage error is returned as `{ error }`. */
export function parseJourneyArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        app: { type: 'string', multiple: true },
        tarballs: { type: 'string' },
        consumer: { type: 'string' },
        work: { type: 'string' },
        'log-dir': { type: 'string' },
        keep: { type: 'boolean' },
        image: { type: 'string' },
        'image-network': { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const image = values.image;
  // The quickstart runs the commands of docs/quickstart.md as a shell runs them, through npx and the
  // installed tree; it is not a journey of the image.
  const apps =
    values.app ?? Object.keys(JOURNEYS).filter((a) => image === undefined || a !== 'quickstart');
  const unknown = apps.filter((a) => !Object.hasOwn(JOURNEYS, a));
  if (unknown.length > 0) {
    return {
      error: `unknown --app ${unknown.join(', ')}; one of ${Object.keys(JOURNEYS).join(', ')}`,
    };
  }
  if (image !== undefined && apps.includes('quickstart')) {
    return { error: 'the quickstart journey runs the installed tree; it has no --image form' };
  }
  if (image === undefined && values['image-network'] !== undefined) {
    return { error: '--image-network needs --image' };
  }
  return {
    apps,
    tarballs: values.tarballs,
    consumer: values.consumer,
    work: values.work,
    logDir: values['log-dir'],
    keep: values.keep === true,
    image:
      image === undefined ? undefined : { ref: image, network: values['image-network'] ?? 'host' },
  };
}

/** Pack the workspace (unless tarballs were given) and install them as a consumer. */
function installRelease(work, tarballs) {
  let dir = tarballs === undefined ? undefined : resolve(tarballs);
  if (dir === undefined) {
    dir = join(work, 'tarballs');
    log('packing the workspace');
    const packed = spawnSync(
      process.execPath,
      [join(REPO, 'scripts', 'publish.mjs'), '--pack', '--out', dir],
      {
        cwd: REPO,
        encoding: 'utf8',
      },
    );
    if (packed.status !== 0) throw new JourneyFailure(`packing failed\n${packed.stderr}`);
  }
  const consumer = join(work, 'consumer');
  log('installing the tarballs into an empty directory');
  const installed = spawnSync(
    process.execPath,
    [join(REPO, 'scripts', 'check-consumer-install.mjs'), '--tarballs', dir, '--out', consumer],
    { cwd: work, encoding: 'utf8' },
  );
  if (installed.status !== 0) {
    throw new JourneyFailure(`the consumer install failed\n${installed.stderr}`);
  }
  return { consumer, dir, tarballs: readdirSync(dir).filter((f) => f.endsWith('.tgz')).length };
}

async function main(argv) {
  const args = parseJourneyArgs(argv);
  if ('error' in args) {
    process.stderr.write(`usage: ${args.error}\n`);
    return 2;
  }
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    process.stderr.write(
      'DATABASE_URL is not set: it names the server the environments are created on\n',
    );
    return 2;
  }
  const work = args.work ? resolve(args.work) : mkdtempSync(join(tmpdir(), 'rayspec-journeys-'));
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const summary = { ok: false, journeys: [] };
  const started = Date.now();
  let ctx;
  try {
    const release =
      args.consumer === undefined
        ? installRelease(work, args.tarballs)
        : {
            consumer: resolve(args.consumer),
            dir: args.tarballs === undefined ? undefined : resolve(args.tarballs),
            tarballs: null,
          };
    summary.tarballs = release.tarballs;
    summary.installSeconds = Math.round((Date.now() - started) / 1000);
    ctx = new Context({
      repo: REPO,
      consumer: release.consumer,
      tarballs: release.dir,
      work,
      adminUrl,
      shadowUrl: process.env.SHADOW_DATABASE_URL || adminUrl,
      logDir: args.logDir ? resolve(args.logDir) : undefined,
      log,
      image:
        args.image === undefined
          ? undefined
          : { ...args.image, label: `rayspec-journey-run=${process.pid}-${started}` },
    });
    summary.release = ctx.version;
    if (args.image !== undefined) summary.image = args.image.ref;
    for (const app of args.apps) {
      const journey = new Journey(app, log);
      const t0 = Date.now();
      const entry = { app, ok: false };
      summary.journeys.push(entry);
      try {
        await JOURNEYS[app](ctx, journey);
        entry.ok = true;
      } finally {
        entry.seconds = Math.round((Date.now() - t0) / 1000);
        entry.checks = journey.checks;
        entry.facts = Object.fromEntries(journey.notes.map((n) => [n.key, n.value]));
        await ctx.dispose();
      }
    }
    summary.ok = true;
  } catch (err) {
    summary.error = err instanceof Error ? err.message : String(err);
    if (!(err instanceof JourneyFailure) && err instanceof Error) summary.stack = err.stack;
  } finally {
    await ctx?.dispose().catch(() => {});
    summary.seconds = Math.round((Date.now() - started) / 1000);
    if (!args.keep) {
      // Deployment version directories are read-only; make them removable first. A directory that
      // cannot be removed is reported, and does not hide the summary.
      spawnSync('chmod', ['-R', 'u+w', work]);
      try {
        rmSync(work, { recursive: true, force: true, maxRetries: 3 });
      } catch (err) {
        summary.cleanup = `the work directory ${work} was not removed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary.ok ? 0 : 1;
}

// Run as a script, also through a symlinked path (macOS /tmp, /var/folders): the module's own path is
// the real one, so the argument is compared as its real path too.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
