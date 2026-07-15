/**
 * Product-YAML semantic validation + the fail-closed no-code guardrails.
 *
 * Two exported passes, both returning the FULL list of violations (never the first):
 *
 *  1. `scanProductGuardrails(raw)` — the NO-CODE-IN-YAML enforcement,
 *     run on the RAW parsed object BEFORE the strict Zod parse so each ban produces a SPECIFIC,
 *     EXPLAINING error (the draft's validation-error table) instead of a generic strict unknown-key.
 *     It is SECTION-AWARE:
 *       • GLOBAL (whole doc EXCEPT `contracts`): hard code/handler/SQL/shell keys + inline-code string
 *         VALUES + provider-native WIRE-BLOB keys are banned everywhere (`no_code_in_yaml` /
 *         `provider_native_leak`). `contracts` is EXCLUDED because there a `code`/`function` KEY is a
 *         legitimate DATA property name, not a handler reference — contracts are vetted by the
 *         vocabulary check in `lintProductSpec` instead.
 *       • WORKFLOWS + EXTRACTORS subtrees ONLY: provider/model POLICY keys, provider NAMES, and prompt keys
 *         are ALSO banned — this is the EXECUTABLE graph, which must stay provider-neutral so it compiles
 *         through `@rayspec/product-yaml-workflow-bridge`. The key sets/regexes MIRROR that bridge's
 *         neutrality walk exactly, so a spec that validates here feeds the bridge unchanged, AND provider
 *         POLICY stays legal where the draft allows it (`capabilities[].provider_policy`,
 *         `deployment_overrides`).
 *
 *  2. `lintProductSpec(spec)` — cross-reference resolution, duplicate-id rejection, capability-status
 *     discipline, and the CLOSED contract vocabulary — over an already-shape-valid `ProductSpec`.
 *
 * NOTHING is ever silently dropped or decoratively validated (the fail-open lesson: reject loudly,
 * never silently drop). Every mis-specified element is rejected with a closed `SpecError` code.
 */
import { type SpecError, specError } from './errors.js';
// The RESERVED (injected tenancy/GDPR) column names — the SAME set the backend store lint enforces
// (lint.ts). A declared product store column may not shadow one: the SQL generator INJECTS them.
// `toJsIdentifier` is the spec-side snake→camel copy (KEEP-IN-SYNC docstring at its definition)
// used by the column-collision check below.
import { RESERVED_COLUMN_NAMES, RESERVED_QUERY_KEYWORDS, toJsIdentifier } from './lint.js';
import { normalizeProductTriggerEvent } from './product-events.js';
import type { ProductSpec } from './product-grammar.js';
import { lintProductViews } from './product-views-lint.js';

// ---------------------------------------------------------------------------------------
// no-code guardrails — key sets + patterns
// (the banned-key SETS below are `export`ed for the cross-package parser↔bridge KEY-SET parity test in
//  `@rayspec/product-yaml-workflow-bridge`, which asserts the parser bans a SUPERSET of the bridge's
//  keys. Export-only — no runtime behavior change.)
// ---------------------------------------------------------------------------------------

/**
 * HARD code/handler keys — banned EVERYWHERE (except inside `contracts`, where a property may
 * legitimately be named this). A key here means product-owned code/handlers/SQL/shell are being
 * smuggled into product meaning; implementation belongs in Tier A/B.
 */
export const GLOBAL_CODE_KEYS: ReadonlySet<string> = new Set([
  'code',
  'fn',
  'function',
  'handler',
  'handler_path',
  'handlers',
  'implementation',
  'inline_js',
  'inline_ts',
  'javascript',
  'module',
  'module_path',
  'resolver',
  'route_handler',
  'shell',
  'sql',
  'typescript',
]);

/**
 * Provider-native WIRE-BLOB keys — banned EVERYWHERE (a raw provider request/response payload is never
 * a Product-YAML contract). DISTINCT from provider POLICY keys (`default_provider`/`default_model`/…),
 * which are ALLOWED on a capability / in `deployment_overrides` and only banned inside workflows/extractors.
 */
export const GLOBAL_PROVIDER_BLOB_KEYS: ReadonlySet<string> = new Set([
  'api_key',
  'api_key_env',
  'body',
  'deepgram_request',
  'headers',
  'native_payload',
  'provider_payload',
  'raw_provider_payload',
]);

/**
 * Inline-code string VALUES (mirrors the product-YAML check script's `codeLikePattern`) — an import/require/
 * arrow-fn/class/process.env/child_process/eval/file-path/SQL fragment appearing as a value is code.
 */
