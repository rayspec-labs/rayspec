/**
 * `lintSpec` — the semantic pass beyond Zod shape validation.
 *
 * Zod (`grammar.ts`) proves SHAPE (types, enums, strict unknown-key rejection). The lint pass
 * proves SEMANTICS that Zod cannot express across sections:
 *
 *  1. Cross-references RESOLVE — every `tooling.handler`, `agents[].tools[]`, `api.action.*`,
 *     `triggers.action.*`, and `stores[].foreignKeys[].references` points at a declared id/name.
 *  2. NO DUPLICATE ids/names within any section — incl. tooling by `name` (the dispatchTool
 *     registry keys on `spec.name`, dispatch.ts), api routes by `${method} ${path}`, and store
 *     columns by `name` within a store.
 *  3. CAPABILITY — every agent is run through core `validateSpec(syntheticAgentSpec, backend, …)`
 *     so a capability the backend lacks fails at CONFIG time (the canonical violation:
 *     `outputSchema` + `requireNativeStructuredOutput:true` on `backend:'pi'`).
 *  4. EMBEDDED SCHEMAS COMPILE — every tool `parameters`/`outputSchema` AND every agent
 *     `outputSchema.schema` is compiled with Ajv2020 at load; a malformed one is
 *     `invalid_embedded_schema`. A tool's `parameters` must additionally be an OBJECT schema
 *     (`type:'object'`) — all 3 backends require object-typed tool args (`schema_violation`).
 *  5. KIND→FIELD coherence — a `cron` trigger requires `schedule`; an `event` trigger requires
 *     `event`; a handler referenced by `tooling` must be `kind:'tool'`, by `api` must be `route`,
 *     by `triggers` must be `trigger` (so a handler is wired through the right chokepoint).
 *  6. DDL COHERENCE — a store column may not collide with an injected tenancy/GDPR column
 *     (`reserved_column_name`); an FK `onDelete:'set null'` requires a NULLABLE local column
 *     (`schema_violation`).
 *
 * NOTE on `deployment`: the optional `deployment.durableWorker` is a
 * DEPLOYMENT declaration ("does this deployment run a durable off-request worker?"), gated by
 * `.strict()` shape validation. For the per-REQUEST `async:true` run signal there is NO grammar field
 * to cross-check (it is `StartRunRequest.async`, runs.ts), and the LOAD-BEARING async gate is the
 * RUNTIME one: `async:true` + no durable executor wired ⇒ a clean fail-closed 501 at `executeAgentRun`.
 * BUT a declared `cron` TRIGGER is a CONFIG-LEVEL coupling we CAN check: a cron is fired ONLY by the
 * durable worker, so a `cron` trigger WITHOUT `deployment.durableWorker:true` would be silently never
 * scheduled — rule (5) below rejects that (`schema_violation`). The composition root ALSO boot-aborts
 * on the same coupling (defense-in-depth), but the static lint rule fails it at parse/deploy time.
 *
 * Returns the FULL list of violations (closed `SpecError` codes) — never the first. Pure function
 * over an already-shape-valid `RaySpec` (the parser calls it after the Zod parse succeeds).
 */
import { type AgentSpec, type BackendId, validateSpec } from '@rayspec/core';
// ajv ships CJS with no `exports` map; under NodeNext + verbatimModuleSyntax the default import
// types as the module NAMESPACE even though at runtime it IS the class (ajv sets
// module.exports.default = module.exports). Resolve the constructor at runtime across both interop
// shapes and take the instance TYPE from the named class export — exactly as dispatch.ts does.
import type { Ajv2020 as Ajv2020Class } from 'ajv/dist/2020.js';
import * as Ajv2020Module from 'ajv/dist/2020.js';
import { type SpecError, type SpecWarning, specError, specWarning } from './errors.js';
import type { RaySpec } from './grammar.js';

type AjvInstance = Ajv2020Class;
const Ajv2020Ctor = ((Ajv2020Module as { default?: unknown }).default ?? Ajv2020Module) as new (
  opts?: Record<string, unknown>,
) => AjvInstance;

