/**
 * DECLARATION-DRIVEN grounded-artifact materialization (
 *
 * This module is the product-free replacement for the earlier product-specific persist +
 * grounding PIPELINE SHAPE: everything it does is driven by the Product-YAML declarations —
 * the `artifacts[]` section (kind, contract, collection, provenance.evidence_field,
 * provenance.required, lifecycle), the `grounding` policy (`on_invalid_citation: prune`,
 * `on_empty_evidence: drop`, the closed span-set contract), and the product `contracts`. NO product
 * name, artifact kind, field name, or prompt appears here.
 *
 * ── Member derivation (how a candidate document yields per-kind artifacts) ──────────────────────
 * For each declared artifact kind K with contract C, against the candidate document (the agent
 * output constrained by `required_output_shape.schema_ref`):
 *   1. ARRAY:      if the candidate's contract declares an array property P with `items.ref == C`,
 *                  every element of `candidate[P]` is one K member (the decisions/action_items/… case).
 *   2. PROJECTION: else, if the artifact declares `provenance.required: false` (an evidence-exempt,
 *                  document-level artifact — the summary case), ONE member is PROJECTED from the
 *                  candidate's top level through C's declared property names.
 *   3. otherwise the kind is NOT derivable from the declarations — fail-closed error (never a
 *                  silent skip).
 *
 * ── The evidence gate (the declared grounding policy, executed) ────────────────────────────────
 * Per member, the declared `provenance.evidence_field` is validated against the CLOSED span-id set
 * with the Tier-B mechanical checker (`closedReferenceGroundingChecker` — the reviewed
 * grounding-runtime primitive):
 *   - `on_invalid_citation: prune` → out-of-set citations are REMOVED (the member keeps only valid
 *     spans); a non-string citation entry is treated as invalid (untrusted model output).
 *   - `on_empty_evidence: drop`    → an evidence-REQUIRED member whose evidence is empty after the
 *     prune is DROPPED (a fully-ungrounded claim never persists). An evidence-exempt member
 *     (`provenance.required: false`) is never dropped.
 * After the gate, ZERO out-of-set citation survives in a persisted payload, and every surviving
 * evidence-required member cites ≥1 valid span — a hard guarantee, declaration-driven.
 * (Some NESTED-evidence semantics — commitment/owner/answer evidence pruning, decided-status
 * demotion, owner/entity verbatim validation — are NOT reproduced here; they are undeclarable in the
 * current grammar.)
 *
 * ── The collection ROW CONTRACT (Tier-A storage shape) ─────────────────────────────────────────
 * A persisted member becomes one row in the artifact collection's bound store, with the CANONICAL
 * column set (compose fail-closed-verifies the bound store declares them):
 *   `<scope>_id` (the scope column, from `artifacts[].scope`) · `artifact_kind` · `payload` (jsonb:
 *   the member payload + an `evidence_span_ids` duplicate of the pruned evidence) · `human_edited` ·
 *   `dismissed` · `artifact_ref` (the tenant-namespaced upsert key
 *   `${tenantId}:${scopeId}:${kind}:${seq}`, per-kind sequence — the established reconciliation key).
 * Lifecycle, executed as declared: `preserve_human_edits` → a human-edited row is never overwritten
 * (pre-read + skip); `reconcile_stale_rows` → non-human-edited rows of a re-extract that no longer
 * produces them are deleted, over the DECLARED reconcile scope (`declaredReconcileScope` — the
 * spec's reconcile-enabled kinds + their bound stores, independent of what the current extraction
 * produced, so a whole-kind removal still reconciles). Both run through the tenant-bound
 * `HandlerDb` facade (the structural tenant predicate underneath).
 */
import { closedReferenceGroundingChecker } from '@rayspec/grounding-runtime';
import type { HandlerDb, StoreRow } from '@rayspec/handler-sdk';
import type { ArtifactSpec, ProductSpec } from '@rayspec/spec';

/** A fail-closed materialization defect (a declaration the candidate cannot satisfy). */
export class MaterializeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaterializeError';
  }
}

/** One derived member of a declared artifact kind (payload + its declared evidence). */
export interface ResolvedMember {
  readonly payload: Record<string, unknown>;
  /** The pruned (post-gate) evidence span ids — [] for an evidence-exempt member. */
  readonly evidence: readonly string[];
}

