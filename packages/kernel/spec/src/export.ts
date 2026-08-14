/**
 * JSON-Schema exporter for the RaySpec config grammar.
 *
 * The design calls for "Zod + JSON-Schema export". The pinned `zod@4.4.3` ships a native
 * `z.toJSONSchema` (verified doc-first) so this needs NO new dependency. We export at the
 * draft-2020-12 dialect — the SAME dialect `packages/platform/src/dispatch.ts` compiles tool
 * schemas with (`ajv/dist/2020`) — so the runtime exporter and the runtime validator speak one
 * JSON-Schema language.
 *
 * Scope: build the RUNTIME exporter + the round-trip contract test.
 *
 * The MINIMAL schema-emit + drift-gate: this exporter is now ALSO the source for a CHECKED-IN
 * `packages/spec/spec.schema.json` artifact, kept fresh by the structural CI gate `gate:spec-schema`
 * (`scripts/check-spec-schema.mjs` — re-derives the schema, serializes it through one shared helper, and
 * byte-compares to the committed file; regenerate with `--write`). The gate only checks FRESHNESS — this
 * function stays the single source of truth. Generated handler TYPES remain deferred.
 */
import { z } from 'zod';
import { RaySpec } from './grammar.js';
import { ProductSpec } from './product-grammar.js';

/**
 * Export the `RaySpec` grammar as a JSON-Schema (draft-2020-12) object. Every STRICT grammar
 * object level carries `additionalProperties:false` (the fail-closed shape an Ajv2020 instance
 * enforces byte-for-byte); the three embedded JSON-Schema slots (tool `parameters`/`outputSchema`,
 * agent `outputSchema.schema`) are intentionally OPEN records.
 *
 * `io: 'input'` is LOAD-BEARING: `z.toJSONSchema` defaults to `io: 'output'`, which marks every
 * `.default()`ed field REQUIRED — making the exported artifact REJECT a default-omitting minimal
 * spec (`{version, metadata}`) that `parseSpec` ACCEPTS (the parser fills the defaults). `io:'input'`
 * exports the PRE-default INPUT shape, so the artifact validates exactly what an author may WRITE —
 * matching the parser's accept set (the round-trip contract test drives a default-omitting object
 * through the artifact to lock this).
 *
 * `unrepresentable` defaults to `'throw'`; the grammar uses only representable types
 * (string/literal/enum/array/record/object/boolean/number/discriminatedUnion), all verified to
 * export, so this never throws for the current grammar.
 */
export function exportJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(RaySpec, {
    target: 'draft-2020-12',
    io: 'input',
  }) as Record<string, unknown>;
}

/**
 * Export the `ProductSpec` (Product-YAML) grammar as a JSON-Schema (draft-2020-12) — the SAME
 * `io:'input'` discipline as `exportJsonSchema` (so a default-omitting minimal product doc validates
 * against the artifact exactly as `parseProductSpec` accepts it). The Product-YAML `contracts` slot is
 * an intentionally OPEN record (its closed vocabulary is enforced by product-lint, not this artifact),
 * mirroring how the RaySpec artifact leaves a tool's `parameters` open. This artifact is kept
 * fresh by the `gate:spec-schema` drift gate alongside `spec.schema.json` (`packages/spec/product.schema.json`).
 */
export function exportProductJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ProductSpec, {
    target: 'draft-2020-12',
    io: 'input',
  }) as Record<string, unknown>;
}

/**
 * Export the ONE canonical schema for the `version:'1.0'` document. A
 * `version:'1.0'` doc is one of two PROFILES, discriminated by the presence of the `product:` section:
 * the BACKEND profile (`RaySpec` — the low-level surface AND the internal engine target) or the
 * PRODUCT profile (`ProductSpec` — the high-level product-meaning surface). This is a hand-composed
 * `oneOf` over the two existing profile schemas (a `oneOf` with a `product` required/forbidden
 * discriminant is clearer + diff-reviewable than `z.toJSONSchema` over a top-level union of two strict
 * objects). It is UNAMBIGUOUS by construction: the backend arm keeps `additionalProperties:false`, so a
 * `product`-carrying doc CANNOT match it, and the product arm REQUIRES `product` — so exactly one arm
 * matches. Both arms stay draft-2020-12 + `io:'input'` (defaults-applied-on-parse) and fail-closed
 * (every strict level keeps `additionalProperties:false`). The dialect `$schema` declaration lives ONLY
 * at the unified root; the inner profile `$schema` keys are stripped so the artifact is one well-formed
 * 2020-12 document. Kept fresh by `gate:spec-schema` alongside the two profile views.
 *
 * `$defs` HOISTING (the BLOCKER fix): `z.toJSONSchema` factors a reused sub-schema into a ROOT-scoped
 * `$defs.__schemaN` with document-root-relative `"$ref": "#/$defs/__schemaN"` pointers (the product
 * profile emits one such def today; the backend profile emits none). A JSON-Pointer `$ref` is ALWAYS
 * resolved from the DOCUMENT ROOT (`#`), NOT from the `oneOf[n]` object it sits under — so leaving a
 * profile's `$defs` NESTED under an arm leaves its refs dangling (Ajv2020 raises `can't resolve
 * reference #/$defs/__schema0 from id #`). This exporter therefore HOISTS every arm's `$defs` up to the
 * unified ROOT (deleting it from the arm), so the inner `#/$defs/...` refs resolve against the
 * now-present root `$defs`. A cross-arm `$defs` key collision throws (fail loud, never silently clobber).
 * The `packages/spec/src/export.test.ts` Ajv2020 compile test is the forcing-function that keeps this
 * honest (a regression to nested `$defs` turns it red with a MissingRefError).
 */
