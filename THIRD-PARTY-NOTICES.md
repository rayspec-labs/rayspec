# Third-Party Notices

RaySpec is distributed under the terms in [`LICENSE`](./LICENSE). It builds on
open-source and third-party software that carries its own licenses and copyright
notices. This file records the attributions that must travel with the project.

## How third-party code is distributed

RaySpec does **not** vendor or re-bundle third-party source or binaries into
this repository. Every dependency is declared in `package.json` / the workspace
lockfile with an exact pinned version and is installed by the end user directly
from the public npm registry. Under that install-from-registry model, each
package's own license and copyright travel inside `node_modules` after
`pnpm install` — **for the packages whose publishers ship a license file**. Many
do not: **31** of the installed packages ship no in-tarball `LICENSE` at all
(including all four Pi packages, and the Codex CLI launcher together with its
prebuilt binary). For those, this file and the SBOM are the attribution, and they
are doing real compliance work rather than decoration. The SBOM lists them by
name under `flags.ships_no_license_file`.

### What the SBOM is, exactly

`docs/dependency-sbom.json` is a per-package table: for every distinct
`name@version` the workspace resolves, it records the license string **read
verbatim from the installed `package.json`**, whether that package ships its own
license file, which of RaySpec's own packages declare it directly, and its
platform constraints.

- The package **set** is derived from `pnpm-lock.yaml`, so it is
  **host-independent** — the same on macOS, on Linux, and in CI.
- The **licenses** are read from the installed tree after
  `pnpm install --frozen-lockfile`, on whichever machine generated the file. A
  package whose `os`/`cpu`/`libc` constraints exclude that machine is not
  installed there, so its license cannot be read from disk: such a row is
  recorded with `installed: false`, `license: null` and an explicit
  `absent_reason` — **never dropped**. Today that is 111 of 485 rows, and all of
  them are per-platform native binary variants of packages already in the table
  (or the five wasm-runtime packages reachable only through one). A deployer who
  regenerates the SBOM on their own platform reads the licenses for the variants
  that platform actually installs.
- The `host` field is **provenance only**. It says where the licenses were read.
  It does not describe the scope of the inventory.
- The summary (`license_groups`, `flags`) is **derived from the table**, so it
  cannot disagree with the rows it summarizes. The regexes used to classify
  copyleft are recorded in the file under `classification`, so a reader can audit
  the call rather than take it on trust.

Regenerate it with `pnpm gen:dependency-sbom` (the exact command is recorded in
the file). `pnpm gate:sbom-fresh` — a required CI check — compares the
`lockfile_sha256` the SBOM recorded against the current `pnpm-lock.yaml` and
fails when a dependency has moved without the inventory following it.

### Copyleft

Of the **374** packages whose license was read from an installed manifest, **none
carries a strong-copyleft (GPL/AGPL/LGPL) license**. Two carry the file-scoped
weak-copyleft MPL-2.0 (see below). The remaining 111 rows are the platform-gated
variants described above; their licenses were not read on the generating host and
are honestly recorded as `null` rather than assumed.

## Agent backend SDKs

RaySpec runs four in-process agent backends behind one neutral `Backend`
interface. Their SDKs are declared dependencies (never vendored), each installed
from npm under its own license. The backends differ materially in **how they
authenticate**, and that difference is disclosed here rather than left implicit.

In every case the credential is the **operator's own**. RaySpec stores no
provider credential per tenant or per end user, and offers no path by which one
party's login could be proxied on behalf of another: an agent backend receives
its credential only from the process environment the operator controls, from a
constructor argument the operator's own boot code supplies, or from a credentials
file on the operator's own disk. There is no request-supplied credential path.

### OpenAI Agents SDK — MIT

- `@openai/agents` 0.11.8
- `@openai/agents-core` 0.11.8
- `@openai/agents-openai` 0.11.8

Licensed under the MIT License. Copyright (c) 2025 OpenAI. The MIT permission
notice and disclaimer travel in each package's own `LICENSE` file in
`node_modules`.

