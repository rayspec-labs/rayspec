/**
 * The delta-diff core — GOLDEN + REAL-GATE byte-fidelity tests.
 *
 * The load-bearing proofs (fail-the-fix, not pass-the-shape):
 *   1. BYTE-FIDELITY through the REAL scan — the machine-emitted `proposedAllowlist` is scanned by the
 *      genuine `scanMigrationSql` over the EXACT emitted SQL: BLOCKED with an empty allowlist, PASSES
 *      with the proposal. No injected seam (the ND-1 trap): the destructive SQL is what `diffProductStores`
 *      actually produces, driven through the production gate. Weakening the allowlist-match
 *      normalization turns the "passes" arm RED (documented shadow-mutation in the S1 report).
 *   2. GENERATOR EQUIVALENCE — `diffProductStores([], new).migrationSql === generateProductSql(new)`
 *      BYTE-FOR-BYTE (a first materialization is the CREATE-only generator).
 *   3. NO-OP — `diff(old, old)` is empty.
 *   4. GOLDEN deltas — add col (nullable/NN-no-default), drop col, type change (USING / no-USING),
 *      unique add/remove, FK add/remove/change, table add/drop, and the rename-as-drop+add note.
 *   5. The versioned migration-naming convention (append, never overwrite `0000`).
 */
import { StoreSpec } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import { diffProductStores, nextMigrationFilename } from './diff-product-stores.js';
import { emitStoreSql, generateProductSql } from './generated/generate-product-sql.js';
import { scanMigrationSql } from './migration-scan.js';

/** Parse a raw store object through the REAL Zod grammar so defaults (nullable/unique/onDelete) apply. */
function store(raw: unknown): StoreSpec {
  return StoreSpec.parse(raw);
}

/** A representative pair with EVERY delta shape at once — the strong byte-fidelity fixture. */
const OLD_RICH = [
  store({
    name: 'meetings',
    columns: [
      { name: 'title', type: 'text' },
      { name: 'note', type: 'text' }, // removed in NEW → DROP COLUMN
      { name: 'priority', type: 'integer' }, // int→text in NEW → type change (USING ::text)
      { name: 'slug', type: 'text', unique: true }, // unique dropped in NEW → DROP INDEX
    ],
  }),
  store({
    name: 'transcripts', // removed table in NEW → DROP TABLE
    columns: [
      { name: 'body', type: 'text' },
      { name: 'meeting_id', type: 'uuid' },
    ],
    foreignKeys: [{ column: 'meeting_id', references: 'meetings', onDelete: 'cascade' }],
  }),
];
const NEW_RICH = [
  store({
    name: 'meetings',
    columns: [
      { name: 'title', type: 'text' },
      { name: 'priority', type: 'text' }, // type change from integer
      { name: 'slug', type: 'text' }, // unique removed
      { name: 'tag', type: 'text' }, // added, NOT NULL (nullable defaults false) + no default → flagged
    ],
  }),
];

describe('diffProductStores — no-op', () => {
  it('diff(old, old) is empty (statements, sql, findings, allowlist)', () => {
    const r = diffProductStores(OLD_RICH, OLD_RICH);
    expect(r.statements).toEqual([]);
    expect(r.migrationSql).toBe('');
    expect(r.findings).toEqual([]);
    expect(r.proposedAllowlist).toEqual([]);
    expect(r.destructive).toBe(false);
  });

  it('an identical single store is a no-op', () => {
    const s = [store({ name: 'a', columns: [{ name: 'x', type: 'text' }] })];
    expect(diffProductStores(s, s).statements).toEqual([]);
  });
});

