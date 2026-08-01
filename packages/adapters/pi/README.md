# @rayspec/adapter-pi

The Pi adapter. Runs the same neutral `AgentSpec` as the reference adapter onto the same
neutral surface — central `dispatchTool`, real `ConvTurn`/`ConvPart` types, and a real
per-step journal.

Part of [RaySpec](https://rayspec.dev) — **file-deployable AI infrastructure**: describe a
product's backend in one declarative YAML file, and RaySpec stands up accounts and
authentication, in-process agents, an HTTP API, a Postgres-backed data layer, durable
background jobs, and the supporting tooling — deployed GitOps-style from that single file.

Most projects consume this package indirectly — start with
[`npx rayspec init`](https://www.npmjs.com/package/rayspec) or `@rayspec/server` rather
than depending on it directly.

## Cancellation

Ending a run (`POST /v1/runs/{id}/cancel`, or a caller-supplied abort signal) reaches this
backend through the run's signal on the `RunContext`. The adapter links it to the agent
session's `abort()` and, before issuing the model request at all, re-checks it — so a run
cancelled before the request goes out never calls the provider.

The pinned `@earendil-works/pi-coding-agent` 0.79.9 offers exactly one stop: `session.abort()`.
`prompt()` takes no abort signal of any kind (`PromptOptions`), so there is no request-level or
stream-level handle to pass in. `session.abort()` aborts the controller the *agent* created for
the run it is currently executing, and that controller's signal is the one carried into the
model request options — so an in-flight token stream does stop at the transport, not merely get
abandoned. What that leaves, honestly:

- **A cancel that lands in the window between the adapter's check and the agent registering its
  run is still swallowed.** `agent.abort()` aborts the *current* run's controller and does
  nothing when there is none, and `prompt()` performs several awaited steps before the run
  starts. The adapter's pre-call check closes the large window (a cancel arriving during session
  creation); this narrow one remains, and is observed only by the platform, which stops waiting
  the moment the signal fires.
- **Auto-compaction and branch summarisation run under their own abort controllers that
  `session.abort()` does not touch.** Only `dispose()` reaches them, and the adapter calls that
  in its teardown — so a compaction request that was in flight when the cancel arrived runs until
  the teardown reaches it. (The adapter never performs a branch or fork operation, so it never
  starts a branch summary itself.)
- **A run executing in a separate worker process receives no in-process signal at all.** The run
  is recorded cancelled and never dispatched again, but the work in that process stops when it
  stops. This is shared by all four backends and is not adapter-specific — see
  [#210](https://github.com/rayspec-labs/rayspec/issues/210).
- **A host tool already in flight is not interrupted.** The run-level signal is not composed into
  the per-tool abort; a handler that had already started runs to its own tool timeout. Its result
  is discarded, and a non-idempotent tool's taint marker was written before it fired, so the run
  stays quarantined rather than becoming silently re-runnable.
- **Work already committed upstream is not undone.** Cancellation stops further work; it is not a
  rollback.

There is no child process on this backend — the session runs in-process and only the neutral
tools declared by the spec are offered to the model, so nothing is spawned and there is no
orphaned child to reason about.

## Links

- Website & docs: <https://rayspec.dev>
- Source (monorepo): <https://github.com/rayspec-labs/rayspec>
- Changelog: <https://github.com/rayspec-labs/rayspec/blob/main/CHANGELOG.md>

## License

Source-available under the **Functional Source License (FSL-1.1-ALv2)** — each release
converts to Apache-2.0 two years after publication. See
[LICENSE](https://github.com/rayspec-labs/rayspec/blob/main/LICENSE).
