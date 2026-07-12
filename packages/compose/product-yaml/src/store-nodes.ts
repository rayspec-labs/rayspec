/**
 * The Tier-A `store.read` / `store.write` workflow nodes (S2) — the
 * runtime for the product profile's declared-store step types, built over the SAME tenant-bound `HandlerDb` facade
 * every other node uses (`makeHandlerDb`: name-keyed, fail-closed on undeclared stores/columns,
 * structurally tenant-predicated).
 *
 * DESIGN LAWS:
 *  - The compiled `WorkflowStepSpec` carries only the neutral dispatch shape (capability=store +
 *    operation); the DECLARATION (target store, filter, values, limit, the store's conflict key) is
 *    re-read from the validated `ProductSpec` by (workflow id, step id) — exactly how the grounding/
 *    validation/persist nodes read their policy from the spec. A step the spec does not declare is a
 *    TYPED failure (`store_step_undeclared`), never a guess.
 *  - **store.write is `db.upsert` EXCLUSIVE, on the STORE-DECLARED conflict key** (the C10 25P02
 *    lesson: an in-tx unique-violation on a non-upsert path poisons the WHOLE run transaction — an
 *    insert-and-recover can never be saved in-tx). The durable engine's at-least-once law re-executes
 *    a mid-crash node; the upsert makes the re-execution converge on ONE row per key value.
 *  - store.read is a BOUNDED equality lookup: the facade's equality-only select, capped at the
 *    declared `limit` (default STORE_READ_DEFAULT_LIMIT, clamped to STORE_READ_MAX_LIMIT in depth),
 *    deterministically ordered by the store's key column ascending (re-runs and journals see one
 *    stable row order). DELIBERATELY NOT SUPPORTED (honest v1): comparison/range/LIKE/IN filters,
 *    joins, multi-store transactions, deletes/updates.
 *  - Value sources resolve fail-closed: `{event}` reads a SCALAR trigger-payload key (absent/non-
 *    scalar → typed failure); `{const}` is the literal; `{artifact}` (write-values only) resolves the
 *    LAST upstream artifact of the declared contract ref (absent → typed failure — never a silent
 *    null write). A type mismatch the declarations cannot see statically (e.g. an object artifact
 *    into a text column) is rejected by the facade's column-type-aware SF-1 guard at run time.
 */

import type {
  CapabilityInvocationContext,
  CapabilityInvocationResult,
  CapabilityNodeHandler,
} from '@rayspec/foundation';
import type { HandlerDb, StoreRow } from '@rayspec/handler-sdk';
import {
  type ProductSpec,
  STORE_READ_DEFAULT_LIMIT,
  STORE_READ_MAX_LIMIT,
  type StoreFilterValue,
  type StoreWriteValue,
  type WorkflowStep,
} from '@rayspec/spec';
import { unwrapArtifactValue } from './materialize.js';
import { lastArtifactOfKind } from './nodes.js';

export interface StoreNodeConfig {
  readonly spec: ProductSpec;
  /** The run's tenant-bound store facade (the structural tenant predicate underneath). */
  readonly db: HandlerDb;
}

function fail(
  code: string,
  message: string,
): CapabilityInvocationResult & { status: 'terminal_failure' } {
  return { status: 'terminal_failure', error: { code, message, retryable: false } };
}

/** Re-read the DECLARED step (with its store vocabulary) by (workflow id, step id) — fail-closed. */
function declaredStep(
  spec: ProductSpec,
  ctx: CapabilityInvocationContext,
  expectedType: 'store_read' | 'store_write',
):
  | { ok: true; step: WorkflowStep; store: ProductSpec['stores'][number] }
  | { ok: false; failure: CapabilityInvocationResult } {
  const wf = spec.workflows.find((w) => w.id === ctx.workflow.id);
  const step = wf?.steps.find((s) => s.id === ctx.step.id);
  if (!step || step.type !== expectedType) {
    return {
      ok: false,
      failure: fail(
        'store_step_undeclared',
        `the ProductSpec declares no ${expectedType} step '${ctx.step.id}' in workflow ` +
          `'${ctx.workflow.id}' — the compiled spec and the product declaration have diverged ` +
          '(fail-closed; a code-built spec must carry the matching declaration).',
      ),
    };
  }
  const store =
    step.store !== undefined ? spec.stores.find((s) => s.name === step.store) : undefined;
  if (!store) {
    return {
      ok: false,
      failure: fail(
        'store_step_undeclared',
        `step '${ctx.step.id}' targets store '${step.store ?? '(none)'}', which is not a declared ` +
          'product store (fail-closed).',
      ),
    };
  }
  return { ok: true, step, store };
}

