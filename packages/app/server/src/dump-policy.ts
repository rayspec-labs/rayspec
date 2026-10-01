/**
 * WHAT OF A DUMP MAY REACH AN IMPORT TARGET — the allowlist an import applies to the table of
 * contents of each custom-format dump (`dump-archive.ts`) before anything is restored.
 *
 * A snapshot's dumps are untrusted: the bundle is authenticated by its encryption, not by who made
 * it. `pg_restore` runs, as the target's migration role, exactly the SQL each table-of-contents entry
 * carries, so the policy reads that SQL itself and decides entry by entry:
 *
 *  - OBJECT KINDS. Restored: schemas, tables, sequences and their ownership and values, column
 *    defaults, constraints and foreign keys, indexes, triggers, row-level policies and the switch that
 *    enables them, functions in a trusted language, table data. Read and not restored: privileges and
 *    default privileges (the target's roles get their own, below), comments, and the entries of the
 *    database itself. Everything else — a view, a type, an operator, a cast, an aggregate, a
 *    procedural language, an event trigger, a publication, a large object, a role — is refused
 *    (`RAY_POLICY_DENIED` `privileged-statement`).
 *  - STATEMENTS. Every restored entry must consist of the statements its kind produces and nothing
 *    else: a table entry is a `CREATE TABLE` and the `ALTER TABLE` forms `pg_dump` adds to it, an
 *    index entry one `CREATE INDEX`, and so on. A table's data must be exactly
 *    `COPY <that table> (<columns>) FROM stdin;`, so `COPY … PROGRAM` never runs; a sequence value
 *    exactly `SELECT pg_catalog.setval(…)`. Statements are split by a lexer that knows SQL's quoting,
 *    so a statement hidden in a string or a comment is not mistaken for another.
 *  - NO DUMP CODE AT RESTORE TIME. A function the dump defines runs only when something calls it. A
 *    restored statement may call a function only by an unqualified name, which resolves in
 *    `pg_catalog` alone (the restore runs with an empty search path), or by `pg_catalog.` — never a
 *    function of the dump, except a trigger naming its trigger function, which runs only after the
 *    restore. Built-in functions that run SQL text or touch the server (`query_to_xml`, `ts_stat`,
 *    `pg_read_file`, `set_config`, `dblink…`, `lo_import`, …) are refused anywhere.
 *  - FUNCTIONS. Only `sql` and `plpgsql`; no `SECURITY DEFINER` except the two lookups the platform
 *    chain creates, unchanged (name, arguments, body and pinned search path, `ISOLATION_DEFINER_
 *    FUNCTIONS`), and only in the application database; no `LEAKPROOF`, `SUPPORT` or `WINDOW`, and no
 *    setting but the search path. A body that names a role, an extension, `ALTER SYSTEM`,
 *    `COPY … PROGRAM` or a file or server function is refused too.
 *  - EXTENSIONS. None in the application database; in the workflow system database only `uuid-ossp`,
 *    which the durable engine's own migrations create (`RAY_POLICY_DENIED`
 *    `unsupported-extension`).
 *  - OWNERS AND GRANTS. Every object belongs to one role, the dump's owner (`unmapped-owner`
 *    otherwise). A privilege may name that role, `PUBLIC`, and the roles its default privileges name;
 *    a grant to any other role is `unmapped-owner`. The mapping onto the target: every object is
 *    restored owned by the target's migration role, and the target's runtime and snapshot roles get
 *    the privileges the database roles setup grants on what the migration role creates.
 *  - NAMES. The dump's tables are exactly the ones `snapshot.json` counts for its database; a table
 *    whose rows the snapshot excludes carries no data, and a counted table with rows carries its data
 *    (`RAY_DIGEST_MISMATCH` `inner-metadata` otherwise).
 *
 * The result is the list of entries to restore, in archive order, which the import hands to
 * `pg_restore --use-list`.
 */
import { type BundleError, bundleError, type ErrorReason } from '@rayspec/bundle-contract';
import { ISOLATION_DEFINER_FUNCTIONS, normalizeFunctionBody } from '@rayspec/db';
import type { DumpToc, DumpTocEntry } from './dump-archive.js';

// ─── the lexer ─────────────────────────────────────────────────────────────────────────────────

type TokenKind = 'word' | 'quoted' | 'string' | 'dollar' | 'number' | 'op' | 'semi';

export interface SqlToken {
  kind: TokenKind;
  /** The token as written. */
  text: string;
  /** A word lowercased, a quoted identifier unquoted, a string or dollar-quoted body unescaped. */
  value: string;
}

/** SQL the lexer cannot read (an unterminated string, quote or comment). */
export class SqlLexError extends Error {}

const WORD_START = /[A-Za-z_\u0080-\uffff]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-\uffff]/;

/**
 * Split SQL into tokens, skipping whitespace and comments. Knows standard strings (`''` doubled),
 * escape strings (`E'…'`), quoted identifiers, dollar quoting and nested block comments.
 */
