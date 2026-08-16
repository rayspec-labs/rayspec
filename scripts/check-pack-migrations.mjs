#!/usr/bin/env node
/**
 * Pack-migration chain gate — a pack's hand-written platform tables stay inside its own namespace.
 *
 * An extension pack contributes product tables through `stores`, which the platform generates and
 * owns. A pack that needs platform state instead — hand-shaped indexes, foreign keys, an
 * append-only ledger — brings its own migration chain, and that chain runs through the same
 * migrator as the platform's. Two chains writing into one database is only safe while each one
 * stays in its own namespace, so a pack declares a table prefix and this gate holds the chain to
 * it: EVERY `CREATE TABLE` and EVERY `CREATE INDEX` / `CREATE UNIQUE INDEX` must NAME an object
 * that carries the prefix, and every `ALTER TABLE` and every `CREATE INDEX ... ON` must TARGET a
 * table that carries it. A chain that creates a bare `orgs`, or that alters one, is not a pack
 * owning its own tables — it is a pack reaching into the platform's.
 *
 * ADDITIVE-ONLY, AND NO ALLOWLIST — THE ASYMMETRY IS DELIBERATE. The destructive half of this gate
 * is not a second, weaker vocabulary written here: it is the platform's OWN scan,
 * `scanMigrationSql` from `@rayspec/db`, run over the pack chain with an EMPTY allowlist. On the
 * platform chain `gate:migrations` runs that same scan against a reviewed allowlist in
 * packages/kernel/db/src/migration-scan.allowlist.ts; a pack chain gets no equivalent and no
 * mechanism to author one, so every finding the scan raises is a refusal, full stop. The
 * allowlist is a record of changes the platform's own maintainers reviewed line by line in this
 * repository; a pack is code from somewhere else, and giving it the same escape hatch would mean
 * a closed pack clearing itself to drop a table nobody in this repository ever read. Because the
 * two gates run the SAME detector set, "no lower bar than the core" is a property of the wiring
 * rather than a claim to re-verify whenever that set grows — and ON TOP of it a pack chain must
 * also match the ACCEPTED set below, so a statement nobody anticipated fails CLOSED instead of
 * passing because no detector named it. That is the higher bar.
 *
 * A ZERO-FILE OR ZERO-CHAIN SCAN IS A FAILURE. A declared chain whose directory is empty, renamed
 * or absent reads nothing, and so does an emptied `DECLARED_CHAINS`; either would otherwise report
 * a clean pass over a chain that was never scanned — the fail-open shape the chokepoint-family
 * gates closed with a scanned-count guard. The gate refuses on both, names what was not scanned,
 * and its pass line reports how many chains, files and statements it actually read.
 *
 * The gate reads SQL TEXT, so it strips comments and blanks string-literal bodies before it
 * matches anything (the shape `check-handler-imports.mjs` uses for source): a `-- CREATE TABLE
 * orgs` note and a `DEFAULT 'DROP TABLE orgs'` column default are not statements, and a `;` or
 * `--` inside a literal or a quoted identifier is not structure. Statement boundaries are the ones
 * the MIGRATOR uses — a literal-aware `;` AND drizzle's `--> statement-breakpoint` marker, which
 * it splits on whether or not a `;` is there (drizzle-orm/migrator.js). A statement whose text
 * still holds a second top-level verb after that, or an unterminated literal that swallows the
 * rest of the file, is refused rather than scanned at its opening keywords alone.
 *
 * NEEDS THE BUILD: it imports the platform scan from `@rayspec/db`'s built output, so it runs
 * after `pnpm build` (as `gate:spec-schema` and `gate:api-report` already do). It needs no
 * database.
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
 * The platform's destructive-migration scan. Loading it is fail-closed on purpose: a gate that
 * silently fell back to a vocabulary of its own when the build was missing would be exactly the
 * "lower bar than the core" this gate exists to prevent.
 */