**Authentication: API key only.** This SDK exposes no subscription or OAuth path;
the adapter takes an `OPENAI_API_KEY` and records the auth mode `api-key`. The
"no credential proxying" question is therefore trivially settled — there is no
subscription credential here to proxy. Use is subject to OpenAI's API terms of
use and usage policies.

### OpenAI Codex SDK — Apache-2.0

- `@openai/codex-sdk` 0.142.2 (ships its own `LICENSE`)
- `@openai/codex` 0.142.2 — the CLI launcher, a dependency of the SDK. Ships
  **no** in-tarball `LICENSE` file.
- `@openai/codex` per-platform **prebuilt binaries**, installed as optional
  dependencies under npm aliases (`@openai/codex@0.142.2-darwin-arm64`,
  `-darwin-x64`, `-linux-arm64`, `-linux-x64`, `-win32-arm64`, `-win32-x64`).
  Each is published by OpenAI under Apache-2.0. Only the one variant matching the
  installing platform is fetched; the variant read on the machine that generated
  the SBOM declares Apache-2.0 and ships **no** in-tarball `LICENSE` file.

The Codex SDK wraps the `codex` CLI: it **spawns the prebuilt binary above as a
child process**. That binary is installed from npm like any other dependency and
is never vendored into or redistributed by this repository. Because neither the
launcher nor the binary carries a license file of its own, the Apache-2.0
notice below is the attribution that travels with them.

    Copyright 2025 OpenAI

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this software except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
    WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
    License for the specific language governing permissions and limitations
    under the License.

This same Apache-2.0 text is the notice for every Apache-2.0 package in the
resolved tree that ships no license file of its own; the SBOM names them under
`flags.ships_no_license_file`.

**Authentication: subscription only — state this plainly.** The Codex backend has
**no API-key mode at all**. It authenticates from the operator's own personal
ChatGPT OAuth session, read from `auth.json` under `CODEX_HOME` (default
`~/.codex`), and the run is recorded under the auth mode
`codex-subscription-oauth`. The adapter's options type exposes no `apiKey`, and
the environment handed to the `codex` child process is a fixed **allowlist**
(`HOME`, `PATH`, `LANG`, `TMPDIR`/`TMP`/`TEMP`, `LC_*`, `CODEX_HOME`, and a
per-run bridge token) — so a stray `OPENAI_API_KEY` or `CODEX_API_KEY` in the
operator's environment is structurally unable to reach the subprocess and cannot
silently redirect the run onto metered API billing. With no OAuth session on
disk, the adapter reports `unauthenticated` rather than falling back to a key.

Running a personal ChatGPT subscription credential through automated software is
an **informed, accepted risk taken deliberately by this project's maintainers**,
not an oversight and not a recommendation to third parties. Use of Codex is
subject to OpenAI's own agreements — including the terms governing ChatGPT
subscriptions and the Codex CLI — and each operator is responsible for
determining whether their intended use is permitted under the agreement that
binds them. A deployment that does not want this backend simply never selects it
(see **Choosing which backends a deployment runs**, below).

### Anthropic Claude Agent SDK — PROPRIETARY (declared dependency, not vendored)

- `@anthropic-ai/claude-agent-sdk` 0.3.185
- its platform sidecar packages (`@anthropic-ai/claude-agent-sdk-<platform>`, one
  per supported OS/architecture)

**© Anthropic PBC. All rights reserved.** This SDK is proprietary software. It is
**not** licensed under an open-source license and is **not** covered by the
RaySpec `LICENSE`. Its manifest declares `SEE LICENSE IN README.md`; the
published tarball ships a `LICENSE.md` reading, in full: *"© Anthropic PBC. All
rights reserved. Use is subject to the Legal Agreements outlined here:
https://code.claude.com/docs/en/legal-and-compliance."*

RaySpec's posture toward this dependency:

- **RaySpec redistributes no Anthropic SDK code or binary.** The SDK is a pinned
  npm dependency that the self-hoster installs directly from the npm registry
  under Anthropic's own terms. Nothing from the SDK is copied into, re-published
  by, or bundled with this repository.
