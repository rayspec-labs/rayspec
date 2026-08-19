# Workforce extension seams — an out-of-tree sample

> **LOCAL / trusted posture / NOT internet-facing** — like every example in this directory.

Five implementations of the five workforce extension seams, written the way a deployment outside
this repository would write them: one dependency (`@rayspec/core`), imported by its package name,
resolved through its `exports` map to its built entry. No engine file is patched, no `packages/`
path is referenced, and no relative import leaves this directory.

| File | Seam | What it decides differently from the shipped default |
|---|---|---|
| `src/separator-strategy.ts` | `OrchestrationStrategy` | Splits the goal on a declared separator and chains the pieces, instead of one step for the whole goal |
| `src/least-loaded-selector.ts` | `WorkerSelector` | Balances assignments across qualified candidates, instead of taking the first in declaration order |
| `src/keyword-memory.ts` | `WorkforceMemoryProvider` | Actually recalls, ranked by keyword overlap, instead of returning nothing |
| `src/queued-approvals.ts` | `ApprovalProvider` | Parks a real ticket on a drainable queue, instead of failing closed |
| `src/department-cost-policy.ts` | `CostPolicy` | Adds a per-department ceiling on top of the deployment's own ledger policy |

## What the test proves, and what it does not

`src/contract.test.ts` runs `runSeamContracts` — the same conformance kit `@rayspec/core`'s own
suite runs against the shipped defaults — plus three structural arms:

1. **Out of tree.** It reads this package's sources and fails if any import starts with `../`, names
   a `/src/` or `/dist/` path, or names a workspace package other than `@rayspec/core`.
2. **Against the built entry.** It resolves `@rayspec/core` and fails unless the resolved file is the
   package's `dist/index.js`.
3. **Conforming.** Every seam passes every contract property, and every seam is confirmed to have
   actually been run — an absent subject contributes no results rather than a pass.

What a green run does **not** prove is that any of these five are good at their job. The contract kit
checks structural obligations — boundedness, dependency direction, candidate membership, ticket
status, decision shape — and deliberately not decision quality. It also does not exercise the
engine-side authority checks, which need facts this package cannot see: whether an owner is declared
is settled by the goal intake, and whether spend is affordable is settled by the durable ledger.

## Running it

```bash
pnpm --filter @rayspec/workforce-extension-example test
pnpm --filter @rayspec/workforce-extension-example typecheck
```

Both run in CI. This package is named `@rayspec/*` rather than `@spike/*` precisely so the
`--filter='!@spike/*'` exclusion cannot reach it: a sample whose passing is unenforced would be a
claim, not a proof.

## Where the boundary is written down

`docs/workforce-extension-seams.md` — what each seam may decide, what it may see, and what it can
never do, with the mechanism that enforces each line.
