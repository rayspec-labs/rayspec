/**
 * The execution-time authorization check for durable agent runs.
 *
 * A run enqueued through the API was authorized when it was enqueued; the job then waits on a queue
 * for as long as the worker is busy. This is what the worker asks when the job is about to execute:
 * may the identity the server recorded on the job (`RunJob.requestedBy`) still run an agent in the
 * job's tenant? It answers from the same live state the request chain reads — the membership row for
 * a member, the key row for an API key — so a member removed, demoted below `agent:run`, or a key
 * revoked or expired while the job waited, does not have the run completed on their behalf.
 *
 * `system` (a trigger or a schedule) is the platform's own work and passes. A job without a recorded
 * identity was enqueued before jobs carried one and passes too, so an upgrade does not strand the
 * jobs already on a queue; every job enqueued from now on records one.
 */
import { authorize, roleGrants } from '@rayspec/auth-core';
import type { DurableRunAuthorizer, RunJob } from '@rayspec/platform';
import type { ApiKeyStore } from '../stores/api-key-store.js';
import type { IdentityStore } from '../stores/identity-store.js';

/** The two lookups the check needs, as the composition root already holds them. */
export interface RunAuthorizerStores {
  readonly identityStore: Pick<IdentityStore, 'liveMembership'>;
  readonly apiKeyStore: Pick<ApiKeyStore, 'findById'>;
  /** The clock an expiry is compared against. Default: now. */
  readonly now?: () => Date;
}

/** Build the check the durable worker runs before it executes an agent run. */
export function makeRunAuthorizer(stores: RunAuthorizerStores): DurableRunAuthorizer {
  const now = stores.now ?? (() => new Date());
  return async (job: RunJob): Promise<boolean> => {
    const who = job.requestedBy;
    if (who === undefined || who.kind === 'system') return true;
    if (who.kind === 'user') {
      const live = await stores.identityStore.liveMembership(who.userId, job.tenantId);
      return live !== undefined && roleGrants(live.role, 'agent:run');
    }
    if (who.kind === 'apikey') {
      const key = await stores.apiKeyStore.findById(job.tenantId, who.apiKeyId);
      if (key === undefined || key.revokedAt !== null) return false;
      if (key.expiresAt !== null && key.expiresAt.getTime() <= now().getTime()) return false;
      return authorize({ scopes: key.scopes }, 'agent:run', { isApiKey: true });
    }
    // An identity kind this build does not know: refuse rather than guess.
    return false;
  };
}
