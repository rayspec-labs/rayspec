/**
 * The declaration-driven materializer — unit proofs over the REAL parsed fixture (no product-specific concept).
 * Load-bearing behaviors, each asserted fail-the-fix:
 *  - member derivation: array (items.ref match) + projection (evidence-exempt singleton) + the
 *    fail-closed underivable kind;
 *  - the executed grounding policy: prune (out-of-set + non-string citations removed) and drop
 *    (evidence-required member with empty post-prune evidence never persists; exempt member kept);
 *  - the grounded-document rebuild (downstream persist re-derives losslessly);
 *  - the collection row contract (per-kind seq, tenant-namespaced artifact_ref, evidence_span_ids);
 *  - the DECLARED lifecycle, executed: human-edit preservation + stale-row reconciliation.
 */
import { describe, expect, it } from 'vitest';
import {
  applyGroundingPolicy,
  buildCollectionRows,
  declaredReconcileScope,
  deriveGroundedMembers,
  MaterializeError,
  persistCollectionRows,
} from './materialize.js';
import { FakeHandlerDb } from './test-support/fake-handler-db.js';
import { parseFixture } from './test-support/fixture.js';

const TENANT = 'tenant-a';
const SCOPE = { column: 'session_id', id: 's1' };
const COLLECTIONS = new Map([['note_artifacts', { store: 'note_artifacts' }]]);

function candidateDoc() {
  return {
    headline: 'Weekly sync',
    body: 'Notes body.',
    findings: [
      { text: 'fully grounded', evidence: ['sp-1', 'sp-2'] },
      { text: 'partially grounded', evidence: ['sp-1', 'sp-GHOST'] },
      { text: 'fully ungrounded', evidence: ['sp-GHOST'] },
      { text: 'no evidence at all', evidence: [] },
      { text: 'non-string citation', evidence: [42 as unknown as string, 'sp-2'] },
    ],
  };
}
// The closed span set is now an id→text map (the values back grounding's opt-in quote-text check).
// These fixtures declare NO quote_field, so the text is never read — behaviour is id-membership only.
const CLOSED = new Map([
  ['sp-1', 'the first source span text'],
  ['sp-2', 'the second source span text'],
]);

describe('applyGroundingPolicy (prune + drop, declaration-driven)', () => {
  const spec = parseFixture();

  it('prunes out-of-set + non-string citations and drops empty-evidence members', () => {
    const app = applyGroundingPolicy(spec, candidateDoc(), 'notetool.notes', CLOSED);
    const findings = app.kinds.find((k) => k.artifact.kind === 'finding');
    expect(findings?.members.map((m) => m.payload.text)).toEqual([
      'fully grounded',
      'partially grounded',
      'non-string citation',
    ]);
    // The prune wrote back ONLY valid spans (zero out-of-set citation survives).
    expect(findings?.members.map((m) => m.evidence)).toEqual([
      ['sp-1', 'sp-2'],
      ['sp-1'],
      ['sp-2'],
    ]);
    for (const m of findings?.members ?? []) {
      expect(m.payload.evidence).toEqual(m.evidence);
    }
    expect(app.droppedMembers).toBe(2); // 'fully ungrounded' + 'no evidence at all'
    expect(app.prunedCitations).toBe(3); // sp-GHOST ×2 + the non-string 42
  });

  it('keeps the evidence-exempt projection member (never dropped) with empty evidence', () => {
    const app = applyGroundingPolicy(spec, candidateDoc(), 'notetool.notes', CLOSED);
    const digest = app.kinds.find((k) => k.artifact.kind === 'digest');
    expect(digest?.derivation).toBe('projection');
    expect(digest?.members).toHaveLength(1);
    // The declared evidence field is written back (pruned-empty) even on the exempt member, so the
    // persisted payload always carries its declared provenance field.
    expect(digest?.members[0]?.payload).toEqual({
      headline: 'Weekly sync',
      body: 'Notes body.',
      evidence_span_ids: [],
    });
    expect(digest?.members[0]?.evidence).toEqual([]);
  });

  it('rebuilds the grounded document so persist re-derives LOSSLESSLY', () => {
    const app = applyGroundingPolicy(spec, candidateDoc(), 'notetool.notes', CLOSED);
    const grounded = app.groundedDoc.findings as Array<{ text: string; evidence: string[] }>;
    expect(grounded.map((f) => f.text)).toEqual([
      'fully grounded',
      'partially grounded',
      'non-string citation',
    ]);
    // Re-derivation from the grounded doc yields the SAME members (the persist node's view).
    const rederived = deriveGroundedMembers(spec, app.groundedDoc, 'notetool.notes');
    const findings = rederived.find((k) => k.artifact.kind === 'finding');
    expect(findings?.members.map((m) => [m.payload.text, m.evidence])).toEqual(
      app.kinds
        .find((k) => k.artifact.kind === 'finding')
        ?.members.map((m) => [m.payload.text, m.evidence]),
    );
  });

  it('fails closed on an underivable declared kind (never a silent skip)', () => {
    const spec2 = parseFixture();
    // Point the 'finding' artifact at a contract the candidate contract has no array for, and make
    // it evidence-required (no projection escape): underivable → MaterializeError.
    const mutated = {
      ...spec2,
      artifacts: spec2.artifacts.map((a) =>
        a.kind === 'finding' ? { ...a, contract: 'notetool.token_response' } : a,
      ),
    };
    expect(() => applyGroundingPolicy(mutated, candidateDoc(), 'notetool.notes', CLOSED)).toThrow(
      MaterializeError,
    );
    expect(() => applyGroundingPolicy(mutated, candidateDoc(), 'notetool.notes', CLOSED)).toThrow(
      /not derivable/,
    );
  });

  it('fails closed when called with an undeclared policy (defense-in-depth behind compose)', () => {
    const spec2 = parseFixture();
    const noPolicy = { ...spec2, grounding: undefined };
    expect(() => applyGroundingPolicy(noPolicy, candidateDoc(), 'notetool.notes', CLOSED)).toThrow(
      /on_invalid_citation: prune/,
    );
  });
});