export function lexSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (depth > 0) {
        if (i >= n) throw new SqlLexError('an unterminated comment');
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    if (
      ch === "'" ||
      (/[EeBbXxNn]/.test(ch) && sql[i + 1] === "'" && !WORD_PART.test(sql[i - 1] ?? ' '))
    ) {
      const backslashEscapes = ch === 'E' || ch === 'e';
      const start = i;
      i = ch === "'" ? i + 1 : i + 2;
      let value = '';
      for (;;) {
        if (i >= n) throw new SqlLexError('an unterminated string');
        const c = sql[i]!;
        if (backslashEscapes && c === '\\') {
          value += sql[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (c === "'") {
          if (sql[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += c;
        i++;
      }
      tokens.push({ kind: 'string', text: sql.slice(start, i), value });
      continue;
    }
    if (ch === '"') {
      const start = i;
      i++;
      let value = '';
      for (;;) {
        if (i >= n) throw new SqlLexError('an unterminated quoted identifier');
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += sql[i];
        i++;
      }
      tokens.push({ kind: 'quoted', text: sql.slice(start, i), value });
      continue;
    }
    if (ch === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag !== null) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        if (close === -1) throw new SqlLexError('an unterminated dollar-quoted string');
        tokens.push({
          kind: 'dollar',
          text: sql.slice(i, close + tag[0].length),
          value: sql.slice(i + tag[0].length, close),
        });
        i = close + tag[0].length;
        continue;
      }
    }
    if (WORD_START.test(ch)) {
      const start = i;
      while (i < n && WORD_PART.test(sql[i]!)) i++;
      const text = sql.slice(start, i);
      tokens.push({ kind: 'word', text, value: text.toLowerCase() });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      const start = i;
      while (i < n && /[0-9.eE]/.test(sql[i]!)) {
        if ((sql[i] === 'e' || sql[i] === 'E') && /[+-]/.test(sql[i + 1] ?? '')) i++;
        i++;
      }
      tokens.push({ kind: 'number', text: sql.slice(start, i), value: sql.slice(start, i) });
      continue;
    }
    if (ch === ';') {
      tokens.push({ kind: 'semi', text: ';', value: ';' });
      i++;
      continue;
    }
    tokens.push({ kind: 'op', text: ch, value: ch });
    i++;
  }
  return tokens;
}

/** Split tokens into statements at each `;`; an empty statement is dropped. */
export function splitStatements(tokens: readonly SqlToken[]): SqlToken[][] {
  const out: SqlToken[][] = [];
  let current: SqlToken[] = [];
  for (const t of tokens) {
    if (t.kind === 'semi') {
      if (current.length > 0) out.push(current);
      current = [];
    } else current.push(t);
  }
  if (current.length > 0) out.push(current);
  return out;
}

// ─── reading statements ────────────────────────────────────────────────────────────────────────

/** Whether the tokens from `at` are these keywords, case-insensitively. */
function keywords(tokens: readonly SqlToken[], at: number, ...words: string[]): boolean {
  return words.every((w, i) => tokens[at + i]?.kind === 'word' && tokens[at + i]!.value === w);
}

function isName(t: SqlToken | undefined): boolean {
  return t !== undefined && (t.kind === 'word' || t.kind === 'quoted');
}

/** A possibly qualified name from `at`: its parts (identifier values) and the index after it. */
function qualifiedName(
  tokens: readonly SqlToken[],
  at: number,
): { parts: string[]; next: number } | null {
  if (!isName(tokens[at])) return null;
  const parts = [tokens[at]!.value];
  let i = at + 1;
  while (tokens[i]?.kind === 'op' && tokens[i]!.value === '.' && isName(tokens[i + 1])) {
    parts.push(tokens[i + 1]!.value);
    i += 2;
  }
  return { parts, next: i };
}

// ─── the policy ────────────────────────────────────────────────────────────────────────────────

/** Which database a dump restores. */
export type DumpDatabase = 'application' | 'workflow-system';

/** The extension the durable engine's own migrations create in the workflow system database. */
const WORKFLOW_SYSTEM_EXTENSION = 'uuid-ossp';
const WORKFLOW_SYSTEM_EXTENSION_SQL =
  'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;';

/** The functions `uuid-ossp` provides, the only extension functions a restored statement may call. */
const UUID_OSSP_FUNCTIONS = new Set([
  'uuid_generate_v1',
  'uuid_generate_v1mc',
  'uuid_generate_v3',
  'uuid_generate_v4',
  'uuid_generate_v5',
  'uuid_nil',
  'uuid_ns_dns',
  'uuid_ns_oid',
  'uuid_ns_url',
  'uuid_ns_x500',
]);

/** The schemas besides `public` each database may hold: the platform ledger's and the engine's. */
const SCHEMAS: Readonly<Record<DumpDatabase, ReadonlySet<string>>> = {
  application: new Set(['drizzle']),
  'workflow-system': new Set(['dbos']),
};

/**
 * Built-in functions no restored statement or function body may call: they run SQL given as text,
 * read or write files or large objects on the server, signal other sessions, change settings or
 * reach other servers.
 */
const DENIED_FUNCTIONS = new Set([
  'query_to_xml',
  'query_to_xmlschema',
  'query_to_xml_and_xmlschema',
  'cursor_to_xml',
  'cursor_to_xmlschema',
  'table_to_xml',
  'table_to_xmlschema',
  'table_to_xml_and_xmlschema',
  'schema_to_xml',
  'schema_to_xmlschema',
  'schema_to_xml_and_xmlschema',
  'database_to_xml',
  'database_to_xmlschema',
  'database_to_xml_and_xmlschema',
  'ts_stat',
  'pg_read_file',
  'pg_read_binary_file',
  'pg_stat_file',
  'pg_ls_dir',
  'pg_ls_logdir',
  'pg_ls_waldir',
  'pg_ls_tmpdir',
  'pg_ls_archive_statusdir',
  'pg_ls_logicalmapdir',
  'pg_ls_logicalsnapdir',
  'pg_ls_replslotdir',
  'pg_file_write',
  'pg_file_rename',
  'pg_file_unlink',
  'lo_import',
  'lo_export',
  'lo_from_bytea',
  'lo_put',
  'lo_create',
  'lo_unlink',
  'set_config',
  'pg_terminate_backend',
  'pg_cancel_backend',
  'pg_reload_conf',
  'pg_rotate_logfile',
  'pg_promote',
  'pg_switch_wal',
  'pg_create_restore_point',
  'pg_logical_emit_message',
  'pg_sleep',
  'pg_sleep_for',
  'pg_sleep_until',
  'pg_advisory_lock',
  'pg_advisory_lock_shared',
  'pg_advisory_xact_lock',
  'pg_advisory_xact_lock_shared',
  'pg_try_advisory_lock',
  'pg_try_advisory_lock_shared',
  'pg_try_advisory_xact_lock',
  'pg_try_advisory_xact_lock_shared',
  'dblink',
  'dblink_exec',
  'dblink_connect',
  'dblink_connect_u',
  'dblink_send_query',
  'pg_import_system_collations',
]);

/** Phrases a function body may not hold, matched on its tokens outside strings. */
const DENIED_BODY_PHRASES: readonly (readonly string[])[] = [
  ['alter', 'system'],
  ['create', 'role'],
  ['create', 'user'],
  ['create', 'group'],
  ['alter', 'role'],
  ['alter', 'user'],
  ['alter', 'group'],
  ['drop', 'role'],
  ['drop', 'user'],
  ['create', 'extension'],
  ['alter', 'extension'],
  ['create', 'event', 'trigger'],
  ['create', 'language'],
  ['create', 'server'],
  ['create', 'foreign'],
  ['create', 'publication'],
  ['create', 'subscription'],
  ['security', 'definer'],
  ['set', 'role'],
  ['set', 'session', 'authorization'],
  ['reset', 'role'],
  ['reset', 'session', 'authorization'],
  ['alter', 'default', 'privileges'],
  ['load'],
  ['copy'],
  ['program'],
  ['grant'],
  ['revoke'],
];

/** The trusted languages a restored function may be written in. */
const TRUSTED_LANGUAGES = new Set(['sql', 'plpgsql']);

/** Index access methods a restored index may use: the built-in ones. */
const INDEX_METHODS = new Set(['btree', 'hash', 'gin', 'gist', 'brin', 'spgist']);

/** The table-of-contents kinds that set up the restore session, with the one form each may take. */
const SESSION_DEFINITIONS: Readonly<Record<string, string>> = {
  ENCODING: "SET client_encoding = 'UTF8';\n",
  STDSTRINGS: "SET standard_conforming_strings = 'on';\n",
  SEARCHPATH: "SELECT pg_catalog.set_config('search_path', '', false);\n",
};

/** Kinds that belong to the database itself; only a restore that creates the database runs them. */
const DATABASE_KINDS = new Set(['DATABASE', 'DATABASE PROPERTIES']);

/** One counted table of `snapshot.json` for this database. */
export interface CountedTable {
  schema: string;
  table: string;
  rows: number;
}

export interface DumpPolicyInput {
  database: DumpDatabase;
  toc: DumpToc;
  /** The tables `snapshot.json` counts for this database. */
  tables: readonly CountedTable[];
  /** Tables (`schema.table`) whose rows the snapshot excludes: they carry no data. */
  rowsExcluded: ReadonlySet<string>;
}

export interface DumpRestorePlan {
  /** The role that owns every object of the dump. */
  owner: string;
  /** The entries to restore, in archive order. */
  restore: DumpTocEntry[];
  /** The `--use-list` file for `pg_restore`: one line per entry to restore. */
  useList: string;
  /** How many foreign keys the restore creates. */
  foreignKeys: number;
  /** The functions the restore creates, `schema.name(arguments)`. */
  functions: string[];
  /** The extensions the restore creates. */
  extensions: string[];
}

export type DumpPolicyResult =
  | { ok: true; value: DumpRestorePlan }
  | { ok: false; errors: BundleError[] };

class PolicyRefusal extends Error {
  constructor(readonly error: BundleError) {
    super(error.message);
  }
}

/** A name from the dump as a message may show it: printable, short. */
function shown(value: string | null): string {
  const printable = (value ?? '').replace(/[^\x20-\x7e]/g, '?');
  return printable.length > 80 ? `${printable.slice(0, 77)}...` : printable;
}

function denied(
  reason: ErrorReason<'RAY_POLICY_DENIED'>,
  database: DumpDatabase,
  entry: DumpTocEntry | null,
  what: string,
): PolicyRefusal {
  const where =
    entry === null ? '' : ` (${shown(entry.desc)} ${shown(entry.namespace)} ${shown(entry.tag)})`;
  return new PolicyRefusal(
    bundleError(
      'RAY_POLICY_DENIED',
      `the ${database === 'application' ? 'application' : 'workflow system'} database dump ${what}` +
        `${where}; nothing was restored`,
      { reason },
    ),
  );
}

function mismatch(database: DumpDatabase, what: string): PolicyRefusal {
  return new PolicyRefusal(
    bundleError(
      'RAY_DIGEST_MISMATCH',
      `the ${database === 'application' ? 'application' : 'workflow system'} database dump ${what}, ` +
        'which is not what snapshot.json states',
      { reason: 'inner-metadata' },
    ),
  );
}

/** The statements of an entry's SQL, or a refusal when the lexer cannot read it. */
function statementsOf(
  input: DumpPolicyInput,
  entry: DumpTocEntry,
  sql: string | null,
): SqlToken[][] {
  try {
    return splitStatements(lexSql(sql ?? ''));
  } catch {
    throw denied('privileged-statement', input.database, entry, 'holds SQL the import cannot read');
  }
}

interface Context {
  input: DumpPolicyInput;
  /** Functions the dump defines, by `schema.name`, with whether each returns `trigger`. */
  functions: Map<string, { trigger: boolean }>;
}

/**
 * Refuse a call, anywhere in `tokens`, of a function that is not a permitted built-in: a denied
 * built-in by any name, or a qualified name outside `pg_catalog` that is not a permitted extension
 * function. `exempt` marks token positions of a qualified name that is not a call (a table being
 * created or referenced, a trigger's function).
 */
function checkCalls(
  ctx: Context,
  entry: DumpTocEntry,
  tokens: readonly SqlToken[],
  exempt: ReadonlySet<number> = new Set(),
): void {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!isName(t)) continue;
    // Only the first part of a qualified name starts it.
    if (i > 0 && tokens[i - 1]!.kind === 'op' && tokens[i - 1]!.value === '.') continue;
    const name = qualifiedName(tokens, i);
    if (name === null) continue;
    const next = tokens[name.next];
    if (next?.kind !== 'op' || next.value !== '(') {
      i = name.next - 1;
      continue;
    }
    const last = name.parts.at(-1)!;
    if (name.parts.length === 1) {
      if (t.kind === 'word' && last === 'operator') {
        // OPERATOR(schema.op): only pg_catalog's operators.
        const inner = tokens[name.next + 1];
        if (isName(inner) && inner!.value !== 'pg_catalog') {
          throw denied(
            'privileged-statement',
            ctx.input.database,
            entry,
            'uses an operator it defines',
          );
        }
      }
      if (DENIED_FUNCTIONS.has(last)) {
        throw denied('privileged-statement', ctx.input.database, entry, 'calls a server function');
      }
      i = name.next - 1;
      continue;
    }
    if (exempt.has(i)) {
      i = name.next - 1;
      continue;
    }
    const schema = name.parts[0]!;
    if (name.parts.length === 2 && schema === 'pg_catalog') {
      if (DENIED_FUNCTIONS.has(last)) {
        throw denied('privileged-statement', ctx.input.database, entry, 'calls a server function');
      }
    } else if (
      !(
        ctx.input.database === 'workflow-system' &&
        name.parts.length === 2 &&
        schema === 'public' &&
        UUID_OSSP_FUNCTIONS.has(last)
      )
    ) {
      throw denied(
        'privileged-statement',
        ctx.input.database,
        entry,
        'calls a function outside pg_catalog where the restore or every insert evaluates it',
      );
    }
    i = name.next - 1;
  }
}

