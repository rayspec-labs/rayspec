# PRD — Repository Maintainers

> This is the plain-language brief the document `rayspec.yaml` was authored from: a
> repository-maintenance workforce — the recurring work a busy open-source repository
> accumulates, declared as an organization instead of a pile of scripts.

## The product

Three departments, nine employees. Issue triage classifies and reproduces incoming reports;
Documentation keeps the reference precise and drafts release notes; Competitive Watch tracks
comparable tools on its own small budget. A maintainer submits goals ("triage today's issues",
"draft the 1.x release notes", "what changed in comparable tools this month?") and decides the
approvals that gate anything public.

## Users & jobs

- **The maintainer** submits goals, decides `public_statement` approvals, and reads
  `rayspec workforce tasks --tree` / `cost --by department` to see where time and money went.
- **Issue Triage** (`mgr_triage`, `issue_analyst`, `repro_engineer`): classify severity and
  area; attempt minimal reproductions. Every reproduction claim is independently reviewed —
  `repro_engineer` holds `repro_required`, and the `triage_repro` rule fires on every one of its
  completions, unconditionally.
- **Documentation** (`mgr_docs`, `release_notes_writer`): reference precision and release
  notes. Low-confidence writing routes to `senior_reviewer` (`confidenceBelow: 0.85`); release
  notes additionally end in a human approval — the drafts carry `public_statement`, and
  `mgr_docs` (who holds the label and the `request_approval` tool) asks for the sign-off before
  anything ships.
- **Competitive Watch** (`mgr_watch`, `market_watcher`): monitoring on a tight department budget
  ($5/day inside the workforce's $60/day) — the ledger blocks the department without touching
  the others.

## Rules & posture

- Budgets: $60/day workforce-wide, $3 and 25 turns per task, watch capped at $5/day, delegation
  depth 3, fan-out 6, 6 concurrent workers, 45m wall clock, 3 review rounds.
- The `release_notes_crew` team (led by `mgr_docs`, pairing the release-notes writer with the
  analyst on loan from triage) is how the orchestrator addresses release-notes work as one unit
  — teams are deliberately cross-functional.
- The approval escalates on timeout (1d) up the reporting line instead of failing silently.

## Explicitly out of scope (v1)

- Any recurring schedule: goals arrive by submission. (Cron/webhook operation is a deployment
  decision, not part of this example.)
- Repository write access: this workforce ANALYZES and DRAFTS; humans merge, label and publish.
- Cross-run learning, performance routing, semantic memory, cost optimization — deliberately
  absent from the built-in orchestration (see `docs/workforce-architecture.md`).

## How this maps to the document

| PRD need | Document construct |
| --- | --- |
| Three maintenance disciplines | `departments: triage, docs, watch` |
| Every reproduction claim reviewed | `labels: [repro_required]` + `reviewPolicies[1]` (`triage_repro`) |
| Writing quality gate | `reviewPolicies[0]` (`docs_quality`, `confidenceBelow: 0.85`) |
| Human sign-off on public wording | `approvalPolicies[0]` + `labels: [public_statement]` on the writer and the requesting manager |
| Watch spends only its allowance | `departments[watch].budgets` (`usd: 5, window: daily`) |
| Release notes as one addressable unit | `teams[0]` (`release_notes_crew`) |
