# @rayspec/adapter-codex

The OpenAI **Codex** adapter — the fourth backend, with full parity to the
openai/anthropic/pi adapters. Maps the neutral `Backend` interface onto
`@openai/codex-sdk` (pinned).

Part of [RaySpec](https://rayspec.dev) — **file-deployable AI infrastructure**: describe a
product's backend in one declarative YAML file, and RaySpec stands up accounts and
authentication, in-process agents, an HTTP API, a Postgres-backed data layer, durable
background jobs, and the supporting tooling — deployed GitOps-style from that single file.

Most projects consume this package indirectly — start with
[`npx rayspec init`](https://www.npmjs.com/package/rayspec) or `@rayspec/server` rather
than depending on it directly.

## Cancellation

Cancelling a run aborts the signal on the run context. This adapter links that signal to the
`AbortController` it hands to the SDK's streamed turn, so the streamed turn is aborted and the
spawned `codex` child is signalled. Once that turn ends, the teardown of the in-process MCP tool
bridge is **bounded**: it no longer waits on connections that outlive the turn. What that does
**not** cover:

- **A child that ignores `SIGTERM` is killed after the kill grace.** The SDK spawns with
  `{ signal }` and no `killSignal`, so aborting sends a single `SIGTERM`, and it drives the turn
  with a readline loop over the child's stdout — a child that ignored the signal would keep that
  loop, and `backend.run()`, open for good. The adapter therefore points the SDK at a small
  launcher (written once per process into a private temp directory) that starts the real binary as
  its own child, forwards the `SIGTERM`, and sends `SIGKILL` once the run's kill grace has passed
  (`RAYSPEC_AGENT_KILL_GRACE_MS`, default 5000 ms). `src/cancel.integration.test.ts` drives the real
  SDK against a stand-in executable with an empty `SIGTERM` handler and asserts it is gone after the
  grace and `run()` settles. If the bundled binary cannot be found or the launcher cannot be
  written, the adapter runs the binary directly, without the escalation, and logs that once.
- **A silent child is ended by the provider-call timeout.** With `RAYSPEC_AGENT_REQUEST_TIMEOUT_MS`
  set (or the managed posture's default), a turn that produces no event for that long is aborted
  through the same controller and the same kill ladder, and the run reports the neutral `timeout`
  class. A tool call the platform dispatches does not count as silence.
- The launcher starts the `codex` child in a process group of its own and signals the whole group,
  so processes the child spawned are ended with it, and it never waits on the relayed output beyond
  the grace: a process that inherited the child's stdout cannot keep `run()` open. A process the
  child starts in a session of its own leaves the group and is not signalled; on Windows there are
  no process groups and only the child is signalled.
- Whether the real `codex` CLI exits on that signal and reaps its own children is **not verified
  here**. The cancellation tests drive the real SDK against a stand-in executable, so the points
  above are stated as limits rather than measured against the shipped CLI.
- A run already executing in a **separate worker process** receives no in-process signal by
  default; setting `RAYSPEC_RUN_CANCEL_POLL_MS` (on by default under
  `RAYSPEC_HOSTING_POSTURE=managed`) makes that process re-read the cancellation record
  and raise the abort itself, which is the signal this adapter acts on. Both behaviours are shared
  by all four backends.
- A tool call already in flight is not interrupted, and work already committed upstream is not
  undone.

## Links

- Website & docs: <https://rayspec.dev>
- Source (monorepo): <https://github.com/rayspec-labs/rayspec>
- Changelog: <https://github.com/rayspec-labs/rayspec/blob/main/CHANGELOG.md>

## License

Source-available under the **Functional Source License (FSL-1.1-ALv2)** — each release
converts to Apache-2.0 two years after publication. See
[LICENSE](https://github.com/rayspec-labs/rayspec/blob/main/LICENSE).
