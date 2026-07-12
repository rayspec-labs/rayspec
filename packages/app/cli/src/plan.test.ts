/**
 * `rayspec plan` — deterministic tests (no Postgres; shadow disabled).
 *
 * Proves the deploy FRONT-HALF composition (validate → diff → gate) without ever touching a DB:
 *  - a valid spec → ok, expected stores/routes/agents projection, NON-EMPTY migrationSql, gate clean;
 *  - an invalid spec → ok:false, phase:'validate', the parseSpec error list (no SQL generated);
 *  - the gate-BLOCKED path → breakingChangeBlocked:true, ok:false, phase:'gate' — exercised end-to-end
 *    via a crafted destructive migration over `scanMigrationSql` (the generator only emits additive
 *    SQL, so the destructive case is constructed at the scanner, mirroring migration-scan.test.ts) AND
 *    asserted at the `runPlan` projection level (the example spec is additive → not blocked);
 *  - shadowApplied:false when SHADOW_DATABASE_URL is unset (doctor-level validity still holds);
 *  - no secret leak in the output.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scanMigrationSql } from '@rayspec/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPlan } from './plan.js';

/** Repo root, relative to this test file (packages/cli/src → rayspec). */
const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
/** The neutral reference Product-YAML (read-only fixture): its projection counts must match its real sections. */
const ACME_YAML = readFileSync(
  join(REPO_ROOT, 'examples/acme-notes/acme-notes.product.yaml'),
  'utf8',
);
/** A small NON-audio Product-YAML fixture (support-triage): derives ONE collection store. */
const SUPPORT_TRIAGE_YAML = readFileSync(
  join(REPO_ROOT, 'packages/kernel/spec/src/__fixtures__/product/support-triage.product.yaml'),
  'utf8',
);
/** support-triage + a NEW persisted collection (`ticket_escalations`) — derives a SECOND store. */
const SUPPORT_TRIAGE_V2_YAML = (() => {
  const anchor =
    '  - kind: suggested_reply\n    label: Suggested reply\n    contract: support.suggested_reply\n    scope: ticket\n    collection: ticket_artifacts\n';
  const added =
    `${anchor}\n  - kind: escalation_note\n    label: Escalation note\n` +
    '    contract: support.suggested_reply\n    scope: ticket\n    collection: ticket_escalations\n' +
    '    lifecycle:\n      persist: true\n';
  return SUPPORT_TRIAGE_YAML.replace(anchor, added);
})();

const VALID_SPEC = `
version: '1.0'
metadata:
  name: plan-test
stores:
  - name: meetings
    columns:
      - { name: title, type: text }
      - { name: completed, type: boolean }
  - name: transcripts
    columns:
      - { name: meeting_id, type: uuid }
      - { name: body, type: text }
    foreignKeys:
      - { column: meeting_id, references: meetings, onDelete: cascade }
api:
  - { method: GET, path: '/meetings', action: { kind: store, store: meetings, op: list } }
  - { method: POST, path: '/meetings', action: { kind: store, store: meetings, op: create } }
agents:
  - id: summarizer
    name: summarizer
    backend: openai
    model: gpt-4o-mini
    instructions: Summarize.
tooling: []
handlers: []
triggers: []
`;

let dir: string;
let prevCwd: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayspec-plan-'));
  writeFileSync(join(dir, 'rayspec.yaml'), VALID_SPEC, 'utf8');
  prevCwd = process.cwd();
  process.chdir(dir);
});

