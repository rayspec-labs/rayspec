/**
 * Deterministic in-memory fakes for the capability UNIT tests. They reproduce the REAL constraints the
 * capability relies on (the fail-the-fix discipline): the fake DB ENFORCES the tenant-namespaced
 * UNIQUE columns (a genuine double-insert of the same `session_ref`/`track_ref` throws a 23505-coded
 * error, exactly like the store facade surfaces); the fake blob computes a REAL content hash so the
 * playback ETag/304/Range behavior is exercised for real. Cross-tenant isolation + true SAVEPOINT
 * rollback under concurrency are proven at the DB level (the api-auth integration test), not here.
 *
 * NOT part of the package's public surface (the exports map exposes only `.` and `./rayspec`).
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  BlobNotFound,
  BlobPutOpts,
  BlobRangeOpts,
  BlobReadResult,
  BlobStat,
  BlobStore,
  HandlerDb,
  SelectOptions,
  StoreFilter,
  StoreRow,
} from '@rayspec/handler-sdk';

/** A 23505-coded unique-violation error (the shape the store facade surfaces; `code` is enumerable-safe). */
function uniqueViolation(): Error {
  const e = new Error('unique constraint violation');
  Object.defineProperty(e, 'code', { value: '23505', enumerable: false, configurable: true });
  return e;
}

/** Match a row against an equality filter (every key must equal; loose `==` like the real path). */
function matches(row: StoreRow, filter: StoreFilter | undefined): boolean {
  if (!filter) return true;
  for (const [k, v] of Object.entries(filter)) {
    if (row[k] !== v) return false;
  }
  return true;
}

export interface FakeHandlerDbOptions {
  /** Per-store UNIQUE column sets the fake enforces (default: audio_sessions/audio_tracks refs). */
  readonly uniqueColumns?: Record<string, readonly string[]>;
  /**
   * Test-only interleave seam: fires at the START of every `update()` (before the write lands). Lets a
   * deterministic test force a concurrent state change (e.g. a finalize sealing a track) BETWEEN a
   * transaction's re-read and its guarded write — the interleave the atomic status-guard defends.
   */
  readonly hooks?: {
    readonly beforeUpdate?: (
      store: string,
      filter: StoreFilter,
      patch: StoreRow,
    ) => void | Promise<void>;
  };
}

const DEFAULT_UNIQUE: Record<string, readonly string[]> = {
  audio_sessions: ['session_ref'],
  audio_tracks: ['track_ref'],
};

/** An in-memory `HandlerDb` that enforces per-store UNIQUE columns. Single implicit tenant (per instance). */
export class FakeHandlerDb implements HandlerDb {
  private readonly tables = new Map<string, StoreRow[]>();
  private readonly uniqueColumns: Record<string, readonly string[]>;
  private readonly hooks: FakeHandlerDbOptions['hooks'];

  constructor(opts: FakeHandlerDbOptions = {}) {
    this.uniqueColumns = opts.uniqueColumns ?? DEFAULT_UNIQUE;
    this.hooks = opts.hooks;
  }

  private rows(store: string): StoreRow[] {
    let r = this.tables.get(store);
    if (!r) {
      r = [];
      this.tables.set(store, r);
    }
    return r;
  }

  async select(store: string, filter?: StoreFilter, opts?: SelectOptions): Promise<StoreRow[]> {
    void opts;
    return this.rows(store)
      .filter((r) => matches(r, filter))
      .map((r) => ({ ...r }));
  }

  async insert(store: string, values: StoreRow): Promise<StoreRow> {
    const uniques = this.uniqueColumns[store] ?? [];
    for (const col of uniques) {
      if (values[col] !== undefined && this.rows(store).some((r) => r[col] === values[col])) {
        throw uniqueViolation();
      }
    }
    const row: StoreRow = { id: randomUUID(), ...values };
    this.rows(store).push(row);
    return { ...row };
  }

  async upsert(
    store: string,
    conflictColumns: string[],
    values: StoreRow,
  ): Promise<StoreRow | undefined> {
    const existing = this.rows(store).find((r) => conflictColumns.every((c) => r[c] === values[c]));
    if (existing) {
      Object.assign(existing, values);
      return { ...existing };
    }
    return this.insert(store, values);
  }

  async update(store: string, filter: StoreFilter, patch: StoreRow): Promise<StoreRow[]> {
    await this.hooks?.beforeUpdate?.(store, filter, patch);
    const updated: StoreRow[] = [];
    for (const r of this.rows(store)) {
      if (matches(r, filter)) {
        Object.assign(r, patch);
        updated.push({ ...r });
      }
    }
    return updated;
  }

  async delete(store: string, filter: StoreFilter): Promise<number> {
    const rows = this.rows(store);
    let removed = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r && matches(r, filter)) {
        rows.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  async transaction<R>(fn: (tx: HandlerDb) => Promise<R>): Promise<R> {
    // No real savepoint rollback (single-threaded deterministic tests never hit a concurrent race —
    // that is proven against a real Postgres in the api-auth integration test). A thrown fn propagates.
    return fn(this);
  }
}

/** An in-memory `BlobStore` with a REAL content hash (so ETag/304/Range are exercised for real). */
export class FakeBlobStore implements BlobStore {
  private readonly blobs = new Map<string, { bytes: Uint8Array; contentType?: string }>();

  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    opts?: BlobPutOpts,
  ): Promise<void> {
    const bytes =
      body instanceof Uint8Array
        ? new Uint8Array(body)
        : new Uint8Array(await new Response(body).arrayBuffer());
    this.blobs.set(key, { bytes, ...(opts?.contentType ? { contentType: opts.contentType } : {}) });
  }

  async get(key: string): Promise<BlobReadResult | BlobNotFound> {
    const b = this.blobs.get(key);
    if (!b) return { notFound: true, key };
    return {
      body: new Response(b.bytes).body as ReadableStream<Uint8Array>,
      contentLength: b.bytes.length,
      ...(b.contentType ? { contentType: b.contentType } : {}),
    };
  }

  async createReadStream(
    key: string,
    opts?: BlobRangeOpts,
  ): Promise<ReadableStream<Uint8Array> | BlobNotFound> {
    const b = this.blobs.get(key);
    if (!b) return { notFound: true, key };
    const offset = opts?.offset ?? 0;
    const length = opts?.length ?? b.bytes.length - offset;
    const slice = b.bytes.slice(offset, offset + length);
    return new Response(slice).body as ReadableStream<Uint8Array>;
  }

  async stat(key: string): Promise<BlobStat | BlobNotFound> {
    const b = this.blobs.get(key);
    if (!b) return { notFound: true, key };
    const sha = createHash('sha256').update(b.bytes).digest('hex');
    return {
      len: b.bytes.length,
      etagSource: `${sha}:${b.bytes.length}`,
      ...(b.contentType ? { contentType: b.contentType } : {}),
    };
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }

  async deleteTenant(): Promise<void> {
    this.blobs.clear();
  }

  /** Test helper: the raw stored bytes for a key (or undefined). */
  peek(key: string): Uint8Array | undefined {
    return this.blobs.get(key)?.bytes;
  }
}
