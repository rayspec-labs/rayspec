# @rayspec/adapter-openai-tts

The OpenAI text-to-speech adapter behind the provider-neutral
[`@rayspec/tts-port`](https://github.com/rayspec-labs/rayspec/tree/main/packages/kernel/tts-port)
contract: one REST call to `/v1/audio/speech`, no provider SDK, the credential resolved
lazily at call time, and content-free errors. Requests are validated against the adapter's
own policy (text cap, closed voice list, speed clamp) before anything is billed.

Part of [RaySpec](https://rayspec.dev) — **file-deployable AI infrastructure**: describe a
product's backend in one declarative YAML file, and RaySpec stands up accounts and
authentication, in-process agents, an HTTP API, a Postgres-backed data layer, durable
background jobs, and the supporting tooling — deployed GitOps-style from that single file.

Most projects consume this package indirectly — start with
[`npx rayspec init`](https://www.npmjs.com/package/rayspec) or `@rayspec/server` rather
than depending on it directly.

## Links

- Website & docs: <https://rayspec.dev>
- Source (monorepo): <https://github.com/rayspec-labs/rayspec>
- Changelog: <https://github.com/rayspec-labs/rayspec/blob/main/CHANGELOG.md>

## License

Source-available under the **Functional Source License (FSL-1.1-ALv2)** — each release
converts to Apache-2.0 two years after publication. See
[LICENSE](https://github.com/rayspec-labs/rayspec/blob/main/LICENSE).
