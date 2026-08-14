/**
 * `resolveResponseProjection` + `serializeRow` — prototype-safety of the `rename` lookup (pure,
 * no DB, no network).
 *
 * A store column may legally be named after an Object.prototype member (`constructor`,
 * `__proto__` — both SafeIdentifier-legal). The rename lookup must be an OWN-property read: a
 * prototype-walking `rename[col]` resolves such a column to the INHERITED member (a function /
 * Object.prototype), which then serializes the column under a garbage wire key
 * (`"function Object() { [native code] }"`) on a spec the doctor passes clean — and the OpenAPI
 * row schema, derived from the SAME resolution, documents the same garbage key. These pins fail
 * on any regression at the resolver (the serializer and `storeRowSchema` both consume it; lint's
 * `wireOf` twin is pinned in @rayspec/spec `response-projection.test.ts`).
 */
import { lintSpec, RaySpec } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import { resolveResponseProjection } from './store-projection.js';
import { serializeRow } from './store-validation.js';

/**
 * Parse + lint a spec whose store carries proto-named columns; throws on any doctor error.
 * `protoColumnType` types the `__proto__` column: `text` (a string value) or `jsonb` (an OBJECT
 * value — the shape that turns a plain-`{}` accumulator's `out['__proto__'] = value` from a silent
 * no-op into a real prototype mutation).
 */
function protoSpec(protoColumnType: 'text' | 'jsonb' = 'text'): RaySpec {
  const spec = RaySpec.parse({
    version: '1.0',
    metadata: { name: 'proto-named-columns' },
    stores: [
      {
        name: 'relics',
        columns: [
          { name: 'wire_name', type: 'text' },
          { name: 'constructor', type: 'text' },
          { name: '__proto__', type: protoColumnType },
        ],
      },
    ],
    api: [
      {
        method: 'GET',
        path: '/relics',
        action: { kind: 'store', store: 'relics', op: 'list' },
        project: { rename: { wire_name: 'wireName' } },
      },
      {
        method: 'POST',
        path: '/relics',
        action: { kind: 'store', store: 'relics', op: 'create' },
        project: { casing: 'camel', rename: { wire_name: 'wireName' } },
      },
    ],
  });
  const lintErrors = lintSpec(spec);
  if (lintErrors.length > 0) throw new Error(`spec lint failed: ${JSON.stringify(lintErrors)}`);
  return spec;
}

// The Drizzle row (camel TS keys — `snakeToCamel('__proto__')` is `_Proto__`, so no literal
// `__proto__` key exists on the raw row object; `constructor:` in a literal is an ordinary key).
const ROW = { id: 'u-1', wireName: 'ada', constructor: 'brunel', _Proto__: 'shelley' };

describe('response projection — columns named after Object.prototype members', () => {
  it('resolves every wire name to an OWN string, never an inherited prototype member', () => {
    const spec = protoSpec();
    const store = spec.stores[0]!;
    for (const route of spec.api) {
      const projection = resolveResponseProjection(store, route.project);
      expect(projection).toBeDefined();
      // The direct regression signal: a prototype-walking lookup maps 'constructor' to the
      // inherited function and '__proto__' to Object.prototype — not strings.
      for (const [snake, wire] of projection!) {
        expect(typeof wire, `wire name of '${snake}' must be a string`).toBe('string');
      }
    }
    const snake = resolveResponseProjection(store, spec.api[0]!.project)!;
    expect(snake.get('wire_name')).toBe('wireName');
    expect(snake.get('constructor')).toBe('constructor');
    expect(snake.get('__proto__')).toBe('__proto__');
    const camel = resolveResponseProjection(store, spec.api[1]!.project)!;
    expect(camel.get('wire_name')).toBe('wireName');
    // The SAME snake→camel transform as everywhere else ('constructor' has no underscore to
    // transform; '__proto__' becomes the Drizzle TS key shape) — never an inherited member.
    expect(camel.get('constructor')).toBe('constructor');
    expect(camel.get('__proto__')).toBe('_Proto__');
  });

  it('serializes the proto-named columns under their own wire names (exact wire bytes)', () => {
    const spec = protoSpec();
    const store = spec.stores[0]!;
    const snakeOut = serializeRow(
      store,
      ROW,
      resolveResponseProjection(store, spec.api[0]!.project),
    );
    // JSON.stringify pins the exact wire bytes (an own `__proto__` key on the null-prototype
    // accumulator serializes like any other key).
    expect(JSON.stringify(snakeOut)).toBe(
      '{"id":"u-1","wireName":"ada","constructor":"brunel","__proto__":"shelley"}',
    );
    expect(Object.hasOwn(snakeOut, '__proto__')).toBe(true);
    expect(Object.hasOwn(snakeOut, 'constructor')).toBe(true);
    const camelOut = serializeRow(
      store,
      ROW,
      resolveResponseProjection(store, spec.api[1]!.project),
    );
    expect(JSON.stringify(camelOut)).toBe(
      '{"id":"u-1","wireName":"ada","constructor":"brunel","_Proto__":"shelley"}',
    );
  });

  it('serializes them on the UN-PROJECTED path too — a route with no `project` (author snake names)', () => {
    const spec = protoSpec();
    const store = spec.stores[0]!;
    // A route that declares no `project` resolves to `undefined`: that is the argument the
    // un-projected path is entered with, so this is the shape every project-less route returns.
    const none = resolveResponseProjection(store, undefined);
    expect(none).toBeUndefined();
    const out = serializeRow(store, ROW, none);
    // Same pin as the projected arm above, under the AUTHOR's snake names: a column named
    // `__proto__` is an ordinary column and must reach the wire, not be swallowed by the
    // accumulator's setter.
    expect(JSON.stringify(out)).toBe(
      '{"id":"u-1","wire_name":"ada","constructor":"brunel","__proto__":"shelley"}',
    );
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect(Object.hasOwn(out, 'constructor')).toBe(true);
  });

  it('an OBJECT value under a `__proto__` column is a property, never the response prototype', () => {
    const spec = protoSpec('jsonb');
    const store = spec.stores[0]!;
    const value = { tampered: true };
    const row = { id: 'u-2', wireName: 'ada', constructor: 'brunel', _Proto__: value };
    const out = serializeRow(store, row, resolveResponseProjection(store, undefined));
    // The jsonb case is the sharp one: `out['__proto__'] = <object>` on an accumulator that still
    // has Object.prototype REPLACES the response object's prototype — the column disappears from
    // the response AND every key of the stored value becomes readable through the response.
    expect(Object.getPrototypeOf(out)).not.toBe(value);
    expect((out as { tampered?: unknown }).tampered).toBeUndefined();
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect(JSON.stringify(out)).toBe(
      '{"id":"u-2","wire_name":"ada","constructor":"brunel","__proto__":{"tampered":true}}',
    );
  });
});
