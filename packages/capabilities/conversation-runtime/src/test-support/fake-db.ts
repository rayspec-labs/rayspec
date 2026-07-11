/**
 * A deterministic in-memory `HandlerDb` fake for the capability unit tests. THE FAKE ENFORCES THE
 * REAL CONSTRAINTS (the fail-the-fix discipline — a fake that is a plain array proves nothing;
 * verified against `packages/platform/src/handlers/store-facade.ts` before porting):
 *
 *  - ONE SHARED underlying pair of tables across tenant-bound instances, with GLOBAL (cross-tenant)
 *    unique indexes exactly where the generated DDL puts them: `conversations.conversation_ref`,
 *    `conversation_turns.turn_ref`, `conversation_turns.seq_ref`. A test composing two tenant-bound
 *    fakes over one `SharedConversationTables` therefore proves the tenant-prefixed refs ISOLATE
 *    tenants (and would catch a regression that dropped the prefix).
 *  - `insert` throws the facade's SANITIZED unique-violation shape on ANY violated unique: a
 *    neutral `Error('unique constraint violation')` carrying `code === '23505'` NON-ENUMERABLY
 *    (the XT-1 sanitize — no constraint name; submit-turn's race detection keys on exactly this).
 *  - the facade's upsert semantics: DO-UPDATE is TENANT-SCOPED (a conflict on a foreign tenant's
 *    row writes nothing and returns `undefined`); tenant_id is auto-stamped on insert; a conflict
 *    on a NON-target unique throws the same sanitized error insert does.
 *  - select/update/delete are tenant-scoped structurally (every op filters by the bound tenant);
 *    select honors the C11 `orderBy`/`limit` options (submit-turn's tail read depends on them).
 *  - THE TX-POISON LAW (the F1 harvest — probe-verified against the REAL stack, drizzle +
 *    postgres.js): a route handler runs INSIDE the engine's tenant transaction, and a unique
 *    violation raised there UNSCOPED poisons that tx — postgres.js REMEMBERS the error and rejects
 *    the outer transaction promise with it even when the handler caught it (the typed 409 is
 *    produced but discarded → the route 500s). A `db.transaction(...)` NESTING, however, is a real
 *    SAVEPOINT (drizzle rolls back TO the savepoint on error), which un-poisons the outer tx. The
 *    fake models exactly that: each instance is ONE request's tx; an insert/upsert unique violation
 *    raised at savepoint depth 0 sets `poisoned` (every later call on the instance throws the
 *    25P02-shaped aborted-tx error); the SAME violation inside `transaction(fn)` does NOT poison,
 *    and the scope's OWN inserts are undone on error (a single-statement scope by construction in
 *    submit-turn — updates/deletes inside a savepoint scope are not modeled because no caller
 *    issues them; extend the journal if one ever does).
 */
import type { HandlerDb, StoreRow } from '@rayspec/handler-sdk';
import { CONVERSATION_TURNS_STORE, CONVERSATIONS_STORE } from '../stores.js';

interface FakeRow extends Record<string, unknown> {
  tenant_id: string;
}

/** The GLOBAL unique columns per store — the generated-DDL truth the fake enforces. */
const UNIQUE_COLUMNS: Record<string, readonly string[]> = {
  [CONVERSATIONS_STORE]: ['conversation_ref'],
  [CONVERSATION_TURNS_STORE]: ['turn_ref', 'seq_ref'],
};

/** The facade's sanitized unique-violation shape (store-facade.ts `sanitizeDbError`, reproduced). */
function uniqueViolation(): Error {
  const sanitized = new Error('unique constraint violation');
  Object.defineProperty(sanitized, 'code', {
    value: '23505',
    enumerable: false,
    configurable: true,
  });
  return sanitized;
}

/** The Postgres aborted-transaction shape every statement after an unscoped in-tx error gets. */
function abortedTransaction(): Error {
  const aborted = new Error(
    'current transaction is aborted, commands ignored until end of transaction block',
  );
  Object.defineProperty(aborted, 'code', {
    value: '25P02',
    enumerable: false,
    configurable: true,
  });
  return aborted;
}

/** The fake `HandlerDb` + the tx-poison observability the F1 unit arms assert on. */
export interface FakeConversationDb extends HandlerDb {
  /** TRUE once an UNSCOPED (non-savepoint) unique violation poisoned this request's tx. */
  readonly poisoned: boolean;
}

/** The shared underlying tables (one per test) — the global-unique authority. */
export class SharedConversationTables {
  readonly conversations: FakeRow[] = [];
  readonly turns: FakeRow[] = [];

  rowsOf(store: string): FakeRow[] {
    if (store === CONVERSATIONS_STORE) return this.conversations;
    if (store === CONVERSATION_TURNS_STORE) return this.turns;
    throw new Error(`fake db: undeclared store '${store}' (fail-closed like the real facade).`);
  }

  /** The GLOBAL (cross-tenant) unique lookup — exactly what the generated single-column unique is. */
  findByUnique(store: string, column: string, value: unknown): FakeRow | undefined {
    return this.rowsOf(store).find((r) => r[column] === value);
  }
}

/**
 * A tenant-bound fake `HandlerDb` over shared tables (build one per tenant in a test). ONE
 * instance models ONE request's route transaction (the tx-poison law — module header).
 */
