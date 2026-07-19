# rayspec

**File-deployable AI infrastructure.** Describe a product's backend in one declarative
YAML file, and RaySpec stands up accounts and authentication, in-process agents, an HTTP
API, a Postgres-backed data layer, durable background jobs, and the supporting tooling —
deployed GitOps-style from that single file.

This package is the launcher: a thin `rayspec` bin that hands control to the RaySpec CLI
([`@rayspec/cli`](https://www.npmjs.com/package/@rayspec/cli)).

## Quickstart

```sh
npx rayspec init                # scaffold a minimal, valid backend spec (rayspec.yaml)
npx rayspec doctor rayspec.yaml # static diagnosis of the spec
npx rayspec plan rayspec.yaml   # show what a deploy would materialize
npx rayspec dev gen-secrets     # mint the boot secrets, then set DATABASE_URL to deploy
```

Every subcommand emits machine-parseable JSON to stdout.

## Links

- Website & docs: <https://rayspec.dev>
- Source (monorepo): <https://github.com/rayspec-labs/rayspec>
- Changelog: <https://github.com/rayspec-labs/rayspec/blob/main/CHANGELOG.md>

## License

Source-available under the **Functional Source License (FSL-1.1-ALv2)** — each release
converts to Apache-2.0 two years after publication. See
[LICENSE](https://github.com/rayspec-labs/rayspec/blob/main/LICENSE).
