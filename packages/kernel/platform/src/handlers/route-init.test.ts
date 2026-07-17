/**
 * The TWO route-invocation postures of route-init.ts, each pinned focused + fail-the-fix
 * (the PM-mandated shared-surface pins; this file is the platform half, the api-auth interpreter
 * branch has its own DB-observable pin):
 *
 *  1. THE UNFLAGGED DEFAULT (every existing `{handler}` route): `invokeRouteHandler` opens EXACTLY
 *     ONE outer `tdb.transaction(...)` and builds the `RouteHandlerInit` from the TRANSACTIONAL
 *     handle — pinned via a fake TenantDb whose tx handle carries a DISTINCT tenantId marker, so a
 *     posture regression (init built from the base handle, or a second/zero tx) fails these arms.
 *  2. THE DETACHED (handler-managed) POSTURE (the conversation turn route):
 *     `invokeRouteHandlerDetached` opens ZERO engine transactions — the init is built from the BASE
 *     TenantDb, and the handler manages its own short transactions via `init.db.transaction(...)`,
 *     each of which delegates to the REAL `tdb.transaction` (a top-level tx — the store facade's
 *     existing tool-handler posture applied to a route handler).
 *
 *  Both postures must build the SAME init shape (the parity arms): the security response-brand strip
 *  on `init.body`, the spread-ABSENT (not undefined) semantics for blob/body, and the tenant-bound
 *  blobFactory call. A drift between the two builders would let the detached path silently lose a
 *  security guard — the parity arms fail on that.
 */
import type { TenantDb } from '@rayspec/db';
import { type BlobStore, HTTP_RESPONSE_BRAND, type RouteHandlerInit } from '@rayspec/handler-sdk';
import type { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { invokeRouteHandler, invokeRouteHandlerDetached } from './route-init.js';

/** A fake TenantDb observing `transaction()` calls; its tx handle carries a marked tenantId. */
function makeFakeTdb(tenantId: string): {
  tdb: TenantDb;
  txCalls: () => number;
} {
  let txCalls = 0;
  const makeHandle = (id: string): Record<string, unknown> => ({
    tenantId: id,
    async transaction<R>(fn: (tx: TenantDb) => Promise<R>): Promise<R> {
      txCalls += 1;
      // The tx handle is DISTINCT (marked) so a test can observe WHICH handle built the init.
      return fn(makeHandle(`TX:${id}`) as unknown as TenantDb);
    },
  });
  return { tdb: makeHandle(tenantId) as unknown as TenantDb, txCalls: () => txCalls };
}

const NO_TABLES: ReadonlyMap<string, PgTable> = new Map();

describe('invokeRouteHandler — the UNFLAGGED DEFAULT posture (exactly one engine tx)', () => {
  it('opens EXACTLY ONE outer tdb.transaction and builds the init from the TX handle', async () => {
    const { tdb, txCalls } = makeFakeTdb('t-default');
    let seen: RouteHandlerInit | undefined;
    const result = await invokeRouteHandler(
      async (init) => {
        seen = init;
        // The engine tx is already open when the handler runs.
        expect(txCalls()).toBe(1);
        return { ok: true };
      },
      tdb,
      NO_TABLES,
      { p: '1' },
    );
    expect(result).toEqual({ ok: true });
    expect(txCalls()).toBe(1);
    // The init was built from the TRANSACTIONAL handle (the GUC seam) — not the base handle.
    expect(seen?.tenantId).toBe('TX:t-default');
    expect(seen?.params).toEqual({ p: '1' });
  });

  it('strips the reserved response-envelope brand from init.body', async () => {
    const { tdb } = makeFakeTdb('t-brand');
    let seenBody: unknown;
    await invokeRouteHandler(
      async (init) => {
        seenBody = init.body;
        return null;
      },
      tdb,
      NO_TABLES,
      {},
      undefined,
      undefined,
      undefined,
      { [HTTP_RESPONSE_BRAND]: true, keep: 'me' },
    );
    expect(seenBody).toEqual({ keep: 'me' });
  });
});

describe('invokeRouteHandlerDetached — the handler-managed posture (ZERO engine tx)', () => {
  it('opens NO engine transaction; the init is built from the BASE handle', async () => {
    const { tdb, txCalls } = makeFakeTdb('t-detached');
    let seen: RouteHandlerInit | undefined;
    const result = await invokeRouteHandlerDetached(
      async (init) => {
        seen = init;
        // NO transaction is open when the handler starts (the intake-ordering law's precondition:
        // the handler owns its short txs; the model leg later runs with none held).
        expect(txCalls()).toBe(0);
        return { ok: 'detached' };
      },
      tdb,
      NO_TABLES,
      { p: '2' },
    );
    expect(result).toEqual({ ok: 'detached' });
    expect(txCalls()).toBe(0);
    expect(seen?.tenantId).toBe('t-detached');
    expect(seen?.params).toEqual({ p: '2' });
  });

  it('init.db.transaction(...) delegates to the REAL tdb.transaction (a handler-managed top-level tx)', async () => {
    const { tdb, txCalls } = makeFakeTdb('t-managed');
    await invokeRouteHandlerDetached(
      async (init) => {
        expect(txCalls()).toBe(0);
        const inner = await init.db.transaction(async (tx) => {
          // Inside the handler-managed tx: exactly one real tdb.transaction was opened, and the
          // inner facade is rebound to the TX handle (the store facade's delegation contract).
          expect(txCalls()).toBe(1);
          expect(typeof tx.select).toBe('function');
          return 'inner-done';
        });
        expect(inner).toBe('inner-done');
        // After the handler-managed tx resolves, no additional engine tx exists.
        expect(txCalls()).toBe(1);
        return null;
      },
      tdb,
      NO_TABLES,
      {},
    );
    expect(txCalls()).toBe(1);
  });

  it('PARITY: strips the response brand + keeps spread-absent semantics + tenant-bound blob', async () => {
    const { tdb } = makeFakeTdb('t-parity');
    let seen: RouteHandlerInit | undefined;
    const blobTenants: string[] = [];
    const fakeBlob = {} as BlobStore;
    await invokeRouteHandlerDetached(
      async (init) => {
        seen = init;
        return null;
      },
      tdb,
      NO_TABLES,
      {},
      (tenantId: string) => {
        blobTenants.push(tenantId);
        return fakeBlob;
      },
      undefined,
      undefined,
      { [HTTP_RESPONSE_BRAND]: true, keep: 'parity' },
    );
    // The security brand strip applies on the detached path too (shared init builder — no drift).
    expect(seen?.body).toEqual({ keep: 'parity' });
    // The blob handle is bound to the request's server-derived tenant (the base handle here).
    expect(blobTenants).toEqual(['t-parity']);
    expect(seen?.blob).toBe(fakeBlob);
    // Spread-ABSENT semantics: no mint/enqueue capability was wired ⇒ the keys are ABSENT.
    expect(seen && 'mintPlayToken' in seen).toBe(false);
    expect(seen && 'enqueue' in seen).toBe(false);
  });

  it('PARITY: an undefined body means init.body is ABSENT (not undefined)', async () => {
    const { tdb } = makeFakeTdb('t-absent');
    let seen: RouteHandlerInit | undefined;
    await invokeRouteHandlerDetached(
      async (init) => {
        seen = init;
        return null;
      },
      tdb,
      NO_TABLES,
      {},
    );
    expect(seen && 'body' in seen).toBe(false);
    expect(seen && 'blob' in seen).toBe(false);
  });
});
