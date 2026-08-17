/**
 * The claimed-section seam for the read-only commands — shared by `doctor --with-packs`, `plan` and
 * `deploy --dry-run` so the three cannot answer the same document differently.
 *
 * A top-level key an extension pack claims is owned by that pack, not by the core grammar. A command
 * that parses the document WITHOUT resolving the deployment's packs therefore reports the key as
 * `unknown_field` and sends the operator to delete configuration that is in fact correct — which is
 * exactly the report the pack-aware parse exists to avoid. So each of the three runs the SAME loader,
 * from the SAME deployment tree the boot loads packs from, and reports what it found:
 *
 *   THE ROOT   the deployment tree is `dirname(<spec path>)`, or `RAYSPEC_HANDLER_ROOT` when the
 *              deployment sets one — the same resolution `loadServerConfig` makes for the boot, so a
 *              command and the boot it previews can never disagree about where a pack lives.
 *   THE PARSE  `parseSpecWithPacks` (@rayspec/platform) — the ONE pack-aware entry. It resolves
 *              `extensions[]` through the path jail and the exact version pin, hands each claimed
 *              top-level node to the claiming pack's validator, and reports a pack that is missing
 *              (`extension_pack_unavailable`) apart from one that is present and refused
 *              (`extension_pack_refused`). Nothing here re-implements any of it.
 *   THE LINE   ONE neutral line per section the deployment's packs claim, naming the key and the pack
 *              id. It states ownership and nothing else — the document's verdict is the command's own,
 *              reported as errors, and the line never doubles as one.
 *
 * A DOCUMENT THAT NAMES NO PACK NEVER REACHES ANY OF IT. The check is made on the loaded document
 * before the loader module is even imported, so a pack-free deployment loads no `@rayspec/platform`,
 * imports nothing out of its own tree, and gets the parse it always got, error text included. That is
 * what `parseFromDeploymentTree` returning `undefined` means, and every caller reads it that way.
 *
 * THE OTHER PARSE IN THIS FILE, and why it is here rather than in `doctor.ts`. Resolving a pack means
 * IMPORTING it — code out of the deployment tree, executing in-process — so `doctor` resolves none
 * unless it is asked to (`--with-packs`), and `parseWithoutPacks` is what it runs instead. The two
 * live together because they answer the same question about the same document shape and must agree on
 * which documents that question even applies to; they differ in exactly one thing, which is whether a
 * pack is read. What the pack-less one CANNOT do is name the owner of a claimed key, so it neither
 * refuses such a key nor certifies it: it lifts it out unvalidated and says so in one neutral line.
 *
 * THE BOUNDARY, stated: the line is reported for a document that PARSED. A document that did not is
 * answered with its violations, which already name the pack (`extension_pack_*`) or the section the
 * violation is in (`<key>.<field>`) — a claim line beside them would add no fact they do not carry.
 * No further pack-contributed detail is reported by any of the three commands: what a pack configures
 * is the pack's business, and this is a diagnostic, not a second copy of the pack's grammar.
 */
import { dirname, resolve as resolvePath } from 'node:path';
import {
  detectSpecKind,
  isCoreTopLevelKey,
  loadSpecDocument,
  parseSpecSections,
  type RaySpec,
  type SectionClaim,
  type SpecError,
} from '@rayspec/spec';

/** The one-line rendering of a single claim. Neutral: it names the key and its owner, and stops. */
function claimedSectionLine(key: string, packId: string): string {
  return `section '${key}' is claimed by extension pack '${packId}'`;
}

/** A document parsed from its deployment tree, with the sections that deployment's packs claim. */
export interface DeploymentTreeParse {
  /** The validated core document — absent exactly when `errors` is non-empty. */
  readonly spec?: RaySpec;
  /** The fail-closed violation list (empty when the document validated). */
  readonly errors: SpecError[];
  /** ONE neutral line per claimed section; empty when the document did not parse. */
  readonly claimedSections: readonly string[];
  /**
   * ONE neutral line stating what leaving the packs unresolved left unchecked — the `parseWithoutPacks`
   * half's only extra output, and ABSENT from a parse that did resolve them (there is nothing left
   * unresolved to state). It is not a warning: the document is not being called wrong.
   */
  readonly notResolved?: readonly string[];
}

/**
 * The deployment tree a spec's packs are resolved within — `RAYSPEC_HANDLER_ROOT` when the deployment
 * declares one, otherwise the directory the DEPLOYMENT's spec file sits in. Mirrors
 * `loadServerConfig`'s `escapeHatchRoot`, which is what the boot hands the loader, so a command
 * previews the boot's tree rather than a second guess at it.
 */
