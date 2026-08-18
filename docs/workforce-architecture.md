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
bound at request time (the approval policy matched by the employee's labels). A decision carries the
VERIFIED principal as `decidedBy` — the route derives it from the credential; there is no field
for asserting an identity. The timeout sweep gives every hung approval its declared fate.

**The engine keeps the authorization it writes.** An approval's `approver` and a review's
`reviewer` are journaled as accountability facts, so the door compares them against the deciding
principal rather than trusting `store:write` alone
(`packages/kernel/tasks/src/decision-authority.ts`; matrix in `decision-authority.db.test.ts`):

- `approver: user` — the deployment's human operator surface, and the only value the declared
  grammar admits — is the OPEN sentinel: any permitted principal decides it, exactly as before.
  This is the shipped single-operator posture and the regression guard pins it.
- A row that NAMES a principal binds to it. The case that actually arises is the escalation: when
  an `onTimeout: escalate` request times out, the sweep closes it and re-issues it to the
  requester's DECLARED superior (`approver: <employeeId>`, journaled as
  `workforce.approval.requested`). Only that principal may resolve it — the operator whose
  inaction caused the escalation cannot. The refusal is a 403 naming who the row names, and it
  writes nothing at all.
- **Break-glass** keeps an unavailable decider from wedging a deployment, and takes two
  independent things so it can never happen by accident: the request must ASK (`override: true`,
  or `--override` on the CLI) and the principal must HOLD `workforce:override` (an `owner`/`admin`
  permission, deliberately never grantable to an API key — the override exists to record which
  *human* contradicted a named human). The journal then carries `overriddenApprover` /
  `overriddenReviewer`, so the trail says what happened instead of leaving `decided_by` to
  contradict the recorded decider silently.

At the HTTP door this means an escalated approval is **always** reached through break-glass, not
usually: a principal authenticates as `user:<id>` / `api-key:<id>` and a named approver is a
declared employee id, so the two namespaces are structurally disjoint and the comparison cannot
match. That is the deliberate fail-closed reading — open core carries no principal-to-employee
binding, and the honest answer to "we cannot verify this caller is `ops_lead`" is to demand the
override and record it. There is no second route for an approval: `decideApproval` has exactly one
caller (the HTTP door), no tool decides an approval, and the escalation dispatches no turn — so an
escalated approval ends either in a break-glass decision or, when its window expires, in the
terminal `fail` fate the re-issued request carries. (A named *reviewer* is the different case: a
review verdict does arrive through that reviewer's own dispatched turn, where the actor IS the
employee id and `apply-intents.ts` already re-checks it.)

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
and the reject→rework loop are all enforced regardless, and the `firesOnLabels` branch of the
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

A crash is not the only way a turn stops making progress, and the durable engine's own status
cannot see the other one. A worker whose process is up and whose turn workflow is genuinely PENDING
but whose body is WEDGED — a hung socket, a deadlocked dependency — reaches neither release path:
not the turn's final transaction, which it never gets to, and not the reaper, which asked the
engine and was told the workflow was alive. Such a row held its `maxConcurrentWorkers` slot and its
budget reservation indefinitely, and because the `task`/`root` ledger scopes are un-windowed the
stranded estimate never rolled over. Every claim therefore now stamps a LEASE
(`workforce_tasks.claim_expires_at`, written in the same compare-and-swap that takes the claim and
cleared by every exit from `working`), and the sweep reaps an expired claim through the identical
path as a dead one — same re-queue, same release of exactly what the claim reserved, in the window
it reserved it in — journaling `queueReason: 'turn_lease_expired'` so the two diagnoses stay
distinguishable. The default lease is 30 minutes and is deliberately far above any plausible
healthy turn: the shipped examples' whole-TASK wall clocks are 30m and 45m, and a task is many
turns. A turn reaped while still running cannot corrupt anything — its final application is
refused over the successor's claim by the claim-ownership check — so the residual cost of an
over-eager lease is duplicated work, which is why the default errs long rather than short.
`packages/workflow/durable-dbos/src/task-scheduler.db.test.ts` proves both halves: a wedged
PENDING turn is reaped with its reservation returned, and a live turn inside its lease survives
every sweep.