- **Each self-hoster supplies their own Anthropic credentials.** The adapter
  supports **two** credential modes, and their precedence is set by the SDK:
  `ANTHROPIC_API_KEY` takes priority over `CLAUDE_CODE_OAUTH_TOKEN`.
  - An **API key** obtained through the Anthropic (Claude) Console. This is the
    credential `.env.example` recommends for a deployment, and the run is
    recorded under the auth mode `api-key`.
  - A **subscription OAuth token** (`CLAUDE_CODE_OAUTH_TOKEN`, obtained via
    `claude setup-token`), drawing the operator's own Claude subscription rather
    than metered API billing. The run is recorded under the auth mode
    `subscription-oauth-official-harness`. This project's own CI exercises the
    Anthropic adapter through this mode.

  Because the API key wins the precedence, a deployment that sets **both** and
  intends the subscription would silently bill the API instead. RaySpec detects
  that combination and prints a loud warning at boot naming the two variables (it
  never prints their values), and the adapter surfaces the same finding through
  its pre-run auth self-check. It does not hard-block: an operator may legitimately
  intend the API-key path.

  Which of these two modes a given operator is permitted to use is governed by
  that operator's own agreement with Anthropic, not by this document.
- **No credential proxying on behalf of end users.** Anthropic's terms state that
  Anthropic does not permit third-party developers to offer Claude.ai login or to
  route requests through Free, Pro, or Max subscription-plan credentials on behalf
  of their users. RaySpec does not do this: the operator's own credential is used
  for that operator's own use. There is no per-tenant or per-end-user credential
  store anywhere in the codebase and no path to proxy another party's
  subscription login — an auth mode literally named
  `subscription-oauth-thirdparty-DISALLOWED` exists in the neutral vocabulary for
  configuration validation and is never produced by any run.

Use of the Anthropic Claude Agent SDK is subject to Anthropic's own agreements,
including the Anthropic Commercial Terms of Service and the Anthropic Usage
Policy. Consult the governing terms before deploying the Anthropic backend:

- Anthropic Commercial Terms: <https://www.anthropic.com/legal/commercial-terms>
- Claude Code / Agent SDK legal and compliance:
  <https://code.claude.com/docs/en/legal-and-compliance>
- Anthropic Usage Policy: <https://www.anthropic.com/legal/aup>

### Anthropic API SDK — MIT

- `@anthropic-ai/sdk` 0.105.0

Licensed under the MIT License. **Copyright 2023 Anthropic, PBC.** The MIT
permission notice and disclaimer travel in the package's own `LICENSE` file in
`node_modules`.

This is a **separate, open-source package** from the proprietary Claude Agent SDK
above, and is not covered by that SDK's terms. It is a declared dependency of
RaySpec's Anthropic adapter, pinning the version that satisfies the Claude Agent
SDK's `@anthropic-ai/sdk` peer dependency. RaySpec's own source does not import
it. (An earlier revision of this file omitted it entirely, which made the project
look more license-restricted than it is.)

### Model Context Protocol SDK — MIT

- `@modelcontextprotocol/sdk` 1.29.0

Licensed under the MIT License. **Copyright (c) 2024 Anthropic, PBC.** The MIT
permission notice and disclaimer travel in the package's own `LICENSE` file in
`node_modules`.

A declared dependency of RaySpec's Codex adapter, which imports its `McpServer`
and `StreamableHTTPServerTransport` to host the in-process tool bridge the
`codex` child process calls back into. It is also a peer dependency of the Claude
Agent SDK, and an optional peer dependency of `@google/genai`, which the Pi AI
package depends on.

### Pi Coding Agent — MIT

- `@earendil-works/pi-coding-agent` 0.79.9
- `@earendil-works/pi-ai` 0.79.9
- `@earendil-works/pi-agent-core` 0.79.9
- `@earendil-works/pi-tui` 0.79.9

Licensed under the MIT License. **Copyright Mario Zechner.** These packages'
published npm tarballs include **no standalone `LICENSE` file** (verified against
the installed tree), so the copyright attribution is carried here as required by
the MIT License.

**Authentication: OpenAI API key only.** The Pi backend runs on `OPENAI_API_KEY`
and records the auth mode `api-key`. As a compliance posture, this adapter is
**never** pointed at an Anthropic subscription credential — only the OpenAI key is
ever injected into it.

