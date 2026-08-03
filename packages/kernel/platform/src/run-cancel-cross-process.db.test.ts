/**
 * Cancelling a run that is executing in ANOTHER PROCESS — DB-backed, with a REAL second process.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IS BEING PROVEN, AND WHY IT NEEDS A SECOND PROCESS.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The cancellation marker has always been durable; the SIGNAL is a module-level map, so it reaches
 * only the runs executing in the process that holds it. Nothing re-read the marker while run-core was
 * waiting for the backend, so a run on another worker kept burning until it returned by itself. With
 * `RAYSPEC_RUN_CANCEL_POLL_MS` set, the run's OWN process re-reads the marker on an interval and
 * delivers its own abort — the same abort the in-process path delivers, on the same controller.
 *
 * Proving that inside one process is impossible: the in-process registry would reach the run whether
 * or not anything durable did. So the observation arm SPAWNS A REAL CHILD PROCESS
 * (`test-support/cross-process-run.ts`, which imports platform SOURCE) and the parent only ever writes
 * the marker on its own handle. The boundary is asserted rather than assumed: while the child's run is
 * in flight, the parent's `signalRunCancelled` for that runId returns FALSE, and an in-process control
 * run in the very same moment returns TRUE.
 *
 * "IDENTICAL" IS MEASURED, NOT CLAIMED. Both arms run the SAME function from the SAME fixture in the
 * SAME durable invocation shape; the terminal state and journal are read back through one normalizer
 * and compared for equality — and then compared against the absolute expected value, so the equality
 * can never be green on two empty shapes.
 *
 * TWO MEASURED FACTS SHAPE THESE ASSERTIONS. A run holds its `runs` header at an uncommitted
 * `running` inside its own transaction, so another connection reads the pre-run `enqueued` — never
 * `running`. And the enqueue-time header must exist BEFORE the run (the fixture writes it, as the run
 * surface does, outside the run's transaction), or a cancelled run's rollback leaves no `runs` row at
 * all and the terminal comparison compares two absences.
 *
 * ONE ARM IS DELIBERATELY NOT THE DURABLE SHAPE. What a cancelled run leaves in its journal is
 * decided by whether it ran inside a transaction, not by which process cancelled it, so the last
 * test runs the SYNCHRONOUS shape — `runAgent` on a plain tenant handle, no transaction, no
 * `taintDb`, as the run surface invokes it — and pins that its committed steps SURVIVE beside the
 * cancellation. Both shapes are documented; neither claim rests on the other's measurement.
 *
 * This file never skips: `makeTestDb()` throws without DATABASE_URL, and the ran-guard at the bottom
 * fails loudly if the arms above did not execute.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TenantDb } from '@rayspec/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isRunCancelled,
  markRunCancelled,
  recordRunCancelled,
  signalRunCancelled,
} from './run-cancel.js';
import { runAgent } from './run-core.js';
import { isRunTainted } from './run-taint.js';
import {
  CROSS_PROCESS_SPEC,
  type CrossProcessRunConfig,
  type CrossProcessRunOutcome,
  GatedRunBackend,
  runDurableShapeCancellable,
} from './test-support/cross-process-run.js';
import {
  forTenant,
  makeTestDb,
  resetRunSchema,
  seedOrgs,
  TENANT_A,
} from './test-support/test-db.js';

const db = makeTestDb();

const here = dirname(fileURLToPath(import.meta.url));
/** The child fixture, run as a real process. TypeScript source on purpose: never the built dist. */
const CHILD_PATH = join(here, 'test-support', 'cross-process-run.ts');

/** The variable under test. Saved and restored per test so no arm leaks into the next. */
const POLL_ENV = 'RAYSPEC_RUN_CANCEL_POLL_MS';

/** Long enough that a run which is NOT ended by the marker is unmistakably still burning. */
const BACKEND_GATE_MS = 5000;
/** The window a cross-process cancellation must land in, from the parent's marker write. */
const OBSERVE_WITHIN_MS = 1500;

/** The ran-guard's counter: a file that silently did nothing must never read as a green file. */
let testsRan = 0;

/** Every child spawned by the current test, so the afterEach can kill a survivor. */
const children: ChildProcess[] = [];

