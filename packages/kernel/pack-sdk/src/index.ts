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
 * HANDLER modules RUN with injected capabilities, and the contract they are written against is
 * declared HERE too (`handler.ts`): the manifest half says where a handler lives and what it is
 * called, and the handler half says what it IS — the value the platform calls it with, and the
 * function it exports. So a pack still imports ONE thing to build both halves — for the shapes this
 * package contracts, which is the `tool` kind and the `route` kind behind a `{kind:'handler'}` api
 * action. What it does NOT contract is named in `handler.ts` with the reason, so a pack author reads
 * a statement rather than discovering an absence. A route's init also carries the two doors that make
 * a route more than a one-shot JSON reply: `PackJournalReader`, the typed, tenant-scoped, bounded way
 * back OUT of the run journal a pack's work is recorded in (`journal.ts`), and `PackSseResponder`,
 * the injected constructor for an INCREMENTAL response — the deployment's own envelope builder, so a
 * pack can stream frames without naming a runtime marker it does not own.
 *
 * A pack's SERVICE modules are the third surface, and they are typed HERE rather than against the
 * handler contract: a service is not called by the platform, it is BOOTED by it, so what it receives
 * is a boot context rather than a per-invocation init — including `TurnDispatch`, the one capability
 * a handler may not even name (see `service.ts`).
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
export type {
  PackHandlerInit,
  PackHandlerPrincipal,
  PackRouteHandler,
  PackRouteHandlerInit,
  PackRouteResponse,
  PackSelectOptions,
  PackSseFrame,
  PackSseProducer,
  PackSseResponder,
  PackStoreDb,
  PackStoreFilter,
  PackStoreRow,
  PackToolHandler,
  PackToolHandlerInit,
  PackUpsertOptions,
} from './handler.js';
export { isSafeIdentifier, MAX_IDENTIFIER_LENGTH, SAFE_IDENTIFIER_RE } from './identifier.js';
export type {
  PackJournalEntry,
  PackJournalPage,
  PackJournalQuery,
  PackJournalReadEntry,
  PackJournalReader,
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
export type {
  PackDatabase,
  PackJournal,
  PackJournalStep,
  PackJournalWriter,
  PackServiceContext,
  PackServiceDeclaration,
  PackServiceModule,
  TurnDispatch,
  TurnDispatchRequest,
  TurnDispatchResult,
} from './service.js';