function deploymentRootFor(deploymentSpecPath: string, env: NodeJS.ProcessEnv): string {
  const declared = env.RAYSPEC_HANDLER_ROOT?.trim();
  return declared ? resolvePath(declared) : dirname(deploymentSpecPath);
}

/**
 * The LOADED document, when it is one a pack could have anything to say about; `undefined` otherwise —
 * a document of the product profile (whose grammar has no `extensions[]`, so it can reference no
 * pack), one that does not load at all, and one that names no pack.
 *
 * Both parses in this file ask this one question, so neither can decide the other's documents are out
 * of scope. WHAT COUNTS AS NAMING A PACK IS READ OFF THE RAW DOCUMENT, not off a validated
 * `extensions[]`: a malformed list is still a document whose keys may be owned elsewhere, and what to
 * report for it is each parse's own business.
 */
function packBearingDocument(specText: string): Record<string, unknown> | undefined {
  // The product profile has no `extensions[]` in its grammar, so it can reference no pack. Checked on
  // the same `product:` discriminant every other dispatch in the CLI uses.
  if (detectSpecKind(specText) === 'product') return undefined;
  const loaded = loadSpecDocument(specText);
  if (!loaded.ok) return undefined;
  const declared = loaded.value.extensions;
  const namesAPack = Array.isArray(declared) ? declared.length > 0 : declared !== undefined;
  return namesAPack ? loaded.value : undefined;
}

/**
 * Parse `specText` with the packs the deployment at `deploymentSpecPath` carries, so a top-level
 * section one of them claims is validated by its owner and reported as owned.
 *
 * THE TREE IS THE DEPLOYMENT'S, NOT THE TEXT'S OWN FILE'S. `deploymentSpecPath` is the path of the
 * document THIS DEPLOYMENT boots — for a document being checked, its own path. `plan --against` hands
 * in the NEW document's path for its baseline as well: a baseline is a prior revision of the same
 * deployment's document supplied as a diff INPUT, so it may sit wherever the operator produced it (a
 * checkout of the previous revision, a scratch copy beside the terminal), while the packs that can
 * validate it are the ones installed on the deployment being planned. Resolving from the baseline
 * file's own directory would answer with the wrong pack set — and would import pack code out of a
 * directory named only as a diff input.
 *
 * Returns `undefined` when the pack-aware parse has nothing to add, and the caller must then keep its
 * OWN unchanged parse: a document of the product profile (whose grammar has no `extensions[]`, so it
 * can reference no pack), one that does not load at all, and one that names no pack.
 *
 * WHAT COUNTS AS NAMING A PACK IS READ OFF THE RAW DOCUMENT, not off a validated `extensions[]`, and
 * the whole decision about a malformed one is left to `parseSpecWithPacks`. It has to be: that entry
 * point deliberately STOPS at an `extensions[]` that does not typecheck and reports the pin error and
 * nothing else, because while the list does not typecheck it is unknowable which top-level keys the
 * packs own — and reporting the section as an unknown field beside a bad pin sends an operator to
 * delete configuration over one character in the line above it. Falling back to `parseSpec` here
 * would report exactly that.
 */