interface ChildArm {
  /** Resolves when the child's run is in flight inside its transaction, with its step written. */
  readonly inGate: Promise<void>;
  /** Resolves with the child's reported outcome. */
  readonly done: Promise<CrossProcessRunOutcome & { sawAbort: boolean }>;
}

/**
 * Spawn the fixture as a real process. `pollMs` is placed in the CHILD's environment only — the
 * parent's own configuration is never changed by this, which is what keeps the in-process control
 * arms honest.
 */
function spawnCrossProcessRun(cfg: CrossProcessRunConfig, pollMs: number): ChildArm {
  const child = spawn(process.execPath, ['--import', 'tsx', CHILD_PATH, JSON.stringify(cfg)], {
    env: { ...process.env, [POLL_ENV]: String(pollMs) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);

  let resolveGate: () => void = () => {};
  let rejectGate: (e: Error) => void = () => {};
  const inGate = new Promise<void>((res, rej) => {
    resolveGate = res;
    rejectGate = rej;
  });
  let resolveDone: (v: CrossProcessRunOutcome & { sawAbort: boolean }) => void = () => {};
  let rejectDone: (e: Error) => void = () => {};
  const done = new Promise<CrossProcessRunOutcome & { sawAbort: boolean }>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  let buffered = '';
  let stderr = '';
  let settled = false;
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    buffered += chunk.toString();
    let nl = buffered.indexOf('\n');
    while (nl >= 0) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (line.length > 0) {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.phase === 'in-gate') resolveGate();
        if (msg.phase === 'done') {
          settled = true;
          resolveDone(msg as unknown as CrossProcessRunOutcome & { sawAbort: boolean });
        }
        if (msg.phase === 'crashed') {
          const err = new Error(`child crashed: ${String(msg.message)}`);
          rejectGate(err);
          rejectDone(err);
        }
      }
      nl = buffered.indexOf('\n');
    }
  });
  child.on('exit', (code) => {
    if (settled) return;
    const err = new Error(
      `child exited (code ${String(code)}) before reporting; stderr:\n${stderr}`,
    );
    rejectGate(err);
    rejectDone(err);
  });
  return { inGate, done };
}

/**
 * The normalized terminal tuple: the run header's status plus every journal step it left, in a
 * DETERMINISTIC order (the natural key of a step, never insertion time). This one reader serves both
 * arms, so an equality between them is an equality of the same measurement.
 */
async function terminalShape(runId: string): Promise<{
  headerStatus: string | null;
  steps: Array<{
    type: string;
    status: string;
    error_class: string | null;
    idempotency_key: string;
  }>;
}> {
  const headerRows = (await db.$client.unsafe('SELECT status FROM runs WHERE run_id = $1', [
    runId,
  ])) as unknown as Array<{ status: string }>;
  const stepRows = (await db.$client.unsafe(
    'SELECT type, status, error_class, idempotency_key FROM journal_steps WHERE run_id = $1 ' +
      'ORDER BY type, idempotency_key',
    [runId],
  )) as unknown as Array<{
    type: string;
    status: string;
    error_class: string | null;
    idempotency_key: string;
  }>;
  return {
    headerStatus: headerRows[0]?.status ?? null,
    steps: stepRows.map((r) => ({
      type: r.type,
      status: r.status,
      error_class: r.error_class,
      idempotency_key: r.idempotency_key,
    })),
  };
}

/** What a cancelled run's terminal tuple IS — asserted absolutely, not only against the other arm. */
const CANCELLED_SHAPE = {
  headerStatus: 'error',
  steps: [
    {
      type: 'cancel',
      status: 'error',
      error_class: 'cancelled',
      idempotency_key: 'run:cancelled',
    },
  ],
};

/**
 * Wrap a TenantDb so a test can watch (or break) exactly the handle the poll reads through. `onUse`
 * fires for every statement-issuing method, so "used zero times" means the handle was never touched
 * at all — not merely never selected from.
 */