What the lease does **not** do, stated plainly: it releases the row and the money, not the
operating-system resource. Nothing kills the wedged body — there is no safe way to interrupt
arbitrary handler code mid-call — so the wedged execution keeps its slot on the turn queue until it
returns, throws, or the process restarts. What the reap recovers is the task (dispatchable again),
the workforce `maxConcurrentWorkers` slot (counted off `working` rows), and the budget reservation,
which is the only one of the three that leaked permanently. A deployment whose workers wedge often
wants a smaller turn-queue concurrency or a timeout inside the handler, not a shorter lease.

## Upgrade and rollback notes

Read this before an upgrade or an emergency, and read the limitations as literally as the
guarantees — three of the six entries below are constraints, not features, and each names the test
that would go red if the constraint silently changed.

**This release carries ONE migration: `0013_workforce_dedupe_lease_and_scrub`.** It adds three
NULLABLE columns (`workforce_reviews.turn_number`, `workforce_approvals.turn_number`,
`workforce_tasks.claim_expires_at`), two PARTIAL unique indexes, and relaxes five `text NOT NULL`
content columns to accept NULL so `journalScrub` can erase content while retaining the budget
ledger. It cannot fail on a populated database and needs no backfill: a nullable column cannot be
violated by an existing row, `DROP NOT NULL` never fails on data, and because `turn_number` is a new
column every pre-existing row holds NULL — and NULLs are distinct for uniqueness — so both unique
indexes constrain ZERO existing rows. (That last property comes from the key being new and all-NULL,
not from the indexes being partial; a total unique index on the same column would create just as
cleanly.) Rolling the binary back is safe: older releases never read the new columns, and a relaxed
`NOT NULL` is a superset of what they wrote. No operator action is required.
Pinned by the `0013` block in `packages/kernel/db/scripts/shadow-dryrun.sh` and by
`gate:migrate-clean`'s zero-drift cross-check against `schema.ts`.

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
approval timeouts, and it is not a schema rollback. Nothing sweeps while the deployment refuses to
boot, and the timeout predicate is ABSOLUTE rather than elapsed-since-resume —
`sweepApprovalTimeouts` selects `pending` approvals on `lt(timeoutAt, now)`
(`packages/kernel/tasks/src/approvals.ts:167-181`) — so every window that expired during the outage
is due the moment you turn the flag back on, and the declared fates fire then.

**The boot migrator is a SINGLE-RUNNER step. Run migrations from one runner** — and do not read
"safe to run repeatedly" as multi-replica boot safety. It takes no advisory lock.

What is PINNED, and what to design against (`boot-migrator-concurrency.db.test.ts`):

- **A runner that meets another's objects aborts cleanly and records nothing.** Staged
  deterministically — `orgs` is `0000`'s first non-`IF NOT EXISTS` CREATE, so a runner arriving
  second dies exactly there — the abort is SQLSTATE `42P07` (duplicate_table),
  `drizzle.__drizzle_migrations` records **zero** rows, and `journal_steps` (created *before* `orgs`
  in the same batch) does not exist afterwards. So the whole-batch rollback is observed rather than
  inferred: there is no half-applied migration for an operator to reason about, and the next boot
  re-applies from the top rather than resuming a fiction.
- **Two concurrent runners: at least one applies the chain, AT MOST ONE fails**, any failure is a
  clean duplicate-object abort from a known set (`42P07` / `42710` / `23505` / `40001` / `40P01`),
  and the database ends fully migrated either way. Zero failures is a legitimate outcome, not an
  anomaly — a sufficiently serialized pair sees the high-water mark and the second runner no-ops.
  **Do not build alerting that expects a failure.**

Observed but NOT pinned, and recorded as an observation rather than as behaviour: on the
certification host the concurrent pair does produce a loser every time, with SQLSTATE `23505` raised
from the migrator's first statement. That is one host's timing, not a contract — the assertion above
admits five SQLSTATEs and zero-or-one losers precisely because the racy path is not deterministic.