/** All derived members of one declared artifact kind. */
export interface ResolvedKindMembers {
  readonly artifact: ArtifactSpec;
  readonly derivation: 'array' | 'projection';
  /** The candidate-contract array property the members came from (derivation 'array'). */
  readonly arrayProperty?: string;
  readonly members: readonly ResolvedMember[];
}

/** The executed-policy outcome over one candidate document. */
export interface GroundingApplication {
  /** The candidate document with pruned/dropped array members written back (projection untouched). */
  readonly groundedDoc: Record<string, unknown>;
  readonly kinds: readonly ResolvedKindMembers[];
  /** Citations removed by the prune (out-of-set or non-string). */
  readonly prunedCitations: number;
  /** Evidence-required members dropped for empty post-prune evidence. */
  readonly droppedMembers: number;
  /**
   * Members whose declared `quote_field` value was not a verbatim token-run subset of any cited span
   * (the `unsupported_claim` finding fired) — advisory under `on_unquoted_claim: ignore`, enforced
   * under prune/drop/fail. Zero unless a product declares a quote_field (default-off).
   */
  readonly unsupportedClaims: number;
}

interface RawMember {
  payload: Record<string, unknown>;
  rawEvidence: readonly unknown[];
  evidenceField: string | undefined;
  evidenceRequired: boolean;
}

function contractOf(spec: ProductSpec, ref: string, forWhat: string): Record<string, unknown> {
  const contract = spec.contracts[ref];
  if (!contract) {
    throw new MaterializeError(
      `${forWhat}: contract '${ref}' is not declared in contracts{} — cannot derive members.`,
    );
  }
  return contract;
}

/** Find the candidate contract's array property whose `items.ref` names `contractRef`. */
function arrayPropertyFor(
  candidateContract: Record<string, unknown>,
  contractRef: string,
): string | undefined {
  const props = candidateContract.properties;
  if (props === null || typeof props !== 'object') return undefined;
  for (const [name, schema] of Object.entries(props as Record<string, unknown>)) {
    if (schema === null || typeof schema !== 'object') continue;
    const items = (schema as Record<string, unknown>).items;
    if (items === null || typeof items !== 'object') continue;
    if ((items as Record<string, unknown>).ref === contractRef) return name;
  }
  return undefined;
}

function rawMembersFor(
  spec: ProductSpec,
  artifact: ArtifactSpec,
  candidate: Record<string, unknown>,
  candidateContract: Record<string, unknown>,
): { derivation: 'array' | 'projection'; arrayProperty?: string; members: RawMember[] } {
  const evidenceField = artifact.provenance?.evidence_field;
  const evidenceRequired = artifact.provenance?.required !== false;

  const arrayProperty = arrayPropertyFor(candidateContract, artifact.contract);
  if (arrayProperty !== undefined) {
    const raw = candidate[arrayProperty];
    const list = Array.isArray(raw) ? raw : [];
    const members: RawMember[] = list.map((element, i) => {
      if (element === null || typeof element !== 'object' || Array.isArray(element)) {
        throw new MaterializeError(
          `artifact kind '${artifact.kind}': candidate['${arrayProperty}'][${i}] is not an object — ` +
            'the candidate does not satisfy its declared contract.',
        );
      }
      const payload = element as Record<string, unknown>;
      const rawEvidence =
        evidenceField && Array.isArray(payload[evidenceField])
          ? (payload[evidenceField] as unknown[])
          : [];
      return { payload, rawEvidence, evidenceField, evidenceRequired };
    });
    return { derivation: 'array', arrayProperty, members };
  }

  if (artifact.provenance?.required === false) {
    // PROJECTION singleton: pick the artifact contract's declared property names from the candidate
    // top level (the document-level summary case). Absent properties are simply not projected.
    const targetContract = contractOf(
      spec,
      artifact.contract,
      `artifact kind '${artifact.kind}' (projection)`,
    );
    const props = targetContract.properties;
    const names =
      props !== null && typeof props === 'object'
        ? Object.keys(props as Record<string, unknown>)
        : [];
    const payload: Record<string, unknown> = {};
    for (const name of names) {
      if (name in candidate) payload[name] = candidate[name];
    }
    return {
      derivation: 'projection',
      members: [{ payload, rawEvidence: [], evidenceField, evidenceRequired: false }],
    };
  }

  throw new MaterializeError(
    `artifact kind '${artifact.kind}' (contract '${artifact.contract}') is not derivable from the ` +
      'candidate document: the candidate contract declares no array property with items.ref == the ' +
      'artifact contract, and the artifact is not an evidence-exempt projection (provenance.required: ' +
      'false). Declare one of the two derivations — a kind that cannot be derived never persists silently.',
  );
}

