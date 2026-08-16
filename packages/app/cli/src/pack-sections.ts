/**
 * The claimed-section seam for the read-only commands — shared by `doctor`, `plan` and
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
 * THE BOUNDARY, stated: the line is reported for a document that PARSED. A document that did not is
 * answered with its violations, which already name the pack (`extension_pack_*`) or the section the
 * violation is in (`<key>.<field>`) — a claim line beside them would add no fact they do not carry.
 * No further pack-contributed detail is reported by any of the three commands: what a pack configures
 * is the pack's business, and this is a diagnostic, not a second copy of the pack's grammar.
 */
import { dirname, resolve as resolvePath } from 'node:path';
import { detectSpecKind, loadSpecDocument, type RaySpec, type SpecError } from '@rayspec/spec';

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
}

/**
 * The deployment tree a spec's packs are resolved within — `RAYSPEC_HANDLER_ROOT` when the deployment
 * declares one, otherwise the directory the spec file itself sits in. Mirrors `loadServerConfig`'s
 * `escapeHatchRoot`, which is what the boot hands the loader, so a command previews the boot's tree
 * rather than a second guess at it.
 */
function deploymentRootFor(specPath: string, env: NodeJS.ProcessEnv): string {
  const declared = env.RAYSPEC_HANDLER_ROOT?.trim();
  return declared ? resolvePath(declared) : dirname(specPath);
}

/**
 * Parse `specText` with the packs the deployment at `specPath` carries, so a top-level section one of
 * them claims is validated by its owner and reported as owned.
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
  specPath: string,
  specText: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DeploymentTreeParse | undefined> {
  // The product profile has no `extensions[]` in its grammar, so it can reference no pack. Checked on
  // the same `product:` discriminant every other dispatch in the CLI uses.
  if (detectSpecKind(specText) === 'product') return undefined;
  const loaded = loadSpecDocument(specText);
  if (!loaded.ok) return undefined;
  const declared = loaded.value.extensions;
  const namesAPack = Array.isArray(declared) ? declared.length > 0 : declared !== undefined;
  if (!namesAPack) return undefined;

  // Only now — a document that references a pack is the only one that pays for the loader's module.
  const { parseSpecWithPacks } = await import('@rayspec/platform');
  const root = deploymentRootFor(specPath, env);
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