function watchTenantDb(
  inner: TenantDb,
  onUse: (method: string) => void,
  failSelect = false,
): TenantDb {
  const watched = new Set(['select', 'insert', 'update', 'delete', 'transaction']);
  return new Proxy(inner, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof prop === 'string' && watched.has(prop) && typeof value === 'function') {
        return (...args: unknown[]) => {
          onUse(prop);
          if (failSelect && prop === 'select') {
            throw new Error('watchTenantDb: the marker read fails on every tick');
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as TenantDb;
}

function config(runId: string, over: Partial<CrossProcessRunConfig> = {}): CrossProcessRunConfig {
  return {
    runId,
    tenantId: TENANT_A,
    gateMs: BACKEND_GATE_MS,
    fireNonIdempotentTool: false,
    ...over,
  };
}

/** Poll `predicate` until it holds (bounded) — a deterministic barrier, never a fixed sleep. */
async function waitFor(predicate: () => boolean, capMs = 5000): Promise<void> {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`condition did not hold within ${capMs}ms`);
}

let savedPollEnv: string | undefined;

beforeAll(async () => {
  // FAIL LOUDLY rather than skip: without the fixture there is no second process and nothing here
  // measures anything, which is exactly the silent-green this file exists to prevent.
  if (!existsSync(CHILD_PATH)) {
    throw new Error(`cross-process run fixture is missing at ${CHILD_PATH}`);
  }
  await resetRunSchema(db);
});

beforeEach(async () => {
  savedPollEnv = process.env[POLL_ENV];
  delete process.env[POLL_ENV];
  await db.$client.unsafe(
    'TRUNCATE journal_steps, conversation_items, run_events, runs, idempotency_keys CASCADE',
  );
  await seedOrgs(db, TENANT_A);
});

// Registered as the ONLY afterEach so ordering cannot surprise: no child ever survives into the next
// test's TRUNCATE, and the environment is restored whatever an arm did to it.
afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  if (savedPollEnv === undefined) delete process.env[POLL_ENV];
  else process.env[POLL_ENV] = savedPollEnv;
});

afterAll(async () => {
  await db.$client.end();
});

describe('ACCEPTANCE 2 — single-process behaviour is unchanged when nothing is configured', () => {
  it('an unconfigured run never touches the autonomous handle, and completes with an un-aborted signal', async () => {
    testsRan += 1;
    const uses: string[] = [];
    const taintDb = watchTenantDb(forTenant(db, TENANT_A), (m) => uses.push(m));
    const cfg = config('poll-unset', { gateMs: 20 });
    const backend = new GatedRunBackend(cfg);
    const outcome = await runDurableShapeCancellable(db, cfg, backend, taintDb);

    // The whole cost of the feature when it is off: NOTHING. Not one statement on the autonomous
    // handle, because the poll was never armed.
    expect(uses).toEqual([]);
    expect(outcome).toEqual({ outcome: 'completed', errorName: null });
    expect(backend.sawAbortedAtEntry).toBe(false);
    expect(backend.sawAbort).toBe(false);
    expect((await terminalShape(cfg.runId)).headerStatus).toBe('completed');
  });

  it('PAIRED NON-VACUITY: the same counter moves the moment the poll IS configured, and the run ends', async () => {
    testsRan += 1;
    // Without this arm the zero above could equally be a counter that never counts. Same handle, same
    // wrapper, same shape — one variable set.
    process.env[POLL_ENV] = '25';
    const uses: string[] = [];
    const taintDb = watchTenantDb(forTenant(db, TENANT_A), (m) => uses.push(m));
    const cfg = config('poll-set-nonvacuity');
    const backend = new GatedRunBackend(cfg);
    let inGate = false;
    backend.onGate = () => {
      inGate = true;
    };
    const running = runDurableShapeCancellable(db, cfg, backend, taintDb);
    await waitFor(() => inGate);
    // ONLY the marker — no signal of any kind, even though this run is in this very process.
    await markRunCancelled(forTenant(db, TENANT_A), cfg.runId);

    expect(await running).toEqual({ outcome: 'cancelled', errorName: 'RunCancelledError' });
    expect(uses.length).toBeGreaterThan(0);
  });
});

