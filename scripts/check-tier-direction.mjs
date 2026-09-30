#!/usr/bin/env node
/**
 * Tier-direction gate — every workspace package depends only on packages of its own tier or a
 * lower one.
 *
 * The tiers, lowest first, are the directories under `packages/`: kernel, adapters, capabilities,
 * workflow, compose, app, test (docs/ARCHITECTURE.md, "Package taxonomy"). A package's tier is the
 * directory it lives in. The workspace members under `examples/` are consumers of the platform and
 * sit above every tier; nothing under `packages/` may depend on one.
 *
 * Every dependency field counts — `dependencies`, `devDependencies`, `peerDependencies` and
 * `optionalDependencies` — because a development dependency couples the build order and the tests
 * of two tiers as much as a runtime one does. Only dependencies on workspace packages are checked.
 *
 * The gate FAILS when:
 *   (a) a workspace package lies outside every tier directory (a new tier must be named here and in
 *       the architecture document first);
 *   (b) a package depends on a package of a higher tier, or on an example, and that exact edge is
 *       not one of the reviewed EXCEPTIONS below;
 *   (c) an exception names an edge that no longer exists — a stale exception is removed, never kept
 *       as a pre-approval for a future edge;
 *   (d) the tier list in docs/ARCHITECTURE.md differs from TIERS, so the document and the gate cannot
 *       drift apart;
 *   (e) it scanned no package at all, so a moved workspace file cannot turn the gate into a silent pass.
 *
 * Text-only, DB-free, secret-free, build-optional.
 *
 *   node scripts/check-tier-direction.mjs   # exit 1 on any violation
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved through fileURLToPath so a checkout path with a space survives.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The tiers, lowest first. Each is a directory under `packages/`. */
export const TIERS = ['kernel', 'adapters', 'capabilities', 'workflow', 'compose', 'app', 'test'];

/** The rank of the workspace members under `examples/`: above every tier. */
const EXAMPLES_RANK = TIERS.length;

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/**
 * Reviewed upward edges. Each names the exact package, dependency and field, and why the edge
 * exists. Adding one is an architecture decision, made in review with the architecture document
 * updated alongside.
 */
export const EXCEPTIONS = [
  {
    from: '@rayspec/capability-bridges',
    to: '@rayspec/foundation',
    field: 'dependencies',
    reason:
      'the bridge adapts each capability event to the workflow input event type; it is the one package that joins the two tiers, so neither the capabilities nor the engine depends on the other',
  },
  {
    from: '@rayspec/capability-bridges',
    to: '@rayspec/workflow-durable',
    field: 'dependencies',
    reason:
      'the bridge sinks enqueue a durable workflow run on ingress through the engine ingress type; same joining role as above',
  },
  {
    from: '@rayspec/agent-runtime',
    to: '@rayspec/product-yaml-workflow-bridge',
    field: 'devDependencies',
    reason:
      'a test drives the agent step through the product workflow bridge; the shipped module does not import it',
  },
];

/** The workspace globs from pnpm-workspace.yaml: each `- "<glob>"` line of its `packages:` list. */
function workspaceGlobs(root) {
  const text = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const globs = [];
  let inPackages = false;
  for (const line of text.split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) inPackages = false;
    const item = inPackages ? /^\s+-\s+["']?([^"'\s#]+)["']?/.exec(line) : null;
    if (item) globs.push(item[1]);
  }
  return globs;
}

/** Expand a workspace glob whose `*` segments each stand for one directory level. */
function expand(root, glob) {
  let dirs = [root];
  for (const segment of glob.split('/')) {
    const next = [];
    for (const dir of dirs) {
      if (segment === '*') {
        if (!existsSync(dir)) continue;
        for (const name of readdirSync(dir)) {
          if (name === 'node_modules' || name.startsWith('.')) continue;
          const full = join(dir, name);
          if (statSync(full).isDirectory()) next.push(full);
        }
      } else if (segment.includes('*')) {
        throw new Error(`workspace glob segment ${segment} is not supported by this gate`);
      } else {
        next.push(join(dir, segment));
      }
    }
    dirs = next;
  }
  return dirs.filter((dir) => existsSync(join(dir, 'package.json')));
}