The loser's cost, when there is one, is a failed boot that a restart fixes. The advisory-locked
shape a future fix should mirror is `tenant-provision.ts`'s `pg_advisory_xact_lock`, exercised at
`tenant-provision.db.test.ts:152-181`.

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
a later deploy. That one boot is enough, and it cannot quietly not-happen: the stamp needs a durable
worker and a task tenant, and BOTH of those are themselves refusals rather than conditions — a
`workforce:` section without `deployment.durableWorker: true` is rejected at the parse with a typed
`schema_violation` (`workforce-lint.ts:670-676`, pinned at
`workforce-parse.negative.test.ts:606-611`), and a declared workforce with `RAYSPEC_CRON_TENANT_ID`
unset aborts the boot (`composition-root.ts:2957-2963`, pinned at
`serve-workforce-flag.db.test.ts`). A deploy that declares a workforce and comes up has therefore
stamped it.

## Backup and restore

**The core ships no backup tool** — no scheduler, no snapshot command, no continuous WAL archiving,
and no point-in-time recovery. `packages/compose/api-auth/src/engine/deploy.ts:68-77` says so at the
deploy boundary ("Backup/PITR is deferred"), and nothing in this repo emits or reads a dump. What a
self-hoster runs is stock Postgres.

What this page can promise is narrower, and it is tested: the shipped **workforce task graph and its
journal** survive one `pg_dump`/`pg_restore` round trip **byte-for-byte**, and the restored database
**resumes**. That scope is exact and is the scope the census measures — the nine `workforce_*` tables
plus both `run_events` namespaces, for one tenant — not "the whole database": the other core platform
tables (`orgs`, `users`, `sessions`, `runs`, `journal_steps`, `conversation_items`, `tenant_events`)
are carried by the same dump but are not what this page's oracle checks.
`backup-restore.db.test.ts` is that proof end to end, against a database holding a
`queued` task, a turn in flight, three parks (an approval wait, a review wait, and the structural
`awaiting_children` one), the three terminal shapes, and their transitions, signals, delegations,
approvals, reviews, messages, ledger rows and journal entries in **both** `run_events` namespaces.

### The two commands

```bash
# BACK UP — against a LIVE deployment. pg_dump reads inside one repeatable-read snapshot, so a turn
# that commits while the dump runs is either wholly in it or wholly out of it, never half of each.
# That is Postgres's guarantee, not one this repo adds.
pg_dump -Fc -d "$DATABASE_URL" -f "workforce-$(date -u +%Y%m%dT%H%M%SZ).dump"

# RESTORE — into a database that does not exist yet. Never on top of the live one.
psql "$ADMIN_DATABASE_URL" -c 'CREATE DATABASE rayspec_restored'
pg_restore --exit-on-error --no-owner --no-privileges \
  -d "postgres://…@…/rayspec_restored" workforce-….dump
```

Then point `DATABASE_URL` at the restored database and boot normally. `--no-owner --no-privileges`
let the restore land under whatever role the new host uses instead of failing on a role that does
not exist there.

**What `--exit-on-error` does, and what it does not do.** It does **not** rescue the exit code:
`pg_restore` exits **1** when it hits an error either way, so `$?` is a reliable signal with or
without the flag — check it, and do not skip checking it because the flag is present. What the flag
changes is **where the restore stops**, and therefore how quickly you can name what went wrong.
Measured against `pg_restore` 16.13, restoring a three-table dump into a database where the first
table already existed:

| | exit | what landed |
|---|---|---|
| clean restore, either way (the control) | 0 | everything |
| error, **without** the flag | 1 | everything it could — it presses on, then reports the damage as a single `warning: errors ignored on restore: 2` at the end of a long log |
| error, **with** the flag | 1 | it halts at the first failure, so the two later tables were **never created at all** |

So the flag leaves you with *less*, on purpose: an obviously incomplete database and an error
message sitting at the point of failure, rather than a nearly-complete one whose one missing piece is
summarized in a line that scrolls past. For a task graph that is the trade you want — a restore that
is visibly unfinished is recoverable, and one you believe is complete is not. Pass the flag, and
still check `$?`.

### The two values that decide whether the restore is usable

