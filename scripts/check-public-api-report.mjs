#!/usr/bin/env node
/**
 * Public-API report gate — a change to a DECLARED public surface must land as a reviewable diff.
 *
 * A package that promises a contract to code built OUTSIDE this repository has a surface that may
 * only move deliberately. Nothing in the tree records that surface today, so adding, removing or
 * re-shaping an export is invisible in review: it looks like an ordinary source edit, and every gate
 * stays green. This gate makes the surface a CHECKED-IN ARTIFACT — a per-package report derived from
 * the package's BUILT type declarations — and fails when the artifact and the declarations disagree.
 *
 *   node scripts/check-public-api-report.mjs            # CHECK (exit 1 on drift, prints a diff)
 *   node scripts/check-public-api-report.mjs --write    # REGENERATE the committed report(s)
 *
 * (The `--write` idiom is the one `scripts/check-spec-schema.mjs` already uses: the SAME renderer
 * produces the committed bytes and the comparison bytes, so the two can never use different formats.)
 *
 * OPT-IN, BY DECLARATION. A package participates by naming its report file in its own manifest:
 *
 *   "rayspecPublicApi": "api-report.md"     // relative to the package directory
 *
 * A package without that key is not scanned. The set of scanned packages is therefore DECLARED DATA,
 * read out of the workspace manifests — not a fixed directory root — so ZERO declared packages is a
 * PASS, deliberately: "nothing has opted in yet" is a legitimate state of this repository, and the
 * gate says so on the PASS line. This is NOT the fail-open that `scripts/check-gate-coverage.test.mjs`
 * exists to prevent; there the scanned set is a HARDCODED list of source roots, so a root that reads
 * nothing means a root was renamed and the guard silently retired itself. Here there is no root to
 * vanish: an empty result means no manifest declared the key, which is a fact about the manifests, and
 * a package that DOES declare it can never be skipped (see below).
 *
 * A REPORT IS ITS OWN DECLARATION. The empty PASS is only sound while "nothing has opted in" is TRUE,
 * and a committed report is the tree's own evidence that something did. Every report carries a stamp,
 * and the scan walks the workspace directories for stamped files no manifest claims: a package that
 * loses the marker (a merge resolution, a rebase, `pnpm pkg delete`) — or whose directory drops out of
 * the `packages:` patterns — FAILS while its report is still in the tree, instead of retiring the
 * guard and leaving the report to rot.
 *
 * WHAT IS FAIL-CLOSED. Everything about a package that HAS declared the key:
 *   - a missing or unreadable report file FAILS, naming the package and the regeneration command;
 *   - a report that disagrees with the declarations FAILS, printing the unified diff;
 *   - a manifest that names no type entry point FAILS;
 *   - MISSING built type declarations FAIL ("build first") — an unbuilt package can never be read as
 *     an empty surface, which would otherwise let a `--write` erase the whole report;
 *   - a top-level `export …` statement NO branch of the parser understands FAILS, naming the file and
 *     the statement. There is no "dropped quietly" path: an export the gate cannot read would cost a
 *     section in the report and make every later change to it invisible.
 *
 * DERIVED FROM `dist`, NOT FROM SOURCE. The report is read from the `.d.ts` files the build emits and
 * the manifest points at, so it records what a CONSUMER of the published package gets — including the
 * shape TypeScript actually emitted, which is not always the shape the source suggests.
 *
 * FORMAT (stable, sorted, diff-friendly). One section per exported name, sorted by name (plain
 * code-unit order — locale-independent, so the bytes are identical on every host), under one heading
 * per type entry point. Adding an export therefore adds ONE section instead of rewriting the file.
 * Comments are stripped (a doc-comment edit is not a surface change) and the package VERSION is not
 * recorded (a release bump must not churn every report).
 *
 * EVERY DECLARATION OF A NAME, not just the last one. One name routinely carries several top-level
 * declarations — an overload set, a `const` exported next to a `type` of the same name, merged
 * `interface` blocks — and each one is a promise on its own. They are all recorded, in file order,
 * inside that name's single section, so removing one overload is a diff.
 *
 * SCOPE BOUNDARY, stated rather than hidden: a re-export from ANOTHER package (`export * from
 * '@scope/pkg'`, `export * as ns from '@scope/pkg'`) cannot be enumerated from this package's own
 * declarations. It is recorded verbatim as an opaque re-export line, so the FACT is reviewable even
 * though the borrowed names are not listed. A namespace re-export of a module INSIDE the package is
 * readable, so it is read: its members are recorded under the namespace's section.
 *
 * NO DEPENDENCIES. Node builtins only, like the other gates under scripts/ — the type declarations are
 * read as text. A checked-in report is worth nothing if regenerating it needs a toolchain the gate had
 * to add to the dependency tree the SBOM and the advisory scan cover.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the repo root from THIS file via fileURLToPath — a checkout path with a space (or any
// other percent-encodable character) survives, where `new URL(import.meta.url).pathname` would leave
// a literal `%20` in the path and break every join below.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = process.argv.includes('--write');
/** The opt-in marker a package sets in its own manifest to join the scan. */
const MARKER = 'rayspecPublicApi';
const REGENERATE = 'node scripts/check-public-api-report.mjs --write';
/**
 * The stamp every generated report carries in its header. It is what makes an ORPHANED report
 * findable: a report is evidence that a package opted in, so one nobody claims is a retired guard.
 * Deliberately a token no prose about this gate would spell out.
 */