const CODE_LIKE_VALUE =
  /\b(import\s+|export\s+|require\s*\(|=>|function\s+\w*|class\s+\w+|async\s+function|process\.env|Deno\.|Bun\.|child_process|exec\s*\(|eval\s*\(|new\s+Function|\.ts\b|\.tsx\b|\.js\b|\.mjs\b|\.cjs\b|\/handlers\/|handlers\/|SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+.+\s+SET|DELETE\s+FROM)\b/i;

/**
 * Provider/model POLICY keys — banned INSIDE `workflows`/`extractors` (the executable graph). These mirror
 * `@rayspec/product-yaml-workflow-bridge`'s `providerNativeKeys` so the two neutrality boundaries are
 * identical. Legal OUTSIDE the graph (capability provider_policy / deployment_overrides).
 */
export const GRAPH_PROVIDER_POLICY_KEYS: ReadonlySet<string> = new Set([
  'adapter_visibility',
  'backend',
  'credential_env',
  'default_backend',
  'default_model',
  'default_provider',
  'model',
  'model_policy',
  'provider',
  'provider_payload',
  'provider_policy',
]);

/** Prompt keys — banned inside the graph (prompt text is a Tier-B agent-execution concern, not YAML). */
export const GRAPH_PROMPT_KEYS: ReadonlySet<string> = new Set([
  'prompt',
  'prompt_template',
  'system_prompt',
  'user_prompt',
]);

/** A product-owned handler/module PATH as a string value (banned in the graph). */
const PRODUCT_OWNED_PATH = /(?:\/handlers\/|handlers\/|\.tsx?\b|\.mjs\b|\.cjs\b|\.js\b)/i;
/** A provider NAME as a string value (banned in the graph — mirrors the bridge). */
const PROVIDER_NAME_VALUE =
  /\b(?:deepgram|openai|anthropic|gemini|pi)\b|provider_native|native_payload/i;
/**
 * A PRODUCTION-EXECUTION claim as a string value (banned in the graph). MIRRORS the workflow-bridge's
 * `productionClaimPattern` BYTE-FOR-BYTE (compiler.ts) — a Product-YAML doc declares meaning, it does not
 * claim it EXECUTES in production. The `product-bridge-parity.test.ts` cross-check keeps the two in sync.
 */
const GRAPH_PRODUCTION_CLAIM = /\b(production_ready|prod(?:uction)?\s+execution|prod\s+runtime)\b/i;
/**
 * A PROMPT/LLM-EXECUTION claim as a string value (banned in the graph). MIRRORS the workflow-bridge's
 * `promptExecutionPattern` BYTE-FOR-BYTE — prompt/agent execution is a Tier-B runtime concern, not YAML
 * meaning. Closing this was finding GR-1: a graph string like `llm call` passed the parser but the bridge
 * THREW on it (the S7-2 validate/compile drift). Kept in sync by the parity cross-check test.
 */
const GRAPH_PROMPT_EXECUTION = /\b(prompt\s+execution|execute\s+prompt|llm\s+call|agent\s+call)\b/i;

/**
 * A media STREAMING/PLAYBACK route marker. Streaming/range media serving is a Tier-B media
 * capability, NEVER a Product-YAML view handler. Word-boundary-anchored so a playback-TOKEN read
 * view (e.g. `/play-token`) and a benign name like `/downstream-processor` are NOT caught, while real
 * streaming routes ARE — including COMPOUND names (`/livestream`, `/live-streaming`) and the plural
 * (`/streams`), which the prior `\bstream\b` marker missed because `live`+`stream` carries no internal
 * word boundary. The closed `source.kind` enum stays the STRUCTURAL guard (a `stream` source kind → a
 * bad-enum `schema_violation`); this route-path marker is defense-in-depth. Tested fail-the-fix with BOTH
 * positive and negative cases (no untested substring theater).
 */
const STREAMING_ROUTE_MARKER = /\b(?:playback|(?:live)?stream(?:ing|s)?)\b/i;

// The trigger normalization (a workflow trigger's `capability` + `event` → the canonical event id)
// is the SHARED `normalizeProductTriggerEvent` from `./product-events.js` (S1) — the ONE source the
// bridge compiler also imports (the old KEEP-IN-SYNC local copy is gone; the cross-package parity
// test pins the single source). The parser requires the normalized event to be a declared contract of
// the trigger's capability (its doc-level proxy for the Tier-B event vocabulary the bridge validates
// against its stage manifests), so a typo'd `trigger.event` fails closed here instead of only at
// bridge-compile time (finding GR-4).

/**
 * Walk an arbitrary value, applying `onKey` to every object key and `onString` to every string leaf,
 * building a JSON path for the message. Pure structural recursion (arrays index, objects descend).
 */
function walk(
  value: unknown,
  path: string,
  onKey: (key: string, path: string) => void,
  onString: (value: string, path: string) => void,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      walk(item, `${path}[${i}]`, onKey, onString);
    });
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      onKey(key, `${path}.${key}`);
      walk(child, `${path}.${key}`, onKey, onString);
    }
    return;
  }
  if (typeof value === 'string') onString(value, path);
}

/**
 * The no-code-in-YAML guardrail scan over the RAW parsed doc. Returns SPECIFIC, explaining errors
 * (`no_code_in_yaml` / `provider_native_leak`). Section-aware (see the module docstring).
 */
