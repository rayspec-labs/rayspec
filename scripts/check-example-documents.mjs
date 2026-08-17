#!/usr/bin/env node
/**
 * Example-document gate — every document shipped under `examples/` still answers the read-only
 * floor, exactly as it is committed.
 *
 * The examples are the first thing a reader runs, and nothing was watching them: a document could
 * stop validating and ship, and twice now one has. This gate closes that hole by running the CLI
 * itself — `doctor`, `plan` and `deploy --dry-run` — over EVERY document it finds under
 * `examples/`, and it finds them by WALKING THE DIRECTORY, never from a list kept here. A document
 * added to a new example directory is covered the moment it lands; a document that is moved or
 * renamed is still covered; and a walk that finds NOTHING is a FAILURE, not a silent pass (the
 * fail-open shape the chokepoint-family gates closed with a scanned-count guard).
 *
 * WHAT EACH DOCUMENT IS HELD TO is derived from the document and the tree it sits in — again, no
 * list here:
 *
 *   • a NEGATIVE fixture (`*.invalid.*` in its name — the deliberate counter-example a suite points
 *     at) must be REFUSED by `doctor`. It is the gate's own accept control: if the floor ever stops
 *     refusing it, every green verdict above is worthless, so a negative fixture that starts
 *     passing fails this gate.
 *
 *   • a document referencing an extension pack whose entry is TYPESCRIPT SOURCE (`index.ts` with no
 *     compiled `index.js` beside it — the `.js`-preferred resolution `loadExtensions` itself does)
 *     must PASS `doctor`, which loads no pack, and must be REFUSED by the two pack-resolving
 *     commands with `extension_pack_refused` — never `extension_pack_unavailable`. That pack is
 *     PRESENT; it was refused because the deploy runtime loads compiled JavaScript only. Telling an
 *     operator to deploy what is already there sends them to the one remedy that cannot work, so
 *     the code that says so is pinned here over the real shipped documents, not only in a unit test
 *     over a synthetic one.
 *
 *   • every other document must EXIT 0 on all three commands.
 *
 * HERMETIC: each command runs with the `.env` auto-loader off and with no database URL in the
 * child's environment, so the gate reads the same on a developer's machine as in CI and never
 * touches a database.
 *
 * NEEDS THE BUILD: it drives the CLI's built entrypoint, so it runs after `pnpm build` (as
 * `gate:spec-schema` and `gate:api-report` already do). A missing build is exit 2 — the gate
 * refuses rather than reporting a pass it never measured.
 *
 * Usage: node scripts/check-example-documents.mjs
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { extractExtensionModules } from './lib/extension-roots.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES_DIR = join(repoRoot, 'examples');
const CLI = join(repoRoot, 'packages', 'app', 'cli', 'dist', 'index.js');
/** Directories that hold no authored document (installed packages, build output). */
const SKIP_DIRS = new Set(['node_modules', 'dist']);
/** The entry file `loadExtensions` resolves inside a pack directory (its `entryFile` default). */
const PACK_ENTRY = 'index';
/** How many documents are driven at once (each runs its commands in order). */
const CONCURRENCY = 4;

if (!existsSync(CLI)) {
  console.error(
    `example-documents gate: the built CLI is not at ${relative(repoRoot, CLI)} — run ` +
      '`pnpm build` first. The gate refuses rather than reporting a pass over documents it never ran.',
  );
  process.exit(2);
}

/** Every `.yaml`/`.yml` file under `examples/`, walked (never listed here), repo-relative. */
function walkDocuments(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...walkDocuments(join(dir, entry.name)));
    } else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) {
      found.push(relative(repoRoot, join(dir, entry.name)));
    }
  }
  return found.sort();
}

/**
 * True iff the document references an extension pack that is PRESENT as TypeScript source and NOT
 * built — the pack directory holds `index.ts` and no compiled `index.js`. This mirrors
 * `resolvePackModule`'s `.js`-preferred resolution, which is what decides the file the production
 * importer is handed and therefore whether it refuses.
 */
function referencesSourceOnlyPack(docRel) {
  const docAbs = join(repoRoot, docRel);
  let modules;
  try {
    modules = extractExtensionModules(readFileSync(docAbs, 'utf8'));
  } catch {
    return false; // an unreadable document is judged by the CLI below, not skipped here.
  }
  return modules.some((moduleSpec) => {
    if (!moduleSpec.startsWith('.')) return false; // a bare specifier is not a directory in the tree.
    const packDir = resolve(dirname(docAbs), moduleSpec);
    return (
      existsSync(join(packDir, `${PACK_ENTRY}.ts`)) &&
      !existsSync(join(packDir, `${PACK_ENTRY}.js`))
    );
  });
}