const REPORT_STAMP = 'rayspec-public-api-report/v1';
/** Directories the orphan scan never descends into. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.turbo', 'coverage']);
/** Cap the printed diff so a wholesale rewrite cannot bury the CI log. */
const MAX_DIFF_LINES = 200;
/** Above this many DP cells the diff falls back to a whole-region replacement (see `diffOps`). */
const MAX_DIFF_CELLS = 4_000_000;

const rel = (p) => relative(repoRoot, p) || '.';
const errText = (err) => String(err?.message ? err.message : err);

function die(msg) {
  console.error(`public-api-report gate FAILED: ${msg}`);
  process.exit(1);
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

// ─── the workspace manifests ────────────────────────────────────────────────────────────────────
// The scan reads EVERY workspace manifest, so a package can opt in from anywhere the workspace file
// already covers — no second list of directories to keep in sync with pnpm-workspace.yaml.

/** The `packages:` patterns of pnpm-workspace.yaml, in file order. */
function workspacePatterns() {
  const file = join(repoRoot, 'pnpm-workspace.yaml');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    die(`could not read pnpm-workspace.yaml at ${rel(file)}: ${errText(err)}`);
  }
  const lines = text.split('\n');
  const start = lines.indexOf('packages:');
  if (start < 0) die("pnpm-workspace.yaml has no top-level 'packages:' block.");
  const patterns = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z]/.test(lines[i])) break; // the next top-level key ends the block
    const item = lines[i].match(/^\s+-\s*(.+?)\s*$/);
    if (item) patterns.push(item[1].replace(/^['"]|['"]$/g, ''));
  }
  if (patterns.length === 0) die("pnpm-workspace.yaml declares no 'packages:' patterns.");
  return patterns;
}

/**
 * Expand ONE workspace pattern to existing directories. Literal segments and a WHOLE-segment `*` are
 * supported — the two forms the workspace file uses. Anything else (a partial glob, `**`) is refused
 * rather than silently under-matched: an unreadable pattern would drop packages out of the scan.
 */
function expandPattern(pattern) {
  let dirs = [repoRoot];
  for (const seg of pattern.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '*') {
      dirs = dirs.flatMap((d) =>
        readdirSync(d, { withFileTypes: true })
          .filter((e) => e.isDirectory() && e.name !== 'node_modules')
          .map((e) => join(d, e.name)),
      );
      continue;
    }
    if (seg.includes('*')) {
      die(
        `pnpm-workspace.yaml pattern '${pattern}' uses the unsupported segment '${seg}'.\n` +
          '  This gate reads literal segments and a whole-segment `*` only — teach it the new form ' +
          'rather than letting packages fall out of the scan.',
      );
    }
    dirs = dirs.map((d) => join(d, seg)).filter(isDir);
  }
  return dirs;
}

/** Every workspace package directory that has a manifest, plus the workspace root itself. */
function workspacePackageDirs() {
  const included = new Set([repoRoot]);
  const excluded = new Set();
  for (const pattern of workspacePatterns()) {
    const negated = pattern.startsWith('!');
    for (const dir of expandPattern(negated ? pattern.slice(1) : pattern)) {
      (negated ? excluded : included).add(dir);
    }
  }
  return [...included]
    .filter((d) => !excluded.has(d) && isFile(join(d, 'package.json')))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ─── reading a `.d.ts` ──────────────────────────────────────────────────────────────────────────

/**
 * Drop a leading `#!` line. A declaration file emitted for an executable entry point starts with one
 * (three built `.d.ts` in this repo do), it is NOT a comment, and it carries no `;` — so leaving it in
 * would glue it to the first declaration and make that whole statement unreadable, costing an export.
 * The newline is kept so nothing else shifts.
 */
function stripShebang(src) {
  return src.startsWith('#!') ? src.slice(src.indexOf('\n') + 1 || src.length) : src;
}

/**
 * Drop comments, preserving line structure (every newline inside a block comment is kept) and every
 * string/template literal verbatim — a `//` inside a string-literal type must not truncate the line.
 * A `.d.ts` carries no regular-expression literals and no division, so a `/` outside a string can
 * only open a comment.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const end = endOfString(src, i);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The index just past the string/template literal that opens at `start`. */
function endOfString(src, start) {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === quote) return i + 1;
    i++;
  }
  return i;
}

