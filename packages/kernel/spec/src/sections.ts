/**
 * THE SECTION-AWARE PARSE — a top-level spec section whose grammar an extension pack owns.
 *
 * The document's top level is `.strict()`, by design, and this module does not weaken that. What it
 * adds is a way for a key to be OWNED by someone other than the core grammar:
 *
 *   THE LOAD  `loadSpecDocument` (parse.ts) — YAML safe-load, the version check, the reserved-key
 *             scan. Shared verbatim with `parseSpec`; nothing here re-implements it.
 *   THE LIFT  every CLAIMED key the document carries is lifted out of the loaded object, the
 *             REMAINDER is parsed by the unchanged core grammar — so a key no pack claimed still
 *             meets `.strict()` and is refused with the same code, message and path as today — and
 *             each lifted node is handed to the claiming pack's own validator.
 *
 * WHY LIFT ONLY WHAT IS CLAIMED, rather than collect every unknown key and re-admit the claimed ones.
 * Both orders produce the same error LIST (measured: Zod raises a level's `unrecognized_keys` issue
 * after that level's own issues either way), so the reason is not ordering — it is ownership. Lifting
 * only the claimed keys leaves the unclaimed remainder to be refused by the grammar's own
 * `unrecognized_keys` issue, mapped by the ONE mapper that maps it today, so the code, the message
 * and the path of an unknown top-level key have exactly one implementation. Collecting them here
 * would put a second copy of that message in this file, free to drift from the one the pack-free
 * parse emits — and a drift there is invisible until an author reads the wrong sentence.
 *
 * THE DOCUMENT GRAMMARS WIN. A claim on a key a document grammar owns (`stores`, `api`, `product`, …)
 * is refused at pack load, naming the pack. Should such a claim reach here anyway — a claim list
 * built in code rather than resolved from a manifest — the key is NOT lifted and the core grammar
 * parses it. The denylist is `CORE_TOP_LEVEL_KEYS`, read off the grammar objects themselves, so a
 * section added to a document grammar is closed to packs the moment it is declared.
 *
 * THE VALIDATOR IS FOREIGN CODE. A claim's validator is authored and versioned outside this
 * repository, so it is treated like every other pack surface: it is called inside a fail-closed
 * envelope. A validator that throws, or that answers with something that is not a verdict, REFUSES
 * its section — it never escapes as an exception, and it can never leave a section unvalidated in a
 * document the parse then reports as valid.
 */
import { z } from 'zod';
import { type Result, type SpecError, specError } from './errors.js';
import { ExtensionRef, RaySpec } from './grammar.js';
import { lintSpec } from './lint.js';
import { loadSpecDocument, specErrorsFromZodIssues, type ZodIssueLike } from './parse.js';
import { ProductSpec } from './product-grammar.js';

/**
 * The top-level keys a document grammar owns — DERIVED from the grammar objects themselves, never
 * re-listed. A pack may not claim one of these, and a claim that names one is refused at load (see
 * `loadExtensions`).
 *
 * BOTH PROFILES, not just the backend one. `version:'1.0'` is one language with two profiles, told
 * apart by the `product:` discriminant (detect.ts), and `validateAnySpec` routes on exactly that key.
 * A pack allowed to claim `product` would therefore re-classify a backend document as a product
 * document for every caller that detects before it parses — so the denylist is the UNION of the two
 * shapes. It stays derived, so a section added to EITHER grammar closes to packs when it is declared.
 */
export const CORE_TOP_LEVEL_KEYS: readonly string[] = Object.freeze([
  ...new Set([...Object.keys(RaySpec.shape), ...Object.keys(ProductSpec.shape)]),
]);

/** True iff `key` is a top-level key the core document grammar owns. */
export function isCoreTopLevelKey(key: string): boolean {
  return CORE_TOP_LEVEL_KEYS.includes(key);
}