afterAll(() => {
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe('plan — valid spec (front-half, no shadow)', () => {
  it('returns ok with the expected stores/routes/agents projection + non-empty migration SQL', async () => {
    const r = await runPlan(['rayspec.yaml'], { shadowDatabaseUrl: undefined });
    expect(r.ok).toBe(true);
    expect(r.phase).toBeUndefined();

    expect(r.stores.map((s) => s.name)).toEqual(['meetings', 'transcripts']);
    expect(r.stores.find((s) => s.name === 'transcripts')?.foreignKeys).toBe(1);

    expect(r.routes).toEqual([
      { method: 'GET', path: '/meetings', action: 'store' },
      { method: 'POST', path: '/meetings', action: 'store' },
    ]);

    expect(r.agents).toEqual([{ id: 'summarizer', backend: 'openai', model: 'gpt-4o-mini' }]);

    // Non-empty, reviewable migration SQL with the injected tenancy FK + a CREATE per store.
    expect(r.migrationSql).toContain('CREATE TABLE "meetings"');
    expect(r.migrationSql).toContain('CREATE TABLE "transcripts"');
    expect(r.migrationSql).toContain('tenant_id_orgs_id_fk');

    // The first materialization is purely additive — the gate is clean, nothing blocked.
    expect(r.gateFindings).toEqual([]);
    expect(r.breakingChangeBlocked).toBe(false);
    expect(r.shadowApplied).toBe(false);
    expect(r.errors).toEqual([]);
  });

  it('shadowApplied:false when SHADOW_DATABASE_URL is unset (validity still holds)', async () => {
    const r = await runPlan(['rayspec.yaml'], { shadowDatabaseUrl: undefined });
    expect(r.ok).toBe(true);
    expect(r.shadowApplied).toBe(false);
  });
});

describe('plan — Product-YAML docs', () => {
  it('a bare Product-YAML doc (no artifacts) validates with a zeroed product projection + no stores', async () => {
    writeFileSync(
      join(dir, 'p-ok.yaml'),
      'version: "1.0"\nproduct:\n  id: acme_bare\n  name: AcmeBare\n',
      'utf8',
    );
    const r = await runPlan(['p-ok.yaml'], { shadowDatabaseUrl: undefined });
    expect(r.ok).toBe(true);
    // No persisting artifacts / no stt step ⇒ NO derived stores ⇒ nothing to migrate.
    expect(r.stores).toEqual([]);
    expect(r.routes).toEqual([]);
    expect(r.agents).toEqual([]);
    expect(r.migrationSql).toBe('');
    expect(r.shadowApplied).toBe(false);
    expect(r.errors).toEqual([]);
    // The 0.2 projection is now REAL (all-zero here — the doc declares no sections).
    expect(r.product).toEqual({
      capabilities: 0,
      artifacts: 0,
      workflows: 0,
      views: 0,
      extractors: 0,
    });
  });

  it('an invalid Product-YAML doc aborts at validate with the Product-YAML SpecError list', async () => {
    writeFileSync(
      join(dir, 'p-bad.yaml'),
      'version: "1.0"\nproduct:\n  id: p\n  name: P\nworkflows:\n  - id: w\n    trigger: { capability: ghost, event: e }\n    steps:\n      - { id: s, type: capability, use: ghost.op }\n',
      'utf8',
    );
    const r = await runPlan(['p-bad.yaml'], { shadowDatabaseUrl: undefined });
    expect(r.ok).toBe(false);
    expect(r.phase).toBe('validate');
    expect(r.errors.map((e) => e.code)).toContain('dangling_ref');
    expect(r.migrationSql).toBe('');
  });
});

describe('plan — invalid spec aborts at validate', () => {
  it('returns ok:false, phase:validate, the parseSpec errors, no SQL', async () => {
    writeFileSync(
      join(dir, 'bad.yaml'),
      "version: '1.0'\nmetadata: { name: x }\nbogus: 1\n",
      'utf8',
    );
    const r = await runPlan(['bad.yaml'], { shadowDatabaseUrl: undefined });
    expect(r.ok).toBe(false);
    expect(r.phase).toBe('validate');
    expect(r.errors.map((e) => e.code)).toContain('unknown_field');
    expect(r.migrationSql).toBe('');
    expect(r.stores).toEqual([]);
  });
});

describe('plan — gate blocks an unreviewed destructive migration', () => {
  it('scanMigrationSql blocks a destructive statement without an allowlist entry (the gate wiring)', () => {
    // The generator only emits additive SQL, so the destructive case is constructed at the SCANNER
    // (mirrors migration-scan.test.ts). This is the exact function runPlan derives
    // `breakingChangeBlocked` from: pass:false ⇒ breakingChangeBlocked:true.
    const scan = scanMigrationSql('ALTER TABLE "meetings" DROP COLUMN "title";', []);
    expect(scan.pass).toBe(false);
    expect(scan.findings.some((f) => f.kind === 'drop-column' && !f.allowed)).toBe(true);
    // breakingChangeBlocked is defined as `!scan.pass` in runPlan.
    expect(!scan.pass).toBe(true);
  });

  it('an additive plan is NOT blocked (the gate has no false positive on a normal spec)', async () => {
    const r = await runPlan(['rayspec.yaml'], { shadowDatabaseUrl: undefined });
    expect(r.breakingChangeBlocked).toBe(false);
    expect(r.ok).toBe(true);
  });

  it('ND-1: a destructive migration is BLOCKED through runPlan and SHORT-CIRCUITS the shadow', async () => {
    // Drive the gate-BLOCKED branch through runPlan's OWN code path (not just the bare scanner) by
    // injecting a destructive DIFF, AND supply a shadow URL + a shadowApply SPY — proving the block
    // returns BEFORE the shadow runs (shadowApplied:false, the spy never called).
    let shadowCalls = 0;
    const r = await runPlan(['rayspec.yaml'], {
      shadowDatabaseUrl: 'postgres://u:p@shadow.host:5432/rayspec_shadow',
      generateSql: () => 'ALTER TABLE "meetings" DROP COLUMN "title";',
      shadowApply: async () => {
        shadowCalls += 1;
        return { ok: true, dbName: 'x' };
      },
    });
    expect(r.ok).toBe(false);
    expect(r.phase).toBe('gate');
    expect(r.breakingChangeBlocked).toBe(true);
    expect(r.shadowApplied).toBe(false);
    // The destructive statement DID flow through runPlan's gate (a real finding, not a no-op).
    expect(r.gateFindings.some((f) => f.kind === 'drop-column' && !f.allowed)).toBe(true);
    // The shadow was SHORT-CIRCUITED — the spy never ran.
    expect(shadowCalls).toBe(0);
  });
});

describe('plan — RO-1: refuse a shadow that targets the REAL DB (no admin connection opened)', () => {
  it('SHADOW_DATABASE_URL === DATABASE_URL → ok:false phase:shadow AND shadowApply is NEVER called', async () => {
    // Inject a shadowApply SPY: if RO-1 opens a connection / runs the shadow, the spy fires. The guard
    // must return ok:false phase:'shadow' WITHOUT ever calling it (so no admin connection is opened).
    let shadowCalls = 0;
    const same = 'postgres://u:p@db.internal:5432/rayspec';
    const r = await runPlan(['rayspec.yaml'], {
      databaseUrl: same,
      shadowDatabaseUrl: same,
      shadowApply: async () => {
        shadowCalls += 1;
        return { ok: true, dbName: 'x' };
      },
    });
    expect(r.ok).toBe(false);
    expect(r.phase).toBe('shadow');
    expect(r.shadowApplied).toBe(false);
    expect(r.errors[0]?.message).toMatch(/refusing to shadow-apply/i);
    // STRUCTURAL no-connection proof: the shadow-apply (the only thing that opens a connection) never ran.
    expect(shadowCalls).toBe(0);
    // No secret leak in the refusal.
    expect(JSON.stringify(r)).not.toContain('postgres://');
  });

  it('RO-1-PORT: same host + same db, one URL with :5432 and one WITHOUT → RO-1 fires (default port normalized)', async () => {
    // `postgres://db/rayspec` (no port ⇒ 5432) and `postgres://db:5432/rayspec` resolve to the SAME
    // real DB. Without default-port normalization RO-1 would NOT fire (port '' !== '5432') and the
    // shadow would run against the real DB. With it, the guard refuses and the spy is never called.
    let shadowCalls = 0;
    const r = await runPlan(['rayspec.yaml'], {
      databaseUrl: 'postgres://u:p@db.internal/rayspec', // no explicit port → 5432
      shadowDatabaseUrl: 'postgres://u:p@db.internal:5432/rayspec', // explicit 5432
      shadowApply: async () => {
        shadowCalls += 1;
        return { ok: true, dbName: 'x' };
      },
    });
    expect(r.ok).toBe(false);
    expect(r.phase).toBe('shadow');
    expect(r.shadowApplied).toBe(false);
    expect(r.errors[0]?.message).toMatch(/refusing to shadow-apply/i);
    // STRUCTURAL no-connection proof: the shadow-apply (the only thing that connects) never ran.
    expect(shadowCalls).toBe(0);
  });

  it('same host but a DIFFERENT db name (rayspec vs rayspec_shadow) does NOT trip RO-1', async () => {
    // The normal setup must still run the shadow — RO-1 only fires on the SAME db name.
    let shadowCalls = 0;
    const r = await runPlan(['rayspec.yaml'], {
      databaseUrl: 'postgres://u:p@db.internal:5432/rayspec',
      shadowDatabaseUrl: 'postgres://u:p@db.internal:5432/rayspec_shadow',
      shadowApply: async () => {
        shadowCalls += 1;
        return { ok: true, dbName: 'x' };
      },
    });
    // The guard did NOT fire — the shadow ran (the spy was called), and the plan is ok.
    expect(shadowCalls).toBe(1);
    expect(r.ok).toBe(true);
    expect(r.shadowApplied).toBe(true);
  });
});

// The RaySpec (0.1) update-mode fixtures: a base + an ADDITIVE (nullable) evolution + a
// DESTRUCTIVE (drop-column) evolution of the SAME store.
const UPD_BASE = `
version: '1.0'
metadata:
  name: upd-base
stores:
  - name: widgets
    columns:
      - { name: label, type: text }
      - { name: qty, type: integer }
`;
const UPD_ADDITIVE = `
version: '1.0'
metadata:
  name: upd-base
stores:
  - name: widgets
    columns:
      - { name: label, type: text }
      - { name: qty, type: integer }
      - { name: color, type: text, nullable: true }
`;
const UPD_DESTRUCTIVE = `
version: '1.0'
metadata:
  name: upd-base
stores:
  - name: widgets
    columns:
      - { name: label, type: text }
`;

describe('plan — update mode (--against): RaySpec 0.1 delta', () => {
  beforeAll(() => {
    writeFileSync(join(dir, 'upd-base.yaml'), UPD_BASE, 'utf8');
    writeFileSync(join(dir, 'upd-additive.yaml'), UPD_ADDITIVE, 'utf8');
    writeFileSync(join(dir, 'upd-destructive.yaml'), UPD_DESTRUCTIVE, 'utf8');
  });

  it('an ADDITIVE delta (new nullable column) is not blocked; updateMode + empty proposedAllowlist', async () => {
    const r = await runPlan(['upd-additive.yaml'], {
      against: 'upd-base.yaml',
      shadowDatabaseUrl: undefined,
    });
    expect(r.ok).toBe(true);
    expect(r.updateMode).toBe(true);
    expect(r.breakingChangeBlocked).toBe(false);
    expect(r.proposedAllowlist).toEqual([]);
    // The migration is the DELTA (an ADD COLUMN), not a first materialization (no CREATE TABLE).
    expect(r.migrationSql).toContain('ADD COLUMN "color"');
    expect(r.migrationSql).not.toContain('CREATE TABLE "widgets"');
    // The new store projection reflects the NEW spec (widgets with the added column).
    expect(r.stores.map((s) => s.name)).toEqual(['widgets']);
  });

  it('a DESTRUCTIVE delta (drop column) is BLOCKED without an allowlist; proposes a byte-faithful entry', async () => {
    const r = await runPlan(['upd-destructive.yaml'], {
      against: 'upd-base.yaml',
      shadowDatabaseUrl: undefined,
    });
    expect(r.ok).toBe(false);
    expect(r.phase).toBe('gate');
    expect(r.updateMode).toBe(true);
    expect(r.breakingChangeBlocked).toBe(true);
    expect(r.gateFindings.some((f) => f.kind === 'drop-column' && !f.allowed)).toBe(true);
    // The machine PROPOSES an allowlist entry for the exact destructive statement (review-required).
    expect(r.proposedAllowlist?.map((a) => a.kind)).toContain('drop-column');
    expect(r.proposedAllowlist?.[0]?.match).toContain('DROP COLUMN "qty"');
  });

  it('FAIL-THE-FIX: the machine-proposed allowlist, round-tripped through the --allowlist FILE, PASSES the real gate', async () => {
    // Run once to obtain the machine-proposed allowlist, write it VERBATIM to a JSON file, feed it back
    // through the CLI `--allowlist` layer, and assert the SAME destructive statement now PASSES — proving
    // the byte-fidelity survives JSON.stringify + the CLI file read (not just the in-memory diff object).
    const first = await runPlan(['upd-destructive.yaml'], {
      against: 'upd-base.yaml',
      shadowDatabaseUrl: undefined,
    });
    expect(first.breakingChangeBlocked).toBe(true);
    const allowlistPath = join(dir, 'reviewed-allowlist.json');
    writeFileSync(allowlistPath, JSON.stringify(first.proposedAllowlist), 'utf8');

    const second = await runPlan(['upd-destructive.yaml'], {
      against: 'upd-base.yaml',
      allowlist: 'reviewed-allowlist.json',
      shadowDatabaseUrl: undefined,
    });
    expect(second.ok).toBe(true);
    expect(second.breakingChangeBlocked).toBe(false);
    // The finding is now CLEARED (allowed) through the real scan, not merely absent.
    expect(second.gateFindings.every((f) => f.allowed)).toBe(true);
  });

  it('a cross-FAMILY --against (0.1 new vs 0.2 old) aborts at validate', async () => {
    writeFileSync(
      join(dir, 'old-product.yaml'),
      'version: "1.0"\nproduct:\n  id: p\n  name: P\n',
      'utf8',
    );
    const r = await runPlan(['upd-additive.yaml'], {
      against: 'old-product.yaml',
      shadowDatabaseUrl: undefined,
    });
    expect(r.ok).toBe(false);
    expect(r.phase).toBe('validate');
    expect(r.errors[0]?.message).toMatch(/does not match/i);
  });
});

describe('plan — --allowlist fail-closed validation', () => {
  async function planWithAllowlist(json: string) {
    writeFileSync(join(dir, 'bad-allowlist.json'), json, 'utf8');
    return runPlan(['upd-destructive.yaml'], {
      against: 'upd-base.yaml',
      allowlist: 'bad-allowlist.json',
      shadowDatabaseUrl: undefined,
    });
  }

  it('rejects non-JSON', async () => {
    const r = await planWithAllowlist('not json{');
    expect(r.ok).toBe(false);
    expect(r.phase).toBe('validate');
    expect(r.errors[0]?.message).toMatch(/not valid JSON/i);
  });

  it('rejects a non-array', async () => {
    const r = await planWithAllowlist('{"kind":"drop-column"}');
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.message).toMatch(/must be a JSON array/i);
  });

  it('rejects an unknown kind', async () => {
    const r = await planWithAllowlist('[{"kind":"nuke-everything","match":"x","reason":"y"}]');
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.message).toMatch(/known destructive kind/i);
  });

  it('rejects a missing reason', async () => {
    const r = await planWithAllowlist('[{"kind":"drop-column","match":"x"}]');
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.message).toMatch(/reason must be a non-empty string/i);
  });
});