describe('buildCollectionRows (the canonical row contract)', () => {
  const spec = parseFixture();

  it('builds per-kind sequenced, tenant-namespaced rows with the evidence_span_ids duplicate', () => {
    const app = applyGroundingPolicy(spec, candidateDoc(), 'notetool.notes', CLOSED);
    const rows = buildCollectionRows(app.kinds, {
      tenantId: TENANT,
      scopeColumn: SCOPE.column,
      scopeId: SCOPE.id,
      collectionStores: COLLECTIONS,
    });
    // Declaration order: digest first (declared first), then the findings, per-kind seq :0,:1,…
    expect(rows.map((r) => r.artifactRef)).toEqual([
      'tenant-a:s1:digest:0',
      'tenant-a:s1:finding:0',
      'tenant-a:s1:finding:1',
      'tenant-a:s1:finding:2',
    ]);
    const finding0 = rows[1]?.row;
    expect(finding0).toMatchObject({
      session_id: 's1',
      artifact_kind: 'finding',
      human_edited: false,
      dismissed: false,
      artifact_ref: 'tenant-a:s1:finding:0',
    });
    expect((finding0?.payload as Record<string, unknown>).evidence_span_ids).toEqual([
      'sp-1',
      'sp-2',
    ]);
    expect((rows[0]?.row.payload as Record<string, unknown>).evidence_span_ids).toEqual([]);
  });

  it('fails closed on an unbound collection', () => {
    const app = applyGroundingPolicy(spec, candidateDoc(), 'notetool.notes', CLOSED);
    expect(() =>
      buildCollectionRows(app.kinds, {
        tenantId: TENANT,
        scopeColumn: SCOPE.column,
        scopeId: SCOPE.id,
        collectionStores: new Map(),
      }),
    ).toThrow(/no bound store/);
  });
});