/**
 * A statement whose top-level `{ … }` is a DECLARATION BODY rather than part of an expression or an
 * export clause. Matched against the text that precedes the opening brace: only these end at the
 * closing brace. `export type T = { a: 1 } | { b: 2 };` and `export { A } from './b.js';` both put a
 * `}` at nesting zero and both run on to the `;` — cutting them at the brace would split one
 * statement into several malformed ones (and lose the module a clause re-exports from).
 */
const BLOCK_BODY_RE =
  /^(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:interface|class|namespace|module|global|(?:const\s+)?enum)\b/;

/**
 * Split a comment-free `.d.ts` into its TOP-LEVEL statements. Brackets are counted, strings are
 * skipped whole, and a statement ends either at a `;` at nesting zero or at the `}` that closes a
 * declaration body (see `BLOCK_BODY_RE`), swallowing an optional `;` after it.
 */
function topLevelStatements(src) {
  const statements = [];
  let depth = 0;
  let bracePrefix = null; // the text before this statement's first nesting-zero `{`
  let start = 0;
  let i = 0;
  const cut = (end) => {
    const text = src.slice(start, end).trim();
    if (text) statements.push(text);
    start = end;
    depth = 0;
    bracePrefix = null;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      i = endOfString(src, i);
      continue;
    }
    if (c === '{' || c === '(' || c === '[') {
      if (c === '{' && depth === 0) bracePrefix = src.slice(start, i).trim();
      depth++;
      i++;
      continue;
    }
    if (c === '}' || c === ')' || c === ']') {
      depth = Math.max(0, depth - 1);
      i++;
      if (depth === 0 && c === '}' && bracePrefix !== null && BLOCK_BODY_RE.test(bracePrefix)) {
        let j = i;
        while (j < src.length && /\s/.test(src[j])) j++;
        if (src[j] === ';') i = j + 1;
        cut(i);
      }
      continue;
    }
    if (c === ';' && depth === 0) {
      i++;
      cut(i);
      continue;
    }
    i++;
  }
  cut(src.length);
  return statements;
}

const NAME = '[A-Za-z_$][\\w$]*';
const DECL_KEYWORD =
  '(?:const\\s+enum|interface|class|type|const|let|var|function|enum|namespace|module)';
const DECL_RE = new RegExp(`^(?:declare\\s+)?(?:abstract\\s+)?(${DECL_KEYWORD})\\s+(${NAME})`);
const EXPORT_DECL_RE = new RegExp(
  `^export\\s+(?:declare\\s+)?(?:abstract\\s+)?(${DECL_KEYWORD})\\s+(${NAME})`,
);
const STAR_AS_RE = new RegExp(
  `^export\\s+(?:type\\s+)?\\*\\s+as\\s+(${NAME})\\s+from\\s+['"]([^'"]+)['"]`,
);
const STAR_RE = /^export\s+(?:type\s+)?\*\s+from\s+['"]([^'"]+)['"]/;
const CLAUSE_RE = /^export\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/;
const IMPORT_CLAUSE_RE = /^import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/;
// `export default Kernel;` — the trailing `;` is part of the statement `topLevelStatements` cuts, and
// it is what tsc emits, so the anchor has to allow it or the branch below is dead code.
const DEFAULT_EXPORT_RE = new RegExp(`^export\\s+default\\s+(${NAME})\\s*;?\\s*$`);
// `export default class Widget { … }` / `export default function main(): void;` — the default export
// IS the declaration. The name binds locally only, so it is recorded under `default`.
const DEFAULT_DECL_RE = new RegExp(
  `^export\\s+default\\s+(?:declare\\s+)?(?:abstract\\s+)?(${DECL_KEYWORD})\\s+(${NAME})`,
);