/**
 * Execute the DECLARED grounding policy over a candidate document: derive every declared kind's
 * members, prune out-of-set citations (`on_invalid_citation: prune`), drop evidence-required members
 * with empty post-prune evidence (`on_empty_evidence: drop`), verify any declared verbatim quote
 * (`provenance.quote_field` + `on_unquoted_claim`), and rebuild the grounded document. `closedSpans`
 * is the closed source-span set (the `grounding.source_span_contract` artifact) as an id→text map: the
 * KEYS are the closed citation set (as before) and the VALUES carry each span's text for quote-text
 * verification. When no artifact declares a quote_field the text is never read (default-off).
 */
export function applyGroundingPolicy(
  spec: ProductSpec,
  candidate: Record<string, unknown>,
  candidateSchemaRef: string,
  closedSpans: ReadonlyMap<string, string>,
): GroundingApplication {
  const grounding = spec.grounding;
  if (grounding?.on_invalid_citation !== 'prune' || grounding.on_empty_evidence !== 'drop') {
    // compose() front-stops this; kept fail-closed so a direct caller cannot run an undeclared policy.
    throw new MaterializeError(
      'grounding policy must be declared with on_invalid_citation: prune + on_empty_evidence: drop ' +
        '(the only executed policy values).',
    );
  }
  const candidateContract = contractOf(spec, candidateSchemaRef, 'candidate document');
  const closed = [...closedSpans.keys()];
  // The declared unsupported-quote policy — DEFAULT 'ignore' (advisory) so a product that declares a
  // quote_field but not on_unquoted_claim gets the check as an advisory finding only.
  const onUnquotedClaim = grounding.on_unquoted_claim ?? 'ignore';
  // Span {id,text}[] carrier for the checker — built ONCE, passed only when a quote is being checked.
  const spanTextCarrier = [...closedSpans].map(([id, text]) => ({ id, text }));

  let prunedCitations = 0;
  let droppedMembers = 0;
  let unsupportedClaims = 0;
  const kinds: ResolvedKindMembers[] = [];

  for (const artifact of spec.artifacts) {
    if (artifact.lifecycle?.persist === false) continue; // declared non-persisting kind
    const quoteField = artifact.provenance?.quote_field; // opt-in quote-text verification (default off)
    const { derivation, arrayProperty, members } = rawMembersFor(
      spec,
      artifact,
      candidate,
      candidateContract,
    );

    const kept: ResolvedMember[] = [];
    for (const member of members) {
      const stringEvidence = member.rawEvidence.filter((e): e is string => typeof e === 'string');
      prunedCitations += member.rawEvidence.length - stringEvidence.length; // non-string = invalid
      // A verbatim quote to verify iff this artifact declares a quote_field AND the member carries a
      // non-blank string value for it. When a quote_field IS declared but the member carries no such
      // value (absent, non-string, empty, or WHITESPACE-ONLY), the member is itself an UNQUOTED CLAIM:
      // a blank quote has no word tokens to verify against a span (the checker would classify it
      // unsupported anyway), so it takes the on_unquoted_claim consequence directly via the precise
      // "absent/blank" classification below — never a silent pass, and never the misleading
      // "not a verbatim subset" wording that only fits a genuinely-present-but-unmatched quote.
      const rawQuote = quoteField ? member.payload[quoteField] : undefined;
      const quote =
        typeof rawQuote === 'string' && rawQuote.trim().length > 0 ? rawQuote : undefined;
      const missingQuote = quoteField !== undefined && quote === undefined;
      // The Tier-B mechanical checker: out-of-set citations are reported + separated (never repaired);
      // when a quote is present it ALSO verifies the quote against the cited spans' text (per-span).
      const check = closedReferenceGroundingChecker({
        source_artifact: {
          kind: spec.grounding?.source_span_contract ?? 'source',
          content: quote ? { spans: spanTextCarrier } : null,
        },
        candidate_artifact: { kind: artifact.kind, content: member.payload },
        references: stringEvidence.map((id) => ({ id })),
        closed_reference_ids: closed,
        ...(quote ? { quote } : {}),
      });
      let pruned = check.corrected_references.map((r) => r.id);
      prunedCitations += check.dropped_references.length;

      // The unsupported-quote consequence (`on_unquoted_claim`), same machinery as on_invalid_citation:
      // an unsupported member has NO cited span backing its quote, so 'prune' empties its evidence
      // (then on_empty_evidence: drop bites an evidence-required member), 'drop' removes it outright,
      // 'fail' is terminal, and 'ignore' records the advisory finding but keeps the member.
      if (missingQuote || (quote && check.findings.some((f) => f.code === 'unsupported_claim'))) {
        unsupportedClaims += 1;
        if (onUnquotedClaim === 'fail') {
          throw new MaterializeError(
            `artifact kind '${artifact.kind}': the declared quote_field '${quoteField}' ` +
              (missingQuote
                ? 'is absent, empty, blank, or not a string on a member (on_unquoted_claim: fail).'
                : 'value is not a verbatim token-run subset of any cited source span (on_unquoted_claim: fail).'),
          );
        }
        if (onUnquotedClaim === 'drop') {
          droppedMembers += 1;
          continue;
        }
        if (onUnquotedClaim === 'prune') pruned = []; // no cited span supports the quote → prune all
        // 'ignore' → fall through; the member persists (advisory only).
      }

      if (member.evidenceRequired && pruned.length === 0) {
        droppedMembers += 1; // on_empty_evidence: drop — a fully-ungrounded claim never persists
        continue;
      }
      const payload = member.evidenceField
        ? { ...member.payload, [member.evidenceField]: pruned }
        : member.payload;
      kept.push({ payload, evidence: pruned });
    }

    kinds.push({
      artifact,
      derivation,
      ...(arrayProperty !== undefined ? { arrayProperty } : {}),
      members: kept,
    });
  }

  // Rebuild the grounded document: array-derived kinds write their kept members back; projection
  // kinds read the top level, which the gate never modifies.
  const groundedDoc: Record<string, unknown> = { ...candidate };
  for (const kind of kinds) {
    if (kind.derivation === 'array' && kind.arrayProperty !== undefined) {
      groundedDoc[kind.arrayProperty] = kind.members.map((m) => m.payload);
    }
  }

  return { groundedDoc, kinds, prunedCitations, droppedMembers, unsupportedClaims };
}

