# Workforce extension seams

The workforce runtime has five places where a deployment can replace the JUDGMENT without touching
the engine: how a goal becomes a plan, who a task goes to, what a turn remembers, how an approval is
routed, and whether spend is allowed. Each is a plain TypeScript interface exported from
`@rayspec/core`, each ships with a deterministic default that is always present, and each has an
authority boundary that is written down below and checked in code.

This page is for whoever writes the replacement. It says what each seam may decide, what it is
allowed to see, and what it cannot do — and for every "cannot", it names the mechanism that refuses
and the test that drives it. Where nothing refuses yet, it says that too, in the same words.

A working sample of all five lives at `examples/workforce-extension/`. It depends only on
`@rayspec/core`, imports only that package's entry, and runs the same conformance kit this page
describes.

---

## 1. The boundary in one table

| Seam | May decide | May see | Cannot do |
|---|---|---|---|
| `OrchestrationStrategy` | The SHAPE of a plan: how many steps, what each says, which declared seat owns each, the dependency order | The goal, who submitted it, the workforce id, the default owner | Name a seat the workforce does not declare · book a department its owner does not belong to · depend on a later step · exceed the plan or title bounds · write a row |
| `WorkerSelector` | Which ONE of the given candidates gets the task, and why | The task's id, required capabilities and department; the candidate list the caller already filtered | Return anyone outside the candidate list · return someone lacking a required capability · answer when the list is empty |
| `WorkforceMemoryProvider` | What prior material is relevant, and its rank | The query text, an optional workforce id, an optional limit | Exceed the limit it was given · exceed the recall ceiling · instruct a later turn (its output renders as neutralized data) · write a task |
| `ApprovalProvider` | Where a question goes and what the ticket is called | The task, requester, approver, reason, timeout and timeout fate | Return a decision — `request` may only ever yield a PENDING ticket |
| `CostPolicy` | Whether to raise an ADDITIONAL objection to a proposed turn, and what its own accounting records | The task and root ids, workforce, department, the estimate, and the settled actual | Authorize spend the deterministic baseline denied · widen a ceiling · write or alter the durable ledger the baseline settles |

Two properties hold across all five and are checked directly against the interface sources by
`packages/kernel/core/src/seam-wiring.test.ts`:

- **No seam receives a capability.** The five interface modules import nothing at all — every input
  is plain data, so there is no database handle, blob store or transaction for an implementation to
  reach through. (`'no seam interface imports anything'`.)
- **No seam can assert a tenant.** No type any seam touches carries a tenant field, in either
  direction. (`'no seam type carries a tenant'`.) For the one seam that runs before tenant-scoped
  work, the intake reconciles the tenant and the workforce id BEFORE calling it
  (`packages/app/server/src/workforce-goal-intake.ts:97-98`), which
  `workforce-goal-intake.db.test.ts` pins as `'reconciles tenant and workforce BEFORE the strategy
  runs'`.

**On granting tools.** No seam has a tool surface. A turn's native toolset is derived from the
employee's declared role — `TOOLSETS_BY_ROLE[employee.role]`
(`packages/kernel/workforce-tools/src/toolset.ts:835`), assembled at
`packages/app/server/src/workforce-turn-handlers.ts:139`. The one indirect influence is real and
worth stating precisely: an `OrchestrationStrategy` chooses which declared seat owns a step, and a
seat's role determines its toolset. So a strategy selects among the toolsets the workforce already
declared; it cannot invent a seat, and it cannot change what a seat's role is allowed to call.

---

## 2. Seam by seam

### `OrchestrationStrategy` — goal to plan

`packages/kernel/core/src/orchestration-strategy.ts:39`. Default: `SingleTaskPlanStrategy` (`:49`) —
the whole goal as one step for the default owner.

**Wired.** Its production caller is the goal intake
(`packages/app/server/src/workforce-goal-intake.ts:100`); a composition supplies a replacement
through `assembleServer`'s `orchestrationStrategy` option, which has no environment path, so a
production entrypoint always runs the shipped default unless an embedder passes one
(`packages/app/server/src/composition-root.ts:3475`).

**What refuses an over-reaching plan:** `planRefusal`
(`packages/app/server/src/workforce-goal-intake.ts:49`) validates the returned plan against the
DECLARED workforce and the row bounds, and it runs before the first insert. The whole plan is then
created in one transaction, so a refused plan writes zero rows and a multi-step plan is never
half-born. Each of these is a driven cell of `'refuses every over-reaching plan shape typed, with
ZERO rows'` in `workforce-goal-intake.db.test.ts`, and each asserts the zero-row outcome:

| Over-reach | Refused because |
|---|---|
| An owner the workforce does not declare | the employee is not in the declared config |
| A department the owner does not belong to | department is ledger attribution, not a free field |
| A dependency on a later step, on itself, on a fractional or negative index | `dependsOn` may name only strictly prior steps |
| More dependencies than a row carries | `MAX_TASK_DEPENDENCIES` |
| A title outside `1..MAX_TASK_TITLE_CHARS`, or an empty goal | the row bounds, pre-checked against the same exported constants the creation schema uses |
| A plan with no steps | there is nothing to create |
| A plan wider than `SEAM_MAX_PLAN_STEPS` | one submitted goal may not become an unbounded write |

