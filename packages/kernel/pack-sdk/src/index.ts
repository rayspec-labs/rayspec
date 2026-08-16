/**
 * @rayspec/pack-sdk — the surface an out-of-tree extension pack compiles against.
 *
 * An extension pack ships in its OWN repository: it carries its own stores, handlers, tooling,
 * routes and agents, and a deployment names it by reference. To build, it has to import SOMETHING —
 * manifest types, the error vocabulary, the identifier rule, the journal shapes. Without a promised
 * surface it reaches into whichever internal package happens to export them, which turns every
 * internal refactor into a silent break for every pack and makes "what may a pack rely on" a matter
 * of taste. This package is the answer: it is the ONE surface a pack is allowed to compile against,
 * and it promises nothing else.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * TYPES ONLY — AND WHY THAT IS THE POINT, NOT A LIMITATION.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A pack receives every runtime object it needs by INJECTION at boot: the deployment builds the
 * capabilities and hands them in. It never constructs one, so it never needs to IMPORT one — and a
 * contract that ships no implementation cannot drift from the implementation it describes, cannot
 * pull a transitive dependency into a pack's build, and cannot become a back door into internals
 * through a re-export. The one executable line in this package is `isSafeIdentifier`, because the
 * rule it checks — a pattern bounded by a length — is not expressible as a type.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE TWO AUTHORING SURFACES, DELIBERATELY DISTINCT.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A pack's ENTRY module DECLARES the pack: it default-exports the manifest, which it builds with
 * the platform's manifest helper (the entry is the one module that names the platform). A pack's
 * HANDLER modules RUN with injected capabilities and import only `@rayspec/handler-sdk`, the
 * type-only handler contract — a boundary the repository enforces with its own gate. This package
 * is the DECLARATION-side contract: the shapes a pack author writes down and the vocabulary the
 * deployment answers them with.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * COMPATIBILITY.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The exported surface is reported in `api-report.md`, checked in beside this source, so every
 * change to it is a reviewable diff rather than an accident. What a minor release may change, what
 * forces a major, and what is frozen once a release ships are stated in the package README — read
 * it before adding anything here.
 */
export type { PackError, PackErrorCode } from './errors.js';
export { isSafeIdentifier, MAX_IDENTIFIER_LENGTH, SAFE_IDENTIFIER_RE } from './identifier.js';
export type {
  PackJournalEntry,
  PackJournalStatus,
  PackJournalStepType,
  PackTokenUsage,
} from './journal.js';
export type {
  DefinedPack,
  PackAgentFragment,
  PackApiRouteFragment,
  PackCapabilities,
  PackFragments,
  PackHandlerFragment,
  PackHandlerKind,
  PackHttpMethod,
  PackManifest,
  PackManifestBrand,
  PackMigrationChain,
  PackSectionClaim,
  PackStoreFragment,
  PackToolFragment,
} from './manifest.js';