let scanMigrationSql;
try {
  ({ scanMigrationSql } = await import('@rayspec/db'));
} catch (cause) {
  console.error(
    'pack-migrations gate: could not load the platform destructive-migration scan from ' +
      `@rayspec/db — ${cause.message}\n\nRun \`pnpm build\` first. The gate refuses rather than ` +
      'scanning a pack chain with a weaker rule set of its own.',
  );
  process.exit(2);
}

/**
 * The pack migration chains scanned in CI, each `{ dir, tablePrefix }`. The chain is a directory of
 * `.sql` files and the prefix is the namespace the pack claims — the same pair a pack manifest
 * declares. On the platform main line the only chain is the in-tree fixture pack's, which exists so
 * this gate scans real committed bytes rather than reporting a pass over an empty declared set.
 * EMPTYING THIS ARRAY DOES NOT RETIRE THE GATE — a zero-chain run fails closed (see below).
 */
const DECLARED_CHAINS = [
  { dir: 'packages/test/fixture-pack/migrations', tablePrefix: 'fixture_pack_' },
];

/** A declared prefix must be a plain SQL identifier fragment — anything else is a config error. */
const PREFIX_RE = /^[a-z_][a-z0-9_]*$/i;

/**
 * The statement forms a pack chain may contain. Everything else is refused: "additive-only" is
 * expressed as the accepted set, not as a list of the destructive things to look for, so a
 * statement nobody anticipated fails CLOSED instead of passing because no detector named it. This
 * is the bar ON TOP of the platform scan, never instead of it: matching a form here does not
 * excuse a statement from the destructive scan, so an `ALTER TABLE ... DROP COLUMN "a", ADD
 * COLUMN "b" text` — one legal Postgres statement carrying both an additive and a destructive
 * action — is refused by the scan even though the form below accepts its shape.
 */
const ADDITIVE_FORMS = [
  /^CREATE\s+TABLE\b/i,
  /^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i,
  /^CREATE\s+TYPE\b/i,
  /^ALTER\s+TABLE\b[\s\S]*\bADD\b/i,
];

/**
 * Verbs that can only BEGIN a statement. Two of them in one scanned statement means a boundary was
 * missed — an unterminated statement, an exotic separator — and every decision below is anchored at
 * `^`, so the tail would be judged on the head's keywords. Refuse instead. Keywords that are ALTER
 * TABLE *actions* (`DROP CONSTRAINT`, `DROP COLUMN`) are deliberately absent: they are legal inside
 * one statement, and the platform scan is what refuses them.
 */
const SECOND_VERB_RE =
  /\b(?:CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX|TYPE|SCHEMA|(?:MATERIALIZED\s+)?VIEW)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|TYPE|SCHEMA|(?:MATERIALIZED\s+)?VIEW|DATABASE|OWNED)|TRUNCATE|INSERT\s+INTO|DELETE\s+FROM)\b/gi;

/** An object name: a quoted or bare identifier, optionally schema-qualified. */
const NAME = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))?`;
const CREATE_TABLE_RE = new RegExp(
  String.raw`^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${NAME})`,
  'i',
);
// The lookahead keeps SQL keywords out of the name capture: an unnamed `CREATE INDEX ON t (...)`
// would otherwise bind the name "ON" — a fabricated diagnostic, and a bypass for any prefix that
// "on" starts with — instead of reaching the fail-closed unnamed branch below. `CONCURRENTLY` and
// `IF` are named too because the optional groups ahead of the capture BACKTRACK: on
// `CREATE INDEX CONCURRENTLY ON t (...)` the engine gives the optional group up to satisfy the
// capture and binds "CONCURRENTLY" instead. Every one of them must fall through to the branch.
const CREATE_INDEX_RE = new RegExp(
  String.raw`^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?!(?:ON|CONCURRENTLY|IF)\b)(${NAME})`,
  'i',
);
/** The table an index is built ON — a pack may not index a table it does not own. */
const INDEX_TARGET_RE = new RegExp(String.raw`\bON\s+(?:ONLY\s+)?(${NAME})`, 'i');
/** The table an `ALTER TABLE` targets — the same namespace rule as a created object. */
const ALTER_TABLE_RE = new RegExp(
  String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${NAME})`,
  'i',
);