type Resolved = { ok: true; value: unknown } | { ok: false; failure: CapabilityInvocationResult };

/** Resolve ONE declared value source against the run (trigger payload / upstream artifacts). */
function resolveSource(
  source: StoreFilterValue | StoreWriteValue,
  ctx: CapabilityInvocationContext,
  where: string,
): Resolved {
  if ('event' in source) {
    const value = ctx.input_event.payload[source.event];
    const t = typeof value;
    if (t !== 'string' && t !== 'number' && t !== 'boolean') {
      return {
        ok: false,
        failure: fail(
          'store_event_key_missing',
          `${where} reads trigger-payload key '${source.event}', which is absent or not a scalar ` +
            `on event '${ctx.input_event.type}' (fail-closed — never a NULL/undefined identity).`,
        ),
      };
    }
    return { ok: true, value };
  }
  if ('const' in source) return { ok: true, value: source.const };
  // {artifact}: the LAST upstream artifact of the declared contract ref (write-values only by grammar).
  const artifact = lastArtifactOfKind(ctx, source.artifact);
  if (!artifact) {
    return {
      ok: false,
      failure: fail(
        'store_artifact_missing',
        `${where} references upstream artifact '${source.artifact}', which no completed dependency ` +
          'produced (fail-closed — never a silent null write; check depends_on).',
      ),
    };
  }
  return { ok: true, value: unwrapArtifactValue(artifact.value) };
}

/**
 * The `store.read` node: a BOUNDED, deterministic equality lookup over the declared target store,
 * emitting the rows under the step's single declared output ref (the downstream feed).
 */
export function makeStoreReadNode(cfg: StoreNodeConfig): CapabilityNodeHandler {
  return async (ctx): Promise<CapabilityInvocationResult> => {
    const declared = declaredStep(cfg.spec, ctx, 'store_read');
    if (!declared.ok) return declared.failure;
    const { step, store } = declared;

    const filter: StoreRow = {};
    for (const [column, source] of Object.entries(step.filter ?? {})) {
      const resolved = resolveSource(source, ctx, `store_read step '${step.id}' filter.${column}`);
      if (!resolved.ok) return resolved.failure;
      filter[column] = resolved.value as StoreRow[string];
    }

    // Bounded + deterministic: the declared limit (default/clamp per the shared spec constants) and
    // a stable key-ascending order (the key column is unique — a total order).
    const limit = Math.min(step.limit ?? STORE_READ_DEFAULT_LIMIT, STORE_READ_MAX_LIMIT);
    const keyColumn = store.key[0] as string;
    let rows: StoreRow[];
    try {
      rows = await cfg.db.select(store.name, filter, {
        limit,
        orderBy: [{ column: keyColumn, dir: 'asc' }],
      });
    } catch (e) {
      return fail(
        'store_read_failed',
        `store_read step '${step.id}' failed reading '${store.name}': ` +
          (e instanceof Error ? e.message : String(e)),
      );
    }

    const outputRef = ctx.step.output_artifact_refs?.[0];
    if (!outputRef) {
      return fail(
        'store_outputs_undeclared',
        `store_read step '${step.id}' compiled without its rows output ref (fail-closed).`,
      );
    }
    return {
      status: 'completed',
      artifact_refs: [
        {
          id: `${ctx.step.id}:${outputRef}`,
          kind: outputRef,
          source_node_id: ctx.step.id,
          value: rows,
        },
      ],
      output: { store: store.name, count: rows.length },
    };
  };
}

