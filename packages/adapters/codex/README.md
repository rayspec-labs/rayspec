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

- **The child is signalled, not killed — and if it does not die, the run does not end.** The SDK
  spawns with `{ signal }` and no `killSignal`, so aborting sends a single `SIGTERM` and nothing
  escalates; it then drives the turn with a readline loop over the child's stdout. A child that
  ignores `SIGTERM` keeps that stdout open, so the loop never ends, `backend.run()` never returns,
  and its teardown — the bounded bridge close included — never runs at all. This is measured, not
  assumed: `src/cancel.integration.test.ts` pins it with a stand-in executable that installs an
  empty `SIGTERM` handler. The bounded teardown fixes a hang **after** the turn ends; it cannot
  rescue a run whose child refuses to exit.
- Processes the `codex` child itself spawned are not signalled and can be left orphaned.
- Whether the real `codex` CLI exits on that signal and reaps its own children is **not verified
  here**. The cancellation tests drive the real SDK against a stand-in executable, so the points
  above are stated as limits rather than measured against the shipped CLI.
- A run already executing in a **separate worker process** receives no in-process signal at all.
  That limit is shared by all four backends and is tracked in
  [#210](https://github.com/rayspec-labs/rayspec/issues/210).
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