The step ceiling is `SEAM_MAX_PLAN_STEPS = 64` (`packages/kernel/core/src/seam-contracts.ts:61`),
enforced at `packages/app/server/src/workforce-goal-intake.ts:58`. **64 is a conservative round
number, not a derived one** — far above what the shipped default produces (one step) and far below a
write that could hurt. Decomposition of any real width belongs to the orchestrator's own turns
through `delegate_task`, where each new task crosses the dispatch boundary and draws on its own
budget; the ceiling exists to stop a runaway, not to express a recommended plan size.

### `WorkforceMemoryProvider` — recall

`packages/kernel/core/src/memory-provider.ts:34`. Default: `EmptyRecallMemoryProvider` (`:45`) —
returns nothing and retains nothing, on purpose, so every consumer is tested against an empty recall.

**Wired, with one qualification.** It is called at
`packages/app/server/src/workforce-turn-handlers.ts:187`; the injection point is the
`memoryProviderFor` (`:73`) dependency. The composition root does not pass it
(`packages/app/server/src/composition-root.ts:3462` calls `buildWorkforceTurnHandlers` without it),
so a boot always gets the shipped `TaskHistoryMemoryProvider` — the seam is injectable by an embedder
that composes the turn handlers itself, not by configuration.

**What contains an over-reaching provider,** at the render site rather than at the seam, because
neutralization has to match the document being rendered into:

- **Hit text cannot forge structure.** Each hit renders through `sanitizeUntrusted`
  (`packages/kernel/workforce-tools/src/context.ts:655`), which strips every line-boundary and
  control character, so a hit cannot begin a line and therefore cannot place a column-0 section
  header or a forged data-boundary line. Driven by `'C1: an untrusted recall hit cannot forge the
  data-boundary line'` in `context.test.ts`, which asserts exactly one boundary line and exactly one
  `## 4. Task` header survive while the injected words remain, flattened onto the recall line.
- **The section is byte-bounded and droppable.** `SECTION_BUDGETS.recall` is 4096 bytes
  (`packages/kernel/workforce-tools/src/context.ts:76`), and recall is section 7 — the first thing
  dropped when the whole input is over ceiling
  (`packages/kernel/workforce-tools/src/context.ts:700-701`).
- **The hit COUNT is capped** at `SEAM_MAX_MEMORY_HITS = 64` before rendering
  (`packages/kernel/workforce-tools/src/context.ts:645`), with the drop announced under its own
  marker. This exists because the byte-budget loop re-measures the whole block once per dropped hit:
  the budget was always honored, but honoring it cost time quadratic in what the provider returned.
  Measured on this checkout before the cap: 1 000 hits rendered in 0.2 ms, 5 000 in 1.2 s, and 20 000
  in 30.8 s of CPU inside a pure function; the reviewer measured the same shape on different hardware
  (1.0 ms / 1 005.7 ms / 21 381.8 ms). The shipped provider's own ceiling is `RECALL_MAX_HITS = 10`
  (`packages/kernel/workforce-tools/src/memory.ts:39`), so nothing shipped changes. Driven by
  `'caps the hits it will render, whatever the provider returned'`.

### `WorkerSelector` — assignment

`packages/kernel/core/src/worker-selector.ts:53`. Default: `CapabilityMatchSelector` (`:63`) — the
first candidate holding every required capability, preferring a department match, in declaration
order; a typed `WorkerSelectionError` when nobody qualifies.

**Not wired.** There is no production call site anywhere in `packages/**`, which
`seam-wiring.test.ts` measures rather than assumes (`'WorkerSelector has NO production reference
outside its own module'`).

### `CostPolicy` — spend authorization

`packages/kernel/core/src/cost-policy.ts:53`. Shipped implementation: `LedgerCostPolicy`
(`packages/kernel/tasks/src/budget.ts:551`), the deterministic ledger check bound to one tenant
handle and one validated budgets declaration.

**Not wired as a seam.** The interface has a shipped implementation, which is not the same as a call
site: nothing constructs `LedgerCostPolicy`, and the engine's budget path calls the underlying
authorize/settle functions directly. Both halves are measured by `'CostPolicy is IMPLEMENTED in the
task engine and never constructed'`, which pins the exact two files that name it and asserts zero
constructions.

### `ApprovalProvider` — human decisions

`packages/kernel/core/src/approval-provider.ts:45`. Default: `UnroutedApprovalProvider` (`:57`) —
both operations throw a typed `ApprovalUnroutedError`, so a composition with no decision surface
fails loudly instead of fabricating a ticket.

**Not wired.** No production call site, measured by `'ApprovalProvider has NO production reference
outside its own module'`. The durable engine has its own persistent, swept, CLI-decidable
implementation over the approval rows; it does not travel through this interface.

### `ReviewPolicy` — a default without a seam