/**
 * Validate ONE claimed section node. Returns the validated value or the full violation list, and
 * never returns a partially-trusted value (the same fail-closed contract `parseSpec` keeps for the
 * document as a whole).
 *
 * It must not throw — and because the implementation behind it is foreign code, that is ENFORCED
 * rather than asked for: `sectionValidatorFrom` wraps the pack's schema module, and `parseSpecSections`
 * wraps the claim, so an implementation that throws anyway refuses its section instead of escaping.
 */
export type SectionValidator = (node: unknown) => Result<unknown, SpecError>;

/** One resolved claim: the key, the pack that owns it, and the validator the pack ships for it. */
export interface SectionClaim {
  /** The claimed top-level key (a safe identifier, checked at load). */
  readonly key: string;
  /** The id of the extension pack that claims the key — every message about the section names it. */
  readonly packId: string;
  /** The pack's validator for the section node. */
  readonly validate: SectionValidator;
}

/**
 * What a pack's schema module must default-export: anything that can `safeParse` a node. STRUCTURAL
 * on purpose — a pack is authored and versioned in its own repository and validates with its own
 * copy of Zod (or with something else entirely), so requiring an instance of THIS package's Zod
 * would make the contract un-satisfiable off-tree.
 */
export interface SectionSchemaLike {
  readonly safeParse: (value: unknown) => {
    readonly success: boolean;
    readonly data?: unknown;
    readonly error?: unknown;
  };
}

/** True iff `value` can validate a section node (the check the pack loader makes fail-closed). */
export function isSectionSchemaLike(value: unknown): value is SectionSchemaLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { safeParse?: unknown }).safeParse === 'function'
  );
}

/** Read a rejected `safeParse` outcome's issue list, keeping only entries this mapper can path. */
function readIssues(error: unknown): ZodIssueLike[] {
  const raw = (error as { issues?: unknown } | null | undefined)?.issues;
  if (!Array.isArray(raw)) return [];
  const issues: ZodIssueLike[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const { path, message, code, keys } = item as {
      path?: unknown;
      message?: unknown;
      code?: unknown;
      keys?: unknown;
    };
    if (!Array.isArray(path) || typeof message !== 'string') continue;
    issues.push({
      path: path as ReadonlyArray<PropertyKey>,
      message,
      ...(typeof code === 'string' ? { code } : {}),
      ...(Array.isArray(keys) ? { keys: keys.map(String) } : {}),
    });
  }
  return issues;
}

/** The one-line fallback when a rejection carries no readable issue list. */
function readMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && message.length > 0
    ? message
    : 'the extension pack refused this section (its validator reported no detail)';
}

/** Name what a validator answered with, for the message that refuses the section because of it. */
function describeVerdict(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object with no `success` field' : `the ${typeof value}`;
}

/**
 * Refuse a section because the code that owns it did not produce a verdict. `what` completes the
 * sentence "its validator …". Reported as `schema_violation` under the section key, so a caller
 * still branches on the closed vocabulary rather than on a special case.
 */
function validatorRefusal(key: string, owner: string, what: string): Result<unknown, SpecError> {
  return {
    ok: false,
    errors: [
      specError(
        'schema_violation',
        `${owner} owns this section, and its validator ${what}. A section whose own validator does ` +
          'not return a verdict is REFUSED: the document is never accepted carrying a section ' +
          'nothing validated (fail-closed).',
        key,
      ),
    ],
  };
}

