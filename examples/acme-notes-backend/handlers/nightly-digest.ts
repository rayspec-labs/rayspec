/**
 * Escape-hatch trigger handler for the `nightly-digest` cron trigger (neutral acme-notes backend).
 *
 * Imports `@rayspec/handler-sdk` type-only; this dir is in no tsconfig so tsc never compiles it,
 * and Biome does not resolve imports.
 *
 * Trigger/route handlers run inside `TenantDb.transaction()` (the GUC seam), so this handler reads +
 * writes atomically under the tenant predicate.
 */
import type { TriggerHandler, TriggerHandlerInit } from '@rayspec/handler-sdk';

/**
 * Mark yesterday's completed notebooks as digested. Runs in a tenant-scoped transaction; the
 * TenantDb auto-injects the tenant predicate on every statement.
 */
export const nightlyDigest: TriggerHandler = async (init: TriggerHandlerInit) => {
  await init.db.transaction(async (tx) => {
    const pending = await tx.select('notebooks', { completed: true });
    for (const notebook of pending) {
      await tx.update('entries', { notebook_id: notebook.id }, { summary: 'digested' });
    }
  });
};