/**
 * Column names the Slice-1 generator INJECTS on every product table (the tenancy/GDPR pattern —
 * see packages/db/src/schema.ts). An author-declared business column with one of these names
 * would shadow/collide with the injected column, so the linter rejects it fail-closed.
 */
export const RESERVED_COLUMN_NAMES: ReadonlySet<string> = new Set([
  'id',
  'tenant_id',
  'created_at',
  'deleted_at',
  'retention_days',
  'region',
  // The injected actor + idempotency columns (server-controlled, never author-declarable).
  'created_by',
  'idempotency_key',
]);

/**
 * The list-query CONTROL keywords — the reserved query-string keys the declarative `list` route
 * uses to steer sorting + keyset pagination (mirrors `CONTROL_KEYS` in the compose package's
 * store-query.ts; @rayspec/spec cannot import the compose package, so this is the KEEP-IN-SYNC copy).
 *
 * A declared BUSINESS column of one of these names is a config error, because at the `list` route it is
 * (a) silently un-equality-filterable — `buildListQuery` routes `?order=`/`?after=`/`?limit=` to the
 * control parsers and never reaches the per-column equality lookup — AND (b) it makes the emitted
 * OpenAPI document carry a DUPLICATE query parameter (the hard-coded control param + the per-column
 * filter param share a `name`+`in`), which is an INVALID OpenAPI 3.1 doc. This is a SEPARATE set from
 * `RESERVED_COLUMN_NAMES` on purpose — that Set is meta-test-locked to equal the injected columns
 * (`INJECTED_COLUMN_NAMES`); these keywords are not injected columns, they are query controls.
 */
export const RESERVED_QUERY_KEYWORDS: ReadonlySet<string> = new Set(['order', 'after', 'limit']);

/**
 * Route prefixes the PLATFORM owns — a declared static frontend mount may neither claim one nor nest
 * under one (the frontend lint rule below), and the static runtime declines any request under one so a
 * platform miss falls through to the uniform JSON 404 rather than a served file / SPA shell
 * (serve-static.ts consumes this SAME constant so the two never drift). Root `/` is NOT here: it is a
 * legitimate static catch-all that coexists with `/v1/*` via registration order + fall-through.
 */
export const RESERVED_ROUTE_PREFIXES = ['/v1', '/health', '/oidc'] as const;

/**
 * Find duplicate keys in a list, reporting each duplicate occurrence (by index) as a SpecError.
 * `keyOf` extracts the dedup key; `pathOf` builds the JSON path for a violating index.
 */
function findDuplicates<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  section: string,
  pathOf: (index: number) => string,
): SpecError[] {
  const errors: SpecError[] = [];
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const key = keyOf(item);
    if (seen.has(key)) {
      errors.push(
        specError(
          'duplicate_name',
          `duplicate ${section} '${key}' (each ${section} id/name must be unique)`,
          pathOf(index),
        ),
      );
    } else {
      seen.add(key);
    }
  });
  return errors;
}

/**
 * snake_case -> camelCase, IDENTICAL to the generator's `toCamel` (generate-product-schema.ts), so
 * the collision check here predicts the exact JS identifier the generator would emit. (TEN-3)
 *
 * EXPORTED for the product-store column-collision check in `product-lint.ts` —
 * the ONE spec-side copy of the rule. KEEP-IN-SYNC (honest replication, dependency direction:
 * spec must not import platform/db): the SAME rule also lives in
 *  - packages/db/src/generated/generate-product-schema.ts (`toCamel`) + build-product-tables.ts,
 *  - packages/platform/src/handlers/store-facade.ts (`snakeToCamel`),
 *  - packages/api-auth/src/engine/injected-columns-view.ts (`snakeToCamel`).
 * A literal-example pin test (product-stores.test.ts, "snake→camel pin") guards this copy against
 * drift; if the rule ever changes, ALL copies + the pin must move together.
 */
