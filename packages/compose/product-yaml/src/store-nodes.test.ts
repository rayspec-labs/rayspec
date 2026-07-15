/**
 * The Tier-A store.read / store.write nodes — unit proofs over a spying
 * HandlerDb fake. The C10/at-least-once LAW is pinned fail-the-fix: store.write goes through
 * `db.upsert` EXCLUSIVELY with the STORE-DECLARED conflict key — the fake exposes an `insert` spy
 * that must NEVER fire (an insert-and-recover rewrite trips this test before it can poison a run
 * transaction with an in-tx 23505 → 25P02).
 */

import type {
  ArtifactRef,
  CapabilityInvocationContext,
  ExecutionJournal,
  WorkflowSpec,
} from '@rayspec/foundation';
import type { HandlerDb, SelectOptions, StoreFilter, StoreRow } from '@rayspec/handler-sdk';
import { STORE_READ_DEFAULT_LIMIT } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import { makeStoreReadNode, makeStoreWriteNode } from './store-nodes.js';
import { FIELDLOG_YAML, parseFixture } from './test-support/fixture.js';

const SPEC = parseFixture(FIELDLOG_YAML);

/** A spying HandlerDb: records select/upsert calls; every OTHER method throws (never reachable). */
class SpyDb implements HandlerDb {
  readonly selects: Array<{ store: string; filter?: StoreFilter; opts?: SelectOptions }> = [];
  readonly upserts: Array<{ store: string; conflictColumns: string[]; values: StoreRow }> = [];
  readonly inserts: StoreRow[] = [];
  selectRows: StoreRow[] = [];
  upsertRow: StoreRow | undefined = { entry_ref: 'sess-1' };
  failWith: Error | undefined;

  async select(store: string, filter?: StoreFilter, opts?: SelectOptions): Promise<StoreRow[]> {
    if (this.failWith) throw this.failWith;
    this.selects.push({ store, ...(filter ? { filter } : {}), ...(opts ? { opts } : {}) });
    return this.selectRows;
  }
  async count(): Promise<number> {
    throw new Error('unexpected count');
  }
  async insert(_store: string, values: StoreRow): Promise<StoreRow> {
    // THE LAW: a store.write node must never reach insert (upsert-exclusive — C10/25P02).
    this.inserts.push(values);
    throw new Error('unexpected insert — store.write must be upsert-EXCLUSIVE');
  }
  async upsert(
    store: string,
    conflictColumns: string[],
    values: StoreRow,
  ): Promise<StoreRow | undefined> {
    if (this.failWith) throw this.failWith;
    this.upserts.push({ store, conflictColumns, values });
    return this.upsertRow;
  }
  async update(): Promise<StoreRow[]> {
    throw new Error('unexpected update');
  }
  async delete(): Promise<number> {
    throw new Error('unexpected delete');
  }
  async transaction<R>(fn: (tx: HandlerDb) => Promise<R>): Promise<R> {
    return fn(this);
  }
}

const WORKFLOW: WorkflowSpec = {
  id: 'log_session',
  tier: 'A',
  status: 'runtime_foundation',
  trigger: { event: 'audio_input.finalized_session' },
  idempotency_key: 'unused',
  steps: [],
};

function journal(): ExecutionJournal {
  return {
    workflow_run_id: 'run-1',
    workflow_id: 'log_session',
    idempotency_key: 'k',
    input_event: {
      id: 'evt-1',
      type: 'audio_input.finalized_session',
      occurred_at: 'now',
      payload: {},
    },
    status: 'running',
    node_states: [],
    artifact_refs: [],
    attempts: 1,
    created_at: 'now',
    updated_at: 'now',
  };
}

function ctxFor(
  stepId: 'catalog' | 'log',
  operation: 'read' | 'write',
  payload: Record<string, unknown>,
  artifacts: ArtifactRef[] = [],
  outputRefs?: string[],
): CapabilityInvocationContext {
  return {
    workflow: WORKFLOW,
    step: {
      id: stepId,
      capability: 'store',
      operation,
      ...(outputRefs ? { output_artifact_refs: outputRefs } : {}),
    },
    input_event: {
      id: 'evt-1',
      type: 'audio_input.finalized_session',
      occurred_at: 'now',
      payload,
    },
    input: {},
    journal: journal(),
    artifacts,
  };
}

