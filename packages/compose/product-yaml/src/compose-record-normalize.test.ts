/**
 * The declared input-normalize step, at the COMPOSE layer:
 *
 *   1. FAIL-CLOSED (RED-first): a doc whose record_input capability declares `input_normalize` but
 *      whose deployment supplies NO `rollout.record.normalizer` is REJECTED at compose (never a green
 *      mount whose submit route silently ignores the declared normalize) — the declared-agents
 *      executor-coverage mirror.
 *   2. POSITIVE WIRING (end-to-end through compose): with a normalizer factory supplied, the composed
 *      record submit handler runs the normalize step — the stored row carries the NORMALIZED value.
 *   3. NON-RECORD REJECTION: `input_normalize` declared on a capability OTHER than record_input has no
 *      wired runtime here and is rejected fail-closed.
 */
import type { HandlerDb } from '@rayspec/handler-sdk';
import type { RecordNormalizerFactory } from '@rayspec/record-runtime';
import { type ProductSpec, parseProductSpec } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import { composeCapabilityStores } from './capability-stores.js';
import { composeProductDeploy, type ProductYamlRollout } from './compose.js';
import { deriveProductStores } from './derive-stores.js';
import { NORMALIZE_INTAKE_YAML, parseFixture, RecordingEnqueuer } from './test-support/fixture.js';

const TENANT = '00000000-0000-0000-0000-0000000000d5';

/** A minimal in-memory HandlerDb (select + upsert) — enough to drive the submit core end-to-end. */
function fakeHandlerDb(rows: Record<string, unknown>[] = []): HandlerDb {
  return {
    async select(_store: string, filter: Record<string, unknown>) {
      return rows.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
    },
    async upsert(_store: string, _conflict: string[], row: Record<string, unknown>) {
      const ref = row.record_ref;
      const i = rows.findIndex((r) => r.record_ref === ref);
      if (i >= 0) rows[i] = { ...rows[i], ...row };
      else rows.push({ ...row });
    },
  } as unknown as HandlerDb;
}

/** The rollout for the normalize fixture (declared store derived; normalizer optional). */
function normalizeRollout(
  spec: ProductSpec,
  normalizer?: RecordNormalizerFactory,
): ProductYamlRollout {
  const derived = deriveProductStores(spec, composeCapabilityStores(spec).names);
  return {
    tenantId: TENANT,
    enqueuer: new RecordingEnqueuer(),
    stores: derived.stores,
    artifactCollections: derived.artifactCollections,
    ...(normalizer ? { record: { normalizer } } : {}),
  };
}

describe('compose — the declared input-normalize step', () => {
  it('FAIL-CLOSED: a normalize-declaring doc with NO wired normalizer is rejected at compose (naming the seam)', () => {
    const spec = parseFixture(NORMALIZE_INTAKE_YAML);
    expect(() => composeProductDeploy(spec, normalizeRollout(spec))).toThrow(
      /input_normalize.*rollout\.record\.normalizer|rollout\.record\.normalizer.*absent/s,
    );
  });

  it('POSITIVE: a supplied normalizer factory is wired into the composed submit handler — a submit stores the NORMALIZED value (end-to-end)', async () => {
    const spec = parseFixture(NORMALIZE_INTAKE_YAML);
    const factory: RecordNormalizerFactory = () => ({
      agentId: 'field_normalizer',
      async normalize({ record }) {
        return { status: 'normalized', record: { ...record, normalized: true } };
      },
    });
    const composed = composeProductDeploy(spec, normalizeRollout(spec, factory));

    const handler = composed.handlers.get('record_input_submit')?.fn;
    if (!handler) throw new Error('composed record submit handler missing');
    const rows: Record<string, unknown>[] = [];
    const init = {
      tenantId: TENANT,
      db: fakeHandlerDb(rows),
      params: { record_id: 'rec-1' },
      body: { title: 'fix the door' },
    } as never;

    const result = await handler(init);
    expect(result).toMatchObject({ record_id: 'rec-1', deduped: false });
    // The composed handler ran the wired normalize step — the stored row carries the NORMALIZED value.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ title: 'fix the door', normalized: true });
  });

  it('NON-RECORD: input_normalize declared on a non-record capability is rejected fail-closed', () => {
    const parsed = parseProductSpec(`
version: "1.0"
product:
  id: mis_norm
  name: Misplaced Normalize
requires:
  capabilities: [file_input]
capabilities:
  - id: file_input
    tier: B
    status: available
    contracts: [file_input.file_submitted]
    input_normalize:
      agent: n
      output_contract: c.out
contracts:
  c.out:
    type: object
`);
    if (!parsed.ok) throw new Error(`fixture must parse:\n${JSON.stringify(parsed.errors)}`);
    expect(() =>
      composeProductDeploy(parsed.value, { tenantId: TENANT, enqueuer: new RecordingEnqueuer() }),
    ).toThrow(/input_normalize/);
  });
});