/**
 * A dollar-quote tag follows unquoted-identifier rules except that it may not contain a `$`, so
 * DIGITS after the first character are legal (`$tag1$`). A pattern that stopped at letters read
 * `$tag1$hi$tag1$` as no-quote-then-`$hi$`-opener, found no partner for it, and swallowed the rest
 * of the file into the current statement — everything after a valid literal went unscanned.
 */
const DOLLAR_TAG_RE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Drizzle's statement separator. `migrator.js` splits each migration file on this exact string
 * whether or not the statement before it ended in `;`, so a chain that omits the semicolons is
 * still several statements to the migrator — and must be several statements here.
 */
const BREAKPOINT = '--> statement-breakpoint';

/**
 * Split SQL into statements the way the MIGRATOR does, LITERAL-AWARE. Walks the text tracking lexer
 * state so a `--`, a slash-star block comment or a `;` inside a single-quoted string ('', the
 * escaped quote), a dollar-quoted body ($tag$...$tag$) or a double-quoted identifier ("", the
 * escaped quote) is not mistaken for structure. A statement ends at a top-level `;` OR at a
 * `--> statement-breakpoint` marker, which is recognised BEFORE the `--` comment strip could
 * swallow it. Comments are dropped; literal and identifier bodies are kept verbatim so the
 * object-name match below still sees the name it must check. Each statement is returned with its
 * 1-based starting line and its internal whitespace collapsed to single spaces, so a newline-split
 * `DROP\nTABLE` reads as one statement.
 *
 * Returns `{ statements, unterminated }`. `unterminated` is the first literal that ran to the end
 * of the file without a closing delimiter — everything after it was swallowed into one statement
 * and cannot have been scanned, which the caller turns into a refusal instead of a silent pass.
 */
