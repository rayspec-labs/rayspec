# Workforce Starter — the smallest declared workforce that runs the whole engine

Two departments, seven employees, one team, one review policy, one human approval. This is the
document the workforce acceptance story deploys byte-for-byte in CI, and the worked example the
spec reference quotes.

## What's here

- `rayspec.yaml` — the document (its `workforce:` block is deliberately the final section; the
  spec reference quotes it verbatim and a CI test keeps the two identical).
- `PRD.md` — the plain-language brief, including what is deliberately out of scope.
- `live-story.sh` — the manual live path (real model calls; never runs in CI).

## Validate (no DB, no deploy)

```
RAYSPEC_EXPERIMENTAL_WORKFORCE=1 node packages/app/cli/dist/index.js doctor examples/workforce-starter/rayspec.yaml
```

Without the flag the same command refuses the document with the typed
`experimental_section_disabled` error — that refusal is a feature: the `workforce:` section is
experimental, and nothing parses it by accident.

## Drive it end-to-end — deterministic (the CI-proven path)

The ten-step acceptance story — deploy this file, submit a goal, fan out to both departments,
review-reject-rework-accept, park on the approval, **SIGKILL the process and restart it on the
same database**, approve through the real CLI, synthesize, and render the tree — runs as
`packages/app/cli/src/workforce-story-e2e.db.test.ts` on every CI run, with scripted backends
standing in for the models. What that test asserts is this file's actual behavior; if the two
ever disagree, CI is red.

## Live path (manual)

`./live-story.sh` runs the same story against real model backends when `OPENAI_API_KEY` and
`DATABASE_URL` are present, and self-skips otherwise. It is the manual acceptance path — CI
never runs it, and its transcript depends on the model.

## Honest scope

- The deterministic story above is the CI-proven claim; the live path is smoke-proven only.
- The built-in orchestration is deliberately bounded: no cross-run learning, no historical
  performance routing, no semantic memory (recall is recency + keyword over this tenant's own
  rows), no cost optimization. `docs/workforce-architecture.md` states each boundary and the
  mechanism behind it.

> **LOCAL / trusted posture / NOT internet-facing** — the separate hardening layer (per-tenant
> sandbox, RLS, KMS-DEK, DPoP) is the gate before any external exposure. Never put this behind a
> public address.