describe('persistCollectionRows (the DECLARED lifecycle, executed)', () => {
  const spec = parseFixture();
  // The DECLARED reconcile scope (MAT-1): derived from the spec, not from a run's planned rows.
  const RECONCILE = declaredReconcileScope(spec, COLLECTIONS);

  function plannedRows(doc = candidateDoc()) {
    const app = applyGroundingPolicy(spec, doc, 'notetool.notes', CLOSED);
    return buildCollectionRows(app.kinds, {
      tenantId: TENANT,
      scopeColumn: SCOPE.column,
      scopeId: SCOPE.id,
      collectionStores: COLLECTIONS,
    });
  }

  it('upserts by artifact_ref — a re-persist reconciles to the SAME rows (no duplicates)', async () => {
    const db = new FakeHandlerDb();
    const first = await persistCollectionRows(db, plannedRows(), SCOPE, RECONCILE);
    expect(first.upserted).toBe(4);
    const second = await persistCollectionRows(db, plannedRows(), SCOPE, RECONCILE);
    expect(second.upserted).toBe(4);
    expect(db.rows('note_artifacts')).toHaveLength(4); // the REAL constraint: never duplicated
    expect(first.countsByKind).toEqual({ digest: 1, finding: 3 });
  });

  it('preserve_human_edits: a human-edited row is NEVER overwritten', async () => {
    const db = new FakeHandlerDb();
    await persistCollectionRows(db, plannedRows(), SCOPE, RECONCILE);
    // A human edits finding:0 …
    const edited = db
      .rows('note_artifacts')
      .find((r) => r.artifact_ref === 'tenant-a:s1:finding:0');
    if (!edited) throw new Error('row missing');
    edited.human_edited = true;
    edited.payload = { text: 'HUMAN EDIT', evidence: ['sp-1'], evidence_span_ids: ['sp-1'] };
    // … a re-extract runs → the edit WINS.
    const outcome = await persistCollectionRows(db, plannedRows(), SCOPE, RECONCILE);
    expect(outcome.skippedHumanEdited).toBe(1);
    const after = db.rows('note_artifacts').find((r) => r.artifact_ref === 'tenant-a:s1:finding:0');
    expect((after?.payload as Record<string, unknown>).text).toBe('HUMAN EDIT');
  });

  it('preserve_dismissed: a dismissed row is NEVER resurrected across a rebuild', async () => {
    const db = new FakeHandlerDb();
    await persistCollectionRows(db, plannedRows(), SCOPE, RECONCILE);
    // A user DISMISSES finding:0 (a distinct lifecycle from human_edited — the row is NOT edited).
    const row = db.rows('note_artifacts').find((r) => r.artifact_ref === 'tenant-a:s1:finding:0');
    if (!row) throw new Error('row missing');
    row.dismissed = true;
    row.payload = { text: 'DISMISSED-MARKER', evidence: ['sp-1'], evidence_span_ids: ['sp-1'] };
    // … a reprocess re-extracts (the same candidate) → the DISMISSAL wins: dismissed STAYS true and
    // the row is NOT re-stamped `dismissed:false` (RED before the fix — the upsert Object.assigns
    // `dismissed:false` from buildCollectionRows over the dismissed row, resurrecting it).
    const outcome = await persistCollectionRows(db, plannedRows(), SCOPE, RECONCILE);
    expect(outcome.skippedDismissed).toBe(1);
    const after = db.rows('note_artifacts').find((r) => r.artifact_ref === 'tenant-a:s1:finding:0');
    expect(after?.dismissed).toBe(true);
    // The dismissed row is preserved as-is (the upsert is skipped, mirroring the human-edit skip).
    expect((after?.payload as Record<string, unknown>).text).toBe('DISMISSED-MARKER');
  });

  it('preserve_dismissed: a dismissed row is spared even when preserveHumanEdits is FALSE (unconditional)', async () => {
    const db = new FakeHandlerDb();
    // A prior DISMISSED row already in the store.
    await db.insert('note_artifacts', {
      session_id: 's1',
      artifact_kind: 'finding',
      payload: { text: 'old', evidence_span_ids: [] },
      human_edited: false,
      dismissed: true,
      artifact_ref: 'tenant-a:s1:finding:0',
    });
    // A re-extract plans the SAME ref with preserveHumanEdits:FALSE (so the human-edit pre-read is
    // NOT what spares it) — the dismissal-preserve is unconditional.
    const planned = [
      {
        store: 'note_artifacts',
        artifactRef: 'tenant-a:s1:finding:0',
        kind: 'finding',
        preserveHumanEdits: false,
        row: {
          session_id: 's1',
          artifact_kind: 'finding',
          payload: { text: 'RE-EXTRACTED', evidence_span_ids: [] },
          human_edited: false,
          dismissed: false,
          artifact_ref: 'tenant-a:s1:finding:0',
        },
      },
    ];
    const outcome = await persistCollectionRows(db, planned, SCOPE, RECONCILE);
    expect(outcome.skippedDismissed).toBe(1);
    expect(outcome.upserted).toBe(0);
    const after = db.rows('note_artifacts').find((r) => r.artifact_ref === 'tenant-a:s1:finding:0');
    expect(after?.dismissed).toBe(true);
    expect((after?.payload as Record<string, unknown>).text).toBe('old'); // NOT re-extracted over
  });

  it('reconcile_stale_rows: a smaller re-extract deletes orphans — except human-edited ones', async () => {
    const db = new FakeHandlerDb();
    await persistCollectionRows(db, plannedRows(), SCOPE, RECONCILE);
    // Mark finding:2 human-edited so the reconcile must spare it.
    const spare = db.rows('note_artifacts').find((r) => r.artifact_ref === 'tenant-a:s1:finding:2');
    if (!spare) throw new Error('row missing');
    spare.human_edited = true;
    // The re-extract now produces ONE finding.
    const smaller = {
      ...candidateDoc(),
      findings: [{ text: 'only survivor', evidence: ['sp-1'] }],
    };
    const outcome = await persistCollectionRows(db, plannedRows(smaller), SCOPE, RECONCILE);
    expect(outcome.reconciledStale).toBe(1); // finding:1 deleted; finding:2 spared (human edit)
    const refs = db
      .rows('note_artifacts')
      .map((r) => r.artifact_ref)
      .sort();
    expect(refs).toEqual([
      'tenant-a:s1:digest:0',
      'tenant-a:s1:finding:0',
      'tenant-a:s1:finding:2',
    ]);
  });

  it('reconcile_stale_rows: a smaller re-extract spares a DISMISSED orphan (never deletes a dismissed row)', async () => {
    const db = new FakeHandlerDb();
    await persistCollectionRows(db, plannedRows(), SCOPE, RECONCILE);
    // A user dismissed finding:2 — the reconcile must spare it exactly like a human-edited row.
    const spare = db.rows('note_artifacts').find((r) => r.artifact_ref === 'tenant-a:s1:finding:2');
    if (!spare) throw new Error('row missing');
    spare.dismissed = true;
    // The re-extract now produces ONE finding (finding:1 and finding:2 become stale orphans).
    const smaller = {
      ...candidateDoc(),
      findings: [{ text: 'only survivor', evidence: ['sp-1'] }],
    };
    const outcome = await persistCollectionRows(db, plannedRows(smaller), SCOPE, RECONCILE);
    expect(outcome.reconciledStale).toBe(1); // finding:1 deleted; finding:2 spared (dismissed)
    const refs = db
      .rows('note_artifacts')
      .map((r) => r.artifact_ref)
      .sort();
    expect(refs).toEqual([
      'tenant-a:s1:digest:0',
      'tenant-a:s1:finding:0',
      'tenant-a:s1:finding:2',
    ]);
    const kept = db.rows('note_artifacts').find((r) => r.artifact_ref === 'tenant-a:s1:finding:2');
    expect(kept?.dismissed).toBe(true);
  });

  it('reconcile_stale_rows on WHOLE-KIND removal: a re-extract with ZERO members of a declared kind deletes ALL its prior non-human-edited rows (MAT-1)', async () => {
    const db = new FakeHandlerDb();
    await persistCollectionRows(db, plannedRows(), SCOPE, RECONCILE);
    // A human edits finding:2 — the whole-kind reconcile must spare it (both directions asserted).
    const spare = db.rows('note_artifacts').find((r) => r.artifact_ref === 'tenant-a:s1:finding:2');
    if (!spare) throw new Error('row missing');
    spare.human_edited = true;
    // The re-extract yields ZERO members of the previously-persisted, reconcile-declared kind
    // 'finding' (the whole kind vanished from the candidate). The reconcile scope is DECLARED, not
    // derived from what this extraction produced — the stale rows MUST be deleted anyway.
    const empty = { ...candidateDoc(), findings: [] };
    const outcome = await persistCollectionRows(db, plannedRows(empty), SCOPE, RECONCILE);
    expect(outcome.reconciledStale).toBe(2); // finding:0 + finding:1 deleted
    const refs = db
      .rows('note_artifacts')
      .map((r) => r.artifact_ref)
      .sort();
    // Deleted: every prior non-human-edited 'finding' row. Preserved: the human edit + the digest.
    expect(refs).toEqual(['tenant-a:s1:digest:0', 'tenant-a:s1:finding:2']);
    const kept = db.rows('note_artifacts').find((r) => r.artifact_ref === 'tenant-a:s1:finding:2');
    expect(kept?.human_edited).toBe(true);
  });

  it('reconcile scans the DECLARED store set: whole-kind removal deletes stale rows in a store the planned rows never touch (MAT-1, STORE half)', async () => {
    // Two collections bound to two DIFFERENT stores: the always-produced digest projection lives in
    // store A, the reconcile-declared 'finding' kind in store B. A whole-kind removal then plans
    // rows for store A ONLY — so a store loop derived from the PLANNED rows would never visit
    // store B and the stale finding rows would survive. Only the spec-derived store set
    // (declaredReconcileScope.stores) reaches them: this pins the STORE-derivation half of MAT-1
    // (the single-store fixture above cannot — the digest row keeps its one store in any
    // planned-derived set).
    const spec2 = parseFixture();
    const multi = {
      ...spec2,
      artifacts: spec2.artifacts.map((a) =>
        a.kind === 'finding' ? { ...a, collection: 'finding_artifacts' } : a,
      ),
    };
    const collections = new Map([
      ['note_artifacts', { store: 'digest_store' }],
      ['finding_artifacts', { store: 'finding_store' }],
    ]);
    const reconcile = declaredReconcileScope(multi, collections);
    expect([...reconcile.stores].sort()).toEqual(['digest_store', 'finding_store']);

    const plan = (doc: Record<string, unknown>) => {
      const app = applyGroundingPolicy(multi, doc, 'notetool.notes', CLOSED);
      return buildCollectionRows(app.kinds, {
        tenantId: TENANT,
        scopeColumn: SCOPE.column,
        scopeId: SCOPE.id,
        collectionStores: collections,
      });
    };

    const db = new FakeHandlerDb();
    await persistCollectionRows(db, plan(candidateDoc()), SCOPE, reconcile);
    expect(db.rows('finding_store')).toHaveLength(3); // finding:0..2 landed in store B
    // A human edits finding:1 — the cross-store reconcile must spare it …
    const spare = db.rows('finding_store').find((r) => r.artifact_ref === 'tenant-a:s1:finding:1');
    if (!spare) throw new Error('row missing');
    spare.human_edited = true;
    // … and another session's store-B row must stay untouched (scope-bounded).
    await db.insert('finding_store', {
      session_id: 'other-session',
      artifact_kind: 'finding',
      payload: {},
      human_edited: false,
      dismissed: false,
      artifact_ref: 'tenant-a:other-session:finding:0',
    });

    // Whole-kind removal: the re-extract yields ZERO findings → the planned rows touch ONLY store A.
    const planned = plan({ ...candidateDoc(), findings: [] });
    expect(new Set(planned.map((p) => p.store))).toEqual(new Set(['digest_store']));
    const outcome = await persistCollectionRows(db, planned, SCOPE, reconcile);

    // The DECLARED store set drove the scan: this scope's stale store-B rows are GONE …
    expect(outcome.reconciledStale).toBe(2); // finding:0 + finding:2 deleted in finding_store
    const refs = db
      .rows('finding_store')
      .map((r) => r.artifact_ref)
      .sort();
    // … while the human edit + the other session's row survive; store A keeps its digest.
    expect(refs).toEqual(['tenant-a:other-session:finding:0', 'tenant-a:s1:finding:1']);
    expect(db.rows('digest_store').map((r) => r.artifact_ref)).toEqual(['tenant-a:s1:digest:0']);
  });

  it('reconciliation is SCOPE-bounded: another session’s rows are untouched', async () => {
    const db = new FakeHandlerDb();
    await db.insert('note_artifacts', {
      session_id: 'other-session',
      artifact_kind: 'finding',
      payload: {},
      human_edited: false,
      dismissed: false,
      artifact_ref: 'tenant-a:other-session:finding:0',
    });
    await persistCollectionRows(db, plannedRows(), SCOPE, RECONCILE);
    expect(
      db.rows('note_artifacts').some((r) => r.artifact_ref === 'tenant-a:other-session:finding:0'),
    ).toBe(true);
  });
});

describe('declaredReconcileScope (the MAT-1 declared authority)', () => {
  const spec = parseFixture();

  it('derives the reconcile-enabled kinds + their bound stores from the SPEC', () => {
    const scope = declaredReconcileScope(spec, COLLECTIONS);
    expect([...scope.kinds].sort()).toEqual(['digest', 'finding']);
    expect([...scope.stores]).toEqual(['note_artifacts']);
  });

  it('excludes a kind whose lifecycle does not declare reconcile_stale_rows', () => {
    const mutated = {
      ...spec,
      artifacts: spec.artifacts.map((a) =>
        a.kind === 'digest'
          ? { ...a, lifecycle: { ...a.lifecycle, reconcile_stale_rows: false } }
          : a,
      ),
    };
    const scope = declaredReconcileScope(mutated, COLLECTIONS);
    expect([...scope.kinds]).toEqual(['finding']);
  });

  it('fails closed on a reconcile-declared kind with no bound store', () => {
    expect(() => declaredReconcileScope(spec, new Map())).toThrow(MaterializeError);
    expect(() => declaredReconcileScope(spec, new Map())).toThrow(/no bound store/);
  });
});