function splitStatements(sql) {
  const statements = [];
  let unterminated = null;
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
    const openedAt = line;
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
    unterminated ??= {
      line: openedAt,
      what: quote === "'" ? 'string literal' : 'quoted identifier',
    };
  };

  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';

    if (ch === '-' && next === '-') {
      if (sql.startsWith(BREAKPOINT, i)) {
        end(); // the marker is a statement boundary to the migrator, so it is one here
        i += BREAKPOINT.length;
        continue;
      }
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
      const tag = DOLLAR_TAG_RE.exec(sql.slice(i))?.[0];
      if (tag) {
        const openedAt = line;
        for (const c of tag) push(c);
        i += tag.length;
        const close = sql.indexOf(tag, i);
        const bodyEnd = close === -1 ? n : close;
        for (let j = i; j < bodyEnd; j++) {
          if (sql[j] === '\n') line += 1;
          push(sql[j]);
        }
        if (close === -1) {
          unterminated ??= { line: openedAt, what: `dollar-quoted literal ${tag}` };
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
  return { statements, unterminated };
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
      const tag = DOLLAR_TAG_RE.exec(s.slice(i))?.[0];
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

/** Clip a statement for a diagnostic. */
function clip(text) {
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/**
 * Check one migration file's SQL against a required table prefix. Pure (no I/O) so the regression
 * exercises the EXACT logic the CI run does. `rel` is used only in messages. Returns
 * `{ violations, statements }` — the statement count is what the pass line reports.
 */
export function scanPackMigrationSql(rel, sql, tablePrefix) {
  const violations = [];

  // The destructive half: the PLATFORM's scan, with NO allowlist. Every finding is a refusal —
  // there is no entry to author that would clear one. Run over the whole file so its line numbers
  // and its unanchored detectors see each statement exactly as `gate:migrations` would.
  for (const finding of scanMigrationSql(sql, []).findings) {
    violations.push(
      `${rel}:${finding.line}: destructive statement in a pack migration chain [${finding.kind}] — ` +
        `${clip(finding.text)}. The platform chain clears such a statement only through a reviewed ` +
        'allowlist entry; a pack chain has NO allowlist and no mechanism to author one.',
    );
  }

  const { statements, unterminated } = splitStatements(sql);
  if (unterminated) {
    violations.push(
      `${rel}:${unterminated.line}: an UNTERMINATED ${unterminated.what} runs to the end of the ` +
        'file — everything after it is swallowed into one statement and cannot have been scanned ' +
        '(fail-closed).',
    );
  }

  for (const stmt of statements) {
    const at = `${rel}:${stmt.line}`;
    const text = blankLiteralBodies(stmt.text);
    const shown = clip(stmt.text);

    if (!ADDITIVE_FORMS.some((re) => re.test(text))) {
      violations.push(
        `${at}: not an additive statement — ${shown}. A pack migration chain may only CREATE ` +
          'TABLE / CREATE INDEX / CREATE TYPE / ALTER TABLE ... ADD (fail-closed).',
      );
      continue;
    }

    if ((text.match(SECOND_VERB_RE)?.length ?? 0) > 1) {
      violations.push(
        `${at}: ${shown} still holds more than one top-level statement verb — the chain must end ` +
          'every statement with a `;` or a `--> statement-breakpoint` marker so each one is ' +
          "scanned on its own, rather than judged on the first one's keywords (fail-closed).",
      );
      continue;
    }

    /** Refuse an object name / target that leaves the pack's declared namespace. */
    const requirePrefix = (what, raw) => {
      const name = objectName(raw);
      if (name.startsWith(tablePrefix)) return;
      violations.push(
        `${at}: ${what} "${name}" does not carry the declared table prefix '${tablePrefix}' — a ` +
          "pack's tables and indexes live in the pack's own namespace.",
      );
    };

    const table = CREATE_TABLE_RE.exec(text);
    if (table) {
      requirePrefix('CREATE TABLE', table[1]);
      continue;
    }

    const index = CREATE_INDEX_RE.exec(text);
    if (index) {
      requirePrefix(index[1] ? 'CREATE UNIQUE INDEX' : 'CREATE INDEX', index[2]);
      const target = INDEX_TARGET_RE.exec(text.slice(index[0].length));
      if (target) requirePrefix('an index ON table', target[1]);
      continue;
    }

    const altered = ALTER_TABLE_RE.exec(text);
    if (altered) {
      requirePrefix('ALTER TABLE', altered[1]);
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

// The AGGREGATE fail-closed guard (the shape `check-no-pack-imports.mjs` uses): the per-chain
// zero-file check above cannot see an empty DECLARED_CHAINS, so emptying that array would retire
// the gate with a clean pass while the committed chain rots. Refuse on an empty scan either way.
if (chains.length === 0 || scannedFiles === 0) {
  violations.push(
    `refusing to certify on an empty scan (fail-closed): ${chains.length} chain(s) and ` +
      `${scannedFiles} migration file(s) were read. ${
        chains.length === 0
          ? 'DECLARED_CHAINS is EMPTY — emptying the declared set does not retire this gate.'
          : 'A declared chain read nothing.'
      }`,
  );
}

if (violations.length > 0) {
  console.error('pack-migrations gate FAILED:');
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    "\nEvery table and index a pack migration chain creates must carry the pack's declared table " +
      'prefix, and the chain must survive the platform destructive scan with NO allowlist. A pack ' +
      'chain has no allowlist and no mechanism to author one: a closed pack does not get a lower ' +
      'bar than the core.',
  );
  process.exit(1);
}

console.log(
  `pack-migrations gate PASSED: ${chains.length} chain(s), ${scannedFiles} migration file(s), ` +
    `${scannedStatements} statement(s) — every created table and index carries its declared table ` +
    'prefix, and every statement is additive.',
);