/**
 * Re-derive the (already grounded) members from a grounded document — the persist node's view. The
 * evidence gate is idempotent over its own output, so this is `applyGroundingPolicy` with the
 * grounded doc's own citations as the closed set boundary handled upstream; here we only DERIVE.
 */
export function deriveGroundedMembers(
  spec: ProductSpec,
  groundedDoc: Record<string, unknown>,
  candidateSchemaRef: string,
): ResolvedKindMembers[] {
  const candidateContract = contractOf(spec, candidateSchemaRef, 'grounded document');
  const kinds: ResolvedKindMembers[] = [];
  for (const artifact of spec.artifacts) {
    if (artifact.lifecycle?.persist === false) continue;
    const { derivation, arrayProperty, members } = rawMembersFor(
      spec,
      artifact,
      groundedDoc,
      candidateContract,
    );
    kinds.push({
      artifact,
      derivation,
      ...(arrayProperty !== undefined ? { arrayProperty } : {}),
      members: members.map((m) => ({
        payload: m.payload,
        evidence: m.rawEvidence.filter((e): e is string => typeof e === 'string'),
      })),
    });
  }
  return kinds;
}

/** One planned collection row (the canonical row contract) + its per-kind lifecycle flags. */
export interface PlannedCollectionRow {
  readonly store: string;
  readonly row: StoreRow;
  readonly artifactRef: string;
  readonly kind: string;
  readonly preserveHumanEdits: boolean;
}

/**
 * The DECLARED reconcile scope: which artifact kinds carry `lifecycle.reconcile_stale_rows` and
 * which bound stores hold their rows. Derived from the PRODUCT SPEC (never from what one extraction
 * happened to produce) — the reconcile law: a re-extract that yields ZERO members of a reconcile-declared
 * kind must still delete that kind's prior non-human-edited rows. A reconcile set derived from the
 * planned rows would silently drop a whole-kind removal from the reconcile pass (the rows survive and
 * the views keep serving them as grounded).
 */
