/**
 * `parseSpecWithPacks` — the pack-aware entry to the section-aware parse.
 *
 * `parseSpec` (@rayspec/spec) validates a document against the core grammar alone, and refuses every
 * top-level key that grammar does not declare. That stays exactly true. What a deployment WITH packs
 * needs on top is the one thing the spec package cannot do on its own: resolve the document's
 * `extensions[]` — path-jailed, exact-version-pinned — to find out which top-level keys the packs on
 * this deployment own, and hand each such node to the pack that owns it.
 *
 *   THE LOAD    `loadSpecDocument` — YAML safe-load, version check, reserved-key scan (the stages
 *               `parseSpec` runs first, shared verbatim, so the two entries cannot drift).
 *   THE RESOLVE `readExtensionRefs` reads the refs off the loaded document (already through the
 *               grammar's EXACT version pin, so a range or a floating tag never reaches the loader),
 *               and `loadExtensions` resolves them with the SAME jail and the SAME pin check the
 *               merge uses.
 *   THE LIFT    `parseSpecSections` takes each CLAIMED key out of the document, parses the remainder
 *               with the unchanged core grammar — an unclaimed key is still `unknown_field` — and
 *               hands each lifted node to the claiming pack's validator.
 *   THE MERGE   `lintSpec` over the document's sections CONCATENATED with the packs' fragments — the
 *               surface a boot would actually assemble. Every stage above asks about one half; a rule
 *               can be true of each half and false of the sum, and the boot asks this question too
 *               (`mergeExtensions` re-parses the merged document). Asking it here is what keeps a
 *               command that answers pack questions from reporting clean what the boot refuses.
 *
 * TWO WAYS A PACK CAN FAIL, AND THEY PRESCRIBE OPPOSITE ACTIONS. A pack owns the grammar of every
 * section it claims, so a document taken to a deployment that does not have the pack cannot be
 * validated at all. That fails here, at parse, as a TYPED `extension_pack_unavailable` naming the
 * pack — not as an `unknown_field` pointing at the section, which would send the operator to delete
 * the section rather than to install the pack. But a pack that IS here and was REFUSED (an entry that
 * is on disk and did not load — an unbuilt pack is the common one — a version skew, two packs
 * claiming one key, a handler outside `handlers/`) is a different failure with a
 * different remedy, and it is reported under its own code, `extension_pack_refused`. Telling an
 * operator to deploy a pack that is already deployed is worse than telling them nothing, so the
 * loader marks which class a failure is (`ExtensionLoadError.failure`) and this file never guesses.
 * Two codes, THREE classes: the remedy an entry that did not load needs is not the remedy a pack that
 * was read and refused needs, so that class gets its own sentence under the shared code.
 * All are fail-closed regardless of whether the document declares a section: a referenced pack that
 * cannot be used is exactly as unusable either way.
 *
 * A document that references NO pack never reaches the loader: it is parsed by the load + the lift
 * with an empty claim list, which is `parseSpec` (measured over a corpus in the spec package's accept
 * control). No packs ⇒ no import, no jail, no behaviour change.
 */
