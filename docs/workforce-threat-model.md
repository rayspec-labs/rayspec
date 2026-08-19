# Workforce runtime — threat model

> **LOCAL / trusted posture / NOT internet-facing.** This runtime is built for a single-node,
> single-operator deployment behind a trusted boundary. It is **not** hardened for public
> exposure, and the hardening suite that would be the gate for that (RLS as the primary tenant
> boundary, KMS-wrapped DEKs, per-tenant agent sandboxes, DPoP) **is not built**. Do not place
> this server behind a public address.

**Status:** the OC-004 sign-off artifact. **Scope:** the `workforce:` task engine and everything
that feeds it. **Audience:** a security reviewer deciding whether the trust boundaries hold.

The whole discipline of this page is one rule: **every guarantee names the mechanism or the test
that enforces it, and every gap says out loud that it is a gap.** A sentence here that claims more
than its citation supports is a defect in the page, not a rounding error. Where a defence has no
test, this page says **NO TEST** in those words rather than describing the code confidently.

Every `file:line` in this page is machine-checked by
`packages/kernel/workforce-tools/src/threat-model-drift.test.ts`, which asserts that the cited line
still **contains the recorded text** (Appendix A) and that every named suite still declares the
test title claimed for it (Appendix B) — a range check is not a verification, and a citation into a
file someone is editing rots silently from their own edits.

---

## 1. How to read this page

### 1.1 Trust levels

| Level | Meaning |
|---|---|
| **U0** | **Untrusted model output.** Tool arguments, tool call sequences, submitted results. |
| **U1** | **Untrusted human input through an authenticated principal.** HTTP bodies, CLI input. |
| **U2** | **Untrusted prior-turn output re-entering context.** Child results, recall hits, messages. |
| **T1** | **Deployer-authored configuration** — the `rayspec.yaml` document, reviewed like code. Trusted for its *content* (a declared rule is authority); **not** trusted for its *shape*. |
| **T2** | **Trusted runtime code** — the kernel, the composition, the HTTP middleware chain. |

### 1.2 What the words mean here

- **PROVEN** — a named test drives the abuse case against the real mechanism and observes the
  refusal. The test is cited.
- **PARTIAL** — the mechanism is real and cited; some abuse case in the same class has no test,
  and that case is named.
- **NO TEST** — the mechanism exists in code and nothing exercises it, **or** no mechanism exists.
  Which of the two is stated explicitly each time.
- **SIMULATED** — the property is established by a construction that stands in for the real
  failure (see §7.3). Never reported as PROVEN.

### 1.3 The architectural fact everything else follows from

**A wait is a row, never a process.** Delegation joins, reviews, approvals, escalations and budget
parks are Postgres rows with no in-memory continuation; resume is always a fresh journaled
dispatch. That is why every intake surface below is a *write door* with a validation chokepoint,
rather than a message into a live process.

### 1.4 What is out of scope for this page