/** The position of the qualified name `ALTER TABLE [ONLY] <name>` names, or null. */
function alterTableTarget(tokens: readonly SqlToken[]): { parts: string[]; next: number } | null {
  if (!keywords(tokens, 0, 'alter', 'table')) return null;
  const at = keywords(tokens, 2, 'only') ? 3 : 2;
  return qualifiedName(tokens, at);
}

function sameName(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return a !== undefined && a.length === b.length && a.every((p, i) => p === b[i]);
}

function tableOf(entry: DumpTocEntry): string[] {
  return [entry.namespace ?? '', entry.tag];
}

/** The statements one kind of entry may consist of; throws a refusal for anything else. */
function checkEntry(ctx: Context, entry: DumpTocEntry): void {
  const { input } = ctx;
  const refuse = (what: string) => denied('privileged-statement', input.database, entry, what);
  const statements = statementsOf(input, entry, entry.defn);
  const only = (): SqlToken[] => {
    if (statements.length !== 1) throw refuse('holds more than the one statement of its kind');
    return statements[0]!;
  };
  if (entry.tablespace !== null && entry.tablespace !== '') throw refuse('names a tablespace');
  if (entry.tableam !== null && entry.tableam !== '' && entry.tableam !== 'heap') {
    throw refuse('names a table access method other than heap');
  }
  if (entry.desc !== 'TABLE DATA' && entry.copyStmt !== null && entry.copyStmt !== '') {
    throw refuse('carries a COPY statement outside table data');
  }

  switch (entry.desc) {
    case 'SCHEMA': {
      const s = only();
      if (!keywords(s, 0, 'create', 'schema') || s.length !== 3 || !isName(s[2])) {
        throw refuse('is not one CREATE SCHEMA');
      }
      if (!SCHEMAS[input.database].has(s[2]!.value) || s[2]!.value !== entry.tag) {
        throw refuse('creates a schema the platform does not use');
      }
      return;
    }
    case 'TABLE': {
      const [create, ...rest] = statements;
      const at = keywords(create ?? [], 1, 'unlogged') ? 3 : 2;
      if (
        create === undefined ||
        !keywords(create, 0, 'create') ||
        !keywords(create, at - 1, 'table')
      ) {
        throw refuse('is not a CREATE TABLE');
      }
      const name = qualifiedName(create, at);
      if (name === null || !sameName(name.parts, tableOf(entry))) {
        throw refuse('creates a table other than the one it names');
      }
      for (const t of create) {
        if (
          t.kind === 'word' &&
          ['tablespace', 'inherits', 'partition', 'using'].includes(t.value)
        ) {
          throw refuse(`creates a table with ${t.value.toUpperCase()}`);
        }
      }
      checkCalls(ctx, entry, create, new Set([at]));
      for (const s of rest) {
        const target = alterTableTarget(s);
        if (target === null || !sameName(target.parts, tableOf(entry))) {
          throw refuse('alters another table than the one it creates');
        }
        const i = target.next;
        const allowed =
          keywords(s, i, 'force', 'row', 'level', 'security') ||
          keywords(s, i, 'replica', 'identity') ||
          (keywords(s, i, 'alter', 'column') &&
            isName(s[i + 2]) &&
            (keywords(s, i + 3, 'set', 'statistics') ||
              keywords(s, i + 3, 'set', 'storage') ||
              keywords(s, i + 3, 'add', 'generated')));
        if (!allowed) throw refuse('alters its table in a way a dump of the platform does not');
        checkCalls(ctx, entry, s);
      }
      return;
    }
    case 'SEQUENCE': {
      const s = only();
      if (keywords(s, 0, 'create', 'sequence')) {
        const name = qualifiedName(s, 2);
        if (name === null || !sameName(name.parts, tableOf(entry))) {
          throw refuse('creates another sequence than the one it names');
        }
      } else {
        const target = alterTableTarget(s);
        if (
          target === null ||
          !keywords(s, target.next, 'alter', 'column') ||
          !keywords(s, target.next + 3, 'add', 'generated')
        ) {
          throw refuse('is neither a CREATE SEQUENCE nor an identity column');
        }
      }
      checkCalls(ctx, entry, s);
      return;
    }
    case 'SEQUENCE OWNED BY': {
      const s = only();
      const name = qualifiedName(s, 2);
      if (
        !keywords(s, 0, 'alter', 'sequence') ||
        name === null ||
        !sameName(name.parts, tableOf(entry)) ||
        !keywords(s, name.next, 'owned', 'by') ||
        qualifiedName(s, name.next + 2)?.next !== s.length
      ) {
        throw refuse('is not one ALTER SEQUENCE … OWNED BY');
      }
      return;
    }
    case 'DEFAULT': {
      const s = only();
      const target = alterTableTarget(s);
      if (
        target === null ||
        target.parts[0] !== entry.namespace ||
        !keywords(s, target.next, 'alter', 'column') ||
        !keywords(s, target.next + 3, 'set', 'default')
      ) {
        throw refuse('is not one ALTER TABLE … SET DEFAULT');
      }
      checkCalls(ctx, entry, s);
      return;
    }
    case 'CONSTRAINT':
    case 'FK CONSTRAINT': {
      const s = only();
      const target = alterTableTarget(s);
      if (target === null || target.parts[0] !== entry.namespace) {
        throw refuse('is not an ALTER TABLE of its schema');
      }
      const i = target.next;
      if (!keywords(s, i, 'add', 'constraint') || !isName(s[i + 2])) {
        throw refuse('is not one ALTER TABLE … ADD CONSTRAINT');
      }
      const kind = s[i + 3];
      const fk = keywords(s, i + 3, 'foreign', 'key');
      if (entry.desc === 'FK CONSTRAINT') {
        if (!fk) throw refuse('is not a foreign key');
        const references = s.findIndex((_t, at) => at > i + 3 && keywords(s, at, 'references'));
        if (references === -1) throw refuse('is a foreign key that references nothing');
        checkCalls(ctx, entry, s, new Set([references + 1]));
        return;
      }
      if (
        fk ||
        !(
          keywords(s, i + 3, 'primary', 'key') ||
          (kind?.kind === 'word' && ['unique', 'check', 'exclude'].includes(kind.value))
        )
      ) {
        throw refuse('is not a primary key, unique, check or exclusion constraint');
      }
      checkCalls(ctx, entry, s);
      return;
    }
    case 'INDEX': {
      const s = only();
      const at = keywords(s, 1, 'unique') ? 2 : 1;
      if (!keywords(s, 0, 'create') || !keywords(s, at, 'index') || !isName(s[at + 1])) {
        throw refuse('is not one CREATE INDEX');
      }
      const on = keywords(s, at + 2, 'on') ? at + 2 : -1;
      if (on === -1) throw refuse('is not one CREATE INDEX … ON');
      const table = qualifiedName(s, keywords(s, on + 1, 'only') ? on + 2 : on + 1);
      if (table === null || table.parts[0] !== entry.namespace) {
        throw refuse('indexes a table of another schema');
      }
      if (!keywords(s, table.next, 'using') || !INDEX_METHODS.has(s[table.next + 1]?.value ?? '')) {
        throw refuse('uses an index access method other than the built-in ones');
      }
      for (const t of s) {
        if (t.kind === 'word' && t.value === 'tablespace') throw refuse('names a tablespace');
      }
      checkCalls(ctx, entry, s);
      return;
    }
    case 'TRIGGER': {
      const s = only();
      const at = keywords(s, 1, 'constraint') ? 2 : 1;
      if (!keywords(s, 0, 'create') || !keywords(s, at, 'trigger')) {
        throw refuse('is not one CREATE TRIGGER');
      }
      const execute = s.findIndex(
        (_t, i) => keywords(s, i, 'execute', 'function') || keywords(s, i, 'execute', 'procedure'),
      );
      const fn = execute === -1 ? null : qualifiedName(s, execute + 2);
      if (fn === null || fn.parts.length !== 2) {
        throw refuse('is a trigger without a qualified trigger function');
      }
      const defined = ctx.functions.get(fn.parts.join('.'));
      if (defined === undefined || !defined.trigger) {
        throw refuse('calls a function the dump does not define as a trigger function');
      }
      checkCalls(ctx, entry, s, new Set([execute + 2]));
      return;
    }
    case 'POLICY': {
      const s = only();
      const target =
        keywords(s, 0, 'create', 'policy') && isName(s[2]) && keywords(s, 3, 'on')
          ? qualifiedName(s, 4)
          : null;
      if (target === null || target.parts[0] !== entry.namespace) {
        throw refuse('is not one CREATE POLICY on a table of its schema');
      }
      checkCalls(ctx, entry, s);
      return;
    }
    case 'ROW SECURITY': {
      const s = only();
      const target = alterTableTarget(s);
      if (
        target === null ||
        !sameName(target.parts, tableOf(entry)) ||
        !keywords(s, target.next, 'enable', 'row', 'level', 'security') ||
        target.next + 4 !== s.length
      ) {
        throw refuse('is not one ALTER TABLE … ENABLE ROW LEVEL SECURITY');
      }
      return;
    }
    case 'FUNCTION':
      checkFunction(ctx, entry, only());
      return;
    case 'EXTENSION': {
      if (
        input.database !== 'workflow-system' ||
        entry.tag !== WORKFLOW_SYSTEM_EXTENSION ||
        (entry.defn ?? '').trim() !== WORKFLOW_SYSTEM_EXTENSION_SQL
      ) {
        throw denied(
          'unsupported-extension',
          input.database,
          entry,
          'creates an extension outside the allowlist (none in the application database, ' +
            'uuid-ossp alone in the workflow system database)',
        );
      }
      return;
    }
    case 'TABLE DATA': {
      if (statements.length > 0) throw refuse('carries SQL beside its data');
      if (!isCopyFromStdin(entry)) {
        throw refuse('loads its data with something other than COPY … FROM stdin into its table');
      }
      return;
    }
    case 'SEQUENCE SET': {
      const set =
        /^SELECT pg_catalog\.setval\('([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)', -?[0-9]{1,19}, (true|false)\);\n$/.exec(
          entry.defn ?? '',
        );
      if (set === null || set[1] !== entry.namespace || set[2] !== entry.tag) {
        throw refuse('sets a sequence with something other than pg_catalog.setval');
      }
      return;
    }
    default:
      throw refuse('is a kind of object an import does not restore');
  }
}