describe('plan — update-mode RO-1: refuse a baseline-seeded shadow that targets the REAL DB', () => {
  it('additive update + SHADOW_DATABASE_URL === DATABASE_URL → refused, and shadowApplyBaselineUpdate is NEVER called', async () => {
    // The update-mode analogue of the first-materialize RO-1 proof (the shadowApply spy test above): an
    // ADDITIVE delta passes the gate and REACHES the shadow resolve, so RO-1 is the thing under test.
    // Inject the baseline-update spy — if RO-1 opened a connection / ran the shadow it would fire. The
    // guard must return ok:false phase:'shadow' WITHOUT ever calling it (no admin connection opened).
    let baselineCalls = 0;
    const same = 'postgres://u:p@db.internal:5432/rayspec';
    const r = await runPlan(['upd-additive.yaml'], {
      against: 'upd-base.yaml',
      databaseUrl: same,
      shadowDatabaseUrl: same,
      shadowApplyBaselineUpdate: async () => {
        baselineCalls += 1;
        return { ok: true, dbName: 'x', drift: [] };
      },
    });
    expect(r.ok).toBe(false);
    expect(r.phase).toBe('shadow');
    expect(r.updateMode).toBe(true);
    expect(r.shadowApplied).toBe(false);
    expect(r.errors[0]?.message).toMatch(/refusing to shadow-apply/i);
    // STRUCTURAL no-connection proof: the baseline-seeded shadow (the only thing that connects) never ran.
    expect(baselineCalls).toBe(0);
    // No secret leak in the refusal.
    expect(JSON.stringify(r)).not.toContain('postgres://');
  });

  it('additive update + DIFFERENT shadow db name → RO-1 does NOT fire, the baseline shadow RUNS (the spy fires once)', async () => {
    // The non-vacuous companion: same host, a DIFFERENT db name, so RO-1 must NOT fire and the
    // baseline-seeded shadow DOES run — proving the spy-never-called assertion above actually bites.
    let baselineCalls = 0;
    const r = await runPlan(['upd-additive.yaml'], {
      against: 'upd-base.yaml',
      databaseUrl: 'postgres://u:p@db.internal:5432/rayspec',
      shadowDatabaseUrl: 'postgres://u:p@db.internal:5432/rayspec_shadow',
      shadowApplyBaselineUpdate: async () => {
        baselineCalls += 1;
        return { ok: true, dbName: 'x', drift: [] };
      },
    });
    expect(baselineCalls).toBe(1);
    expect(r.ok).toBe(true);
    expect(r.shadowApplied).toBe(true);
  });
});