Provider/model behaviour (an LLM's own alignment), the security of a declared agent pack's own
tools beyond the boundaries this runtime enforces on them, host and container hardening, and the
non-goals in §8.

---

## 2. The trust boundary map

```
   U1 HTTP client ──▶ authenticate ▶ resolveTenant ▶ requirePermission ──▶ route (strict zod)
                                          │                                       │
                          tenant is SERVER-DERIVED                      engine (typed intents)
                                          │                                       │
                                          ▼                                       ▼
   T1 rayspec.yaml ──▶ parse + lint ──▶ WorkforceConfig ──┐          Postgres, via TenantDb
                                                          │                   (predicate
   T2 composition ──▶ snapshot + facts + recall ──────────┼──▶ turn input     injected)
                                                          │      (byte-bounded, sanitized)
                                                          ▼
   U2 prior turns ──▶ child results / messages / recall ──┘
                                                          │
                                                          ▼
                                                    model backend
                                                          │
   U0 model output ──▶ Ajv (chokepoint) ▶ zod (tool) ▶ turnIntentSchema (engine) ──▶ ONE typed
                                                                                     intent
```

Three properties hold across the whole map and are argued once, in §6:

- **§6.1 Tenant scope is structural** — application-level predicate injection at one chokepoint,
  deny-by-default for unregistered tables. **Not** Postgres RLS (§8).
- **§6.2 The prompt/data boundary is enforced in code**, positionally: nothing interpolated into a
  line may contain a line boundary — untrusted *and* config-derived text alike.
- **§6.3 The principal is server-derived** and the request body cannot assert it.

---

## 3. Surface-by-surface

### 3.1 Goal intake — `POST /v1/workforce/:workforceId/goals`

**Trust: U1.** A goal is free text from an authenticated principal, and it renders **verbatim and
untrimmably** into the owning employee's turn input.

**Chokepoints, in order.**

1. `requireAuth() → resolveTenant(deps) → requirePermission(deps, 'store:write')` on the route.
   Tenant is derived from the principal, never the URL:
   `packages/compose/api-auth/src/http/middleware.ts:150` reads `principal?.orgId` and
   `packages/compose/api-auth/src/http/middleware.ts:174` sets it as the request tenant.
2. **A supplied `Idempotency-Key` is refused, not ignored**
   (`packages/compose/api-auth/src/routes/workforce.ts:1001`). This route mints a fresh billed root
   per call; silently dropping the header would be a lost-write trap.
3. **Rate limit before the body read** (`packages/compose/api-auth/src/routes/workforce.ts:1013`),
   keyed `(tenant, workforce)` — the cost-DoS bound on loop-minting billed roots.
4. **Strict body, byte-capped goal**
   (`packages/compose/api-auth/src/routes/workforce.ts:205`, `refine(withinGoalBytes, …)`). The cap
   is in **bytes**, deliberately: a character cap would admit a multibyte goal that then bricks
   every dispatch against a byte-denominated turn-input budget.
5. **Tenant and workforce reconciliation before the strategy runs**
   (`packages/app/server/src/workforce-goal-intake.ts:107` and
   `packages/app/server/src/workforce-goal-intake.ts:108`) — both return the uniform `not_found`.
6. **`planRefusal` re-validates the returned plan against the declared workforce**
   (`packages/app/server/src/workforce-goal-intake.ts:59`) — undeclared owner
   (`packages/app/server/src/workforce-goal-intake.ts:72`), a department the owner does not belong
   to (`packages/app/server/src/workforce-goal-intake.ts:76`), a non-prior dependency index, a
   title outside the row bounds — called at
   `packages/app/server/src/workforce-goal-intake.ts:116`, **before** the transaction at
   `packages/app/server/src/workforce-goal-intake.ts:125`, so a refused plan writes zero rows.
7. `requestedBy` is stamped from the verified principal
   (`packages/compose/api-auth/src/routes/workforce.ts:1031`), never read from the body.

| Abuse case | Outcome | Evidence |
|---|---|---|
| Cross-tenant goal (foreign tenant or unknown workforce) | uniform `not_found`, strategy never invoked | **PROVEN** — `packages/app/server/src/workforce-goal-intake.db.test.ts`, `reconciles tenant and workforce BEFORE the strategy runs` |
| A plan naming an undeclared owner / foreign department / forward dependency / no steps | typed refusal, **zero rows** | **PROVEN** — `packages/app/server/src/workforce-goal-intake.db.test.ts`, `refuses an invalid plan typed, with ZERO rows` (four cells) |
| Oversized or multibyte goal bricking every later dispatch | refused at intake in bytes | **PROVEN** — the same byte constant is asserted to fit section 4 at module load (`packages/kernel/workforce-tools/src/context.ts:112`), and the delegate-side twin is driven in `packages/app/server/src/workforce-turn-validation.db.test.ts`, `C7: a MULTIBYTE hand-off goal over the BYTE cap` |
| Cost-DoS by loop-minting roots | 429 before the intake runs | **PROVEN** — `packages/compose/api-auth/src/routes/workforce.test.ts`, `C5: rate-limits repeated goal submissions of the SAME workforce` |
| Silent double-submit on a client retry | 400 naming the header | **PROVEN** — `packages/compose/api-auth/src/routes/workforce.test.ts`, `refuses a goal outside the strict schema, a reserved workforce id, and a read-only key` |
| Forged `requestedBy` in the body | strict schema 400; the field is server-stamped | **PROVEN** — same test (strict-schema arm) |
| A plan with an unbounded NUMBER of steps | refused typed, zero rows — one submitted goal cannot become an unbounded write | **PROVEN** — the ceiling is `packages/app/server/src/workforce-goal-intake.ts:68` against `packages/kernel/core/src/seam-contracts.ts:61`; driven by `packages/app/server/src/workforce-goal-intake.db.test.ts`, `refuses every over-reaching plan shape typed, with ZERO rows`, with the at-the-bound control `a plan AT the step bound is created — the bound refuses excess, not decomposition` so the fix is not a blanket refusal |

**What else would produce the same reading.** The intake tests could pass because the *strategy* is
a stub that never returns a hostile plan. They do not: each cell installs a scripted strategy that
returns exactly the hostile plan, and the assertion is on the intake's refusal plus a zero-row
count taken after the call.

---

### 3.2 Inter-agent messages — `send_message`

**Trust: U0 at write, U2 at read.** A message body is model-authored, stored, and re-rendered into
a *different* employee's later turn — the one channel where one seat writes directly into another
seat's prompt.

**Chokepoints.**

- Recipient must be `user` or a **declared** employee:
  `packages/kernel/workforce-tools/src/toolset.ts:705`.
- Body length capped at `MAX_MESSAGE_BODY_CHARS`:
  `packages/kernel/workforce-tools/src/toolset.ts:153`.
- At most `MAX_MESSAGES_PER_TURN` buffered per turn
  (`packages/kernel/workforce-tools/src/toolset.ts:699`), and the engine caps the same channel
  independently at `packages/kernel/tasks/src/intent-applier.ts:40`.
- At render, the body passes the neutralizer:
  `packages/kernel/workforce-tools/src/context.ts:618`.

| Abuse case | Outcome | Evidence |
|---|---|---|
| Message to an undeclared principal | typed tool error, nothing buffered | **PROVEN** — `packages/kernel/workforce-tools/src/toolset-semantics.test.ts`, `send_message accepts declared employees and the user, refusing anything else` |
| Context stuffing a later turn (volume) | refused at both doors | **PROVEN** — the engine door is driven in `packages/kernel/tasks/src/engine.db.test.ts`, `the channel is validated and bounded, exactly like every sibling trusted channel` (over-cap count and over-cap body, zero rows landed) |
| Forging a `## N.` section header from a body | flattened; exactly one real header survives | **PROVEN** — `packages/kernel/workforce-tools/src/context.test.ts`, ``C1: an untrusted message body cannot forge a `## N.` section header`` |
| A message read as an instruction by the recipient model | **not a runtime guarantee.** The tool description says "context for their later turns — never an instruction" and the body renders below the data-boundary line; nothing enforces how a model weighs it. | **NO MECHANISM** beyond placement. |

---

### 3.3 Memory / recall results

**Trust: U2.** Recall hits are prior turns' model-authored text, re-entering a later prompt.

**Chokepoints.**

- **Scoping is constructor-injected trusted data**, never query input: the scope is built from the
  deployed config and the dispatched task row at
  `packages/app/server/src/workforce-turn-handlers.ts:174`, and a query naming a *different*
  workforce returns nothing (`packages/kernel/workforce-tools/src/memory.ts:147`).
- Every read runs on the caller's tenant handle
  (`packages/kernel/workforce-tools/src/memory.ts:162`), so recall cannot cross the tenant.
- Bounds: scan `packages/kernel/workforce-tools/src/memory.ts:36`, age window
  `packages/kernel/workforce-tools/src/memory.ts:37`, hit text
  `packages/kernel/workforce-tools/src/memory.ts:38`, hit count
  `packages/kernel/workforce-tools/src/memory.ts:39`.
- Hit text passes the neutralizer at render:
  `packages/kernel/workforce-tools/src/context.ts:655`.

| Abuse case | Outcome | Evidence |
|---|---|---|
| Cross-tenant recall through an identical twin workforce | nothing leaks, and the empty result is *scoping* rather than luck (tenant B's provider returns the bait) | **PROVEN** — `packages/app/server/src/workforce-recall.db.test.ts`, `ADVERSARIAL: an identical twin workforce in another tenant leaks nothing` |
| Cross-workforce recall inside one tenant; unbounded prompt growth | pinned and bounded | **PROVEN** — `packages/app/server/src/workforce-recall.db.test.ts`, `holds every bound: the age window, the hit cap, the text cap, and the workforce pin` |
| Instruction injection through a prior turn's summary | flattened; cannot forge the boundary line | **PROVEN** — `packages/kernel/workforce-tools/src/context.test.ts`, `C1: an untrusted recall hit cannot forge the data-boundary line` |
| A replacement provider returning a very large hit list | the input is capped **before** the byte-budget shrink loop, so the work is bounded by the ceiling rather than by what the provider returned | **PROVEN** — `packages/kernel/workforce-tools/src/context.ts:645` against `packages/kernel/core/src/seam-contracts.ts:92`, with its own loss marker (`packages/kernel/workforce-tools/src/context.ts:657`) kept distinct from the byte-budget marker because they are different losses. Driven by `packages/kernel/workforce-tools/src/context.test.ts`, `caps the hits it will render, whatever the provider returned, and says how many it dropped` (a 20 000-hit flood), with two controls: `a provider inside the ceiling is rendered whole, with no omission notice` and `the byte budget still applies INSIDE the ceiling, and both losses are reported` |

---

### 3.4 Child task results

**Trust: U2.** A completed child's result is model-authored and is rendered into the parent's turn.

**Chokepoints.** `renderMergedResult` serializes through `JSON.stringify` — which escapes C0 —
and then `escapeRawSeparators` closes the U+0085 / U+2028 / U+2029 residual `JSON.stringify` leaves
raw (`packages/kernel/workforce-tools/src/context.ts:450`, helper at
`packages/kernel/workforce-tools/src/context.ts:278`). Per-entry ceiling
`packages/kernel/workforce-tools/src/context.ts:79` with a compact fallback that keeps the typed
fields; the keyed block drops highest-task-id-first with an explicit marker
(`packages/kernel/workforce-tools/src/context.ts:496`).

| Abuse case | Outcome | Evidence |
|---|---|---|
| Structure forgery from a string *value* inside a result | impossible to emit a raw line break out of the quotes — the escape is lossless `\uXXXX` | **PROVEN** — the same escape path is driven in `packages/kernel/workforce-tools/src/context.test.ts`, `C1: a delegated goal/title with raw line breaks cannot forge structure either` |
| Unbounded fan-in blowing the context ceiling | deterministic drop with a marker; section 4 untouched | **PROVEN** — `packages/kernel/workforce-tools/src/context.test.ts`, `orders children by task id ascending and drops the highest ids first, with a marker`, and `drops section 7 first, then 6, then 5` |
| Silent, unmarked loss of results | every drop emits its marker | **PROVEN** — same two tests |

---

### 3.5 Tool arguments

**Trust: U0.** The rawest surface: bytes the model chose.

**Three independent passes, in order.**

1. **Ajv at the dispatch chokepoint.** `dispatchTool` runs its validate-in only when the tool
   carries `inputSchema` (`packages/kernel/platform/src/dispatch.ts:318`). Every native tool gets
   one **structurally**, bound at the single return of the toolset builder
   (`packages/kernel/workforce-tools/src/toolset.ts:856`) — so a tool added to the table above it
   cannot miss the pass, and the schema the model is *shown* is by construction the schema its
   arguments are checked against.
2. **A per-tool zod `strictObject`**, through `parseEnding`
   (`packages/kernel/workforce-tools/src/toolset.ts:168`), which **records the refusal**
   (`packages/kernel/workforce-tools/src/toolset.ts:171`) before it throws.
3. **The engine's own discriminated union** over the resulting intent
   (`packages/kernel/tasks/src/intent-applier.ts:116`).

**What the engine receives on a refusal is a typed sentinel, never the model's arguments**
(`packages/kernel/workforce-tools/src/collector.ts:35`, selected at
`packages/app/server/src/workforce-turn-handlers.ts:245`). This is the load-bearing part: forwarding
the raw value let a `submit_result` whose arguments failed the toolset schema be re-read by the
engine as a valid intent of a *different* kind — and review-policy matching keys on the intent the
toolset **collected**, which was none. That is a mandatory review skipped by sending the wrong
arguments to the right tool.

| Abuse case | Outcome | Evidence |
|---|---|---|
| Skipping a mandatory review policy via wrong arguments to the right tool | never becomes a completion; the policy still fires | **PROVEN** — `packages/app/server/src/workforce-turn-validation.db.test.ts`, `wrong arguments to submit_result NEVER become a completion` |
| Forging a linkage field (`escalateTo`) through arguments | resolved from the reporting edge, arguments ignored | **PROVEN** — `packages/app/server/src/workforce-turn-validation.db.test.ts`, `a forged escalateTo cannot ride in through the tool arguments` |
| A tool dispatched with unvalidated arguments because it declared only `spec.parameters` | structurally impossible for the native set | **PROVEN** — `packages/kernel/workforce-tools/src/role-privilege.test.ts`, `every tool a role carries sets inputSchema, and it IS the schema the model was shown` |
| Unbounded retry loop on a deterministic refusal | the refusal is recorded, so the turn takes the declared requeue-once-then-fail fate instead of yielding | **PROVEN** — `packages/kernel/workforce-tools/src/toolset-semantics.test.ts`, `malformed turn-ending arguments record the malformed marker and throw a typed tool error`, plus the in-run recovery arm beside it |

**What else would produce the same reading.** "The suite passes" is compatible with the engine
never having been reached. It was: the turn-validation arms above are DB tests driving the real
scheduler and asserting on rows and journal events, not on the toolset's return value.

---

### 3.6 Review results

**Trust: U0 for a model verdict, U1 for an HTTP verdict.**

**The model side never chooses which review it decides.** `submit_review` takes the review id from
the pre-built snapshot (`packages/kernel/workforce-tools/src/toolset.ts:619`, used at
`packages/kernel/workforce-tools/src/toolset.ts:631`), and the snapshot only offers one when the
parent's park binding names **this** task as the dispatched review task
(`packages/kernel/workforce-tools/src/snapshot.ts:191`) **and** the row is undecided **and** its
recorded reviewer is this employee (`packages/kernel/workforce-tools/src/snapshot.ts:202`).

**Who may be *asked* for a review is also bounded**: the allowed set is the declared policies
covering the caller, their own superior holding a decision role, or `user`
(`packages/kernel/workforce-tools/src/toolset.ts:442`), and the caller is removed from it
(`packages/kernel/workforce-tools/src/toolset.ts:449`).

**The HTTP side** parses a strict body (`packages/kernel/tasks/src/reviews.ts:145`), enforces the
recorded reviewer (`packages/kernel/tasks/src/reviews.ts:196`, refusal at
`packages/kernel/tasks/src/reviews.ts:198`), checks the park names *this* review
(`packages/kernel/tasks/src/reviews.ts:214`), and compare-and-swaps on `verdict IS NULL`
(`packages/kernel/tasks/src/reviews.ts:233`).

**The in-engine reviewer turn is the one path where a *named* reviewer is satisfied without
break-glass**: the applier refuses a verdict whose review names someone other than the task owner
(`packages/kernel/tasks/src/apply-intents.ts:962`, alongside the parent check at
`packages/kernel/tasks/src/apply-intents.ts:961`) and then passes that same owner as the actor
(`packages/kernel/tasks/src/apply-intents.ts:984`) — a bare employee id, which
`packages/kernel/tasks/src/decision-authority.ts:60` matches directly. At the HTTP door it cannot
be satisfied at all; see §7.2.

| Abuse case | Outcome | Evidence |
|---|---|---|
| Self-review | the caller is deleted from the allowed set; a policy whose reviewer *is* the submitter falls back to the human | **PROVEN** — `packages/kernel/workforce-tools/src/toolset-semantics.test.ts`, `request_review never accepts the caller as their own reviewer`, and `falls back to the human when the matched reviewer IS the submitter` |
| Deciding a review this task was not dispatched for | no `reviewId` is offered; the tool refuses | **PROVEN** — `packages/kernel/workforce-tools/src/toolset-semantics.test.ts`, `submit_review takes its reviewId from the SNAPSHOT` |
| Unbounded review chain | a review task carries no `request_review`, and the engine refuses the intent too | **PROVEN** — `packages/kernel/workforce-tools/src/toolset-semantics.test.ts`, `a REVIEW task carries no request_review` |
| A second verdict on a decided review | 409, one verdict per round | **PROVEN** — `packages/compose/api-auth/src/routes/workforce.test.ts`, `a review verdict resolves a parked review once (409 on the rerun) and the inbox is tenant-scoped` |
| Deciding a stale review still listed in the inbox | typed 409, nothing written | **PROVEN** — `packages/compose/api-auth/src/routes/workforce.test.ts`, `a stale review decided from the inbox is a typed 409, not a 500` |
| Any `store:write` principal deciding a review addressed to a **named** reviewer | 403 naming the reviewer, row untouched | **PROVEN** — `packages/compose/api-auth/src/routes/workforce.test.ts`, `the review verdict door enforces the recorded reviewer the same way` |

---

### 3.7 Approval decisions

**Trust: U0 for the request, U1 for the decision.** This is the human-in-the-loop artifact, so its
accountability trail is the asset.

**The request side cannot choose its approver.** `request_approval` hardcodes
`approver: 'user'` (`packages/kernel/workforce-tools/src/toolset.ts:533`); the window and the
timeout fate come from the declared rule; and an escalating rule on a seat with no superior is
refused up front rather than sent to the planner
(`packages/kernel/workforce-tools/src/toolset.ts:511`).

**The only writer of a *named* approver is the timeout sweep**, which re-issues an escalating
request to the requester's declared superior
(`packages/kernel/tasks/src/approvals.ts:312`) and journals that name as an accountability fact.

**The decision door keeps the authorization the engine wrote.** `decideApproval` reads the row and
compares the server-derived actor against it (`packages/kernel/tasks/src/approvals.ts:133`),
refusing typed when they differ and no authorized override is present
(`packages/kernel/tasks/src/approvals.ts:135`) — on a plain read, **before** any write, so a
refusal writes nothing. The `status = 'pending'` compare-and-swap
(`packages/kernel/tasks/src/approvals.ts:148`) remains the race arbiter, unchanged.

**The predicate** is one module (`packages/kernel/tasks/src/decision-authority.ts:60`).
`'user'` is the **open sentinel** and stays open — it is the deployment's human operator surface
and the only spelling the grammar admits
(`packages/kernel/tasks/src/decision-authority.ts:41`). The principal scheme set is **closed**
(`packages/kernel/tasks/src/decision-authority.ts:47`) and the identity half must be the whole
remainder (`packages/kernel/tasks/src/decision-authority.ts:64`), so the
`principal:unresolved` sentinel satisfies nothing even if `requireAuth()` were ever dropped.

**Break-glass takes two independent things, and neither alone does anything**
(`packages/compose/api-auth/src/routes/workforce.ts:120`):

1. the request must **ask** — `override: true`, a field on the strict body
   (`packages/kernel/tasks/src/approvals.ts:86`, inside the schema at
   `packages/kernel/tasks/src/approvals.ts:77`), which is intent and never authority;
2. the principal must **hold** `workforce:override`
   (`packages/kernel/auth-core/src/authz.ts:46`), checked through the same permission gate the
   route's `store:write` middleware used (`packages/compose/api-auth/src/routes/workforce.ts:126`),
   and run **before** the engine call (`packages/compose/api-auth/src/routes/workforce.ts:886`) so
   an unauthorized ask is a named 403 rather than a silent downgrade.

The permission is **owner/admin only** — granted in the owner table
(`packages/kernel/auth-core/src/authz.ts:63`) and the admin table
(`packages/kernel/auth-core/src/authz.ts:81`), and in no other role — and **SENSITIVE**, so it
re-checks live membership rather than riding a stale role claim
(`packages/kernel/auth-core/src/authz.ts:116`). It is **not** api-key-grantable; that is an absence,
which no line can cite, so it is pinned by assertion instead — and not merely by the set membership:
`packages/kernel/auth-core/src/authz.test.ts`, `an api-key can NEVER break the glass on a named
approver/reviewer, however it is scoped` drives `authorize()` with a key that holds the scope
explicitly, and again with a key holding **every** scope, and observes the refusal both times.
The override lands in the journal
(`packages/kernel/tasks/src/approvals.ts:173`; the review twin at
`packages/kernel/tasks/src/reviews.ts:268`), present *only* when an override actually happened.

| Abuse case | Outcome | Evidence |
|---|---|---|
| The model selecting its own approver | hardcoded `'user'`; the escalation target comes from the declared reporting edge | **PROVEN** — `packages/kernel/workforce-tools/src/toolset-semantics.test.ts`, `request_approval pulls the declared window for the caller labels and names the escalation target` |
| An escalating rule on a seat with no superior | refused before the planner | **PROVEN** — `packages/kernel/workforce-tools/src/toolset-semantics.test.ts`, `an escalating approval rule on a seat with no superior is refused` |
| A client asserting `decidedBy` | strict body; the field is server-derived | **PROVEN** — `packages/compose/api-auth/src/routes/workforce.test.ts`, `mutations demand store:write: a read-only API key gets the 403 naming the gap` (strict-body arms in the same describe) |
| **The operator whose inaction caused an escalation resolving the escalated request** | 403 naming the recorded approver; the row is untouched | **PROVEN** — `packages/kernel/tasks/src/decision-authority.db.test.ts`, `THE ESCALATION: only the superior the sweep named (or break-glass) may decide the re-issued request`, and `packages/compose/api-auth/src/routes/workforce.test.ts`, `a NAMED approver refuses a different principal — 403, and the row is untouched` |
| Holding `workforce:override` and overriding **silently** | still 403 — the request must also ask | **PROVEN** — `packages/compose/api-auth/src/routes/workforce.test.ts`, `break-glass without ASKING is still refused` |
| A break-glass decision leaving no trace | the journal records who was overridden, and only then | **PROVEN** — `packages/kernel/tasks/src/decision-authority.db.test.ts`, `break-glass decides a named row AND the journal records that an override happened`, with the negative twin `an ordinary (non-override) decision journals NO override field` |
| A near-miss principal spelling satisfying a named decider | refused | **PROVEN** — `packages/kernel/tasks/src/decision-authority.test.ts`, `a DIFFERENT principal never satisfies a named decider`, and `the unresolved-principal sentinel satisfies no named decider` |
| The single-operator posture regressing into a locked-out deployment | `approver: 'user'` rows stay decidable by any `store:write` principal | **PROVEN** — `packages/compose/api-auth/src/routes/workforce.test.ts`, ``REGRESSION GUARD: an `approver: 'user'` row stays decidable by any store:write principal`` |

**What else would produce the same reading.** A 403 in these tests could come from the tenant
guard, the permission middleware, or the authority gate. The tests distinguish them: the
cross-tenant arm asserts **404** (not 403), the missing-permission arm asserts a 403 naming
`workforce:override`, and the mismatch arm asserts a 403 carrying the recorded approver in
`details` **and** re-reads the row to show it untouched.

**The limitation this surface carries is §7.2 and it is not small.** Read it.

---

### 3.8 Operator signals — pause / resume / halt / cancel / signal

**Trust: U1.**

**Only three of the nine signal kinds may be posted from outside**
(`packages/kernel/tasks/src/signals.ts:65`, enforced on the route at
`packages/compose/api-auth/src/routes/workforce.ts:168`). The other six are **mechanism** kinds,
each written by the code that establishes the fact it reports — accepting them from a request would
let a caller assert that fact by hand.

**Release is matched on the PARK — the `(status, reason)` pair — not on the status alone**
(`packages/kernel/tasks/src/signals.ts:160`, matched at
`packages/kernel/tasks/src/signals.ts:218`). Status-only matching is exactly what lets a signal
dissolve a park it says nothing about.

**Two parks no override may dissolve** (`packages/kernel/tasks/src/signals.ts:101`): the fan-out
join and the escalation park, because each waits on a *child task's* terminal — a fact an
operator's override does not change, on a row the override does not touch. `deadline_exceeded`
joins them for `manual_unblock` (`packages/kernel/tasks/src/signals.ts:113`), because unblocking it
livelocks: the next reserve pass re-parks against the same instant.

**The same park vocabulary binds the budget-escalation door**
(`packages/kernel/tasks/src/signals.ts:192`) — a rule enforced on one door and not the next is not
a rule.

| Abuse case | Outcome | Evidence |
|---|---|---|
| Posting `child_completed` / `escalated` to dissolve a join or an escalation park | typed 400 at the route — the kind is not in the operator vocabulary | **PROVEN** — `packages/compose/api-auth/src/routes/workforce.test.ts`, `the route accepts OPERATOR kinds only — a mechanism kind is a typed 400` |
| `manual_unblock` used to release a structural park | recorded, but the park holds | **PROVEN** — `packages/compose/api-auth/src/routes/workforce.test.ts`, `an operator override RECORDS but does not release a structural park, through the route` |
| Killing a turn mid-flight through `cancel` | a cancel is absorbed at a turn boundary, never mid-turn | **PARTIAL** — the mechanism is the cancel cascade and the turn-boundary absorption; the *cascade* is covered by `packages/kernel/tasks/src/cascade-locking.db.test.ts`. That a running turn is never killed is established by construction plus the reaper suites (§7.3), not by an empirical mid-turn kill. |
| Replaying a signal to wake a task twice | idempotent on `(tenant, task, signal_key)` | **PROVEN** — `packages/compose/api-auth/src/routes/workforce.test.ts`, `signal delivery is strict-bodied and idempotent under a supplied key` |
| Halting or pausing another tenant's workforce | uniform 404, no row of theirs touched | **PROVEN** — `packages/compose/api-auth/src/cross-tenant-gate.test.ts`, `MUTATING verbs — signal, decide, verdict, goals, pause, resume, cancel, halt` |

---

### 3.9 Extension-seam outputs

**Trust: U0-equivalent.** Out-of-tree code, running in-process, with the runtime's own privileges.
The seam contract is what bounds it — not the seam's good behaviour.

There are six neutral seams. **Their wiring status differs sharply, and the difference is the whole
security story**, so it is stated per seam rather than in aggregate.

| Seam | Production call site | Return value re-validated? |
|---|---|---|
| `OrchestrationStrategy` | **yes** — the goal intake | **yes** — `planRefusal` (`packages/app/server/src/workforce-goal-intake.ts:59`), except step count (§7.4) |
| `WorkforceMemoryProvider` | **yes** — the turn handler (`packages/app/server/src/workforce-turn-handlers.ts:182`) | **partly** — hits render as bounded, sanitized data (§3.3) and the input count is capped (`packages/kernel/workforce-tools/src/context.ts:645`); a *malformed* hit is rejected only by a confinement nothing calls (§7.1) |
| `ReviewPolicy` | **yes**, but hardcoded — no injection point | n/a |
| `WorkerSelector` (`packages/kernel/core/src/worker-selector.ts:53`) | **NONE** | a confinement exists and **nothing calls it** (§7.1) |
| `CostPolicy` (`packages/kernel/core/src/cost-policy.ts:53`) | **NONE** — see below; the scheduler calls the underlying `authorizeTurn` function directly | a confinement exists and **nothing calls it** (§7.1) |
| `ApprovalProvider` (`packages/kernel/core/src/approval-provider.ts:45`) | **NONE** | a confinement exists and **nothing calls it** (§7.1) |

**How the wiring claims were established** — by probe, not by reading the interfaces, and the probe
is now also a **tripwire that runs every build**: `packages/kernel/core/src/seam-wiring.test.ts`
scans production sources and asserts `WorkerSelector has NO production reference outside its own
module`, the same for `ApprovalProvider`, and — separately, because the shape differs —
`CostPolicy is IMPLEMENTED in the task engine and never constructed`. It `TEETH:` -tests itself by
planting a wiring and confirming detection, and it **fails closed on an empty scan**.

**`LedgerCostPolicy` is constructed nowhere at all** — not in production and not in a test.
`grep` for `new LedgerCostPolicy` across `packages/` and `examples/` returns **zero** hits; the class
is declared at `packages/kernel/tasks/src/budget.ts:551`, re-exported a second time from
`packages/kernel/tasks/src/index.ts:46`, and instantiated by nothing.
`packages/kernel/core/src/strategy-defaults.test.ts` does **not** import `cost-policy.js` and has no
`LedgerCostPolicy` arm; it exercises the *other* defaults. An earlier draft of this page said the
class was "never instantiated outside tests", which is literally true and misleading — it implies a
test instantiates it. Nothing does. The correction runs in the direction that **strengthens** §7.1:
the class is entirely dead code.

**Injection points are narrower than the interfaces suggest.** `orchestrationStrategy` reaches the
composition only through the `buildServer` options object
(`packages/app/server/src/composition-root.ts:3506`), and that option is explicitly **not**
reachable from the environment-derived options
(`packages/app/server/src/composition-root.ts:2043`) — so a production entrypoint always runs the
shipped default. The turn-handler seam beside it carries the same posture, stated in its own
docblock (`packages/app/server/src/composition-root.ts:2034`). `memoryProviderFor` is not passed by
the composition root at all; reaching it means an embedder composing the turn handlers itself.

| Abuse case | Outcome | Evidence |
|---|---|---|
| A strategy naming an undeclared owner, a foreign department, or a forward dependency | refused before the first insert, zero rows | **PROVEN** — `packages/app/server/src/workforce-goal-intake.db.test.ts`, `refuses an invalid plan typed, with ZERO rows` |
| A seam asserting a tenant identity | **structurally impossible** — no seam type carries a tenant field; tenant is injected into the callee by trusted composition code and never read back from a return value | **PROVEN by construction**, checked against the three interface definitions cited above. |
| A memory provider injecting instructions | rendered as bounded, sanitized data | **PROVEN** — §3.3's C1 arm |
| A selector returning a non-candidate; a cost policy allowing what the baseline denied; an approval provider answering its own question | each is refused **by a confinement wrapper that no production code calls** — so on a running deployment nothing happens, because nothing calls those seams either | **The refusal is tested; the wiring does not exist.** `packages/kernel/core/src/seam-confinement.test.ts` drives each over-reach against the wrapper and observes the refusal. Read §7.1 before counting this as a control. |
| A strategy returning an unbounded plan | refused typed, zero rows | **PROVEN** — §3.1 |

`packages/kernel/core/src/strategy-defaults.test.ts` covers the **shipped defaults' honesty** (that
each default does what its docstring says, including refusing rather than guessing).
`packages/kernel/core/src/seam-contracts.ts` is a **conformance kit an out-of-tree implementer runs
against their own implementation** — `workerSelectorContract(selector)` and friends — not a dispatch
path this runtime executes. Neither drives a hostile implementation through a production call site,
because for three of the seams no such call site exists.

---

## 4. Model output is never authority

The invariant is that no model output directly mutates a workforce row, selects a principal, grants
itself a tool, or bypasses a policy. Every model-reachable identifier is resolved by trusted code
against the deployed declaration, and re-checked by the kernel:

| Identifier | Resolved where | Test |
|---|---|---|
| delegation target (employee) | `packages/kernel/workforce-tools/src/resolve-target.ts:64` | `packages/kernel/workforce-tools/src/toolset-semantics.test.ts`, `resolves employee:, department: (manager) and team: (lead) to their owners` |
| delegation target, manager scope | `packages/kernel/workforce-tools/src/resolve-target.ts:109`, own-department members at `packages/kernel/workforce-tools/src/resolve-target.ts:126`; `team:` refused outright at `packages/kernel/workforce-tools/src/resolve-target.ts:116` | `packages/kernel/workforce-tools/src/toolset-semantics.test.ts`, `a manager reaches own department members and led-team members — nothing else`, and `the led-team grant exists exactly where the task IS that team's work` |
| escalation target | `packages/kernel/workforce-tools/src/toolset.ts:586` — the reporting edge, never arguments | `packages/app/server/src/workforce-turn-validation.db.test.ts`, `a forged escalateTo cannot ride in through the tool arguments` |
| reviewer | `packages/kernel/workforce-tools/src/toolset.ts:442` | `packages/kernel/workforce-tools/src/toolset-semantics.test.ts`, `request_review refuses a reviewer outside the caller scope — no org-wide routing` |
| review id | `packages/kernel/workforce-tools/src/snapshot.ts:202` | `packages/kernel/workforce-tools/src/toolset-semantics.test.ts`, `submit_review takes its reviewId from the SNAPSHOT` |
| message recipient | `packages/kernel/workforce-tools/src/toolset.ts:705` | `packages/kernel/workforce-tools/src/toolset-semantics.test.ts`, `send_message accepts declared employees and the user, refusing anything else` |
| approver | not chosen at request time (`packages/kernel/workforce-tools/src/toolset.ts:533`); **enforced at decision time** (§3.7) | `packages/kernel/tasks/src/decision-authority.db.test.ts` |
| tenant | server-derived (`packages/compose/api-auth/src/http/middleware.ts:150`) | `packages/app/server/src/workforce-goal-intake.db.test.ts`, `reconciles tenant and workforce BEFORE the strategy runs` |
| `requestedBy` | server-stamped for a root (`packages/compose/api-auth/src/routes/workforce.ts:1031`), inherited from the parent owner for a child (`packages/kernel/tasks/src/create-task.ts:259`); the child schema is a `strictObject` carrying no such field (`packages/kernel/tasks/src/create-task.ts:106`) | neutralized anyway — `packages/kernel/workforce-tools/src/context.test.ts`, ``C1: `requestedBy` cannot forge a section header from section 4`` |

**No privilege inheritance.** The toolset is keyed on the **task owner** alone and indexed by that
employee's declared role; nothing in the call chain carries a parent's role, agent, or tool list.
**PROVEN** — `packages/kernel/workforce-tools/src/role-privilege.test.ts`, `the toolset is a
function of the TASK owner alone — two roles never blend`.

---

## 5. Deployer-authored configuration (T1)

The document is trusted for its **content** and untrusted for its **shape** (§6.2).

Two changes since the earlier inventory matter here:

- **`capabilities` is now `labels`**, and a label is a `SafeIdentifier`
  (`packages/kernel/spec/src/workforce-grammar.ts:95`, applied at
  `packages/kernel/spec/src/workforce-grammar.ts:146` and
  `packages/kernel/spec/src/workforce-grammar.ts:236`) — the same
  `/^[a-z_][a-z0-9_]*$/` shape every other identifier carries
  (`packages/kernel/spec/src/identifier.ts:19`). Labels are opaque tokens matched for equality,
  never interpreted.
- **A rule guarding a label no employee holds is now a lint ERROR, not a warning**
  (`packages/kernel/spec/src/workforce-lint.ts:697`). A clause that can never fire is a typo that
  silently disables a control, and refusing the document is the fail-closed reading.

**A declared agent tool may not carry a native tool's name** — refused at parse
(`packages/kernel/spec/src/workforce-lint.ts:236`) and again at dispatch composition
(`packages/kernel/workforce-tools/src/toolset.ts:75`, called at
`packages/app/server/src/workforce-turn-handlers.ts:157`), both through one shared predicate that
normalizes the MCP-bridged spelling (`packages/kernel/core/src/workforce-ids.ts:80`, over the set at
`packages/kernel/core/src/workforce-ids.ts:42`). See §6.4 for what happens *behind* those doors.

**A declared agent tool with `idempotent: false` is refused on workforce turns**
(`packages/app/server/src/workforce-turn-handlers.ts:161`) — a turn body re-executes on recovery,
and a side-effecting tool would re-fire.

---

## 6. Cross-cutting defences

### 6.1 Tenant scope — structural, application-level, deny-by-default

**Mechanism.** One chokepoint class injects the tenant predicate into every statement:
`select` (`packages/kernel/db/src/tenant-db.ts:150`), `insert` auto-stamps
(`packages/kernel/db/src/tenant-db.ts:171`), `update` injects the predicate
(`packages/kernel/db/src/tenant-db.ts:192`) **and strips a caller-supplied `tenantId` from the SET**
(`packages/kernel/db/src/tenant-db.ts:195`) so no update can move a row between tenants, `delete`
injects it too (`packages/kernel/db/src/tenant-db.ts:208`). A table not registered in the scoped
tuple throws (`packages/kernel/db/src/tenant-db.ts:52`) — deny by default. All nine `workforce_*`
tables are in the core tuple (`packages/kernel/db/src/schema.ts:1151`). A transaction sets a
tenant GUC (`packages/kernel/db/src/tenant-db.ts:45`) as groundwork; see the RLS caveat below.

**Proven.** `packages/compose/api-auth/src/cross-tenant-gate.test.ts` carries a workforce arm that
seeds two orgs from **one frozen declaration** — byte-identical workforce id, employee ids,
department ids, team ids — and then:

- pins that the iterated table set **is** the nine workforce tables, so the arm cannot go vacuous
  (`the iterated table set IS the nine workforce tables`);
- shows **Postgres itself** refuses a byte-identical task id or approval id in a second tenant
  (`POSTGRES ITSELF refuses a byte-identical task id`) — every workforce table carries a *global*
  single-column primary key, which is a stronger guarantee than an application predicate;
- reads every one of the nine tables through the tenant handle and gets only the caller's rows
  (`every one of the nine tables, read through the tenant handle, returns ONLY the caller`);
- partitions both workforce `run_events` namespaces, including the **identical** control `run_id`
  (`both workforce run_events namespaces are partitioned`);
- drives every mutating verb and shows no row of the other tenant moves
  (`MUTATING verbs — signal, decide, verdict, goals, pause, resume, cancel, halt`).

The before/after snapshots in that arm are read with **raw SQL**, not through the chokepoint — an
unchanged-after assertion read through the very predicate under test would move in lockstep with a
broken predicate and pass vacuously.

**The gap that remains.** The CI tripwire that would catch a *new* unscoped read
(`scripts/check-tenant-chokepoint.mjs`) is a regex scanner with blind spots its own docstring names:
multi-hop aliases, getters, computed property access, and everything under `*.test.ts` or
`/test-support/`. The load-bearing defence against a future missing `.where()` is that the unscoped
handle constructors are not exported from the database package's main surface — which is sound and
**is not itself pinned by a test at the workforce table set**. **NO TEST** for that specific
property.

**RLS is not used.** There is no `CREATE POLICY` and no `ENABLE ROW LEVEL SECURITY` anywhere in the
tree — probed by grep across `packages/`, `examples/` and `deployments/`; the only match in the repo
is a SQL-injection *fixture string* in a parser negative test. This is a deliberate non-goal (§8),
not an oversight, and it means tenant isolation is exactly as strong as the application chokepoint
above.

### 6.2 The prompt/data boundary

**The rule is positional, not provenance-based: nothing interpolated into a line may contain a line
boundary.** The neutralizer strips every line-boundary and control class — C0, DEL, C1 including
U+0085 NEL, plus U+2028 LS and U+2029 PS (`packages/kernel/workforce-tools/src/context.ts:238`,
applied by `packages/kernel/workforce-tools/src/context.ts:240`). For JSON-serialized values,
`JSON.stringify` escapes C0 and `packages/kernel/workforce-tools/src/context.ts:278` closes the
three-character residual losslessly.

**Config-derived text goes through the same neutralizer**, under a name that records which side of
the boundary the value came from (`packages/kernel/workforce-tools/src/context.ts:273`). This is not
a claim that config is untrusted: its *content* is still authority. What it can no longer do is
choose where in the document it appears — and sections 1–3 are where a forged header is most
persuasive, because everything above the data-boundary line reads as the platform speaking. Applied
to line 1 itself (`packages/kernel/workforce-tools/src/context.ts:679`), to labels
(`packages/kernel/workforce-tools/src/context.ts:307`), and to every other config string in
sections 1–3. `requestedBy` is neutralized too
(`packages/kernel/workforce-tools/src/context.ts:524`) even though it is server-derived today,
because "safe by virtue of who writes it" is a property of the current writers, not of the frame.

**PROVEN** — `packages/kernel/workforce-tools/src/context.test.ts` carries a forgery arm per
channel: message body, recall hit, department mission
(``C1: a forged `## N.` header in a DEPARTMENT MISSION cannot reach column 0``), employee title,
workforce/department name, review-rule id and reviewer, `requestedBy`, and a delegated goal/title.
Each asserts **exactly one real header line** *and* that the words survive — flattened, never
dropped.

**The goal is never trimmed.** An oversized goal is a typed refusal
(`packages/kernel/workforce-tools/src/context.ts:536`), not a silent shortening, and two module-load
asserts make that refusal unreachable for legally-created goals rather than merely typed: the
mandatory budgets plus guidance fit the ceiling (`packages/kernel/workforce-tools/src/context.ts:97`
against `packages/kernel/workforce-tools/src/context.ts:68`), and the creation-surface byte cap plus
section 4's fixed overhead fit the task budget
(`packages/kernel/workforce-tools/src/context.ts:112`). The one place the drop loop could fail open
is closed typed (`packages/kernel/workforce-tools/src/context.ts:712`).
**PROVEN** — `packages/kernel/workforce-tools/src/context.test.ts`, `NEVER trims the goal: an
oversized goal is a typed refusal`.

**Assembly is deterministic.** **PROVEN** — `packages/kernel/workforce-tools/src/context.test.ts`,
`is byte-deterministic: 100 assemblies of one input are identical`. Recall is the one input that can
re-rank across time (a whole-turn re-execution reads a moved clock); that is transcript variance,
and the final application stays receipt-idempotent (§7.3).

### 6.3 The principal is server-derived

`actorFrom` (`packages/compose/api-auth/src/routes/workforce.ts:95`) reads the authenticated
principal and returns `user:<id>` / `api-key:<id>`, with a closed sentinel rather than a guessable
identity; `requireAuth()` runs before every caller. It is the sole source of `actor` / `decidedBy`
on every mutating route (`packages/compose/api-auth/src/routes/workforce.ts:892` on the
approval-decide route, `packages/compose/api-auth/src/routes/workforce.ts:966` on the
review-verdict route, and the signal/cancel/pause/resume/halt routes). The route is named beside
each line because `actor: actorFrom(c),` is not a distinctive string — it appears eight times in
this file — so a line number alone would not tell a re-pinner which one was meant. The client cannot even *attempt* the assertion: every mutating body is a `z.strictObject`,
so a body carrying `decidedBy` is a 400, not a silently ignored field. Tenant is derived the same
way (`packages/compose/api-auth/src/http/middleware.ts:174`).

### 6.4 Native tools cannot be shadowed — now structurally

Two refusal doors (§5) sit in front. **Behind** them, the composition spreads the declared agent
tools first and the runtime's natives **last**
(`packages/app/server/src/workforce-turn-handlers.ts:104`, returning at
`packages/app/server/src/workforce-turn-handlers.ts:108`, used at
`packages/app/server/src/workforce-turn-handlers.ts:217`), and the dispatcher indexes its list into
a by-name map where the later entry wins
(`packages/kernel/platform/src/dispatch.ts:226`). So a collision that somehow reached dispatch
resolves to the runtime's own tool. This was the reverse until recently: the doors were the *only*
barrier, contradicting their own stated rationale.

**PROVEN** — `packages/app/server/src/workforce-tool-precedence.test.ts` establishes the instrument
in **both** directions, re-asserts the door on the very list it then dispatches past
(`DOOR: the composition still REFUSES the colliding tool list this suite then dispatches`), and only
then asserts the property (`PROPERTY: composeTurnTools dispatches a reserved name to the NATIVE
handler`). The composition's own use of the helper is pinned separately, so the function cannot be
correct-and-uncalled: `packages/app/server/src/workforce-turn-validation.db.test.ts`,
`the composition offers the DECLARED agent tools first and the NATIVE toolset last`.

### 6.5 Tenant erasure

The tenant data-erasure control seam is wired on **every** boot, under no condition at all — the
product deploy (`packages/app/server/src/product-boot.ts:2978`), the declared-spec deploy
(`packages/app/server/src/composition-root.ts:3565`) and the no-document auth-only boot
(`packages/app/server/src/composition-root.ts:2300`) each build one.

**Two successive conditions each chased the shape whose data had just been noticed, and each was
falsified by the next one.** "No product stores ⇒ no tenant data" was falsified by the task engine:
both shipped workforce examples declare zero stores while their databases hold the tenant's whole
task graph and both workforce `run_events` namespaces. The *stores-or-workforce* condition that
replaced it was falsified in turn by the agent-run surface, which `createAuthApp` mounts on every
boot — so a deployment declaring neither still accumulates that tenant's `runs`, its `journal_steps`
(raw model output), its `conversation_items` (the raw transcript) and its `run_events` journal.
The generalization is the point: **any condition here is a shape the seam is missing from**, which
is why there is now none. What a document declares changes what *else* there is to erase, never
whether there is anything.

**Wiring is not arming.** A defined seam erases nothing by existing: the destructive act stays gated
on `RAYSPEC_ERASURE_ENABLED`, resolved at the composition root and never a spec flag, and an unset
gate makes every call a counts-only DRY-RUN preview.

**PROVEN** — `packages/app/server/src/auth-only-erasure-boot.db.test.ts`, `2. the tenant-erasure
control seam is WIRED on a declared-agents auth-only boot`; the same suite's no-document case,
`packages/app/server/src/auth-only-erasure-boot.db.test.ts`, `7. a boot with NO document at all
wires the seam too, and still previews`; the store-less workforce case,
`packages/app/server/src/workforce-erasure-boot.db.test.ts`, `2. the tenant-erasure control seam is
WIRED on a store-less workforce boot`; and
`packages/app/server/src/erase-tenant.db.test.ts`, `14. a FULL erase (not scrub) still removes the
WHOLE task graph, budget ledger included` — the last is what makes the workforce half of the
oracle non-vacuous, where it previously asserted `0 === 0`.

---

## 7. Limitations — stated plainly

These are not footnotes. A reviewer who reads only this section has the honest picture.

### 7.1 Three seams have no production call site — so their confinements are LANDED BUT UNCALLED

`WorkerSelector`, `CostPolicy` and `ApprovalProvider` are **not called anywhere in production code**.
That is not an inference from reading the interfaces; it is asserted every build by a tree-scanning
tripwire that fails closed on an empty scan and self-tests by planting a wiring
(`packages/kernel/core/src/seam-wiring.test.ts`, `WorkerSelector has NO production reference outside
its own module` and its two siblings). `LedgerCostPolicy` is constructed nowhere at all (§3.9).

**Return-value confinements now exist** — `confineWorkerSelector`, `confineCostPolicy`,
`confineApprovalProvider` and `confineMemoryProvider` in
`packages/kernel/core/src/seam-confinement.ts` — and each rebuilds the return value field by field
rather than trusting the shape it was handed. They are tested against deliberately over-reaching
implementations (`packages/kernel/core/src/seam-confinement.test.ts`).

**And nothing calls them.** A repo-wide search for the four wrapper names across `packages/` and
`examples/`, excluding tests and their own module, returns **two hits, both prose inside docblocks**
— no invocation. So the accurate description is **landed but uncalled**, not "protected":

> **The confinements for these three seams are enforced by code nothing calls, because nothing calls
> those seams either.** They are a contract written down in advance and proven against hostile
> fixtures — not a control operating on a running deployment.

The consequence for a reviewer is unchanged by their landing: **if any of these three seams is wired
in a future change, the wiring change is the security review.** What has improved is that the
confinement it must call now exists and is tested, so wiring it correctly is a small deliberate act
rather than a design task — and the tripwire above will go red the moment the wiring appears, which
is exactly when someone should look.

The consequence for a reviewer: if any of these three seams is wired in a future change, the wiring
change is the security review, and it must land its confinement in the same commit.

### 7.2 There is no principal-to-employee binding

**This is the sharpest limitation on the page.**

Two namespaces meet on the `approver` and `reviewer` columns:

- the **declaration** namespace — `'user'`, or a declared employee id, which is a `SafeIdentifier`
  (`packages/kernel/spec/src/identifier.ts:19`): lowercase letters, digits and underscore only, so
  **`-` is not admissible**;
- the **principal** namespace — what the server derives from an authenticated request:
  `user:<userId>` or `api-key:<apiKeyId>`, where both ids are UUIDs
  (`packages/kernel/db/src/schema.ts:68`), which **always contain `-`**.

The two are therefore **structurally disjoint**: at the HTTP door, `mayDecide`
(`packages/kernel/tasks/src/decision-authority.ts:60`) can never match a *named* decider against an
authenticated principal, because the identity half of a principal string is a UUID and a declared
employee id cannot be one.

**Consequences, stated without softening:**

1. For an approval that names an employee — which is exactly what the escalation sweep mints
   (`packages/kernel/tasks/src/approvals.ts:312`) — **break-glass is the only route at the HTTP
   door, not a fallback.** The "the named superior decides it" path the escalation fate advertises
   is unreachable end to end.
2. `decideApproval` has exactly one production caller, the HTTP route
   (`packages/compose/api-auth/src/routes/workforce.ts:888`). There is no in-engine approval
   decision path. So consequence 1 has no exception.
3. **An api-key-only deployment cannot resolve an escalated approval at all.**
   `workforce:override` is not api-key-grantable by design, so a machine credential can decide every
   `approver: 'user'` row through `store:write` and no named row whatsoever.
4. The review side has one exception, and only one: the **dispatched reviewer's own turn** journals
   the bare employee id as its actor (`packages/kernel/tasks/src/apply-intents.ts:984`), which
   `mayDecide` matches directly. That is the in-engine path; the HTTP verdict door behaves exactly
   like the approval door.

**The enforcement is still correct** — it fails closed, and the journal records who overrode whom.
What is missing is the binding that would make the intended path work.

**This is a decided boundary, not an open question.** A principal-to-employee binding is an
identity-mapping feature with its own trust surface — who may claim to be an employee, and who
authorises that claim — and it is deliberately **not** built in this release. So the honest reading
of `onTimeout: 'escalate'` is: it re-routes the *accountability record* to the declared superior and
it re-opens the decision window, and on an HTTP-only deployment the decision itself is taken by
break-glass. No document may imply that the named-approver path works end to end.

**The grammar does not yet say so, and that is a gap.** A document declaring `onTimeout: 'escalate'`
is accepted today with one exception: the lint refuses a policy that escalates *and covers the
orchestrator seat*, because the orchestrator reports to nobody and the runtime could not build the
fate at all (`packages/kernel/spec/src/workforce-lint.ts:643` guards the fate,
`packages/kernel/spec/src/workforce-lint.ts:650` raises it as an error). That is a **different**
condition from the one on this page: it catches "there is no superior to name", not "the superior
who *is* named cannot be matched by any authenticated principal".

**The second condition now HAS a diagnostic** (B-017k). `doctor` raises the
`workforce_escalation_unreachable` **advisory** on every escalating policy, at that policy's own
path (`packages/kernel/spec/src/workforce-lint.ts:871`), so an author learns this at authoring time
rather than from a 403 at 2am. Three things it deliberately is not, because each would overstate it:

- it is a **warning, not an error**. The declaration is correct and the row *is* decidable — by an
  owner or admin through break-glass. What is narrower than an author assumes is the resolution
  *path*, and whether that bites depends on deployment posture the document cannot see. Refusing the
  parse would make half a frozen closed enum unusable;
- it is **not acknowledgeable**. `lintSuppress` is scoped to the node carrying it and no node's path
  reaches `workforce.…`, so the code is excluded from `SuppressibleWarningCode`
  (`packages/kernel/spec/src/errors.ts:417`) rather than offering an acknowledgement that would
  silence nothing;
- it **changes no enforcement**. The 403 at the decision door, the break-glass gate and the journal
  are exactly as described above. The advisory tells an author what this page tells a reader; it
  does not build the binding, which remains deliberately out of this release.

### 7.3 Mid-turn crash safety is SIMULATED, not empirically proven

The engine's recovery story is that a process death mid-turn cannot double-apply a turn's effects
and cannot strand a claim. That property is established by **construction plus two suite families**,
never by killing a process inside a running turn:

- **Receipt idempotency** — a replayed turn is a no-op at the row level, pinned by
  `packages/kernel/tasks/src/turn-dedupe.db.test.ts` (for example `a replayed request_approval turn
  is a receipt no-op and leaves exactly one approval row`), including the case where the receipt
  itself is gone.
- **Claim reaping** — a claimed turn whose workflow is dead or wedged is reaped and its reservation
  released, pinned by `packages/workflow/durable-dbos/src/task-scheduler.db.test.ts` (for example
  `a WEDGED turn — DBOS still PENDING — is reaped once its claim lease expires`), with the negative
  twin that a live turn inside its lease is never reaped.

Both end-to-end process kills in this repository land at a **park**, never inside a running turn.
The vision permits this. It must never be reported as an empirical mid-turn crash test, and this
page does not.

### 7.4 Two unbounded inputs behind the wired seams — both now CLOSED

Recorded here rather than deleted, because the shape is the useful part: both were
resource-exhaustion reachable only through an installed out-of-tree implementation, neither was a
privilege escalation, and both were found by driving the seam rather than by reading it.

1. **A plan had no step ceiling** — one submitted goal could become an unbounded write, since the
   plan is created as sibling roots inside one transaction
   (`packages/app/server/src/workforce-goal-intake.ts:125`). **Closed:**
   `packages/app/server/src/workforce-goal-intake.ts:68` bounds `plan.steps.length` against
   `packages/kernel/core/src/seam-contracts.ts:61`, with a test at the bound so the fix refuses
   excess rather than decomposition (§3.1).
2. **Recall rendering was quadratic in the hit count a provider returned.** The byte budget always
   held; the *cost* of holding it grew with the square of the input. **Closed:**
   `packages/kernel/workforce-tools/src/context.ts:645` caps the input before the shrink loop, under
   its own marker (§3.3). The shipped provider still self-caps well inside the ceiling
   (`packages/kernel/workforce-tools/src/memory.ts:39`), so no shipped configuration ever reached
   either version.

**Both were recorded on this page as NO MECHANISM, NO TEST while that was true, and both statements
were false within a day of being written.** That is the shelf life of an absence claim, and it is
why §7.5's last bullet exists.

### 7.5 Smaller gaps, named rather than omitted

- **~~`planRefusal` has untested branches.~~ CLOSED.** An earlier draft recorded that the title-length
  and dependency-count branches had no test cell — and **under-enumerated its own gap**, because the
  empty-goal branch (`packages/app/server/src/workforce-goal-intake.ts:76` is the department check
  one line below it) was untested and unnamed. All three are now driven:
  `packages/app/server/src/workforce-goal-intake.db.test.ts`, `refuses every over-reaching plan shape
  typed, with ZERO rows` carries a cell for an over-bound title, an empty title, an empty goal and an
  over-count dependency list, each asserting zero rows. Kept as a struck-through entry rather than
  deleted: a gap statement that missed a member of the very set it was enumerating is the program's
  own recorded failure mode — *probing proves only what you thought to probe* — and the correction is
  worth more visible than tidy.
- **Whether a model treats a message or a recall hit as an instruction is not enforceable here.**
  The runtime controls placement (below the data-boundary line) and shape (no forged headers). It
  does not control the model.
- **The unscoped-handle non-export property (§6.1) is not pinned by a test.**
- **The goals route has no idempotency key.** It refuses one loudly rather than dropping it, which
  converts a silent double-bill into a visible 400 — but exactly-once submission is the caller's job
  today.
- **What this page's own guard does not catch.**
  `packages/kernel/workforce-tools/src/threat-model-drift.test.ts` checks that every cited line
  still contains the text the ledger records, and that every quoted test title still exists. It
  does **not** check that a cited line is the *right* line for the argument built on it, and it
  cannot check a claim made without a citation. Its arms were each proved to have teeth by mutation
  — and that battery found one of them missing (a title renamed in the prose alone went green,
  because only the appendix copy was checked), which is why arm 6 exists.

  **The residual class is the near miss, and this page shipped one before a manual audit caught
  it.** An earlier draft cited `packages/app/server/src/composition-root.ts:2034` for the claim that
  the *orchestration strategy* option is unreachable from the environment. That line is the
  **turn-handler** option's docblock; the strategy's own is
  `packages/app/server/src/composition-root.ts:2043`. Same file, adjacent block, and both contain
  the phrase the ledger recorded — so the guard passed it, correctly and uselessly. A citation that
  is stable is not thereby a citation that is *apt*, and only reading the enclosing function or
  docblock settles which. Every citation in this page whose recorded text also occurs elsewhere in
  its own file was re-checked that way.
- **An absence claim has a SHELF LIFE, and this page has already outlived two of its own.** §7.4's
  two gaps were recorded as **NO MECHANISM, NO TEST** — true when written, false within a day, once
  the change that closed them merged. The direction of that error is the point: a page whose whole
  discipline is *no sentence claims more than its evidence* must not ship claiming **less** than the
  tree either, because a reader who finds one understatement cannot tell which direction any other
  claim errs in. Understating corrodes the same credibility overstating does. **Every NO TEST /
  NO MECHANISM statement here must be re-verified against the current tip immediately before this
  page ships — not against the tree its author started from.** The citation guard cannot do this
  for you: it checks that cited lines still say what they said, and an absence has no line to cite.

---

## 8. Non-goals — what this release does not provide

The vision's non-goal list is reproduced here so that a reader of *this* page cannot mistake an
unlisted item for a delivered one. **None of the following is provided:**

- public internet exposure;
- shared untrusted multi-tenant hosting;
- per-tenant agent sandboxes;
- PostgreSQL row-level security as the primary tenant boundary;
- customer-managed KMS/DEK lifecycle;
- DPoP or token binding;
- cross-run learning; historical-performance routing; semantic/vector memory;
- automatic model/provider cost optimization; adaptive organization redesign;
- an administrative web UI;
- SSO, SCIM, enterprise RBAC, compliance exports, or SLAs;
- stable v1 semantics for the experimental `workforce:` grammar.

The tenant boundary that **is** provided is §6.1's application-level chokepoint. It is a real
boundary against application bugs and a co-operating multi-tenant workload; it is **not** a boundary
against a hostile tenant with database access, and RLS is not standing behind it.

---

## 9. The posture warning, and where it is enforced

The boot banner prints the posture **unconditionally on every full boot**, with no environment
variable that suppresses it. Two exported constants carry it
(`packages/app/server/src/banner.ts:22` and `packages/app/server/src/banner.ts:38`); the full
banner names it in its title (`packages/app/server/src/banner.ts:60`) and the static-profile banner
carries the same headline (`packages/app/server/src/banner.ts:225`) and the **byte-identical**
warning block (`packages/app/server/src/banner.ts:235`).

**PROVEN** — `packages/app/server/src/banner.test.ts` asserts the constants against their shipped
bytes first (`the exported constants ARE the shipped strings — the anti-circularity control`),
without which every other arm would follow a reworded constant into a banner that no longer warns
anyone; then that both banners carry it (`the STATIC-PROFILE boot banner carries the SAME warning,
byte-identically`); then that neither offers a suppression variable.

**Bind posture.** The server defaults to a loopback host. There is **no refusal** of a non-loopback
bind — `RAYSPEC_HOST=0.0.0.0` is honoured as a deliberate opt-in, and the banner prints identically
either way. That is a documented choice, not an oversight, and it is why the banner's content
matters more than the default.

The same warning appears in `README.md`, `SECURITY.md`, `docs/ARCHITECTURE.md`,
`docs/cli-reference.md`, `docs/v1-posture.md`, the server package README, the `deployments/` sample,
`docker-compose.yml`, and the generated OpenAPI description.

**In the examples it is not universal, and the exact set matters.** Fourteen of eighteen example
directories carry it. **Four carry no posture warning in any phrasing** — `examples/acme-notes`,
`examples/acme-notes-backend`, `examples/agent-boot-backend` and `examples/local-boot` — because
none of them has a README or PRD to carry one: they are spec fixtures, a generated backend, a bare
`.yaml`, and a test harness respectively. A reader may reasonably judge that those four are not
user-facing surfaces; that is an argument for the boundary, not for the sentence. An earlier draft
of this page said the warning appears in "every shipped example", which is **false as written**, so
it is stated by count and by name here instead.

One further caveat that only a phrasing-aware search finds: `examples/notes-ui` carries the warning
in **different words** ("LOCAL, trusted posture", "not internet-facing without the separate
external-exposure hardening layer") rather than the shared blockquote. It is covered, but it is a
live instance of exactly the drift the next paragraph admits to.

**No drift test cross-checks any of those prose copies against `banner.ts`** — only the banner's own
two constants are pinned. **NO TEST** for the prose copies.

---

## 10. What changed since the trust-surface inventory

The inventory (`planning/inventories/B-016-threat-surface-inventory.md`, §4) was a snapshot taken
before fourteen PRs landed. It was the input to this page, not its replacement; every claim in it
was re-derived. **Its prose mostly survived; its line numbers largely did not** — which is the
ordinary fate of a `file:line` in a moving tree, and the reason this page ships a guard rather than
a promise. The material changes:

| Inventory finding | Status on this tree |
|---|---|
| **F-1** no workforce arm in the cross-tenant gate | **closed** — eight arms, §6.1 |
| **F-2** the recorded `approver`/`reviewer` is never enforced | **closed** — enforced at both decision doors, with journaled break-glass, §3.7 — and it produced §7.2 |
| **F-3** the posture banner is unpinned and absent from the static boot | **closed** — §9 |
| **F-4** tool precedence is inverted relative to its rationale | **closed** — natives win structurally, §6.4 |
| **F-5** config text renders unsanitized | **closed** — §6.2 |
| **F-6** the posture warning is missing from four examples, `deployments/`, compose and OpenAPI | **PARTIAL.** `deployments/`, `docker-compose.yml` and the generated OpenAPI are closed; **four examples still carry no warning** — the same count B-016 reported, though a different reading of which four are user-facing. §9 names them. |
| **F-7** the unwired seams have no return-value re-validation | **closed as written, but read §7.1.** Confinements exist and are tested against hostile fixtures; **nothing calls them**, because nothing calls the seams. A tripwire now asserts that absence every build. |
| **F-8** `requestedBy` skips the neutralizer | **closed** — §6.2 |
| `employees[].capabilities` | renamed to `labels`, `SafeIdentifier`-constrained, and the unheld-label rule is now a lint **error** — §5 |
| erasure is not wired for a store-less workforce | **closed** — §6.5 |

The inventory also carries an in-place correction of its own (a citation that did not support the
claim built on it). That correction stands; it is the reason this page's citations are guarded by a
test rather than by care.

---

## Appendix A — citation ledger

Every `file:line` in the prose above, with the text that line must still contain. Checked by
`packages/kernel/workforce-tools/src/threat-model-drift.test.ts` on every run, in both directions —
an entry here that no longer matches is a failing test, and a citation in the prose that is missing
here is also a failing test.

```text
packages/kernel/workforce-tools/src/context.ts:68 | export const TURN_INPUT_MAX_BYTES = 65_536;
packages/kernel/workforce-tools/src/context.ts:79 | export const CHILD_RESULT_MAX_BYTES = 4_096;
packages/kernel/workforce-tools/src/context.ts:97 | if (MANDATORY_CEILING + GUIDANCE_CEILING >= TURN_INPUT_MAX_BYTES) {
packages/kernel/workforce-tools/src/context.ts:112 | if (MAX_TASK_TEXT_BYTES + TASK_SECTION_FIXED_OVERHEAD_BOUND > SECTION_BUDGETS.task) {
packages/kernel/workforce-tools/src/context.ts:238 | const UNTRUSTED_STRUCTURE_CHARS =
packages/kernel/workforce-tools/src/context.ts:240 | function sanitizeUntrusted(text: string | null): string {
packages/kernel/workforce-tools/src/context.ts:273 | const sanitizeConfig = sanitizeUntrusted;
packages/kernel/workforce-tools/src/context.ts:278 | function escapeRawSeparators(json: string): string {
packages/kernel/workforce-tools/src/context.ts:307 | employee.labels.length > 0 ? employee.labels.map(sanitizeConfig).join(', ') : 'none declared';
packages/kernel/workforce-tools/src/context.ts:450 | const whole = escapeRawSeparators(JSON.stringify(entry, null, 1));
packages/kernel/workforce-tools/src/context.ts:496 | ...(omitted > 0 ? [`[…${omitted} omitted: byte budget]`] : []),
packages/kernel/workforce-tools/src/context.ts:524 | sanitizeUntrusted(task.requestedBy)
packages/kernel/workforce-tools/src/context.ts:536 | throw new GoalExceedsContextBudgetError(
packages/kernel/workforce-tools/src/context.ts:618 | sanitizeUntrusted(m.body)
packages/kernel/workforce-tools/src/context.ts:634 | function renderRecall(recall: readonly MemoryHit[]): string | null {
packages/kernel/workforce-tools/src/context.ts:645 | const capped = recall.slice(0, SEAM_MAX_MEMORY_HITS);
packages/kernel/workforce-tools/src/context.ts:655 | sanitizeUntrusted(hit.text)
packages/kernel/workforce-tools/src/context.ts:657 | omitted: hit ceiling
packages/kernel/workforce-tools/src/context.ts:679 | sanitizeConfig(input.employee.id)
packages/kernel/workforce-tools/src/context.ts:712 | throw new ContextInputOverflowError(bytesOf(assembled), TURN_INPUT_MAX_BYTES);
packages/kernel/workforce-tools/src/toolset.ts:75 | export function assertNoReservedCollisions(agentTools: readonly NeutralTool[]): void {
packages/kernel/workforce-tools/src/toolset.ts:153 | body: z.string().min(1).max(MAX_MESSAGE_BODY_CHARS),
packages/kernel/workforce-tools/src/toolset.ts:168 | const parseEnding = <T>(schema: z.ZodType<T>, args: unknown): T => {
packages/kernel/workforce-tools/src/toolset.ts:171 | collector.recordMalformed(args, parsed.error.message);
packages/kernel/workforce-tools/src/toolset.ts:442 | const allowed = new Set<string>([
packages/kernel/workforce-tools/src/toolset.ts:449 | allowed.delete(employee.id);
packages/kernel/workforce-tools/src/toolset.ts:511 | if (onTimeout === 'escalate' && employee.reportsTo === null) {
packages/kernel/workforce-tools/src/toolset.ts:533 | approver: 'user',
packages/kernel/workforce-tools/src/toolset.ts:586 | const superior = employee.reportsTo;
packages/kernel/workforce-tools/src/toolset.ts:619 | const pending = snapshot.pendingReview;
packages/kernel/workforce-tools/src/toolset.ts:631 | reviewId: pending.reviewId,
packages/kernel/workforce-tools/src/toolset.ts:699 | if (collector.messageCount >= MAX_MESSAGES_PER_TURN) {
packages/kernel/workforce-tools/src/toolset.ts:705 | if (recipient !== 'user' && !config.employees.has(recipient)) {
packages/kernel/workforce-tools/src/toolset.ts:856 | inputSchema: handlers[name].spec.parameters
packages/kernel/workforce-tools/src/memory.ts:36 | export const RECALL_SCAN_LIMIT = 200;
packages/kernel/workforce-tools/src/memory.ts:37 | export const RECALL_MAX_AGE_MS = 30 * 24 * 3_600_000;
packages/kernel/workforce-tools/src/memory.ts:38 | export const RECALL_HIT_TEXT_MAX_CHARS = 300;
packages/kernel/workforce-tools/src/memory.ts:39 | export const RECALL_MAX_HITS = 10;
packages/kernel/workforce-tools/src/memory.ts:147 | if (query.workforceId !== undefined && query.workforceId !== this.#scope.workforceId) {
packages/kernel/workforce-tools/src/memory.ts:162 | const completedRows = (await this.#tdb
packages/kernel/workforce-tools/src/snapshot.ts:191 | binding.data.reviewTaskId === task.taskId &&
packages/kernel/workforce-tools/src/snapshot.ts:202 | review.verdict === null && review.reviewer === employee.id
packages/kernel/workforce-tools/src/resolve-target.ts:64 | const employee = config.employees.get(target.id);
packages/kernel/workforce-tools/src/resolve-target.ts:109 | export function assertManagerMayTarget(
packages/kernel/workforce-tools/src/resolve-target.ts:116 | if (target.kind === 'team') {
packages/kernel/workforce-tools/src/resolve-target.ts:126 | if (ownDepartment?.members.includes(resolved.owner)) return;
packages/kernel/workforce-tools/src/collector.ts:35 | export const MALFORMED_TURN_ENDING
packages/kernel/tasks/src/approvals.ts:77 | export const approvalDecisionSchema = z.strictObject({
packages/kernel/tasks/src/approvals.ts:86 | override: z.boolean().default(false),
packages/kernel/tasks/src/approvals.ts:133 | const overrode = !mayDecide(named.approver, input.decidedBy);
packages/kernel/tasks/src/approvals.ts:135 | throw new ApprovalApproverMismatchError(input.approvalId, named.approver, input.decidedBy);
packages/kernel/tasks/src/approvals.ts:148 | eq(schema.workforceApprovals.status, 'pending'),
packages/kernel/tasks/src/approvals.ts:173 | overriddenApprover: approval.approver
packages/kernel/tasks/src/approvals.ts:312 | approver: escalatedTo,
packages/kernel/tasks/src/reviews.ts:145 | export const reviewVerdictSchema = z.strictObject({
packages/kernel/tasks/src/reviews.ts:196 | const overrode = !mayDecide(pending.reviewer, input.actor);
packages/kernel/tasks/src/reviews.ts:198 | throw new ReviewReviewerMismatchError(input.reviewId, pending.reviewer, input.actor);
packages/kernel/tasks/src/reviews.ts:214 | assertReviewMatchesPark(task, input.reviewId);
packages/kernel/tasks/src/reviews.ts:233 | isNull(schema.workforceReviews.verdict)
packages/kernel/tasks/src/reviews.ts:268 | overriddenReviewer: review.reviewer
packages/kernel/tasks/src/decision-authority.ts:41 | export const ANY_AUTHENTICATED_DECIDER = 'user';
packages/kernel/tasks/src/decision-authority.ts:47 | const PRINCIPAL_SCHEMES = ['user:', 'api-key:'] as const;
packages/kernel/tasks/src/decision-authority.ts:60 | export function mayDecide(named: string, actor: string): boolean {
packages/kernel/tasks/src/decision-authority.ts:64 | if (actor.startsWith(scheme) && actor.slice(scheme.length) === named) return true;
packages/kernel/tasks/src/apply-intents.ts:961 | review.taskId !== task.parentTaskId ||
packages/kernel/tasks/src/apply-intents.ts:962 | review.reviewer !== task.owner
packages/kernel/tasks/src/apply-intents.ts:984 | actor: task.owner,
packages/kernel/tasks/src/signals.ts:65 | export const OPERATOR_SIGNAL_KINDS = [
packages/kernel/tasks/src/signals.ts:101 | const STRUCTURAL_PARKS: readonly StatusReason[] = ['awaiting_children', 'escalated'];
packages/kernel/tasks/src/signals.ts:113 | const NOT_OPERATOR_UNBLOCKABLE: readonly StatusReason[] = [
packages/kernel/tasks/src/signals.ts:160 | const WAKES: Readonly<Record<SignalKind, readonly Park[]>> = Object.freeze({
packages/kernel/tasks/src/signals.ts:192 | const BUDGET_ESCALATION_PARKS: readonly Park[] = Object.freeze([
packages/kernel/tasks/src/signals.ts:218 | function answersPark(kind: SignalKind, status: string, statusReason: string | null): boolean {
packages/kernel/tasks/src/intent-applier.ts:40 | export const MAX_MESSAGES_PER_TURN = 20;
packages/kernel/tasks/src/intent-applier.ts:116 | export const turnIntentSchema = z.discriminatedUnion('kind', [
packages/kernel/tasks/src/create-task.ts:106 | export const childTaskSpecSchema = z.strictObject({
packages/kernel/tasks/src/create-task.ts:259 | requestedBy: parent.owner,
packages/kernel/tasks/src/budget.ts:551 | export class LedgerCostPolicy implements CostPolicy {
packages/kernel/tasks/src/index.ts:46 | LedgerCostPolicy,
packages/compose/api-auth/src/routes/workforce.ts:95 | function actorFrom(c: Context<AppEnv>): string {
packages/compose/api-auth/src/routes/workforce.ts:120 | async function breakGlassAuthorized(
packages/compose/api-auth/src/routes/workforce.ts:126 | await enforcePermission(deps, c, 'workforce:override');
packages/compose/api-auth/src/routes/workforce.ts:168 | kind: operatorSignalKindSchema,
packages/compose/api-auth/src/routes/workforce.ts:205 | refine(withinGoalBytes
packages/compose/api-auth/src/routes/workforce.ts:886 | const override = await breakGlassAuthorized(deps, c, body.override);
packages/compose/api-auth/src/routes/workforce.ts:888 | const approval = await decideApproval(tdb, {
packages/compose/api-auth/src/routes/workforce.ts:892 | decidedBy: actorFrom(c),
packages/compose/api-auth/src/routes/workforce.ts:966 | actor: actorFrom(c),
packages/compose/api-auth/src/routes/workforce.ts:1001 | if (c.req.header('Idempotency-Key') !== undefined) {
packages/compose/api-auth/src/routes/workforce.ts:1013 | const { allowed, retryAfterMs } = await deps.rateLimiter.checkAsync(
packages/compose/api-auth/src/routes/workforce.ts:1031 | requestedBy: actorFrom(c),
packages/compose/api-auth/src/http/middleware.ts:150 | const serverOrg = principal?.orgId;
packages/compose/api-auth/src/http/middleware.ts:174 | if (serverOrg) c.set('tenantId', serverOrg);
packages/app/server/src/workforce-goal-intake.ts:59 | function planRefusal(plan: ExecutionPlan, config: WorkforceConfig): string | null {
packages/app/server/src/workforce-goal-intake.ts:68 | if (plan.steps.length > SEAM_MAX_PLAN_STEPS) {
packages/app/server/src/workforce-goal-intake.ts:72 | const employee = config.employees.get(step.owner);
packages/app/server/src/workforce-goal-intake.ts:76 | if (step.department !== null && step.department !== employee.department) {
packages/app/server/src/workforce-goal-intake.ts:107 | if (input.tenantId !== deps.tenantId) return { outcome: 'not_found' };
packages/app/server/src/workforce-goal-intake.ts:108 | if (input.workforceId !== deps.config.id) return { outcome: 'not_found' };
packages/app/server/src/workforce-goal-intake.ts:116 | const refusal = planRefusal(plan, deps.config);
packages/app/server/src/workforce-goal-intake.ts:125 | const created = await tdb.transaction(async (tx) => {
packages/app/server/src/workforce-turn-handlers.ts:104 | export function composeTurnTools(
packages/app/server/src/workforce-turn-handlers.ts:108 | return [...agentTools, ...nativeTools];
packages/app/server/src/workforce-turn-handlers.ts:157 | assertNoReservedCollisions(agentTools);
packages/app/server/src/workforce-turn-handlers.ts:161 | const sideEffecting = agentTools.find((tool) => tool.idempotent === false);
packages/app/server/src/workforce-turn-handlers.ts:174 | const recallScope: RecallScope = {
packages/app/server/src/workforce-turn-handlers.ts:182 | deps.memoryProviderFor?.(tdb, recallScope) ??
packages/app/server/src/workforce-turn-handlers.ts:217 | tools: composeTurnTools(nativeTools, agentTools),
packages/app/server/src/workforce-turn-handlers.ts:245 | (collected.malformed !== null || attemptedEnding
packages/app/server/src/banner.ts:22 | export const NOT_INTERNET_FACING = 'NOT internet-facing';
packages/app/server/src/banner.ts:38 | export const POSTURE_WARNING_LINES: readonly string[] = Object.freeze([
packages/app/server/src/banner.ts:60 | LOCAL / single-node / pre-external-hardening
packages/app/server/src/banner.ts:225 | STATIC PROFILE (frontend-only)
packages/app/server/src/banner.ts:235 | lines.push(...POSTURE_WARNING_LINES);
packages/app/server/src/composition-root.ts:2034 | NOT reachable from `assembleOptsFromEnv`, so a
packages/app/server/src/composition-root.ts:2043 | `assembleOptsFromEnv`, so a production entrypoint always runs the shipped default
packages/app/server/src/composition-root.ts:2300 | eraseTenantNow = (
packages/app/server/src/composition-root.ts:3506 | strategy: opts.orchestrationStrategy ?? new SingleTaskPlanStrategy(),
packages/app/server/src/composition-root.ts:3565 | const eraseTenantNow: BootedServer['eraseTenantNow'] = (
packages/app/server/src/product-boot.ts:2978 | const eraseTenantNow: BootedServer['eraseTenantNow'] = (
packages/kernel/platform/src/dispatch.ts:226 | const byName = new Map(deps.tools.map((t) => [t.spec.name, t]));
packages/kernel/platform/src/dispatch.ts:318 | if (tool.inputSchema) {
packages/kernel/db/src/tenant-db.ts:45 | export const TENANT_GUC = 'app.current_tenant';
packages/kernel/db/src/tenant-db.ts:52 | function assertScoped(table: PgTable): void {
packages/kernel/db/src/tenant-db.ts:150 | const tenantPredicate = eq(tenantColumn(table), this.tenantId);
packages/kernel/db/src/tenant-db.ts:171 | return this.raw.insert(table as PgTable).values(stamped as never);
packages/kernel/db/src/tenant-db.ts:192 | const tenantPredicate = eq(tenantColumn(table), this.tenantId);
packages/kernel/db/src/tenant-db.ts:195 | const { tenantId: _stripped, ...safeSet } = set;
packages/kernel/db/src/tenant-db.ts:208 | const tenantPredicate = eq(tenantColumn(table), this.tenantId);
packages/kernel/db/src/schema.ts:68 | id: uuid('id').defaultRandom().primaryKey(),
packages/kernel/db/src/schema.ts:1151 | export const CORE_TENANT_SCOPED_TABLES = [
packages/kernel/core/src/workforce-ids.ts:42 | export const RESERVED_WORKFORCE_TOOL_NAMES: ReadonlySet<string> = new Set([
packages/kernel/core/src/workforce-ids.ts:80 | export function isReservedWorkforceToolSpelling(name: string): boolean {
packages/kernel/core/src/worker-selector.ts:53 | export interface WorkerSelector {
packages/kernel/core/src/cost-policy.ts:53 | export interface CostPolicy {
packages/kernel/core/src/approval-provider.ts:45 | export interface ApprovalProvider {
packages/kernel/core/src/seam-contracts.ts:61 | export const SEAM_MAX_PLAN_STEPS = 64;
packages/kernel/core/src/seam-contracts.ts:92 | export const SEAM_MAX_MEMORY_HITS = 64;
packages/kernel/spec/src/workforce-lint.ts:236 | if (tool !== undefined && isReservedWorkforceToolSpelling(tool.name)) {
packages/kernel/spec/src/workforce-lint.ts:643 | if (approval.onTimeout !== 'escalate') return;
packages/kernel/spec/src/workforce-lint.ts:650 | 'invalid_orchestrator',
packages/kernel/spec/src/workforce-lint.ts:697 | 'workforce_label_unheld',
packages/kernel/spec/src/workforce-lint.ts:871 | 'workforce_escalation_unreachable',
packages/kernel/spec/src/errors.ts:417 | 'workforce_escalation_unreachable',
packages/kernel/spec/src/workforce-grammar.ts:95 | export const WorkforceLabel = SafeIdentifier;
packages/kernel/spec/src/workforce-grammar.ts:146 | labels: z.array(WorkforceLabel).default([]),
packages/kernel/spec/src/workforce-grammar.ts:236 | const PolicyLabels = z.array(WorkforceLabel).min(1);
packages/kernel/spec/src/identifier.ts:19 | export const SAFE_IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;
packages/kernel/auth-core/src/authz.ts:46 | 'workforce:override'
packages/kernel/auth-core/src/authz.ts:63 | 'workforce:override',
packages/kernel/auth-core/src/authz.ts:81 | 'workforce:override',
packages/kernel/auth-core/src/authz.ts:116 | 'workforce:override',
```

## Appendix B — test ledger

Every suite this page offers as proof, with a title it must still declare. A renamed test leaves
the page claiming a proof nobody can find, so the guard checks these too — and refuses a suite
named in the prose that is absent from this list.

```text
packages/compose/api-auth/src/cross-tenant-gate.test.ts | the iterated table set IS the nine workforce tables
packages/compose/api-auth/src/cross-tenant-gate.test.ts | POSTGRES ITSELF refuses a byte-identical task id
packages/compose/api-auth/src/cross-tenant-gate.test.ts | every one of the nine tables, read through the tenant handle, returns ONLY the caller
packages/compose/api-auth/src/cross-tenant-gate.test.ts | both workforce run_events namespaces are partitioned
packages/compose/api-auth/src/cross-tenant-gate.test.ts | MUTATING verbs — signal, decide, verdict, goals, pause, resume, cancel, halt
packages/compose/api-auth/src/routes/workforce.test.ts | mutations demand store:write: a read-only API key gets the 403 naming the gap
packages/compose/api-auth/src/routes/workforce.test.ts | a review verdict resolves a parked review once (409 on the rerun) and the inbox is tenant-scoped
packages/compose/api-auth/src/routes/workforce.test.ts | a stale review decided from the inbox is a typed 409, not a 500
packages/compose/api-auth/src/routes/workforce.test.ts | signal delivery is strict-bodied and idempotent under a supplied key
packages/compose/api-auth/src/routes/workforce.test.ts | the route accepts OPERATOR kinds only — a mechanism kind is a typed 400
packages/compose/api-auth/src/routes/workforce.test.ts | an operator override RECORDS but does not release a structural park, through the route
packages/compose/api-auth/src/routes/workforce.test.ts | refuses a goal outside the strict schema, a reserved workforce id, and a read-only key
packages/compose/api-auth/src/routes/workforce.test.ts | C5: rate-limits repeated goal submissions of the SAME workforce
packages/compose/api-auth/src/routes/workforce.test.ts | a NAMED approver refuses a different principal — 403, and the row is untouched
packages/compose/api-auth/src/routes/workforce.test.ts | REGRESSION GUARD: an `approver: 'user'` row stays decidable by any store:write principal
packages/compose/api-auth/src/routes/workforce.test.ts | break-glass without ASKING is still refused
packages/compose/api-auth/src/routes/workforce.test.ts | the review verdict door enforces the recorded reviewer the same way
packages/kernel/tasks/src/decision-authority.test.ts | a DIFFERENT principal never satisfies a named decider
packages/kernel/tasks/src/decision-authority.test.ts | the unresolved-principal sentinel satisfies no named decider
packages/kernel/tasks/src/decision-authority.db.test.ts | THE ESCALATION: only the superior the sweep named (or break-glass) may decide the re-issued request
packages/kernel/tasks/src/decision-authority.db.test.ts | break-glass decides a named row AND the journal records that an override happened
packages/kernel/tasks/src/decision-authority.db.test.ts | an ordinary (non-override) decision journals NO override field
packages/kernel/tasks/src/engine.db.test.ts | the channel is validated and bounded, exactly like every sibling trusted channel
packages/kernel/tasks/src/turn-dedupe.db.test.ts | a replayed request_approval turn is a receipt no-op and leaves exactly one approval row
packages/kernel/tasks/src/cascade-locking.db.test.ts | a cancel racing the reserve pass completes the cascade instead of throwing it away
packages/workflow/durable-dbos/src/task-scheduler.db.test.ts | a WEDGED turn — DBOS still PENDING — is reaped once its claim lease expires
packages/kernel/workforce-tools/src/context.test.ts | is byte-deterministic: 100 assemblies of one input are identical
packages/kernel/workforce-tools/src/context.test.ts | drops section 7 first, then 6, then 5
packages/kernel/workforce-tools/src/context.test.ts | NEVER trims the goal: an oversized goal is a typed refusal
packages/kernel/workforce-tools/src/context.test.ts | orders children by task id ascending and drops the highest ids first, with a marker
packages/kernel/workforce-tools/src/context.test.ts | C1: an untrusted message body cannot forge a `## N.` section header
packages/kernel/workforce-tools/src/context.test.ts | C1: an untrusted recall hit cannot forge the data-boundary line
packages/kernel/workforce-tools/src/context.test.ts | C1: a forged `## N.` header in a DEPARTMENT MISSION cannot reach column 0
packages/kernel/workforce-tools/src/context.test.ts | C1: `requestedBy` cannot forge a section header from section 4
packages/kernel/workforce-tools/src/context.test.ts | C1: a delegated goal/title with raw line breaks cannot forge structure either
packages/kernel/workforce-tools/src/context.test.ts | caps the hits it will render, whatever the provider returned, and says how many it dropped
packages/kernel/workforce-tools/src/context.test.ts | a provider inside the ceiling is rendered whole, with no omission notice
packages/kernel/workforce-tools/src/context.test.ts | the byte budget still applies INSIDE the ceiling, and both losses are reported
packages/kernel/workforce-tools/src/toolset-semantics.test.ts | send_message accepts declared employees and the user, refusing anything else
packages/kernel/workforce-tools/src/toolset-semantics.test.ts | submit_review takes its reviewId from the SNAPSHOT
packages/kernel/workforce-tools/src/toolset-semantics.test.ts | a REVIEW task carries no request_review
packages/kernel/workforce-tools/src/toolset-semantics.test.ts | request_review never accepts the caller as their own reviewer
packages/kernel/workforce-tools/src/toolset-semantics.test.ts | request_review refuses a reviewer outside the caller scope — no org-wide routing
packages/kernel/workforce-tools/src/toolset-semantics.test.ts | falls back to the human when the matched reviewer IS the submitter
packages/kernel/workforce-tools/src/toolset-semantics.test.ts | an escalating approval rule on a seat with no superior is refused
packages/kernel/workforce-tools/src/toolset-semantics.test.ts | request_approval pulls the declared window for the caller labels and names the escalation target
packages/kernel/workforce-tools/src/toolset-semantics.test.ts | malformed turn-ending arguments record the malformed marker and throw a typed tool error
packages/kernel/workforce-tools/src/toolset-semantics.test.ts | resolves employee:, department: (manager) and team: (lead) to their owners
packages/kernel/workforce-tools/src/toolset-semantics.test.ts | a manager reaches own department members and led-team members — nothing else
packages/kernel/workforce-tools/src/toolset-semantics.test.ts | the led-team grant exists exactly where the task IS that team
packages/kernel/workforce-tools/src/role-privilege.test.ts | the toolset is a function of the TASK owner alone — two roles never blend
packages/kernel/workforce-tools/src/role-privilege.test.ts | every tool a role carries sets inputSchema, and it IS the schema the model was shown
packages/kernel/auth-core/src/authz.test.ts | an api-key can NEVER break the glass on a named approver/reviewer, however it is scoped
packages/kernel/core/src/strategy-defaults.test.ts | CapabilityMatchSelector
packages/kernel/core/src/seam-wiring.test.ts | WorkerSelector has NO production reference outside its own module
packages/kernel/core/src/seam-wiring.test.ts | ApprovalProvider has NO production reference outside its own module
packages/kernel/core/src/seam-wiring.test.ts | CostPolicy is IMPLEMENTED in the task engine and never constructed
packages/kernel/core/src/seam-wiring.test.ts | reads a non-empty set of production sources — an empty scan fails CLOSED
packages/kernel/core/src/seam-wiring.test.ts | TEETH: a planted wiring is detected, and a comment that merely names a seam is not
packages/kernel/core/src/seam-confinement.test.ts | REFUSES a selection naming someone outside the candidate set
packages/app/server/src/workforce-goal-intake.db.test.ts | refuses an invalid plan typed, with ZERO rows
packages/app/server/src/workforce-goal-intake.db.test.ts | refuses every over-reaching plan shape typed, with ZERO rows
packages/app/server/src/workforce-goal-intake.db.test.ts | a plan AT the step bound is created — the bound refuses excess, not decomposition
packages/app/server/src/workforce-goal-intake.db.test.ts | reconciles tenant and workforce BEFORE the strategy runs
packages/app/server/src/workforce-recall.db.test.ts | ADVERSARIAL: an identical twin workforce in another tenant leaks nothing
packages/app/server/src/workforce-recall.db.test.ts | holds every bound: the age window, the hit cap, the text cap, and the workforce pin
packages/app/server/src/workforce-turn-validation.db.test.ts | wrong arguments to submit_result NEVER become a completion
packages/app/server/src/workforce-turn-validation.db.test.ts | a forged escalateTo cannot ride in through the tool arguments
packages/app/server/src/workforce-turn-validation.db.test.ts | C7: a MULTIBYTE hand-off goal over the BYTE cap
packages/app/server/src/workforce-turn-validation.db.test.ts | the composition offers the DECLARED agent tools first and the NATIVE toolset last
packages/app/server/src/workforce-tool-precedence.test.ts | PROPERTY: composeTurnTools dispatches a reserved name to the NATIVE handler
packages/app/server/src/workforce-tool-precedence.test.ts | DOOR: the composition still REFUSES the colliding tool list this suite then dispatches
packages/app/server/src/banner.test.ts | the exported constants ARE the shipped strings — the anti-circularity control
packages/app/server/src/banner.test.ts | the STATIC-PROFILE boot banner carries the SAME warning, byte-identically
packages/app/server/src/workforce-erasure-boot.db.test.ts | 2. the tenant-erasure control seam is WIRED on a store-less workforce boot
packages/app/server/src/erase-tenant.db.test.ts | 14. a FULL erase (not scrub) still removes the WHOLE task graph, budget ledger included
packages/kernel/workforce-tools/src/threat-model-drift.test.ts | every citation resolves AND the cited line CONTAINS the recorded text
packages/app/server/src/auth-only-erasure-boot.db.test.ts | 2. the tenant-erasure control seam is WIRED on a declared-agents auth-only boot
packages/app/server/src/auth-only-erasure-boot.db.test.ts | 7. a boot with NO document at all wires the seam too, and still previews
```