export function toJsIdentifier(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/** The full semantic pass. Input is already shape-valid (post-Zod-parse). */
export function lintSpec(spec: RaySpec): SpecError[] {
  const errors: SpecError[] = [];

  // ---- ID/NAME SETS (built once; reused by the cross-ref checks) ------------------------
  const storeNames = new Set(spec.stores.map((s) => s.name));
  // name -> store, so a business-key FK (`referencesColumn`) can resolve its referenced column in the
  // TARGET store (unique + type-match validation below).
  const storeByName = new Map(spec.stores.map((s) => [s.name, s]));
  const agentIds = new Set(spec.agents.map((a) => a.id));
  const toolIds = new Set(spec.tooling.map((t) => t.id));
  // handlers indexed by id -> kind, so a ref can also assert the handler is the RIGHT kind.
  const handlerKindById = new Map(spec.handlers.map((h) => [h.id, h.kind]));

  // ---- 2. DUPLICATES (within each section) ----------------------------------------------
  errors.push(
    ...findDuplicates(
      spec.stores,
      (s) => s.name,
      'store name',
      (i) => `stores[${i}].name`,
    ),
    ...findDuplicates(
      spec.agents,
      (a) => a.id,
      'agent id',
      (i) => `agents[${i}].id`,
    ),
    ...findDuplicates(
      spec.tooling,
      (t) => t.id,
      'tooling id',
      (i) => `tooling[${i}].id`,
    ),
    // Tool NAME (not just id): dispatchTool keys its registry by `t.spec.name` (dispatch.ts), so
    // two tools sharing a name silently collide at runtime — one handler is lost. Reject at config.
    ...findDuplicates(
      spec.tooling,
      (t) => t.name,
      'tooling name',
      (i) => `tooling[${i}].name`,
    ),
    ...findDuplicates(
      spec.handlers,
      (h) => h.id,
      'handler id',
      (i) => `handlers[${i}].id`,
    ),
    ...findDuplicates(
      spec.triggers,
      (t) => t.name,
      'trigger name',
      (i) => `triggers[${i}].name`,
    ),
    // API route uniqueness: a duplicate `${method} ${path}` would register two handlers on one
    // route — the second silently shadows the first. Reject at config.
    ...findDuplicates(
      spec.api,
      (r) => `${r.method} ${r.path}`,
      'api route',
      (i) => `api[${i}].path`,
    ),
  );

  // ---- 1 & 5. CROSS-REFS + KIND COHERENCE -----------------------------------------------

  // stores: column uniqueness + reserved-name guard + FK resolution + FK on-delete coherence.
  spec.stores.forEach((store, si) => {
    // (6) Duplicate column names within this store.
    errors.push(
      ...findDuplicates(
        store.columns,
        (c) => c.name,
        'store column',
        (i) => `stores[${si}].columns[${i}].name`,
      ),
    );

    // A column -> column map (used by the FK column-resolution + 'set null' coherence check below).
    const columnByName = new Map(store.columns.map((c) => [c.name, c]));

    // (9) Reserved (injected) column names — a business column may not shadow a tenancy/GDPR column.
    store.columns.forEach((col, ci) => {
      if (RESERVED_COLUMN_NAMES.has(col.name)) {
        errors.push(
          specError(
            'reserved_column_name',
            `store '${store.name}' declares reserved column '${col.name}' — that column is injected ` +
              'by the generator (tenancy/GDPR); rename the business column',
            `stores[${si}].columns[${ci}].name`,
          ),
        );
      } else if (RESERVED_QUERY_KEYWORDS.has(col.name)) {
        // A column named after a list-query control keyword would be un-filterable AND would emit
        // a duplicate OpenAPI query parameter — reject at config with an explaining rename hint.
        errors.push(
          specError(
            'reserved_query_keyword',
            `store '${store.name}' declares column '${col.name}', which collides with a reserved ` +
              'list-query control keyword (order/after/limit) the declarative list route uses for ' +
              'sorting/keyset pagination — the column would be un-filterable and would emit a duplicate ' +
              'OpenAPI query parameter; rename the business column',
            `stores[${si}].columns[${ci}].name`,
          ),
        );
      }
      // (enum) An `enum` whitelist is a TEXT-column value constraint the platform enforces server-side
      // (store-validation derives a `z.enum` → an out-of-whitelist create/update value is a 400). The
      // grammar already pins a non-empty array of non-empty members; the lint adds the two facts Zod
      // cannot express here: (a) it belongs ONLY on a text column; (b) the members are DISTINCT.
      if (col.enum !== undefined) {
        if (col.type !== 'text') {
          errors.push(
            specError(
              'schema_violation',
              `store '${store.name}' column '${col.name}' declares an enum whitelist but is type ` +
                `'${col.type}' — enum is only valid on a 'text' column`,
              `stores[${si}].columns[${ci}].enum`,
            ),
          );
        }
        const seenValues = new Set<string>();
        for (const value of col.enum) {
          if (seenValues.has(value)) {
            errors.push(
              specError(
                'schema_violation',
                `store '${store.name}' column '${col.name}' enum has a duplicate value ` +
                  `'${value}' — enum members must be distinct`,
                `stores[${si}].columns[${ci}].enum`,
              ),
            );
            break; // one report per column is enough (the author fixes the list in one pass)
          }
          seenValues.add(value);
        }
      }
    });

    store.foreignKeys.forEach((fk, fi) => {
      if (!storeNames.has(fk.references)) {
        errors.push(
          specError(
            'dangling_ref',
            `store '${store.name}' foreign key references unknown store '${fk.references}'`,
            `stores[${si}].foreignKeys[${fi}].references`,
          ),
        );
      }
      const fkColumn = columnByName.get(fk.column);
      if (fkColumn === undefined) {
        errors.push(
          specError(
            'dangling_ref',
            `store '${store.name}' foreign key column '${fk.column}' is not a declared column`,
            `stores[${si}].foreignKeys[${fi}].column`,
          ),
        );
      } else if (fk.referencesColumn === undefined) {
        // ID-TARGET FK (default): the local column references the parent's injected uuid PK (`id`), so
        // it MUST be declared `type:'uuid'` (GEN-1). A non-uuid FK column diverges the generators (the
        // TS generator forces uuid() while the SQL generator emits the author type) and yields an
        // unappliable migration — reject it at config time.
        if (fkColumn.type !== 'uuid') {
          errors.push(
            specError(
              'schema_violation',
              `store '${store.name}' foreign key column '${fk.column}' is type '${fkColumn.type}' but ` +
                "must be 'uuid' (it references the parent store's injected uuid primary key)",
              `stores[${si}].foreignKeys[${fi}].column`,
            ),
          );
        }
        if (fk.onDelete === 'set null' && fkColumn.nullable === false) {
          // (8) ON DELETE SET NULL requires a NULLABLE column — otherwise the DDL is self-contradictory.
          errors.push(
            specError(
              'schema_violation',
              `store '${store.name}' foreign key on column '${fk.column}' uses onDelete:'set null' but ` +
                'the column is NOT NULL — make it nullable or change the on-delete policy',
              `stores[${si}].foreignKeys[${fi}].onDelete`,
            ),
          );
        }
      } else {
        // BUSINESS-KEY FK: the local column references a NAMED unique column of the target store — a
        // TENANT-SCOPED COMPOUND FK `(tenant_id, col) -> parent(tenant_id, refcol)`.
        //
        // (a) onDelete:'set null' is IMPOSSIBLE on a compound FK — it would have to null `tenant_id`,
        //     which is NOT NULL by construction. A business-key FK supports 'cascade' or 'restrict' only.
        if (fk.onDelete === 'set null') {
          errors.push(
            specError(
              'schema_violation',
              `store '${store.name}' foreign key on column '${fk.column}' uses onDelete:'set null' with ` +
                'referencesColumn — a business-key FK is a tenant-scoped compound key and cannot null ' +
                "tenant_id; use onDelete:'cascade' or 'restrict'",
              `stores[${si}].foreignKeys[${fi}].onDelete`,
            ),
          );
        }
        // (b) Resolve the referenced column in the TARGET store (skip when the target store is dangling —
        //     the dangling_ref above already reports that).
        const targetStore = storeByName.get(fk.references);
        if (targetStore !== undefined) {
          const targetCol = targetStore.columns.find((c) => c.name === fk.referencesColumn);
          if (targetCol === undefined) {
            errors.push(
              specError(
                'dangling_ref',
                `store '${store.name}' foreign key referencesColumn '${fk.referencesColumn}' is not a ` +
                  `declared column of the referenced store '${fk.references}'`,
                `stores[${si}].foreignKeys[${fi}].referencesColumn`,
              ),
            );
          } else {
            // (c) A FK can only reference a UNIQUE column (Postgres requires a matching unique index).
            if (targetCol.unique !== true) {
              errors.push(
                specError(
                  'schema_violation',
                  `store '${store.name}' foreign key referencesColumn ` +
                    `'${fk.references}.${fk.referencesColumn}' must be declared 'unique: true' — a ` +
                    'foreign key can only reference a unique column',
                  `stores[${si}].foreignKeys[${fi}].referencesColumn`,
                ),
              );
            }
            // (d) The local FK column's type MUST match the referenced column's type (relaxes the
            //     uuid-only GEN-1 rule for a non-id target — a slug FK is text, a code FK is integer, …).
            if (fkColumn.type !== targetCol.type) {
              errors.push(
                specError(
                  'schema_violation',
                  `store '${store.name}' foreign key column '${fk.column}' is type '${fkColumn.type}' but ` +
                    `references '${fk.references}.${fk.referencesColumn}' of type '${targetCol.type}' — ` +
                    "an FK column's type must match its referenced column",
                  `stores[${si}].foreignKeys[${fi}].column`,
                ),
              );
            }
          }
        }
      }
    });

    // (TEN-3) Two store columns whose names camelCase to the SAME JS identifier would collide as
    // duplicate keys in the generated TS table object (e.g. `foo_bar` and `fooBar` both -> fooBar).
    // The safe-identifier grammar narrows the input, but `_`-vs-camel ambiguity remains — reject it.
    errors.push(
      ...findDuplicates(
        store.columns,
        (c) => toJsIdentifier(c.name),
        'store column camelCase identifier',
        (i) => `stores[${si}].columns[${i}].name`,
      ),
    );
  });

  // (TEN-3) Two STORE names that camelCase to the same const identifier collide as duplicate consts
  // in the generated product-schema module (e.g. `audit_log` and `auditLog` both -> auditLog).
  errors.push(
    ...findDuplicates(
      spec.stores,
      (s) => toJsIdentifier(s.name),
      'store camelCase identifier',
      (i) => `stores[${i}].name`,
    ),
  );

  // tooling[].handler -> a declared handler of kind 'tool'.
  spec.tooling.forEach((tool, ti) => {
    const kind = handlerKindById.get(tool.handler);
    if (kind === undefined) {
      errors.push(
        specError(
          'dangling_ref',
          `tool '${tool.id}' references unknown handler '${tool.handler}'`,
          `tooling[${ti}].handler`,
        ),
      );
    } else if (kind !== 'tool') {
      errors.push(
        specError(
          'dangling_ref',
          `tool '${tool.id}' references handler '${tool.handler}' of kind '${kind}', expected 'tool'`,
          `tooling[${ti}].handler`,
        ),
      );
    }
  });

  // agents[].tools[] -> declared tooling ids.
  spec.agents.forEach((agent, ai) => {
    agent.tools.forEach((toolId, tidx) => {
      if (!toolIds.has(toolId)) {
        errors.push(
          specError(
            'dangling_ref',
            `agent '${agent.id}' references unknown tool '${toolId}'`,
            `agents[${ai}].tools[${tidx}]`,
          ),
        );
      }
    });
  });

  // api[].action.* -> declared store/agent/handler/stream (handler must be kind 'route').
  spec.api.forEach((route, ri) => {
    const action = route.action;
    if (action.kind === 'store') {
      if (!storeNames.has(action.store)) {
        errors.push(
          specError(
            'dangling_ref',
            `route ${route.method} ${route.path} references unknown store '${action.store}'`,
            `api[${ri}].action.store`,
          ),
        );
      }
    } else if (action.kind === 'agent') {
      if (!agentIds.has(action.agent)) {
        errors.push(
          specError(
            'dangling_ref',
            `route ${route.method} ${route.path} references unknown agent '${action.agent}'`,
            `api[${ri}].action.agent`,
          ),
        );
      }
    } else {
      // handler OR stream action — both resolve `action.handler` against a declared `route`-kind
      // handler (a stream handler dispatches through the api chokepoint, like a `{handler}` route —
      // the ingest/playback `mode` is a runtime concern, not a handler kind). The shared
      // resolution below covers both kinds.
      const kind = handlerKindById.get(action.handler);
      if (kind === undefined) {
        errors.push(
          specError(
            'dangling_ref',
            `route ${route.method} ${route.path} references unknown handler '${action.handler}'`,
            `api[${ri}].action.handler`,
          ),
        );
      } else if (kind !== 'route') {
        errors.push(
          specError(
            'dangling_ref',
            `route ${route.method} ${route.path} handler '${action.handler}' is kind '${kind}', expected 'route'`,
            `api[${ri}].action.handler`,
          ),
        );
      }
    }
  });

  // ---- frontend[] static mounts — route COLLISIONS (fail-closed) -------------------------------
  // A declared static frontend mount is served alongside the API (composition-root / serve-static.ts).
  // Its `route` must not collide with (a) another mount, (b) a declared `api[].path` (one would shadow
  // the other), or (c) a reserved system prefix (`/v1`, `/health`, `/oidc` — platform-owned). Root `/`
  // is EXEMPT: it never equals an api path nor nests under a reserved prefix, and a static-last `/` mount
  // legitimately coexists with `/v1/*` (registration order + a static miss fall-through).
  const apiRoutePaths = new Set(spec.api.map((r) => r.path));
  const seenFrontendRoutes = new Set<string>();
  (spec.frontend ?? []).forEach((mount, fi) => {
    const route = mount.route;
    // (a) DUPLICATE mount route.
    if (seenFrontendRoutes.has(route)) {
      errors.push(
        specError(
          'frontend_route_collision',
          `duplicate frontend route '${route}' (each frontend mount route must be unique)`,
          `frontend[${fi}].route`,
        ),
      );
    } else {
      seenFrontendRoutes.add(route);
    }
    // (b) EXACTLY equals a declared api route path — a static mount and an api route cannot share a path.
    if (apiRoutePaths.has(route)) {
      errors.push(
        specError(
          'frontend_route_collision',
          `frontend route '${route}' collides with a declared api route path — a static mount and an ` +
            'api route cannot share a path; choose a different frontend route',
          `frontend[${fi}].route`,
        ),
      );
    }
    // (c) EQUALS or NESTS UNDER a reserved system prefix (root `/` is exempt — it matches neither).
    if (RESERVED_ROUTE_PREFIXES.some((p) => route === p || route.startsWith(`${p}/`))) {
      errors.push(
        specError(
          'frontend_route_collision',
          `frontend route '${route}' is reserved for the platform (${RESERVED_ROUTE_PREFIXES.join(
            ', ',
          )}); choose a different route`,
          `frontend[${fi}].route`,
        ),
      );
    }
  });

  // ---- extensions[] DUPLICATE ids (cross-ref/merge resolution lands in S4) ----------------
  // The `loadExtensions` merge (S4) keys packs by `id`; two refs sharing an id would silently
  // collide (one pack lost). Reject at config time — symmetric with the other section dup checks.
  errors.push(
    ...findDuplicates(
      spec.extensions,
      (e) => e.id,
      'extension id',
      (i) => `extensions[${i}].id`,
    ),
  );

  // triggers[].action.* -> declared agent/handler (handler must be kind 'trigger'); kind->field.
  spec.triggers.forEach((trigger, ti) => {
    const action = trigger.action;
    if (action.kind === 'agent') {
      if (!agentIds.has(action.agent)) {
        errors.push(
          specError(
            'dangling_ref',
            `trigger '${trigger.name}' references unknown agent '${action.agent}'`,
            `triggers[${ti}].action.agent`,
          ),
        );
      }
    } else {
      const kind = handlerKindById.get(action.handler);
      if (kind === undefined) {
        errors.push(
          specError(
            'dangling_ref',
            `trigger '${trigger.name}' references unknown handler '${action.handler}'`,
            `triggers[${ti}].action.handler`,
          ),
        );
      } else if (kind !== 'trigger') {
        errors.push(
          specError(
            'dangling_ref',
            `trigger '${trigger.name}' handler '${action.handler}' is kind '${kind}', expected 'trigger'`,
            `triggers[${ti}].action.handler`,
          ),
        );
      }
    }
    // kind -> required field coherence (cron needs schedule; event needs event).
    if (trigger.kind === 'cron' && trigger.schedule === undefined) {
      errors.push(
        specError(
          'schema_violation',
          `cron trigger '${trigger.name}' is missing 'schedule'`,
          `triggers[${ti}].schedule`,
        ),
      );
    }
    // A cron trigger is FIRED by the durable off-request worker. Without
    // `deployment.durableWorker:true` no worker is wired, so the cron would be SILENTLY not scheduled
    // (it never fires — no error at deploy, just nothing at 2am). Reject at config time: a declared
    // cron REQUIRES the durable worker. (Defense-in-depth: composition-root ALSO boot-aborts if a cron
    // is registered with no worker wired — see deployDeclaredSpec.)
    if (trigger.kind === 'cron' && spec.deployment?.durableWorker !== true) {
      errors.push(
        specError(
          'schema_violation',
          `cron trigger '${trigger.name}' requires 'deployment.durableWorker: true' — a cron is fired ` +
            'by the durable off-request worker; without it the trigger would never fire (silently ' +
            'unscheduled). Set deployment.durableWorker:true or remove the cron trigger',
          `triggers[${ti}].kind`,
        ),
      );
    }
    if (trigger.kind === 'event' && trigger.event === undefined) {
      errors.push(
        specError(
          'schema_violation',
          `event trigger '${trigger.name}' is missing 'event'`,
          `triggers[${ti}].event`,
        ),
      );
    }
  });

  // ---- 3. CAPABILITY (every agent through core validateSpec) -----------------------------
  spec.agents.forEach((agent, ai) => {
    // A synthetic neutral AgentSpec for capability validation. `input` is a runtime value the
    // config omits, so we supply a placeholder ('') — validateSpec ignores input, it inspects
    // outputSchema + tools against the backend's capabilities. Tools are referenced by id in the
    // config; capability validation only needs to know whether the agent uses ANY tools (the
    // backend must be tool-capable), so we attach lightweight neutral ToolSpecs for the resolved
    // tool ids. Cross-ref resolution above already flags an unknown tool id; here we only build
    // capability input from the ids that resolve.
    const resolvedToolSpecs = agent.tools
      .filter((id) => toolIds.has(id))
      .map((id) => {
        const t = spec.tooling.find((tool) => tool.id === id);
        return {
          name: t?.name ?? id,
          description: t?.description ?? '',
          parameters: (t?.parameters ?? {}) as Record<string, unknown>,
        };
      });
    const synthetic: AgentSpec = {
      name: agent.name,
      instructions: agent.instructions,
      model: agent.model,
      input: '',
      tools: resolvedToolSpecs,
      maxTurns: agent.maxTurns,
      ...(agent.outputSchema ? { outputSchema: agent.outputSchema } : {}),
    };
    const res = validateSpec(synthetic, agent.backend as BackendId, {
      requireNativeStructuredOutput: agent.requireNativeStructuredOutput,
    });
    if (!res.ok) {
      for (const v of res.violations) {
        errors.push(
          specError(
            'capability_violation',
            `agent '${agent.id}' (backend '${agent.backend}'): ${v.message}`,
            `agents[${ai}].backend`,
          ),
        );
      }
    }
  });

  // ---- 4. EMBEDDED SCHEMAS COMPILE (tool parameters/outputSchema + agent outputSchema.schema) --
  // One Ajv instance for the whole pass. strict:false so a tool schema using vendor keywords or
  // draft-mixing does not hard-fail compilation (matches dispatch.ts) — a STRUCTURALLY malformed
  // schema still throws (verified: {type:'not-a-type'} / non-array required / non-object schema).
  const ajv = new Ajv2020Ctor({ allErrors: true, strict: false });

  /** Compile an embedded JSON-Schema; push `invalid_embedded_schema` on a compile throw. */
  const compileEmbedded = (schema: unknown, label: string, path: string): void => {
    try {
      ajv.compile(schema as Record<string, unknown>);
    } catch (e) {
      errors.push(
        specError(
          'invalid_embedded_schema',
          `${label} is a malformed JSON-Schema: ${String(e instanceof Error ? e.message : e)}`,
          path,
        ),
      );
    }
  };

  spec.tooling.forEach((tool, ti) => {
    compileEmbedded(tool.parameters, `tool '${tool.id}' 'parameters'`, `tooling[${ti}].parameters`);
    // (7) Tool args must be an OBJECT schema — all 3 backends require object-typed tool args. A
    // compilable-but-non-object `parameters` (e.g. type:'string', or no type) is a config error.
    const params = tool.parameters as { type?: unknown };
    if (params.type !== 'object') {
      errors.push(
        specError(
          'schema_violation',
          `tool '${tool.id}' 'parameters' must be an object JSON-Schema (type:'object'); ` +
            `got type:${JSON.stringify(params.type)}`,
          `tooling[${ti}].parameters`,
        ),
      );
    }
    if (tool.outputSchema) {
      compileEmbedded(
        tool.outputSchema,
        `tool '${tool.id}' 'outputSchema'`,
        `tooling[${ti}].outputSchema`,
      );
    }
  });

  // (3) An agent's structured-output schema is also embedded JSON-Schema — compile it too, so a
  // malformed agent output schema fails at config time rather than reaching the backend.
  spec.agents.forEach((agent, ai) => {
    if (agent.outputSchema) {
      compileEmbedded(
        agent.outputSchema.schema,
        `agent '${agent.id}' 'outputSchema.schema'`,
        `agents[${ai}].outputSchema.schema`,
      );
    }
  });

  return errors;
}

/**
 * The NON-FATAL semantic-warning pass — advisory findings that do NOT fail a parse (unlike `lintSpec`).
 * Pure over an already-shape-valid `RaySpec`. `doctor`/`plan` surface these alongside the `ok` result so
 * an author sees a documented interaction without being blocked.
 *
 * Today it flags ONE interaction: a `softDelete` store that is the TARGET of a `restrict` foreign key —
 * EITHER an id-target FK (referencing the parent's injected `id`) OR a business-key FK
 * (`referencesColumn`). Both carry the identical footgun: soft-deleting such a parent is an
 * `UPDATE(deleted_at)` that does NOT fire the database ON DELETE restrict, so the referencing rows keep
 * pointing at the (tombstoned) parent — the restrict guarantee only binds on a HARD delete. This is a
 * permitted, documented interaction, so it is a WARNING, not a fail-closed error.
 */
export function lintSpecWarnings(spec: RaySpec): SpecWarning[] {
  const warnings: SpecWarning[] = [];
  spec.stores.forEach((store, si) => {
    if (store.softDelete !== true) return;
    for (const other of spec.stores) {
      for (const fk of other.foreignKeys) {
        // Fire for ANY restrict FK onto this softDelete parent — id-target OR business-key. A soft
        // delete is an UPDATE(deleted_at), which does NOT fire ON DELETE restrict on either FK shape.
        if (fk.references === store.name && fk.onDelete === 'restrict') {
          const fkDesc =
            fk.referencesColumn !== undefined
              ? `business-key foreign key from '${other.name}.${fk.column}' (referencesColumn ` +
                `'${fk.referencesColumn}')`
              : `foreign key from '${other.name}.${fk.column}' (references '${store.name}.id')`;
          warnings.push(
            specWarning(
              'softdelete_fk_restrict',
              `store '${store.name}' is softDelete AND is the target of a restrict ${fkDesc} — ` +
                `soft-deleting a referenced '${store.name}' row is an UPDATE that does NOT fire the ` +
                `database ON DELETE restrict, so '${other.name}' rows keep pointing at the tombstoned ` +
                'parent; the restrict guarantee only binds on a hard delete',
              `stores[${si}].softDelete`,
            ),
          );
        }
      }
    }
  });
  return warnings;
}
