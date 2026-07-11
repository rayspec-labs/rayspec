/**
 * A deterministic in-memory `HandlerDb` fake for the capability unit tests. THE FAKE ENFORCES THE
 * REAL CONSTRAINTS (the fail-the-fix discipline — a fake that is a plain array proves nothing):
 *
 *  - ONE SHARED underlying table across tenant-bound instances, with a GLOBAL (cross-tenant)
 *    unique index on `record_ref` — exactly what the platform's generated single-column unique is.
 *    A test composing two tenant-bound fakes over one `SharedRecordTable` therefore proves the
 *    tenant-prefixed ref ISOLATES tenants (and would catch a regression that dropped the prefix).
 *  - the facade's upsert semantics: DO-UPDATE is TENANT-SCOPED (a conflict on a foreign tenant's
 *    row writes nothing and returns `undefined`); tenant_id is auto-stamped on insert.
 *  - select is tenant-scoped structurally (every read filters by the bound tenant first).
 */
import type { HandlerDb, StoreRow } from '@rayspec/handler-sdk';
import { RECORD_SUBMISSIONS_STORE } from '../stores.js';

interface FakeRow extends Record<string, unknown> {
  tenant_id: string;
}

/** The shared underlying table (one per test) — the global-unique authority. */
export class SharedRecordTable {
  readonly rows: FakeRow[] = [];

  findByRef(ref: unknown): FakeRow | undefined {
    return this.rows.find((r) => r.record_ref === ref);
  }
}

/** A tenant-bound fake `HandlerDb` over a shared table (build one per tenant in a test). */
export function makeFakeRecordDb(table: SharedRecordTable, tenantId: string): HandlerDb {
  const requireStore = (store: string): void => {
    if (store !== RECORD_SUBMISSIONS_STORE) {
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
      if (table.findByRef(values.record_ref) !== undefined) {
        throw new Error('unique constraint violation');
      }
      const row: FakeRow = { ...values, tenant_id: tenantId };
      table.rows.push(row);
      return { ...row } as StoreRow;
    },
    async upsert(store, conflictColumns, values) {
      requireStore(store);
      if (conflictColumns.length !== 1 || conflictColumns[0] !== 'record_ref') {
        throw new Error(`fake db: unexpected conflict target ${conflictColumns.join(',')}`);
      }
      const existing = table.findByRef(values.record_ref);
      if (existing === undefined) {
        const row: FakeRow = { ...values, tenant_id: tenantId };
        table.rows.push(row);
        return { ...row } as StoreRow;
      }
      // The REAL facade's law: the DO-UPDATE is tenant-scoped — a conflict on a FOREIGN tenant's
      // row updates ZERO rows and returns undefined (fail-closed no-op).
      if (existing.tenant_id !== tenantId) return undefined;
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