export function scanProductGuardrails(raw: unknown): SpecError[] {
  const errors: SpecError[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return errors;
  const doc = raw as Record<string, unknown>;

  // ---- GLOBAL scan (whole doc EXCEPT `contracts`) --------------------------------------
  for (const [topKey, topVal] of Object.entries(doc)) {
    if (topKey === 'contracts') continue; // contracts are vetted by the vocabulary check below
    walk(
      topVal,
      topKey,
      (key, keyPath) => {
        if (GLOBAL_CODE_KEYS.has(key)) {
          errors.push(
            specError(
              'no_code_in_yaml',
              `banned code-like key '${key}' at ${keyPath}; Product YAML declares meaning and ` +
                'contracts — code/handlers/SQL belong in Tier A/B implementation, not in YAML',
              keyPath,
            ),
          );
        } else if (GLOBAL_PROVIDER_BLOB_KEYS.has(key)) {
          errors.push(
            specError(
              'provider_native_leak',
              `provider-native wire-blob key '${key}' at ${keyPath}; expose a provider-neutral ` +
                'contract instead of a raw provider request/response payload',
              keyPath,
            ),
          );
        }
      },
      (str, strPath) => {
        if (CODE_LIKE_VALUE.test(str)) {
          errors.push(
            specError(
              'no_code_in_yaml',
              `inline-code string value at ${strPath}; Product YAML must not contain JS/TS, SQL, ` +
                'shell, or handler module paths',
              strPath,
            ),
          );
        }
      },
    );
  }

  // ---- GRAPH scan (workflows + extractors ONLY) ----------------------------------------
  for (const section of ['workflows', 'extractors'] as const) {
    if (!(section in doc)) continue;
    walk(
      doc[section],
      section,
      (key, keyPath) => {
        if (GRAPH_PROVIDER_POLICY_KEYS.has(key)) {
          errors.push(
            specError(
              'provider_native_leak',
              `provider/model policy key '${key}' at ${keyPath}; the executable workflow/agent graph ` +
                'must stay provider-neutral — put provider policy on the capability or in ' +
                'deployment_overrides, not in the graph',
              keyPath,
            ),
          );
        } else if (GRAPH_PROMPT_KEYS.has(key)) {
          errors.push(
            specError(
              'no_code_in_yaml',
              `prompt key '${key}' at ${keyPath}; prompt text is a Tier-B agent-execution concern, ` +
                'not Product YAML meaning',
              keyPath,
            ),
          );
        }
      },
      (str, strPath) => {
        // MIRRORS the bridge's `walkWorkflowDeclarations` string checks in ORDER (compiler.ts): product-
        // owned path → provider name → production-execution claim → prompt/LLM-execution claim. Keeping
        // both this order and the regexes identical is the GR-1 anti-drift contract (parity-tested).
        if (PRODUCT_OWNED_PATH.test(str)) {
          errors.push(
            specError(
              'no_code_in_yaml',
              `product-owned handler/module path '${str}' at ${strPath}; the workflow/agent graph ` +
                'references Tier A/B primitives, not TypeScript modules',
              strPath,
            ),
          );
        } else if (PROVIDER_NAME_VALUE.test(str)) {
          errors.push(
            specError(
              'provider_native_leak',
              `provider-native value '${str}' at ${strPath}; the workflow/agent graph must name ` +
                'neutral capability operations, not providers',
              strPath,
            ),
          );
        } else if (GRAPH_PRODUCTION_CLAIM.test(str)) {
          errors.push(
            specError(
              'production_execution_claim',
              `production-execution claim '${str}' at ${strPath}; Product YAML declares meaning, it ` +
                'does not claim it EXECUTES in production (that is a Tier A/B runtime concern)',
              strPath,
            ),
          );
        } else if (GRAPH_PROMPT_EXECUTION.test(str)) {
          errors.push(
            specError(
              'prompt_execution_claim',
              `prompt/LLM-execution claim '${str}' at ${strPath}; prompt/agent execution is a Tier-B ` +
                'runtime concern, not Product YAML meaning',
              strPath,
            ),
          );
        }
      },
    );
  }

  return errors;
}

// ---------------------------------------------------------------------------------------
// contract vocabulary — the CLOSED declarative JSON-Schema-like vocabulary
// ---------------------------------------------------------------------------------------

/** Allowed keys at a contract SCHEMA level (the draft's "Allowed schema vocabulary"). */
const CONTRACT_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  'type',
  'description',
  'properties',
  'items',
  'required',
  'enum',
  'additional_properties',
  'nullable',
  'ref',
]);
/** Allowed `type` values (the draft's "Allowed contract types"). */
const CONTRACT_TYPES: ReadonlySet<string> = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]);