/**
 * Whether a table's data is loaded by exactly `COPY <its table> (<column>, …) FROM stdin;`: no
 * other source, no option, nothing after it.
 */
function isCopyFromStdin(entry: DumpTocEntry): boolean {
  let tokens: SqlToken[];
  try {
    tokens = lexSql(entry.copyStmt ?? '');
  } catch {
    return false;
  }
  if (!(entry.copyStmt ?? '').endsWith(';\n') || !keywords(tokens, 0, 'copy')) return false;
  const table = qualifiedName(tokens, 1);
  if (table === null || !sameName(table.parts, tableOf(entry))) return false;
  let i = table.next;
  if (tokens[i]?.value !== '(') return false;
  for (i++; ; i += 2) {
    if (!isName(tokens[i])) return false;
    const after = tokens[i + 1];
    if (after?.kind !== 'op') return false;
    if (after.value === ')') break;
    if (after.value !== ',') return false;
  }
  return (
    keywords(tokens, i + 2, 'from', 'stdin') &&
    tokens[i + 4]?.kind === 'semi' &&
    tokens.length === i + 5
  );
}

/**
 * A function entry: `CREATE FUNCTION <schema>.<name>(…) RETURNS … <attributes> AS <body>`, in a
 * trusted language, with only the attributes a dump of the platform or the workflow engine carries.
 */
