# Repository Maintainers — the worked large workforce example

Three departments, nine employees: issue triage, release-notes drafting, docs review, and
competitive monitoring, declared as one `workforce:` document with real budgets, two review
policies, a cross-functional team, and a human approval gate on anything public.

## What's here

- `rayspec.yaml` — the document.
- `PRD.md` — the plain-language brief, including what is deliberately out of scope.

## Validate (no DB, no deploy)

```
RAYSPEC_EXPERIMENTAL_WORKFORCE=1 node packages/app/cli/dist/index.js doctor examples/workforce-maintainers/rayspec.yaml
```

Without the flag the same command refuses the document with the typed
`experimental_section_disabled` error.

## Honest scope

- This example is **parse- and lint-proven in CI** (`workforce-examples.test.ts`): it is a valid
  document under the flag and refused without it. It is NOT driven end-to-end in CI — the
  smaller `examples/workforce-starter/` carries the executed ten-step acceptance story, and
  every mechanism this document declares (delegation, reviews, approvals, budgets, teams) is the
  same engine that story proves.
- Operating it against a real repository (feeding it issues, publishing its drafts) is a
  deployment exercise this example deliberately does not include.

> **LOCAL / trusted posture / NOT internet-facing** — the separate hardening layer (per-tenant
> sandbox, RLS, KMS-DEK, DPoP) is the gate before any external exposure. Never put this behind a
> public address.