export interface ReconcileScope {
  /** The reconcile-declared artifact kinds (`lifecycle.reconcile_stale_rows: true`, persisting). */
  readonly kinds: ReadonlySet<string>;
  /** The bound stores holding those kinds' rows (via their declared collections). */
  readonly stores: ReadonlySet<string>;
}

/**
 * Derive the declared reconcile scope from the product spec + the deployment's collection bindings.
 * Fail-closed: a reconcile-declared kind without a collection or without a bound store is a
 * `MaterializeError` (the same law as `buildCollectionRows` — compose front-stops both).
 */
export function declaredReconcileScope(
  spec: ProductSpec,
  collectionStores: ReadonlyMap<string, { readonly store: string }>,
): ReconcileScope {
  const kinds = new Set<string>();
  const stores = new Set<string>();
  for (const artifact of spec.artifacts) {
    if (artifact.lifecycle?.persist === false) continue;
    if (artifact.lifecycle?.reconcile_stale_rows !== true) continue;
    if (!artifact.collection) {
      throw new MaterializeError(
        `artifact kind '${artifact.kind}' declares lifecycle.reconcile_stale_rows but no collection — ` +
          'a reconciling kind must name its collection.',
      );
    }
    const binding = collectionStores.get(artifact.collection);
    if (!binding) {
      throw new MaterializeError(
        `artifact collection '${artifact.collection}' (kind '${artifact.kind}') has no bound store — ` +
          'supply it in the rollout bindings.',
      );
    }
    kinds.add(artifact.kind);
    stores.add(binding.store);
  }
  return { kinds, stores };
}

/**
 * Build the collection rows for the derived members (per-kind `:0,:1,…` sequence, declaration order —
 * stable across a re-extract, the prior reconciliation rule). `collectionStores` maps a declared
 * `artifacts[].collection` to its bound store name (compose validates the binding + columns).
 */
export function buildCollectionRows(
  kinds: readonly ResolvedKindMembers[],
  opts: {
    readonly tenantId: string;
    readonly scopeColumn: string;
    readonly scopeId: string;
    readonly collectionStores: ReadonlyMap<string, { readonly store: string }>;
  },
): PlannedCollectionRow[] {
  const rows: PlannedCollectionRow[] = [];
  for (const kind of kinds) {
    const collection = kind.artifact.collection;
    if (!collection) {
      throw new MaterializeError(
        `artifact kind '${kind.artifact.kind}' declares lifecycle.persist but no collection — ` +
          'a persisted kind must name its collection.',
      );
    }
    const binding = opts.collectionStores.get(collection);
    if (!binding) {
      throw new MaterializeError(
        `artifact collection '${collection}' has no bound store — supply it in the rollout bindings.`,
      );
    }
    kind.members.forEach((member, seq) => {
      const artifactRef = `${opts.tenantId}:${opts.scopeId}:${kind.artifact.kind}:${seq}`;
      rows.push({
        store: binding.store,
        artifactRef,
        kind: kind.artifact.kind,
        preserveHumanEdits: kind.artifact.lifecycle?.preserve_human_edits === true,
        row: {
          [opts.scopeColumn]: opts.scopeId,
          artifact_kind: kind.artifact.kind,
          payload: { ...member.payload, evidence_span_ids: [...member.evidence] },
          human_edited: false,
          // The NEW-row default. A PRIOR row's `dismissed:true` is NOT overwritten by this default:
          // persistCollectionRows pre-reads and SKIPS the upsert for a dismissed row (preserve), so a
          // rebuild/reprocess never resurrects a user-dismissed artifact.
          dismissed: false,
          artifact_ref: artifactRef,
        },
      });
    });
  }
  return rows;
}

export interface CollectionPersistOutcome {
  readonly upserted: number;
  readonly skippedHumanEdited: number;
  /**
   * Rows whose upsert was SKIPPED because a prior row was `dismissed` — the dismissal-preserve law
   * (a user-dismissed artifact is never resurrected by a rebuild/reprocess). Counted like
   * `skippedHumanEdited`; unconditional (independent of the `preserve_human_edits` lifecycle).
   */
  readonly skippedDismissed: number;
  readonly reconciledStale: number;
  readonly countsByKind: Readonly<Record<string, number>>;
}

