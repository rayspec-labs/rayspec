# @rayspec/cli

The RaySpec CLI: a **read-only diagnostic floor** (`rayspec doctor` for static spec
diagnosis, `rayspec plan` for a deploy preview) plus a clearly separated, local-dev
`dev` command group (scaffolding, secret minting). Every subcommand emits
machine-parseable JSON to stdout.

Usually invoked through the unscoped launcher
[`rayspec`](https://www.npmjs.com/package/rayspec) (`npx rayspec …`).

Part of [RaySpec](https://rayspec.dev) — **file-deployable AI infrastructure**: describe a
product's backend in one declarative YAML file, and RaySpec stands up accounts and
authentication, in-process agents, an HTTP API, a Postgres-backed data layer, durable
background jobs, and the supporting tooling — deployed GitOps-style from that single file.

## Links

- Website & docs: <https://rayspec.dev>
- Source (monorepo): <https://github.com/rayspec-labs/rayspec>
- Changelog: <https://github.com/rayspec-labs/rayspec/blob/main/CHANGELOG.md>

## License

Source-available under the **Functional Source License (FSL-1.1-ALv2)** — each release
converts to Apache-2.0 two years after publication. See
[LICENSE](https://github.com/rayspec-labs/rayspec/blob/main/LICENSE).
