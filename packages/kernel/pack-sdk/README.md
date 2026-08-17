# @rayspec/pack-sdk

The **one** surface an out-of-tree extension pack compiles against: the manifest types for
every contribution kind, the contract the handler modules those declarations point at are
written against, the closed error vocabulary a pack author branches on, the identifier
rule, and the journal entries a pack's work is recorded as.

**Types only.** A pack receives every runtime object by injection at boot, so it never
needs to import one. The single executable export is `isSafeIdentifier`, because the rule
it checks — a pattern bounded by a length — cannot be written as a type. Nothing here
re-exports an implementation, which is what keeps an internal refactor from becoming a
silent break for every pack.

A pack's **entry** module builds its manifest with the platform's manifest helper — which
typechecks the full document grammar at the pack's own edge — and names `DefinedPack` from
this package for what it exports. A pack's **handler** modules run with injected
capabilities, and the contract they are written against is here too: `PackToolHandler` for
the module a `tooling` contribution points at, `PackRouteHandler` for an `api` one served
behind a `{kind:'handler'}` action, and the
init each receives — the invocation's server-derived tenant and `PackStoreDb`, the
name-keyed door onto the declared stores, plus what the request carried on a route. A
route's init carries two further doors: `PackJournalReader`, a typed, tenant-scoped,
bounded read with a stable cursor over the run journal a pack's work is recorded in — so
reading back what was written never means naming a core table in a SQL string — and
`PackSseResponder`, the injected constructor for an **incremental** response, with the
request's resume cursor beside it, so a client that reconnects continues where it stopped
instead of replaying from zero. What a
pack handler does **not** receive — and which declarable shapes are **not** contracted here
(a `trigger`, and a `route`-kind handler behind a `{kind:'stream'}` action, which exchanges
a raw `Request`/`Response` and needs the blob backend) — is stated in the same place, with
the reason. A pack's
**service** modules — the one contribution kind the deployment boots rather than calls —
are typed against `PackServiceModule`: what they receive is a boot context rather than a
per-invocation init, and it carries `TurnDispatch`, the capability a handler may not even
name, and `PackDatabase`, the parameterized-SQL door onto the platform tables the pack
itself owns. The three surfaces are deliberately distinct.

The fragment types here pin the fields a contribution is *addressed* by and leave the rest
of each section body open, so they are deliberately **wider** than that grammar: they
describe what a pack has already declared, and are not a second way to construct it.

Part of [RaySpec](https://rayspec.dev) — **file-deployable AI infrastructure**: describe a
product's backend in one declarative YAML file, and RaySpec stands up accounts and
authentication, in-process agents, an HTTP API, a Postgres-backed data layer, durable
background jobs, and the supporting tooling — deployed GitOps-style from that single file.

## Compatibility policy

This package is a promise, so its versioning is stricter than the rest of the repository:
what ships here is what a pack in someone else's repository builds against.

**Frozen once released.** A member that has shipped in a tagged release is not edited in
place. The exported surface is recorded in `api-report.md`, checked in beside the source
and derived from the built type declarations, so every change to it is a reviewable diff
in the pull request that makes it — never an accident noticed after a release.

**A minor release may:**

- add a new exported type, or a new **optional** member to an existing one;
- widen a vocabulary the platform HANDS a pack — a new `PackErrorCode`, a new journal step
  kind — because the platform can grow one and this surface has to be able to report it.
  Branch on these with a `default` arm: an exhaustive switch with no default is the one
  consumer shape a widening breaks, and it is a deliberate, stated trade;
- widen what a pack may DECLARE — a new contribution kind, a new accepted method;
- change documentation, and nothing else.

**A major release is required to:**

- remove or rename any exported member;
- add a **required** member to anything a pack constructs (a manifest, a fragment), or
  narrow the type of an existing one — both turn a compiling pack into a broken one;
- remove a member from a vocabulary the platform hands a pack, or from one a pack declares;
- change the brand literal a loader checks, or the identifier rule;
- change what a member MEANS while keeping its name — a re-based unit, a path resolved
  against a different root. This is the change that a report diff cannot catch on its own,
  so it is called out explicitly.

**What is deliberately not frozen.** The fragment types pin the fields a contribution is
addressed by and leave the rest of each section body open, and the capability half is left
open likewise. The document grammar and the platform's capability contracts are validated
by the deployment at boot and versioned with it; copying them here would freeze this
surface to every additive change made there and promise a compatibility it cannot keep.

## Links

- Website & docs: <https://rayspec.dev>
- Source (monorepo): <https://github.com/rayspec-labs/rayspec>
- Changelog: <https://github.com/rayspec-labs/rayspec/blob/main/CHANGELOG.md>

## License

Source-available under the **Functional Source License (FSL-1.1-ALv2)** — each release
converts to Apache-2.0 two years after publication. See
[LICENSE](https://github.com/rayspec-labs/rayspec/blob/main/LICENSE).