/**
 * Adapt a pack's schema module into a `SectionValidator`. A rejection is reported UNDER the section
 * key (`acme_notes.retentionDays`) with the SAME codes the core grammar reports: an unknown key
 * inside the section is `unknown_field`, everything else is `schema_violation`. So a section a pack
 * owns reads, in `plan` and `doctor --with-packs` output, exactly like a section the core grammar
 * owns.
 *
 * THE ENVELOPE. `schema` is the default export of a module loaded out of a pack directory: foreign
 * code, admitted on the structural evidence that it has a `safeParse` method and nothing more. Three
 * ways it can fail to answer are therefore handled here rather than left to escape:
 *   • it THROWS (a validator that dereferences a null section body is enough) — the exception would
 *     otherwise leave `parseSpecWithSections`/`parseSpecWithPacks` by throwing, which is the one
 *     thing their contract says they never do;
 *   • it returns something that is NOT a verdict (`undefined`, a string) — reading `.success` off it
 *     would throw a `TypeError` from inside the parse;
 *   • it REJECTS, but the rejection maps to no error at all (an `unrecognized_keys` issue carrying
 *     no `keys`) — an empty error list from a refusal reads as "nothing was wrong", and the section
 *     would be dropped from a document the parse then reports as VALID. The fallback message is the
 *     rejection's own, so the refusal is never silent.
 * Each is a refusal of the section, pathed at the key and naming the pack.
 */