/** Validate ONE contract schema node recursively against the closed vocabulary. */
function lintContractSchema(node: unknown, path: string, errors: SpecError[]): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    errors.push(
      specError(
        'invalid_contract',
        `contract schema at ${path} must be an object (a declarative JSON-Schema-like node)`,
        path,
      ),
    );
    return;
  }
  const schema = node as Record<string, unknown>;
  for (const key of Object.keys(schema)) {
    if (!CONTRACT_SCHEMA_KEYS.has(key)) {
      errors.push(
        specError(
          'invalid_contract',
          `unknown contract schema key '${key}' at ${path}.${key}; the contract vocabulary is closed ` +
            '(type/description/properties/items/required/enum/additional_properties/nullable/ref) — ' +
            'functions, transforms, computed expressions, and provider-native shapes are forbidden',
          `${path}.${key}`,
        ),
      );
    }
  }
  // SCALAR-valued keys must carry their expected scalar shape (GR-2). Without this, a NON-schema position
  // that admits an object (e.g. `description: { handler: '/handlers/evil.ts', code: "import x from 'y'" }`)
  // escaped BOTH the contracts-exempt global guardrail scan AND this vocabulary check — smuggling
  // handler/code keys past the parser. `type`/`properties`/`items`/`required`/`enum` are shape-checked
  // below; these four are the remaining allowed keys, each of which must be a scalar of the right type.
  if ('description' in schema && typeof schema.description !== 'string') {
    errors.push(
      specError(
        'invalid_contract',
        `contract 'description' at ${path}.description must be a string (not an object/array)`,
        `${path}.description`,
      ),
    );
  }
  if ('additional_properties' in schema && typeof schema.additional_properties !== 'boolean') {
    errors.push(
      specError(
        'invalid_contract',
        `contract 'additional_properties' at ${path}.additional_properties must be a boolean`,
        `${path}.additional_properties`,
      ),
    );
  }
  if ('nullable' in schema && typeof schema.nullable !== 'boolean') {
    errors.push(
      specError(
        'invalid_contract',
        `contract 'nullable' at ${path}.nullable must be a boolean`,
        `${path}.nullable`,
      ),
    );
  }
  if ('ref' in schema && typeof schema.ref !== 'string') {
    errors.push(
      specError(
        'invalid_contract',
        `contract 'ref' at ${path}.ref must be a string (a contract id)`,
        `${path}.ref`,
      ),
    );
  }
  // `type` — a single allowed type OR an array of allowed types (nullable unions like [object, "null"]).
  if ('type' in schema) {
    const t = schema.type;
    const types = Array.isArray(t) ? t : [t];
    for (const one of types) {
      if (typeof one !== 'string' || !CONTRACT_TYPES.has(one)) {
        errors.push(
          specError(
            'invalid_contract',
            `contract type ${JSON.stringify(one)} at ${path}.type is not an allowed type ` +
              '(object/array/string/number/integer/boolean/null)',
            `${path}.type`,
          ),
        );
      }
    }
  }
  // `properties` — a map of arbitrary PROPERTY NAMES to sub-schemas (recurse into the sub-schemas).
  if ('properties' in schema) {
    const props = schema.properties;
    if (props === null || typeof props !== 'object' || Array.isArray(props)) {
      errors.push(
        specError(
          'invalid_contract',
          `contract 'properties' at ${path}.properties must be an object`,
          `${path}.properties`,
        ),
      );
    } else {
      for (const [pname, pschema] of Object.entries(props as Record<string, unknown>)) {
        lintContractSchema(pschema, `${path}.properties.${pname}`, errors);
      }
    }
  }
  // `items` — a single sub-schema (recurse).
  if ('items' in schema) lintContractSchema(schema.items, `${path}.items`, errors);
  // `required` — an array of strings.
  if ('required' in schema) {
    const req = schema.required;
    if (!Array.isArray(req) || req.some((r) => typeof r !== 'string')) {
      errors.push(
        specError(
          'invalid_contract',
          `contract 'required' at ${path}.required must be an array of strings`,
          `${path}.required`,
        ),
      );
    }
  }
  // `enum` — a non-empty array of SCALARS (string/number/boolean/null). An object/array element is not a
  // valid enum member and would smuggle a nested shape (e.g. a `{ handler, code }` map) past BOTH the
  // contracts-exempt global guardrail scan and this vocabulary check — the same GR-2 class of hole that
  // `description` had. Each non-scalar element is reported at its index.
  if ('enum' in schema) {
    const en = schema.enum;
    if (!Array.isArray(en) || en.length === 0) {
      errors.push(
        specError(
          'invalid_contract',
          `contract 'enum' at ${path}.enum must be a non-empty array`,
          `${path}.enum`,
        ),
      );
    } else {
      en.forEach((element, i) => {
        if (element !== null && typeof element === 'object') {
          errors.push(
            specError(
              'invalid_contract',
              `contract 'enum' element at ${path}.enum[${i}] must be a scalar ` +
                '(string/number/boolean/null), not an object/array',
              `${path}.enum[${i}]`,
            ),
          );
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------------------
// declared product stores + store steps
// ---------------------------------------------------------------------------------------

/**
 * The GRAPH KEY DENYLIST a declared store column name must avoid: the whole point of a declared
 * column is to be referenced as an OBJECT KEY from workflow-step `filter`/`values` maps — which live
 * in the graph subtree the guardrail scan bans these keys in. A column named `model`/`body`/`sql`/…
 * would be UNDECLARABLE in any step (a confusing late `no_code_in_yaml`/`provider_native_leak` at the
 * use site), so it is rejected AT THE DECLARATION with an explaining message instead.
 */
const STORE_COLUMN_DENYLIST: ReadonlySet<string> = new Set([
  ...GLOBAL_CODE_KEYS,
  ...GLOBAL_PROVIDER_BLOB_KEYS,
  ...GRAPH_PROVIDER_POLICY_KEYS,
  ...GRAPH_PROMPT_KEYS,
]);

/**
 * The S2 store checks — section-level (names, columns, keys) + step-level (target resolution, column
 * contracts, the conflict-key law, per-type field discipline). ONE shared implementation consumed by
 * BOTH `lintProductSpec` (doc/parse time) and `composeProductDeploy` (mount time, defense-in-depth for
 * a code-built spec that bypassed the parser) — never two drifting copies. Returns the FULL list.
 *
 * `capabilityStoreNames` (OPTIONAL — CW-1): the CAPABILITY-OWNED store names of the composing
 * runtime (e.g. the audio mount's stores). A declared store shadowing one is rejected fail-closed
 * (capability stores are owned by their Tier-B runtime). PARSE-TIME callers pass NOTHING —
 * @rayspec/spec cannot import runtime store names, so the doc-level lint covers COLLECTION
 * collisions only (the documented cut); COMPOSE passes the real wired set and covers BOTH (so a
 * code-built spec that bypassed the parser is caught at compose, BEFORE derive/rollout).
 */
export function checkProductStores(
  spec: ProductSpec,
  capabilityStoreNames?: ReadonlySet<string>,
): SpecError[] {
  const errors: SpecError[] = [];
  const inv = (message: string, path: string): void => {
    errors.push(specError('invalid_store', message, path));
  };

  // ---- section level ------------------------------------------------------------------
  errors.push(
    ...findDuplicates(
      spec.stores,
      (s) => s.name,
      'store name',
      (i) => `stores[${i}].name`,
    ),
  );
  const collectionNames = new Set(
    spec.artifacts.map((a) => a.collection).filter((c): c is string => typeof c === 'string'),
  );
  const storeByName = new Map(spec.stores.map((s) => [s.name, s]));
  spec.stores.forEach((store, si) => {
    const base = `stores[${si}]`;
    if (collectionNames.has(store.name)) {
      inv(
        `store '${store.name}' collides with a derived artifact COLLECTION store of the same name — ` +
          'collection stores are derived from artifacts[].collection and owned by the artifact.persist ' +
          'lifecycle; declare a distinct name',
        `${base}.name`,
      );
    }
    // CW-1: only when the caller supplies the runtime's capability-owned store names (compose does;
    // parse time cannot — see the docstring). Mirrors deriveProductStores' own fail-closed check so
    // an audio-name shadow is rejected at compose even when derive never runs (hand-built rollout).
    if (capabilityStoreNames?.has(store.name)) {
      inv(
        `store '${store.name}' collides with a capability-owned store of the same name — ` +
          'capability stores are owned by their Tier-B runtime; declare a distinct name',
        `${base}.name`,
      );
    }
    errors.push(
      ...findDuplicates(
        store.columns,
        (c) => c.name,
        `column name in store '${store.name}'`,
        (i) => `${base}.columns[${i}].name`,
      ),
    );
    const columnByName = new Map(store.columns.map((c) => [c.name, c]));
    store.columns.forEach((col, ci) => {
      if (RESERVED_COLUMN_NAMES.has(col.name)) {
        errors.push(
          specError(
            'reserved_column_name',
            `store '${store.name}' declares reserved column '${col.name}' — that column is injected ` +
              'by the platform (tenancy/GDPR) and may not be declared as a business column',
            `${base}.columns[${ci}].name`,
          ),
        );
      } else if (RESERVED_QUERY_KEYWORDS.has(col.name)) {
        // A column named after a list-query control keyword (order/after/limit/search) would be
        // un-filterable AND would emit a duplicate OpenAPI query parameter on a list route — reject at
        // config with a rename hint (symmetric with the backend store lint).
        errors.push(
          specError(
            'reserved_query_keyword',
            `store '${store.name}' declares column '${col.name}', which collides with a reserved ` +
              'list-query control keyword (order/after/limit/search) used for sorting/keyset ' +
              'pagination/substring search — the column would be un-filterable and would emit a ' +
              'duplicate OpenAPI query parameter; rename the business column',
            `${base}.columns[${ci}].name`,
          ),
        );
      } else if (STORE_COLUMN_DENYLIST.has(col.name)) {
        inv(
          `store '${store.name}' column '${col.name}' collides with a banned graph key — it could ` +
            "never be referenced from a workflow step's filter/values (the no-code/provider-neutrality " +
            'guardrails ban that key in the graph); pick a different column name',
          `${base}.columns[${ci}].name`,
        );
      }
    });
    // Two DECLARED column names mapping to the SAME camelCase
    // runtime key would silently resolve to ONE runtime column — the table builder keys the PgTable
    // by camelCase (build-product-tables.ts) and the facade maps names with the same rule
    // (store-facade.ts snakeToCamel), while the store NODE classifies its DO-UPDATE/DO-NOTHING
    // upsert arm on the SNAKE names (store-nodes.ts) — a camel collision is exactly where those two
    // independent classifications could diverge. SafeIdentifier does NOT prevent it: the rule's
    // `_([a-z0-9])` uppercases DIGITS as a NO-OP, so `col_1` and `col1` BOTH map to `col1` (letters
    // are safe: `a_bc`→`aBc` ≠ `ab_c`→`abC` — the underscore survives as case). Mirrors the backend
    // lint's column-collision check (lint.ts) with an explaining both-columns message.
    //
    // The map is SEEDED with the INJECTED tenancy/GDPR camels — HONESTY NOTE: with the CURRENT
    // injected set this seed arm is provably unreachable (no injected name contains a digit, and an
    // underscore-before-a-digit is the ONLY collision vector within SafeIdentifier space, so any
    // name camel-colliding with an injected name IS that name — which `reserved_column_name` above
    // already rejected). Kept as a structural guard should the injected set ever gain a
    // digit-bearing name; the DECLARED-vs-DECLARED arm below is the live, RED-first-tested one.
    const camelOwner = new Map<string, string>();
    for (const reserved of RESERVED_COLUMN_NAMES)
      camelOwner.set(toJsIdentifier(reserved), reserved);
    store.columns.forEach((col, ci) => {
      const camel = toJsIdentifier(col.name);
      const owner = camelOwner.get(camel);
      if (owner === undefined) {
        camelOwner.set(camel, col.name);
        return;
      }
      // The exact-duplicate / exact-reserved case is already rejected above (duplicate_name /
      // reserved_column_name) — do not double-report it here.
      if (owner === col.name) return;
      const ownerIsInjected = RESERVED_COLUMN_NAMES.has(owner);
      inv(
        ownerIsInjected
          ? `store '${store.name}' column '${col.name}' collides with the INJECTED column '${owner}' ` +
              `under the snake_case→camelCase column mapping (both become runtime key '${camel}') — ` +
              'the injected tenancy/GDPR columns own that runtime key; rename the business column'
          : `store '${store.name}' columns '${owner}' and '${col.name}' collide under the ` +
              `snake_case→camelCase column mapping (both become runtime column key '${camel}') — the ` +
              'runtime table and the store facade key columns by camelCase, so the two declared names ' +
              'would silently resolve to ONE column; rename one',
        `${base}.columns[${ci}].name`,
      );
    });
    store.key.forEach((keyColumn, ki) => {
      const col = columnByName.get(keyColumn);
      if (!col) {
        inv(
          `store '${store.name}' key names undeclared column '${keyColumn}' — the conflict key must ` +
            'be a declared column',
          `${base}.key[${ki}]`,
        );
      } else if (col.nullable) {
        inv(
          `store '${store.name}' key column '${keyColumn}' is nullable — a NULLABLE conflict key ` +
            'breaks the upsert identity (a unique index admits multiple NULLs, so re-executed writes ' +
            'would duplicate instead of dedupe); declare it non-nullable',
          `${base}.key[${ki}]`,
        );
      }
    });
  });

  // ---- step level ---------------------------------------------------------------------
  const contractIds = new Set(Object.keys(spec.contracts));
  const capabilityContractRefs = new Set<string>();
  for (const cap of spec.capabilities)
    for (const cref of cap.contracts) capabilityContractRefs.add(cref);

  spec.workflows.forEach((wf, wi) => {
    wf.steps.forEach((step, si) => {
      const base = `workflows[${wi}].steps[${si}]`;
      const isRead = step.type === 'store_read';
      const isWrite = step.type === 'store_write';
      if (!isRead && !isWrite) {
        for (const field of ['store', 'filter', 'limit', 'values'] as const) {
          if (step[field] !== undefined) {
            inv(
              `workflow '${wf.id}' step '${step.id}' of type '${step.type}' declares '${field}', ` +
                'which is store-step vocabulary (store_read/store_write only)',
              `${base}.${field}`,
            );
          }
        }
        return;
      }

      // The target store must be DECLARED (stores[]) — never a derived collection / capability store
      // (those are owned by their own lifecycles; a step write would bypass them).
      const target = step.store !== undefined ? storeByName.get(step.store) : undefined;
      if (step.store === undefined) {
        inv(
          `workflow '${wf.id}' ${step.type} step '${step.id}' must declare a target 'store' ` +
            '(a declared stores[].name)',
          `${base}.store`,
        );
      } else if (!target) {
        inv(
          `workflow '${wf.id}' step '${step.id}' targets store '${step.store}', which is not a ` +
            'declared product store (stores[]) — derived collection/capability-owned stores are ' +
            'never step-addressable',
          `${base}.store`,
        );
      }
      const declaredColumns = target ? new Set(target.columns.map((c) => c.name)) : undefined;
      const columnList = target ? target.columns.map((c) => c.name).join(', ') : '';

      if (isRead) {
        if (step.values !== undefined) {
          inv(
            `store_read step '${step.id}' declares 'values' (store_write vocabulary) — a read has ` +
              'filters, not written values',
            `${base}.values`,
          );
        }
        for (const column of Object.keys(step.filter ?? {})) {
          if (declaredColumns && !declaredColumns.has(column)) {
            inv(
              `store_read step '${step.id}' filters on '${column}', which is not a declared column ` +
                `of store '${step.store}' (declared: ${columnList})`,
              `${base}.filter.${column}`,
            );
          }
        }
        const outputCount = Object.keys(step.outputs ?? {}).length;
        if (outputCount !== 1) {
          inv(
            `store_read step '${step.id}' must declare exactly one output (the rows artifact ` +
              `contract ref a downstream step consumes); got ${outputCount}`,
            `${base}.outputs`,
          );
        }
      } else {
        for (const field of ['filter', 'limit'] as const) {
          if (step[field] !== undefined) {
            inv(
              `store_write step '${step.id}' declares '${field}' (store_read vocabulary) — a write ` +
                'is an upsert of one declared row, never a query',
              `${base}.${field}`,
            );
          }
        }
        const entries = Object.entries(step.values ?? {});
        if (step.values === undefined || entries.length === 0) {
          inv(
            `store_write step '${step.id}' must declare non-empty 'values' (the written row: ` +
              'column → event key | literal | upstream artifact)',
            `${base}.values`,
          );
        }
        for (const [column, source] of entries) {
          if (declaredColumns && !declaredColumns.has(column)) {
            inv(
              `store_write step '${step.id}' writes column '${column}', which is not a declared ` +
                `column of store '${step.store}' (declared: ${columnList})`,
              `${base}.values.${column}`,
            );
          }
          if (source !== null && typeof source === 'object' && 'artifact' in source) {
            const ref = (source as { artifact: string }).artifact;
            if (!contractIds.has(ref) && !capabilityContractRefs.has(ref)) {
              errors.push(
                specError(
                  'dangling_ref',
                  `store_write step '${step.id}' values.${column} references artifact contract ` +
                    `'${ref}', which is not declared in contracts[] or on a capability`,
                  `${base}.values.${column}`,
                ),
              );
            }
          }
        }
        if (target && entries.length > 0) {
          for (const keyColumn of target.key) {
            if (!entries.some(([column]) => column === keyColumn)) {
              inv(
                `store_write step '${step.id}' values must include the conflict-key column ` +
                  `'${keyColumn}' of store '${step.store}' — the upsert identity every re-executed ` +
                  'write dedupes on (the at-least-once law)',
                `${base}.values`,
              );
            }
          }
        }
        const outputCount = Object.keys(step.outputs ?? {}).length;
        if (outputCount > 1) {
          inv(
            `store_write step '${step.id}' may declare at most one output (the written-row ` +
              `artifact); got ${outputCount}`,
            `${base}.outputs`,
          );
        }
      }
    });
  });

  return errors;
}

// ---------------------------------------------------------------------------------------
// cross-references + duplicates + capability status
// ---------------------------------------------------------------------------------------

/** Report each duplicate occurrence (by index) as a `duplicate_name` SpecError. */
function findDuplicates<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  label: string,
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
          `duplicate ${label} '${key}' (each ${label} must be unique)`,
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
 * The full semantic pass over an already-shape-valid `ProductSpec`. Resolves every cross-reference,
 * rejects duplicates, enforces the capability-status discipline, and vets the contract vocabulary.
 */
export function lintProductSpec(spec: ProductSpec): SpecError[] {
  const errors: SpecError[] = [];

  const capabilityIds = new Set(spec.capabilities.map((c) => c.id));
  // The declared extractor ids — each registers a runtime `agent.<id>` operation (the byte-identity
  // namespace), so a workflow `agent` step's `use: agent.<id>` resolves against THIS set.
  const extractorIds = new Set(spec.extractors.map((a) => a.id));
  const contractIds = new Set(Object.keys(spec.contracts));
  // Every contract EXPLICITLY declared on a capability (its `contracts[]` list). A capability-namespaced
  // ref must resolve to one of THESE, not to the namespace alone (GR-4): `cap.typoed_contract` used to
  // resolve merely because `cap` was a declared capability, letting a typo'd Tier-B contract ref through.
  const capabilityContractRefs = new Set<string>();
  for (const cap of spec.capabilities)
    for (const cref of cap.contracts) capabilityContractRefs.add(cref);

  /**
   * A contract ref resolves iff it is a DECLARED top-level contract id OR an EXACT contract declared on
   * some capability (`capabilities[].contracts[]`). Fail-closed (GR-4): a capability-namespaced ref whose
   * contract is NOT declared on that capability is a `dangling_ref`, not silently accepted on the
   * namespace alone.
   */
  const refResolves = (ref: string): boolean =>
    contractIds.has(ref) || capabilityContractRefs.has(ref);
  const checkRef = (ref: string, path: string): void => {
    if (!refResolves(ref)) {
      errors.push(
        specError(
          'dangling_ref',
          `unresolved contract/capability reference '${ref}' at ${path}; declare it in contracts[] ` +
            'or reference a declared capability contract',
          path,
        ),
      );
    }
  };

  // ---- DUPLICATES --------------------------------------------------------------------
  errors.push(
    ...findDuplicates(
      spec.capabilities,
      (c) => c.id,
      'capability id',
      (i) => `capabilities[${i}].id`,
    ),
    ...findDuplicates(
      spec.artifacts,
      (a) => a.kind,
      'artifact kind',
      (i) => `artifacts[${i}].kind`,
    ),
    ...findDuplicates(
      spec.extractors,
      (a) => a.id,
      'extractor id',
      (i) => `extractors[${i}].id`,
    ),
    ...findDuplicates(
      spec.workflows,
      (w) => w.id,
      'workflow id',
      (i) => `workflows[${i}].id`,
    ),
    ...findDuplicates(
      spec.views,
      (v) => v.id,
      'view id',
      (i) => `views[${i}].id`,
    ),
    ...findDuplicates(
      spec.views,
      (v) => `${v.route.method} ${v.route.path}`,
      'view route',
      (i) => `views[${i}].route`,
    ),
  );

  // ---- requires.capabilities → declared capability ids -------------------------------
  spec.requires.capabilities.forEach((id, i) => {
    if (!capabilityIds.has(id)) {
      errors.push(
        specError(
          'dangling_ref',
          `requires.capabilities references undeclared capability '${id}' — declare it in capabilities[]`,
          `requires.capabilities[${i}]`,
        ),
      );
    }
  });

  // ---- capability status vocabulary -------------------------------------------
  // The earlier blanket rejection of `status:'available'` is deliberately GONE: its premise
  // ("no Tier B runtime is wired yet") expired once the Tier B runtime landed and
  // unlocked the deploy mount. The lint is a DOC-level pass and cannot know what a given deployment
  // wires, so WIREDNESS is now enforced at the real enforcement point — the deploy composition
  // (`@rayspec/product-yaml` composeProductDeploy, called from `deploy()`): a MOUNT rejects any
  // capability that is not `available` or not runtime-backed, fail-closed with the section named.
  // `doctor`/`plan` (validate-only) accept all three statuses; the closed enum in product-grammar.ts
  // still rejects unknown statuses at the shape level. (`invalid_capability_status` stays a reserved
  // SpecError code for the closed-code discipline; nothing emits it at doc level today.)

  // ---- artifacts[].contract → resolve ------------------------------------------------
  spec.artifacts.forEach((art, i) => {
    checkRef(art.contract, `artifacts[${i}].contract`);
    if (art.provenance?.source)
      checkRef(art.provenance.source, `artifacts[${i}].provenance.source`);
    // A declared `quote_field` (opt-in grounding quote-text verification) must name a STRING property
    // of this artifact's contract — the runtime reads the quote off the member payload and verifies it
    // against the cited spans' text, so a quote_field with no declared string field is fail-closed.
    // (The sibling `evidence_field` is intentionally NOT property-resolved: it may name a runtime-only
    // field the contract does not declare; a quote to VERIFY must be a real declared string.)
    const quoteField = art.provenance?.quote_field;
    if (quoteField) {
      const contract = spec.contracts[art.contract];
      if (contract && typeof contract === 'object') {
        const props = (contract as Record<string, unknown>).properties;
        const prop =
          props && typeof props === 'object'
            ? (props as Record<string, unknown>)[quoteField]
            : undefined;
        const isStringProp =
          prop !== null &&
          typeof prop === 'object' &&
          (prop as Record<string, unknown>).type === 'string';
        if (!isStringProp) {
          errors.push(
            specError(
              'dangling_ref',
              `artifacts[${i}].provenance.quote_field '${quoteField}' does not name a string property ` +
                `of contract '${art.contract}' — grounding quote-text verification needs a declared string field.`,
              `artifacts[${i}].provenance.quote_field`,
            ),
          );
        }
      }
    }
  });

  // ---- contracts vocabulary ----------------------------------------------------------
  for (const [id, schema] of Object.entries(spec.contracts)) {
    lintContractSchema(schema, `contracts.${id}`, errors);
  }

  // ---- extractors[].extraction refs → resolve ----------------------------------------
  spec.extractors.forEach((extractor, ai) => {
    const ex = extractor.extraction;
    ex.input_artifacts.forEach((art, i) => {
      checkRef(art.ref, `extractors[${ai}].extraction.input_artifacts[${i}].ref`);
    });
    ex.output_artifacts.forEach((art, i) => {
      checkRef(art.ref, `extractors[${ai}].extraction.output_artifacts[${i}].ref`);
      if (art.schema_ref)
        checkRef(art.schema_ref, `extractors[${ai}].extraction.output_artifacts[${i}].schema_ref`);
    });
    checkRef(
      ex.required_output_shape.schema_ref,
      `extractors[${ai}].extraction.required_output_shape.schema_ref`,
    );
  });

  // ---- workflows[] --------------------------------------------------------------------
  spec.workflows.forEach((wf, wi) => {
    const triggerCap = spec.capabilities.find((c) => c.id === wf.trigger.capability);
    if (!triggerCap) {
      errors.push(
        specError(
          'dangling_ref',
          `workflow '${wf.id}' trigger references undeclared capability '${wf.trigger.capability}'`,
          `workflows[${wi}].trigger.capability`,
        ),
      );
    } else {
      // trigger.event must resolve to a declared contract of that capability (GR-4). We normalize via
      // the SHARED `normalizeProductTriggerEvent` (product-events.ts — the same single source the
      // bridge compiles with), then require the normalized event ∈ the capability's declared
      // `contracts[]` — the doc-level proxy for the Tier-B event vocabulary the bridge checks against
      // its stage manifests. A typo'd event fails closed HERE, not only at bridge-compile time.
      const triggerEvent = normalizeProductTriggerEvent(wf.trigger.capability, wf.trigger.event);
      if (!triggerCap.contracts.includes(triggerEvent)) {
        errors.push(
          specError(
            'dangling_ref',
            `workflow '${wf.id}' trigger event '${wf.trigger.event}' does not resolve to a declared ` +
              `contract of capability '${wf.trigger.capability}' (normalized '${triggerEvent}'); declare ` +
              "it in that capability's contracts[]",
            `workflows[${wi}].trigger.event`,
          ),
        );
      }
    }
    errors.push(
      ...findDuplicates(
        wf.steps,
        (s) => s.id,
        `step id in workflow '${wf.id}'`,
        (i) => `workflows[${wi}].steps[${i}].id`,
      ),
    );
    const stepIds = new Set(wf.steps.map((s) => s.id));
    // Steps declared BEFORE the current one (accumulated in declaration order). `depends_on` may only
    // reference an EARLIER step (GR-3): an unknown step is a `dangling_ref`; a KNOWN step that is not yet
    // declared (a forward or self reference) is an `invalid_dependency_order`. Requiring declaration-order
    // structurally forbids dependency CYCLES (a cycle needs at least one forward edge) and mirrors the
    // bridge's declaration-ordered step graph.
    const seenStepIds = new Set<string>();
    wf.steps.forEach((step, si) => {
      const base = `workflows[${wi}].steps[${si}]`;
      for (const dep of step.depends_on ?? []) {
        if (!stepIds.has(dep)) {
          errors.push(
            specError(
              'dangling_ref',
              `workflow '${wf.id}' step '${step.id}' depends on unknown step '${dep}'`,
              `${base}.depends_on`,
            ),
          );
        } else if (!seenStepIds.has(dep)) {
          errors.push(
            specError(
              'invalid_dependency_order',
              `workflow '${wf.id}' step '${step.id}' depends on '${dep}', which is not declared before ` +
                'it (forward/self/cyclic dependencies are rejected — declare dependencies earlier in steps[])',
              `${base}.depends_on`,
            ),
          );
        }
      }
      // `use` = namespace.operation; the operation half must be present.
      const dot = step.use.indexOf('.');
      const namespace = dot === -1 ? step.use : step.use.slice(0, dot);
      const operation = dot === -1 ? '' : step.use.slice(dot + 1);
      if (operation.length === 0) {
        errors.push(
          specError(
            'schema_violation',
            `workflow '${wf.id}' step '${step.id}' use '${step.use}' must be namespace.operation`,
            `${base}.use`,
          ),
        );
      } else {
        // per-type `use` discipline (mirrors the donor fixture + the bridge)
        switch (step.type) {
          case 'capability':
            if (!capabilityIds.has(namespace)) {
              errors.push(
                specError(
                  'dangling_ref',
                  `workflow '${wf.id}' step '${step.id}' references undeclared capability '${namespace}'`,
                  `${base}.use`,
                ),
              );
            }
            break;
          case 'agent':
            if (namespace !== 'agent' || !extractorIds.has(operation)) {
              errors.push(
                specError(
                  'dangling_ref',
                  `workflow '${wf.id}' agent step '${step.id}' must use agent.<declared-extractor-id> (got '${step.use}')`,
                  `${base}.use`,
                ),
              );
            }
            break;
          case 'validation':
            if (namespace !== 'grounding' && namespace !== 'validation') {
              errors.push(
                specError(
                  'schema_violation',
                  `workflow '${wf.id}' validation step '${step.id}' must use grounding.* or validation.* (got '${step.use}')`,
                  `${base}.use`,
                ),
              );
            }
            break;
          case 'artifact_persist':
            if (step.use !== 'artifact.persist') {
              errors.push(
                specError(
                  'schema_violation',
                  `workflow '${wf.id}' artifact_persist step '${step.id}' must use artifact.persist (got '${step.use}')`,
                  `${base}.use`,
                ),
              );
            }
            break;
          case 'artifact_read':
            if (step.use !== 'artifact.read') {
              errors.push(
                specError(
                  'schema_violation',
                  `workflow '${wf.id}' artifact_read step '${step.id}' must use artifact.read (got '${step.use}')`,
                  `${base}.use`,
                ),
              );
            }
            break;
          // S2: the use discipline is EXACT (mirrors artifact_persist/artifact_read + the bridge) —
          // the two wired operations are store.read / store.write, nothing else.
          case 'store_read':
            if (step.use !== 'store.read') {
              errors.push(
                specError(
                  'schema_violation',
                  `workflow '${wf.id}' store_read step '${step.id}' must use store.read (got '${step.use}')`,
                  `${base}.use`,
                ),
              );
            }
            break;
          case 'store_write':
            if (step.use !== 'store.write') {
              errors.push(
                specError(
                  'schema_violation',
                  `workflow '${wf.id}' store_write step '${step.id}' must use store.write (got '${step.use}')`,
                  `${base}.use`,
                ),
              );
            }
            break;
        }
      }
      // inputs/outputs refs → resolve
      for (const [k, ref] of Object.entries(step.inputs ?? {}))
        checkRef(ref, `${base}.inputs.${k}`);
      for (const [k, ref] of Object.entries(step.outputs ?? {}))
        checkRef(ref, `${base}.outputs.${k}`);
      // Record this step as declared — a LATER step may depend on it, an earlier one may not (GR-3).
      seenStepIds.add(step.id);
    });
  });

  // ---- declared product stores + store steps (S2) -------------------------------------
  errors.push(...checkProductStores(spec));

  // ---- grounding policy refs ---------------------------------------------------------
  if (spec.grounding) {
    if (spec.grounding.source_span_contract)
      checkRef(spec.grounding.source_span_contract, 'grounding.source_span_contract');
    if (spec.grounding.validation_capability)
      checkRef(spec.grounding.validation_capability, 'grounding.validation_capability');
  }

  // ---- views[] -----------------------------------------------------------------------
  // Source resolution is now KIND-AWARE and response-contract
  // resolution + shape⊆contract conformance are SEPARATE validations — both live in
  // `lintProductViews` (product-views-lint.ts), which the views runtime re-runs at mount time.
  // The old flat `checkRef(view.source.ref)` (which let a source ref resolve against ANY contract
  // — the conflation) is deliberately GONE.
  errors.push(
    ...lintProductViews({
      views: spec.views,
      contracts: spec.contracts,
      artifacts: spec.artifacts,
      capabilities: spec.capabilities,
    }),
  );
  spec.views.forEach((view, vi) => {
    const base = `views[${vi}]`;
    if (!view.route.path.startsWith('/')) {
      errors.push(
        specError(
          'schema_violation',
          `view '${view.id}' route path must start with '/'`,
          `${base}.route.path`,
        ),
      );
    }
    // Media STREAMING/PLAYBACK serving is a Tier-B media capability, NEVER a Product-YAML view
    // handler. The view grammar already forbids a streaming SOURCE KIND (source.kind is a
    // closed enum → a bad-enum `schema_violation`); this additionally rejects a route PATH that names
    // binary/range media streaming (`/playback`, `/stream`, `/streaming`). Word-boundary-anchored so a
    // playback-TOKEN read view (e.g. `/…/play-token`) is allowed — the token view returns a read model,
    // not a stream. Tested per-marker (GR/TH-4: no untested substring theater).
    if (STREAMING_ROUTE_MARKER.test(view.route.path)) {
      errors.push(
        specError(
          'schema_violation',
          `view '${view.id}' route '${view.route.path}' names media streaming/playback, which belongs ` +
            'to Tier-B media capability serving, not a Product-YAML view route',
          `${base}.route.path`,
        ),
      );
    }
  });

  return errors;
}
