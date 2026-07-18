/**
 * The "fire a manual trigger" control route — the consumer-usable path for EXPLICITLY firing a
 * declared `kind:'manual'` trigger (a named on-demand job) through the durable off-request worker.
 *
 * Mounted on the SAME createAuthApp middleware chain as every other route
 * (requestId → securityHeaders → authenticate → resolveTenant → requirePermission), so the tenant is
 * SERVER-DERIVED (never client-supplied) and the fire is strictly tenant-scoped.
 *
 * WHY A CONTROL ROUTE (not just the in-process seam): a cron trigger fires itself on its crontab, but a
 * `manual` trigger fires ONLY on an explicit call. An external consumer (a real backend) needs an
 * auth-guarded HTTP path to drive it — the in-process `fireCronNow`/scheduler seam is reachable only by
 * an embedder. This route is that path. It fires through the SAME durable reserve→dispatch machinery a
 * cron fire uses (exactly-once per firing key), so a double fire within one firing instant dedups to
 * ONE dispatch. RESERVED kinds (webhook/event) and cron are NOT fireable here — the injected firer
 * restricts to `kind:'manual'` fail-closed.
 *
 * Endpoint:
 *  - POST /v1/triggers/{name}/fire — fire the named manual trigger. `store:write` (the SENSITIVE
 *    product-write permission — a fire dispatches a declared action that writes the tenant's product
 *    stores; live-membership rechecked for JWT principals, api-key-grantable with scope). Returns 202 +
 *    `{ name, fired }` (`fired:false` = a deduped no-op for this firing key). An unknown / non-manual
 *    trigger, or a foreign tenant → uniform 404 (no existence leak). No wired firer → clean 501.
 */

import type { OpenAPIHono } from '@hono/zod-openapi';
import { ApiError } from '@rayspec/auth-core';
import type { AppDeps, AppEnv } from '../app-context.js';
import { requireAuth, requirePermission, resolveTenant } from '../http/middleware.js';

export function registerTriggerRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  // POST /v1/triggers/:name/fire — fire the named MANUAL trigger on demand.
  app.post(
    '/v1/triggers/:name/fire',
    requireAuth(),
    resolveTenant(deps),
    requirePermission(deps, 'store:write'),
    async (c) => {
      const tenantId = c.get('tenantId');
      if (!tenantId) throw new ApiError('NOT_FOUND', 'Not found.');
      const name = c.req.param('name');
      if (!name) throw new ApiError('NOT_FOUND', 'Not found.');

      // FAIL-CLOSED: a firer must be wired (like async runs need a durable worker). Never a silent
      // no-op that would 202 without firing anything. Absent ⇒ this deployment declares no manual
      // trigger / wires no durable worker.
      if (!deps.manualTriggerFirer) {
        throw new ApiError(
          'NOT_IMPLEMENTED',
          'Manual trigger firing requires a configured durable worker and a declared manual trigger. ' +
            'No manual-trigger firer is wired on this deployment.',
        );
      }

      // QUOTA (cost-DoS bound): a fire dispatches a declared action each call (distinct firing instants
      // are NOT deduped), so an unthrottled caller could re-fire without bound. Throttle the fires of
      // one (tenant, trigger) via the SAME limiter, keyed by the server-derived tenant + the trigger
      // name — BEFORE the firer runs, so an over-quota call dispatches nothing.
      const { allowed, retryAfterMs } = deps.rateLimiter.check(
        'trigger-fire',
        `${tenantId}:${name}`,
      );
      if (!allowed) throw new ApiError('RATE_LIMITED', 'Too many requests.', { retryAfterMs });

      // Tenant-scoped by construction: the firer reconciles the SERVER-DERIVED tenant against the
      // deployment tenant AND restricts to kind:'manual'. A foreign tenant / unknown / non-manual name
      // → notFound → uniform 404 (no existence leak).
      const result = await deps.manualTriggerFirer.fireManual({ tenantId, name });
      if (result.notFound) throw new ApiError('NOT_FOUND', 'Not found.');

      // IMMUTABLE AUDIT (out-of-band, best-effort): a fire dispatches durable work, so record the actor,
      // the server-derived tenant, the trigger, and whether THIS call dispatched (fired) or was a
      // deduped no-op. Emitted ONLY on the successful path (never on 404/501/429 — those returned
      // above). The api-key/user actor tag mirrors the reprocess/store-route convention.
      const principal = c.get('principal');
      const actor =
        principal?.kind === 'user' && principal.userId
          ? `user:${principal.userId}`
          : principal?.apiKeyId
            ? `key:${principal.apiKeyId}`
            : 'unknown';
      await deps.auditStore.appendTriggerFired({
        tenantId,
        actorUserId: principal?.userId ?? null,
        requestId: c.get('requestId'),
        meta: { triggerName: name, fired: result.fired, actor },
      });

      return c.json({ name, fired: result.fired }, 202);
    },
  );
}