describe('plan — --allowlist requires --against (fail-closed on the inert combination)', () => {
  it('rejects --allowlist WITHOUT --against at validate (a reviewed allowlist is inert on a first materialization)', async () => {
    // Without --against there is no destructive delta for an allowlist to clear — the first-materialize
    // path never consults it, so an --allowlist here would be a SILENT no-op. Reject the combination.
    writeFileSync(join(dir, 'inert-allowlist.json'), '[]', 'utf8');
    const r = await runPlan(['rayspec.yaml'], {
      allowlist: 'inert-allowlist.json',
      shadowDatabaseUrl: undefined,
    });
    expect(r.ok).toBe(false);
    expect(r.phase).toBe('validate');
    expect(r.errors[0]?.message).toMatch(/--allowlist requires --against/i);
    // Fail-closed on the FLAG combination — nothing materialized.
    expect(r.migrationSql).toBe('');
  });

  it('--against + --allowlist together is accepted (the guard does not block the legitimate update path)', async () => {
    // The guard is scoped to the inert combination ONLY — a real update diff with a reviewed allowlist
    // (here empty, over an additive delta) proceeds normally.
    writeFileSync(join(dir, 'empty-allowlist.json'), '[]', 'utf8');
    const r = await runPlan(['upd-additive.yaml'], {
      against: 'upd-base.yaml',
      allowlist: 'empty-allowlist.json',
      shadowDatabaseUrl: undefined,
    });
    expect(r.errors.map((e) => e.message).join(' ')).not.toMatch(/--allowlist requires --against/i);
    expect(r.ok).toBe(true);
    expect(r.updateMode).toBe(true);
  });
});