export function sectionValidatorFrom(
  schema: SectionSchemaLike,
  key: string,
  packId?: string,
): SectionValidator {
  const owner = packId === undefined ? 'an extension pack' : `extension pack '${packId}'`;
  return (node: unknown): Result<unknown, SpecError> => {
    try {
      const outcome = schema.safeParse(node) as ReturnType<SectionSchemaLike['safeParse']> | null;
      if (outcome === null || typeof outcome !== 'object' || typeof outcome.success !== 'boolean') {
        return validatorRefusal(key, owner, `returned ${describeVerdict(outcome)}`);
      }
      if (outcome.success) return { ok: true, value: outcome.data };
      const errors = specErrorsFromZodIssues(readIssues(outcome.error), key);
      if (errors.length > 0) return { ok: false, errors };
      return {
        ok: false,
        errors: [specError('schema_violation', readMessage(outcome.error), key)],
      };
    } catch (e) {
      return validatorRefusal(key, owner, `threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}

/** A validated document plus the claimed sections that were lifted out of it and validated. */
export interface SpecWithSections {
  /** The document the CORE grammar validated — it never carries a claimed key. */
  readonly spec: RaySpec;
  /** Each claimed section the document declared, keyed by its key, as its own pack validated it. */
  readonly sections: Readonly<Record<string, unknown>>;
}

/** `extensions[]` read on its own, so the pack refs are known before the strict shape parse runs. */
const ExtensionRefs = z.array(ExtensionRef).default([]);

/**
 * Read the document's `extensions[]` refs — the packs whose section claims have to be resolved
 * before the shape parse can know which top-level keys are owned. Every ref that comes back has
 * already met the grammar's EXACT version pin, so a range or a floating dist-tag never reaches the
 * loader.
 *
 * A malformed `extensions[]` is returned as ERRORS rather than as an empty ref list, and the caller
 * stops there. It has to: while the list does not typecheck, WHICH top-level keys the packs own is
 * unknowable, so continuing would refuse a section a referenced pack may well own as an unknown
 * field — sending an operator to delete the section when the fault is one character in the pin above
 * it. That is the same short-circuit discipline `loadSpecDocument` already applies to the version
 * check: when a stage makes the rest of the document unreadable, the rest of the document is not
 * reported on. The errors are produced by the grammar's OWN `ExtensionRef` through the ONE mapper, so
 * they are byte-identical to what the strict shape parse would have reported for the same entry.
 */
export function readExtensionRefs(
  loaded: Record<string, unknown>,
): Result<readonly ExtensionRef[], SpecError> {
  const parsed = ExtensionRefs.safeParse(loaded.extensions);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, errors: specErrorsFromZodIssues(parsed.error.issues, 'extensions') };
}

/**
 * Run ONE claim's validator inside the fail-closed envelope. `sectionValidatorFrom` already wraps the
 * pack's own schema module; this wraps the CLAIM, which a caller may also have built by hand, so the
 * `SectionValidator` contract ("returns the validated value or the violation list — never throws") is
 * total for every claim rather than only for the ones this module built.
 */
function runClaim(claim: SectionClaim, node: unknown): Result<unknown, SpecError> {
  const owner = `extension pack '${claim.packId}'`;
  let outcome: Result<unknown, SpecError>;
  try {
    outcome = claim.validate(node);
  } catch (e) {
    return validatorRefusal(
      claim.key,
      owner,
      `threw: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (outcome === null || typeof outcome !== 'object' || typeof outcome.ok !== 'boolean') {
    return validatorRefusal(claim.key, owner, `returned ${describeVerdict(outcome)}`);
  }
  if (outcome.ok) return outcome;
  // A REFUSAL MUST COST AT LEAST ONE ERROR. Were an empty list allowed through, the section would be
  // absent from `sections`, nothing would be added to `sectionErrors`, and a document whose owning
  // pack rejected its configuration could still be reported VALID.
  return outcome.errors.length > 0
    ? outcome
    : validatorRefusal(claim.key, owner, 'refused the section but reported no violation');
}

/**
 * The lift over an already-loaded document. `claims` is what the deployment's packs claim; an empty
 * list makes this the unchanged `parseSpec` shape parse + lint over the same object.
 *
 * Aggregates like every other stage: a document that is wrong in the core sections AND in a claimed
 * section reports both in one pass (core first, then the sections, in claim order).
 */
export function parseSpecSections(
  loaded: Record<string, unknown>,
  claims: readonly SectionClaim[],
): Result<SpecWithSections, SpecError> {
  // The keys to lift: claimed, present in the document, and not owned by the core grammar. The
  // first claim on a key wins (the loader refuses a second one, naming both packs).
  const claimedKeys = new Map<string, SectionClaim>();
  for (const claim of claims) {
    if (isCoreTopLevelKey(claim.key)) continue;
    if (!claimedKeys.has(claim.key)) claimedKeys.set(claim.key, claim);
  }
  const lifted: Array<{ claim: SectionClaim; node: unknown }> = [];
  let document = loaded;
  if ([...claimedKeys.keys()].some((key) => Object.hasOwn(loaded, key))) {
    const remainder: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(loaded)) {
      const claim = claimedKeys.get(key);
      if (claim === undefined) remainder[key] = value;
      else lifted.push({ claim, node: value });
    }
    document = remainder;
  }

  // ---- 4. STRICT ZOD PARSE over the REMAINDER (an unclaimed key is refused exactly as today) ----
  const parsed = RaySpec.safeParse(document);

  // ---- 4b. THE CLAIMED SECTIONS, each by its own pack's validator ----
  const sections: Record<string, unknown> = {};
  const sectionErrors: SpecError[] = [];
  for (const { claim, node } of lifted) {
    const outcome = runClaim(claim, node);
    if (outcome.ok) sections[claim.key] = outcome.value;
    else sectionErrors.push(...outcome.errors);
  }

  if (!parsed.success) {
    return {
      ok: false,
      errors: [...specErrorsFromZodIssues(parsed.error.issues), ...sectionErrors],
    };
  }

  // ---- 5. SEMANTIC LINT (needs a typed spec, so only once the shape parse succeeded) ----
  const errors = [...lintSpec(parsed.data), ...sectionErrors];
  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, value: { spec: parsed.data, sections } };
}

/**
 * Parse + validate a raw RaySpec YAML spec whose top level may carry sections the given packs claim.
 * With an EMPTY claim list this is `parseSpec` — same stages, same value, same errors in the same
 * order (measured over a corpus in `sections-accept-control.test.ts`).
 *
 * A caller that has to RESOLVE the claims from the document's own `extensions[]` first wants
 * `parseSpecWithPacks` (`@rayspec/platform`), which owns the loader and its path jail.
 */
export function parseSpecWithSections(
  rawYamlText: string,
  claims: readonly SectionClaim[],
): Result<SpecWithSections, SpecError> {
  const loaded = loadSpecDocument(rawYamlText);
  if (!loaded.ok) return loaded;
  return parseSpecSections(loaded.value, claims);
}