describe('ACCEPTANCE 1 — the process boundary is real', () => {
  it('the parent cannot signal a run executing in the child, and CAN signal one of its own', async () => {
    testsRan += 1;
    const childCfg = config('boundary-child');
    const child = spawnCrossProcessRun(childCfg, 100);
    await child.inGate;

    // The in-process control, started while the child's run is in flight: same shape, same process.
    const localCfg = config('boundary-local');
    const localBackend = new GatedRunBackend(localCfg);
    let localInGate = false;
    localBackend.onGate = () => {
      localInGate = true;
    };
    const localRunning = runDurableShapeCancellable(db, localCfg, localBackend);
    await waitFor(() => localInGate);

    // The pair is the proof: a FALSE on its own could be a broken call. The TRUE beside it, in the
    // same process at the same instant, says the call works and the child is simply out of reach.
    expect(signalRunCancelled(childCfg.runId)).toBe(false);
    await markRunCancelled(forTenant(db, TENANT_A), localCfg.runId);
    expect(signalRunCancelled(localCfg.runId)).toBe(true);
    expect(await localRunning).toEqual({ outcome: 'cancelled', errorName: 'RunCancelledError' });

    // And the child, which nothing in this process can signal, is ended by the marker alone.
    await markRunCancelled(forTenant(db, TENANT_A), childCfg.runId);
    expect(await child.done).toMatchObject({ outcome: 'cancelled' });
  });
});

describe('ACCEPTANCE 1 — a run in a second process observes the cancellation and ends identically', () => {
  it('the child ends promptly on the marker alone, and its terminal state and journal match the in-process path', async () => {
    testsRan += 1;
    const childCfg = config('cross-observed');
    const child = spawnCrossProcessRun(childCfg, 100);
    await child.inGate;

    // The parent's whole part in this: ONE marker write, on its own handle. It never signals — it
    // cannot, and this asserts that rather than trusting it.
    expect(signalRunCancelled(childCfg.runId)).toBe(false);
    const markedAt = Date.now();
    await markRunCancelled(forTenant(db, TENANT_A), childCfg.runId);
    const childOutcome = await child.done;
    const observedMs = Date.now() - markedAt;

    // The step set first: it is what makes a failure here read as "the run was not ended" rather than
    // as a timeout. Without the poll the child burns the whole gate, completes, and COMMITS — leaving
    // the `llm` step beside the cancellation step, and taking BACKEND_GATE_MS to do it.
    expect(childOutcome).toMatchObject({ outcome: 'cancelled', errorName: 'RunCancelledError' });
    const crossShape = await terminalShape(childCfg.runId);
    expect(crossShape).toEqual(CANCELLED_SHAPE);

    // The in-process control: the SAME fixture function, the SAME shape, cancelled the way the
    // in-process path cancels — marker then signal — with no poll configured in this process.
    const localCfg = config('cross-control');
    const localBackend = new GatedRunBackend(localCfg);
    let localInGate = false;
    localBackend.onGate = () => {
      localInGate = true;
    };
    const localRunning = runDurableShapeCancellable(db, localCfg, localBackend);
    await waitFor(() => localInGate);
    await markRunCancelled(forTenant(db, TENANT_A), localCfg.runId);
    expect(signalRunCancelled(localCfg.runId)).toBe(true);
    expect(await localRunning).toEqual({ outcome: 'cancelled', errorName: 'RunCancelledError' });
    const controlShape = await terminalShape(localCfg.runId);

    // IDENTICAL, measured: the two arms produce the same tuple — and that tuple is the expected one,
    // so the equality cannot be satisfied by two empty shapes.
    expect(crossShape).toEqual(controlShape);
    expect(controlShape).toEqual(CANCELLED_SHAPE);
    // And it was prompt: the run stopped burning the gate instead of running it out.
    expect(observedMs).toBeLessThan(OBSERVE_WITHIN_MS);
  });
});

describe('ACCEPTANCE 3 — a cancelled run that fired a non-idempotent tool stays quarantined', () => {
  it('the taint survives the rollback, the run stays marked cancelled, and the journal shows only the cancellation', async () => {
    testsRan += 1;
    const childCfg = config('cross-tainted', { fireNonIdempotentTool: true });
    const child = spawnCrossProcessRun(childCfg, 100);
    await child.inGate;
    await markRunCancelled(forTenant(db, TENANT_A), childCfg.runId);
    expect(await child.done).toMatchObject({ outcome: 'cancelled' });

    const tdb = forTenant(db, TENANT_A);
    // The taint was committed on the AUTONOMOUS handle before the side effect, so the run's rollback
    // could not take it — the evidence that a non-idempotent tool already fired is still there.
    expect(await isRunTainted(tdb, childCfg.runId)).toBe(true);
    // Still marked cancelled, so no dispatch (fresh or recovery) can ever run it again.
    expect(await isRunCancelled(tdb, childCfg.runId)).toBe(true);
    // And the ledger shows the cancellation only: the tool step it journaled inside the transaction
    // went down with the rollback, exactly as a cancelled run's other writes do.
    expect(await terminalShape(childCfg.runId)).toEqual(CANCELLED_SHAPE);
  });
});

