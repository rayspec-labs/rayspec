/**
 * What this pack's services actually did, recorded IN PROCESS so a test can read it back.
 *
 * A service's whole point is that the deployment starts it and stops it: the interesting facts are
 * ORDER (which booted first, which shut down first) and WHAT THE CONTEXT CARRIED (was a claimed
 * section there, was a journal writer there, was the dispatch capability there). Neither is visible in
 * the database, and inferring either from a side effect would be measuring something else.
 *
 * This module is the record. A test loads the SAME compiled module the deployment loaded — the module
 * registry is keyed by resolved path, so importing `dist/services/observed.js` after a boot reads the
 * very instance the services wrote to — and asserts on it. Nothing here is read by the pack itself,
 * and nothing here is state a real pack would keep: it exists so the seam is measurable.
 */

/** One thing a service did, in the order it happened. */
export const events: string[] = [];

/** What a service found on the context it was booted with. */
export interface ObservedContext {
  /** The claimed-section keys the context carried (this pack's own, and only its own). */
  readonly sectionKeys: string[];
  /** The `retentionDays` this pack's own `auditing` section declared, when the document wrote one. */
  readonly retentionDays?: number;
  /**
   * `spec.metadata.name` off the context's document — one fact read back off `ctx.spec`, so that a
   * context handed an EMPTY document instead of the deployment's merged one is a test failure rather
   * than an unmeasured difference. Absent if the context carried no document at all.
   */
  readonly specName?: string;
  /**
   * The environment the context carried, read at ONE agreed key the suite sets before it boots. Same
   * purpose as `specName`: `ctx.env` is part of the contract, so something has to read it.
   */
  readonly envMarker?: string;
  /** Whether the deployment had a run-journal writer to give (it binds a tenant, or it does not). */
  readonly journal: boolean;
  /** Whether the deployment had the dispatch capability to give (a durable worker, or none). */
  readonly dispatch: boolean;
  /** The row count this service read back through the database door at boot. */
  readonly ledgerRows?: number;
  /**
   * How many rows the service's TRANSACTIONAL write committed at boot — the pair that is only ever
   * right together. Zero on a deployment that had registered no tenant to write under.
   */
  readonly ledgerPairRows?: number;
  /**
   * The message of the error the service threw out of a transaction it ABANDONED mid-write, as its own
   * catch saw it. The rollback itself is read off the database; this is how the suite sees that the
   * error reached the pack unchanged rather than as something the platform rewrote.
   */
  readonly abandonedError?: string;
}

/** The one environment key this pack's services read, so a suite can prove `ctx.env` arrived. */
export const ENV_MARKER_KEY = 'RAYSPEC_FIXTURE_PACK_MARKER';

/** `spec.metadata.name` off a document a pack must treat as open data, not as a typed spec. */
export function specName(spec: Readonly<Record<string, unknown>>): string | undefined {
  const metadata = spec.metadata as { name?: unknown } | undefined;
  return typeof metadata?.name === 'string' ? metadata.name : undefined;
}

/** The context each service was booted with, keyed by service name. */
export const contexts = new Map<string, ObservedContext>();

/** How many times each service's timer has fired. */
export const ticks = new Map<string, number>();

/** Record one ordered event. */
export function record(event: string): void {
  events.push(event);
}

/** Count one timer tick for `service`. */
export function tick(service: string): void {
  ticks.set(service, (ticks.get(service) ?? 0) + 1);
}

/** Forget everything — so a test can measure one boot rather than every boot in the process. */
export function reset(): void {
  events.length = 0;
  contexts.clear();
  ticks.clear();
}
