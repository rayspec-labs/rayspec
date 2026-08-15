/**
 * The RAW-DOCUMENT key scan — one rule, run on the loaded YAML object before any shape validation:
 * a mapping key literally named `__proto__` is refused, anywhere in the document, on both profiles.
 *
 * WHY IT CANNOT BE A GRAMMAR RULE. No grammar rule can REPORT on this key. `yaml` builds it as a
 * genuine OWN enumerable property (it defines the property rather than assigning it, so the
 * prototype setter is never reached and the loaded object keeps its own prototype), and from there
 * the shape validator takes one of two routes — measured on this grammar, and they differ:
 *   • WHERE THE GRAMMAR READS THE LEVEL — a `.strict()` object, or a `z.record` dock — zod skips the
 *     key BY NAME and raises no issue, so it is simply absent from the parsed document. That is what
 *     cost authors meaning: `api[].project.rename: { __proto__: … }` parsed clean, linted clean and
 *     did NOTHING (the column kept its own name on the wire and in the OpenAPI document while the
 *     author read the document as a rename); a `__proto__` key at the document ROOT, or in
 *     `metadata`, passed the `.strict()` unknown-key rejection that refuses every other unknown key;
 *     every record dock behaved the same way — product `metadata`, a store step's `filter`/`values`,
 *     a view's `fields`/`params`, the `contracts` map itself.
 *   • WHERE THE LEVEL IS A FREE-FORM `z.unknown()` SLOT — a tool's `parameters` JSON Schema, the body
 *     of a `contracts` entry — zod does not inspect it at all, so the key is NOT dropped. It survives
 *     into the parsed document with its value intact and is carried downstream: a contract property
 *     named `__proto__` reaches `components.schemas` in the emitted OpenAPI document. Unreported
 *     there too, which is the point — the grammar has nothing to say about it either way.
 *   • `VIEW_RESERVED_NAMES` (product-views.ts) denies `__proto__` as a declared view name. The
 *     positions it reads from MAPPING KEYS (fields, params, filter/match columns) had already been
 *     emptied of the key by the shape parse, so there that member could not fire for a document
 *     anyone actually wrote. It does fire from a parsed document for a counts BUCKET, which is an
 *     array VALUE and which this scan deliberately leaves alone.
 * One scan over the raw document closes the reportable gap at once, and it is the only place in the
 * pipeline where the key is both still present and inspectable.
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
          `reserved document key '${RESERVED_DOCUMENT_KEY}': no grammar rule can report on this ` +
            'key. Where the grammar reads the level, the shape validator skips the name without ' +
            'raising an issue — the key is dropped and whatever is written under it does nothing. ' +
            'Inside a free-form schema slot (a tool `parameters`, a `contracts` entry) it is not ' +
            'inspected at all and passes through into the parsed document and the API contract ' +
            'emitted from it. Rename the key.',
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