/** Parse `A, B as C, type D` into `[{ local, exported }]`. */
function parseClause(body) {
  return body
    .split(',')
    .map((part) => part.trim().replace(/^type\s+/, ''))
    .filter(Boolean)
    .map((part) => {
      const alias = part.split(/\s+as\s+/);
      const local = alias[0].trim();
      return { local, exported: (alias[1] ?? local).trim() };
    });
}

/**
 * Refuse a top-level `export` statement no branch of the parser claimed. Dropping it would cost a
 * section in the report and make every later change to that export invisible — the exact failure this
 * gate exists to prevent — so an unreadable form fails LOUDLY instead, the same posture a relative
 * specifier that resolves to nothing already has.
 */
function refuseStatement(file, statement) {
  const head = statement.replace(/\s+/g, ' ').trim();
  const shown = head.length > 120 ? `${head.slice(0, 119)}…` : head;
  const hint = /^export\s*=/.test(head)
    ? '\n  (`export = X` assigns the WHOLE module; a consumer names it at the import site, so there ' +
      'is no exported name to record.)'
    : '';
  die(
    `${rel(file)} has a top-level export this gate cannot read:\n` +
      `    ${shown}${hint}\n` +
      '  The surface cannot be recorded completely, so the report is not written. Teach the gate this ' +
      'form rather than letting an export fall out of the report.',
  );
}

/**
 * Read ONE declaration file into the parts the surface is assembled from: what it declares, what it
 * exports (and from where), and the star re-exports it forwards.
 */
function parseDeclarationFile(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    die(`could not read the type declarations at ${rel(file)}: ${errText(err)}`);
  }
  const mod = {
    file,
    locals: new Map(), // declared name → [statement text, …] in file order
    imports: new Map(), // local name → { module, name }
    exports: new Map(), // exported name → origin
    stars: [], // `export * from '…'` specifiers, in file order
  };
  // A name can carry SEVERAL top-level declarations (an overload set, a `const` beside a `type` of the
  // same name, merged `interface` blocks). Each is a promise of its own, so they accumulate — keying
  // them by name alone would record the last and let the removal of any other one pass unseen.
  const declare = (name, statement) => {
    const seen = mod.locals.get(name);
    if (seen) seen.push(statement);
    else mod.locals.set(name, [statement]);
  };
  for (const statement of topLevelStatements(stripComments(stripShebang(raw)))) {
    const head = statement.replace(/\s+/g, ' ').trim();
    if (head.startsWith('import')) {
      const clause = head.match(IMPORT_CLAUSE_RE);
      if (clause) {
        for (const { local, exported } of parseClause(clause[1])) {
          // In an IMPORT clause the alias runs the other way: `{ A as B }` binds local `B` to `A`.
          mod.imports.set(exported, { module: clause[2], name: local });
        }
      }
      continue;
    }
    // `export` as a WORD: the branch below refuses what it cannot read, so an identifier that merely
    // starts with those six letters must not be dragged into it.
    if (/^export\b/.test(head)) {
      const starAs = head.match(STAR_AS_RE);
      if (starAs) {
        mod.exports.set(starAs[1], { kind: 'namespace', module: starAs[2] });
        continue;
      }
      const star = head.match(STAR_RE);
      if (star) {
        mod.stars.push(star[1]);
        continue;
      }
      const clause = head.match(CLAUSE_RE);
      if (clause) {
        for (const { local, exported } of parseClause(clause[1])) {
          mod.exports.set(
            exported,
            clause[2] ? { kind: 'from', module: clause[2], name: local } : { kind: 'local', local },
          );
        }
        continue;
      }
      const asDefault = head.match(DEFAULT_EXPORT_RE);
      if (asDefault) {
        mod.exports.set('default', { kind: 'local', local: asDefault[1] });
        continue;
      }
      const defaultDecl = head.match(DEFAULT_DECL_RE);
      if (defaultDecl) {
        declare(defaultDecl[2], statement);
        mod.exports.set('default', { kind: 'local', local: defaultDecl[2] });
        continue;
      }
      const decl = head.match(EXPORT_DECL_RE);
      if (decl) {
        declare(decl[2], statement);
        mod.exports.set(decl[2], { kind: 'local', local: decl[2] });
        continue;
      }
      refuseStatement(file, statement);
      continue;
    }
    const decl = head.match(DECL_RE);
    if (decl) declare(decl[2], statement);
  }
  return mod;
}

/**
 * Resolve a module specifier written in a `.d.ts` to the declaration file it names. Returns the
 * absolute path, `null` for another PACKAGE (nothing here can enumerate it), or `undefined` when a
 * RELATIVE specifier resolves to nothing — which is fail-closed, never a silently short closure.
 */
