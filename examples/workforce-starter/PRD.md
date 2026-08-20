# PRD — Workforce Starter

> This is the plain-language brief the document `rayspec.yaml` was authored from: the smallest
> declared workforce that exercises the whole engine — delegation across two departments, an
> enforced review loop, a human approval gate, and crash-safe resumption.

## The product

A release workforce for a small software team. An operator submits one goal ("analyze X and
draft the announcement"); the workforce splits it across Engineering and Growth, reviews the
risky half independently, holds the public wording for a human sign-off, and answers with one
synthesized result. Every step is a durable task row: kill the process at any point and restart
it on the same database, and the story continues where it stood.

## Users & jobs

- **The operator** submits goals (`POST /v1/workforce/starter/goals` or `rayspec workforce
  submit`), decides approvals (`rayspec workforce approvals approve <id>`), and reads progress
  (`rayspec workforce tasks --tree`).
- **The workforce** does the work: seven employees across two departments, one reviewer, one
  team.

## What happens to a goal (the flow)

1. The goal becomes one root task owned by `lead` (the orchestrator seat).
2. `lead`'s turn fans out to `department:eng` and `department:growth` in ONE `delegate_task`
   call; the root parks with no process attached.
3. Each manager sub-delegates to its members; workers submit structured results with honest
   confidence numbers.
4. An engineering submission below confidence 0.8 trips `eng_quality`: the runtime routes it to
   `qa` no matter what the turn asked for. A rejection produces rework; the ceiling is 2 rounds.
5. Publishing work carries the `public_statement` label, and the label is a GATE: a seat holding
   it cannot complete a task without a human decision, whether or not it ever asks. The copywriter
   drafts under it — its result is stored and the task parks — and the growth manager, which holds
   the same label *and* `request_approval`, both asks for a sign-off on the wording and has its own
   merge gated in turn. Every one of those waits is a row at zero cost until a human decides (2h
   window, then `fail` — which on a gate costs a finished result, not just an unanswered question).
6. When every stream lands, `lead` wakes with the results keyed by child task id and submits the
   synthesis; the root completes.

## Rules & posture

- Budgets: $25/day for the whole workforce, $2.50 and 20 turns per task, delegation depth 3,
  fan-out 4 per task, 4 concurrent workers, 30m wall clock per task.
- Review and approval rules are enforced by the runtime — a matched rule fires regardless of
  what a turn submits.
- All seven agents bind one backend so the manual live path needs a single credential.

## Explicitly out of scope (v1)

- Cross-run learning, historical performance routing, semantic memory, cost optimization — the
  built-in orchestration deliberately ships without them (see `docs/workforce-architecture.md`).
- Webhook/event triggers and any recurring schedule: goals arrive by submission.
- More than one workforce per deployment tenant.

## How this maps to the document

| PRD need | Document construct |
| --- | --- |
| One entry seat for every goal | `workforce.orchestrator: lead` |
| Two parallel streams | `departments: eng, growth` + plural `delegate_task` |
| Independent review of risky work | `reviewPolicies[0]` (`eng_quality`, `confidenceBelow: 0.8`, reviewer `qa`) |
| Human sign-off on public wording | `approvalPolicies[0]` (`public_statement_signoff`) + `labels: [public_statement]` on the copywriter and the growth manager (the requesting seat) |
| A team the orchestrator can address whole | `teams[0]` (`release_crew`, led by `mgr_eng`) |
| Spend and depth ceilings | `budgets` + `execution` |
