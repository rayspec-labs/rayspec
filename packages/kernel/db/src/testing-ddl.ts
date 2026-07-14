/**
 * Test-support SQL emitter for the INJECTED tenancy/GDPR columns.
 *
 * DB-backed tests build product tables in isolated schemas with hand-written CREATE TABLE DDL. They
 * cannot reuse the full `generateProductSql` (it hardcodes `REFERENCES "public"."orgs"` and emits its
 * own unique constraints, whereas the tests create `orgs` in the isolated schema — reached via an
 * unqualified, search_path-resolved `REFERENCES orgs(id)` — and add bespoke attack-surface
 * constraints). To keep those hand-written blocks from silently drifting when an injected column is
 * added or changed, they interpolate these DERIVED column lines around their still-explicit business
 * columns and test-specific constraints. The lines come from the SAME canonical `INJECTED_COLUMNS`
 * `.sqlDef` the generator uses, so the created schema stays byte-equivalent.
 *
 * Test-support only — exported via `@rayspec/db/testing`, never the main `@rayspec/db` barrel.
 */
import { INJECTED_AFTER, INJECTED_BEFORE } from './generated/injected-columns.js';

/** Options for {@link injectedColumnLinesSql}. */
export interface InjectedColumnLinesOptions {
  /**
   * The FK clause appended to the injected `tenant_id` column line. Tests create `orgs` in an
   * ISOLATED (non-public) schema and rely on an UNQUALIFIED `REFERENCES orgs(id)` resolved via
   * search_path (or a schema-qualified `REFERENCES <schema>.orgs(id)`), so a caller passes e.g.
   * `'REFERENCES orgs(id) ON DELETE CASCADE'`. The canonical descriptor's `tenant_id` sqlDef is the
   * bare column (the generator adds its own `public.orgs` FK as a separate ALTER), so WITHOUT this
   * option the emitted `tenant_id` line carries no FK.
   */
  tenantFkRef?: string;
}

/** The injected column lines split around the author business columns (see {@link injectedColumnLinesSql}). */
export interface InjectedColumnLines {
  /** Lines emitted BEFORE the business columns (`id`, `tenant_id`) — comma-joined, no trailing comma. */
  before: string;
  /** Lines emitted AFTER the business columns (`created_at` … `idempotency_key`) — comma-joined, no trailing comma. */
  after: string;
}

/**
 * Emit the INJECTED tenancy/GDPR column-definition lines as two joinable SQL snippets (the columns
 * BEFORE and AFTER the author business columns), derived from the canonical `INJECTED_COLUMNS`
 * descriptor. A test interpolates `before` before its business columns and `after` after them (then
 * any test-specific constraints), producing a table byte-equivalent to the generator's output.
 */
export function injectedColumnLinesSql(
  options: InjectedColumnLinesOptions = {},
): InjectedColumnLines {
  const before = INJECTED_BEFORE.map((c) =>
    c.isTenantFk && options.tenantFkRef ? `${c.sqlDef} ${options.tenantFkRef}` : c.sqlDef,
  ).join(', ');
  const after = INJECTED_AFTER.map((c) => c.sqlDef).join(', ');
  return { before, after };
}

const CONSTRAINT_RE = /^(CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK)\b/i;

/**
 * Parse the column NAMES declared in a `CREATE TABLE <name> (...)` statement out of a DDL string — a
 * test-support helper for the injected-column drift guards. Paren-depth-aware (so a `UNIQUE (a, b)`
 * constraint is ONE item, not two) and skips table-level constraint clauses (`CONSTRAINT` /
 * `PRIMARY KEY` / `FOREIGN KEY` / `UNIQUE` / `CHECK`). Accepts an optional schema qualifier and
 * `IF NOT EXISTS`. THROWS if the named table is not found (a guard that silently found nothing would
 * be a false green).
 */
export function parseCreateTableColumnNames(sql: string, table: string): string[] {
  // Strip SQL line comments first — a `-- …` comment inside the column region may carry commas and
  // would otherwise be mis-split into phantom column defs (these fixtures embed explanatory comments).
  sql = sql.replace(/--[^\n]*/g, '');
  const head = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:[\\w"]+\\.)?"?${table}"?\\s*\\(`,
    'i',
  );
  const m = head.exec(sql);
  if (!m) throw new Error(`parseCreateTableColumnNames: table '${table}' not found in DDL`);

  // Walk from the opening paren of the match to its balanced close.
  let depth = 0;
  let start = -1;
  let end = -1;
  for (let i = m.index + m[0].length - 1; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '(') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`parseCreateTableColumnNames: unbalanced parens for '${table}'`);

  // Split the column region on TOP-LEVEL commas (depth 0), so a composite `UNIQUE (a, b)` stays whole.
  const items: string[] = [];
  let d = 0;
  let cur = '';
  for (const ch of sql.slice(start, end)) {
    if (ch === '(') d++;
    else if (ch === ')') d--;
    if (ch === ',' && d === 0) {
      items.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) items.push(cur);

  const names: string[] = [];
  for (const item of items) {
    const t = item.trim();
    if (!t || CONSTRAINT_RE.test(t)) continue;
    const name = /^"?([A-Za-z_]\w*)"?/.exec(t)?.[1];
    if (name) names.push(name);
  }
  return names;
}
