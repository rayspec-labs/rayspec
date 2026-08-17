/**
 * The pack-migration chain scan — an extension pack's hand-written platform tables stay inside its
 * own namespace, and its chain stays additive.
 *
 * TWO CALLERS, ONE RULE SET. `gate:pack-migrations` runs this over the chains committed in this
 * repository, so a violation lands as a red CI check on the pull request that introduced it; and
 * `applyPackMigrations` runs it over every chain a deployment is about to apply, so a chain that
 * never passed through this repository's CI still cannot reach the database. A pack is code from
 * somewhere else — the gate alone would only ever have covered the packs we happen to ship.
 *
 * NAMESPACE. Every `CREATE TABLE` and every `CREATE INDEX` / `CREATE UNIQUE INDEX` must NAME an
 * object that carries the declared prefix, and every `ALTER TABLE` and every `CREATE INDEX … ON`
 * must TARGET a table that carries it. A chain that creates a bare `orgs`, or that alters one, is
 * not a pack owning its own tables — it is a pack reaching into the platform's.
 *
 * IN POSTGRES'S CASE SPACE, BECAUSE THE SERVER IS. An UNQUOTED identifier is FOLDED to lower case
 * before it names anything — `ALTER TABLE Orgs` targets `orgs`, the platform's own table — while a
 * QUOTED one is not (`"Orgs"` is a different table from `orgs`). A comparison that read both
 * verbatim would therefore have measured a name the database never sees: `tablePrefix: 'Orgs'` with
 * `ALTER TABLE Orgs ADD …` would read as a pack staying inside its own namespace while the statement
 * reached the platform's table, and two packs declaring `Acme_` and `acme_` would read as two
 * namespaces while owning one. So a declared prefix must BE in the folded form (lower case) and an
 * unquoted object name is folded before it is measured against it.
 *
 * ADDITIVE-ONLY, AND NO ALLOWLIST — THE ASYMMETRY IS DELIBERATE. The destructive half is not a
 * second, weaker vocabulary written here: it is the platform's OWN `scanMigrationSql`, run over the
 * pack chain with an EMPTY allowlist. On the platform chain `gate:migrations` runs that same scan
 * against a reviewed allowlist in `migration-scan.allowlist.ts`; a pack chain gets no equivalent and
 * no mechanism to author one, so every finding the scan raises is a refusal, full stop. The
 * allowlist is a record of changes this repository's maintainers reviewed line by line; giving a
 * pack the same escape hatch would mean a closed pack clearing itself to drop a table nobody here
 * ever read. Because both halves run the SAME detector set, "no lower bar than the core" is a
 * property of the wiring rather than a claim to re-verify whenever that set grows — and ON TOP of it
 * a pack chain must also match the ACCEPTED set below, so a statement nobody anticipated fails
 * CLOSED instead of passing because no detector named it. That is the higher bar.
 *
 * A ZERO-FILE SCAN IS A FAILURE. A declared chain whose directory is empty, renamed or absent reads
 * nothing, which would otherwise report a clean pass over a chain that was never scanned — the
 * fail-open shape the chokepoint-family gates closed with a scanned-count guard. It is a violation
 * naming the chain, and the result reports how many files and statements were actually read.
 *
 * The scan reads SQL TEXT, so it strips comments and blanks string-literal bodies before it matches
 * anything: a `-- CREATE TABLE orgs` note and a `DEFAULT 'DROP TABLE orgs'` column default are not
 * statements, and a `;` or `--` inside a literal or a quoted identifier is not structure. Statement
 * boundaries are a SUPERSET of the MIGRATOR's, and by construction rather than by imitation: the RAW
 * file text is split on drizzle's `--> statement-breakpoint` marker FIRST, exactly as
 * `readMigrationFiles` does, and only then is each chunk walked for a literal-aware `;`. The ORDER
 * is the whole point — drizzle never parses comments, so a marker sitting behind a `--` earlier on
 * the same line is still a boundary to it, and a scan that stripped comments first would swallow the
 * marker and with it every statement the migrator would go on to run. A statement whose text still
 * holds a second top-level verb after that, or an unterminated literal that swallows the rest of the
 * file, is refused rather than scanned at its opening keywords alone.
 *
 * ONE THING HERE IS EXPORTED FOR A CONSUMER THAT IS NOT A MIGRATION: the literal-aware splitter
 * (`splitSqlStatements`), which the pack database door in `@rayspec/app-server` reads to refuse a
 * `query` string carrying more than one command. Its own docblock states what that second consumer
 * is promised and what stays file-oriented; everything else in this file is private.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { scanMigrationSql } from './migration-scan.js';

/**
 * A declared prefix must be a plain SQL identifier fragment IN THE CASE POSTGRES STORES IT — lower.
 * The `i` flag this pattern used to carry admitted `Orgs`, and every namespace comparison in this
 * module and in `assertNamespaces` is text: an uppercase prefix is one nothing the server actually
 * writes down could be measured against. Lower case is the single space a declared prefix and a
 * folded object name can meet in, so anything else is a config error rather than a namespace.
 */