import {
  lintSpec,
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

  // A malformed `extensions[]` STOPS here. Until the list typechecks, which top-level keys the
  // deployment's packs own is unknowable — so carrying on would refuse a section a referenced pack
  // may well own as an `unknown_field`, which is precisely the report this entry point exists to
  // avoid. The errors are the grammar's own, so the author reads the same sentence either way.
  const refs = readExtensionRefs(loaded.value);
  if (!refs.ok) return refs;
  if (refs.value.length === 0) {
    const parsed = parseSpecSections(loaded.value, []);
    return parsed.ok ? { ok: true, value: parsed.value } : parsed;
  }

  let packs: LoadedExtensions;
  try {
    packs = await loadExtensions(refs.value, ctx);
  } catch (e) {
    if (e instanceof ExtensionLoadError)
      return { ok: false, errors: [packLoadFailure(e, refs.value)] };
    throw e;
  }

  const parsed = parseSpecSections(loaded.value, packs.sections);
  if (!parsed.ok) return parsed;

  // ── The MERGED surface, linted here rather than only at the boot ─────────────────────────────────
  // Every rule above was asked of the deployment's OWN document. A pack contributes stores, handlers,
  // tooling, routes and agents onto that document, and a rule that is true of each half separately can
  // be false of the sum: two routes that are one route to the router, a pack path under a reserved
  // prefix, a pack tool referring to a handler the merge does not carry.
  //
  // The boot already asks this — `mergeExtensions` concatenates the fragments, re-serializes and
  // re-parses, so the merged document goes through the same `lintSpec`. Until this ran here, the boot
  // and the floor disagreed on exactly those findings: the boot refused and `doctor --with-packs`
  // reported the same document clean, which is the shape of defect the floor exists to remove. Linting
  // the merged surface HERE closes the class rather than one rule of it — the next rule added to
  // `lintSpec` is answered by both edges the day it is written.
  //
  // WHY `lintSpec` AND NOT THE BOOT'S FULL RE-PARSE. The fragments were already validated by their
  // owning pack's section schema at load, so the grammar half would re-decide a settled question; and
  // a floor that reported MORE than the boot would send an author to fix a document that deploys. This
  // is the boot's check minus the grammar re-run: never a finding the boot would not also raise.
  //
  // WHAT A MERGED FINDING'S `path` MEANS. It indexes the MERGED section — for a pack-contributed
  // member, an index into an array nobody wrote. The boot has the same limit for the same reason, and
  // the message names the offending route/store by name, which is what an operator acts on.
  const mergedErrors = lintSpec({
    ...parsed.value.spec,
    stores: [...parsed.value.spec.stores, ...packs.stores],
    handlers: [...parsed.value.spec.handlers, ...packs.handlers],
    tooling: [...parsed.value.spec.tooling, ...packs.tooling],
    api: [...parsed.value.spec.api, ...packs.api],
    agents: [...parsed.value.spec.agents, ...packs.agents],
    // `extensions[]` is spent by the merge — the boot drops it for the same reason before re-parsing.
    extensions: [],
  });
  // The base parse SUCCEEDED to reach here, so it reported nothing: every error below is a fact about
  // the merged surface alone, and none of them is a duplicate of one the author has already been told.
  if (mergedErrors.length > 0) return { ok: false, errors: mergedErrors };

  return { ok: true, value: { ...parsed.value, extensions: packs } };
}

/**
 * Turn a fail-closed load failure into the typed parse error an operator reads. The pack id comes off
 * the error as a field (not scraped out of its message), which is also what paths the error at the
 * `extensions[]` entry that named the pack.
 *
 * WHICH CODE is decided by the loader, not guessed here: `pack-absent` is set only where nothing is
 * on disk at the entry the resolution landed on, which is what "the deployment does not have this
 * pack" means. Everything else is a pack this deployment HAS, so the sentence an operator reads says
 * it is here and was refused, and does not send them to deploy something they already deployed.
 *
 * THE REMEDY SENTENCE IS PER CLASS, not per code. A pack that was READ and then refused holds a
 * complete artifact that is wrong, so "deploying it again changes nothing" is exactly true. A pack
 * whose ENTRY DID NOT LOAD holds an artifact that is incomplete — unbuilt, or missing the
 * dependencies its entry imports — and for the second of those, deploying the pack directory again,
 * complete this time, IS the fix. Asserting the refused sentence over that case would trade one wrong
 * remedy for another, so it gets its own: the same artifact lands the same way, and the load failure
 * carried below names which incompleteness it is.
 */
function packLoadFailure(
  e: ExtensionLoadError,
  refs: ReadonlyArray<{ readonly id: string }>,
): SpecError {
  const index = e.packId === undefined ? -1 : refs.findIndex((ref) => ref.id === e.packId);
  const reason = e.message.replace(/^extension '[^']*': /, '');
  const named = e.packId === undefined ? 'an extension pack' : `extension pack '${e.packId}'`;
  const path = index >= 0 ? `extensions[${index}]` : 'extensions';
  if (e.failure === 'pack-absent') {
    return specError(
      'extension_pack_unavailable',
      `${named} is not available on this deployment — a pack owns the grammar of every top-level ` +
        'section it claims, so a document that declares one cannot be validated without it. Deploy ' +
        'the pack, or remove it from extensions[] together with the sections it claims. Load ' +
        `failure: ${reason}`,
      path,
    );
  }
  if (e.failure === 'entry-did-not-load') {
    return specError(
      'extension_pack_refused',
      `${named} is present on this deployment but its ENTRY MODULE DID NOT LOAD, so the top-level ` +
        'sections it claims cannot be validated. The pack is here, so deploying the same artifact ' +
        'again lands the same way: it is either not built (a deploy runtime loads compiled ' +
        'JavaScript only) or it did not arrive with the dependencies its entry imports. The load ' +
        `failure below says which. Load failure: ${reason}`,
      path,
    );
  }
  return specError(
    'extension_pack_refused',
    `${named} is present on this deployment but was REFUSED, so the top-level sections it claims ` +
      'cannot be validated. Deploying it again changes nothing: fix the pack, or the extensions[] ' +
      `entry that references it. Load failure: ${reason}`,
    path,
  );
}
