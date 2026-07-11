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
      ...(spec.product.description ? { description: spec.product.description } : {}),
    },
  });
  return { ok: true, openapi };
}
