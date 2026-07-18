/**
 * The live-executor-identity readiness probe (`GET /recovery-scope`) — deterministic, network-free
 * teeth for its FAIL-CLOSED contract. The probe reports the LIVE durable executor identity
 * ({ executorId, applicationVersion }); it is PUBLIC (no auth, exactly like /health) and product-free.
 *
 * These tests exercise the SHARED route registrar `registerRecoveryScopeRoute` (the same function the
 * composition root wires in production) plus the pure `recoveryScopeResponse`, with an INJECTED
 * identity accessor. They assert the whole invariant fail-the-fix, not the shape:
 *
 *   (b) FAIL-CLOSED arm — an engine that has NOT launched reports an empty `applicationVersion` (that
 *       is the real value DBOS's `applicationVersion` holds until launch), and NO wired executor is
 *       represented by an undefined accessor. Both must yield 503, so a consumer that requires "both
 *       fields present + non-empty string, else fail-closed" fails closed against them (a status-only
 *       reader also fails closed on the 503).
 *   (c) SHAPE — a ready 200 body is EXACTLY { executorId, applicationVersion } (camelCase), both
 *       non-empty strings, no extra field (no secret / connection / env leak).
 *
 * The launched-engine 200 arm end-to-end (a real DBOS boot) lives in durable-worker-boot.db.test.ts;
 * the source-of-truth for the empty pre-launch `applicationVersion` is pinned in @rayspec/durable-dbos's
 * executor-identity.test.ts.
 */
import type { DurableExecutorIdentity } from '@rayspec/platform';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  RECOVERY_SCOPE_PATH,
  recoveryScopeResponse,
  registerRecoveryScopeRoute,
} from './composition-root.js';

/** The consumer contract the probe serves: READY iff HTTP 200 AND both fields are non-empty strings. */
function readerSeesReady(status: number, body: unknown): boolean {
  if (status !== 200) return false;
  const b = body as { executorId?: unknown; applicationVersion?: unknown };
  return (
    typeof b.executorId === 'string' &&
    b.executorId.length > 0 &&
    typeof b.applicationVersion === 'string' &&
    b.applicationVersion.length > 0
  );
}

/** Register the probe on a bare Hono app with an injected identity accessor and GET it. */
async function probe(
  identity: (() => DurableExecutorIdentity) | undefined,
): Promise<{ status: number; body: unknown }> {
  const app = new Hono();
  registerRecoveryScopeRoute(app, identity);
  const res = await app.request(RECOVERY_SCOPE_PATH);
  return { status: res.status, body: await res.json() };
}

const READY: DurableExecutorIdentity = { executorId: 'local', applicationVersion: 'v-abc123' };
// The EXACT pre-launch DBOS value: executorID defaults to 'local', applicationVersion is '' until launch.
const NOT_LAUNCHED: DurableExecutorIdentity = { executorId: 'local', applicationVersion: '' };

describe('recoveryScopeResponse — the pure fail-closed decision', () => {
  it('ready ONLY when both fields are present + non-empty', () => {
    expect(recoveryScopeResponse(() => READY).ready).toBe(true);
    // The not-launched arm: an empty applicationVersion is NOT ready.
    expect(recoveryScopeResponse(() => NOT_LAUNCHED).ready).toBe(false);
    // An empty executorId is likewise NOT ready.
    expect(
      recoveryScopeResponse(() => ({ executorId: '', applicationVersion: 'v-abc123' })).ready,
    ).toBe(false);
    // Both empty → not ready.
    expect(recoveryScopeResponse(() => ({ executorId: '', applicationVersion: '' })).ready).toBe(
      false,
    );
    // No wired executor at all → not ready.
    expect(recoveryScopeResponse(undefined).ready).toBe(false);
  });

  it('body is EXACTLY the two identity fields (no extra field can leak)', () => {
    const out = recoveryScopeResponse(() => READY);
    expect(out.body).toEqual({ executorId: 'local', applicationVersion: 'v-abc123' });
    expect(Object.keys(out.body).sort()).toEqual(['applicationVersion', 'executorId']);
    // An accessor that returns extra keys cannot smuggle them through — the body is re-projected.
    const leaky = recoveryScopeResponse(
      () =>
        ({
          executorId: 'local',
          applicationVersion: 'v-abc123',
          secret: 'MUST-NOT-LEAK',
        }) as unknown as DurableExecutorIdentity,
    );
    expect(Object.keys(leaky.body).sort()).toEqual(['applicationVersion', 'executorId']);
    expect((leaky.body as Record<string, unknown>).secret).toBeUndefined();
  });
});

describe('GET /recovery-scope — the wired route (registerRecoveryScopeRoute)', () => {
  it('(c) launched identity → 200 with EXACTLY { executorId, applicationVersion } (camelCase)', async () => {
    const { status, body } = await probe(() => READY);
    expect(status).toBe(200);
    expect(body).toEqual({ executorId: 'local', applicationVersion: 'v-abc123' });
    expect(Object.keys(body as object).sort()).toEqual(['applicationVersion', 'executorId']);
    // A consumer requiring both-non-empty reads it as READY.
    expect(readerSeesReady(status, body)).toBe(true);
  });

  it('(b) not-yet-launched engine (empty applicationVersion) → 503, reader fails closed', async () => {
    const { status, body } = await probe(() => NOT_LAUNCHED);
    expect(status).toBe(503);
    // A both-non-empty-required reader MUST NOT read this as ready.
    expect(readerSeesReady(status, body)).toBe(false);
  });

  it('(b) no durable worker wired (undefined accessor) → 503, reader fails closed', async () => {
    const { status, body } = await probe(undefined);
    expect(status).toBe(503);
    expect(readerSeesReady(status, body)).toBe(false);
  });
});