/** The rank of a package directory, or undefined when it lies in no tier. */
function rankOf(root, dir) {
  const [top, tier] = relative(root, dir).split(/[\\/]/);
  if (top === 'examples') return EXAMPLES_RANK;
  if (top !== 'packages') return undefined;
  const rank = TIERS.indexOf(tier);
  return rank === -1 ? undefined : rank;
}

/** The tier names of the taxonomy table in docs/ARCHITECTURE.md, in table order. */
function documentedTiers(root) {
  const text = readFileSync(join(root, 'docs/ARCHITECTURE.md'), 'utf8');
  const start = text.indexOf('## Package taxonomy');
  if (start === -1) return undefined;
  const end = text.indexOf('\n## ', start + 1);
  const section = text.slice(start, end === -1 ? undefined : end);
  return [...section.matchAll(/^\|\s*\*\*([a-z]+)\*\*\s*\|/gm)].map((m) => m[1]);
}

/**
 * Check the workspace at `root` against `exceptions`; returns the list of problems and the number
 * of packages scanned.
 */
export function checkTierDirection(root = repoRoot, exceptions = EXCEPTIONS) {
  const problems = [];
  const packages = new Map();
  for (const glob of workspaceGlobs(root)) {
    for (const dir of expand(root, glob)) {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (typeof manifest.name !== 'string') continue;
      packages.set(manifest.name, { dir, manifest, rank: rankOf(root, dir) });
    }
  }
  if (packages.size === 0) {
    problems.push('no workspace package was found; the gate scanned nothing');
    return { problems, scanned: 0 };
  }

  const tierName = (rank) => (rank === EXAMPLES_RANK ? 'examples' : TIERS[rank]);
  const used = new Set();
  for (const [name, { dir, manifest, rank }] of packages) {
    if (rank === undefined) {
      problems.push(`${name} (${relative(root, dir)}) lies in no tier directory`);
      continue;
    }
    for (const field of DEPENDENCY_FIELDS) {
      for (const dep of Object.keys(manifest[field] ?? {})) {
        const target = packages.get(dep);
        if (target === undefined || target.rank === undefined || target.rank <= rank) continue;
        const exception = exceptions.find(
          (e) => e.from === name && e.to === dep && e.field === field,
        );
        if (exception) {
          used.add(exception);
          continue;
        }
        problems.push(
          `${name} (${tierName(rank)}) depends on ${dep} (${tierName(target.rank)}) in ${field}: a package may depend only on its own tier or a lower one`,
        );
      }
    }
  }
  for (const exception of exceptions) {
    if (!used.has(exception)) {
      problems.push(
        `the exception ${exception.from} -> ${exception.to} (${exception.field}) matches no dependency any more; remove it`,
      );
    }
  }

  const documented = documentedTiers(root);
  if (documented === undefined) {
    problems.push('docs/ARCHITECTURE.md has no "Package taxonomy" section to read the tiers from');
  } else if (documented.join(',') !== TIERS.join(',')) {
    problems.push(
      `docs/ARCHITECTURE.md lists the tiers ${documented.join(', ')}; this gate orders ${TIERS.join(', ')}`,
    );
  }
  return { problems, scanned: packages.size };
}

/** Whether this file is the script Node was started with; both sides real paths (a /tmp link). */
function isEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isEntry()) {
  const { problems, scanned } = checkTierDirection();
  if (problems.length > 0) {
    console.error(`❌ tier-direction: ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    `✅ tier-direction: ${scanned} workspace packages depend only on their own or a lower tier (${EXCEPTIONS.length} reviewed exceptions)`,
  );
}
