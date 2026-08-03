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
session's `abort()` and, before issuing the prompt call at all, re-checks it — so a run cancelled
before the adapter reaches that call never calls the provider. A cancel that lands *after* the
agent has registered its run is carried into the request itself. The one window that is neither —
between that re-check and the agent registering the run — is described below.

The pinned `@earendil-works/pi-coding-agent` 0.79.9 offers exactly one stop: `session.abort()`.
`prompt()` takes no abort signal of any kind (`PromptOptions`), so there is no request-level or
stream-level handle to pass in. `session.abort()` aborts the controller the *agent* created for
the run it is currently executing, and that controller's signal is the one carried into the
model request options — so an in-flight token stream does stop at the transport, not merely get
abandoned. What that leaves, honestly:

- **A cancel that lands in the window between the adapter's check and the agent registering its
  run is still swallowed, and this one remains by choice rather than by SDK constraint.**
  `agent.abort()` aborts the *current* run's controller and does nothing when there is none, and
  `prompt()` performs several awaited steps before the run starts — at minimum the unconditional
  `before_agent_start` extension event. The adapter's pre-call check closes the large window (a
  cancel arriving during session creation); a cancel inside this narrow one reaches nothing and
  the full request goes out and streams. The SDK does permit closing it: the first event of a run
  is emitted *after* the agent has registered the run and *before* the model request is issued,
  and it reaches the subscription this adapter already holds, so re-checking the signal there and
  stopping again would abort the live controller in time. This adapter does not do that — it
  would mean issuing a second stop from inside the ordered event-forwarding path that every
  uncancelled run also takes, to recover a window measured in a handful of awaits. The window is
  recorded here rather than closed.
- **Auto-compaction and branch summarisation run under their own abort controllers that
  `session.abort()` does not touch.** Only `dispose()` reaches them, and the adapter calls that
  in its teardown — so a compaction request that was in flight when the cancel arrived runs until
  the teardown reaches it. (The adapter never performs a branch or fork operation, so it never
  starts a branch summary itself.)
- **A run executing in a separate worker process receives no in-process signal by default.** The
  run is recorded cancelled and never dispatched again, but the work in that process stops when it
  stops. Setting `RAYSPEC_RUN_CANCEL_POLL_MS` makes that process re-read the cancellation record on
  the configured interval and raise the abort itself — the same signal this adapter wires to its
  session, so the stop applies there as it does in-process. Both behaviours are shared by all four
  backends and are not adapter-specific.
- **A host tool already in flight is not interrupted, and the adapter's own `run()` stays pending
  until it returns.** The run-level signal is not composed into the per-tool abort; a handler that
  had already started runs to its own tool timeout. Its result is discarded, and a non-idempotent
  tool's taint marker was written before it fired, so the run stays quarantined rather than
  becoming silently re-runnable. The adapter-side consequence: the agent loop awaits an in-flight
  tool call before it next looks at the abort, and `prompt()` returns only when the loop does, so
  after a cancel `run()` — with its session, subscription and event tail alive — remains pending
  for the remainder of that tool's timeout. The caller is already free; the platform stopped
  waiting when the signal fired and discards whatever `run()` eventually returns.
- **Work already committed upstream is not undone.** Cancellation stops further work; it is not a
  rollback.

For a run cancelled before the prompt call, the adapter invents no terminal state of its own: it
skips the call and falls through its normal epilogue, so its `RunResult` reads `completed` with no
model output. The platform never sees it — the run is journalled cancelled and the result is
discarded — but code embedding `@rayspec/adapter-pi` directly reads that return value and should
treat the run's own signal, not the result, as the record of a cancellation.

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
