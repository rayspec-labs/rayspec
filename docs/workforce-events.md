# Workforce events

The durable task engine's journal vocabulary — the versioned contract an observer (the CLI's
`events` replay, the tree and cost views, or your own consumer) reconstructs a workforce's
history from.

**The contract.** Events land in the append-only `run_events` table: task-scoped events under
`run_id = <taskId>`, workforce-scoped control events under `run_id = workforce:<workforceId>`.
Every event's `data` is `{ v: 1, type, …payload }`. Sequence allocation order equals commit
order per stream, so a `seq > cursor` replay never skips an event that committed late
(`packages/kernel/tasks/src/events.ts` — the vocabulary's one writer). **Adding an event type is
a minor change; changing a payload field documented here is a major one.** The read side is
fail-closed: a stored row outside this vocabulary is dropped by the replay route, never served
verbatim.

**EXPERIMENTAL.** The section that produces these events parses only under
`RAYSPEC_EXPERIMENTAL_WORKFORCE`; the vocabulary below is versioned so it can be consumed
seriously anyway — `v: 1` is in every payload precisely so a later change is detectable.

## The vocabulary

The journal event vocabulary is:

| Event | Stream | Payload fields |
| --- | --- | --- |
| `workforce.task.created` | task | `taskId`, `parentTaskId`, `rootTaskId`, `owner`, `requestedBy`, `goal`, `priority` |
| `workforce.task.queued` | task | `taskId`, `parentTaskId`, `owner`, `requestedBy`, `priority`, `queueReason` — WHY the task (re)queued: `initial` (first queue), `turn_yield` (a turn ended without a turn-ending tool), `tool_error` (the one-retry re-queue after a refused ending), `turn_reaped` (a dead turn the sweeper re-queued), `turn_lease_expired` (a turn the durable engine still reported PENDING whose claim lease ran out — a WEDGED turn, re-queued through the same path and with the same reservation release as a dead one), `review_verdict` (a reject→rework re-queue), or the absorbing SIGNAL KIND (`user_reply`, `approval_decided`, `budget_raised`, … — the wake that re-queued a parked task) |
| `workforce.task.turn_started` | task | `taskId`, `turnNumber`, `turnId` (the dispatched workflow id — the claim), `owner` |
| `workforce.task.turn_ended` | task | `taskId`, `turnId`, `turnNumber`, `outcome` (the applied plan kind), `costUsd`, `classification?` (`direct` \| `delegate` \| `team` \| `review` \| `escalate` — present on orchestrator and manager turns whose typed intent was accepted AND applied as that decision; absent on worker turns, refused endings, and outcomes that refused or overrode the decision itself — a rejected delegation, a consumed cancel. `complete_with_review` keeps it: the decision stood and policy added review. Derived server-side from the typed intent, never from model prose; the engine enforces the presence rule, so no caller can journal a decision that never existed) |
| `workforce.task.transitioned` | task | `taskId`, `from`, `to`, `statusReason`, `actor` |
| `workforce.task.completed` | task | `taskId`, `statusReason`, `resultSummary`, `confidence`, `totalCostUsd`, `turnsUsed` |
| `workforce.task.failed` | task | `taskId`, `statusReason`, `resultSummary`, `confidence`, `totalCostUsd`, `turnsUsed` |
| `workforce.task.cancelled` | task | `taskId`, `statusReason`, `resultSummary`, `confidence`, `totalCostUsd`, `turnsUsed` |
| `workforce.task.dependency_failed` | task | `taskId`, `dependencies` (the prerequisite ids that ended `failed`/`cancelled`) |
| `workforce.approval.requested` | task | `approvalId`, `taskId`, `question`, `options`, `approver`, `onTimeout` (+ `escalatedFrom` when the request is the escalation of a timed-out approval) |
| `workforce.approval.decided` | task | `approvalId`, `taskId`, `decision`, `decidedBy` (the VERIFIED principal — the route derives it from the credential), `reason` |
| `workforce.approval.timed_out` | task | `approvalId`, `taskId`, `onTimeout`, `escalateTo` |
| `workforce.review.requested` | task | `reviewId`, `taskId`, `reviewer`, `round`; a request that DISPATCHES a reviewer turn additionally carries `policy` (`true` when a matched policy intercepted the completion, `false` when the turn asked) and `reviewTaskId`; a request routed to a human carries neither |
| `workforce.review.decided` | task | `reviewId`, `taskId`, `reviewer`, `round`, `verdict`, `decidedBy`, `reasons`, `requiredChanges`, `outcome` (what the verdict did to the task) |
| `workforce.review.abandoned` | task | `taskId`, `reviewId`, `reviewTaskId`, `reviewer`, `round`, `reviewTaskStatus`, `outcome` — the dispatched review task ended terminal WITHOUT a verdict; the reviewed task is released to a human rather than stranded, and no verdict is fabricated |
| `workforce.delegation.accepted` | task (parent) | `parentTaskId`, `childTaskId`, `delegatedBy`, `delegatedTo` (what was ADDRESSED — `employee:`/`department:`/`team:`), `resolvedOwner` (who answers for it), `depth`, `goal` |
| `workforce.delegation.rejected` | task (parent) | `parentTaskId`, `childTaskId`, `delegatedBy`, `delegatedTo`, `resolvedOwner`, `reason` (`depth_exceeded` \| `fanout_exceeded` \| `self_delegation` \| `delegation_cycle`), `detail` |
| `workforce.budget.reserved` | task | `taskId`, `turnNumber`, `turnId`, `estimateUsd`, `reservedAt` — the claim's own durable reservation record; the reaper's release reads exactly this entry back |
| `workforce.budget.settled` | task | `taskId`, `estimateUsd`, `actualUsd`, `turnNumber` |
| `workforce.budget.exceeded` | task | TWO shapes. The exceedance itself, on the OFFENDING task: `taskId`, `scopeKind` (`task` \| `root` \| `department` \| `workforce`), `scopeId`, `ceiling`, `consumed`, `onBudgetExhausted`. On the `block_and_escalate` path a SECOND `budget.exceeded` lands on the ROOT: `taskId` (the root), `escalatedFrom` (the offending task), `scopeKind`, `scopeId`, `unblock` (the human-facing remedy) — and NOT `ceiling`/`consumed`/`onBudgetExhausted` |
| `workforce.budget.escalation_deferred` | task (root) | `taskId`, `escalatedFrom`, `scopeKind`, `scopeId`, `park`, `surfacesWhen` — an exceedance whose escalation the root's park refused; for a structural park this event is the whole notification |
| `workforce.control.paused` | workforce | `workforceId`, `actor`, `drain` |
| `workforce.control.resumed` | workforce | `workforceId`, `actor` |
| `workforce.control.halted` | workforce | `workforceId`, `actor`, `reason`, `affectedTaskCount` |
| `workforce.message.sent` | task | `taskId`, `sender`, `recipient`, `bodyLength` — WHO and HOW MUCH, never the body (the body is context for later turns, not journal material) |
| `workforce.escalation.raised` | task | `taskId`, `escalationTaskId`, `escalateTo`, `reason` (the closed escalation set), `detail` |

## Reading the journal

- `GET /v1/workforce/tasks/:id/events` replays one TASK's stream as SSE, resumable by
  `Last-Event-ID`; `rayspec workforce events <task-id>` is the same replay parsed to JSON.
- The tree and cost views read the same durable rows — there is no shadow observability system,
  so what an event says and what a view shows can never come from two places.

**Honest scope — what the shipped surface does NOT replay.** The only replay endpoint reads the
TASK stream (`run_id = <taskId>`). The root-scoped budget-escalation events ARE replayable: they
are written under `run_id = <rootTaskId>`, so the root task's own events endpoint serves them. What
has no reader is the workforce-scoped **`workforce.control.*`** events (`paused`/`resumed`/`halted`,
written under `run_id = workforce:<workforceId>`): they are DURABLY WRITTEN with the same versioned
vocabulary, but the reference orchestration ships no reader that replays the `workforce:<workforceId>`
stream — a consumer that wants control history reads that `run_id` from `run_events` itself.
Documenting the control vocabulary here is a forward contract for such a consumer, not a claim that a
shipped endpoint serves it.

## Notable semantics

- **`turn_ended.classification`** is the decision-seat signal: which way an orchestrator or
  manager turn moved its task, computed from the validated intent the toolset collected. A
  refused ending (`outcome: invalid_intent`), a rejected delegation, and a consumed cancel all
  carry none — the engine suppresses the field wherever the named decision did not stand, so
  model bytes never classify anything and the journal never claims a decision that never was.
- **`review.decided` beside `turn_ended`**: when a matched policy intercepts a completion, the
  turn's journal shows both facts at once — `classification: direct` (what the seat chose) and
  `outcome: complete_with_review` (what the engine enforced).
- **`budget.reserved` is load-bearing, not telemetry**: the reaper releases a dead turn's
  reservation by reading this exact entry back (amount and window), refusing to guess either.

## See also

- **[Workforce architecture](./workforce-architecture.md)** — the lifecycle these events narrate.
- **[Spec reference → workforce](./spec-reference.md#workforce-experimental)** — the grammar.
- **[Workforce tools](./workforce-tools.md)** — the toolsets whose calls become these events.