export async function parseFromDeploymentTree(
  deploymentSpecPath: string,
  specText: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DeploymentTreeParse | undefined> {
  if (packBearingDocument(specText) === undefined) return undefined;

  // Only now — a document that references a pack is the only one that pays for the loader's module.
  const { parseSpecWithPacks } = await import('@rayspec/platform');
  const root = deploymentRootFor(deploymentSpecPath, env);
  const parsed = await parseSpecWithPacks(specText, { packsRoot: root, deploymentRoot: root });
  if (!parsed.ok) return { errors: parsed.errors, claimedSections: [] };
  return {
    spec: parsed.value.spec,
    errors: [],
    claimedSections: (parsed.value.extensions?.sections ?? []).map((claim) =>
      claimedSectionLine(claim.key, claim.packId),
    ),
  };
}

/**
 * Parse `specText` WITHOUT resolving the deployment's packs — no pack module is imported, so no code
 * out of the deployment tree runs. Returns `undefined` on exactly the documents
 * `parseFromDeploymentTree` returns `undefined` for, and the caller then keeps its own unchanged parse.
 *
 * WHAT IT DOES WITH A KEY IT CANNOT RESOLVE THE OWNER OF, and why it is neither of the two obvious
 * answers. Refusing it as `unknown_field` is the wrong-remedy report this whole seam exists to remove:
 * a top-level key a pack claims is CORRECT configuration, and the operator would be sent to delete it.
 * Certifying it silently is worse: nothing here read the grammar that governs it. So on a document
 * that declares a pack, every top-level key the core grammar does not own is LIFTED OUT unvalidated —
 * the same posture, and the same `parseSpecSections` lift, `deploy --check-env` already takes for the
 * same reason — and the report states it in one neutral line.
 *
 * WHAT THE LIFT COSTS, STATED RATHER THAN DISCOVERED. Which keys a pack claims is knowable only from a
 * loaded pack, so this cannot lift the claimed ones and refuse the rest: it lifts EVERY non-core
 * top-level key of a pack-bearing document, which includes a MISTYPED one. That is the price of not
 * running pack code, it is paid only on a document that declares a pack, and `--with-packs` buys the
 * fuller check back for a reader who wants it.
 */
export function parseWithoutPacks(specText: string): DeploymentTreeParse | undefined {
  const loaded = packBearingDocument(specText);
  if (loaded === undefined) return undefined;
  const unresolved = Object.keys(loaded).filter((key) => !isCoreTopLevelKey(key));
  const notResolved = [unresolvedLine(declaredPackIds(loaded), unresolved)];
  const parsed = parseSpecSections(loaded, unresolved.map(unresolvedClaim));
  return parsed.ok
    ? { spec: parsed.value.spec, errors: [], claimedSections: [], notResolved }
    : { errors: parsed.errors, claimedSections: [], notResolved };
}

/**
 * The pack ids the document declares, read DEFENSIVELY off the raw list: this parse reports on a
 * document whose `extensions[]` may not typecheck (the core parse below reports that), and an id it
 * cannot read is simply one it does not name.
 */
function declaredPackIds(loaded: Record<string, unknown>): string[] {
  const declared = loaded.extensions;
  if (!Array.isArray(declared)) return [];
  return declared.flatMap((entry) => {
    const id = (entry as { readonly id?: unknown } | null)?.id;
    return typeof id === 'string' ? [id] : [];
  });
}

/**
 * A claim for a key this parse cannot resolve the owner of. Its validator ACCEPTS the node unexamined,
 * which is the truthful posture: the grammar for that section belongs to a pack, no pack was loaded,
 * and inventing a verdict either way would be worse than saying so — which the report does.
 */
function unresolvedClaim(key: string): SectionClaim {
  return {
    key,
    packId: 'unresolved (no pack was loaded)',
    validate: (node: unknown) => ({ ok: true, value: node }),
  };
}

/**
 * THE ONE NEUTRAL LINE. It states what was not done and how to have it done, and it stops: a document
 * that leaves its packs unresolved is not a document that is wrong, so this is not a warning. One line
 * whatever the document declares — a per-section list would grow with the document and read as a
 * finding count.
 *
 * It says "nothing about the pack(s) was checked", not "their availability was not checked": an
 * unloaded pack is unchecked in EVERY respect the loader would have judged — that it is installed here,
 * and that the loader would accept it at all (an entry module that is on disk and does not load — an
 * unbuilt pack, or one missing the dependencies its entry imports — a version pin that does not match
 * its manifest, two packs claiming one top-level key, a `module:` that escapes the deployment tree).
 * Naming only availability would read as an enumeration and leave a reader believing a reference the
 * loader would REFUSE was still held against the jail here. It was not.
 */
function unresolvedLine(packIds: readonly string[], unresolved: readonly string[]): string {
  const named = packIds.length === 0 ? '' : ` (${packIds.join(', ')})`;
  const lifted =
    unresolved.length === 0
      ? ''
      : ` — [${unresolved.join(', ')}] accepted unexamined rather than refused`;
  return (
    'no extension pack was loaded, so nothing about the pack(s) this document ' +
    `declares${named} was checked: neither that they are installed here, nor that the loader would ` +
    `accept them, nor the grammar of any top-level section they claim${lifted}. ` +
    'Run `doctor --with-packs` to load them — it imports the entry module of each from this ' +
    'deployment tree.'
  );
}

/**
 * Weave the claimed-section lines onto a command's result envelope. PURELY ADDITIVE: an empty list
 * returns the envelope UNTOUCHED, so a pack-free document's output keeps its exact key set — the same
 * discipline `plan` already applies to its document advisories.
 */
export function withClaimedSections<T extends object>(
  result: T,
  claimedSections: readonly string[],
): T {
  return claimedSections.length === 0 ? result : { ...result, claimedSections };
}
