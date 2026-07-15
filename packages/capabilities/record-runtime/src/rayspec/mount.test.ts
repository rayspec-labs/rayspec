/**
 * The mount fragment: the `MountedAudioCapability`-shaped fragments compose consumes — ONE
 * authenticated POST submit route, the capability-owned store, the resolved handler map — plus the
 * HTTP-facing behavior of the bound handler (status mapping incl. the sink-rejection 403).
 */
import type { httpResponse } from '@rayspec/handler-sdk';
import { describe, expect, it } from 'vitest';
import { createInMemoryRecordSubmittedSink, RecordEventRejectedError } from '../events.js';
import type { RecordNormalizerFactory } from '../normalizer.js';
import { recordCapabilityStores } from '../stores.js';
import { makeFakeRecordDb, SharedRecordTable } from '../test-support/fake-db.js';
import {
  DEFAULT_RECORD_BASE_PATH,
  DEFAULT_RECORD_HANDLER_IDS,
  mountRecordCapability,
} from './mount.js';

const TENANT = 'tenant-aaaa';

function routeInit(table: SharedRecordTable, body: unknown, recordId = 'rec-1') {
  return {
    tenantId: TENANT,
    db: makeFakeRecordDb(table, TENANT),
    params: { record_id: recordId },
    body,
  } as never;
}

describe('mountRecordCapability', () => {
  it('returns the composable fragments: the store, ONE POST submit route, the handler map', () => {
    const mounted = mountRecordCapability({
      recordSubmittedSink: createInMemoryRecordSubmittedSink(),
    });
    expect(mounted.basePath).toBe(DEFAULT_RECORD_BASE_PATH);
    // The mount's stores equal the store-schema function (single source).
    expect(mounted.stores).toEqual(recordCapabilityStores());
    // Exactly ONE route: the authenticated POST submit (handler-kind — the standard bearer chain).
    expect(mounted.api).toEqual([
      {
        method: 'POST',
        path: '/records/{record_id}/submit',
        action: { kind: 'handler', handler: 'record_input_submit' },
      },
    ]);
    expect([...mounted.handlers.keys()]).toEqual([DEFAULT_RECORD_HANDLER_IDS.recordSubmit]);
    expect(mounted.handlers.get('record_input_submit')?.kind).toBe('route');
  });

  it('honors a basePath override in the mounted route', () => {
    const mounted = mountRecordCapability({
      recordSubmittedSink: createInMemoryRecordSubmittedSink(),
      basePath: '/intake/',
    });
    expect(mounted.api[0]?.path).toBe('/intake/{record_id}/submit');
  });

  it('the bound handler serves a submit end-to-end and maps a typed error to its status', async () => {
    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();
    const mounted = mountRecordCapability({ recordSubmittedSink: sink });
    const handler = mounted.handlers.get('record_input_submit')?.fn;
    if (!handler) throw new Error('handler missing');

    const okReturn = await handler(routeInit(table, { title: 'x' }));
    expect(okReturn).toEqual({ record_id: 'rec-1', event_id: `${TENANT}:rec-1`, deduped: false });
    expect(sink.deliveredCount()).toBe(1);

    const conflict = (await handler(routeInit(table, { title: 'DIFFERENT' }))) as ReturnType<
      typeof httpResponse
    >;
    expect(conflict).toMatchObject({ status: 409, body: { error: 'record_conflict' } });
  });

  it('maps a sink RecordEventRejectedError to the clean deliberate 403 (never a 500)', async () => {
    const table = new SharedRecordTable();
    const mounted = mountRecordCapability({
      recordSubmittedSink: {
        emit: async () => {
          throw new RecordEventRejectedError('cross_tenant', 'rejected fail-closed (test)');
        },
      },
    });
    const handler = mounted.handlers.get('record_input_submit')?.fn;
    if (!handler) throw new Error('handler missing');
    const res = (await handler(routeInit(table, { title: 'x' }))) as ReturnType<
      typeof httpResponse
    >;
    expect(res).toMatchObject({
      status: 403,
      body: { error: 'record_event_rejected' },
    });
    expect(JSON.stringify(res)).toContain('cross_tenant');
    // A GENUINE fault still surfaces (rethrow → the platform's 500), not a mapped 403.
    const faulty = mountRecordCapability({
      recordSubmittedSink: {
        emit: async () => {
          throw new Error('genuine fault');
        },
      },
    });
    const faultyHandler = faulty.handlers.get('record_input_submit')?.fn;
    await expect(faultyHandler?.(routeInit(new SharedRecordTable(), { t: 1 }))).rejects.toThrow(
      'genuine fault',
    );
  });

  it('threads a normalizer factory through the bound handler (built with the SERVER-DERIVED tenant): a submit stores the NORMALIZED value', async () => {
    const table = new SharedRecordTable();
    const sink = createInMemoryRecordSubmittedSink();
    const seenTenants: string[] = [];
    const factory: RecordNormalizerFactory = (tenantId) => {
      seenTenants.push(tenantId);
      return {
        agentId: 'field_normalizer',
        async normalize({ record }) {
          return { status: 'normalized', record: { ...record, normalized: true } };
        },
      };
    };
    const mounted = mountRecordCapability({ recordSubmittedSink: sink, recordNormalizer: factory });
    // The mounted SURFACE is unchanged by the normalizer (one POST route, one handler).
    expect(mounted.api).toHaveLength(1);
    const handler = mounted.handlers.get('record_input_submit')?.fn;
    if (!handler) throw new Error('handler missing');

    const ok = await handler(routeInit(table, { title: 'x' }));
    expect(ok).toMatchObject({ record_id: 'rec-1', deduped: false });
    // The factory was invoked with the SERVER-DERIVED tenant (init.tenantId).
    expect(seenTenants).toEqual([TENANT]);
    // The stored row + the emitted event carry the NORMALIZED value.
    expect(table.rows[0]?.payload).toEqual({ title: 'x', normalized: true });
    expect(sink.deliveredFor(`${TENANT}:rec-1`)?.record).toEqual({ title: 'x', normalized: true });
  });
});