describe('store.read node', () => {
  it('resolves the declared filter, applies limit + deterministic key-asc order, emits the rows artifact', async () => {
    const db = new SpyDb();
    db.selectRows = [{ item_code: 'mic_kit', label: 'Mic kit' }];
    const node = makeStoreReadNode({ spec: SPEC, db });
    const result = await node(
      ctxFor('catalog', 'read', { session_id: 'sess-1' }, [], ['fieldlog.catalog_rows']),
    );
    expect(db.selects).toEqual([
      {
        store: 'equipment_catalog',
        filter: { item_code: 'mic_kit' },
        opts: { limit: 10, orderBy: [{ column: 'item_code', dir: 'asc' }] },
      },
    ]);
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('unreachable');
    expect(result.artifact_refs).toEqual([
      {
        id: 'catalog:fieldlog.catalog_rows',
        kind: 'fieldlog.catalog_rows',
        source_node_id: 'catalog',
        value: [{ item_code: 'mic_kit', label: 'Mic kit' }],
      },
    ]);
    expect(result.output).toEqual({ store: 'equipment_catalog', count: 1 });
  });

  it('an OMITTED limit defaults to STORE_READ_DEFAULT_LIMIT (bounded by construction)', async () => {
    const spec = parseFixture(FIELDLOG_YAML.replace('        limit: 10\n', ''));
    const db = new SpyDb();
    const node = makeStoreReadNode({ spec, db });
    await node(ctxFor('catalog', 'read', { session_id: 'sess-1' }, [], ['fieldlog.catalog_rows']));
    expect(db.selects[0]?.opts?.limit).toBe(STORE_READ_DEFAULT_LIMIT);
  });

  it('a filter {event:} key absent from the trigger payload fails TYPED (never an unbounded/wrong read)', async () => {
    const spec = parseFixture(
      FIELDLOG_YAML.replace('item_code: { const: mic_kit }', 'item_code: { event: item_code }'),
    );
    const db = new SpyDb();
    const node = makeStoreReadNode({ spec, db });
    const result = await node(
      ctxFor('catalog', 'read', { session_id: 'sess-1' }, [], ['fieldlog.catalog_rows']),
    );
    expect(result.status).toBe('terminal_failure');
    if (result.status !== 'terminal_failure') throw new Error('unreachable');
    expect(result.error?.code).toBe('store_event_key_missing');
    expect(db.selects).toEqual([]);
  });

  it('a step id the ProductSpec does not declare fails TYPED (code-built spec mismatch)', async () => {
    const db = new SpyDb();
    const node = makeStoreReadNode({ spec: SPEC, db });
    const result = await node(
      ctxFor('log', 'read', { session_id: 'sess-1' }, [], ['fieldlog.catalog_rows']),
    );
    expect(result.status).toBe('terminal_failure');
    if (result.status !== 'terminal_failure') throw new Error('unreachable');
    expect(result.error?.code).toBe('store_step_undeclared');
  });

  it('a facade failure surfaces as a TYPED terminal failure (never an unhandled throw)', async () => {
    const db = new SpyDb();
    db.failWith = new Error('boom');
    const node = makeStoreReadNode({ spec: SPEC, db });
    const result = await node(
      ctxFor('catalog', 'read', { session_id: 'sess-1' }, [], ['fieldlog.catalog_rows']),
    );
    expect(result.status).toBe('terminal_failure');
    if (result.status !== 'terminal_failure') throw new Error('unreachable');
    expect(result.error?.code).toBe('store_read_failed');
    expect(result.error?.message).toContain('boom');
  });
});

