# @rayspec/durable-dbos

The **DBOS adapter** for the neutral `DurableExecutor` (the off-request durable-execution spine).

## What it is

This is the **only** package that imports `@dbos-inc/dbos-sdk`. `@rayspec/platform` / `run-core` /
the four SDK adapters (openai · anthropic · pi · codex) carry **no** DBOS dependency — the engine
asymmetry is absorbed here.
The neutral `DurableExecutor` / `RunJob` / `DurableJobStatus` types live in `@rayspec/platform` and
carry no DBOS reference, so an engine swap touches only this package.

`DbosDurableExecutor` runs the **existing `runAgent` off-request, unchanged**, inside one DBOS
workflow (`runAgentJob`) whose single durable step calls
`runAgent(forTenant(db, tenantId).transaction(...), backend, spec, { runId })`. It adds **no** new
persistence/streaming layer: events still persist to `run_events` via run-core's pipeline; a
disconnected client resumes completion via the shipped `GET /v1/runs/{id}/events?lastEventId=`.

## Durability contract — WHOLE-RUN re-execution (honest, not step-resume)

DBOS recovers an interrupted workflow by **re-invoking the workflow body from the start**, replaying
only **completed** steps from their memoized return values. Our workflow has **one** big step (the
whole `runAgent`), so a crash **mid-`runAgent`** leaves that step incomplete and on recovery it would
**re-run `runAgent` from scratch** (the model is re-called; the journal only short-circuits an
*already-completed* run). **There is no intra-run step-resume.** This is the documented contract
— do not claim step-resume.

## Crash-safety — the non-idempotent-taint quarantine

Whole-run re-execution + a non-idempotent (`idempotent:false`) tool = a re-fired side effect, so an
automated retry is only safe for a run that has NOT yet fired a non-idempotent effect. The
non-idempotent-taint quarantine makes retry safe. Three layers cooperate:

1. `maxRecoveryAttempts: 1` on the workflow — caps DBOS's own crash-recovery so a perpetually-crashing
   job dead-letters at `MAX_RECOVERY_ATTEMPTS_EXCEEDED` instead of looping. (This alone is
   insufficient — it still permits one silent recovery re-run before the flip — hence layer 2.)
2. A **started-once guard** backed by our own `idempotency_keys` (the correctness boundary — DBOS
   memoizes step *outputs*, not our in-step Drizzle writes). At the top of the step it atomically
   reserves `(tenant, scope='run_started', key=runId)`: the first execution wins and runs `runAgent`;
   a recovery re-execution finds the marker already present and defers to layer 3.
3. The **taint-aware quarantine decision** on that recovery: the guard consults the
   `run_taint` marker (written by the chokepoint on its OWN connection BEFORE a non-idempotent side
   effect fires, so it survives a crash that rolls the run back). A **tainted** run is QUARANTINED —
   the workflow throws `DurableRunNotRetriedError` (terminal-failed) and `runAgent` is **not** re-run.
   An **untainted** (idempotent / no-tool) run is SAFELY re-runnable, so the recovery re-executes it
   (the safe-class automated retry). A transient taint-READ error is retried in place, never collapsed
   into a quarantine or a silent re-run.

**The safety invariant:** a crashed run that already fired a non-idempotent tool is **never silently
re-fired** — it is quarantined terminal for manual review; only an untainted/idempotent run retries
automatically.

## DBOS coexistence

DBOS keeps its own Postgres **system database** — SEPARATE from the app DB (it auto-creates it; it
never touches the app `public` schema, so `gate:migrate-clean` is unaffected). The composition root
derives its url from `DATABASE_URL` (swap the db name to `<appdb>_dbos_sys`) or reads
`DBOS_SYSTEM_DATABASE_URL`.

The pinned SDK is **`@dbos-inc/dbos-sdk@4.21.6`** (exact; the functional API — no decorators). The
wire shape it depends on is golden/contract-tested (`src/dbos-wire-shape.test.ts`) so a future SDK
bump fails loudly.
