# `deployments/acme-notes` — the single-repo Product-YAML VPS boot entrypoint

One file, [`serve.mts`](./serve.mts): the neutral boot wrapper a single-repo Product-YAML deployment
runs. It injects no product meaning — the LIVE extraction, the STT provider and the store bindings
are all read from the environment by the composition root's Product-YAML boot. What the wrapper adds
over the generic `rayspec-serve` bin is the LOCAL table-registration stand-in
(`registerProductStores`), which a real deployment replaces with a committed `product-schema.ts`.

> **LOCAL / trusted posture / NOT internet-facing** — the separate hardening layer (per-tenant
> sandbox, RLS, KMS-DEK, DPoP) is the gate before any external exposure. Never put this behind a
> public address.

The same warning is printed at runtime, on every boot this wrapper performs: `serve.mts` calls
`bootBanner`, whose `POSTURE_WARNING_LINES` (`packages/app/server/src/banner.ts`) carry it
unconditionally. This page exists because the runtime copy is only visible to whoever watches the
boot log — a reader who finds this directory in the tree sees nothing until they run it.

## Why it exists in this repository

It is the REAL subject of the `check:deploy-entrypoint` gate: every bare import in `serve.mts` must
be a root-linked, resolvable dependency, which is what keeps an `ERR_MODULE_NOT_FOUND` crash-loop out
of a deployment that boots for the first time on a fresh host.

It also carries a trace-export posture, like every other boot that prints the banner: it calls
`applyServeAgentTracing()` before the secret-requiring config load, so `RAYSPEC_AGENT_TRACING` is
honoured here and not merely reported. That property is enforced, not conventional —
`packages/app/server/src/wrapper-agent-tracing.test.ts` discovers the `bootBanner(` call sites by
reading the tree and requires each one to apply a posture.

## Boot it

```bash
DATABASE_URL=… RAYSPEC_JWT_SIGNING_KEY=… RAYSPEC_API_KEY_PEPPER=… \
  node --import tsx deployments/acme-notes/serve.mts
```

`RAYSPEC_HOST` defaults to `127.0.0.1`. A non-loopback bind is honoured as a deliberate opt-in and
is **not refused** (`packages/app/server/src/serve-bind.test.ts` — "honors an explicit RAYSPEC_HOST
(a non-loopback bind is a deliberate opt-in)"). Nothing in this repository stops a public bind; the
warning above is the whole of the enforcement.
