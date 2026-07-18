/**
 * A deterministic in-memory `HandlerDb` fake for the capability unit tests. THE FAKE ENFORCES THE
 * REAL CONSTRAINTS (the fail-the-fix discipline — a fake that is a plain array proves nothing):
 *
 *  - ONE SHARED underlying table across tenant-bound instances, with a GLOBAL (cross-tenant)
 *    unique index on `file_ref` — exactly what the platform's generated single-column unique is.
 *    A test composing two tenant-bound fakes over one `SharedFileTable` therefore proves the
 *    tenant-prefixed ref ISOLATES tenants (and would catch a regression that dropped the prefix).
 *  - the facade's upsert semantics: DO-UPDATE is TENANT-SCOPED (a conflict on a foreign tenant's
 *    row writes nothing and returns `undefined`); the `updateWhere` CONDITIONAL-UPDATE guard (a
 *    conflict row that does not match writes nothing and returns `undefined` — the state-guarded
 *    first-upload close); tenant_id is auto-stamped on insert.
 *  - select/update/delete are tenant-scoped structurally (every op filters by the bound tenant).
 */
import type { HandlerDb, StoreRow } from '@rayspec/handler-sdk';
import { FILE_UPLOADS_STORE } from '../stores.js';

interface FakeRow extends Record<string, unknown> {
  tenant_id: string;
}

/** The shared underlying table (one per test) — the global-unique authority. */
export class SharedFileTable {
  readonly rows: FakeRow[] = [];

  findByRef(ref: unknown): FakeRow | undefined {
    return this.rows.find((r) => r.file_ref === ref);
  }
}

/** A tenant-bound fake `HandlerDb` over a shared table (build one per tenant in a test). */
export function makeFakeFileDb(table: SharedFileTable, tenantId: string): HandlerDb {
  const requireStore = (store: string): void => {
    if (store !== FILE_UPLOADS_STORE) {
      throw new Error(`fake db: undeclared store '${store}' (fail-closed like the real facade).`);
    }
  };
  const db: HandlerDb = {
    async select(store, filter = {}, opts) {
      requireStore(store);
      let rows = table.rows.filter((r) => r.tenant_id === tenantId);
      for (const [col, val] of Object.entries(filter)) {
        rows = rows.filter((r) => r[col] === val);
      }
      if (opts?.limit !== undefined) rows = rows.slice(0, opts.limit);
      return rows.map((r) => ({ ...r }) as StoreRow);
    },
    async insert(store, values) {
      requireStore(store);
      if (table.findByRef(values.file_ref) !== undefined) {
        throw new Error('unique constraint violation');
      }
      const row: FakeRow = { ...values, tenant_id: tenantId };
      table.rows.push(row);
      return { ...row } as StoreRow;
    },
    async upsert(store, conflictColumns, values, opts) {
      requireStore(store);
      if (conflictColumns.length !== 1 || conflictColumns[0] !== 'file_ref') {
        throw new Error(`fake db: unexpected conflict target ${conflictColumns.join(',')}`);
      }
      const existing = table.findByRef(values.file_ref);
      if (existing === undefined) {
        const row: FakeRow = { ...values, tenant_id: tenantId };
        table.rows.push(row);
        return { ...row } as StoreRow;
      }
      // The REAL facade's law: the DO-UPDATE is tenant-scoped — a conflict on a FOREIGN tenant's
      // row updates ZERO rows and returns undefined (fail-closed no-op).
      if (existing.tenant_id !== tenantId) return undefined;
      // The CONDITIONAL-UPDATE guard (updateWhere): the conflicting row must ALSO match every guard
      // column — exactly what Postgres's `ON CONFLICT … DO UPDATE … WHERE` enforces (AND-ed beneath the
      // tenant scope). A row that does NOT match updates ZERO rows and returns undefined. A fake that
      // IGNORED this guard would prove nothing — it would go green against an unconditional upsert too.
      if (opts?.updateWhere !== undefined) {
        for (const [col, val] of Object.entries(opts.updateWhere)) {
          if (existing[col] !== val) return undefined;
        }
      }
      Object.assign(existing, values);
      return { ...existing } as StoreRow;
    },
    async update(store, filter, patch) {
      requireStore(store);
      const rows = table.rows.filter(
        (r) => r.tenant_id === tenantId && Object.entries(filter).every(([c, v]) => r[c] === v),
      );
      for (const r of rows) Object.assign(r, patch);
      return rows.map((r) => ({ ...r }) as StoreRow);
    },
    async delete(store, filter) {
      requireStore(store);
      const keep: FakeRow[] = [];
      let deleted = 0;
      for (const r of table.rows) {
        const match =
          r.tenant_id === tenantId && Object.entries(filter).every(([c, v]) => r[c] === v);
        if (match) deleted += 1;
        else keep.push(r);
      }
      table.rows.length = 0;
      table.rows.push(...keep);
      return deleted;
    },
    async transaction(fn) {
      return fn(db);
    },
  };
  return db;
}