Every row surviving is the easy half, and it is not the half that goes wrong. Two counters decide
whether the restored graph can be *worked*, and both compare equal to "the table has the right
number of rows":

- **`workforce_tasks.version`** — the optimistic CAS token `applyTransition` compare-and-swaps on.
  Lose it and every row is present while no parked task can ever be claimed again.
- **`workforce_tasks.last_event_seq` and `workforce_runtime.last_event_seq`** — the journal sequence
  HEADs. Allocation rides the owning row's own counter (`events.ts:125-134` for a task stream,
  `:147-158` for the workforce control stream), and `run_events` carries
  `UNIQUE(tenant_id, run_id, seq)` (`0004_run_events.sql:36`). A restore that reset a counter would not
  fail at restore time; it would fail on the very next append, as a duplicate key, in the last place
  an operator would look.

`backup-restore.db.test.ts` asserts both on their own terms rather than leaving a row-count
comparison to imply them, and it carries the negative arms that give those assertions teeth: a
restore with the version reset, a restore with a journal head lost (which reds with SQLSTATE `23505`
on `run_events_tenant_run_seq_idx`), and a restore missing one table's rows.

### What the restore does, and what it does not carry

| | |
|---|---|
| **All nine `workforce_*` tables and both `run_events` namespaces** | Byte-identical — the oracle is an md5 over the ordered full row text, not a count. |
| **The applied-migration ledger** (`drizzle.__drizzle_migrations`) | Travels with the dump, so the restored deployment's boot migrator is a no-op rather than an attempt to re-apply the whole chain. |
| **A `queued` task** | Dispatches on the restored database through the shipped reserve pass. |
| **A park** | Stays parked, at the version it was parked at. The structural `awaiting_children` park has no operator exit at all, and it does not acquire one across a restore. |
| **A terminal task** | Untouched, whole-row. |
| **A turn IN FLIGHT at dump time** | Comes back as a `working` row whose workflow no longer exists — see below. It is re-queued, not stranded. |
| **The DBOS system database** | **NOT in the dump.** It is a separate database (`executor.ts:119-124`), so a dump of the application database does not contain it, and the restored deployment starts with an empty one. |
| **Secrets** | Not in the database at all. Restoring under freshly minted secrets has consequences for copied API keys and issued tokens — see [Restore and key rotation](./ARCHITECTURE.md#restore-and-key-rotation). |

**Why the missing DBOS system database is safe, and what it costs.** A claim is an application row,
so it travels; the workflow behind it does not. On the restored deployment the sweep asks the engine
whether the claim's workflow id is still live, finds it absent, and treats absent the same as dead:
it re-queues the task through the one status door and releases the claim's budget reservation in the
same transaction (`task-scheduler.ts:936-972`, inside `runSweep`). A fresh dispatch of the same turn is safe because
turn handlers are effect-free and the receipt guards double application — the same property that
makes crash recovery safe. The cost is one repeated turn's model spend, and the reap is journaled:
the re-queue carries `queueReason: turn_reaped`, so an operator can see afterwards which tasks the
restore re-ran rather than resumed. `backup-restore.db.test.ts` seeds exactly this shape — a claim
minted with the shipped `taskTurnWorkflowId` — and asserts the reap, the reason, and that the same
sweep leaves a not-yet-due approval alone.

**Restoring is not a rollback.** The dump carries the schema it was taken at, and the boot migrator
described above then applies whatever is still pending — forward, because there are no
down-migrations to apply (`deploy.ts:70`). So restoring an older dump under a newer deployment moves
the schema *towards* that deployment and never backwards. It also does not soften the redeploy gate:
the restored rows are live work, and `assertWorkforceSpecCompatible`
(`workforce-boot.ts:93-101`) reads them at the next boot and refuses a document that would strand any
of them, naming the stranded task ids — pinned at `workforce-boot.db.test.ts:110-113`.

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
- **[Workforce extension seams](./workforce-extension-seams.md)** — the five replaceable interfaces,
  what each may decide, and what refuses an implementation that reaches past it.
- **[CLI reference → workforce](./cli-reference.md#workforce--operate-the-durable-task-engine-of-a-running-deployment)**
  — the operator console.
