#!/usr/bin/env node
/**
 * Platform/product seam gate.
 *
 * The platform (`packages/**`, `scripts/**`, `examples/**`) is the reusable, product-free core; the
 * product-bound trees (`products/**`, `sdks/**`, `deployments/**`) are consumer-owned and may live in a
 * different repository entirely. This gate pins that boundary structurally: the platform must never grow
 * a build-time dependency on a product tree, so a consumer can vendor, relocate or replace those trees
 * without touching the core.
 *
 *  (a) NO platform source (packages/**, scripts/**, examples/**) STATICALLY IMPORTS a `products/` or
 *      `sdks/` path — a real build-time dependency across the seam. Prose comments that MENTION the
 *      seam (in backticks or plain text) are fine; only a QUOTED specifier on a genuine
 *      import/export-from/require/dynamic-import form is flagged. The scan is robust to
 *      PRETTIER-WRAPPED multi-line imports: a wrapped import's `from '<path>'` tail lands on a line
 *      WITHOUT the `import` keyword, so we also anchor on a bare `from` clause. It is precise about
 *      what counts as an import so it does NOT flag a runtime PATH CONSTANT — e.g. a test's
 *      `new URL('../../products/<name>/<name>.yaml', import.meta.url)`, `join(import.meta.dirname,
 *      '../products/…')`, or an `export const PATH = 'products/…'` — those are legitimate
 *      fixture/dev-harness reads or path constants, not build-time dependencies, and are excluded by
 *      requiring the keyword be immediately followed by `(`/whitespace+quote (so `import.meta` never
 *      matches) and never preceded by `.` or a word char (so `foo.import(`/`Array.from(`/`myrequire(`
 *      never match). Line comments and inline block comments are stripped per-line before matching, so
 *      a seam path mentioned only in a comment never trips the gate.
 *
 *      KNOWN LIMITATION (unexploitable today): a tsconfig `paths` ALIAS that resolves into
 *      `products/`/`sdks/` and is imported by its alias name (no literal `products/`/`sdks/` substring
 *      in the specifier) would evade this literal-substring scan. No such alias exists (products/ has no
 *      importable module; sdks/ is Rust), so it is not a live gap — flagged here so it isn't
 *      rediscovered as a surprise later.
 *
 *  (b) NO file in the deploy kit's BUILD CONTEXT (`deployments/** ` minus `*.md`) references a legacy
 *      extension-pack path (`PACK_RE`) — the deploy image must build from THIS repo alone, never from a
 *      sibling checkout. (Runbook `.md` files may document such a path as an operator escape hatch, so
 *      `*.md` is exempt.) This clause is UNRELATED to the products/sdks seam above; it is a separate
 *      deploy-kit self-containment invariant.
 *
 *  (c) NO platform `package.json` (root, packages/**, examples/**) declares a build-time DEPENDENCY on
 *      `products/` or `sdks/` via a `file:`/`link:`/`workspace:`/relative-path spec — such a dep evades
 *      the static-import scan (there is no `import` line) yet is a real build-time dependency the
 *      Docker `--frozen-lockfile` would only catch much later.
 *
 *   node scripts/check-no-pack-imports.mjs   # CHECK (exit 1 on any violation)
 *
 * DB-free, secret-free, build-free — a pure text scan. Runs UNCONDITIONALLY.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';

const repoRoot = join(dirname(new URL(import.meta.url).pathname), '..');

// The platform/product seam: `products/` + `sdks/` are consumer-owned trees the platform must not
// depend on at build time. `deployments/` is consumer-owned too, but it is handled separately by
// clause (b) below — it is not part of the platform static-import scan (a) or the package.json scan (c).
const SEAM_RE = /(?:products\/|sdks\/)/;
const SEAM_SPEC = '["\'][^"\'`]*(?:products\\/|sdks\\/)[^"\'`]*["\']';
/**
 * Three genuine-import forms, each requiring a QUOTED (', ") specifier that carries a seam path.
 * Backtick prose is exempt (the specifier class excludes `` ` ``). Each keyword is guarded by
 * `(?<![.\w])` so a method call (`Array.from(`, `foo.import(`) or a longer identifier (`myrequire(`)
 * never matches — only the keyword itself, at a real token boundary, counts.
 *
 *  - FROM_CLAUSE: a bare `from '<seam>'` clause — this is the anchor (not `import`/`export`) so a
 *    PRETTIER-WRAPPED import's `} from '<path>'` tail, which sits on a line with no `import` keyword,
 *    is still caught. `from` must be immediately followed by (optional whitespace then) the quote, so
 *    `Array.from(x)` and any non-import `.from(` call never match (no quote follows).
 *  - CALL_FORM: `import(`/`require(` — the keyword immediately followed by (optional whitespace then)
 *    `(` then the quote. Because `import.meta` is followed by `.`, not `(`, it never matches this form.
 *  - BARE_IMPORT: a side-effect `import '<seam>'` — the keyword immediately followed by whitespace then
 *    the quote (no parens). `import.meta.dirname` again fails (`.`, not whitespace, follows `import`).
 */
const FROM_CLAUSE_RE = new RegExp(`(?<![.\\w])from\\s*${SEAM_SPEC}`);
const CALL_FORM_RE = new RegExp(`(?<![.\\w])(?:import|require)\\s*\\(\\s*${SEAM_SPEC}`);
const BARE_IMPORT_RE = new RegExp(`(?<![.\\w])import\\s+${SEAM_SPEC}`);