describe('diffProductStores — first materialization equals the CREATE-only generator', () => {
  it('diff([], new).migrationSql === generateProductSql(new) BYTE-FOR-BYTE', () => {
    const r = diffProductStores([], NEW_RICH);
    expect(r.migrationSql).toBe(generateProductSql(NEW_RICH));
    expect(r.destructive).toBe(false); // a fresh CREATE is purely additive
    expect(r.proposedAllowlist).toEqual([]);
    // The two-table throwaway shape too (regression against the committed generator convention).
    const twoTable = [
      store({ name: 'meetings', columns: [{ name: 'title', type: 'text' }] }),
      store({
        name: 'transcripts',
        columns: [
          { name: 'meeting_id', type: 'uuid' },
          { name: 'body', type: 'text' },
        ],
        foreignKeys: [{ column: 'meeting_id', references: 'meetings' }],
      }),
    ];
    expect(diffProductStores([], twoTable).migrationSql).toBe(generateProductSql(twoTable));
  });
});

describe('diffProductStores — REAL-gate byte-fidelity (the load-bearing proof)', () => {
  const r = diffProductStores(OLD_RICH, NEW_RICH);

  it('emits the exact forward statements in additive-first / destructive-last order', () => {
    expect(r.statements).toEqual([
      // additive first
      'ALTER TABLE "meetings" ADD COLUMN "tag" text NOT NULL',
      // destructive (surviving-table): removed col, type change, dropped unique index
      'ALTER TABLE "meetings" DROP COLUMN "note"',
      'ALTER TABLE "meetings" ALTER COLUMN "priority" SET DATA TYPE text USING "priority"::text',
      'DROP INDEX "meetings_slug_unique"',
      // dropped table last
      'DROP TABLE "transcripts"',
    ]);
  });

  it('classifies every statement with the scan vocabulary (additive vs destructive kinds)', () => {
    const byKind = Object.fromEntries(r.findings.map((f) => [f.sql, f.destructiveKinds]));
    expect(byKind['ALTER TABLE "meetings" ADD COLUMN "tag" text NOT NULL']).toEqual([
      'add-column-not-null-no-default',
    ]);
    expect(byKind['ALTER TABLE "meetings" DROP COLUMN "note"']).toEqual(['drop-column']);
    expect(
      byKind[
        'ALTER TABLE "meetings" ALTER COLUMN "priority" SET DATA TYPE text USING "priority"::text'
      ],
    ).toEqual(['using-cast']);
    expect(byKind['DROP INDEX "meetings_slug_unique"']).toEqual(['drop-index']);
    expect(byKind['DROP TABLE "transcripts"']).toEqual(['drop-table']);
  });

  it('the REAL scan BLOCKS the generated SQL with an EMPTY allowlist', () => {
    const scan = scanMigrationSql(r.migrationSql, []);
    expect(scan.pass).toBe(false);
    const blocked = scan.findings
      .filter((f) => !f.allowed)
      .map((f) => f.kind)
      .sort();
    expect(blocked).toEqual([
      'add-column-not-null-no-default',
      'drop-column',
      'drop-index',
      'drop-table',
      'using-cast',
    ]);
  });

  it('the REAL scan PASSES the SAME SQL with the machine-proposed allowlist (byte-fidelity)', () => {
    // This is the arm the shadow-mutation of normalizeStatementForMatch turns RED.
    const scan = scanMigrationSql(r.migrationSql, r.proposedAllowlist);
    expect(scan.pass).toBe(true);
    expect(scan.findings.every((f) => f.allowed)).toBe(true);
  });

  it('every proposed allowlist entry carries a review reason and is one-per-destructive-statement', () => {
    expect(r.destructive).toBe(true);
    expect(r.proposedAllowlist).toHaveLength(5);
    for (const e of r.proposedAllowlist) {
      expect(e.reason).toMatch(/REVIEW REQUIRED/);
      expect(e.match).not.toMatch(/;\s*$/); // trailing-`;` stripped, like the scan matcher
    }
  });

  it('surfaces the column-rename + drop-ordering + no-default caveats honestly', () => {
    const joined = r.notes.join('\n');
    expect(joined).toMatch(/column RENAME/); // note dropped + tag added ⇒ ambiguous with a rename
    expect(joined).toMatch(/SURVIVING foreign key/); // a table was dropped
    expect(joined).toMatch(/non-nullable column "meetings"\."tag"/);
    // NO table-rename note: this fixture drops a table but adds none, so a table rename is not ambiguous.
    expect(joined).not.toMatch(/table RENAME/);
  });

  it('surfaces the TABLE-rename caveat only when a table is dropped AND another added', () => {
    const renamed = diffProductStores(
      [store({ name: 'old_name', columns: [{ name: 'a', type: 'text' }] })],
      [store({ name: 'new_name', columns: [{ name: 'a', type: 'text' }] })],
    );
    expect(renamed.notes.join('\n')).toMatch(/table RENAME/);
    // drop + create (data NOT migrated) — both statements present
    expect(renamed.statements.some((s) => s.startsWith('CREATE TABLE "new_name"'))).toBe(true);
    expect(renamed.statements).toContain('DROP TABLE "old_name"');
  });
});

