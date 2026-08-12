/**
 * The ONE runtime resolution of a declared response projection (`project` on a store route, or on
 * a store with wholesale route override) to per-column wire names.
 *
 * BOTH read-shape consumers derive from this single map — the row serializer
 * (`store-validation.ts` `serializeRow`) and the OpenAPI row-schema emitter (`emit-openapi.ts`
 * `storeRowSchema`) — so the served wire shape and the documented wire shape CANNOT drift: they
 * are two renderings of one resolution. READ-SIDE ONLY by construction: nothing here touches the
 * request path (body casing, filters, order, operator params all stay author-named).
 *
 * Resolution semantics (the linted contract — @rayspec/spec `checkResponseProjection` is the
 * config-time twin of this membership rule):
 *  - wire name = `rename[col]`, else the camelCase twin under `casing: 'camel'` (the SAME
 *    snake→camel rule the request side accepts — one transform end to end), else the snake name;
 *  - membership: `fields` (when present) is the LAST word — a column is exposed iff its wire name
 *    is allowlisted (so `fields` can re-include an injected column past `omitInjected`, and can
 *    drop `id`); otherwise `omitInjected: true` drops the injected columns EXCEPT the spared `id`.
 *
 * The injected set is derived from the db's single source (`INJECTED_COLUMN_TS_NAMES`, 8 columns)
 * — never hand-copied. A wire-name collision throws fail-closed at RESOLUTION time (registration /
 * doc build, both boot-side): the linter rejects such a document, so this only fires for a
 * code-built spec that bypassed parse/lint — refusing loudly beats serializing a response where
 * one key silently swallows another column.
 */
import type { ResponseProjection, StoreSpec } from '@rayspec/spec';
import { INJECTED_COLUMN_TS_NAMES, snakeToCamel } from './injected-columns-view.js';

/**
 * Resolve a projection to `snake column name → wire field name` over the EXPOSED columns (a column
 * absent from the map is omitted from responses). Returns `undefined` for an absent projection —
 * the callers keep their historical, byte-identical un-projected path (never an identity map, so
 * "no `project` key ⇒ byte-identical behavior" is structural, not incidental).
 */
export function resolveResponseProjection(
  store: StoreSpec,
  project: ResponseProjection | undefined,
): ReadonlyMap<string, string> | undefined {
  if (project === undefined) return undefined;
  const businessNames = new Set(store.columns.map((c) => c.name));
  const wireBySnake = new Map<string, string>();
  const snakeByWire = new Map<string, string>();
  const expose = (snake: string, injected: boolean): void => {
    // OWN-property lookup only: a plain `rename?.[snake]` walks the prototype chain, so a column
    // legally named `constructor` or `__proto__` would resolve to an inherited Object.prototype
    // member and serialize under a garbage wire key (KEEP-IN-SYNC twin: lint's `wireOf`).
    const renamed =
      project.rename !== undefined && Object.hasOwn(project.rename, snake)
        ? project.rename[snake]
        : undefined;
    const wire = renamed ?? (project.casing === 'camel' ? snakeToCamel(snake) : snake);
    if (project.fields !== undefined) {
      // `fields` is the last word on membership (it can re-include past omitInjected).
      if (!project.fields.includes(wire)) return;
    } else if (project.omitInjected === true && injected && snake !== 'id') {
      return;
    }
    const prior = snakeByWire.get(wire);
    if (prior !== undefined) {
      // Lint rejects this document (`projection_collision`); reachable only via a code-built spec
      // that bypassed parse/lint — refuse at boot rather than let one key swallow another column.
      throw new Error(
        `resolveResponseProjection: store '${store.name}' projection maps columns '${prior}' and ` +
          `'${snake}' to the same wire name '${wire}' — post-projection field names must be unique`,
      );
    }
    snakeByWire.set(wire, snake);
    wireBySnake.set(snake, wire);
  };
  // Injected first (the order the OpenAPI row schema documents), then the declared business
  // columns. A business column shadowing an injected name is rejected by lint
  // (`reserved_column_name`); the skip is belt-and-braces for a code-built spec.
  for (const snake of Object.keys(INJECTED_COLUMN_TS_NAMES)) {
    if (businessNames.has(snake)) continue;
    expose(snake, true);
  }
  for (const col of store.columns) expose(col.name, false);
  return wireBySnake;
}
