# Workforce forward compatibility

What the experimental marking on the `workforce:` surface means, what may change, and
what will not — with the mechanism that enforces each statement named beside it.

Read it as literally as it is written. Where this page states a guarantee it names a
test, a gate or a code path you can run. Where it states *no* guarantee, that absence is
the honest position and is deliberately not dressed up: an unbacked promise is worse than
no promise, because it is a promise someone will plan against.

## The short version

`workforce:` is **experimental**. It is not part of the frozen `version: '1.0'` grammar.
Its shape, its validation rules, its event payloads, its HTTP surface and its CLI output
may change in **any** release, including a patch release, and **no deprecation period is
promised**. Nothing on this page walks that back.

What *is* promised is that you will never meet the section by accident, and that the
runtime tells you it is experimental at every surface you can read.

## The flag

`RAYSPEC_EXPERIMENTAL_WORKFORCE` is the one opt-in. Accepted truthy values are `1`,
`true` and `yes` — trimmed, case-insensitive; anything else, including absence, is OFF
(`packages/kernel/spec/src/experimental.ts`, the single derivation every entry point
calls so the truthiness rule cannot drift between surfaces).

**What the flag does.** With it unset, a document that declares `workforce:` is refused
at the spec parse with the typed code `experimental_section_disabled`
(`packages/kernel/spec/src/parse.ts`). The refusal is proven at every CLI entry point by
`packages/app/cli/src/workforce-flag.test.ts` (`doctor`, `plan`, `deploy --dry-run`) and
at boot by `packages/app/server/src/serve-workforce-flag.db.test.ts`.

