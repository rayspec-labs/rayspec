/**
 * `parseSpecWithPacks` — the pack-aware entry to the two-phase parse.
 *
 * `parseSpec` (@rayspec/spec) validates a document against the core grammar alone, and refuses every
 * top-level key that grammar does not declare. That stays exactly true. What a deployment WITH packs
 * needs on top is the one thing the spec package cannot do on its own: resolve the document's
 * `extensions[]` — path-jailed, exact-version-pinned — to find out which top-level keys the packs on
 * this deployment own, and hand each such node to the pack that owns it.
 *
 *   PHASE A  `loadSpecDocument` — YAML safe-load, version check, reserved-key scan (the stages
 *            `parseSpec` runs first, shared verbatim, so the two entries cannot drift).
 *   THE LOAD `readExtensionRefs` reads the refs off the loaded document (already through the
 *            grammar's EXACT version pin, so a range or a floating tag never reaches the loader), and
 *            `loadExtensions` resolves them with the SAME jail and the SAME pin check the merge uses.
 *   PHASE B  `parseSpecSections` lifts each CLAIMED key out of the document, parses the remainder
 *            with the unchanged core grammar — an unclaimed key is still `unknown_field` — and hands
 *            each lifted node to the claiming pack's validator.
 *
 * THE PACK THAT IS NOT THERE. A pack owns the grammar of every section it claims, so the same
 * document taken to a deployment that does not have the pack cannot be validated at all. That fails
 * here, at parse, as a TYPED `extension_pack_unavailable` naming the pack — not as an `unknown_field`
 * pointing at the section, which would send the operator to delete the section rather than to install
 * the pack. It is fail-closed regardless of whether the document declares a section: a referenced
 * pack that cannot be resolved is exactly as unusable either way.
 *
 * A document that references NO pack never reaches the loader: it is parsed by phase A + phase B with
 * an empty claim list, which is `parseSpec` (measured over a corpus in the spec package's accept
 * control). No packs ⇒ no import, no jail, no behaviour change.
 */
import {
  loadSpecDocument,
  parseSpecSections,
  type RaySpec,
  type Result,
  readExtensionRefs,
  type SpecError,
  type SpecWithSections,
  specError,
} from '@rayspec/spec';
import {
  ExtensionLoadError,
  type LoadExtensionsContext,
  type LoadedExtensions,
  loadExtensions,
} from './load-extensions.js';

/** A validated document, its pack-owned sections, and the packs that were loaded to validate them. */
export interface SpecWithPacks extends SpecWithSections {
  /** The document the CORE grammar validated (never carries a claimed key). */
  readonly spec: RaySpec;
  /**
   * The packs this document references, already resolved — returned so a caller that also MERGES the
   * pack fragments does not resolve (and import) every pack a second time. Absent when the document
   * references no pack, which is the strict no-op.
   */
  readonly extensions?: LoadedExtensions;
}

/**
 * Parse + validate a raw RaySpec YAML spec, resolving the packs it references so a top-level section
 * a pack claims is validated by that pack. Returns the typed document plus its claimed sections, or
 * the FULL aggregated list of fail-closed violations — never a partially-trusted value.
 */
export async function parseSpecWithPacks(
  rawYamlText: string,
  ctx: LoadExtensionsContext,
): Promise<Result<SpecWithPacks, SpecError>> {
  const loaded = loadSpecDocument(rawYamlText);
  if (!loaded.ok) return loaded;

  const refs = readExtensionRefs(loaded.value);
  if (refs.length === 0) {
    const parsed = parseSpecSections(loaded.value, []);
    return parsed.ok ? { ok: true, value: parsed.value } : parsed;
  }

  let packs: LoadedExtensions;
  try {
    packs = await loadExtensions(refs, ctx);
  } catch (e) {
    if (e instanceof ExtensionLoadError) return { ok: false, errors: [packUnavailable(e, refs)] };
    throw e;
  }

  const parsed = parseSpecSections(loaded.value, packs.sections);
  return parsed.ok ? { ok: true, value: { ...parsed.value, extensions: packs } } : parsed;
}

/**
 * Turn a fail-closed load failure into the typed parse error an operator reads. The pack id comes off
 * the error as a field (not scraped out of its message), which is also what paths the error at the
 * `extensions[]` entry that named the pack.
 */
function packUnavailable(
  e: ExtensionLoadError,
  refs: ReadonlyArray<{ readonly id: string }>,
): SpecError {
  const index = e.packId === undefined ? -1 : refs.findIndex((ref) => ref.id === e.packId);
  const reason = e.message.replace(/^extension '[^']*': /, '');
  const named = e.packId === undefined ? 'an extension pack' : `extension pack '${e.packId}'`;
  return specError(
    'extension_pack_unavailable',
    `${named} is not available on this deployment — a pack owns the grammar of every top-level ` +
      'section it claims, so a document that declares one cannot be validated without it. Deploy ' +
      'the pack, or remove it from extensions[] together with the sections it claims. Load ' +
      `failure: ${reason}`,
    index >= 0 ? `extensions[${index}]` : 'extensions',
  );
}