function checkFunction(ctx: Context, entry: DumpTocEntry, s: readonly SqlToken[]): void {
  const { input } = ctx;
  const refuse = (what: string) => denied('privileged-statement', input.database, entry, what);
  if (!keywords(s, 0, 'create', 'function')) throw refuse('is not a CREATE FUNCTION');
  const name = qualifiedName(s, 2);
  if (name === null || name.parts.length !== 2 || name.parts[0] !== entry.namespace) {
    throw refuse('creates a function outside its schema');
  }
  // The argument list, to its matching parenthesis; argument defaults are evaluated by a caller only.
  let depth = 0;
  let i = name.next;
  if (s[i]?.value !== '(') throw refuse('is a function without arguments');
  const argsStart = i;
  for (; i < s.length; i++) {
    if (s[i]!.kind === 'op' && s[i]!.value === '(') depth++;
    if (s[i]!.kind === 'op' && s[i]!.value === ')') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw refuse('is a function with unbalanced arguments');
  const argsEnd = i;
  if (!keywords(s, i + 1, 'returns')) throw refuse('is a function without RETURNS');
  const asAt = s.findIndex((_t, at) => at > argsEnd && keywords(s, at, 'as'));
  if (asAt === -1) throw refuse('is a function without a body');
  const body = s.slice(asAt + 1);
  if (body.length !== 1 || (body[0]!.kind !== 'dollar' && body[0]!.kind !== 'string')) {
    throw refuse('is a function whose body is not one quoted text');
  }
  const header = s.slice(argsEnd + 2, asAt);
  const returnsTrigger = header[0]?.kind === 'word' && header[0].value === 'trigger';

  let language: string | null = null;
  let definer = false;
  const settings: string[] = [];
  for (let at = 0; at < header.length; at++) {
    const t = header[at]!;
    if (t.kind !== 'word') continue;
    if (t.value === 'language') {
      language = header[at + 1]?.value ?? null;
      at++;
    } else if (t.value === 'security') {
      const mode = header[at + 1]?.value;
      if (mode === 'definer') definer = true;
      else if (mode !== 'invoker') throw refuse('is a function with an unknown security mode');
      at++;
    } else if (t.value === 'set') {
      settings.push(header[at + 1]?.value ?? '');
      // `SET <name> TO <values>` or `FROM CURRENT`: the values run to the next attribute.
      at++;
    } else if (['leakproof', 'support', 'window', 'external'].includes(t.value)) {
      throw refuse(`is a function marked ${t.value.toUpperCase()}, which needs a superuser`);
    }
  }
  if (language === null || !TRUSTED_LANGUAGES.has(language)) {
    throw refuse('is a function in a language other than sql or plpgsql');
  }
  if (settings.some((setting) => setting !== 'search_path')) {
    throw refuse('is a function that changes a setting other than the search path');
  }

  const args = s.slice(argsStart, argsEnd + 1);
  checkCalls(ctx, entry, args.slice(1, -1));
  if (definer) {
    const signature = name.parts[1]!;
    const argText = rendered(args.slice(1, -1));
    const expected = ISOLATION_DEFINER_FUNCTIONS.find(
      (d) => d.name === signature && d.arguments === argText,
    );
    const searchPath = settingValues(header);
    if (
      input.database !== 'application' ||
      name.parts[0] !== 'public' ||
      expected === undefined ||
      searchPath !== "'pg_catalog', 'pg_temp'" ||
      normalizeFunctionBody(body[0]!.value) !== normalizeFunctionBody(expected.body)
    ) {
      throw refuse(
        'creates a SECURITY DEFINER function that is not one of the platform chain’s two lookups',
      );
    }
  }
  // The body runs only when called, never at restore; it still may not name what only a superuser
  // or another server could do.
  let bodyTokens: SqlToken[];
  try {
    bodyTokens = lexSql(body[0]!.value);
  } catch {
    throw refuse('is a function whose body the import cannot read');
  }
  for (let at = 0; at < bodyTokens.length; at++) {
    for (const phrase of DENIED_BODY_PHRASES) {
      if (keywords(bodyTokens, at, ...phrase)) {
        throw refuse(`is a function whose body uses ${phrase.join(' ').toUpperCase()}`);
      }
    }
    const t = bodyTokens[at]!;
    if (
      (t.kind === 'word' || t.kind === 'quoted') &&
      DENIED_FUNCTIONS.has(t.value) &&
      bodyTokens[at + 1]?.value === '('
    ) {
      throw refuse('is a function whose body calls a server function');
    }
  }
  ctx.functions.set(name.parts.join('.'), { trigger: returnsTrigger });
}

/** Tokens rendered back as `pg_dump` prints an argument list: words joined by single spaces. */
function rendered(tokens: readonly SqlToken[]): string {
  let out = '';
  for (const t of tokens) {
    const text = t.kind === 'word' ? t.value : t.text;
    if (t.value === ',' || t.value === ')' || out === '' || out.endsWith('(')) out += text;
    else out += ` ${text}`;
  }
  return out;
}

/** The values of a function's `SET search_path TO …`, as written. */
function settingValues(header: readonly SqlToken[]): string | null {
  const at = header.findIndex((_t, i) => keywords(header, i, 'set', 'search_path'));
  if (at === -1 || !keywords(header, at + 2, 'to')) return null;
  const values: string[] = [];
  for (let i = at + 3; i < header.length; i++) {
    const t = header[i]!;
    if (t.kind === 'string') values.push(`'${t.value}'`);
    else if (t.kind === 'op' && t.value === ',') continue;
    else break;
  }
  return values.join(', ');
}

// ─── privileges ────────────────────────────────────────────────────────────────────────────────

/** The roles a privilege statement names after TO or FROM (`PUBLIC` included). */
function grantees(statement: readonly SqlToken[]): string[] | null {
  const at = statement.findIndex(
    (t) => t.kind === 'word' && (t.value === 'to' || t.value === 'from'),
  );
  if (at === -1) return null;
  const roles: string[] = [];
  for (let i = at + 1; i < statement.length; i++) {
    const t = statement[i]!;
    if (t.kind === 'op' && t.value === ',') continue;
    if (keywords(statement, i, 'with', 'grant', 'option')) break;
    if (keywords(statement, i, 'granted', 'by')) break;
    if (keywords(statement, i, 'cascade') || keywords(statement, i, 'restrict')) break;
    if (t.kind === 'word' && t.value === 'group') continue;
    if (!isName(t)) return null;
    roles.push(t.kind === 'word' && t.value === 'public' ? 'PUBLIC' : t.value);
  }
  return roles;
}

/** The statements of a privilege entry: GRANT or REVOKE ON an object, or default privileges. */
function privilegeStatements(
  ctx: Context,
  entry: DumpTocEntry,
): { forRole: string | null; roles: string[] }[] {
  const out: { forRole: string | null; roles: string[] }[] = [];
  for (const s of statementsOf(ctx.input, entry, entry.defn)) {
    let forRole: string | null = null;
    let body = s;
    if (keywords(s, 0, 'alter', 'default', 'privileges')) {
      if (!keywords(s, 3, 'for', 'role') || !isName(s[5])) {
        throw denied(
          'unmapped-owner',
          ctx.input.database,
          entry,
          'sets default privileges without naming the role they belong to',
        );
      }
      forRole = s[5]!.value;
      let i = 6;
      if (keywords(s, i, 'in', 'schema')) i += 3;
      body = s.slice(i);
    }
    const grant = keywords(body, 0, 'grant') || keywords(body, 0, 'revoke');
    const on = body.findIndex((t) => t.kind === 'word' && t.value === 'on');
    if (!grant || on === -1) {
      throw denied(
        'privileged-statement',
        ctx.input.database,
        entry,
        'holds a privilege statement that is not a GRANT or REVOKE on an object (a role membership)',
      );
    }
    const roles = grantees(body);
    if (roles === null) {
      throw denied('privileged-statement', ctx.input.database, entry, 'holds an unreadable grant');
    }
    out.push({ forRole, roles });
  }
  return out;
}

// ─── the plan ──────────────────────────────────────────────────────────────────────────────────

/** Kinds restored when they pass their checks. */
const RESTORED_KINDS = new Set([
  'SCHEMA',
  'TABLE',
  'SEQUENCE',
  'SEQUENCE OWNED BY',
  'DEFAULT',
  'CONSTRAINT',
  'FK CONSTRAINT',
  'INDEX',
  'TRIGGER',
  'POLICY',
  'ROW SECURITY',
  'FUNCTION',
  'EXTENSION',
  'TABLE DATA',
  'SEQUENCE SET',
]);

/**
 * Decide what of one dump an import restores. Returns the plan, or the first refusal: an entry the
 * allowlist refuses (`RAY_POLICY_DENIED` with `privileged-statement`, `unsupported-extension` or
 * `unmapped-owner`) or a dump that disagrees with `snapshot.json` (`RAY_DIGEST_MISMATCH`
 * `inner-metadata`).
 */
export function planDumpRestore(input: DumpPolicyInput): DumpPolicyResult {
  try {
    return { ok: true, value: plan(input) };
  } catch (err) {
    if (err instanceof PolicyRefusal) return { ok: false, errors: [err.error] };
    throw err;
  }
}

function plan(input: DumpPolicyInput): DumpRestorePlan {
  const ctx: Context = { input, functions: new Map() };
  const { entries } = input.toc;

  // The session the restore runs in.
  for (const [desc, defn] of Object.entries(SESSION_DEFINITIONS)) {
    const found = entries.filter((e) => e.desc === desc);
    if (found.length !== 1 || found[0]!.defn !== defn) {
      throw denied(
        'privileged-statement',
        input.database,
        found[0] ?? null,
        `sets up its session other than with ${defn.trim()}`,
      );
    }
  }

  // The owner: every schema object belongs to one role.
  const owned = entries.filter(
    (e) => RESTORED_KINDS.has(e.desc) && e.desc !== 'EXTENSION' && e.desc !== 'TABLE DATA',
  );
  const owner = owned[0]?.owner ?? '';
  if (owner === '') {
    throw denied(
      'unmapped-owner',
      input.database,
      owned[0] ?? null,
      'names no owner for its objects',
    );
  }

  // Functions first: a trigger may name only a function the dump defines.
  for (const e of entries) if (e.desc === 'FUNCTION') checkEntry(ctx, e);

  const restore: DumpTocEntry[] = [];
  const knownRoles = new Set([owner, 'PUBLIC', 'pg_database_owner']);
  const acl: DumpTocEntry[] = [];
  for (const e of entries) {
    if (e.desc in SESSION_DEFINITIONS) continue;
    if (DATABASE_KINDS.has(e.desc)) continue;
    // Privileges and comments of the database itself go with it: a restore never creates it.
    if (
      (e.desc === 'ACL' || e.desc === 'COMMENT' || e.desc === 'SECURITY LABEL') &&
      e.namespace === null &&
      e.tag.startsWith('DATABASE ')
    ) {
      continue;
    }
    if (e.desc === 'ACL' || e.desc === 'DEFAULT ACL' || e.desc === 'COMMENT') {
      if (e.desc === 'COMMENT') {
        const s = statementsOf(input, e, e.defn);
        if (s.length !== 1 || !keywords(s[0]!, 0, 'comment', 'on')) {
          throw denied(
            'privileged-statement',
            input.database,
            e,
            'holds a comment entry that is not one COMMENT ON',
          );
        }
      } else acl.push(e);
      continue;
    }
    if (!RESTORED_KINDS.has(e.desc)) {
      throw denied(
        'privileged-statement',
        input.database,
        e,
        'holds a kind of object an import does not restore',
      );
    }
    if (e.desc === 'EXTENSION') {
      if (e.owner !== null && e.owner !== '' && e.owner !== owner) {
        throw denied('unmapped-owner', input.database, e, 'has an object of another owner');
      }
    } else if (e.owner !== owner) {
      throw denied('unmapped-owner', input.database, e, 'has an object of another owner');
    }
    if (e.desc !== 'FUNCTION') checkEntry(ctx, e);
    restore.push(e);
  }

  // Privileges: default privileges of the owner name the roles the dump knows; a grant to anyone
  // else maps to no role of the target.
  const statements = acl.map((e) => ({ entry: e, statements: privilegeStatements(ctx, e) }));
  for (const { entry, statements: list } of statements) {
    if (entry.desc !== 'DEFAULT ACL') continue;
    for (const s of list) {
      if (s.forRole !== owner) {
        throw denied(
          'unmapped-owner',
          input.database,
          entry,
          'sets default privileges of another role',
        );
      }
      for (const role of s.roles) knownRoles.add(role);
    }
  }
  for (const { entry, statements: list } of statements) {
    if (entry.desc === 'ACL' && entry.owner !== owner && entry.owner !== 'pg_database_owner') {
      throw denied('unmapped-owner', input.database, entry, 'has privileges of another owner');
    }
    for (const s of list) {
      if (entry.desc === 'ACL' && s.forRole !== null) {
        throw denied(
          'privileged-statement',
          input.database,
          entry,
          'holds default privileges in a grant',
        );
      }
      for (const role of s.roles) {
        if (!knownRoles.has(role)) {
          throw denied(
            'unmapped-owner',
            input.database,
            entry,
            'grants a privilege to a role the dump does not account for',
          );
        }
      }
    }
  }

  // Names: the tables are exactly the counted ones, and their data agrees with the counts.
  const key = (schema: string | null, table: string) => `${schema ?? ''}.${table}`;
  const counted = new Map(input.tables.map((t) => [key(t.schema, t.table), t.rows]));
  const created = new Set(
    restore.filter((e) => e.desc === 'TABLE').map((e) => key(e.namespace, e.tag)),
  );
  const withData = new Set(
    restore.filter((e) => e.desc === 'TABLE DATA').map((e) => key(e.namespace, e.tag)),
  );
  if (created.size !== counted.size || [...created].some((t) => !counted.has(t))) {
    throw mismatch(input.database, 'creates other tables than the ones snapshot.json counts');
  }
  for (const t of withData) {
    if (!created.has(t)) throw mismatch(input.database, 'holds data of a table it does not create');
    if (input.rowsExcluded.has(t)) {
      throw mismatch(input.database, 'holds rows of a table whose data category is excluded');
    }
  }
  for (const [t, rows] of counted) {
    if (rows > 0 && !withData.has(t))
      throw mismatch(input.database, 'holds no data for a counted table with rows');
  }

  const functions = restore
    .filter((e) => e.desc === 'FUNCTION')
    .map((e) => `${e.namespace}.${e.tag}`);
  return {
    owner,
    restore,
    useList: restore.map((e) => `${e.dumpId}; ${e.tableoid} ${e.oid} ${e.desc}\n`).join(''),
    foreignKeys: restore.filter((e) => e.desc === 'FK CONSTRAINT').length,
    functions,
    extensions: restore.filter((e) => e.desc === 'EXTENSION').map((e) => e.tag),
  };
}
