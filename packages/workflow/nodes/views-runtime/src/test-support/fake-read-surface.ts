/**
 * Test-support: a REAL-CONSTRAINT-enforcing fake read surface (a fake must
 * reproduce the real constraint, or it proves nothing).
 *
 * Mirrors the load-bearing behaviors of the real `HandlerDb` facade over `TenantDb`
 * (@rayspec/platform store-facade.ts):
 *   - an UNDECLARED store name THROWS (fail-closed — same as `resolveTable`);
 *   - an unknown FILTER or ORDER-BY column THROWS (same as `resolveColumn`);
 *   - a negative/NaN limit/offset THROWS (same as `assertNonNegativeInt`);
 *   - rows are TENANT-PARTITIONED STRUCTURALLY: a handle is bound to ONE tenant at construction
 *     and physically cannot see another tenant's rows (the TenantDb predicate analog);
 *   - `Date` values serialize to ISO strings on read (same as `serializeValue`);
 *   - equality-only filters (AND-combined), stable multi-key ORDER BY (asc/desc), LIMIT/OFFSET.
 *
 * Rows are stored per (tenant, store); `seed` stamps the injected `id`/`created_at` when absent
 * (the real insert path stamps them server-side).
 */
import type { SelectOptions, StoreFilter, StoreRow } from '@rayspec/handler-sdk';
import type { StoreSpec } from '@rayspec/spec';

/** The injected columns the real table always carries (the fake resolves them like declared ones). */
const INJECTED = new Set([
  'id',
  'tenant_id',
  'created_at',
  'deleted_at',
  'retention_days',
  'region',
]);

function serializeValue(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

function assertNonNegativeInt(what: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`FakeReadSurface: ${what} must be a non-negative integer (got ${value})`);
  }
}

export class FakeReadSurface {
  readonly #columns = new Map<string, Set<string>>();
  /** tenant → store → rows (structural partition — the tenant predicate analog). */
  readonly #rows = new Map<string, Map<string, StoreRow[]>>();
  #nextId = 1;

  constructor(stores: readonly StoreSpec[]) {
    for (const store of stores) {
      const cols = new Set(INJECTED);
      for (const c of store.columns) cols.add(c.name);
      this.#columns.set(store.name, cols);
    }
  }

  /** Seed one row into a tenant's store (stamps injected id/created_at when absent). */
  seed(tenantId: string, store: string, row: StoreRow): void {
    const cols = this.#resolveStore(store);
    for (const key of Object.keys(row)) {
      if (!cols.has(key)) {
        throw new Error(`FakeReadSurface: seed uses unknown column '${key}' on store '${store}'`);
      }
    }
    let tenant = this.#rows.get(tenantId);
    if (!tenant) {
      tenant = new Map();
      this.#rows.set(tenantId, tenant);
    }
    let rows = tenant.get(store);
    if (!rows) {
      rows = [];
      tenant.set(store, rows);
    }
    rows.push({
      id: `fake-${this.#nextId++}`,
      created_at: '2026-07-01T10:00:00.000Z',
      tenant_id: tenantId,
      ...row,
    });
  }

  #resolveStore(store: string): Set<string> {
    const cols = this.#columns.get(store);
    if (!cols) {
      throw new Error(
        `FakeReadSurface: store '${store}' is not a declared product store (fail-closed) — a ` +
          'handler may only access stores declared in the spec.',
      );
    }
    return cols;
  }

  /** Resolve + apply an equality filter over ONE tenant's partition (shared by select and count). */
  #match(tenantId: string, store: string, filter: StoreFilter | undefined): StoreRow[] {
    const cols = this.#resolveStore(store);
    for (const key of Object.keys(filter ?? {})) {
      if (!cols.has(key)) {
        throw new Error(
          `FakeReadSurface: unknown filter column '${key}' on store '${store}' (fail-closed)`,
        );
      }
    }
    // STRUCTURAL tenant scope: only THIS tenant's partition is even reachable.
    const all = this.#rows.get(tenantId)?.get(store) ?? [];
    return all.filter((row) => Object.entries(filter ?? {}).every(([k, v]) => row[k] === v));
  }

  /** A tenant-BOUND read handle (the shape the interpreter consumes: `select`+`count` — read-only). */
  forTenant(tenantId: string): {
    select: (store: string, filter?: StoreFilter, opts?: SelectOptions) => Promise<StoreRow[]>;
    count: (store: string, filter?: StoreFilter) => Promise<number>;
  } {
    return {
      // The count primitive — same fail-closed resolution + tenant partition as select.
      count: async (store, filter) => this.#match(tenantId, store, filter).length,
      select: async (store, filter, opts) => {
        const cols = this.#resolveStore(store);
        let rows = this.#match(tenantId, store, filter);
        if (opts?.orderBy && opts.orderBy.length > 0) {
          for (const { column } of opts.orderBy) {
            if (!cols.has(column)) {
              throw new Error(
                `FakeReadSurface: unknown order-by column '${column}' on store '${store}' (fail-closed)`,
              );
            }
          }
          const keys = opts.orderBy;
          rows = [...rows].sort((a, b) => {
            for (const { column, dir } of keys) {
              const av = a[column];
              const bv = b[column];
              let cmp = 0;
              if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
              else cmp = String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
              if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
            }
            return 0;
          });
        }
        if (opts?.offset !== undefined) {
          assertNonNegativeInt('offset', opts.offset);
          rows = rows.slice(opts.offset);
        }
        if (opts?.limit !== undefined) {
          assertNonNegativeInt('limit', opts.limit);
          rows = rows.slice(0, opts.limit);
        }
        // Serialize like the real facade (Date → ISO) and return copies (no aliasing).
        return rows.map((row) => {
          const out: StoreRow = {};
          for (const [k, v] of Object.entries(row)) out[k] = serializeValue(v);
          return out;
        });
      },
    };
  }
}
