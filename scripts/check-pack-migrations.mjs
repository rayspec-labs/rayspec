#!/usr/bin/env node
/**
 * Pack-migration chain gate — a pack's hand-written platform tables stay inside its own namespace.
 *
 * An extension pack contributes product tables through `stores`, which the platform generates and
 * owns. A pack that needs platform state instead — hand-shaped indexes, foreign keys, an
 * append-only ledger — brings its own migration chain, and that chain runs through the same
 * migrator as the platform's. Two chains writing into one database is only safe while each one
 * stays in its own namespace, so a pack declares a table prefix and this gate holds the chain to
 * it: EVERY `CREATE TABLE` and EVERY `CREATE INDEX` / `CREATE UNIQUE INDEX` in the chain must name
 * an object that carries the prefix. A chain that creates a bare `orgs` or a bare `sessions_idx`
 * is not a pack owning its own tables — it is a pack reaching into the platform's.
 *
 * ADDITIVE-ONLY, AND NO ALLOWLIST — THE ASYMMETRY IS DELIBERATE. The platform's own chain is
 * scanned by `gate:migrations`, which BLOCKS a destructive statement unless a reviewed entry in
 * packages/kernel/db/src/migration-scan.allowlist.ts clears it. A pack chain gets no equivalent and
 * no mechanism to author one: a destructive statement here is a failure, full stop. The platform's
 * allowlist is a record of changes its own maintainers reviewed line by line in this repository; a
 * pack is code from somewhere else, and giving it the same escape hatch would mean a closed pack
 * clearing itself to drop a table nobody in this repository ever read. A closed pack does not get a
 * lower bar than the core — it gets a higher one.
 *
 * A ZERO-FILE SCAN IS A FAILURE. A declared chain whose directory is empty, renamed or absent reads
 * nothing, finds nothing, and would otherwise report a clean pass over a chain that was never
 * scanned — the fail-open shape the chokepoint-family gates closed with a scanned-count guard. The
 * gate refuses instead and names the chain, and its pass line reports how many files and statements
 * it actually read.
 *
 * The gate reads SQL TEXT, so it strips comments and blanks string-literal bodies before it matches
 * anything (the shape `check-handler-imports.mjs` uses for source): a `-- CREATE TABLE orgs` note
 * and a `DEFAULT 'DROP TABLE orgs'` column default are not statements, and a `;` or `--` inside a
 * literal or a quoted identifier is not structure.
 *
 * Usage:
 *   node scripts/check-pack-migrations.mjs                 # scan every DECLARED chain
 *   node scripts/check-pack-migrations.mjs <dir> <prefix>  # scan one chain (the regression's door)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The pack migration chains scanned in CI, each `{ dir, tablePrefix }`. The chain is a directory of
 * `.sql` files and the prefix is the namespace the pack claims — the same pair a pack manifest
 * declares. On the platform main line the only chain is the in-tree fixture pack's, which exists so
 * this gate scans real committed bytes rather than reporting a pass over an empty declared set.
 */
const DECLARED_CHAINS = [
  { dir: 'packages/test/fixture-pack/migrations', tablePrefix: 'fixture_pack_' },
];

/** A declared prefix must be a plain SQL identifier fragment — anything else is a config error. */
const PREFIX_RE = /^[a-z_][a-z0-9_]*$/i;

/**
 * The statement forms a pack chain may contain. Everything else is refused: "additive-only" is
 * expressed as the accepted set, not as a list of the destructive things to look for, so a
 * statement nobody anticipated fails CLOSED instead of passing because no detector named it.
 */
const ADDITIVE_FORMS = [
  /^CREATE\s+TABLE\b/i,
  /^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i,
  /^CREATE\s+TYPE\b/i,
  /^ALTER\s+TABLE\b[\s\S]*\bADD\b/i,
];

/**
 * Destructive vocabulary — mirrors what `gate:migrations` blocks on the platform chain, and is used
 * HERE only to say WHY a statement was refused (a refusal is already decided by ADDITIVE_FORMS).
 * `DELETE` and `UPDATE` are matched in their statement shapes so the `ON DELETE cascade ON UPDATE
 * no action` of an additive foreign key is not mistaken for one.
 */
const DESTRUCTIVE = [
  /\bDROP\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
  /^UPDATE\b/i,
  /\bRENAME\b/i,
  /\bALTER\s+COLUMN\b/i,
];

