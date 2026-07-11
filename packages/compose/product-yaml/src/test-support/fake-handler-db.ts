/**
 * A constraint-ENFORCING in-memory `HandlerDb` fake (the discipline: a fake must reproduce the
 * REAL constraint or it proves nothing). It emulates the store facade the materializer/nodes write
 * through: equality-filtered select, insert, ATOMIC upsert with the real ON CONFLICT semantics over
 * the named conflict columns (get-or-update, never a duplicate row), update, delete-by-filter.
 */
import type { HandlerDb, StoreFilter, StoreRow } from '@rayspec/handler-sdk';

function matches(row: StoreRow, filter: StoreFilter | undefined): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([k, v]) => row[k] === v);
}

export class FakeHandlerDb implements HandlerDb {
  readonly stores = new Map<string, StoreRow[]>();
  /** Every upsert call `(store, conflictColumns, values)` — for call-shape assertions. */
  readonly upserts: Array<{ store: string; conflictColumns: string[]; values: StoreRow }> = [];

  rows(store: string): StoreRow[] {
    let rows = this.stores.get(store);
    if (!rows) {
      rows = [];
      this.stores.set(store, rows);
    }
    return rows;
  }

  async select(store: string, filter?: StoreFilter): Promise<StoreRow[]> {
    return this.rows(store)
      .filter((r) => matches(r, filter))
      .map((r) => ({ ...r }));
  }

  async count(store: string, filter?: StoreFilter): Promise<number> {
    return (await this.select(store, filter)).length;
  }

  async insert(store: string, values: StoreRow): Promise<StoreRow> {
    this.rows(store).push({ ...values });
    return { ...values };
  }

  async upsert(
    store: string,
    conflictColumns: string[],
    values: StoreRow,
  ): Promise<StoreRow | undefined> {
    this.upserts.push({ store, conflictColumns, values: { ...values } });
    const rows = this.rows(store);
    const existing = rows.find((r) => conflictColumns.every((c) => r[c] === values[c]));
    if (existing) {
      // The REAL ON CONFLICT DO UPDATE: one row, updated in place — never a duplicate.
      Object.assign(existing, values);
      return { ...existing };
    }
    rows.push({ ...values });
    return { ...values };
  }

  async update(store: string, filter: StoreFilter, patch: StoreRow): Promise<StoreRow[]> {
    const updated: StoreRow[] = [];
    for (const row of this.rows(store)) {
      if (!matches(row, filter)) continue;
      Object.assign(row, patch);
      updated.push({ ...row });
    }
    return updated;
  }

  async delete(store: string, filter: StoreFilter): Promise<number> {
    const rows = this.rows(store);
    const keep = rows.filter((r) => !matches(r, filter));
    const deleted = rows.length - keep.length;
    this.stores.set(store, keep);
    return deleted;
  }

  async transaction<R>(fn: (tx: HandlerDb) => Promise<R>): Promise<R> {
    return fn(this);
  }
}