function resolveDeclaration(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier);
  const swaps = [
    ['.js', '.d.ts'],
    ['.mjs', '.d.mts'],
    ['.cjs', '.d.cts'],
  ];
  const candidates = [];
  for (const [from, to] of swaps) {
    if (base.endsWith(from)) candidates.push(base.slice(0, -from.length) + to);
  }
  candidates.push(`${base}.d.ts`, join(base, 'index.d.ts'), base);
  return candidates.find(isFile);
}

/**
 * The exported surface of one declaration file: every name a consumer can import from it, resolved
 * through relative re-exports, plus the opaque star re-exports it forwards from other packages.
 * `cache` memoises per file; `open` breaks a re-export cycle.
 */
function surfaceOf(file, cache, open = new Set()) {
  const cached = cache.get(file);
  if (cached) return cached;
  if (open.has(file)) return { names: new Map(), opaque: [] };
  open.add(file);

  const mod = parseDeclarationFile(file);
  const names = new Map();
  const opaque = [];

  // A star re-export contributes only names the module does not export itself, so explicit exports
  // are applied last and always win — the ESM precedence rule.
  for (const specifier of mod.stars) {
    const target = resolveDeclaration(file, specifier);
    if (target === null) {
      opaque.push(specifier);
      continue;
    }
    if (target === undefined) {
      die(
        `${rel(file)} re-exports from '${specifier}', which resolves to no declaration file.\n` +
          '  The surface cannot be read completely, so the report is not written.',
      );
    }
    const inner = surfaceOf(target, cache, open);
    for (const [name, entry] of inner.names) names.set(name, entry);
    opaque.push(...inner.opaque);
  }

  for (const [exported, origin] of mod.exports) {
    names.set(exported, resolveOrigin(file, mod, origin, cache, open));
  }

  open.delete(file);
  const surface = { names, opaque };
  cache.set(file, surface);
  return surface;
}

/** Where one exported name is declared, and the declaration text to print for it. */
function resolveOrigin(file, mod, origin, cache, open) {
  if (origin.kind === 'namespace') {
    // `export * as ns from '…'` is opaque only when the module leaves the package. A RELATIVE
    // specifier is inside this package's own readable closure — treating it as foreign would hide
    // every member of an idiomatic grouped export behind one unchanging line.
    const target = resolveDeclaration(file, origin.module);
    if (target === null) return { external: origin.module, note: 'namespace re-export' };
    if (target === undefined) {
      die(
        `${rel(file)} re-exports the namespace '${origin.module}', which resolves to no declaration ` +
          'file.\n  The surface cannot be read completely, so the report is not written.',
      );
    }
    return { namespace: origin.module, file: target, surface: surfaceOf(target, cache, open) };
  }
  if (origin.kind === 'from' || origin.kind === 'local') {
    const via =
      origin.kind === 'from'
        ? { module: origin.module, name: origin.name }
        : (mod.imports.get(origin.local) ?? null);
    if (via) {
      const target = resolveDeclaration(file, via.module);
      if (target === null) return { external: via.module, name: via.name };
      if (target === undefined) {
        die(
          `${rel(file)} re-exports from '${via.module}', which resolves to no declaration file.\n` +
            '  The surface cannot be read completely, so the report is not written.',
        );
      }
      const inner = surfaceOf(target, cache, open);
      return inner.names.get(via.name) ?? { unresolved: via.name, from: rel(target) };
    }
    const texts = mod.locals.get(origin.local);
    if (texts) return { file, name: origin.local, texts };
  }
  return { unresolved: origin.local ?? origin.name ?? 'default', from: rel(file) };
}

// ─── the report ─────────────────────────────────────────────────────────────────────────────────

/** Normalise a declaration for the report: no trailing blanks, no empty lines. */
function normalizeDeclaration(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line !== '')
    .join('\n');
}

/** The opaque star re-exports of one surface, as a bullet list. */
function renderOpaque(out, opaque) {
  if (opaque.length === 0) return;
  out.push('', 'Opaque re-export(s) — the borrowed names are owned by another package:', '');
  for (const specifier of [...new Set(opaque)].sort()) {
    out.push(`- \`export * from '${specifier}'\``);
  }
}

/**
 * ONE exported name, at heading depth `level`. A namespace re-export of a module inside the package
 * recurses into its members (`seen` breaks a re-export cycle); everything else is one section.
 */
