/**
 * The `services` contribution kind — the one kind the platform BOOTS rather than calls.
 *
 * Every other contribution a pack makes is REACTIVE: a route is served, a tool is invoked, a trigger
 * fires. A pack that has to reconcile state at boot, drain a queue or schedule follow-up work has no
 * such door, and the only way to wire one in was a bespoke option on the composition root — the exact
 * coupling extension packs exist to avoid. A service is that door: a module the pack declares, the
 * platform starts, and the platform stops.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHERE IT SITS IN THE BOOT, AND WHY EXACTLY THERE.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * AFTER the platform migration chain, the pack chains and the deployed document's own validation —
 * because a service reads and writes the tables those steps create and is configured by the document
 * that step validated — and BEFORE the listener accepts traffic, because a service that reconciles
 * state at boot has to have finished before the first request can observe half-reconciled state. The
 * composition root boots them inside `assembleServer`, which every entrypoint awaits before it creates
 * a listener, so "before traffic" is a property of the call graph rather than a promise.
 *
 * SHUTDOWN IS THE EXACT REVERSE. A service booted later may depend on one booted earlier (the second
 * one's queue, the first one's connection), so stopping them in boot order would pull the ground out
 * from under the ones still running. `pack-services.test.ts` asserts both directions against ONE
 * shared log, so a reversal that is not a reversal cannot pass.
 *
 * A FAILING BOOT FAILS THE BOOT, NAMING THE PACK. A service that cannot start is a pack that is not
 * working, and a deployment that serves traffic anyway is one whose operator learns about it from a
 * customer. The services that DID boot are shut down again, in reverse, before the failure is raised —
 * a refused boot must not leave a timer or a connection running behind it.
 */
import type { HandlerJournal } from '@rayspec/handler-sdk';
import type { TurnDispatch } from '../turn-dispatch.js';

/**
 * The DATABASE door a service reaches its own tables through — the parameterized query executor, the
 * same shape the deploy target's own `query` seam has.
 *
 * WHY THIS AND NOT THE GENERATED STORE HANDLES: what a service maintains is the PLATFORM state its
 * pack owns — the migration chain it declared, with its hand-shaped indexes and its foreign keys —
 * and those tables are not generated business stores, so no generated handle addresses them. The
 * posture is the pack's existing one, stated rather than widened: a pack already ships arbitrary DDL
 * for exactly these tables through its own chain, and it runs IN OUR PROCESS as a TRUSTED, NOT
 * SANDBOXED author (see the manifest contract's posture note). This adds a door to state the pack
 * already owns; it does not change who is trusted.
 */