`packages/kernel/core/src/review-policy.ts:69`, default `DeclaredReviewPolicy` (`:80`). It is
constructed from the declared config at `packages/kernel/workforce-tools/src/review-policy.ts:76`
and there is **no injection point** — a deployment cannot replace it. It is listed here so its
absence from the seam set is a stated fact rather than an omission.

---

## 3. The confinements

`packages/kernel/core/src/seam-confinement.ts` turns each interface's prose contract into a check on
the returned value. One rule runs through all of them:

- **AUTHORITY is REFUSED.** An identity, an approval status, a spend decision, a hit's score: wrong
  means a typed `SeamConfinementError` (`:52`) naming the seam and the property.
- **SIZE is CLAMPED.** A selection rationale, a recall hit count: these decide nothing, and refusing
  on them would hand an extension a denial of service — one oversized string and the turn dies.

| Helper | What it makes structurally impossible | Driven by |
|---|---|---|
| `confineWorkerSelector` (`:75`) | Returning a non-candidate; returning someone lacking a required capability; answering on an empty list | `'REFUSES a selection naming someone outside the candidate set'`, `'REFUSES a selection lacking a capability the task requires'`, `'REFUSES an empty candidate list before the inner selector can answer at all'` |
| `confineCostPolicy` (`:221`) | Turning a baseline denial into an allow — the baseline is asked first and its denial returns verbatim, so the extension is not even consulted. Settlement is the baseline's authoritatively; the extension's own is advisory and its failure cannot roll the ledger back | `'an extension may NOT allow what the baseline denied'`, `'a widened ceiling in the extension changes nothing'`, `'the extension is never consulted once the baseline has denied'`, `"a FAILING baseline settlement surfaces — it is the turn's real settlement"` |
| `confineApprovalProvider` (`:248`) | Returning any status but `pending`; returning an unparseable timestamp or an unbounded ticket id | `'REFUSES a provider that answers its own question'`, `'REFUSES an unparseable requestedAt'` |
| `confineMemoryProvider` (`:307`) | Exceeding the caller's limit or the seam ceiling (clamped); returning a hit with a non-finite score or no id (refused) | `'CLAMPS a flood to the seam ceiling'`, `"CLAMPS to the caller's own limit when it is narrower"`, `'REFUSES a malformed hit'` |

All named tests live in `packages/kernel/core/src/seam-confinement.test.ts`.

**These confinements are NOT WIRED.** Nothing in `packages/**` calls any of them, for the plain
reason that nothing calls the three seams they confine either. They are the checks a call site must
adopt when one is built. Two things keep that from being a promise nobody has to keep: the
confinement for each unwired seam already exists and is driven adversarially, so wiring one is a
wrapping rather than a design exercise; and `seam-wiring.test.ts` turns red the moment any of those
three seams gains a reference in `packages/**`, so the wrapping cannot be skipped quietly.

There is deliberately no `confineOrchestrationStrategy`. That authority is already owned by
`planRefusal`, which needs the declared workforce — facts `@rayspec/core` cannot see. A second,
weaker authority in core would make the guarantee worse, not better.

**What the tripwire does not catch,** in the manner of every greppable guard here: it matches
identifiers in comment-stripped source, so it does not chase aliasing, and it does not do type
analysis, so a structurally-compatible object that never names the interface is invisible to it. What
it does buy is that the ORDINARY way to wire a seam — importing its type or its shipped default —
fails the suite and points here.

---

## 4. The contract kit

`packages/kernel/core/src/seam-contracts.ts` exports a framework-free conformance kit:
`runSeamContracts(subjects)` returns `ContractResult[]`, and `contractFailures(results)` selects the
failures. It imports no test runner, so an implementation outside this repository can run it in
whatever harness it already has.

`seam-contracts.test.ts` runs every property against three arms: the shipped default, a fixture
implementation that decides differently, and — for each property individually — an implementation
that violates exactly that property, which must be reported as failed. The third arm is what makes
the first two mean anything; a kit that passes everything proves nothing about what it passed.

**What a green run does not say.** The kit checks STRUCTURAL obligations. It does not check whether a
decision is good, and it cannot check the authority questions that need facts outside the seam: a
strategy's owners are validated by `planRefusal`, and spend is validated by the durable ledger. The
kit is the seam-side half of conformance and does not replace the engine-side half.

The kit exercises the write halves of the interfaces — `remember`, `settle`, `request`, `cancel` —
because a contract that only reads proves half a seam. Run it against a throwaway deployment.

---

## 5. Writing one

```ts
import { type OrchestrationStrategy, runSeamContracts, contractFailures } from '@rayspec/core';

class MyStrategy implements OrchestrationStrategy { /* … */ }

const results = await runSeamContracts({ orchestrationStrategy: new MyStrategy() });
if (contractFailures(results).length > 0) throw new Error('not conforming');
```

`examples/workforce-extension/` is the same thing at full size: five implementations, one dependency,
and a test that checks the package reaches into no workspace path, resolves `@rayspec/core` to its
built entry rather than its sources, and passes every contract property.