/**
 * Walk an exported JSON-Schema and return the JSON Pointers of every OBJECT NODE THAT DECLARES
 * `properties` WITHOUT closing itself (`additionalProperties: false`) — i.e. every place a grammar
 * object lost its `.strict()`. The walk is SCHEMA-AWARE, not a blind object recursion: it descends
 * only through the keyword positions that hold sub-schemas (`properties` values,
 * `additionalProperties`, `patternProperties` values, `items`, `prefixItems`, `oneOf`/`anyOf`/
 * `allOf` arms, `$defs` values), so a property that happens to be NAMED `properties` can never make
 * its parent's property MAP look like a schema node.
 *
 * Deliberately-open shapes stay legal by construction: a `z.record(...)` exports with NO
 * `properties` member (only `propertyNames` + an object-valued `additionalProperties`), so it is
 * not an object-with-declared-properties and is never flagged. What IS flagged: a plain
 * `z.object()` (no `additionalProperties` at all) and a `z.looseObject()` (object-valued
 * `additionalProperties` BESIDE declared properties) — both are unknown-key acceptance at a level
 * that declares a closed vocabulary, which is exactly the fail-closed regression the spec-schema
 * gate exists to catch (asserted per NESTED object, not only at the document root).
 */
export function findOpenObjectNodes(schema: Record<string, unknown>): string[] {
  const open: string[] = [];
  const escapePointer = (segment: string): string =>
    segment.replaceAll('~', '~0').replaceAll('/', '~1');
  const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  const walk = (node: unknown, pointer: string): void => {
    if (!isPlainObject(node)) return;
    const properties = node.properties;
    if (isPlainObject(properties)) {
      if (node.additionalProperties !== false) open.push(pointer === '' ? '/' : pointer);
      for (const [key, child] of Object.entries(properties)) {
        walk(child, `${pointer}/properties/${escapePointer(key)}`);
      }
    }
    if (isPlainObject(node.additionalProperties)) {
      walk(node.additionalProperties, `${pointer}/additionalProperties`);
    }
    if (isPlainObject(node.patternProperties)) {
      for (const [key, child] of Object.entries(node.patternProperties)) {
        walk(child, `${pointer}/patternProperties/${escapePointer(key)}`);
      }
    }
    walk(node.items, `${pointer}/items`);
    if (Array.isArray(node.prefixItems)) {
      for (const [index, child] of node.prefixItems.entries()) {
        walk(child, `${pointer}/prefixItems/${index}`);
      }
    }
    for (const keyword of ['oneOf', 'anyOf', 'allOf'] as const) {
      const arms = node[keyword];
      if (Array.isArray(arms)) {
        for (const [index, child] of arms.entries()) {
          walk(child, `${pointer}/${keyword}/${index}`);
        }
      }
    }
    if (isPlainObject(node.$defs)) {
      for (const [key, child] of Object.entries(node.$defs)) {
        walk(child, `${pointer}/$defs/${escapePointer(key)}`);
      }
    }
  };

  walk(schema, '');
  return open;
}

export function exportUnifiedJsonSchema(): Record<string, unknown> {
  const strip$schema = (s: Record<string, unknown>): Record<string, unknown> => {
    const { $schema: _dialect, ...rest } = s;
    return rest;
  };
  // The two profile arms, each stripped of its inner dialect `$schema` (the unified root carries it).
  const arms = [strip$schema(exportJsonSchema()), strip$schema(exportProductJsonSchema())];

  // Hoist each arm's ROOT-scoped `$defs` up to the unified root, deleting it from the arm (see the
  // `$defs` HOISTING note above). A JSON-Pointer `$ref` resolves from the DOCUMENT ROOT, NOT the
  // `oneOf[n]` object it sits under, so a profile's `#/$defs/...` refs would DANGLE if its `$defs`
  // stayed nested. Merge under one root `$defs`; a cross-arm key collision throws (fail loud).
  const rootDefs: Record<string, unknown> = {};
  for (const arm of arms) {
    const armDefs = (arm as { $defs?: Record<string, unknown> }).$defs;
    if (!armDefs) continue;
    for (const [key, def] of Object.entries(armDefs)) {
      if (key in rootDefs) {
        throw new Error(
          `exportUnifiedJsonSchema: $defs key collision '${key}' across the backend/product profiles — ` +
            'namespace the arm defs before hoisting (both arms cannot share a root-scoped def name).',
        );
      }
      rootDefs[key] = def;
    }
    delete (arm as { $defs?: unknown }).$defs;
  }

  const unified: Record<string, unknown> = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'RaySpec spec (version 1.0) — one language, two profiles (backend | product)',
    description:
      "A version:'1.0' document is one of two profiles, discriminated by the presence of the " +
      '`product:` section: the backend profile (low-level RaySpec, the internal engine target) ' +
      'or the product profile (high-level product meaning, lowered to the backend profile at deploy).',
    oneOf: arms,
  };
  // Only emit `$defs` if any arm contributed one (keeps the artifact minimal when no arm factors a def).
  if (Object.keys(rootDefs).length > 0) unified.$defs = rootDefs;
  return unified;
}