export interface PackServiceDatabase {
  /**
   * Run one parameterized statement and read its rows back. A TRANSACTION-CONTROL statement (`BEGIN`,
   * `COMMIT`, `ROLLBACK`, `SAVEPOINT`, …) is REFUSED here before it reaches the server: this handle is
   * pooled, so the connection such a statement lands on would go back to the pool still inside a
   * transaction nothing ever commits.
   */
  query(sql: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
  /**
   * Run `fn` inside ONE transaction, on a connection PINNED for the callback's duration — so a lock
   * taken inside it is still held when the next statement runs, and two writes land together or not at
   * all. `tx` is a `PackServiceDatabase` again: the same parameterized `query`, and nothing else.
   *
   * WHY IT CANNOT BE THE POOLED EXECUTOR ABOVE: on a pooled handle two calls are not promised the same
   * connection, so a bare `BEGIN` cannot open a transaction the next call is in and a
   * `SELECT … FOR UPDATE` is released the moment the call returns. The deployment builds this half over
   * a RESERVED connection (see the composition root's `makePackServiceDatabase`), which is also why it
   * is a RESOURCE DECISION: the pin is reserved out of the pool the deployment SERVES REQUESTS on — the
   * HTTP/API pool, four connections by default, not the durable worker's separate one — and is not
   * returned until `fn` returns.
   *
   * A callback that throws ROLLS BACK and its error propagates unchanged. A statement that FAILS inside
   * `fn` aborts the whole call even when the pack catches it: the driver latches the first statement
   * error on the pinned connection and re-raises it once the callback resolves. NESTING IS REFUSED with
   * a typed error rather than left to the driver, through `tx` AND through the same door re-entered
   * from inside the callback — the first could only be a savepoint, whose rollback would leave the
   * outer transaction alive; the second would be an independent transaction on a second pooled
   * connection, committing under a rolled-back outer one. NO WIDER THAN `query`: the transactional
   * handle carries exactly the members the pooled one carries, so opening a transaction reaches no
   * further than a single statement already reaches. Neither half is a tenant filter — a pack's SQL is
   * run as written, and the tenant a pack attributes rows to comes from the deployment.
   */
  transaction<T>(fn: (tx: PackServiceDatabase) => Promise<T>): Promise<T>;
}

/**
 * The JOURNAL door — the run journal, which is the platform's single record of work done, so a
 * service's own work is recorded where every other kind of work is rather than in a log line.
 *
 * BOTH VERBS, on one handle. `record` appends; the READ half is inherited from `HandlerJournal`
 * rather than re-declared, so the page, the cursor and the bound a service reads through are the
 * SAME ones a route reads through — one shape with one implementation, instead of two that agree
 * until somebody edits one. The read half is here because a service is the surface that WRITES
 * steps: a reader reachable only from a route would leave the writing surface naming a core table in
 * a SQL string, which is the dependency this door exists to remove.
 *
 * TENANT-BOUND BY CONSTRUCTION, exactly like `TurnDispatch`: there is no `tenantId` field on either
 * verb, because a service has no request to derive one from and the composition root binds the
 * deployment tenant when it builds this handle — the same `forTenant` chokepoint handle both halves
 * are built over. ABSENT when the deployment bound no tenant, and absent as a WHOLE: an
 * unattributable write and an unscoped read fail closed together, so a service that wants either
 * fail-closes loudly on `undefined`.
 */
export interface PackServiceJournal extends HandlerJournal {
  /** Append ONE journal step for work this service performed. */
  record(step: PackServiceJournalStep): Promise<void>;
}

/** One step a service records. `input` is HASHED by the platform — the raw value is never stored. */
export interface PackServiceJournalStep {
  /** The run this step belongs to — a service's own correlation id for the unit of work. */
  readonly runId: string;
  /** Which kind of step this is, in the journal's own closed vocabulary. */
  readonly type: 'llm' | 'tool' | 'store';
  /** The replay key: identical `(runId, idempotencyKey)` is one step, recorded once. */
  readonly idempotencyKey: string;
  /** The step's input — hashed into `input_hash` by the platform, never stored verbatim. */
  readonly input: unknown;
  /** The step's output as recorded. Opaque data — its shape is the step's own concern. */
  readonly output: unknown;
  /** Whether the step succeeded. A failed step is journaled, never dropped. */
  readonly status: 'ok' | 'error';
  /** Wall-clock duration of the step in milliseconds (0 when the service does not measure one). */
  readonly latencyMs?: number;
}

/**
 * What a service's `boot` receives. Everything a pack's own thread of control needs, and nothing that
 * would let it reach past its own pack: the database door above, the deployed document as the boot
 * validated it, the top-level sections THIS pack claims (as the pack's own validator returned them —
 * never another pack's), the journal writer, the environment, and the one sanctioned dispatch
 * capability.
 *
 * `journal` and `dispatch` are OPTIONAL for the same reason `init.blob` and `init.enqueue` are: a
 * deployment that bound no tenant or wired no durable worker has none to give, and an ABSENT key is
 * what makes a service that needs one fail-closed loudly instead of silently doing nothing.
 */
export interface PackServiceContext {
  /** The id the deployment's `extensions[]` entry gave this pack — what its own messages name it by. */
  readonly packId: string;
  /** The database door for the platform tables this pack owns. */
  readonly db: PackServiceDatabase;
  /** The deployed document as the boot validated it (deployment sections ⊕ every pack's fragments). */
  readonly spec: Readonly<Record<string, unknown>>;
  /** The top-level sections THIS pack claims, keyed by key, as this pack's own validator returned them. */
  readonly sections: Readonly<Record<string, unknown>>;
  /** The tenant-bound run-journal writer (absent when the deployment bound no tenant). */
  readonly journal?: PackServiceJournal;
  /** The process environment, read-only. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The one sanctioned way to schedule a durable agent turn (absent when no durable worker is wired). */
  readonly dispatch?: TurnDispatch;
}

/**
 * What a service MODULE default-exports. `name` is what the boot log and every refusal call this
 * service; `boot` runs it; `shutdown` stops it. Both may be synchronous — a service whose whole job is
 * to arm a timer has nothing to await.
 */
export interface PackServiceModule {
  /** This service's own name — used in the boot log and in every message that names it. */
  readonly name: string;
  /** Start the service. Throwing FAILS the deployment's boot, naming this pack and this service. */
  boot(ctx: PackServiceContext): Promise<void> | void;
  /** Stop the service. Called in the exact REVERSE of boot order when the deployment closes. */
  shutdown(): Promise<void> | void;
}

/**
 * One resolved service, as `loadExtensions` hands it over: the module's own exported members plus the
 * pack that declared it and the pack-relative path it was declared at (both only ever used to name it).
 */
export interface LoadedPackService extends PackServiceModule {
  /** The id of the pack whose manifest declared this service. */
  readonly packId: string;
  /** The pack-relative module path the manifest declared (the authored path, for messages). */
  readonly module: string;
}

/** A service that could not be started. Its own class so the boot can report it as what it is. */
export class PackServiceError extends Error {
  /** The pack whose service failed. */
  readonly packId: string;
  constructor(message: string, packId: string) {
    super(message);
    this.name = 'PackServiceError';
    this.packId = packId;
  }
}

/** The running services, and the one way to stop them. */
export interface PackServicesHandle {
  /** `<packId>/<name>` for every service that booted, in boot order. */
  readonly booted: readonly string[];
  /** Stop every booted service in the exact REVERSE of boot order. */
  shutdown(): Promise<void>;
}

/**
 * True iff `value` is a real service module — the structural check the loader makes before it accepts
 * a module as one. Fail-closed by construction: a module missing any of the three members is not a
 * service, and saying so at LOAD is what keeps the failure at the deployment's edge rather than at the
 * first tick of a timer that was never armed.
 */
export function isPackServiceModule(value: unknown): value is PackServiceModule {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { name?: unknown; boot?: unknown; shutdown?: unknown };
  return (
    typeof v.name === 'string' && typeof v.boot === 'function' && typeof v.shutdown === 'function'
  );
}

/**
 * Boot every resolved service, in the order the deployment's packs declared them, and hand back the
 * handle that stops them again in the exact reverse.
 *
 * `contextFor` is called once PER PACK-SERVICE, with the owning pack's id, so each service is
 * configured by its own pack's claimed sections rather than by the union of everyone's.
 *
 * A boot that throws unwinds: everything already booted is shut down in reverse, and the failure is
 * re-raised as a `PackServiceError` naming the pack, the service and the module it was declared at.
 * The failing service's own `shutdown` is NOT called — its `boot` never completed, so there is nothing
 * of its to stop, and calling it would hand a half-initialised service a second failure to raise.
 */
export async function bootPackServices(
  services: readonly LoadedPackService[],
  contextFor: (packId: string) => PackServiceContext,
): Promise<PackServicesHandle> {
  const booted: LoadedPackService[] = [];
  for (const service of services) {
    try {
      await service.boot(contextFor(service.packId));
    } catch (e) {
      await shutdownInReverse(booted);
      throw new PackServiceError(
        `extension '${service.packId}': service '${service.name}' (${service.module}) failed to ` +
          `boot: ${e instanceof Error ? e.message : String(e)}. A pack service starts BEFORE the ` +
          'deployment serves traffic, so a service that cannot start is a deployment that must not ' +
          'come up (fail-closed); the services that had already booted were shut down again.',
        service.packId,
      );
    }
    booted.push(service);
  }
  return {
    booted: booted.map((s) => `${s.packId}/${s.name}`),
    shutdown: () => shutdownInReverse(booted),
  };
}

/**
 * Stop `booted` in reverse order, CONTINUING past a service that throws. A noisy shutdown must not
 * strand the services behind it — the same discipline the composition root's `close()` already applies
 * to the durable worker, and for the same reason: a failure to stop cleanly is not a reason to leave
 * everything else running.
 */
async function shutdownInReverse(booted: readonly LoadedPackService[]): Promise<void> {
  for (let i = booted.length - 1; i >= 0; i--) {
    const service = booted[i] as LoadedPackService;
    try {
      await service.shutdown();
    } catch (e) {
      console.error(
        `[platform] extension '${service.packId}': service '${service.name}' threw on shutdown`,
        e,
      );
    }
  }
}