describe('diffProductStores — golden per-shape deltas', () => {
  const base = [store({ name: 'items', columns: [{ name: 'a', type: 'text' }] })];

  it('add a NULLABLE column is purely additive (no findings)', () => {
    const next = [
      store({
        name: 'items',
        columns: [
          { name: 'a', type: 'text' },
          { name: 'b', type: 'text', nullable: true },
        ],
      }),
    ];
    const r = diffProductStores(base, next);
    expect(r.statements).toEqual(['ALTER TABLE "items" ADD COLUMN "b" text']);
    expect(r.destructive).toBe(false);
    expect(r.findings[0]?.destructiveKinds).toEqual([]);
    expect(scanMigrationSql(r.migrationSql, []).pass).toBe(true);
  });

  it('add a NOT-NULL-no-default column is flagged (add-column-not-null-no-default) and re-passes with the proposal', () => {
    const next = [
      store({
        name: 'items',
        columns: [
          { name: 'a', type: 'text' },
          { name: 'b', type: 'text' },
        ],
      }),
    ];
    const r = diffProductStores(base, next);
    expect(r.statements).toEqual(['ALTER TABLE "items" ADD COLUMN "b" text NOT NULL']);
    expect(r.findings[0]?.destructiveKinds).toEqual(['add-column-not-null-no-default']);
    expect(scanMigrationSql(r.migrationSql, []).pass).toBe(false);
    expect(scanMigrationSql(r.migrationSql, r.proposedAllowlist).pass).toBe(true);
  });

  it('a type change to a NON-text target has NO USING (type-change-no-using) and notes the risk', () => {
    const from = [store({ name: 'items', columns: [{ name: 'a', type: 'text' }] })];
    const to = [store({ name: 'items', columns: [{ name: 'a', type: 'uuid' }] })];
    const r = diffProductStores(from, to);
    expect(r.statements).toEqual(['ALTER TABLE "items" ALTER COLUMN "a" SET DATA TYPE uuid']);
    expect(r.findings[0]?.destructiveKinds).toEqual(['type-change-no-using']);
    expect(r.notes.join('\n')).toMatch(/without a USING clause/);
    expect(scanMigrationSql(r.migrationSql, r.proposedAllowlist).pass).toBe(true);
  });

  it('relaxing NOT NULL is additive (DROP NOT NULL); tightening is destructive (SET NOT NULL)', () => {
    const nn = [store({ name: 'items', columns: [{ name: 'a', type: 'text' }] })]; // NOT NULL
    const nullable = [
      store({ name: 'items', columns: [{ name: 'a', type: 'text', nullable: true }] }),
    ];
    const relax = diffProductStores(nn, nullable);
    expect(relax.statements).toEqual(['ALTER TABLE "items" ALTER COLUMN "a" DROP NOT NULL']);
    expect(relax.destructive).toBe(false);
    const tighten = diffProductStores(nullable, nn);
    expect(tighten.statements).toEqual(['ALTER TABLE "items" ALTER COLUMN "a" SET NOT NULL']);
    expect(tighten.findings[0]?.destructiveKinds).toEqual(['set-not-null']);
    expect(scanMigrationSql(tighten.migrationSql, tighten.proposedAllowlist).pass).toBe(true);
  });

  it('adding unique is additive (TENANT-SCOPED compound index); removing unique is destructive (DROP INDEX)', () => {
    const plain = [store({ name: 'items', columns: [{ name: 'a', type: 'text' }] })];
    const uniq = [store({ name: 'items', columns: [{ name: 'a', type: 'text', unique: true }] })];
    const add = diffProductStores(plain, uniq);
    // A non-key author `unique: true` is TENANT-SCOPED — the index is compound (tenant_id, a).
    expect(add.statements).toEqual([
      'CREATE UNIQUE INDEX "items_a_unique" ON "items" USING btree ("tenant_id", "a")',
    ]);
    expect(add.destructive).toBe(false);
    const remove = diffProductStores(uniq, plain);
    // The index NAME is unchanged, so DROP keys off it unchanged (single/compound irrelevant to DROP).
    expect(remove.statements).toEqual(['DROP INDEX "items_a_unique"']);
    expect(remove.findings[0]?.destructiveKinds).toEqual(['drop-index']);
  });

  it('a conflict-key column keeps a SINGLE-column unique index', () => {
    const plain = [store({ name: 'items', columns: [{ name: 'a', type: 'text' }] })];
    const uniq = [store({ name: 'items', columns: [{ name: 'a', type: 'text', unique: true }] })];
    // Mark `a` as a durable conflict key → the durable `ON CONFLICT (a)` target MUST stay single-column
    // (a compound index would 42P10). The index NAME is identical to the compound case.
    const newConflictKeys = new Map([['items', new Set(['a'])]]);
    const add = diffProductStores(plain, uniq, { newConflictKeys });
    expect(add.statements).toEqual([
      'CREATE UNIQUE INDEX "items_a_unique" ON "items" USING btree ("a")',
    ]);
    expect(add.destructive).toBe(false);
  });

  it('a demoted conflict-key → author-unique column REINDEXES single → compound (DROP + CREATE)', () => {
    // The column STAYS `unique: true` across the update; only its durable-conflict-key status changes.
    // Old: `code` was a durable key (single-column `(code)` index). New: `code` is a plain author-unique
    // (tenant-scoped compound `(tenant_id, code)` expected) — the cross-tenant-leak fix must APPLY on the
    // update path, not only on a fresh materialize.
    const oldStore = [
      store({ name: 'catalog', columns: [{ name: 'code', type: 'text', unique: true }] }),
    ];
    const newStore = [
      store({ name: 'catalog', columns: [{ name: 'code', type: 'text', unique: true }] }),
    ];
    const oldConflictKeys = new Map([['catalog', new Set(['code'])]]); // was a key → single
    const newConflictKeys = new Map([['catalog', new Set<string>()]]); // now author-unique → compound
    const r = diffProductStores(oldStore, newStore, { oldConflictKeys, newConflictKeys });
    // A genuine reindex: DROP the stale single-column index, then CREATE the tenant-scoped compound one,
    // ADJACENT and DROP-first (the index NAME is stable). Without the fix the diff emits NOTHING here.
    expect(r.statements).toEqual([
      'DROP INDEX "catalog_code_unique"',
      'CREATE UNIQUE INDEX "catalog_code_unique" ON "catalog" USING btree ("tenant_id", "code")',
    ]);
    expect(r.findings.find((f) => f.sql.startsWith('DROP INDEX'))?.destructiveKinds).toEqual([
      'drop-index',
    ]);
    // The reindex re-passes the REAL gate with the machine-proposed allowlist (byte-fidelity holds).
    expect(scanMigrationSql(r.migrationSql, r.proposedAllowlist).pass).toBe(true);
    expect(r.notes.join('\n')).toMatch(/REINDEXED/);
  });

  it('a promoted author-unique → conflict-key column REINDEXES compound → single (DROP + CREATE)', () => {
    const oldStore = [
      store({ name: 'catalog', columns: [{ name: 'code', type: 'text', unique: true }] }),
    ];
    const newStore = [
      store({ name: 'catalog', columns: [{ name: 'code', type: 'text', unique: true }] }),
    ];
    const oldConflictKeys = new Map([['catalog', new Set<string>()]]); // was author-unique → compound
    const newConflictKeys = new Map([['catalog', new Set(['code'])]]); // now a durable key → single
    const r = diffProductStores(oldStore, newStore, { oldConflictKeys, newConflictKeys });
    // The durable `ON CONFLICT (code)` target now needs a SINGLE-column index (a compound one would 42P10
    // every upsert). DROP the compound, CREATE the single.
    expect(r.statements).toEqual([
      'DROP INDEX "catalog_code_unique"',
      'CREATE UNIQUE INDEX "catalog_code_unique" ON "catalog" USING btree ("code")',
    ]);
    expect(scanMigrationSql(r.migrationSql, r.proposedAllowlist).pass).toBe(true);
  });

  it('a SAME carve-class survivor is a no-op (no spurious reindex)', () => {
    // `code` is author-unique in BOTH old and new (not a key either side) → no carve-class change → the
    // diff emits nothing. Guards against a reindex firing on every diff.
    const s = [store({ name: 'catalog', columns: [{ name: 'code', type: 'text', unique: true }] })];
    const keys = new Map([['catalog', new Set<string>()]]);
    expect(
      diffProductStores(s, s, { oldConflictKeys: keys, newConflictKeys: keys }).statements,
    ).toEqual([]);
    // And a key-both-sides survivor is likewise a no-op (single → single).
    const keyed = new Map([['catalog', new Set(['code'])]]);
    expect(
      diffProductStores(s, s, { oldConflictKeys: keyed, newConflictKeys: keyed }).statements,
    ).toEqual([]);
  });

  it('FIX-2: a NEWLY-ADDED unique column emits ADD COLUMN + CREATE UNIQUE INDEX (both additive)', () => {
    const next = [
      store({
        name: 'items',
        columns: [
          { name: 'a', type: 'text' },
          { name: 'b', type: 'text', nullable: true, unique: true }, // brand-new nullable + unique
        ],
      }),
    ];
    const r = diffProductStores(base, next);
    // Before the fix the added-column loop ignored `unique`, so the index was silently dropped.
    // A non-key author unique on the new column → TENANT-SCOPED compound index.
    expect(r.statements).toEqual([
      'ALTER TABLE "items" ADD COLUMN "b" text',
      'CREATE UNIQUE INDEX "items_b_unique" ON "items" USING btree ("tenant_id", "b")',
    ]);
    expect(r.destructive).toBe(false); // a brand-new column has no duplicate data — purely additive
    expect(scanMigrationSql(r.migrationSql, []).pass).toBe(true);
    expect(r.findings.every((f) => f.destructiveKinds.length === 0)).toBe(true);
  });

  it('adding a table is additive (CREATE via the generator path); dropping a table is destructive', () => {
    const one = [store({ name: 'items', columns: [{ name: 'a', type: 'text' }] })];
    const two = [
      store({ name: 'items', columns: [{ name: 'a', type: 'text' }] }),
      store({ name: 'notes', columns: [{ name: 'b', type: 'text' }] }),
    ];
    const add = diffProductStores(one, two);
    // The added table reuses the CREATE path — injected tenancy columns + tenant FK + tenant idx.
    expect(add.statements.some((s) => s.startsWith('CREATE TABLE "notes"'))).toBe(true);
    expect(add.statements.some((s) => s.includes('"notes_tenant_id_orgs_id_fk"'))).toBe(true);
    expect(
      add.statements.some(
        (s) => s === 'CREATE INDEX "notes_tenant_idx" ON "notes" USING btree ("tenant_id")',
      ),
    ).toBe(true);
    expect(add.destructive).toBe(false);
    const drop = diffProductStores(two, one);
    expect(drop.statements).toEqual(['DROP TABLE "notes"']);
    expect(drop.findings[0]?.destructiveKinds).toEqual(['drop-table']);
  });

  it('FK add is additive; FK remove is destructive; an onDelete change is drop + add', () => {
    const parent = { name: 'meetings', columns: [{ name: 'title', type: 'text' }] };
    const noFk = [
      store(parent),
      store({
        name: 'transcripts',
        columns: [
          { name: 'meeting_id', type: 'uuid' },
          { name: 'body', type: 'text' },
        ],
      }),
    ];
    const withFk = [
      store(parent),
      store({
        name: 'transcripts',
        columns: [
          { name: 'meeting_id', type: 'uuid' },
          { name: 'body', type: 'text' },
        ],
        foreignKeys: [{ column: 'meeting_id', references: 'meetings', onDelete: 'cascade' }],
      }),
    ];
    const add = diffProductStores(noFk, withFk);
    expect(add.statements).toEqual([
      'ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_meeting_id_meetings_id_fk" ' +
        'FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action',
    ]);
    expect(add.destructive).toBe(false);

    const remove = diffProductStores(withFk, noFk);
    expect(remove.statements).toEqual([
      'ALTER TABLE "transcripts" DROP CONSTRAINT "transcripts_meeting_id_meetings_id_fk"',
    ]);
    expect(remove.findings[0]?.destructiveKinds).toEqual(['drop-constraint']);

    const restrictFk = [
      store(parent),
      store({
        name: 'transcripts',
        columns: [
          { name: 'meeting_id', type: 'uuid' },
          { name: 'body', type: 'text' },
        ],
        foreignKeys: [{ column: 'meeting_id', references: 'meetings', onDelete: 'restrict' }],
      }),
    ];
    const change = diffProductStores(withFk, restrictFk);
    // FIX-1: an onDelete-only change keeps the SAME constraint name (the name encodes no policy), so
    // the replace MUST be DROP-then-ADD as an ADJACENT pair in the destructive segment — an ADD before
    // the DROP would fail 42710 duplicate_object on a real DB. Drop at index 0, add at index 1.
    expect(change.statements).toEqual([
      'ALTER TABLE "transcripts" DROP CONSTRAINT "transcripts_meeting_id_meetings_id_fk"',
      'ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_meeting_id_meetings_id_fk" ' +
        'FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE restrict ON UPDATE no action',
    ]);
    expect(change.destructive).toBe(true);
    expect(scanMigrationSql(change.migrationSql, change.proposedAllowlist).pass).toBe(true);
  });

  it('a spec diff never touches the INJECTED tenancy columns (only author business columns)', () => {
    // A diff over identical business columns is a no-op — the injected tenancy/GDPR columns
    // (id/tenant_id/created_at/deleted_at/retention_days/region) are constant across versions and
    // never appear as ALTERs here; they are (re)materialized only on an ADDED table's CREATE.
    const s = [store({ name: 'items', columns: [{ name: 'a', type: 'text' }] })];
    expect(diffProductStores(s, s).statements).toEqual([]);
    const added = diffProductStores([], s).migrationSql;
    expect(added).toContain('"tenant_id" uuid NOT NULL');
    expect(added).not.toMatch(/ALTER TABLE "items" ADD COLUMN "tenant_id"/);
  });

  it('SE-2: throws on duplicate store names within either input array (TEN-1-style input guard)', () => {
    const a = store({ name: 'dup', columns: [{ name: 'x', type: 'text' }] });
    expect(() => diffProductStores([], [a, a])).toThrow(/duplicate store name/i);
    expect(() => diffProductStores([a, a], [])).toThrow(/duplicate store name/i);
  });

  it('TB-1: multiple dropped tables are emitted in REVERSE declared order', () => {
    const many = [
      store({ name: 'alpha', columns: [{ name: 'a', type: 'text' }] }),
      store({ name: 'beta', columns: [{ name: 'b', type: 'text' }] }),
      store({ name: 'gamma', columns: [{ name: 'c', type: 'text' }] }),
    ];
    const keepAlpha = [store({ name: 'alpha', columns: [{ name: 'a', type: 'text' }] })];
    const r = diffProductStores(many, keepAlpha);
    // beta + gamma removed → reverse declared order drops the later-declared child first.
    expect(r.statements).toEqual(['DROP TABLE "gamma"', 'DROP TABLE "beta"']);
    expect(r.findings.map((f) => f.destructiveKinds)).toEqual([['drop-table'], ['drop-table']]);
  });

  it('TB-2: an FK RETARGET (references changes, same onDelete) is a drop(old-name)+add(new-name) adjacent pair', () => {
    const parents = [
      store({ name: 'meetings', columns: [{ name: 'title', type: 'text' }] }),
      store({ name: 'sessions', columns: [{ name: 'label', type: 'text' }] }),
    ];
    const child = (references: string) =>
      store({
        name: 'transcripts',
        columns: [
          { name: 'meeting_id', type: 'uuid' },
          { name: 'body', type: 'text' },
        ],
        foreignKeys: [{ column: 'meeting_id', references, onDelete: 'cascade' }],
      });
    const toMeetings = [...parents, child('meetings')];
    const toSessions = [...parents, child('sessions')];
    const r = diffProductStores(toMeetings, toSessions);
    // The references change → the constraint NAME changes (name encodes the parent) → DROP old-name,
    // ADD new-name, ADJACENT in the destructive segment (pins fkEqual's references branch).
    expect(r.statements).toEqual([
      'ALTER TABLE "transcripts" DROP CONSTRAINT "transcripts_meeting_id_meetings_id_fk"',
      'ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_meeting_id_sessions_id_fk" ' +
        'FOREIGN KEY ("meeting_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action',
    ]);
    expect(r.destructive).toBe(true); // the DROP CONSTRAINT is flagged; the ADD is additive to the scan
  });

  it('TB-3: a delta that BOTH adds a table AND alters a surviving one pins the full statements array', () => {
    const before = [store({ name: 'items', columns: [{ name: 'a', type: 'text' }] })];
    const notes = store({ name: 'notes', columns: [{ name: 'c', type: 'text' }] });
    const after = [
      store({
        name: 'items',
        columns: [
          { name: 'a', type: 'text' },
          { name: 'b', type: 'text', nullable: true }, // additive alter on the SURVIVING table
        ],
      }),
      notes, // an ADDED table
    ];
    const r = diffProductStores(before, after);
    // Phase A (added-table CREATE path via the generator's emitStoreSql) comes FIRST, then Phase B
    // (surviving-table additive alters). The exact added-table bytes are emitStoreSql's — asserted whole.
    expect(r.statements).toEqual([
      ...emitStoreSql(notes),
      'ALTER TABLE "items" ADD COLUMN "b" text',
    ]);
  });
});