const PREFIX_RE = /^[a-z_][a-z0-9_]*$/;

/** The refusal a prefix outside that form gets, anchored at whatever the caller is scanning. */
function prefixShapeViolation(at: string, tablePrefix: string): string {
  return (
    `${at}: the declared table prefix '${tablePrefix}' is not a plain lowercase SQL identifier ` +
    'fragment — PostgreSQL folds an UNQUOTED identifier to lower case, so a prefix given in any ' +
    'other case names a namespace the server never writes down and nothing could hold the chain to ' +
    '(fail-closed).'
  );
}

/**
 * The statement forms a pack chain may contain. Everything else is refused: "additive-only" is
 * expressed as the accepted set, not as a list of the destructive things to look for, so a statement
 * nobody anticipated fails CLOSED instead of passing because no detector named it. This is the bar
 * ON TOP of the platform scan, never instead of it: matching a form here does not excuse a statement
 * from the destructive scan, so an `ALTER TABLE … DROP COLUMN "a", ADD COLUMN "b" text` — one legal
 * Postgres statement carrying both an additive and a destructive action — is refused by the scan
 * even though the form below accepts its shape.
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
 * whether or not the statement before it ended in `;`, so a chain that omits the semicolons is still
 * several statements to the migrator — and must be several statements here.
 */
const BREAKPOINT = '--> statement-breakpoint';

/** One breakpoint-delimited chunk of a migration file, with the newlines that precede it. */
interface Chunk {
  readonly text: string;
  readonly lineOffset: number;
}

/** One split statement: its 1-based line and its whitespace-collapsed text. */
export interface SqlStatement {
  readonly line: number;
  readonly text: string;
}

/** An unterminated literal — the first one found, and what kind it was. */
export interface UnterminatedLiteral {
  readonly line: number;
  readonly what: string;
}

/** What one literal-aware split read: the statements, and the first unterminated literal if any. */
export interface SqlStatementSplit {
  readonly statements: SqlStatement[];
  readonly unterminated: UnterminatedLiteral | null;
}

/**
 * Cut a migration file the way the MIGRATOR cuts it: `readMigrationFiles` does
 * `query.split('--> statement-breakpoint')` on the RAW text and the dialect then executes EVERY
 * chunk (`for (const stmt of migration.sql) await tx.execute(sql.raw(stmt))`), consulting no comment
 * rule anywhere — drizzle has no lexer, so nothing can hide the marker from it.
 *
 * That is why this runs BEFORE any comment handling. A marker with a `--` earlier on the same line
 * (`-- x --> statement-breakpoint DROP TABLE "orgs";`) reads as an ordinary line comment to a scan
 * that strips comments first, which drops the marker AND the statement behind it while the migrator
 * happily runs that statement. Splitting the raw text first makes these boundaries a superset of the
 * migrator's by construction: whatever it would execute as a statement of its own is scanned here as
 * a statement of its own.
 *
 * A marker that lands inside a string or dollar-quoted literal cuts that literal in half, and the
 * fail-closed unterminated-literal path refuses the chain. That is the correct verdict, not a false
 * positive: the migrator would cut it in exactly the same place and execute both halves.
 *
 * Each chunk carries the number of newlines before it, so every diagnostic keeps the line number the
 * file on disk actually has (the marker itself spans no newline).
 */
