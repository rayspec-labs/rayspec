/**
 * The OPERATIONAL "reprocess a session" route — a recovery affordance so re-running a session's
 * declared finalized-session workflow (e.g. to re-extract after a fix, or to recover a stuck session)
 * needs NO manual DB surgery.
 *
 * Mounted on the SAME createAuthApp middleware chain as every other route
 * (requestId → securityHeaders → authenticate → resolveTenant → requirePermission), so the tenant is
 * SERVER-DERIVED (never client-supplied) and the reprocess is strictly tenant-scoped.
 *
 * WHY A DISTINCT KEY: re-emitting a session's finalized event through the NORMAL dispatch path DEDUPS —
 * the default per-session idempotency key resolves to the SAME durable run id, so it returns the prior
 * run instead of re-processing. So a reprocess drives a FRESH durable run under a DISTINCT idempotency
 * key (owned by the injected `SessionReprocessor`), which re-reads the session's CURRENT authoritative
 * store state. The route itself is PRODUCT-AGNOSTIC: the concrete reprocessor (wired by the composition
 * root) owns the tenant-scoped session existence check + the finalized-event construction.
 *
 * Endpoint:
 *  - POST /v1/sessions/{sessionId}/reprocess — enqueue a fresh reprocess run. `store:write` (the
 *    SENSITIVE product-write permission — this re-drives writes into the tenant's product stores;
 *    live-membership rechecked for JWT principals, api-key-grantable with scope). Returns 202 + the
 *    enqueued run id(s). A foreign/absent session → uniform 404 (no existence leak). No wired
 *    reprocessor → clean fail-closed 501.
 */

import type { OpenAPIHono } from '@hono/zod-openapi';
import { ApiError } from '@rayspec/auth-core';
import { z } from 'zod';
import type { AppDeps, AppEnv } from '../app-context.js';
import { readBoundedJson } from '../http/bounded-body.js';
import { requireAuth, requirePermission, resolveTenant } from '../http/middleware.js';

/**
 * The (optional) request body: nothing is trusted beyond the path `sessionId`. `reason` is advisory
 * operator context only (never drives logic). Strict so an unknown field is rejected (no silent
 * passthrough of attacker-controlled fields). An empty body is valid.
 */
const ReprocessRequest = z
  .object({
    reason: z.string().max(500).optional(),
  })
  .strict();

export function registerReprocessRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  // POST /v1/sessions/:sessionId/reprocess — re-drive the session's declared finalized workflow.
  app.post(
    '/v1/sessions/:sessionId/reprocess',
    requireAuth(),
    resolveTenant(deps),
    requirePermission(deps, 'store:write'),
    async (c) => {
      const tenantId = c.get('tenantId');
      if (!tenantId) throw new ApiError('NOT_FOUND', 'Not found.');
      const sessionId = c.req.param('sessionId');
      if (!sessionId) throw new ApiError('NOT_FOUND', 'Not found.');

      // FAIL-CLOSED: a reprocessor must be wired (like async runs need a durable worker). Never a
      // silent no-op that would 202 without enqueuing anything.
      if (!deps.sessionReprocessor) {
        throw new ApiError(
          'NOT_IMPLEMENTED',
          'Session reprocess requires a configured durable workflow reprocessor. ' +
            'No reprocessor is wired on this deployment.',
        );
      }

      // Drain the (optional) body under the configured byte cap — a 413 for an over-cap body BEFORE
      // any reprocess side effect; an absent/invalid body is the valid empty request (`{}`).
      const body = ReprocessRequest.parse(await readBoundedJson(c, deps.maxJsonBodyBytes, {}));

      // Tenant-scoped by construction: the reprocessor re-reads the session's authoritative state
      // scoped to THIS server-derived tenant. A foreign/absent session → found:false → uniform 404.
      const result = await deps.sessionReprocessor.reprocessSession({
        tenantId,
        sessionId,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      });
      if (!result.found) throw new ApiError('NOT_FOUND', 'Not found.');

      // A FOUND session must always match a registered finalized-session trigger, so zero enqueue for a
      // found session is an INTERNAL FAULT (a misconfigured/missing workflow trigger), NEVER a success —
      // fail LOUD (500) rather than return a misleading 202 with nothing enqueued.
      if (result.enqueued.length === 0) {
        throw new ApiError(
          'INTERNAL',
          'Session reprocess enqueued no runs for an existing session (misconfigured workflow trigger).',
        );
      }

      return c.json({ sessionId, enqueued: result.enqueued }, 202);
    },
  );
}
