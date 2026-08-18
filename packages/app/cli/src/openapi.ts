/**
 * `rayspec openapi <spec.yaml>` — emit the OpenAPI 3.1 document for a product-profile document's
 * DECLARED VIEW surface.
 *
 * `emitProductViewsOpenApi` (@rayspec/views-runtime) translates a validated product doc's `views[]` +
 * `contracts` into a pure OpenAPI 3.1 doc (path/query params with closed preset schemas, response
 * contracts as JSON-Schema 2020-12, the producible status set per view). It had ZERO call sites — the
 * vision's "agent-built UI reads a real spec" promise was unwired. This command is its first real
 * surface: a deterministic, machine-parseable client contract for the served read views. READ-ONLY (no
 * DB, no network); NO secret can appear (the only inputs are the operator path + the doc's own views).
 *
 *     { "ok": true,  "openapi": { openapi: "3.1.0", info, paths, components } }   // exit 0
 *     { "ok": false, "errors": [{ code, message, path? }, ...] }                 // exit 1
 *
 * `openapi` is a PRODUCT-PROFILE-only surface: a backend-profile `rayspec.yaml` has no declarative
 * `views` section, so a non-product doc is rejected fail-closed (`unsupported_version`) rather than
 * emitting an empty document that would mislead a client generator.
 */
import { detectSpecKind, parseProductSpec, SPEC_VERSION, type SpecError } from '@rayspec/spec';
import { emitProductViewsOpenApi, type ViewsOpenApiDocument } from '@rayspec/views-runtime';
import { ReadSpecError, readSpecFile, resolveSpecPath } from './read-spec.js';

/**
 * THE POSTURE NOTICE the emitted document carries in `info.description`.
 *
 * This artifact travels further than any other statement of this server's posture: a client
 * generator, an API console or a downstream integrator may hold the OpenAPI document and nothing
 * else — not this repository's README, not SECURITY.md, not the boot banner that says the same
 * thing at runtime (`@rayspec/server` banner.ts `POSTURE_WARNING_LINES`). A description assembled
 * only from `product.description` therefore reached the one audience with no other copy of the
 * warning, and reached it silently.
 *
 * Appended, never substituted: a declared description is the product's own and survives whole
 * (`openapi.test.ts` pins both — the declared text and the notice — and the no-description branch,
 * which is the one that used to emit no `description` key at all).
 *
 * THIS IS THE SECOND COPY of the sentence. The first is
 * `packages/compose/api-auth/src/engine/emit-openapi.ts`, which carries it on the document a running
 * deployment SERVES; that file's note explains why the two are not one export (no DIRECT dependency
 * edge from this package to that one — it is reachable only transitively through `@rayspec/server`,
 * and importing it here is `ERR_MODULE_NOT_FOUND` — plus this module is loaded by every `rayspec`
 * invocation, so its import graph is kept small on purpose).
 *
 * The two are held byte-identical by `openapi.test.ts` here and by `emit-openapi.test.ts` there,
 * both reading the other file off disk. The pin HERE is the load-bearing one for THIS copy: turbo
 * declares no `inputs` for `test`, and api-auth does not depend on this package, so softening the
 * literal below moves `cli#test`'s hash while `api-auth#test` keeps its cached PASS. See the
 * measured hashes in that file's note.
 */
export const OPENAPI_POSTURE_NOTICE =
  'LOCAL / trusted posture / NOT internet-facing — this API is served by a LOCAL, single-node, ' +
  'pre-external-hardening RaySpec deployment. The separate hardening layer (per-tenant sandbox, ' +
  'RLS, KMS-DEK, DPoP) is the gate before any external exposure and is not built yet. Never put ' +
  'this behind a public address.';

/** The `openapi` JSON result. */
export interface OpenapiResult {
  readonly ok: boolean;
  readonly errors?: SpecError[];
  readonly openapi?: ViewsOpenApiDocument;
}

/**
 * Run `openapi` over the positional args: read the spec fail-closed, require a product-profile
 * document, parse+validate it, and emit the view-surface OpenAPI. Never throws for an invalid/unreadable
 * spec — only `ok:false` with the fail-closed error list.
 */
export async function runOpenapi(positionals: readonly string[]): Promise<OpenapiResult> {
  let text: string;
  try {
    const path = resolveSpecPath(positionals);
    text = await readSpecFile(path);
  } catch (e) {
    if (e instanceof ReadSpecError) {
      return { ok: false, errors: [{ code: 'yaml_parse_error', message: e.message }] };
    }
    throw e;
  }

  if (detectSpecKind(text) !== 'product') {
    return {
      ok: false,
      errors: [
        {
          code: 'unsupported_version',
          message:
            'openapi emits the VIEW surface of a product document; this is not a product doc ' +
            '(a backend-profile `rayspec.yaml` has no declarative `views` section). Pass a ' +
            `\`version: "${SPEC_VERSION}"\` document with a \`product:\` section.`,
        },
      ],
    };
  }

  const parsed = parseProductSpec(text);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const spec = parsed.value;

  const openapi = emitProductViewsOpenApi({
    views: spec.views,
    contracts: spec.contracts,
    info: {
      title: `${spec.product.name} — views`,
      version: SPEC_VERSION,
      // The posture notice is UNCONDITIONAL — it is the branch with no declared description that
      // used to emit no description at all, and a consumer holding only this artifact has no other
      // copy of the warning. The declared text, when there is one, comes first and survives whole.
      description: spec.product.description
        ? `${spec.product.description}\n\n${OPENAPI_POSTURE_NOTICE}`
        : OPENAPI_POSTURE_NOTICE,
    },
  });
  return { ok: true, openapi };
}