/** An object name: a quoted or bare identifier, optionally schema-qualified. */
const NAME = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))?`;
const CREATE_TABLE_RE = new RegExp(
  String.raw`^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${NAME})`,
  'i',
);
const CREATE_INDEX_RE = new RegExp(
  String.raw`^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${NAME})`,
  'i',
);

/**
 * Split SQL into statements, LITERAL-AWARE. Walks the text tracking lexer state so a `--`, a
 * slash-star block comment or a `;` inside a single-quoted string ('', the escaped quote), a
 * dollar-quoted body ($tag$...$tag$) or a double-quoted identifier ("", the escaped quote) is not
 * mistaken for structure. Comments are dropped; literal and identifier bodies are kept verbatim so
 * the object-name match below still sees the name it must check. Each statement is returned with
 * its 1-based starting line and its internal whitespace collapsed to single spaces, so a
 * newline-split `DROP\nTABLE` reads as one statement.
 */
function splitStatements(sql) {
  const statements = [];
  let buf = '';
  let line = 1;
  let startLine = 0;
  let i = 0;
  const n = sql.length;

  const push = (ch) => {
    if (startLine === 0 && ch.trim().length > 0) startLine = line;
    buf += ch;
  };
  const end = () => {
    const text = buf.replace(/\s+/g, ' ').trim();
    if (text.length > 0) statements.push({ line: startLine || line, text });
    buf = '';
    startLine = 0;
  };
  /** Copy a quoted run verbatim, treating a doubled delimiter as an escape. */
  const copyQuoted = (quote) => {
    push(quote);
    i += 1;
    while (i < n) {
      const c = sql[i];
      if (c === '\n') line += 1;
      if (c === quote) {
        if (sql[i + 1] === quote) {
          push(quote);
          push(quote);
          i += 2;
          continue;
        }
        push(quote);
        i += 1;
        return;
      }
      push(c);
      i += 1;
    }
  };

  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';

    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i += 1;
      continue; // leave the newline for the line counter below
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) {
        if (sql[i] === '\n') line += 1;
        i += 1;
      }
      i += 2;
      push(' ');
      continue;
    }
    if (ch === "'" || ch === '"') {
      copyQuoted(ch);
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        for (const c of tag) push(c);
        i += tag.length;
        const close = sql.indexOf(tag, i);
        const bodyEnd = close === -1 ? n : close;
        for (let j = i; j < bodyEnd; j++) {
          if (sql[j] === '\n') line += 1;
          push(sql[j]);
        }
        if (close === -1) {
          i = n;
        } else {
          for (const c of tag) push(c);
          i = close + tag.length;
        }
        continue;
      }
    }
    if (ch === ';') {
      push(ch);
      end();
      i += 1;
      continue;
    }
    if (ch === '\n') line += 1;
    push(ch);
    i += 1;
  }
  end();
  return statements;
}

/**
 * Blank the BODY of every single-quoted string and dollar-quoted body (space for char, newlines
 * kept) so a keyword or a table name that lives inside a literal is never read as SQL. Quoted
 * IDENTIFIERS are left intact — they carry the object names this gate exists to check.
 */
function blankLiteralBodies(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '"') {
      out += ch;
      i += 1;
      while (i < n) {
        const c = s[i];
        out += c;
        i += 1;
        if (c === '"') {
          if (s[i] === '"') {
            out += '"';
            i += 1;
            continue;
          }
          break;
        }
      }
      continue;
    }
    if (ch === "'") {
      out += ch;
      i += 1;
      while (i < n) {
        if (s[i] === "'") {
          if (s[i + 1] === "'") {
            out += '  ';
            i += 2;
            continue;
          }
          out += "'";
          i += 1;
          break;
        }
        out += s[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(s.slice(i))?.[0];
      if (tag) {
        out += tag;
        i += tag.length;
        const close = s.indexOf(tag, i);
        const bodyEnd = close === -1 ? n : close;
        for (let j = i; j < bodyEnd; j++) out += s[j] === '\n' ? '\n' : ' ';
        if (close === -1) {
          i = n;
        } else {
          out += tag;
          i = close + tag.length;
        }
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Unquote an object name and drop any schema qualification — `"public"."fx_t"` reads as `fx_t`. */
function objectName(raw) {
  const parts = raw.split('.');
  const last = parts[parts.length - 1].trim();
  return last.startsWith('"') ? last.slice(1, -1).replace(/""/g, '"') : last;
}

/**
 * Check one migration file's SQL against a required table prefix. Pure (no I/O) so the regression
 * exercises the EXACT logic the CI run does. `rel` is used only in messages. Returns
 * `{ violations, statements }` — the statement count is what the pass line reports.
 */
export function scanPackMigrationSql(rel, sql, tablePrefix) {
  const violations = [];
  const statements = splitStatements(sql);

  for (const stmt of statements) {
    const at = `${rel}:${stmt.line}`;
    const text = blankLiteralBodies(stmt.text);
    const shown = stmt.text.length > 120 ? `${stmt.text.slice(0, 120)}…` : stmt.text;

    if (!ADDITIVE_FORMS.some((re) => re.test(text))) {
      const destructive = DESTRUCTIVE.some((re) => re.test(text));
      violations.push(
        destructive
          ? `${at}: destructive statement in a pack migration chain — ${shown}. A pack chain is ` +
              'additive-only and has NO allowlist: there is no entry to author that would clear this.'
          : `${at}: not an additive statement — ${shown}. A pack migration chain may only CREATE ` +
              'TABLE / CREATE INDEX / CREATE TYPE / ALTER TABLE ... ADD (fail-closed).',
      );
      continue;
    }

    const table = CREATE_TABLE_RE.exec(text);
    if (table) {
      const name = objectName(table[1]);
      if (!name.startsWith(tablePrefix)) {
        violations.push(
          `${at}: CREATE TABLE "${name}" does not carry the declared table prefix ` +
            `'${tablePrefix}' — a pack's tables live in the pack's own namespace.`,
        );
      }
      continue;
    }

    const index = CREATE_INDEX_RE.exec(text);
    if (index) {
      const name = objectName(index[2]);
      const kind = index[1] ? 'CREATE UNIQUE INDEX' : 'CREATE INDEX';
      if (!name.startsWith(tablePrefix)) {
        violations.push(
          `${at}: ${kind} "${name}" does not carry the declared table prefix ` +
            `'${tablePrefix}' — a pack's indexes live in the pack's own namespace.`,
        );
      }
      continue;
    }

    // An unnamed `CREATE INDEX ON t (...)` reaches here: it matched the additive form but has no
    // object name to bind, and the server names it. Fail closed — the chain must say the name.
    if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(text)) {
      violations.push(
        `${at}: ${shown} creates an UNNAMED index — a pack migration chain must name every index ` +
          `so the name can carry the declared table prefix '${tablePrefix}' (fail-closed).`,
      );
    }
  }

  return { violations, statements: statements.length };
}

/**
 * Scan one declared chain. Returns `{ violations, files, statements }`. A directory that reads no
 * `.sql` file — empty, renamed or absent — yields a fail-closed violation naming the chain.
 */
function scanChain(dir, tablePrefix) {
  const violations = [];
  if (!PREFIX_RE.test(tablePrefix)) {
    violations.push(
      `${dir}: the declared table prefix '${tablePrefix}' is not a plain SQL identifier fragment.`,
    );
    return { violations, files: 0, statements: 0 };
  }

  let names = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  } catch {
    names = []; // an absent / unreadable directory reads nothing — handled as the zero-file case.
  }
  if (names.length === 0) {
    violations.push(
      `${dir}: scanned 0 migration file(s) — a declared pack migration chain that reads nothing is ` +
        'a FAILURE, not a skip (the chain was renamed, emptied or never landed).',
    );
    return { violations, files: 0, statements: 0 };
  }

  let statements = 0;
  for (const name of names.sort()) {
    const full = join(dir, name);
    const rel = relative(repoRoot, full).startsWith('..') ? full : relative(repoRoot, full);
    const result = scanPackMigrationSql(
      rel.split('\\').join('/'),
      readFileSync(full, 'utf8'),
      tablePrefix,
    );
    violations.push(...result.violations);
    statements += result.statements;
  }
  return { violations, files: names.length, statements };
}

const argv = process.argv.slice(2);
if (argv.length !== 0 && argv.length !== 2) {
  console.error(
    'pack-migrations gate: usage — `check-pack-migrations.mjs` (every declared chain) or ' +
      '`check-pack-migrations.mjs <dir> <tablePrefix>` (one chain).',
  );
  process.exit(2);
}
const chains =
  argv.length === 2
    ? [{ dir: argv[0], tablePrefix: argv[1] }]
    : DECLARED_CHAINS.map((c) => ({ dir: join(repoRoot, c.dir), tablePrefix: c.tablePrefix }));

const violations = [];
let scannedFiles = 0;
let scannedStatements = 0;
for (const { dir, tablePrefix } of chains) {
  const result = scanChain(resolve(dir), tablePrefix);
  violations.push(...result.violations);
  scannedFiles += result.files;
  scannedStatements += result.statements;
}

if (violations.length > 0) {
  console.error('pack-migrations gate FAILED:');
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    "\nEvery table and index a pack migration chain creates must carry the pack's declared table " +
      'prefix, and the chain must be additive-only. A pack chain has NO allowlist and no mechanism ' +
      'to author one: a closed pack does not get a lower bar than the core.',
  );
  process.exit(1);
}

console.log(
  `pack-migrations gate PASSED: ${chains.length} chain(s), ${scannedFiles} migration file(s), ` +
    `${scannedStatements} statement(s) — every created table and index carries its declared table ` +
    'prefix, and every statement is additive.',
);