function renderName(out, pkgDir, name, decl, level, seen) {
  const hash = '#'.repeat(Math.min(level, 6));
  if (decl.namespace) {
    if (seen.has(decl.file)) {
      out.push(
        '',
        `${hash} \`${name}\` — namespace re-export of \`${decl.namespace}\` (recorded above)`,
      );
      return;
    }
    const members = [...decl.surface.names.keys()].sort();
    out.push(
      '',
      `${hash} \`${name}\` — namespace re-export of \`${decl.namespace}\` — \`${rel2(pkgDir, decl.file)}\``,
      '',
      `${members.length} member(s).`,
    );
    renderOpaque(out, decl.surface.opaque);
    seen.add(decl.file);
    for (const member of members) {
      renderName(out, pkgDir, `${name}.${member}`, decl.surface.names.get(member), level + 1, seen);
    }
    seen.delete(decl.file);
    return;
  }
  if (decl.external) {
    const leaf = name.slice(name.lastIndexOf('.') + 1);
    const what = decl.note ?? (decl.name && decl.name !== leaf ? `as \`${decl.name}\`` : '');
    out.push(
      '',
      `${hash} \`${name}\` — re-exported from \`${decl.external}\`${what ? ` (${what})` : ''}`,
    );
    return;
  }
  if (decl.unresolved) {
    out.push('', `${hash} \`${name}\` — declared outside the readable declaration closure`);
    return;
  }
  const leaf = name.slice(name.lastIndexOf('.') + 1);
  const alias = decl.name !== leaf ? ` (declared as \`${decl.name}\`)` : '';
  out.push('', `${hash} \`${name}\` — \`${rel2(pkgDir, decl.file)}\`${alias}`, '', '```ts');
  // Every declaration this name carries, in file order — an overload set, or a value exported beside
  // a type of the same name, is several promises and each one has to be in the bytes.
  out.push(decl.texts.map(normalizeDeclaration).join('\n'), '```');
}

/**
 * THE ONE renderer — used by BOTH `--write` and the comparison, so the committed report and the bytes
 * it is compared against can never drift apart in format.
 */
function renderReport(pkg) {
  const out = [
    `# Public API report — ${pkg.name}`,
    '',
    '<!--',
    `GENERATED FILE — do not edit by hand. [${REPORT_STAMP}]`,
    '',
    "Derived from this package's BUILT type declarations by scripts/check-public-api-report.mjs, so it",
    'records the surface a consumer of the published package actually gets. Any change to that surface',
    'must be regenerated here and committed in the same change:',
    '',
    `    ${REGENERATE}`,
    '-->',
  ];
  for (const entry of pkg.entries) {
    const sorted = [...entry.surface.names.keys()].sort();
    out.push('', `## Entry point \`${entry.subpath}\` — \`${rel2(pkg.dir, entry.file)}\``, '');
    out.push(`${sorted.length} export(s).`);
    renderOpaque(out, entry.surface.opaque);
    for (const name of sorted) {
      renderName(out, pkg.dir, name, entry.surface.names.get(name), 3, new Set());
    }
  }
  return `${out.join('\n')}\n`;
}

/** A path relative to the package directory, with POSIX separators so the bytes are host-stable. */
function rel2(pkgDir, file) {
  return relative(pkgDir, file).split(/[\\/]/).join('/');
}

// ─── the declared packages ──────────────────────────────────────────────────────────────────────

/** The TYPE entry points a consumer can import, keyed by their `exports` subpath. */
function typeEntryPoints(manifest, pkgDir, label) {
  const found = new Map();
  const record = (subpath, target) => {
    if (found.has(subpath) || typeof target !== 'string') return;
    const swaps = [
      ['.d.ts', '.d.ts'],
      ['.d.mts', '.d.mts'],
      ['.d.cts', '.d.cts'],
      ['.js', '.d.ts'],
      ['.mjs', '.d.mts'],
      ['.cjs', '.d.cts'],
    ];
    for (const [from, to] of swaps) {
      if (target.endsWith(from)) {
        found.set(subpath, join(pkgDir, target.slice(0, -from.length) + to));
        return;
      }
    }
  };
  const collect = (subpath, node) => {
    if (typeof node === 'string') {
      record(subpath, node);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) collect(subpath, child);
      return;
    }
    if (node && typeof node === 'object') {
      if (typeof node.types === 'string') {
        record(subpath, node.types);
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        collect(key.startsWith('.') ? key : subpath, value);
      }
    }
  };
  if (manifest.exports !== undefined) collect('.', manifest.exports);
  if (found.size === 0) record('.', manifest.types ?? manifest.typings);
  if (found.size === 0) {
    die(
      `${label} declares "${MARKER}" but its manifest names no TYPE entry point ` +
        '(no "types" condition under "exports", no top-level "types").\n' +
        '  A declared package must say what a consumer may import before its surface can be recorded.',
    );
  }
  return [...found.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([subpath, file]) => ({ subpath, file }));
}