describe('store.write node (upsert-EXCLUSIVE — the C10/at-least-once law)', () => {
  const catalogArtifact: ArtifactRef = {
    id: 'catalog:fieldlog.catalog_rows',
    kind: 'fieldlog.catalog_rows',
    source_node_id: 'catalog',
    value: [{ item_code: 'mic_kit', label: 'Mic kit' }],
  };

  it('resolves event/const/artifact sources and upserts on the STORE-DECLARED conflict key — insert NEVER fires', async () => {
    const db = new SpyDb();
    db.upsertRow = { entry_ref: 'sess-1', session_id: 'sess-1', status: 'processed' };
    const node = makeStoreWriteNode({ spec: SPEC, db });
    const result = await node(
      ctxFor('log', 'write', { session_id: 'sess-1' }, [catalogArtifact], ['fieldlog.log_row']),
    );
    expect(db.upserts).toEqual([
      {
        store: 'session_log',
        conflictColumns: ['entry_ref'],
        values: {
          entry_ref: 'sess-1',
          session_id: 'sess-1',
          status: 'processed',
          catalog_snapshot: [{ item_code: 'mic_kit', label: 'Mic kit' }],
        },
      },
    ]);
    expect(db.inserts).toEqual([]); // upsert-EXCLUSIVE (fail-the-fix)
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('unreachable');
    expect(result.output).toEqual({ store: 'session_log', key: ['entry_ref'], wrote: 1 });
    expect(result.artifact_refs).toEqual([
      {
        id: 'log:fieldlog.log_row',
        kind: 'fieldlog.log_row',
        source_node_id: 'log',
        value: { entry_ref: 'sess-1', session_id: 'sess-1', status: 'processed' },
      },
    ]);
  });

  it('an undefined upsert on a DO-UPDATE-shaped write (values beyond the key) is a TYPED terminal failure — NEVER a silent completed/wrote:0', async () => {
    // The facade's return contract (store-facade.ts): on the DO-UPDATE arm, `undefined` means the
    // conflict row EXISTS but the tenant-scoped setWhere matched ZERO rows — i.e. a FOREIGN tenant
    // holds the (deployment-global) key. Reporting `completed/wrote:0` here was SILENT cross-tenant
    // data loss (the old, structurally blind pin). It must surface loudly.
    const db = new SpyDb();
    db.upsertRow = undefined;
    const node = makeStoreWriteNode({ spec: SPEC, db });
    const result = await node(
      ctxFor('log', 'write', { session_id: 'sess-1' }, [catalogArtifact], ['fieldlog.log_row']),
    );
    expect(result.status).toBe('terminal_failure');
    if (result.status !== 'terminal_failure') throw new Error('unreachable');
    expect(result.error?.code).toBe('store_write_conflict');
    expect(result.error?.retryable).toBe(false);
    // Content-free re VALUES: the message names the store + the key COLUMN — never the key VALUE
    // (no new cross-tenant oracle surface beyond failure visibility).
    expect(result.error?.message).toContain('session_log');
    expect(result.error?.message).toContain('entry_ref');
    expect(result.error?.message).not.toContain('sess-1');
    // The DO-UPDATE arm is unambiguous — no verify-read fires.
    expect(db.selects).toEqual([]);
  });

  // ── the KEY-ONLY (ensure-exists) write: values ≡ the conflict key, the facade's DO-NOTHING arm ──
  // Lint admits a store_write whose values carry ONLY the key column; the facade then takes
  // `onConflictDoNothing`, where `undefined` is AMBIGUOUS: a legitimate SAME-tenant dedup (the
  // at-least-once re-execution — MUST stay completed) or a FOREIGN-tenant key holder (MUST fail
  // loudly). The node disambiguates with a tenant-scoped verify-read on the key column.
  const KEY_ONLY_YAML = FIELDLOG_YAML.replace(
    `        values:
          entry_ref: { event: session_id }
          session_id: { event: session_id }
          status: { const: processed }
          catalog_snapshot: { artifact: fieldlog.catalog_rows }
        outputs:
          log_row: fieldlog.log_row`,
    `        values:
          entry_ref: { event: session_id }`,
  );

  it('a key-only (ensure-exists) undefined that IS a same-tenant dedup completes wrote:0 — proven by the tenant-scoped verify-read (at-least-once convergence preserved)', async () => {
    const spec = parseFixture(KEY_ONLY_YAML);
    const db = new SpyDb();
    db.upsertRow = undefined;
    db.selectRows = [{ entry_ref: 'sess-1' }]; // THIS tenant already holds the row → genuine dedup
    const node = makeStoreWriteNode({ spec, db });
    const result = await node(ctxFor('log', 'write', { session_id: 'sess-1' }, []));
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('unreachable');
    expect(result.output).toEqual({ store: 'session_log', key: ['entry_ref'], wrote: 0 });
    // The disambiguating read went through the SAME tenant-bound facade, on the key column.
    expect(db.selects).toEqual([
      { store: 'session_log', filter: { entry_ref: 'sess-1' }, opts: { limit: 1 } },
    ]);
  });

  it('a key-only (ensure-exists) undefined with NO same-tenant row is the FOREIGN-holder conflict — TYPED terminal failure, never a silent success', async () => {
    const spec = parseFixture(KEY_ONLY_YAML);
    const db = new SpyDb();
    db.upsertRow = undefined;
    db.selectRows = []; // this tenant does NOT hold the key → a foreign tenant does
    const node = makeStoreWriteNode({ spec, db });
    const result = await node(ctxFor('log', 'write', { session_id: 'sess-1' }, []));
    expect(result.status).toBe('terminal_failure');
    if (result.status !== 'terminal_failure') throw new Error('unreachable');
    expect(result.error?.code).toBe('store_write_conflict');
    expect(result.error?.message).toContain('session_log');
    expect(result.error?.message).toContain('entry_ref');
    expect(result.error?.message).not.toContain('sess-1'); // never the key VALUE
  });

  it('a MISSING upstream artifact for an {artifact:} source fails TYPED (never a silent null write)', async () => {
    const db = new SpyDb();
    const node = makeStoreWriteNode({ spec: SPEC, db });
    const result = await node(ctxFor('log', 'write', { session_id: 'sess-1' }, []));
    expect(result.status).toBe('terminal_failure');
    if (result.status !== 'terminal_failure') throw new Error('unreachable');
    expect(result.error?.code).toBe('store_artifact_missing');
    expect(db.upserts).toEqual([]);
  });

  it('an {event:} key absent from the trigger payload fails TYPED before any write', async () => {
    const db = new SpyDb();
    const node = makeStoreWriteNode({ spec: SPEC, db });
    const result = await node(ctxFor('log', 'write', {}, [catalogArtifact]));
    expect(result.status).toBe('terminal_failure');
    if (result.status !== 'terminal_failure') throw new Error('unreachable');
    expect(result.error?.code).toBe('store_event_key_missing');
    expect(db.upserts).toEqual([]);
  });

  it('a facade failure surfaces as a TYPED terminal failure', async () => {
    const db = new SpyDb();
    db.failWith = new Error('unique constraint violation');
    const node = makeStoreWriteNode({ spec: SPEC, db });
    const result = await node(ctxFor('log', 'write', { session_id: 'sess-1' }, [catalogArtifact]));
    expect(result.status).toBe('terminal_failure');
    if (result.status !== 'terminal_failure') throw new Error('unreachable');
    expect(result.error?.code).toBe('store_write_failed');
  });

  // ── declared column ENUM enforcement on the workflow store.write path ─────────────────────────
  // The `status` column declares an enum whitelist that EXCLUDES the runtime value; the value is
  // EVENT-sourced (dynamic — exactly the agent/event case authoring lint CANNOT statically catch).
  // The enum whitelist is enforced HERE (not only on the HTTP route) so an out-of-whitelist value —
  // including an agent's classification output — can never be silently persisted.
  const ENUM_YAML = FIELDLOG_YAML.replace(
    '- { name: status, type: text }',
    '- { name: status, type: text, enum: [accepted, rejected] }',
  ).replace('status: { const: processed }', 'status: { event: status }');

  it('an OUT-of-whitelist resolved enum value is a TYPED terminal failure BEFORE the upsert (fail-the-fix)', async () => {
    const spec = parseFixture(ENUM_YAML);
    const db = new SpyDb();
    const node = makeStoreWriteNode({ spec, db });
    const result = await node(
      ctxFor(
        'log',
        'write',
        { session_id: 'sess-1', status: 'processed' }, // 'processed' ∉ [accepted, rejected]
        [catalogArtifact],
        ['fieldlog.log_row'],
      ),
    );
    expect(result.status).toBe('terminal_failure');
    if (result.status !== 'terminal_failure') throw new Error('unreachable');
    expect(result.error?.code).toBe('store_write_enum_violation');
    expect(result.error?.message).toContain('status'); // names the COLUMN
    expect(result.error?.message).toContain('session_log'); // names the STORE
    expect(result.error?.message).not.toContain('processed'); // never echoes the offending VALUE
    expect(db.upserts).toEqual([]); // rejected BEFORE the write — no silent persist (fail-the-fix)
  });

  it('an IN-whitelist resolved enum value upserts normally (the guard does NOT over-reject)', async () => {
    const spec = parseFixture(ENUM_YAML);
    const db = new SpyDb();
    db.upsertRow = { entry_ref: 'sess-1', session_id: 'sess-1', status: 'accepted' };
    const node = makeStoreWriteNode({ spec, db });
    const result = await node(
      ctxFor(
        'log',
        'write',
        { session_id: 'sess-1', status: 'accepted' }, // 'accepted' ∈ [accepted, rejected]
        [catalogArtifact],
        ['fieldlog.log_row'],
      ),
    );
    expect(result.status).toBe('completed');
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0]?.values.status).toBe('accepted');
  });

  it('a NON-STRING resolved value for a text-enum column is rejected — it cannot bypass the whitelist by JS type (fail-the-fix)', async () => {
    // A NUMBER resolved from the {event:} source for the `status` text-enum column. A non-string is by
    // definition not a member of a text whitelist, so it must be rejected HERE — matching the HTTP
    // route's z.enum (a non-member number is a VALIDATION_ERROR). Fail-the-fix: with the pre-fix guard
    // (`typeof value === 'string' && …`) the number SKIPPED the whitelist and reached db.upsert (and the facade guard
    // accepts a scalar number too), so it would have upserted `completed` — a real bypass.
    const spec = parseFixture(ENUM_YAML);
    const db = new SpyDb();
    const node = makeStoreWriteNode({ spec, db });
    const result = await node(
      ctxFor(
        'log',
        'write',
        { session_id: 'sess-1', status: 123 }, // a NUMBER — not a string, not a member of [accepted, rejected]
        [catalogArtifact],
        ['fieldlog.log_row'],
      ),
    );
    expect(result.status).toBe('terminal_failure');
    if (result.status !== 'terminal_failure') throw new Error('unreachable');
    expect(result.error?.code).toBe('store_write_enum_violation');
    expect(result.error?.message).toContain('status'); // names the COLUMN
    expect(db.upserts).toEqual([]); // rejected BEFORE the write — never reached Postgres (fail-the-fix)
  });
});
