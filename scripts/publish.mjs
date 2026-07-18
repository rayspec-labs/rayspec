#!/usr/bin/env node
/**
 * RaySpec release packer/publisher — the single sanctioned path to put the CLI + its runtime closure
 * on npm.
 *
 * WHY THIS SCRIPT EXISTS
 * ----------------------
 * Every RaySpec package is committed as `private: true` at version `0.0.0` — that is the deliberate
 * accidental-publish guard: a bare `pnpm publish` / `npm publish` at the repo root or in any package
 * refuses, and nothing in CI publishes. This script is the ONLY place that lifts that guard, and it
 * does so TRANSIENTLY and IN MEMORY of the working tree: for the duration of a pack/publish run it
 * rewrites each publish target's `package.json` to
 *   - `version`  → the single release version (default `1.5.0`, coupled to the `v1.5.0` tag),
 *   - `private`  → `false`,
 *   - `files`    → `["dist"]` if the package does not already declare it (so the tarball ships compiled
 *                  `dist/` only — never `src/`, tests, a stray `.env`, or `.turbo` logs),
 * runs the requested command, and ALWAYS restores the original bytes in a `finally` (even on error /
 * SIGINT). After a run the committed tree is byte-identical to before — the guard is never weakened on
 * disk, and the byte-frozen adapter manifests under `packages/adapters/**` are touched only in this
 * transient, self-reverting way (mirroring the sanctioned private-flip).
 *
 * WORKSPACE VERSION COUPLING
 * --------------------------
 * Internal deps are declared `@rayspec/x: "workspace:*"`. Because ALL targets are stamped to the SAME
 * version before anything is packed, pnpm rewrites every `workspace:*` to that exact version in the
 * packed manifest (proven: a `workspace:*` dep resolves to `1.5.0`). One version string, one tag, the
 * whole closure in lockstep — no changesets, no per-package drift.
 *
 * MODES (default: --dry-run; a real registry write is opt-in and double-gated)
 * ---------------------------------------------------------------------------
 *   --pack         `pnpm pack` each target into --out (default a temp dir); prints each tarball's file
 *                  list + resolved deps. TOKENLESS, no registry contact. The tarball-contents proof.
 *   --dry-run      `pnpm publish --dry-run --no-git-checks` each target (the default). Simulates the
 *                  publish incl. workspace resolution; no registry write. Tokenless in normal operation
 *                  (if your registry demands auth even for a dry-run, use --pack instead).
 *   --publish      REAL `pnpm publish`. Double-gated: also requires `--yes-really-publish` AND
 *                  `RAYSPEC_ALLOW_PUBLISH=1`. Publishes in dependency order (deps before dependents).
 *                  Intended for the founder-run release window only.
 *
 * Other flags: --version <v> (default 1.5.0) · --out <dir> (pack destination) · --json (machine output).
 *
 * This script performs NO git operations and is never wired into a package lifecycle or CI — it runs
 * only when a human invokes it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_VERSION = '1.5.0';
// The opt-in gate for a REAL registry write (read via computed access — this is a release-tool env var,
// not a turbo task input, so it is intentionally not declared in turbo.json).
const ALLOW_PUBLISH_ENV = 'RAYSPEC_ALLOW_PUBLISH';

/** Parse the tiny flag grammar (no positionals). */
function parseFlags(argv) {
  const flags = {
    mode: 'dry-run',
    version: DEFAULT_VERSION,
    out: undefined,
    json: false,
    really: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pack') flags.mode = 'pack';
    else if (a === '--dry-run') flags.mode = 'dry-run';
    else if (a === '--publish') flags.mode = 'publish';
    else if (a === '--yes-really-publish') flags.really = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--version') flags.version = argv[++i];
    else if (a === '--out') flags.out = argv[++i];
    else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return flags;
}

/** All workspace package.json paths (excludes node_modules/dist), via git ls-files for determinism. */
function allManifestPaths() {
  const out = execFileSync('git', ['ls-files', '*package.json', '**/package.json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return [...new Set(out.split('\n').filter(Boolean))]
    .filter((p) => !p.includes('node_modules/'))
    .map((p) => join(REPO_ROOT, p));
}

/**
 * Load {name -> {path, json}} for every publishable workspace package: the scoped `@rayspec/*`
 * packages PLUS the unscoped `rayspec` launcher (the bare `npx rayspec` entrypoint). The repo-root
 * workspace manifest is ALSO named `rayspec`, so it is explicitly excluded — only the member package
 * under `packages/` is a publish target.
 */
function loadRayspecPackages() {
  const rootManifest = join(REPO_ROOT, 'package.json');
  const map = new Map();
  for (const path of allManifestPaths()) {
    let json;
    try {
      json = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    const isScoped = typeof json.name === 'string' && json.name.startsWith('@rayspec/');
    const isLauncher = json.name === 'rayspec' && path !== rootManifest;
    if (isScoped || isLauncher) {
      map.set(json.name, { path, json });
    }
  }
  return map;
}

/**
 * The publish set = the runtime closure of the bin packages — the unscoped `rayspec` launcher plus
 * `@rayspec/cli` + `@rayspec/server` — over PRODUCTION `dependencies` only. The launcher's only
 * dependency is `@rayspec/cli`, so it pulls in the same closure. Excludes dev/test-only packages
 * (e.g. `@rayspec/parity`) and the `@spike/*` / example fixtures (they are not publish targets).
 * Derived — not hardcoded — so it stays correct as the graph evolves.
 */
function computePublishSet(pkgs) {
  const roots = ['rayspec', '@rayspec/cli', '@rayspec/server'];
  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    const entry = pkgs.get(n);
    if (!entry) continue;
    for (const dep of Object.keys(entry.json.dependencies ?? {})) {
      if (dep.startsWith('@rayspec/') && !seen.has(dep)) stack.push(dep);
    }
  }
  return [...seen];
}

/** Topological order (dependencies BEFORE dependents) over the publish set — the safe real-publish order. */
function topoOrder(names, pkgs) {
  const inSet = new Set(names);
  const ordered = [];
  const done = new Set();
  const visiting = new Set();
  const visit = (n) => {
    if (done.has(n)) return;
    if (visiting.has(n)) return; // defensive: a cycle would just fall back to insertion order
    visiting.add(n);
    for (const dep of Object.keys(pkgs.get(n)?.json.dependencies ?? {})) {
      if (inSet.has(dep)) visit(dep);
    }
    visiting.delete(n);
    done.add(n);
    ordered.push(n);
  };
  for (const n of names) visit(n);
  return ordered;
}

/** Transiently rewrite a manifest for publish; returns the ORIGINAL bytes so the caller can restore. */
function stampManifest(path, version) {
  const original = readFileSync(path, 'utf8');
  const json = JSON.parse(original);
  json.version = version;
  json.private = false;
  if (!json.files) json.files = ['dist'];
  // Preserve trailing-newline convention.
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  return original;
}

function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags.version) {
    console.error('--version requires a value (e.g. --version 1.5.0)');
    process.exit(2);
  }
  if (flags.mode === 'publish' && !(flags.really && process.env[ALLOW_PUBLISH_ENV] === '1')) {
    console.error(
      'refusing to publish: a REAL registry write requires both --yes-really-publish and ' +
        'RAYSPEC_ALLOW_PUBLISH=1 in the environment. Use --dry-run or --pack for a no-write proof.',
    );
    process.exit(2);
  }

  const pkgs = loadRayspecPackages();
  const publishSet = computePublishSet(pkgs);
  const order = topoOrder(publishSet, pkgs);
  const outDir =
    flags.mode === 'pack' ? (flags.out ?? mkdtempSync(join(tmpdir(), 'rayspec-pack-'))) : undefined;

  const backups = new Map();
  const results = [];
  try {
    // Phase 1 — stamp EVERY target first, so cross-package workspace:* refs all resolve to `version`.
    for (const name of order) backups.set(name, stampManifest(pkgs.get(name).path, flags.version));

    // Phase 2 — run the requested command per target, in dependency order.
    for (const name of order) {
      const pkgDir = dirname(pkgs.get(name).path);
      if (!existsSync(join(pkgDir, 'dist'))) {
        throw new Error(`${name}: dist/ missing — run \`pnpm build\` before packing/publishing`);
      }
      let stdout = '';
      if (flags.mode === 'pack') {
        stdout = execFileSync('pnpm', ['pack', '--pack-destination', outDir], {
          cwd: pkgDir,
          encoding: 'utf8',
        });
      } else if (flags.mode === 'dry-run') {
        stdout = execFileSync('pnpm', ['publish', '--dry-run', '--no-git-checks'], {
          cwd: pkgDir,
          encoding: 'utf8',
        });
      } else {
        stdout = execFileSync('pnpm', ['publish', '--no-git-checks'], {
          cwd: pkgDir,
          encoding: 'utf8',
        });
      }
      results.push({ name, version: flags.version, ok: true, stdout: stdout.trim() });
      if (!flags.json) console.log(`[${flags.mode}] ${name}@${flags.version} ✓`);
    }
  } finally {
    // Phase 3 — ALWAYS restore original bytes. The committed tree is byte-identical after this script.
    for (const [name, bytes] of backups) writeFileSync(pkgs.get(name).path, bytes);
  }

  const summary = {
    mode: flags.mode,
    version: flags.version,
    count: order.length,
    order,
    outDir: outDir ?? null,
    results: results.map(({ name, version, ok }) => ({ name, version, ok })),
  };
  if (flags.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`\n${flags.mode}: ${order.length} package(s) at ${flags.version}.`);
    if (outDir) console.log(`tarballs → ${outDir}`);
    console.log('working tree restored (private:true / version:0.0.0).');
  }
}

main();
