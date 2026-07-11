/**
 * `rayspec dev db` — create the local DEV database if it is absent (idempotent; NEVER destructive).
 *
 * LOCAL-DEV ONLY · MUTATING: connects to the maintenance (`postgres`) database on the SAME host as a
 * base `DATABASE_URL`, and `CREATE DATABASE`s the target if it does not already exist. It NEVER drops
 * or alters an existing database — a second run is a pure no-op. (The migration chain + pack-store
 * materialization happen at server boot, NOT here — this only ensures the database exists.)
 *
 * The base URL comes from `--database-url` or `process.env.DATABASE_URL` (the repo `.env` is auto-loaded
 * by `index.ts` before dispatch). The target database NAME is `--name` or, if omitted, the database
 * named in the base URL itself (so `rayspec dev db` with a `DATABASE_URL=postgres://…/acme_notes`
 * creates `acme_notes`). Uses the `postgres` lib ALREADY in cli deps — no new dependency.
 *
 * `CREATE DATABASE` cannot be parameterized, so the name is validated against a strict identifier
 * pattern before it is interpolated (defence against injection via a crafted name).
 *
 * Output is a value-free summary `{ db, created }` — the URL/password are NEVER echoed (any stray
 * connection-string in an error message is redacted).
 */

import { parseArgs } from 'node:util';
import postgres from 'postgres';
import { DevCliError } from './errors.js';

/** A safe Postgres database identifier (letters/underscore start; letters/digits/underscore body). */
const DB_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface DevDbResult {
  readonly ok: boolean;
  readonly command: 'dev db';
  /** The target database name (NOT a secret). */
  readonly db?: string;
  /** `true` = freshly created; `false` = already existed (the idempotent no-op path). */
  readonly created?: boolean;
  readonly errors: { readonly code: string; readonly message: string }[];
}

/** Strip any `postgres://…`/`postgresql://…` connection string from a message (never leak creds). */
function redact(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, '<redacted-database-url>');
}

/**
 * `rayspec dev db [--database-url <url>] [--name <db>]` — create-if-absent. Returns a value-free
 * summary; the caller emits it as JSON. Throws `DevCliError` on a usage problem (→ exit 2); an
 * operational failure (bad/unreachable DB) is returned as `ok:false` (→ exit 1) with a redacted message.
 */
export async function runDevDb(args: readonly string[]): Promise<DevDbResult> {
  let databaseUrlFlag: string | undefined;
  let nameFlag: string | undefined;
  try {
    const { values } = parseArgs({
      args: [...args],
      allowPositionals: false,
      strict: true,
      options: {
        'database-url': { type: 'string' },
        name: { type: 'string' },
      },
    });
    databaseUrlFlag = values['database-url'];
    nameFlag = values.name;
  } catch (e) {
    throw new DevCliError(`invalid arguments: ${e instanceof Error ? e.message : String(e)}`);
  }

  const baseUrl = databaseUrlFlag ?? process.env.DATABASE_URL;
  if (!baseUrl || baseUrl.trim().length === 0) {
    throw new DevCliError(
      'no base database URL — pass --database-url <url> or set DATABASE_URL (the dev DB is created on the SAME host).',
    );
  }

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new DevCliError('the base database URL is not a valid URL.');
  }

  // Target name: --name, else the database in the base URL's path.
  const name = nameFlag ?? decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!name) {
    throw new DevCliError(
      'no target database name — pass --name <db> or include it in the base URL.',
    );
  }
  if (!DB_NAME_RE.test(name)) {
    throw new DevCliError(
      `refusing to create database ${JSON.stringify(name)}: name must match ${DB_NAME_RE} (CREATE DATABASE cannot be parameterized).`,
    );
  }

  // Connect to the maintenance database on the same host (CREATE DATABASE runs outside a transaction).
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';

  const sql = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    const exists = await sql`select 1 from pg_database where datname = ${name}`;
    if (exists.length > 0) {
      return { ok: true, command: 'dev db', db: name, created: false, errors: [] };
    }
    // Name is validated against DB_NAME_RE above; the double-quote keeps it a single identifier.
    await sql.unsafe(`CREATE DATABASE "${name}"`);
    return { ok: true, command: 'dev db', db: name, created: true, errors: [] };
  } catch (e) {
    return {
      ok: false,
      command: 'dev db',
      errors: [{ code: 'DB_ERROR', message: redact(e instanceof Error ? e.message : String(e)) }],
    };
  } finally {
    await sql.end();
  }
}
