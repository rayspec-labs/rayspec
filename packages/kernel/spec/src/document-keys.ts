/**
 * The RAW-DOCUMENT key scan — one rule, run on the loaded YAML object before any shape validation:
 * a mapping key literally named `__proto__` is refused, anywhere in the document, on both profiles.
 *
 * WHY IT CANNOT BE A GRAMMAR RULE. The shape validator never sees this key. `yaml` builds it as a
 * genuine OWN enumerable property (it defines the property rather than assigning it, so the
 * prototype setter is bypassed), and the validator then skips it BY NAME in both readers a spec
 * document goes through — the strict-object unrecognized-key walk and the generic record branch —
 * without raising an issue. The consequences measured on this grammar:
 *   • `api[].project.rename: { __proto__: … }` parsed clean, linted clean, and did NOTHING: the
 *     column kept its own name on the wire and in the OpenAPI document while the author read the
 *     document as a rename;
 *   • a `__proto__` key at the document ROOT, or in `metadata`, passed the `.strict()` unknown-key
 *     rejection that refuses every other unknown key;
 *   • every record dock behaved the same way — product `metadata`, a store step's `filter`/`values`,
 *     a view's `fields`/`params`, `contracts`;
 *   • `VIEW_RESERVED_NAMES` (product-views.ts) denies `__proto__` as a declared view name, but it is
 *     enforced over the POST-validation object, where the key was already gone — so that member of
 *     the denylist could not fire for a document anyone actually wrote.
 * One scan over the raw document closes all of them at once, and it is the only place in the
 * pipeline where the key still exists to be seen.
 *
 * ONLY `__proto__`. `constructor` and `prototype` are ordinary own keys that survive validation
 * intact, so they need no refusal here and keep working (a store column named `constructor` is a
 * legal declaration this platform serves). Refusal, not repair: silently stripping or renaming the
 * key is the same lie the validator's skip already told.
 *
 * VALUES ARE UNTOUCHED. This is about a mapping KEY. A store column declared
 * `{ name: __proto__, type: text }` is a value, stays legal, and is served by name.
 */
import { type SpecError, specError } from './errors.js';

/** The one key name a spec document of either profile may not carry. */
export const RESERVED_DOCUMENT_KEY = '__proto__';

/**
 * Scan a loaded YAML document for own `__proto__` mapping keys and return one `SpecError` per
 * occurrence, pathed at the offending key (`api[0].project.rename.__proto__`). Returns `[]` for a
 * clean document and for any non-object input.
 *
 * The walk is CYCLE-GUARDED (a `WeakSet` of visited nodes) because a YAML alias resolves to the very
 * node its anchor labels: `root: &a\n  child: *a` yields an object graph where `root.child === root`,
 * which an unguarded recursive walk would follow forever.
 */
export function scanReservedDocumentKeys(loaded: unknown): SpecError[] {
  const errors: SpecError[] = [];
  const seen = new WeakSet<object>();

  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const [i, item] of node.entries()) walk(item, `${path}[${i}]`);
      return;
    }

    // A mapping. `Object.hasOwn` is the whole test: an inherited `__proto__` (every plain object has
    // one) is not a declared key, an OWN one is exactly what YAML produces for a written key.
    if (Object.hasOwn(node, RESERVED_DOCUMENT_KEY)) {
      errors.push(
        specError(
          'reserved_document_key',
          `reserved document key '${RESERVED_DOCUMENT_KEY}': the shape validator drops this key by ` +
            'name before any rule can see it, so a document declaring it would validate, deploy and ' +
            'document itself as if the key were absent. Rename the key.',
          path === '' ? RESERVED_DOCUMENT_KEY : `${path}.${RESERVED_DOCUMENT_KEY}`,
        ),
      );
    }
    for (const [key, value] of Object.entries(node)) {
      walk(value, path === '' ? key : `${path}.${key}`);
    }
  };

  walk(loaded, '');
  return errors;
}
