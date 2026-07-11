# @rayspec/views-runtime

The **declarative view interpreter**: turns validated product-profile view declarations into a
mountable, tenant-fail-closed, read-only route surface — no route handlers, no product code, no
product concepts in this package.

## What a view is

A product-profile `views[]` entry declares a READ (or a capability-delegated command) contract:

| Half | Declares | Validated by |
|---|---|---|
| `source` (+ `read`) | the BACKING DATA: a store name / a declared artifact kind-or-collection / a capability contract, plus mode (`list` \| `single` \| `collect`), equality `filter` over declared params, `exclude`, `order_by` | kind-aware source resolution (`lintProductViews`, re-run at mount) — a contract id NEVER satisfies a source; the declaration-only carve-out admits **top-level contract ids only** (a capability-contract ref is rejected as dead-on-arrival) |
| `response_contract` (+ `read.shape`) | the DTO: the named contract is the client-facing shape; `shape` declares how rows project into it (closed field vocabulary: `column`/`json`/`param`/`const`/`items`/`list`/`lookup`/`counts`/`group`/`page_*`) | the shape⊆contract CONFORMANCE pass (field coverage, required coverage, admitted types/nullability; a `{type: object, additional_properties: false}` node with no properties is CLOSED-EMPTY — it rejects every projected field) |

The grammar lives in `@rayspec/spec` (`product-views.ts`); the single validation source of truth is
`lintProductViews` (`product-views-lint.ts`) — the parser runs it at parse time, this package re-runs
it at mount time, so a code-built spec cannot bypass it.

## Mounting (composition-homed)

`mountProductViews(config)` mirrors the Tier-B capability mount pattern: it returns `api[]`
fragments (`{ kind: 'handler' }` actions) plus a resolved handler map the declared-routes engine
dispatches. Every view route therefore runs on the platform's standard chain
(`requireAuth → resolveTenant → requirePermission`) inside `TenantDb.transaction()` — the tenant
predicate is STRUCTURAL beneath the interpreter (the only capabilities a view touches are
`init.db.select` and `init.db.count`). Views are read-only by construction.

Mount is FAIL-CLOSED: unknown stores/columns, type-incompatible leaves (`json`/`items` need jsonb;
a leaf type must be producible by its column type; param filters must be coercible), missing
artifact bindings, unknown auth policies, unmountable declaration-only views, and missing
capability delegates all ABORT the mount with the full aggregated error list. The injected-column
allowlist is closed (`id`, `created_at`) — `tenant_id` can never be projected or filtered.

**Auth policy → enforcement:** recognizing a policy is not enforcing it. Every allowlisted
policy must map to a concrete mechanism in `authPolicyEnforcement` (default:
`DEFAULT_AUTH_POLICY_ENFORCEMENT`), or the compile fails. `bearer_tenant` maps to
`platform_handler_chain`: the mounted route is a `{ kind: 'handler' }` action the platform registers
behind `requireAuth → resolveTenant → requirePermission('store:write')` — that chain IS the
enforcement.

**Authorization scope (honest limitation):** read views currently require **`store:write`** — the
platform gates EVERY `{handler}` route on the most-privileged product permission because it cannot
statically prove a handler read-only, so a read view inherits the same gating as any other
`{handler}` route. A **read-scoped API key therefore cannot call read views today**; read-scope
support for declared views is tracked as platform backlog work, NOT changed by this package.

**Deploy boundary:** the product-profile deploy path (`deploy.ts`) still rejects product-profile
view mounts in code. This package produces fragments a deployment composes in code.

## Request laws (declared read semantics)

- **Params**: closed presets (`safe_id`/`positive_int`/`nonnegative_int`/`string`, optional `enum`);
  a missing-required / mis-shaped declared param → `400 { error: 'bad_request', detail }`. Undeclared
  query params are IGNORED (request params are DATA). A path param is required by construction; a
  query param defaults to optional (absent ⇒ its `{param}` sub-value is undefined → the leaf-default /
  no-rows laws below apply). Filter params must be REQUIRED (lint) — a read is never ambiguous. Params
  are read as OWN properties into null-prototype maps — a param named `toString`/`valueOf` behaves
  like any other name.
- **Leaf typing**: a raw value matching the declared type passes; anything else becomes the declared
  literal `default` (default `null`). `number`/`integer` leaves require a FINITE value, so a `NaN` /
  `±Infinity` value becomes the declared default. A `column` leaf projects the stored value verbatim
  (typed-or-default) — it does not re-format. JSON key paths are walked as OWN properties only, so a
  `__proto__`-class segment can never read a prototype.
- **Pagination** (`list`): limit missing/non-integer/`<1` → `default_limit`; `>max_limit` →
  `max_limit`; offset malformed/negative → `0`. `total` = full tenant-scoped (post-`exclude`) match
  count; `next_offset` = `offset+limit < total ? offset+limit : null`. The page is a BOUNDED
  server-side `LIMIT`/`OFFSET` select plus a `count` for the total whenever the read surface offers
  the `count` primitive and nothing forces the whole match set into memory; it falls back to a full
  read + in-interpreter slice when `count` is unavailable or the view declares an in-memory `exclude`.
  Either path yields the identical wire output (page rows, `total`, `next_offset`).
- **Ordering**: rows are ordered by the declared `order_by` columns only — there is no implicit
  tiebreak, so rows with EQUAL sort keys have a DB-unspecified relative order.
- **Absent** (`single`): no row → the DECLARED `read.absent` DTO (`empty_200`) or
  `409 { error: 'not_ready' }` (`not_ready_409`) — never an improvised shape, never a 404.
- **Sub-reads** (`list`/`lookup`/`counts.of`): keyed equality matches; an unresolved
  (`undefined`/`null`) match value yields NO rows — never an unfiltered read. Identical sub-reads
  are MEMOIZED per request on the full query signature — several lookups on one
  (store, match) share ONE select and one row set.
- **Conditional read** (`conditional_read: etag`, GET only): a strong ETag (sha-256 of the canonical
  DTO JSON) is set on the 200; a matching `If-None-Match` → a bodyless 304 with the same ETag.
  **`If-Range` is deliberately NOT a view construct** — byte-range media serving is Tier-B
  capability behavior; it cannot be mis-declared because no grammar slot exists for it.

## OpenAPI

`emitProductViewsOpenApi` derives an OpenAPI 3.1 document from the declarations: preset param
schemas + enums, pagination clamp documentation, the response contract translated from the closed
contract vocabulary (`ref` → `$ref` into `components.schemas`, `nullable` → 3.1 type unions), and the
declared 409/304 behaviors. Documented responses are exactly the PRODUCIBLE set
(`producibleViewResponseStatuses`): a 400 is documented ONLY when the view declares params —
pagination params clamp and can never 400.

## Testing

Unit suites run against `test-support/fake-read-surface.ts` — a REAL-CONSTRAINT fake (fail-closed
store/column resolution, structural tenant partitioning, Date→ISO serialization, the same
`select`+`count` read surface the real facade offers). The composed DB-backed proof through the REAL
platform chain is `packages/compose/api-auth/src/engine/views-seam.db.test.ts` (golden fidelity +
cross-tenant + 401 + real 304 + the request-header allowlist probe). The neutral golden declarations
live in `src/__fixtures__/acme-notes-views.product.yaml` — shared by the unit and seam suites so they
cannot drift; its contract nodes are CLOSED, so the conformance pass has teeth on the richest golden
shapes. A source-scan test (`neutral-views.test.ts`) enforces that no product word ever enters this
package.
