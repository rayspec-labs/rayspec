/**
 * The event-bus WAKE — one process-local listener on the bus channel, fanned out to the subscribers
 * this process is serving.
 *
 * WHAT IT IS FOR. The durable rows are the truth and the periodic read is what guarantees delivery;
 * this exists purely to make delivery IMMEDIATE instead of "within one poll interval". Nothing about
 * correctness rests on it: a wake that is missed, dropped, delayed or never wired at all costs a
 * subscriber latency and nothing else. That is why a failure to establish the LISTEN is logged and
 * survived rather than thrown — a deployment whose stream is one poll interval slow is working; a
 * deployment that refused to boot over it is not.
 *
 * ONE LISTENER, ONE CHANNEL, MANY TENANTS. The bus notifies a single channel and carries the tenant
 * in the payload, so this holds ONE LISTEN for the whole process and dispatches in memory by tenant
 * id. A per-tenant CHANNEL would mean issuing a LISTEN per tenant served and re-issuing as tenants
 * appear — the shape the channel naming was chosen to avoid. (postgres-js gives the listener its own
 * dedicated connection and re-issues the LISTEN after a reconnect, so this borrows nothing from the
 * request pool and does not go permanently deaf on a blip. The gap DURING a reconnect is exactly the
 * missed-wake case the poll covers.)
 *
 * THE WAKE CARRIES NO PAYLOAD — only (tenant, high-water seq). A subscriber uses the seq to decide
 * whether the wake can advance it at all, then reads the durable rows itself, tenant-scoped, through
 * the chokepoint. Putting the event in the wake would create a second delivery path with different
 * ordering and no retention story, and a subscriber that trusted it would be reading something no
 * tenant predicate ever touched.
 */

import type { Db } from '@rayspec/db';
import { listenTenantEvents, type TenantEventListenHandle } from '@rayspec/db';
import type { TenantEventWake } from '../app-context.js';

/** The wake plus the shutdown handle the composition root owns. */
export interface TenantEventWakeHub extends TenantEventWake {
  /** Stop the process LISTEN. Safe to call on a boot whose LISTEN never came up. */
  close(): Promise<void>;
}

/**
 * Build the process's wake hub and start its LISTEN.
 *
 * Returns SYNCHRONOUSLY, before the LISTEN is established: a subscriber that connects in that window
 * registers into the in-memory map and is served by its poll until the LISTEN comes up, which is the
 * same posture as a missed wake. Making the composition root await this instead would put a database
 * round trip in front of the app being constructed for a capability that is, by design, optional.
 */
export function makeTenantEventWake(
  db: Db,
  opts: { readonly logError?: (line: string, detail?: unknown) => void } = {},
): TenantEventWakeHub {
  const byTenant = new Map<string, Set<(lastSeq: number) => void>>();
  const log = opts.logError ?? ((line: string, detail?: unknown) => console.error(line, detail));
  let handle: TenantEventListenHandle | undefined;
  let closed = false;

  const listening = listenTenantEvents(db, (notice) => {
    const listeners = byTenant.get(notice.tenantId);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(notice.lastSeq);
      } catch {
        // One subscriber's failure must not stop the fan-out to the others, and it must never reach
        // the driver's connection callback (a throw there takes the whole LISTEN down).
      }
    }
  })
    .then((h) => {
      handle = h;
      // A close() that raced the LISTEN coming up must still end it.
      if (closed) void h.unlisten().catch(() => {});
    })
    .catch((err: unknown) => {
      log(
        '[api-auth] the tenant event-bus LISTEN could not be established — subscriptions fall back ' +
          'to their periodic read (delivery is delayed, never lost)',
        err,
      );
    });

  return {
    subscribe(tenantId, onWake) {
      let listeners = byTenant.get(tenantId);
      if (!listeners) {
        listeners = new Set();
        byTenant.set(tenantId, listeners);
      }
      listeners.add(onWake);
      return () => {
        const current = byTenant.get(tenantId);
        if (!current) return;
        current.delete(onWake);
        // Drop the tenant's bucket when its last subscriber leaves, so a long-lived process does not
        // accumulate one empty Set per tenant that has ever connected.
        if (current.size === 0) byTenant.delete(tenantId);
      };
    },
    async close() {
      closed = true;
      byTenant.clear();
      await listening;
      await handle?.unlisten().catch(() => {});
    },
  };
}