**What the flag does not do.** It is not a data switch. It is read at the spec parse and
nowhere else; nothing in the task engine consults it, so unsetting it does not remove a
table, stop an approval timeout, or roll back a schema. The full statement of what the
lever does and does not do — including the byte-identity proof over nine tables — is in
[workforce architecture → Upgrade and rollback notes](./workforce-architecture.md#upgrade-and-rollback-notes).
It is not restated here, because two copies of an operational guarantee is one copy too
many.

## Where the marking appears, and what keeps it there

Five surfaces, each with the test or gate that turns red if the marking is deleted. A
marking nothing pins is a marking that can vanish silently, which is why every row below
has a right-hand column.

| Surface | What you see | What keeps it there |
| --- | --- | --- |
| **JSON Schema** | `properties.workforce` in `packages/kernel/spec/spec.schema.json` and on the backend arm of `version-1.0.schema.json` carries `"x-rayspec-experimental": true` plus a `title` and `description` saying so | `gate:spec-schema` byte-compares both committed artifacts against a re-derivation from the grammar; `packages/kernel/spec/src/workforce-experimental-marking.test.ts` asserts the keywords on the **committed files**, not only on the exporter |
| **TypeScript** | every exported symbol of `workforce-grammar.ts`, `workforce-config.ts`, `workforce-lint.ts` and the event vocabulary in `@rayspec/tasks`' `events.ts` carries an `@experimental` TSDoc tag, which your editor shows on hover | `workforce-experimental-marking.test.ts` (spec) and `events-experimental-marking.test.ts` (tasks) check every export in the source **and** in the emitted `dist/*.d.ts` — the file an installed package actually hands your IDE |
| **HTTP** | every response from a `/v1/workforce/*` route carries `X-Experimental: workforce`, including the fail-closed `501` and an unauthenticated `401` | `packages/compose/api-auth/src/routes/workforce-experimental-header.db.test.ts` drives real requests through the app; the header is also in the CORS `exposeHeaders` list, so a browser client can read it |
| **CLI** | `doctor` and `plan` over a document that declares the section print an unmissable banner to **stderr** — `EXPERIMENTAL: this document declares 'workforce:'` — while stdout stays exactly one JSON object | `packages/app/cli/src/workforce-experimental-banner.test.ts` drives the real entry point and asserts the banner reaches stderr and only stderr |
| **Events** | `docs/workforce-events.md` states the vocabulary is experimental, and every event payload carries `v: 1` (`WORKFORCE_EVENT_VERSION`) so a later change is detectable | `packages/kernel/tasks/src/events-experimental-marking.test.ts` pins the paragraph and the version constant |

## What may change without a major version

While the section is experimental, all of the following may change in any release —
minor or patch — with no deprecation window and no compatibility shim:

- the `workforce:` grammar: key names, nesting, closed enum members, and which fields are
  required;
- the validation rules and the `SpecErrorCode` values they raise;
- the event vocabulary in `docs/workforce-events.md` — event types and payload fields
  alike (the `v: 1` stamp exists so a consumer can *detect* the change, not so the change
  is avoided);
- the `/v1/workforce/*` routes: paths, request and response bodies, and status codes;
- the `rayspec workforce` CLI commands, their flags and their JSON output;
- the database tables behind all of it.

There is no mechanism in this repository that prevents any of these, and this page will
not pretend otherwise.

## What is enforced today

These are not stability promises about the future. They are properties of the shipped
release, each with the thing that enforces it — true now, and re-verified on every CI
run:

- **You cannot reach the section by accident.** Absent the flag, the parse refuses
  (`experimental_section_disabled`), at every entry point — see [The flag](#the-flag).
- **The grammar is fail-closed at every level.** Every object level in the `workforce:`
  schema declares `additionalProperties: false`; `gate:spec-schema` walks the whole
  emitted artifact and fails at the exact JSON Pointer of any level that lost it, so an
  unknown key is refused rather than silently accepted.
- **Every event payload is versioned.** `v: 1` is stamped by the vocabulary's one writer
  (`packages/kernel/tasks/src/events.ts`), and the read side drops any stored row outside
  the vocabulary rather than serving it verbatim.
- **A redeploy cannot strand live work.** `assertWorkforceSpecCompatible`
  (`packages/app/server/src/workforce-boot.ts`) refuses a boot whose new document no
  longer declares an employee, department, team or workforce that live non-terminal tasks
  still reference, naming the stranded task ids. It runs before any DDL or mount.
- **Migrations are forward-only.** There are no down-migration files and no rollback
  claim anywhere; recovery from a bad migration is a reviewed forward migration. See
  [workforce architecture → Upgrade and rollback notes](./workforce-architecture.md#upgrade-and-rollback-notes).

## Scope of this page

This page covers the **declared-contract** surface of `workforce:`: the grammar in
`@rayspec/spec` (`workforce-grammar.ts`, `workforce-config.ts`, `workforce-lint.ts`), the
journal event vocabulary in `@rayspec/tasks` (`events.ts`), the `/v1/workforce/*` HTTP
routes and the `rayspec workforce` CLI group.

It does **not** speak for the rest of `@rayspec/tasks`' runtime API (`pauseWorkforce`,
`decideApproval`, the scheduler and its seams). Those symbols are engine internals of the
same experimental feature — treat them as at least as unstable as everything above; they
simply are not what the markings on this page enumerate.

## When the section stops being experimental

Nothing is scheduled and nothing is promised. There is no mechanism in this repository
that emits a notice, a deprecation warning, or a migration when the marking is removed —
so this page does not claim one. What will happen is that this page changes, and the
markings the table above pins are what a consumer can watch: the `x-rayspec-experimental`
keyword disappearing from `spec.schema.json`, the `@experimental` tags disappearing from
the published type declarations, and the `X-Experimental` response header disappearing
from `/v1/workforce/*`. Each of those is a diff you can detect mechanically, which is
more than a promise would be worth.

## See also

- **[Workforce architecture](./workforce-architecture.md)** — the design, the boundaries,
  and the upgrade and rollback notes.
- **[Workforce events](./workforce-events.md)** — the journal vocabulary, versioned.
- **[Spec reference → `workforce` (experimental)](./spec-reference.md#workforce-experimental)** —
  the field-by-field grammar.
- **[CLI reference → `workforce`](./cli-reference.md#workforce--operate-the-durable-task-engine-of-a-running-deployment)** —
  the operator commands.