/**
 * The `store.write` node: resolve the declared row values, then **upsert EXCLUSIVELY on the store's
 * declared conflict key** (see the module header — the C10/at-least-once law).
 *
 * THE `undefined`-RESULT LAW (SEC-TEN-1/S2-XT-WRITE-BLIND fix — loud, never silent). The facade's
 * return contract (store-facade.ts) makes `undefined` mean, per arm:
 *  - DO-UPDATE arm (this node whenever `values` carries any NON-key column): the conflict row on the
 *    named key EXISTS but the tenant-scoped `setWhere` matched ZERO rows — i.e. a FOREIGN tenant
 *    holds the (deployment-global) key, or the razor-edge concurrent delete. There is NO legitimate
 *    same-tenant `undefined` here (a same-tenant conflict always updates + returns the row), so it
 *    is a TYPED terminal failure (`store_write_conflict`) — reporting `completed/wrote:0` was silent
 *    cross-tenant data loss.
 *  - DO-NOTHING arm (`values` ≡ the key — a lint-legal ensure-exists write): `undefined` is
 *    AMBIGUOUS — a legitimate SAME-tenant dedup (the at-least-once re-execution MUST converge to
 *    completed) or the same foreign-tenant holder. The node disambiguates with a tenant-scoped
 *    verify-read on the key column: row present → completed `wrote: 0`; absent → the typed failure.
 * The failure message is CONTENT-FREE re values (store + key COLUMN, never the key VALUE — no new
 * cross-tenant oracle surface beyond failure visibility). The structural fix (a tenant-scoped
 * composite unique) needs kill-set StoreSpec vocabulary — a deferred capability.
 */
export function makeStoreWriteNode(cfg: StoreNodeConfig): CapabilityNodeHandler {
  return async (ctx): Promise<CapabilityInvocationResult> => {
    const declared = declaredStep(cfg.spec, ctx, 'store_write');
    if (!declared.ok) return declared.failure;
    const { step, store } = declared;

    const values: StoreRow = {};
    for (const [column, source] of Object.entries(step.values ?? {})) {
      const resolved = resolveSource(source, ctx, `store_write step '${step.id}' values.${column}`);
      if (!resolved.ok) return resolved.failure;
      values[column] = resolved.value as StoreRow[string];
    }

    let row: StoreRow | undefined;
    try {
      // db.upsert ONLY — never insert-and-recover (C10: an in-tx 23505 → 25P02 poisons the whole
      // run transaction; the upsert's ON CONFLICT converges re-executions on ONE row per key).
      row = await cfg.db.upsert(store.name, [...store.key], values);
    } catch (e) {
      return fail(
        'store_write_failed',
        `store_write step '${step.id}' failed upserting into '${store.name}': ` +
          (e instanceof Error ? e.message : String(e)),
      );
    }

    if (row === undefined) {
      const keyColumn = store.key[0] as string;
      const conflict = fail(
        'store_write_conflict',
        `store_write step '${step.id}' could not apply its write to store '${store.name}': the row ` +
          `identified by key column '${keyColumn}' exists but is not writable by this tenant. The ` +
          'conflict key is deployment-global in this beta posture, so another tenant may already ' +
          'hold this key (see LIMITATIONS; the tenant-scoped composite key is BACKLOG ' +
          'PY-STORE-KEY-1). The write was NOT applied — failing loudly instead of reporting success.',
      );
      const hasNonKeyValues = Object.keys(values).some((c) => !store.key.includes(c));
      // DO-UPDATE arm: unambiguous (see the docstring) — the typed failure, no verify-read.
      if (hasNonKeyValues) return conflict;
      // DO-NOTHING (ensure-exists) arm: disambiguate via the tenant-scoped verify-read.
      let mine: StoreRow[];
      try {
        mine = await cfg.db.select(
          store.name,
          { [keyColumn]: values[keyColumn] as StoreRow[string] },
          { limit: 1 },
        );
      } catch (e) {
        return fail(
          'store_write_failed',
          `store_write step '${step.id}' failed verifying its ensure-exists write on ` +
            `'${store.name}': ` +
            (e instanceof Error ? e.message : String(e)),
        );
      }
      if (mine.length === 0) return conflict;
      // Same-tenant dedup — the at-least-once convergence: completed, wrote: 0 (falls through).
    }

    const outputRef = ctx.step.output_artifact_refs?.[0];
    return {
      status: 'completed',
      ...(outputRef && row
        ? {
            artifact_refs: [
              {
                id: `${ctx.step.id}:${outputRef}`,
                kind: outputRef,
                source_node_id: ctx.step.id,
                value: row,
              },
            ],
          }
        : {}),
      output: { store: store.name, key: [...store.key], wrote: row ? 1 : 0 },
    };
  };
}