describe('nextMigrationFilename — versioned append convention', () => {
  it('an empty dir yields 0000 (first materialization)', () => {
    expect(nextMigrationFilename([])).toBe('0000_update.sql');
    expect(nextMigrationFilename([], 'init')).toBe('0000_init.sql');
  });

  it('appends after the max sequence and NEVER overwrites 0000', () => {
    expect(nextMigrationFilename(['0000_product_stores.sql'])).toBe('0001_update.sql');
    expect(
      nextMigrationFilename(['0000_product_stores.sql', '0001_add_tag.sql', 'meta'], 'drop_note'),
    ).toBe('0002_drop_note.sql');
    // gaps + unordered input still take (max + 1)
    expect(nextMigrationFilename(['0005_x.sql', '0002_y.sql'])).toBe('0006_update.sql');
  });

  it('sanitizes free-text labels to a safe slug', () => {
    expect(nextMigrationFilename([], 'Add Foo!! Bar')).toBe('0000_add_foo_bar.sql');
    expect(nextMigrationFilename([], '   ')).toBe('0000_update.sql');
    expect(nextMigrationFilename([], '__weird__')).toBe('0000_weird.sql');
  });

  it('ignores non-migration filenames when computing the next sequence', () => {
    expect(nextMigrationFilename(['README.md', 'meta', 'not-a-migration.sql'])).toBe(
      '0000_update.sql',
    );
  });
});