function breakpointChunks(sql: string): Chunk[] {
  const chunks: Chunk[] = [];
  let lineOffset = 0;
  for (const text of sql.split(BREAKPOINT)) {
    chunks.push({ text, lineOffset });
    lineOffset += (text.match(/\n/g) ?? []).length;
  }
  return chunks;
}

/**
 * Split a piece of SQL TEXT into statements, LITERAL-AWARE — the primitive, and the only place in
 * this repository that decides where one statement ends and the next begins. Walks the text tracking
 * lexer state so a `--`, a slash-star block comment or a `;` inside a single-quoted string ('', the
 * escaped quote), a dollar-quoted body ($tag$...$tag$) or a double-quoted identifier ("", the escaped
 * quote) is not mistaken for structure. Comments are dropped; literal and identifier bodies are kept
 * verbatim so a caller that matches object names still sees the name it must check. Each statement
 * comes back with its 1-based starting line WITHIN THE TEXT GIVEN and its internal whitespace
 * collapsed to single spaces, so a newline-split `DROP\nTABLE` reads as one statement.
 *
 * TWO CONSUMERS, DIFFERENT SHAPES — which is why this is exported and the rest of this file is not.
 * The migration scan below feeds it ONE BREAKPOINT CHUNK of a file at a time and uses everything it
 * returns: the line numbers become `<file>:<line>` diagnostics, and the statements are scanned one by
 * one. `@rayspec/app-server`'s pack database door feeds it ONE STRING a pack passed to `query` and
 * uses only HOW MANY came back — `query` runs one statement, and `postgres`'s `unsafe` with no
 * parameters runs Postgres SIMPLE-QUERY mode, which executes every command in the string. So the
 * file-oriented machinery around this function — the `--> statement-breakpoint` cut, the line
 * lifting, the additive-form rules — is NOT part of what the second consumer is promised, and an
 * edit that folded any of it INTO this function would silently change the door's answer. What both
 * consumers depend on is exactly this: what counts as a statement boundary and what does not.
 *
 * The `--> statement-breakpoint` marker needs no case here: it is a drizzle FILE convention, and
 * `breakpointChunks` has already removed every one of them from the raw text before this runs, which
 * is the only order in which a comment strip cannot swallow a boundary the migrator honours.
 *
 * `unterminated` is the first literal that ran to the end of the text without a closing delimiter —
 * everything after it was swallowed into one statement and cannot have been read. BOTH consumers
 * REFUSE on it rather than reading `statements` alone, and the door's reason is worth recording
 * here: a dollar-quote is opened on the `$tag$` SHAPE, and the legal identifier `a$b$c` has that
 * shape, so `SELECT 1 AS a$b$c; INSERT …` swallows the whole string into one statement here while
 * Postgres reads two commands and runs both. An unreadable string is not a short one.
 */