/**
 * Persist the planned rows through the tenant-bound `HandlerDb` facade, executing the DECLARED
 * lifecycle: `preserve_human_edits` (pre-read + skip — the human edit wins, never overwritten or
 * re-stamped) and `reconcile_stale_rows` (delete this scope's non-human-edited rows of reconciling
 * kinds whose `artifact_ref` a re-extract no longer produces). Upsert is the atomic
 * `INSERT … ON CONFLICT (artifact_ref) DO UPDATE` (the atomic-upsert idiom) keyed by the tenant-namespaced ref.
 *
 * `reconcile` is the DECLARED reconcile scope (`declaredReconcileScope`) — derived from the product
 * spec's reconcile-enabled kinds + their bound stores, NEVER from `planned`: a re-extract
 * that yields zero members of a reconcile-declared kind still deletes that kind's prior
 * non-human-edited rows, and a store whose planned rows all vanished is still scanned.
 */
export async function persistCollectionRows(
  db: HandlerDb,
  planned: readonly PlannedCollectionRow[],
  scope: { readonly column: string; readonly id: string },
  reconcile: ReconcileScope,
): Promise<CollectionPersistOutcome> {
  const keep = new Set(planned.map((p) => p.artifactRef));

  let reconciledStale = 0;
  for (const store of reconcile.stores) {
    const existing = await db.select(store, { [scope.column]: scope.id });
    for (const row of existing) {
      const ref = typeof row.artifact_ref === 'string' ? row.artifact_ref : '';
      const kind = typeof row.artifact_kind === 'string' ? row.artifact_kind : '';
      if (keep.has(ref)) continue;
      if (!reconcile.kinds.has(kind)) continue;
      if (row.human_edited === true) continue; // never delete a human-edited row
      if (row.dismissed === true) continue; // never delete a dismissed row — the user's dismissal
      // survives a rebuild/reprocess exactly like a human edit (spared from stale-row reconciliation).
      await db.delete(store, { artifact_ref: ref });
      reconciledStale += 1;
    }
  }

  let upserted = 0;
  let skippedHumanEdited = 0;
  let skippedDismissed = 0;
  const countsByKind: Record<string, number> = {};
  for (const p of planned) {
    // Pre-read the prior row to enforce the two preserve laws below. The read is UNCONDITIONAL
    // because dismissal-preserve is unconditional (a user-dismissed artifact must never be
    // resurrected by a rebuild, independent of `preserve_human_edits`) — and every collection row
    // carries a `dismissed` column (buildCollectionRows always writes it), so this is always valid.
    const existing = await db.select(p.store, { artifact_ref: p.artifactRef });
    const prior = existing[0];
    if (p.preserveHumanEdits && prior?.human_edited === true) {
      skippedHumanEdited += 1;
      continue; // the human edit wins — never overwritten or re-stamped
    }
    if (prior?.dismissed === true) {
      // The DISMISSAL wins: a dismissed artifact is a user decision (like a human edit) that must
      // survive a reprocess/re-extract — SKIP the upsert so `dismissed` is never re-stamped false
      // (buildCollectionRows sets `dismissed:false` as the NEW-row default; a prior dismissal is
      // preserved HERE, never resurrected). Unconditional — spared regardless of preserve_human_edits.
      skippedDismissed += 1;
      continue;
    }
    await db.upsert(p.store, ['artifact_ref'], p.row);
    upserted += 1;
    countsByKind[p.kind] = (countsByKind[p.kind] ?? 0) + 1;
  }

  return { upserted, skippedHumanEdited, skippedDismissed, reconciledStale, countsByKind };
}

/**
 * Unwrap an upstream artifact VALUE to its content. The agent-runtime node emits artifact values as
 * `{ ref, kind, schema_ref, materialization_target, content }` envelopes; capability nodes emit raw
 * values. A consumer that needs the document takes `.content` when the envelope shape is present.
 */
export function unwrapArtifactValue(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'content' in (value as Record<string, unknown>) &&
    ('schema_ref' in (value as Record<string, unknown>) ||
      'ref' in (value as Record<string, unknown>))
  ) {
    return (value as Record<string, unknown>).content;
  }
  return value;
}