describe('a poll read that FAILS can neither end a run nor fail one', () => {
  it('every tick rejects, and the uncancelled run completes and commits exactly as it would have', async () => {
    testsRan += 1;
    // The deliberate OPPOSITE of the executor's bounded-retry reader, which rethrows so a run is never
    // DISPATCHED off an unresolved read. Here the run is already executing: ending it on an unreadable
    // marker would destroy work that is happening.
    process.env[POLL_ENV] = '10';
    const uses: string[] = [];
    const taintDb = watchTenantDb(forTenant(db, TENANT_A), (m) => uses.push(m), true);
    const cfg = config('poll-read-fails', { gateMs: 300 });
    const backend = new GatedRunBackend(cfg);

    const outcome = await runDurableShapeCancellable(db, cfg, backend, taintDb);

    expect(uses.filter((m) => m === 'select').length).toBeGreaterThan(0);
    expect(outcome).toEqual({ outcome: 'completed', errorName: null });
    expect(backend.sawAbort).toBe(false);
    // The run's transaction COMMITTED: its header is terminal and the step it journaled inside is
    // there. A failed read cost the run nothing at all.
    expect(await terminalShape(cfg.runId)).toEqual({
      headerStatus: 'completed',
      steps: [
        {
          type: 'llm',
          status: 'ok',
          error_class: null,
          idempotency_key: 'llm:cross-process:0',
        },
      ],
    });
  });
});

describe('what a cancelled run leaves in its journal follows the INVOCATION SHAPE', () => {
  it('the synchronous shape has no transaction to roll back, so it KEEPS the steps it committed', async () => {
    testsRan += 1;
    // Every arm above runs the DURABLE shape — `runAgent` inside `tdb.transaction()` — where the
    // rollback is what leaves a cancelled run with the single `cancelled` step. The SYNCHRONOUS HTTP
    // path runs `runAgent` on a plain tenant handle with no transaction and no `taintDb` (the run
    // surface's `forTenant(deps.db, tenantId)`), so there is nothing to roll back and the steps it
    // journaled are already committed when the cancellation lands. Both shapes are documented; this
    // pins the one the durable arms cannot reach, so neither claim can quietly stop being true.
    process.env[POLL_ENV] = '25';
    const cfg = config('sync-shape-keeps-steps');
    const backend = new GatedRunBackend(cfg);
    let inGate = false;
    backend.onGate = () => {
      inGate = true;
    };
    const tdb = forTenant(db, TENANT_A);

    const ended = runAgent(tdb, backend, CROSS_PROCESS_SPEC, { runId: cfg.runId }).then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.name : String(err)),
    );
    await waitFor(() => inGate);
    // The cancellation as the OTHER process issues it: the marker, then the cancel surface's record.
    // Nothing in this process signals the run — the poll is what has to reach it.
    const cancelDb = forTenant(db, TENANT_A);
    await markRunCancelled(cancelDb, cfg.runId);

    expect(await ended).toBe('RunCancelledError');
    expect(backend.sawAbort).toBe(true);
    await recordRunCancelled(cancelDb, cfg.runId);

    // Terminal exactly as the durable shape is — and the `llm` step it committed before the
    // cancellation is STILL THERE beside the cancellation, which is the difference.
    expect(await terminalShape(cfg.runId)).toEqual({
      headerStatus: 'error',
      steps: [
        {
          type: 'cancel',
          status: 'error',
          error_class: 'cancelled',
          idempotency_key: 'run:cancelled',
        },
        {
          type: 'llm',
          status: 'ok',
          error_class: null,
          idempotency_key: 'llm:cross-process:0',
        },
      ],
    });
  });
});

// The ran-guard: registered LAST + no beforeAll dependency, so a beforeAll throw that skipped the
// arms above can never read as a passing (green) file.
describe('cross-process cancellation — ran-guard (not skippable-as-green)', () => {
  it('the cross-process arms ACTUALLY RAN (all seven)', () => {
    expect(testsRan).toBe(7);
  });
});
