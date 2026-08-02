# @rayspec/adapter-anthropic

The Anthropic Claude Agent SDK adapter (the abstraction's stress case). Maps the neutral
`Backend` interface onto `@anthropic-ai/claude-agent-sdk` (pinned), so the same
declared agent runs unchanged on any RaySpec backend adapter.

Part of [RaySpec](https://rayspec.dev) — **file-deployable AI infrastructure**: describe a
product's backend in one declarative YAML file, and RaySpec stands up accounts and
authentication, in-process agents, an HTTP API, a Postgres-backed data layer, durable
background jobs, and the supporting tooling — deployed GitOps-style from that single file.

Most projects consume this package indirectly — start with
[`npx rayspec init`](https://www.npmjs.com/package/rayspec) or `@rayspec/server` rather
than depending on it directly.

## Cancelling a run on this backend

Cancelling a run reaches this backend: the run's abort signal is linked to the
`AbortController` this adapter hands the SDK, which is the pinned SDK's documented
cancellation mechanism for a plain-string prompt, and the SDK then really does tear the
child process down. A test in this package proves that against a live process rather than
a flag: it drives the real SDK against a stand-in executable, holds the pid the SDK
spawned, and watches it disappear. What that establishes is the SDK's teardown, which is
process-level — signals sent to a pid — and not the vendor `claude` binary's own shutdown
behaviour.

These are the limits that come with it. The first three were measured against a real child
process on the pinned SDK (0.3.185) or read out of it; the rest are properties of the
surrounding platform, or of cancellation in general, rather than of this SDK.

- **Stopping takes seconds, not milliseconds.** The SDK ends the child's standard input
  immediately, waits a two-second grace period, sends `SIGTERM` to a child still
  running, and sends `SIGKILL` five seconds after that. Measured in one run of that test,
  which prints what it measured: standard input closed 1 ms after the abort, a child that
  honours `SIGTERM` gone at 2014 ms, a child that ignores it gone at 7030 ms, and the
  adapter's own call back at 2008 ms — so no caller waits for the last rung, but the child
  can outlive the answer by seconds. The two "gone" figures are polled at 25 ms and are
  indicative of one machine; the test asserts the rungs, not these latencies.
- **A host process that exits inside that window can leave an orphan.** The escalation
  timers are `unref()`ed, so they do not hold the host process open, and the `SIGKILL`
  rung is lost if the host goes away first. The SDK does send `SIGTERM` to its tracked
  children from a process-exit hook, so a child that honours it still dies — measured,
  within a millisecond of a host that exits normally. A child that ignores `SIGTERM` does
  not: with the host exiting 200 ms after the abort, it was still running twenty seconds
  later, when the observation stopped and it had to be killed by hand. A host that is
  killed outright runs no exit hook at all, so neither child is reached in that case.
- **Only the child itself is signalled.** Every rung of the ladder is sent to the pid the
  SDK spawned, never to a process group — the SDK spawns without `detached`. Any process
  that child starts in turn is therefore not reached by cancelling the run.
- **A run executing in a separate worker process receives no signal at all.** The signal
  is an in-process one, so it only reaches a run executing in the process that holds it.
  This limit is shared by all four backends and is tracked as
  [#210](https://github.com/rayspec-labs/rayspec/issues/210).
- **A tool call already in flight is not interrupted.** The run-level signal is not
  composed into the per-tool abort, so a handler that had already started runs to its own
  tool timeout. Its result is discarded, and a non-idempotent tool's taint marker keeps
  the run quarantined rather than silently re-runnable.
- **Work the child already committed upstream is not undone.** Cancellation stops a
  process; it rolls nothing back.

## Links

- Website & docs: <https://rayspec.dev>
- Source (monorepo): <https://github.com/rayspec-labs/rayspec>
- Changelog: <https://github.com/rayspec-labs/rayspec/blob/main/CHANGELOG.md>

## License

Source-available under the **Functional Source License (FSL-1.1-ALv2)** — each release
converts to Apache-2.0 two years after publication. See
[LICENSE](https://github.com/rayspec-labs/rayspec/blob/main/LICENSE).