## Speech-to-text provider

### Deepgram — no third-party code

RaySpec's speech-to-text adapter declares **zero runtime dependencies**. It calls
the Deepgram HTTP API directly with the platform's global `fetch` and an
operator-supplied `DEEPGRAM_API_KEY`. There is no Deepgram SDK in the dependency
tree, so there is no third-party code to attribute here. The credential is the
operator's own and its use is governed by the operator's agreement with Deepgram.

## Choosing which backends a deployment runs

There is **no build flag** that compiles a backend in or out, and this file does
not promise one. What exists is a neutral `Backend` interface and two selection
points, both under the deployer's control:

1. **The platform ships no agent backend.** The composition root receives the
   backends it should serve from an injected factory
   (`() => ReadonlyMap<BackendId, Backend>`) that the deployment's own boot
   entrypoint constructs. A deployment that registers only OpenAI never imports,
   loads, or authenticates any other SDK. The bundled example entrypoint does
   exactly that.
2. **The spec-driven boot path selects by name.** When a deployment boots from a
   product spec, the `backend:` field on each declared extractor picks one of the
   four wired adapters. A spec that never names a backend never constructs its
   adapter, and a backend whose credential is absent fails closed at boot with a
   named, actionable error rather than starting unauthenticated.

To remove a backend's SDK from the dependency tree entirely, a deployer deletes
that adapter package, drops its one import and its one `case` arm from the
spec-driven boot factory, and removes the `workspace:*` entries that declare it
(the boot package, and the cross-backend parity test package). The neutral
`Backend` interface, the tool-dispatch chokepoint, the deploy pipeline, and the
spec grammar are all untouched by that edit — which is the property the neutral
interface exists to guarantee.

## Weak-copyleft build-time dependency

### lightningcss — MPL-2.0

- `lightningcss` and its per-platform native variants

Licensed under the Mozilla Public License, Version 2.0. This is a
**development/build-time transitive dependency** (reached via the test runner's
toolchain). It is not part of the deployed runtime and is not vendored or
modified by RaySpec; its source is available from its publisher, and the full
license text travels in its own `node_modules` package. The MPL-2.0 file-level
copyleft applies only to modifications of the MPL-covered files themselves, which
RaySpec does not make.

## Summary of the dependency license inventory

`pnpm-lock.yaml` resolves **485** distinct third-party packages. The counts below
are the **374** whose license was read verbatim from an installed manifest on the
machine that generated `docs/dependency-sbom.json`; the remaining **111** are the
platform-gated variants described at the top of this file and are recorded there
individually with `license: null`.

| License                       | Distinct packages |
| ----------------------------- | ----------------- |
| MIT                           | 267               |
| Apache-2.0                    | 57                |
| BSD-3-Clause                  | 17                |
| ISC                           | 16                |
| BlueOak-1.0.0                 | 5                 |
| BSD-2-Clause                  | 2                 |
| MIT OR Apache-2.0             | 2                 |
| MPL-2.0                       | 2                 |
| Unlicense                     | 2                 |
| (MIT OR CC0-1.0)              | 1                 |
| 0BSD                          | 1                 |
| SEE LICENSE IN LICENSE.md     | 1                 |
| SEE LICENSE IN README.md      | 1                 |
| **Licenses read from disk**   | **374**           |
| Platform-gated, not installed | 111               |
| **Total distinct packages**   | **485**           |

The two `SEE LICENSE IN ...` rows are the proprietary Anthropic Claude Agent SDK
and its platform sidecar, described above. The permissive bulk (MIT / Apache-2.0 /
BSD / ISC / BlueOak / 0BSD / Unlicense / CC0) imposes attribution-and-notice
obligations, satisfied by each package shipping its own license inside
`node_modules` — except for the 31 packages that ship none, whose attributions
this file carries. No package whose license was read carries a strong-copyleft
(GPL/AGPL/LGPL) obligation.

For the complete, authoritative, per-package mapping — every row with its license
string, whether it ships a license file, and which RaySpec package depends on it
directly — consult `docs/dependency-sbom.json`.
