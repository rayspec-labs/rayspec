# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in RaySpec, please report
it privately. **Do not open a public issue for a security report.**

Email the maintainers at **security@rayspec.dev**. Please include:

- a description of the issue and its impact,
- the affected version or commit,
- clear reproduction steps or a proof of concept, and
- any suggested remediation, if you have one.

We will acknowledge your report, investigate, and coordinate a fix and disclosure
timeline with you. Please give us a reasonable window to remediate before any
public disclosure.

## Supported versions

Security fixes target the latest released version. RaySpec is versioned with
semantic versioning; see [`CHANGELOG.md`](./CHANGELOG.md) for releases.

| Version | Supported |
| ------- | --------- |
| Latest release | Yes |
| Older releases | Best-effort |

---

## Security model

RaySpec's core is built for a **trusted, self-hosted, single-node** posture. It
enforces a set of guarantees from the first boot, and it is explicit about a
further hardening layer that it deliberately does **not** include. Understanding
this split is essential to deploying it safely. This section mirrors
[Architecture → Security model](./docs/ARCHITECTURE.md#security-model).

### Built in, from day one

- **Tenant isolation by construction.** Every query against tenant-owned data
  goes through a single, fail-closed, deny-by-default database chokepoint that
  injects the tenant predicate. A table is reachable through the scoped handle
  only if it is registered as committed source, and the deploy step *verifies*
  this — a spec that declares an unregistered store refuses to deploy. A
  continuous-integration test fails the build if any tenant-owned table can be
  read without the predicate. There is no ergonomic path to a cross-tenant read.
- **No plaintext secrets, fail-closed boot.** Signing keys, peppers, and provider
  credentials live in the environment or a secret manager — never in the database
  or in git. The server refuses to boot if a required secret is missing.
- **An untrusted-content trust boundary.** Agent tool calls run through one
  dispatch boundary, and everything crossing it from the outside — tool outputs,
  transcribed or uploaded content, and rehydrated conversation history — is
  treated as **data, never as instructions**. This is the defense against
  prompt-injection-style attacks: untrusted content can inform a model's answer
  but cannot redirect the agent's behavior or its tool use.
- **An out-of-band audit trail.** An append-only, tenant-scoped run journal
  records what ran, for whom, and under what authority, independently of the
  request path.
- **Per-backend credential isolation.** Each agent backend uses its own
  operator-supplied credentials; the platform never proxies one party's
  credentials on behalf of another.

### The separate hardening layer (NOT in the core)

Running RaySpec for **untrusted, multi-tenant, public-internet** traffic requires
protections that are deliberately out of scope for the core and belong to a
distinct hardening layer:

- per-tenant data encryption with wrapped data-encryption keys,
- database row-level security as a second, in-database enforcement of tenancy,
- per-tenant execution sandboxing, and
- cryptographic binding of tokens to their client.

**The core does not ship these, and it says so loudly at boot. Do not place a
core deployment on a public address for untrusted traffic without that layer.**
The distinction is intentional: the core gives a self-hoster a correct,
tenant-isolated backend for trusted use, and the hardening layer is what a public
multi-tenant service additionally needs.

---

## Scope

A report is in scope if it demonstrates a defect in a guarantee the core claims
to provide (for example: a way to bypass the tenant predicate, to read secrets,
to escape the tool-dispatch trust boundary, or to make the server boot without a
required secret).

The absence of the separate hardening layer above is **documented, deliberate
scope**, not a vulnerability — a core deployment exposed to untrusted
multi-tenant public traffic without that layer is a deployment mistake, not a
platform defect.