describe('plan — Product-YAML (0.2) projections + update mode', () => {
  it('acme-notes.product.yaml: the projection counts match its REAL sections + derives the two Tier-A stores', async () => {
    writeFileSync(join(dir, 'acme-notes.yaml'), ACME_YAML, 'utf8');
    const r = await runPlan(['acme-notes.yaml'], { shadowDatabaseUrl: undefined });
    expect(r.ok).toBe(true);
    // A golden pin on the neutral reference product's section counts (breaks if acme-notes changes).
    expect(r.product).toEqual({
      capabilities: 6,
      artifacts: 6,
      workflows: 1,
      views: 4,
      extractors: 1,
    });
    // The derived Tier-A stores (the artifact collection + the transcript sink), like the boot path.
    expect(r.stores.map((s) => s.name).sort()).toEqual(['note_artifacts', 'track_transcripts']);
    // A 0.2 doc materializes no Tier-A routes/agents in the deploy front-half.
    expect(r.routes).toEqual([]);
    expect(r.agents).toEqual([]);
  });

  it('support-triage (non-audio): projects the collection store + the two DECLARED stores (S2) + its section counts', async () => {
    writeFileSync(join(dir, 'support-triage.yaml'), SUPPORT_TRIAGE_YAML, 'utf8');
    const r = await runPlan(['support-triage.yaml'], { shadowDatabaseUrl: undefined });
    expect(r.ok).toBe(true);
    expect(r.product).toEqual({
      capabilities: 4,
      artifacts: 2,
      workflows: 1,
      views: 1,
      extractors: 1,
    });
    // S2 (DELIBERATE pin evolution): the fixture now showcases the declared-stores vocabulary —
    // the plan projection derives the collection store PLUS the two `stores:` declarations.
    expect(r.stores.map((s) => s.name).sort()).toEqual([
      'reply_templates',
      'ticket_artifacts',
      'triage_log',
    ]);
    // The declared unique conflict key surfaces in the migration SQL (the upsert's backing index).
    expect(r.migrationSql).toContain('CREATE UNIQUE INDEX "reply_templates_template_code_unique"');
  });

  it('0.2 update mode: adding a new persisted collection yields an ADDITIVE derived-store delta', async () => {
    writeFileSync(join(dir, 'st-v1.yaml'), SUPPORT_TRIAGE_YAML, 'utf8');
    writeFileSync(join(dir, 'st-v2.yaml'), SUPPORT_TRIAGE_V2_YAML, 'utf8');
    const r = await runPlan(['st-v2.yaml'], {
      against: 'st-v1.yaml',
      shadowDatabaseUrl: undefined,
    });
    expect(r.ok).toBe(true);
    expect(r.updateMode).toBe(true);
    expect(r.breakingChangeBlocked).toBe(false);
    // The new store shows up in the projection AND the delta CREATEs exactly it (additive).
    // (S2 DELIBERATE pin evolution: the fixture's two DECLARED stores ride in the projection.)
    expect(r.stores.map((s) => s.name).sort()).toEqual([
      'reply_templates',
      'ticket_artifacts',
      'ticket_escalations',
      'triage_log',
    ]);
    expect(r.migrationSql).toContain('CREATE TABLE "ticket_escalations"');
    expect(r.migrationSql).not.toContain('CREATE TABLE "ticket_artifacts"'); // the survivor is untouched
  });

  it('S2: adding a DECLARED store yields an ADDITIVE delta through the SAME diff surface (plan --against)', async () => {
    // v1 = the committed fixture; v2 = + ONE more declared store (unreferenced is legal — it
    // derives + materializes like any store). diffProductStores must CREATE exactly the addition
    // (with the key's backing unique index) and leave every survivor untouched.
    const added =
      `  - name: escalation_queue\n` +
      `    columns:\n` +
      `      - { name: queue_ref, type: text }\n` +
      `      - { name: reason, type: text, nullable: true }\n` +
      `    key: [queue_ref]\n`;
    const v2 = SUPPORT_TRIAGE_YAML.replace('\ncontracts:\n', `${added}\ncontracts:\n`);
    writeFileSync(join(dir, 'st-s2-v1.yaml'), SUPPORT_TRIAGE_YAML, 'utf8');
    writeFileSync(join(dir, 'st-s2-v2.yaml'), v2, 'utf8');
    const r = await runPlan(['st-s2-v2.yaml'], {
      against: 'st-s2-v1.yaml',
      shadowDatabaseUrl: undefined,
    });
    expect(r.ok).toBe(true);
    expect(r.updateMode).toBe(true);
    expect(r.breakingChangeBlocked).toBe(false);
    expect(r.migrationSql).toContain('CREATE TABLE "escalation_queue"');
    expect(r.migrationSql).toContain('CREATE UNIQUE INDEX "escalation_queue_queue_ref_unique"');
    expect(r.migrationSql).not.toContain('CREATE TABLE "reply_templates"'); // survivors untouched
    expect(r.migrationSql).not.toContain('CREATE TABLE "triage_log"');

    // And the REMOVAL direction: v1→v2 reversed proposes dropping exactly the declared store.
    const rev = await runPlan(['st-s2-v1.yaml'], {
      against: 'st-s2-v2.yaml',
      shadowDatabaseUrl: undefined,
    });
    expect(rev.ok).toBe(false); // destructive without an allowlist — BLOCKED (the gate)
    expect(rev.breakingChangeBlocked).toBe(true);
  });

  it('DX-v1.2 FINDING-2: a PRODUCT update THREADS the derived conflict keys to the baseline-seeded shadow (arms the plan-time oracle)', async () => {
    // Minimal product with a declared store: `serial_no` is a plain author-unique (tenant-scoped
    // compound), `sku` is the durable `key` (single-column). deriveConflictKeys ⇒ {catalog: {sku}} — the
    // exact set the plan MUST pass to shadowApplyBaselineUpdate so its oracle enforces the right index
    // shape. Fail-the-fix: drop the `inp.newConflictKeys` passthrough in planStores and the spy sees
    // `undefined` → RED.
    const catOld = `version: '1.0'
product:
  id: catalog_app
  name: Catalog App
stores:
  - name: catalog
    columns:
      - { name: serial_no, type: text, unique: true }
      - { name: sku, type: text }
    key: [sku]
`;
    // An ADDITIVE delta (a new nullable column) → not gate-blocked → the shadow spy is reached.
    const catNew = catOld.replace(
      '    key: [sku]\n',
      '      - { name: label, type: text, nullable: true }\n    key: [sku]\n',
    );
    writeFileSync(join(dir, 'cat-old.yaml'), catOld, 'utf8');
    writeFileSync(join(dir, 'cat-new.yaml'), catNew, 'utf8');
    let seenConflictKeys: unknown = 'NOT_CALLED';
    const r = await runPlan(['cat-new.yaml'], {
      against: 'cat-old.yaml',
      databaseUrl: 'postgres://u:p@db.internal:5432/rayspec',
      shadowDatabaseUrl: 'postgres://u:p@db.internal:5432/rayspec_shadow',
      shadowApplyBaselineUpdate: async (_url, _base, _delta, _stores, newConflictKeys) => {
        seenConflictKeys = newConflictKeys;
        return { ok: true, dbName: 'x', drift: [] };
      },
    });
    expect(r.ok).toBe(true);
    expect(r.shadowApplied).toBe(true);
    expect(r.breakingChangeBlocked).toBe(false);
    // The plan THREADED the derived per-store conflict keys (durable `sku` stays a single-column target).
    expect(seenConflictKeys).toBeInstanceOf(Map);
    const cat = (seenConflictKeys as Map<string, ReadonlySet<string>>).get('catalog');
    expect(cat).toBeDefined();
    expect(cat ? [...cat] : []).toEqual(['sku']);
  });
});