/**
 * Strip `//…` line comments and inline block comments from a single line before testing it — a seam
 * path mentioned only in a comment (prose, not an import) must never trip the gate. Best-effort, not a
 * full parser (the scanned files are TS/JS): a `//` that is part of a URL scheme (`http://`,
 * `https://`) is not treated as a comment start.
 */
function stripComments(line) {
  const noBlock = line.replace(/\/\*.*?\*\//g, '');
  const commentAt = noBlock.search(/(?<!:)\/\//);
  return commentAt === -1 ? noBlock : noBlock.slice(0, commentAt);
}

/** True if `line` contains a genuine static import/require of a `products/`/`sdks/` seam path. */
function isSeamImport(line) {
  const code = stripComments(line);
  return FROM_CLAUSE_RE.test(code) || CALL_FORM_RE.test(code) || BARE_IMPORT_RE.test(code);
}

// Legacy extension-pack paths — clause (b) only (deploy-kit self-containment).
const PACK_RE = /(?:RaySpec-Extension-packs|packs\/memovo)/;

const CODE_EXT = new Set(['.ts', '.mts', '.cts', '.mjs', '.cjs', '.js', '.jsx', '.tsx']);
// `.build-context` is the generated (gitignored) single-repo staging copy of the WHOLE repo — it
// legitimately contains the docs/comparison-harness pack references; it is NOT a committed deploy-kit
// file, so the gate must never scan it (it would flood on the staged repo's own prose/harnesses).
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', '.git', '.build-context']);

/** Recursively yield files under `root` (absolute paths), skipping build/vendor dirs. */
function* walk(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return; // absent dir — nothing to scan
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(join(root, e.name));
    } else if (e.isFile()) {
      yield join(root, e.name);
    }
  }
}

const violations = [];

// ── (a) static products/sdks seam imports in the open-core platform surface ───────────────────────
// NOT deployments/ (consumer-owned — it legitimately references a `products/` path directly) and NOT
// products/sdks themselves (they reference each other/themselves freely).
for (const base of ['packages', 'scripts', 'examples']) {
  for (const file of walk(join(repoRoot, base))) {
    if (!CODE_EXT.has(extname(file))) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (isSeamImport(line)) {
        violations.push(
          `  [seam-import] ${relative(repoRoot, file)}:${i + 1}  ${line.trim().slice(0, 120)}`,
        );
      }
    });
  }
}

// ── (b) the deploy kit build context must stay clean of legacy extension-pack paths (*.md exempt) ──
const deployRoot = join(repoRoot, 'deployments');
let deployKitScanned = 0;
for (const file of walk(deployRoot)) {
  if (extname(file) === '.md') continue; // runbooks may document such a path as an operator escape hatch
  deployKitScanned += 1;
  const text = readFileSync(file, 'utf8');
  text.split('\n').forEach((line, i) => {
    if (PACK_RE.test(line)) {
      violations.push(
        `  [deploy-kit-pack] ${relative(repoRoot, file)}:${i + 1}  ${line.trim().slice(0, 120)}`,
      );
    }
  });
}

// ── (c) NO platform package.json declares a build-time DEPENDENCY on products/sdks ────────────────
// A `"@scope/x": "file:../../products/<name>"` (or link:/workspace:/relative-path) dep is a real
// build-time dependency that the static-import scan (no `import` line) misses. Scan every dependency
// spec VALUE across the platform workspace's package.json files for a seam-path substring — a normal
// registry / `workspace:*` spec never contains one, so this is precise. Covers repo root + packages/**
// + examples/** (NOT deployments/ — consumer-owned, dropped from this scan).
const DEP_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'bundledDependencies',
  'bundleDependencies',
];
const pkgJsonFiles = [];
{
  const rootPkg = join(repoRoot, 'package.json');
  try {
    readFileSync(rootPkg, 'utf8');
    pkgJsonFiles.push(rootPkg);
  } catch {
    // no root package.json — fine
  }
  for (const base of ['packages', 'examples']) {
    for (const file of walk(join(repoRoot, base))) {
      if (basename(file) === 'package.json') pkgJsonFiles.push(file);
    }
  }
}
for (const file of pkgJsonFiles) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    continue; // a malformed package.json is not this gate's job
  }
  for (const section of DEP_SECTIONS) {
    const deps = pkg[section];
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec === 'string' && SEAM_RE.test(spec)) {
        violations.push(
          `  [pkg-dep-seam] ${relative(repoRoot, file)}  "${name}": "${spec.slice(0, 100)}"`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    `no-pack gate FAILED: ${violations.length} violation(s) of the platform/product seam:\n` +
      `${violations.join('\n')}\n\n` +
      '  The open-core platform (packages/scripts/examples) must not statically import or depend on\n' +
      '  products/ or sdks/ (consumer-owned trees) — and the deploy kit build-context must stay clean\n' +
      '  of legacy extension-pack paths. Remove the static seam import / package.json seam dependency /\n' +
      '  deploy-kit pack reference. A runtime comparison or fixture harness may reference either via a\n' +
      '  PATH CONSTANT + dynamic load, never a static import.',
  );
  process.exit(1);
}

console.log(
  `no-pack gate PASSED: no static products/sdks seam imports in packages/scripts/examples; ` +
    `deploy kit build-context clean of legacy extension-pack paths (${deployKitScanned} file(s) scanned); ` +
    `no products/sdks seam dependency in ${pkgJsonFiles.length} package.json file(s).`,
);