/** Every package that has opted in, with its surface read from the built declarations. */
function declaredPackages(dirs) {
  const declared = [];
  for (const dir of dirs) {
    const manifestPath = join(dir, 'package.json');
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      die(`could not read the manifest at ${rel(manifestPath)}: ${errText(err)}`);
    }
    const marker = manifest[MARKER];
    if (marker === undefined) continue;
    const label = manifest.name ?? rel(dir);
    if (typeof marker !== 'string' || marker.trim() === '') {
      die(`${label} declares "${MARKER}" as ${JSON.stringify(marker)} — it must be a report path.`);
    }
    const reportPath = resolve(dir, marker);
    const inside = relative(dir, reportPath);
    if (inside === '' || inside.startsWith('..')) {
      die(`${label} points "${MARKER}" at ${rel(reportPath)}, outside its own package directory.`);
    }
    const entries = typeEntryPoints(manifest, dir, label);
    const cache = new Map();
    for (const entry of entries) {
      if (!existsSync(entry.file)) {
        die(
          `${label} declares "${MARKER}", but its built type declarations are MISSING at ` +
            `${rel(entry.file)} (entry point \`${entry.subpath}\`).\n` +
            '  Run `pnpm build` first — this gate reads dist, so an unbuilt package must never be ' +
            'recorded as an empty surface.',
        );
      }
      entry.surface = surfaceOf(entry.file, cache);
    }
    declared.push({ name: label, dir, reportPath, entries });
  }
  return declared;
}

/**
 * Generated reports in the tree that the declared set does NOT claim. A report is a package's own
 * evidence that it opted in, so an unclaimed one means the guard was retired while the artifact stayed
 * — the marker was dropped from the manifest, the marker now points somewhere else, or the package
 * directory fell out of the `packages:` patterns. Each case leaves a stale report nobody verifies.
 */
function orphanReports(dirs, claimed) {
  const visited = new Set();
  const orphans = [];
  const walk = (dir) => {
    if (visited.has(dir)) return;
    visited.add(dir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith('.md') || claimed.has(full)) continue;
      try {
        // The stamp lives in the header, so a bounded read is enough for any report.
        if (readFileSync(full, 'utf8').slice(0, 1024).includes(REPORT_STAMP)) orphans.push(full);
      } catch {
        /* unreadable: not a report this gate wrote */
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return orphans.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ─── the unified diff (node builtins only) ──────────────────────────────────────────────────────

/** Line operations turning `a` into `b`: a common prefix/suffix trim around one LCS walk. */
function diffOps(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }
  const aMid = a.slice(pre, a.length - suf);
  const bMid = b.slice(pre, b.length - suf);
  const ops = [];
  for (let i = 0; i < pre; i++) ops.push([' ', a[i]]);
  if ((aMid.length + 1) * (bMid.length + 1) > MAX_DIFF_CELLS) {
    // Too large to align line by line; report the changed region wholesale rather than guess.
    for (const line of aMid) ops.push(['-', line]);
    for (const line of bMid) ops.push(['+', line]);
  } else {
    const n = aMid.length;
    const m = bMid.length;
    const width = m + 1;
    const lcs = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * width + j] =
          aMid[i] === bMid[j]
            ? lcs[(i + 1) * width + j + 1] + 1
            : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (aMid[i] === bMid[j]) {
        ops.push([' ', aMid[i]]);
        i++;
        j++;
      } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
        ops.push(['-', aMid[i]]);
        i++;
      } else {
        ops.push(['+', bMid[j]]);
        j++;
      }
    }
    while (i < n) ops.push(['-', aMid[i++]]);
    while (j < m) ops.push(['+', bMid[j++]]);
  }
  for (let i = a.length - suf; i < a.length; i++) ops.push([' ', a[i]]);
  return ops;
}