export function makeFakeConversationDb(
  tables: SharedConversationTables,
  tenantId: string,
): FakeConversationDb {
  // The request-tx state: poisoned = an UNSCOPED unique violation escaped into the route tx
  // (postgres.js will reject the outer tx promise — every later statement is 25P02). A
  // `transaction(fn)` nesting is a SAVEPOINT scope: violations inside it never poison, and the
  // scope's OWN inserts are undone on error (the journal stack below).
  let poisoned = false;
  let savepointDepth = 0;
  const scopeInserts: FakeRow[][] = [];

  const guard = (): void => {
    if (poisoned) throw abortedTransaction();
  };
  const raiseUnique = (): never => {
    if (savepointDepth === 0) poisoned = true;
    throw uniqueViolation();
  };
  const assertNoUniqueViolation = (store: string, values: StoreRow, ignore?: FakeRow): void => {
    for (const column of UNIQUE_COLUMNS[store] ?? []) {
      if (!Object.hasOwn(values, column)) continue;
      const hit = tables.findByUnique(store, column, values[column]);
      if (hit !== undefined && hit !== ignore) raiseUnique();
    }
  };

  const db: FakeConversationDb = {
    get poisoned() {
      return poisoned;
    },
    async select(store, filter = {}, opts) {
      guard();
      let rows = tables.rowsOf(store).filter((r) => r.tenant_id === tenantId);
      for (const [col, val] of Object.entries(filter)) {
        rows = rows.filter((r) => r[col] === val);
      }
      if (opts?.orderBy && opts.orderBy.length > 0) {
        const order = [...opts.orderBy];
        rows = [...rows].sort((a, b) => {
          for (const { column, dir } of order) {
            const av = a[column] as number | string;
            const bv = b[column] as number | string;
            if (av === bv) continue;
            const cmp = av < bv ? -1 : 1;
            return dir === 'desc' ? -cmp : cmp;
          }
          return 0;
        });
      }
      // C11 paging exactly like the real facade (store-facade.ts): OFFSET first, then LIMIT
      // (drizzle emits both; the S3 history-window read depends on offset paging).
      if (opts?.offset !== undefined) rows = rows.slice(opts.offset);
      if (opts?.limit !== undefined) rows = rows.slice(0, opts.limit);
      return rows.map((r) => ({ ...r }) as StoreRow);
    },
    async insert(store, values) {
      guard();
      assertNoUniqueViolation(store, values);
      const row: FakeRow = { ...values, tenant_id: tenantId };
      tables.rowsOf(store).push(row);
      // Journal the write into the CURRENT savepoint scope (undone if that scope errors).
      scopeInserts[scopeInserts.length - 1]?.push(row);
      return { ...row } as StoreRow;
    },
    async upsert(store, conflictColumns, values) {
      guard();
      const target = conflictColumns[0];
      if (conflictColumns.length !== 1 || !(UNIQUE_COLUMNS[store] ?? []).includes(target ?? '')) {
        throw new Error(`fake db: unexpected conflict target ${conflictColumns.join(',')}`);
      }
      const existing = tables.findByUnique(store, target as string, values[target as string]);
      if (existing === undefined) {
        // No conflict on the named target — but a violated OTHER unique still raises (sanitized),
        // exactly like the real facade's insert path.
        assertNoUniqueViolation(store, values);
        const row: FakeRow = { ...values, tenant_id: tenantId };
        tables.rowsOf(store).push(row);
        scopeInserts[scopeInserts.length - 1]?.push(row);
        return { ...row } as StoreRow;
      }
      // The REAL facade's law: the DO-UPDATE is tenant-scoped — a conflict on a FOREIGN tenant's
      // row updates ZERO rows and returns undefined (fail-closed no-op).
      if (existing.tenant_id !== tenantId) return undefined;
      const patch: StoreRow = { ...values };
      delete patch[target as string];
      assertNoUniqueViolation(store, patch, existing);
      Object.assign(existing, patch);
      return { ...existing } as StoreRow;
    },
    async update(store, filter, patch) {
      guard();
      const rows = tables
        .rowsOf(store)
        .filter(
          (r) => r.tenant_id === tenantId && Object.entries(filter).every(([c, v]) => r[c] === v),
        );
      for (const r of rows) Object.assign(r, patch);
      return rows.map((r) => ({ ...r }) as StoreRow);
    },
    async delete(store, filter) {
      guard();
      const all = tables.rowsOf(store);
      const keep: FakeRow[] = [];
      let deleted = 0;
      for (const r of all) {
        const match =
          r.tenant_id === tenantId && Object.entries(filter).every(([c, v]) => r[c] === v);
        if (match) deleted += 1;
        else keep.push(r);
      }
      all.length = 0;
      all.push(...keep);
      return deleted;
    },
    async transaction(fn) {
      guard();
      // A NESTED transaction on an in-tx handle is a SAVEPOINT (drizzle; probe-verified): a
      // unique violation raised inside does NOT poison the outer tx (raiseUnique keys on the
      // depth), the error still rethrows to the caller (drizzle rethrows after ROLLBACK TO
      // SAVEPOINT), and the scope's OWN inserts are undone. Updates/deletes inside a savepoint
      // scope are not journaled — no caller issues them (module header).
      savepointDepth += 1;
      const myInserts: FakeRow[] = [];
      scopeInserts.push(myInserts);
      try {
        const result = await fn(db);
        // Scope committed: its writes belong to the PARENT scope now (undone if THAT errors).
        scopeInserts[scopeInserts.length - 2]?.push(...myInserts);
        return result;
      } catch (e) {
        // ROLLBACK TO SAVEPOINT: undo exactly THIS scope's inserts — never another tx's rows.
        for (const row of myInserts) {
          for (const store of [tables.conversations, tables.turns]) {
            const i = store.indexOf(row);
            if (i >= 0) store.splice(i, 1);
          }
        }
        throw e;
      } finally {
        scopeInserts.pop();
        savepointDepth -= 1;
      }
    },
  };
  return db;
}