describe('plan — no --against byte-stability golden (0.1 first materialization)', () => {
  it('the 0.1 first-materialization output carries EXACTLY the classic keys (no update/product fields)', async () => {
    const r = await runPlan(['rayspec.yaml'], { shadowDatabaseUrl: undefined });
    // The exact, ordered key set of the pre-S2 envelope — no additive field leaks onto this path.
    expect(Object.keys(r)).toEqual([
      'ok',
      'stores',
      'migrationSql',
      'routes',
      'agents',
      'gateFindings',
      'gateSummary',
      'breakingChangeBlocked',
      'shadowApplied',
      'errors',
    ]);
    // The additive S2 fields are ABSENT (undefined) on this path — the serialized bytes are unchanged.
    const json = JSON.stringify(r);
    for (const k of ['updateMode', 'product', 'proposedAllowlist', 'notes', 'driftFindings']) {
      expect(json).not.toContain(`"${k}"`);
    }
    expect(r.updateMode).toBeUndefined();
    expect(r.product).toBeUndefined();
  });
});

describe('plan — no secret leak', () => {
  it('output never contains DB-URL / credential substrings even with secrets in env', async () => {
    // Save + restore the ambient env so this test never leaks a fake URL into a later DB-backed test.
    const prevDb = process.env.DATABASE_URL;
    const prevShadow = process.env.SHADOW_DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://secretuser:secretpass@db.internal:5432/prod';
    process.env.SHADOW_DATABASE_URL = 'postgres://shadowuser:shadowpass@db.internal:5432/shadow';
    try {
      // Pass shadow explicitly as undefined so this stays a no-DB test (does not connect).
      const json = JSON.stringify(
        await runPlan(['rayspec.yaml'], { shadowDatabaseUrl: undefined }),
      );
      expect(json).not.toContain('secretpass');
      expect(json).not.toContain('shadowpass');
      expect(json).not.toContain('postgres://');
    } finally {
      // Delete (don't assign the string "undefined") so the env is truly unset — match index.test.ts.
      if (prevDb === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDb;
      if (prevShadow === undefined) delete process.env.SHADOW_DATABASE_URL;
      else process.env.SHADOW_DATABASE_URL = prevShadow;
    }
  });
});