/** Run one CLI command over one document from the repo root; never throws. */
async function runCli(args) {
  const env = { ...process.env, RAYSPEC_SKIP_DOTENV: '1' };
  delete env.DATABASE_URL;
  delete env.SHADOW_DATABASE_URL;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: repoRoot,
      env,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (e) {
    return { code: e.code ?? 1, out: `${String(e.stdout ?? '')}${String(e.stderr ?? '')}` };
  }
}

/** The three checks one document is held to, as `{ command, run }` pairs. */
const COMMANDS = [
  { name: 'doctor', args: (doc) => ['doctor', doc] },
  { name: 'plan', args: (doc) => ['plan', doc] },
  { name: 'deploy --dry-run', args: (doc) => ['deploy', '--dry-run', doc] },
];

/** Judge one document; returns its violations (empty = it holds). */
async function checkDocument(docRel) {
  const violations = [];
  const negative = /\.invalid\./.test(basename(docRel));
  const sourcePack = referencesSourceOnlyPack(docRel);
  let ran = 0;

  for (const command of COMMANDS) {
    // A negative fixture is judged on the floor alone: `doctor` must refuse it. The two
    // pack-resolving commands would refuse it for the same reason and prove nothing more.
    if (negative && command.name !== 'doctor') continue;
    const { code, out } = await runCli(command.args(docRel));
    ran += 1;

    if (negative) {
      if (code === 0) {
        violations.push(
          `${docRel}: \`${command.name}\` ACCEPTED the negative fixture (exit 0) — a document ` +
            'named `*.invalid.*` is the accept control for every verdict in this gate, so it ' +
            'passing means the floor stopped judging.',
        );
      }
      continue;
    }

    if (sourcePack && command.name !== 'doctor') {
      if (code === 0) {
        violations.push(
          `${docRel}: \`${command.name}\` exited 0 over a pack that is TypeScript source — the ` +
            'production importer loads compiled JavaScript only, so this must be refused.',
        );
      } else if (!out.includes('extension_pack_refused')) {
        violations.push(
          `${docRel}: \`${command.name}\` refused the document without reporting ` +
            `\`extension_pack_refused\` — the pack is PRESENT and was refused. Output: ${out.trim()}`,
        );
      } else if (out.includes('extension_pack_unavailable')) {
        violations.push(
          `${docRel}: \`${command.name}\` reported \`extension_pack_unavailable\` for a pack that ` +
            'is present — that remedy is "deploy the pack", which is already done; the remedy ' +
            'this operator needs is to build it.',
        );
      }
      continue;
    }

    if (code !== 0) {
      violations.push(
        `${docRel}: \`${command.name}\` FAILED (exit ${code}) as committed. Output: ${out.trim()}`,
      );
    }
  }
  return { violations, ran };
}

const documents = walkDocuments(EXAMPLES_DIR);

// THE ZERO-DOCUMENT GUARD. A moved/renamed `examples/` would otherwise walk nothing, find no
// violation and pass — the gate retiring itself with its usual green line.
if (documents.length === 0) {
  console.error(
    `example-documents gate FAILED: the walk of ${relative(repoRoot, EXAMPLES_DIR)} found NO ` +
      'document. Zero documents is a failure, never a pass: the examples cannot have gone away, ' +
      'so the walk is reading the wrong place.',
  );
  process.exit(1);
}

const violations = [];
let commandsRun = 0;
for (let i = 0; i < documents.length; i += CONCURRENCY) {
  const batch = await Promise.all(documents.slice(i, i + CONCURRENCY).map(checkDocument));
  for (const result of batch) {
    violations.push(...result.violations);
    commandsRun += result.ran;
  }
}

if (violations.length > 0) {
  console.error('example-documents gate FAILED:');
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    '\nEvery document under examples/ must answer the read-only floor exactly as it is committed: ' +
      'a reader follows a README and runs these commands first, and a shipped example that does ' +
      'not validate costs them the whole example.',
  );
  process.exit(1);
}

console.log(
  `example-documents gate PASSED: ${documents.length} document(s) under ` +
    `${relative(repoRoot, EXAMPLES_DIR)}, ${commandsRun} CLI run(s) — every committed document ` +
    'answers the floor, every negative fixture is still refused, and a pack that is present but ' +
    'unbuilt is reported as refused rather than absent.',
);
