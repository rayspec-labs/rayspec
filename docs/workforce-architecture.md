# Workforce architecture

How a declared `workforce:` section becomes durable, restartable, budgeted work — written for a
self-hoster who wants to know what actually holds each promise. Every guarantee below names the
mechanism (and usually the test) that enforces it; a claim without one is a bug in this page.

**EXPERIMENTAL.** The section parses only under `RAYSPEC_EXPERIMENTAL_WORKFORCE` (see the
[spec reference](./spec-reference.md#workforce-experimental)); its grammar and behavior may
change without notice.

## The one rule everything else follows from

**A wait is a row, never a process.** A task that is delegating, under review, or waiting for a
human is a Postgres row with a status and no process attached. Resume is a fresh, journaled
dispatch — nothing ever "continues" in memory across a decision. So a kill AT A PARK changes no
outcome at all: the wait is already a row, and the reboot resumes it from that row. A kill
MID-TURN is recovered differently — the turn body re-executes from the top and the model runs
again (its transcript may differ), but the APPLICATION stays exactly-once: the turn's receipt makes
a re-applied turn a clean no-op, and the reaper releases the dead claim's reservation, so no turn is
applied twice and no duplicate children are opened. The acceptance stories prove the park case
directly (`workforce-story-e2e.db.test.ts` lands its SIGKILL at the approval park and the reboot
oracle — status, version, transition count, turn-start count per task — is identical across the
kill); the mid-turn re-execution/duplication guarantee is proven by simulation — the
receipt-idempotency and reaper suites — not by an empirical mid-turn process kill (both
acceptance e2e tests land their SIGKILL at a park, never inside a running turn).

## One journal, one writer

Task events land in the existing append-only `run_events` table: task-scoped events under
`run_id = <taskId>`, workforce-scoped control events under `run_id = workforce:<workforceId>`.
Sequence allocation rides the task row's own counter, and the allocating UPDATE's row lock is
held to commit — so ALLOCATION ORDER EQUALS COMMIT ORDER, and a `seq > cursor` replay can never
skip an event that committed late (`packages/kernel/tasks/src/events.ts`). Every event's payload
carries `v: 1`; the vocabulary is a documented contract
([workforce events](./workforce-events.md)). There is no shadow observability system: the tree
view, the cost views and the events replay all read these same rows.

## The task state machine

Nine statuses (`planned`, `queued`, `working`, `blocked`, `waiting_for_review`,
`waiting_for_user`, `completed`, `failed`, `cancelled`), fourteen closed status reasons, and a
frozen transition table that spells out every (from, to) pair explicitly — all 81 of them, with
the three terminal rows all-false: finished work is never resurrected; follow-up is a NEW task.
The only way back into execution is `queued`, so every resume is a fresh dispatch. One function
(`applyTransition`) is the sole writer of the status column, compare-and-swapped on an
optimistic version and journaled before it returns.

Enforced by: `scripts/check-state-machine-exhaustive.mjs` (a build gate that fails on a missing
cell, a truthy terminal cell, a reason without a status rule, or a status write outside
`applyTransition` that it can SEE — it is a static source tripwire over the tracked engine files, a
loud early warning rather than a runtime monopoly; a raw write the scan cannot reach is not caught
by it, which is why the write path stays disciplined to the one function), 100% branch coverage
thresholds on the transition table and the pure intent planner, and a property suite driving random
transition sequences
(`transitions.property.test.ts`).

## The turn lifecycle

1. **Reserve.** A scheduler pass picks `queued` tasks in a deterministic order (priority, then
   queue time, then id), bounded per tick. It writes nothing to dispatch: the DBOS workflow id
   (`wf-task-turn:<taskId>:<turnNumber>:<version>`) IS the claim, and the engine's
   same-id-at-most-once law dedupes racing schedulers. Paused or saturated workforces are
   excluded in SQL before the page is taken — a bounded scan that could skip rows in place would
   be a starvation window, not a bound.
2. **Claim.** One transaction: the turn's receipt check (a re-executed body whose final
   transaction committed no-ops), the `queued → working` compare-and-swap, the BUDGET
   AUTHORIZATION (same transaction, so a denied or crashed claim leaks no reservation), and the
   `turn_started` journal event. A denial rolls the claim back and parks the task
   `blocked(budget_exhausted)` with the declared exhaustion policy applied.
3. **The turn.** The composition builds a bounded read snapshot, computes the deterministic turn
   facts (legal targets, matched policies, headroom, depth), performs one bounded recall read,
   assembles the byte-budgeted turn input, and runs the employee's agent with the role toolset
   injected beside its declared tools. The handler writes NOTHING to any workforce table —
   every effect flows through the returned typed intent.
4. **Apply.** `applyTurnOutcome`: intents, settlement, transition, journal events and the
   receipt, one idempotent transaction. Crash-and-replay changes no terminal outcome and
   duplicates no side effect — DBOS re-executes a pending body from the top, and the receipt is
   what makes that safe.

## The turn input

The context an employee's turn runs on is assembled by ONE pure function
(`assembleTurnInput`, `packages/kernel/workforce-tools/src/context.ts`): same inputs,
byte-identical output, proven by a 100-run identity test. Seven numbered sections — identity,
role frame, policies in force, the task, child results keyed by child task id, recent messages,
recall — each under a fixed byte budget, with deterministic, MARKED truncation inside a section
and a whole-section drop order (7, then 6, then 5) when the input exceeds its ceiling. **The
goal is never trimmed**: a goal that cannot fit its section is a typed refusal
(`GoalExceedsContextBudgetError`) that takes the declared fail fate — a misconfigured workforce
fails loudly, never on a silently shortened instruction.

Everything the runtime can answer is computed BEFORE the model is invoked and presented as data
(`computeTurnFacts`): which delegation targets are legal for this seat on this task, which
declared review and approval rules cover it (through the SAME predicates the enforcement path
uses, so the prompt can never contradict the policy), how much headroom and delegation depth
remain. The model's one judgment call per turn is which turn-ending tool it finishes with; that
choice is journaled as the turn's `classification`, derived server-side from the TYPED collected
intent — never from model prose.

## Recall

Every turn starts with one bounded recall read over the tenant's OWN prior work: completed task
results and journaled decisions (review verdicts, approval decisions, raised escalations),
scoped to the employee and their department, excluding the current root's whole subtree. Ranking
is recency plus keyword match and nothing more; every bound is a constant (scan rows, a 30-day
age window, hit text, hit count). Scoping is constructor-injected trusted data — the deployed
configuration and the dispatched task row — and every read runs on the tenant-scoped database
handle, so recall can never cross the tenant (`workforce-recall.db.test.ts` proves an identical
twin workforce in a second org leaks nothing). The provider seam is replaceable; the assembly
renders whatever hits arrive and never cares which provider answered.

## Delegation and fan-out

Delegation is a TYPED-INTENT path, never an execution path: `delegate_task` validates its
targets in the trusted layer, writes a durable intent, and ends the turn; the engine applies the
intent and the transition in one transaction; the scheduler dispatches the children as separate
workflows. Targets are `employee:<id>`, `department:<id>` (resolves to its manager), and
`team:<id>` (resolves to its lead, who fans out to the members and synthesizes — team addressing
is the orchestrator seat's move by construction). A manager reaches their own department's
members, plus the members of a team they LEAD while the task is that team's work — a fact read
off the delegation chain, not inferred (`resolve-target.ts`, pinned per role by
`toolset-semantics.test.ts` and `role-privilege.test.ts`).

Several tasks in one `delegate_task` call fan out together under the parent's `all` join; the
parent parks `blocked(awaiting_children)` with no process attached. Racing last children cannot
strand the parent (the fan-in locks the parent row first and re-reads the siblings under the
lock), the join wake is keyed PER FAN-OUT ROUND so a later round can never collide with an
earlier round's consumed key, and the parent's next turn receives the children's FULL structured
results **keyed by child task id, never ordered by completion** — the merged bytes are a pure
function of the children's terminal rows, byte-identical across runs whatever finished first
(the 100-run identity test on the merge).

Safety rules, runtime-enforced at intent acceptance: depth and per-task fan-out ceilings,
self-delegation and delegation cycles refused with typed reasons, budget checked before any
child row is written — and NO PRIVILEGE AGGREGATION: a child runs with its own declared agent
tools plus its role's natives, full stop; no inheritance path exists in code
(`role-privilege.test.ts`: the toolset is a function of the task owner alone).

## Parks and their exits

Every non-terminal wait is a (status, reason) pair — a PARK — and what may release it is matched
on the park itself, never on the status alone, on every door:

| Park | The exit |
| --- | --- |
| `blocked(awaiting_children)` | the fan-in join (all children terminal) |
| `blocked(awaiting_dependency)` | the dependency wake (all prerequisites completed) |
| `blocked(escalated)` | the escalated-to owner's reply |
| `blocked(budget_exhausted)` | a `budget_raised` operator signal |
| `blocked(clarification_pending)` | the requester's `user_reply` |
| `blocked(approval_pending)` | the decision on the escalated approval (an approval whose timeout escalated re-parks its task `blocked` while a superior's sign-off is asked) |
| `waiting_for_review` | the review verdict (accept completes; reject re-queues for rework) |
| `waiting_for_user(approval_pending)` | the human decision, or the timeout sweep's declared fate |
| `waiting_for_user` (no reason) | a `user_reply` operator signal — the "a human decides" park (review rounds spent; a budget exceedance escalated to the root) |

Operators additionally hold the `manual_unblock` door: it releases the `blocked` reasons whose
exit is already a human judgment call, and REFUSES the structural and deadline parks — an
override that dissolved a fan-out join or out-argued an absolute deadline would erase an exit no
signal can re-arm (`signals.ts` owns the vocabulary; the same rule binds on every door).

Structural parks (the join, the escalation) cannot be dissolved by an operator override or an
escalation — their mechanism cannot be re-armed, so no door may move a task sitting in one "for
its own good" (`packages/kernel/tasks/src/signals.ts` owns the vocabulary and every door reads
it). A `waiting_for_user` task consumes zero worker slots and zero budget: nothing is reserved
for a row nothing dispatches.

Reviews: a matched policy intercepts a completion no matter what the turn asked for
(`complete_with_review` — the result is stored, the task parks for review); rejection re-queues
for rework until the round ceiling is spent, then the task parks for a human. A review is
decided exactly once (a compare-and-swap on the verdict), a task under review whose reviewer
task dies gets the review released rather than stranded, and a review task's own completion is
never policy-reviewed — review depth is structurally one.

Approvals: `request_approval` parks the task at zero cost with the DECLARED window and fate
bound at request time (the rule matched by the employee's capabilities). A decision carries the
VERIFIED principal as `decidedBy` — the route derives it from the credential; there is no field
for asserting an identity. The timeout sweep gives every hung approval its declared fate.

## Budget scopes

Ceilings live in a reservation ledger keyed `(scope, calendar window)` with four scope kinds in
one canonical order — task, root (subtree), department, workforce. Authorization happens at the
dispatch boundary inside the claim transaction; settlement records the actual so the next
authorization sees the truth. A DENIAL MUTATES NOTHING (the task parks with a typed reason);
over-settlement is allowed exactly once — a turn that already fired is never aborted mid-flight
— and counts against the next authorization. Exhaustion is always explicit and journaled
(`workforce.budget.exceeded`), never a silent truncation (`budget.db.test.ts`,
`task-scheduler.db.test.ts`: denial parks, `budget_raised` resumes, concurrent subtree spend
holds the ceiling).

Lock discipline, stated once and followed everywhere: `workforce_runtime` → `workforce_tasks`
(root-first within the tree) → `workforce_budget_ledger`. Two operations whose row sets overlap
acquire the intersection in the same order and queue instead of deadlocking.

## The trust boundary

Model output is NEVER authority. The enforcement is layered, and each layer has a test that
fails without it (`workforce-turn-validation.db.test.ts` drives the whole chain):

- **Arguments validate at the dispatch chokepoint** before any handler runs (every native tool
  carries its schema, bound structurally at the one place tools are returned).
- **The toolset validates again** (strict schemas, closed unions) and injects every linkage the
  model must not choose — the review id, the escalation target, the approval window — from the
  snapshot and the declared configuration, never from arguments (a forged `escalateTo` in the
  arguments is refused; the well-formed call resolves the target from the reporting edge).
- **A refused ending crosses the boundary as a typed sentinel**, never as the model's bytes: a
  `submit_result` whose arguments fail the schema cannot be re-read by the engine as a valid
  intent of another kind, so a mandatory review policy cannot be skipped by sending the wrong
  arguments to the right tool.
- **The engine re-validates the intent** against its own closed union as the third pass, and a
  malformed intent never completes a task: one typed re-queue, then `failed`.
- **Policy matches override the turn.** The review-policy match is computed by the composition
  from declared rules and rides a trusted, strictly-validated channel beside the intent — the
  journal records both facts when they disagree (`classification: direct` beside
  `outcome: complete_with_review`).
- **Everything model-authored renders as data.** Task fields, messages, child results and recall
  render under a stated data/instruction boundary line, capped per item and per section — AND
  neutralized: every line-boundary and control character is stripped (or, for JSON-serialized
  values, escaped) before it renders, so no untrusted string can start a new line and forge a
  `## N.` section header or a second boundary line (the two mandated forgery tests — a header via a
  message body, a boundary via a recall hit — fail without it; `context.test.ts`).

**The one place a model's self-report reaches control flow — stated honestly.** A `confidenceBelow`
review rule fires on the confidence NUMBER the submitting turn wrote: a low self-report routes the
result to review (which is what a low number is for), but a turn that reports `0.99` dodges that
rule, and a `submit_result` with no confidence at all does not trip it (the rule keys on a present
number below the threshold). This is the deliberate exception to "model output is never authority":
the self-report is an INPUT to a declared rule, never a bypass of one — the reviewer, the max rounds
and the reject→rework loop are all enforced regardless, and the `firesOnCapabilities` branch of the
same policy fires UNCONDITIONALLY on the declared labels, with no number to dodge.

## Crash safety

The acceptance stories are the proof, not a demo: a real spawned server, a real SIGKILL with no
drain, a second boot on the same database, and a snapshot oracle over every task's status,
version, transition count and turn-start count that must be identical across the kill. The
workforce acceptance story's SIGKILL lands at a QUIESCENT PARK (the approval wait) — where "a wait
is a row" makes the reboot a straight resume — which is the case that oracle pins byte-for-byte
(`workforce-story-e2e.db.test.ts`). The harder MID-TURN case (the turn body re-executes and the
model re-runs, application still exactly-once) is proven by simulation — the receipt-idempotency
and reaper suites — rather than by an empirical mid-turn process kill; there is no such kill test,
and both acceptance e2e tests land their SIGKILL at a park. The
engine-level guards that make it all true: the workflow-id claim, the receipt idempotency, and the
one-writer transition monopoly above.

## Upgrade and rollback notes

Read this before an upgrade or an emergency, and read the limitations as literally as the
guarantees — three of the five entries below are constraints, not features, and each names the test
that would go red if the constraint silently changed.

**Migrations are forward-only.** There are no down-migration files, no `drizzle-kit drop` script,
and no claim anywhere that a schema change can be reversed. Recovery from a bad migration is a
reviewed FORWARD migration. The chain is applied by the real programmatic migrator at every boot and
is idempotent, so repeated boots are safe (`mount-without-deploy.db.test.ts:258-282`,
`boot-migrator-concurrency.db.test.ts`).

**The emergency lever is the feature flag, and it preserves your data.** Unset
`RAYSPEC_EXPERIMENTAL_WORKFORCE` and the next boot refuses the whole `workforce:` section with the
typed code `experimental_section_disabled` — no authoring, no dispatch. It does **not** touch a
single durable row: the flag is read in one place and enforced at the spec parse only, and nothing
in the task engine consults it. `serve-workforce-flag.db.test.ts` proves this end to end against a
database holding live work — a flag-ON deployment writes tasks in seven distinct (status, reason)
shapes, transitions, signals, approvals, reviews, messages, delegations, ledger rows and journal
entries in both `run_events` namespaces; the flag-OFF boot refuses; every one of the nine tables and
both namespaces is then **byte-identical** (an md5 over the ordered full row text, not just a count);
and re-enabling the flag lets a parked task resume on the exact CAS version it was parked at.

What the lever does NOT do: it does not remove the tables, it does not stop time on deadlines or
approval timeouts (nothing sweeps while the deployment refuses to boot — the fates simply fire when
you turn it back on), and it is not a schema rollback.

**The boot migrator is a SINGLE-RUNNER step.** It takes no advisory lock. On a fresh, empty
database two boots that start together will both try to apply the chain, and one of them dies —
observed as SQLSTATE 23505 on the migrator's very first statement (`CREATE SCHEMA IF NOT EXISTS
"drizzle"`), every time, on the certification host. Nothing is corrupted and nothing is half-applied
(the pending set is one transaction), the database ends fully migrated, and the loser's cost is a
failed boot that a restart fixes — but do not read "safe to run repeatedly" as multi-replica boot
safety. Run migrations from one runner. The behaviour is pinned by
`boot-migrator-concurrency.db.test.ts`; the advisory-locked shape a future fix should mirror is
`tenant-provision.ts`'s `pg_advisory_xact_lock`, exercised at `tenant-provision.db.test.ts:152-181`.

**A migration that cannot apply is fail-closed, and the failing tag takes one query to name.** The
migrator throws, the process exits non-zero, the whole pending set rolls back, and
`drizzle.__drizzle_migrations` does not record the failed migration
(`migration-failure.db.test.ts`). The error text quotes the failing STATEMENT verbatim and carries
the Postgres cause (SQLSTATE + message) — but **not** the failing tag. To name it: read
`SELECT max(created_at) FROM drizzle.__drizzle_migrations`, which is a journal `when`; the failing
migration is the first entry in `drizzle/meta/_journal.json` after it.

**Upgrading a database whose rows predate the declaration marker.** The redeploy gate refuses to
strand live work on a removed workforce, employee, department or team, and it decides "this
workforce was declared" from `workforce_runtime.budgets.declaredAt`, which only a declaring boot
writes. A workforce declared by a boot that ran **before** that marker existed carries none, so a
removal or rename made between that boot and the next declaring boot is **not** caught. There is no
safe backfill: for a runtime row the current document does not declare, no boot can tell "declared,
then removed" from "the engine created it under `/v1/workforce`", and guessing would make a
legitimate engine-only deployment refuse to boot over tasks nobody declared. The window closes by
itself on the next boot that still declares the workforce, and both halves are pinned in
`workforce-boot.db.test.ts` ("PRE-MARKER WINDOW…" and "the window CLOSES at the next declaring
boot…").

So the upgrade order is: **boot once with the workforce still fully declared**, then make removals in
a later deploy. One caveat rides along — the marker is stamped only on a boot that has BOTH a durable
worker and `RAYSPEC_CRON_TENANT_ID` set, so a deployment that declares a workforce without
`deployment.durableWorker` never marks it and stays in the window indefinitely.

## Honest scope

What the built-in orchestration deliberately does NOT include:

- **No cross-run learning.** Nothing an employee did in one task changes how the next is routed
  or prompted.
- **No historical performance routing.** Delegation targets resolve from the declared structure
  alone, never from measured worker quality.
- **No semantic memory.** Recall is recency plus keyword over this tenant's own rows — no
  embeddings, no decision extraction, no consolidation, no staleness management.
- **No cross-provider cost optimization.** A turn runs on the backend and model the employee's
  agent declares, at whatever it costs.
- **No advanced context packing.** The turn input is the documented assembly: honest, bounded,
  deterministic — and the goal is never trimmed.

Each of these is a boundary, not a roadmap gap disguised as one: the guarantees this page makes
are exactly the enforced ones named above.

## See also

- **[Spec reference → workforce](./spec-reference.md#workforce-experimental)** — the grammar and
  every validation rule.
- **[Workforce events](./workforce-events.md)** — the journal vocabulary, versioned.
- **[Workforce tools](./workforce-tools.md)** — the role toolsets and the result contract.
- **[CLI reference → workforce](./cli-reference.md#workforce--operate-the-durable-task-engine-of-a-running-deployment)**
  — the operator console.
