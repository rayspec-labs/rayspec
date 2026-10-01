/**
 * The bindings file of the bundle verbs (`deploy <file.ray>`, `import`): JSON in the contract's
 * closed shape `{bindingsFormatVersion: 1, bindings: [{name, value}]}`, each name once. Its content
 * never appears in a message: a refusal names the member, never a value.
 */
import { type BundleError, bundleError, schemaValidator } from '@rayspec/bundle-contract';

/** The largest bindings file: 256 bindings of at most 64 KiB each, with room for the JSON. */
export const MAX_BINDINGS_FILE_BYTES = 17 * 1024 * 1024;

/** The bindings file's values by name, or the refusal (`RAY_USAGE`). */
export function parseBindingsFile(
  bytes: Buffer,
): { ok: true; value: Map<string, string> } | { ok: false; error: BundleError } {
  let document: unknown;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, error: bundleError('RAY_USAGE', 'the bindings file is not valid JSON') };
  }
  const validate = schemaValidator('bindingsFile');
  if (!validate(document)) {
    const at = validate.errors?.[0]?.instancePath ?? '';
    return {
      ok: false,
      error: bundleError(
        'RAY_USAGE',
        'the bindings file is not {bindingsFormatVersion: 1, bindings: [{name, value}]} with names ' +
          `of capital letters, digits and underscores${at === '' ? '' : ` (at ${at})`}`,
        at === '' ? {} : { path: at },
      ),
    };
  }
  const values = new Map<string, string>();
  const bindings = (document as { bindings: { name: string; value: string }[] }).bindings;
  for (const [i, b] of bindings.entries()) {
    if (values.has(b.name)) {
      return {
        ok: false,
        error: bundleError('RAY_USAGE', `the bindings file names ${b.name} twice`, {
          path: `/bindings/${i}/name`,
        }),
      };
    }
    values.set(b.name, b.value);
  }
  return { ok: true, value: values };
}