/** Render the operations as a unified diff with three lines of context. */
function unifiedDiff(committed, fresh, label, context = 3) {
  const ops = diffOps(committed.split('\n'), fresh.split('\n'));
  let aLine = 1;
  let bLine = 1;
  const rows = ops.map(([mark, text]) => {
    const row = { mark, text, a: aLine, b: bLine };
    if (mark !== '+') aLine++;
    if (mark !== '-') bLine++;
    return row;
  });
  const out = [`--- ${label} (committed)`, `+++ ${label} (derived from the declarations)`];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].mark === ' ') {
      i++;
      continue;
    }
    const from = Math.max(0, i - context);
    let last = i;
    for (let k = i; k < rows.length; k++) {
      if (rows[k].mark !== ' ') last = k;
      else if (k - last > 2 * context) break;
    }
    const to = Math.min(rows.length - 1, last + context);
    const hunk = rows.slice(from, to + 1);
    const kept = hunk.filter((r) => r.mark !== '+');
    const added = hunk.filter((r) => r.mark !== '-');
    out.push(
      `@@ -${kept[0]?.a ?? 0},${kept.length} +${added[0]?.b ?? 0},${added.length} @@`,
      ...hunk.map((r) => `${r.mark}${r.text}`),
    );
    i = to + 1;
  }
  if (out.length > MAX_DIFF_LINES) {
    return [
      ...out.slice(0, MAX_DIFF_LINES),
      `… ${out.length - MAX_DIFF_LINES} more diff line(s)`,
    ].join('\n');
  }
  return out.join('\n');
}

// ─── run ────────────────────────────────────────────────────────────────────────────────────────
const dirs = workspacePackageDirs();
const declared = declaredPackages(dirs);

// Before anything else, including the empty-set PASS: a report nobody claims is a retired guard.
const orphans = orphanReports(dirs, new Set(declared.map((pkg) => pkg.reportPath)));
if (orphans.length > 0) {
  die(
    `${orphans.length} public-API report(s) in the tree are claimed by NO manifest:\n` +
      orphans.map((f) => `    ${rel(f)}`).join('\n') +
      `\n  A report is generated from a package's "${MARKER}" key, so an unclaimed one means the key ` +
      'was dropped or re-pointed, or the package left the workspace patterns — the surface is no ' +
      'longer verified while the file stays in the tree.\n' +
      '  Restore the declaration, or delete the report.',
  );
}

if (declared.length === 0) {
  const what = WRITE ? 'nothing to regenerate' : 'PASSED: 0 declared package(s)';
  console.log(
    `public-api-report gate ${what}; ${dirs.length} workspace manifest(s) scanned, ` +
      'no unclaimed report found.\n' +
      `  No package declares "${MARKER}". The scanned set is DECLARED DATA read from the manifests, ` +
      'not a fixed directory root, so an empty set means nothing has opted in — a package that DOES ' +
      'declare the key can never be skipped, and a report left behind by one that dropped the key ' +
      'FAILS instead of rotting.',
  );
  process.exit(0);
}

const stale = [];
for (const pkg of declared) {
  const fresh = renderReport(pkg);
  const exports = pkg.entries.reduce((n, e) => n + e.surface.names.size, 0);

  if (WRITE) {
    writeFileSync(pkg.reportPath, fresh);
    console.log(
      `public-api-report gate: REGENERATED ${rel(pkg.reportPath)} for ${pkg.name} ` +
        `(${pkg.entries.length} entry point(s), ${exports} export(s), ${fresh.length} bytes).`,
    );
    continue;
  }

  let committed;
  try {
    committed = readFileSync(pkg.reportPath, 'utf8');
  } catch (err) {
    die(
      `${pkg.name} declares "${MARKER}" but its report is MISSING or unreadable at ` +
        `${rel(pkg.reportPath)} (${errText(err)}).\n` +
        `  Generate + commit it: \`${REGENERATE}\`.`,
    );
  }

  if (committed !== fresh) {
    stale.push({ pkg, diff: unifiedDiff(committed, fresh, rel(pkg.reportPath)) });
    continue;
  }

  console.log(
    `public-api-report gate PASSED: ${pkg.name} — ${rel(pkg.reportPath)} is fresh ` +
      `(${pkg.entries.length} entry point(s), ${exports} export(s), ${fresh.length} bytes).`,
  );
}

if (stale.length > 0) {
  const names = stale.map((s) => s.pkg.name).join(', ');
  console.error(
    `public-api-report gate FAILED: the public surface changed without its report: ${names}.\n` +
      `  Regenerate + commit: \`${REGENERATE}\`.\n`,
  );
  for (const { pkg, diff } of stale) {
    console.error(`${pkg.name} — ${rel(pkg.reportPath)}\n${diff}\n`);
  }
  process.exit(1);
}

console.log(
  `public-api-report gate PASSED: ${declared.length} declared package(s) ` +
    `${WRITE ? 'regenerated' : 'up to date'}; ${dirs.length} workspace manifest(s) scanned.`,
);