export function splitSqlStatements(sql: string): SqlStatementSplit {
  const statements: SqlStatement[] = [];
  let unterminated: UnterminatedLiteral | null = null;
  let buf = '';
  let line = 1;
  let startLine = 0;
  let i = 0;
  const n = sql.length;

  const push = (ch: string): void => {
    if (startLine === 0 && ch.trim().length > 0) startLine = line;
    buf += ch;
  };
  const end = (): void => {
    const text = buf.replace(/\s+/g, ' ').trim();
    if (text.length > 0) statements.push({ line: startLine || line, text });
    buf = '';
    startLine = 0;
  };
  /** Copy a quoted run verbatim, treating a doubled delimiter as an escape. */
  const copyQuoted = (quote: string): void => {
    const openedAt = line;
    push(quote);
    i += 1;
    while (i < n) {
      const c = sql[i] as string;
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
    const ch = sql[i] as string;
    const next = i + 1 < n ? (sql[i + 1] as string) : '';

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
      const tag = DOLLAR_TAG_RE.exec(sql.slice(i))?.[0];
      if (tag) {
        const openedAt = line;
        for (const c of tag) push(c);
        i += tag.length;
        const close = sql.indexOf(tag, i);
        const bodyEnd = close === -1 ? n : close;
        for (let j = i; j < bodyEnd; j++) {
          if (sql[j] === '\n') line += 1;
          push(sql[j] as string);
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
 * Split a whole migration FILE into the statements the migrator would run: cut the raw text on the
 * breakpoint marker first (`breakpointChunks`), then walk each chunk with the literal-aware splitter.
 * Line numbers from each chunk are lifted back onto the file, so a diagnostic still points at the
 * line on disk. The first unterminated literal ANYWHERE in the file is the one reported.
 *
 * FILE-ORIENTED, AND PRIVATE FOR THAT REASON: the breakpoint marker and the line lifting are facts
 * about a drizzle migration file on disk, not about SQL, so the other consumer of the splitter above
 * must not reach them.
 */
function splitFileStatements(sql: string): SqlStatementSplit {
  const statements: SqlStatement[] = [];
  let unterminated: UnterminatedLiteral | null = null;
  for (const chunk of breakpointChunks(sql)) {
    const result = splitSqlStatements(chunk.text);
    for (const stmt of result.statements) {
      statements.push({ line: stmt.line + chunk.lineOffset, text: stmt.text });
    }
    if (!unterminated && result.unterminated) {
      unterminated = {
        what: result.unterminated.what,
        line: result.unterminated.line + chunk.lineOffset,
      };
    }
  }
  return { statements, unterminated };
}

/**
 * Blank the BODY of every single-quoted string and dollar-quoted body (space for char, newlines
 * kept) so a keyword or a table name that lives inside a literal is never read as SQL. Quoted
 * IDENTIFIERS are left intact — they carry the object names this scan exists to check.
 */
function blankLiteralBodies(s: string): string {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i] as string;
    if (ch === '"') {
      out += ch;
      i += 1;
      while (i < n) {
        const c = s[i] as string;
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

/**
 * Unquote an object name, drop any schema qualification (`"public"."fx_t"` reads as `fx_t`), and put
 * it in the case the SERVER will store it under: an UNQUOTED identifier is folded to lower case
 * (`ALTER TABLE Orgs` targets `orgs`), a QUOTED one keeps its case exactly (`"Orgs"` is its own
 * table). Only the unquoted branch folds, because only the unquoted branch is folded by Postgres.
 */
function objectName(raw: string): string {
  const parts = raw.split('.');
  const last = (parts[parts.length - 1] as string).trim();
  return last.startsWith('"') ? last.slice(1, -1).replace(/""/g, '"') : last.toLowerCase();
}

/** Clip a statement for a diagnostic. */
function clip(text: string): string {
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/** What one migration file's scan found: the refusals, and how many statements were read. */
export interface PackMigrationFileScan {
  /** Every refusal, each already carrying `<file>:<line>` and an actionable reason. */
  readonly violations: string[];
  /** How many statements were actually read (what a pass line reports). */
  readonly statements: number;
}

/** What a whole chain's scan found, plus how much of it was read. */
export interface PackMigrationChainScan extends PackMigrationFileScan {
  /** How many `.sql` files were read — zero is itself a violation, never a skip. */
  readonly files: number;
}

/**
 * Check one migration file's SQL against a required table prefix. PURE (no I/O) so a caller can
 * exercise the EXACT logic a CI run and a boot both use. `rel` is used only in messages.
 *
 * The prefix's own SHAPE is checked here rather than only in `scanPackMigrationChain`, so this door
 * is fail-closed for every caller: a prefix that is not in Postgres's folded case is one no name in
 * the file could be compared against, and returning "no violations" for it would be a clean pass
 * over a namespace rule that never ran. (The chain scan returns before it reaches a file, so a chain
 * never collects this twice.)
 */
export function scanPackMigrationSql(
  rel: string,
  sql: string,
  tablePrefix: string,
): PackMigrationFileScan {
  const violations: string[] = [];

  if (!PREFIX_RE.test(tablePrefix)) {
    return { violations: [prefixShapeViolation(rel, tablePrefix)], statements: 0 };
  }

  // The destructive half: the PLATFORM's scan, with NO allowlist. Every finding is a refusal — there
  // is no entry to author that would clear one. It runs per BREAKPOINT CHUNK for the same reason the
  // splitter does: the core scan strips `--` line comments (it scans plain SQL, where a comment
  // really is one), so on a chain file it would read `-- x --> statement-breakpoint DROP TABLE
  // "orgs";` as a comment and never see the DROP the migrator would run. Cutting on the marker first
  // hands it exactly the text the migrator would execute. The scan carries no state across
  // statements, so on a file without markers this is the identical call `gate:migrations` makes; the
  // chunk's line offset puts the finding back on its line in the file.
  for (const chunk of breakpointChunks(sql)) {
    for (const finding of scanMigrationSql(chunk.text, []).findings) {
      violations.push(
        `${rel}:${finding.line + chunk.lineOffset}: destructive statement in a pack migration ` +
          `chain [${finding.kind}] — ${clip(finding.text)}. The platform chain clears such a ` +
          'statement only through a reviewed allowlist entry; a pack chain has NO allowlist and ' +
          'no mechanism to author one.',
      );
    }
  }

  const { statements, unterminated } = splitFileStatements(sql);
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
    const requirePrefix = (what: string, raw: string): void => {
      const name = objectName(raw);
      if (name.startsWith(tablePrefix)) return;
      violations.push(
        `${at}: ${what} "${name}" does not carry the declared table prefix '${tablePrefix}' — a ` +
          "pack's tables and indexes live in the pack's own namespace.",
      );
    };

    const table = CREATE_TABLE_RE.exec(text);
    if (table) {
      requirePrefix('CREATE TABLE', table[1] as string);
      continue;
    }

    const index = CREATE_INDEX_RE.exec(text);
    if (index) {
      requirePrefix(index[1] ? 'CREATE UNIQUE INDEX' : 'CREATE INDEX', index[2] as string);
      const target = INDEX_TARGET_RE.exec(text.slice(index[0].length));
      if (target) requirePrefix('an index ON table', target[1] as string);
      continue;
    }

    const altered = ALTER_TABLE_RE.exec(text);
    if (altered) {
      requirePrefix('ALTER TABLE', altered[1] as string);
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
 * Scan one chain DIRECTORY of `.sql` files against a required table prefix. A directory that reads
 * no `.sql` file — empty, renamed or absent — yields a fail-closed violation naming the chain rather
 * than a vacuous pass.
 *
 * `relativeTo` only shortens the paths in the messages (the gate passes the repository root so its
 * diagnostics stay repo-relative); it changes nothing about what is read or refused.
 */
export function scanPackMigrationChain(
  dir: string,
  tablePrefix: string,
  relativeTo?: string,
): PackMigrationChainScan {
  const violations: string[] = [];
  if (!PREFIX_RE.test(tablePrefix)) {
    violations.push(prefixShapeViolation(dir, tablePrefix));
    return { violations, files: 0, statements: 0 };
  }

  let names: string[] = [];
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
    const shortened = relativeTo === undefined ? full : relative(relativeTo, full);
    const rel = shortened.startsWith('..') ? full : shortened;
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
