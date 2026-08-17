/**
 * BACKEND-PROFILE RESTART acceptance — the migration decision a leftover `RAYSPEC_UPDATE_MIGRATION`
 * forces on EVERY boot, driven through the REAL composition root (`assembleServer` + the
 * `updateMigrations` seam) against throwaway DATABASEs, and measured in ROWS.
 *
 * ── Why this file exists beside update-mode.db.test.ts ──────────────────────────────────────────
 * Both profiles route their update boot through the SAME `planUpdateBoot`: the product profile
 * (`product-boot.ts`) and the backend profile (`composition-root.ts`). The wrapper arms next door
 * already prove the backend profile's update LIFECYCLE — materialize, additive update, blocked,
 * applied, incomplete — but every one of their reboot arms drops `updateMigrations` (the ordinary
 * reboot path). NONE of them boots twice with the update env STILL SET.
 *
 * That is the one shape the whole `present-matching` probe exists for: a process manager
 * (systemd/docker `Restart=always`) re-enters update mode on every restart with the same delta, and
 * the boot has to decide — from the live schema alone — whether that delta already ran. The defects
 * this surface has taken were not in the decision itself; they were in what each caller HANDS the
 * decision, and one of them turned a fail-closed refusal into a destructive re-apply that no routing
 * assertion could see: the route reads the same whether the boot then serves or dies. Only counting
 * rows across restarts separates them. So every arm below boots THREE times with the env present and
 * asserts the row count at each step.
 *
 * ── The arms (a SEPARATE throwaway DATABASE per arm — no cross-arm coupling) ────────────────────
 *   A. NEVER APPLIED   — v1 schema + the reviewed v1→v2 additive delta. Boot 1 is `drifted` → APPLIES
 *      → LEFTOVER        ('updated'); the served app then writes a row carrying the new column. Boots
 *                        2 and 3 re-enter update mode with the IDENTICAL env: the schema now
 *                        present-matches, the probe finds the delta's own column PRESENT, and both
 *                        MOUNT without re-applying. Rows 1 → 2 → 2 → 2, colours intact.
 *   B. LEFTOVER FROM   — the same delta against a database already AT v2 (the operator never removed
 *      BOOT ONE          the flag after the previous deployment). All THREE boots MOUNT — boot 1 too,
 *                        which is what distinguishes this from A. Rows untouched throughout.
 *   C. RECYCLED NAME   — a reviewed delta that FREES a name and PUTS IT BACK in one statement
 *      (undecidable)     (`ALTER TABLE "widgets" DROP COLUMN "color", ADD COLUMN "color" text`). The
 *                        live schema holds `color` whether or not the delta ran, so the boot can claim
 *                        NOTHING: it MOUNTS on all three boots and the column's DATA survives. Read by
 *                        its first clause alone this wiped the column on every restart, while the
 *                        identical change written as two statements mounted.
 *   D. HALF LANDED     — a reviewed `SET NOT NULL` over a column the drift check INTROSPECTS (landed:
 *      → REFUSED         reaching `present-matching` measured it) beside a hand-shaped `CREATE INDEX`
 *                        that is NOT there (un-landed). The boot REFUSES fail-closed with a
 *                        ProductBootError naming both sides, on all three boots, and the schema is
 *                        untouched. **This arm is the caller-wiring accept control**: its landed half
 *                        comes ONLY from the `driftInspectedColumns(specStores)` argument
 *                        `composition-root.ts` passes. Hand the backend profile an empty inspected set
 *                        and the landed pile empties, the route becomes APPLY, the boot serves, and
 *                        this arm goes RED — which is what makes it a test of the CALLER rather than
 *                        of `planUpdateBoot`, whose own decision is covered by its unit arms.
 *
 * The specs are the same minimal `widgets` shape update-mode.db.test.ts uses (a store + create/get
 * routes; NO durableWorker, NO agents), deliberately: no DBOS singleton is launched, which is what
 * makes several real boots in one process legal here at all.
 *
 * UN-SKIPPABLE RAN-GUARD (the DB-backed false-green class): a DB-backed proof must never SILENTLY
 * self-skip. A separate, NON-skipped describe hard-FAILS when the DB is REQUIRED
 * (CI / RAYSPEC_REQUIRE_DB_TESTS) but the arms did not run.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffProductStores } from '@rayspec/db';
import { registerScopedTables } from '@rayspec/db/testing';
import {
  assembleServer,
  type BootedServer,
  loadServerConfig,
  type PlannedMigration,
  ProductBootError,
} from '@rayspec/server';
import { parseSpec, type RaySpec } from '@rayspec/spec';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readUpdateMigrations } from './serve.js';

// ── The two spec versions, IDENTICAL in shape to update-mode.db.test.ts's v1/v2 ──────────────────
// (a `widgets` store gaining one nullable `color`), so the restart arms here and the lifecycle arms
// there cannot drift into evolving different stores.
//
// Deliberately NOT shared with the product-profile arms in `@rayspec/server` / `@rayspec/cli`. Those
// hand-author their deltas as local SQL constants; the wrapper arms GENERATE theirs from a spec pair
// through `diffProductStores`. Two independent constructions arriving at the same behaviour is a
// property worth keeping — collapsing them onto one imported constant would leave one construction
// and a second call site, which is weaker coverage, not stronger. The guard against the two sides
// testing different BEHAVIOUR is that they assert the same outcomes for named shapes (a never-applied
// delta applies then mounts; a recycled name claims nothing; a half-landed delta refuses), not that
// they import the same string.
const V1_YAML = `
version: '1.0'
metadata:
  name: update-restart-test
  description: v1 — widgets with a name only
stores:
  - name: widgets
    columns:
      - { name: name, type: text }
api:
  - { method: POST, path: '/widgets', action: { kind: store, store: widgets, op: create } }
  - { method: GET, path: '/widgets/{id}', action: { kind: store, store: widgets, op: get } }
`;

const V2_YAML = `
version: '1.0'
metadata:
  name: update-restart-test
  description: v2 — widgets gains a nullable color (ADDITIVE)
stores:
  - name: widgets
    columns:
      - { name: name, type: text }
      - { name: color, type: text, nullable: true }
api:
  - { method: POST, path: '/widgets', action: { kind: store, store: widgets, op: create } }
  - { method: GET, path: '/widgets/{id}', action: { kind: store, store: widgets, op: get } }
`;

/**
 * Arm C's delta: ONE statement that frees a name and puts it back. The live schema holds
 * `widgets.color` before it and after it, so nothing in the schema tells the two states apart — the
 * documented undecidable shape. Hand-authored rather than diffed, because no spec PAIR produces it:
 * it is what an operator writes to rebuild a column in place.
 */
const RECYCLE_COLOR_SQL = 'ALTER TABLE "widgets" DROP COLUMN "color", ADD COLUMN "color" text;';

/**
 * Arm D's delta. The `SET NOT NULL` is over `widgets.name`, which the spec DECLARES and the drift
 * check therefore introspects — so reaching `present-matching` is itself the measurement that it ran
 * (unapplied, the live nullability would have differed and classified `drifted`). The index is
 * hand-shaped: the store grammar cannot express it, so `detectDrift` never looks for it and the
 * classification reads drift-clean whether or not it is there. Landed beside un-landed ⇒ half landed.
 *
 * THE PAIR IS THE POINT, and the next person to touch this will be tempted to drop half of it. A
 * reviewed `SET NOT NULL` ALONE cannot serve as the caller-wiring control: with nothing un-landed
 * beside it the route is `mount` whether or not the classify-derived evidence is there, and the only
 * thing the caller's argument moves is the wording of the mount log. Pairing it with an object the
 * delta CREATEs and the schema does NOT have puts landed and un-landed evidence in one delta, so the
 * argument decides between `refuse-half-landed` (the boot never serves) and `apply` (it serves and
 * re-applies) — a difference observable from OUTSIDE the function. Anything visible only inside it is
 * already covered by `planUpdateBoot`'s own unit arms, and a control that cannot fail is the defect
 * class this whole surface keeps producing.
 */
const HAND_INDEX = 'widgets_name_hand_idx';
const HALF_LANDED_SQL =
  'ALTER TABLE "widgets" ALTER COLUMN "name" SET NOT NULL;\n' +
  '--> statement-breakpoint\n' +
  `CREATE INDEX "${HAND_INDEX}" ON "widgets" ("name");`;

function parseValid(yaml: string): RaySpec {
  const r = parseSpec(yaml);
  if (!r.ok) throw new Error(`fixture invalid: ${r.errors.map((e) => e.message).join('; ')}`);
  return r.value;
}

function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}
function withDbName(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

const EMAIL = 'restart@example.test';
const PASSWORD = 'correct-horse-battery-staple-9';
const ARM_COUNT = 4;

let armsRan = 0;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';

describe('local-boot update mode — the RESTART decision, measured in rows', () => {
  const baseUrl = process.env.DATABASE_URL;
  const maybe = baseUrl ? it : it.skip;

  let tmpDir = '';
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
  ] as const;

  let v1Path = '';
  let v2Path = '';
  /** Every database this file created, dropped in afterAll even if an arm threw. */
  const createdDbs: string[] = [];

  beforeAll(async () => {
    if (!baseUrl) return;
    tmpDir = mkdtempSync(join(tmpdir(), 'rayspec-restart-'));
    v1Path = join(tmpDir, 'v1.yaml');
    v2Path = join(tmpDir, 'v2.yaml');
    writeFileSync(v1Path, V1_YAML, 'utf8');
    writeFileSync(v2Path, V2_YAML, 'utf8');

    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    // A dev RS256 signer as a PKCS#8 PEM — via node:crypto so this harness needs no jose dependency.
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.RAYSPEC_JWT_SIGNING_KEY = privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    process.env.RAYSPEC_API_KEY_PEPPER = 'local-restart-pepper-only';
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8807';
  }, 120_000);

  afterAll(async () => {
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    if (!baseUrl) return;
    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      for (const db of createdDbs) {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
      }
    } finally {
      await admin.end();
    }
  }, 120_000);

  /** A fresh throwaway database for ONE arm, registered for teardown, made the process's DB. */
  async function freshDb(tag: string): Promise<string> {
    const name = `rayspec_restart_${tag}_${process.pid}`;
    const admin = postgres(adminUrl(baseUrl as string), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${name}"`);
    } finally {
      await admin.end();
    }
    createdDbs.push(name);
    const url = withDbName(baseUrl as string, name);
    process.env.DATABASE_URL = url;
    return url;
  }

  /** Boot the REAL composition root. `updateMigrations` present ⇒ UPDATE mode (the backend profile). */
  async function boot(
    specPath: string,
    updateMigrations?: PlannedMigration[],
  ): Promise<BootedServer> {
    process.env.RAYSPEC_SPEC_PATH = specPath;
    return assembleServer(loadServerConfig(), {
      registerProductTables: (tables) => registerScopedTables([...tables.values()]),
      ...(updateMigrations ? { updateMigrations } : {}),
    });
  }

  /** GROUND TRUTH, straight off the catalog — how many widget rows exist right now. */
  async function widgetRows(dbUrl: string): Promise<number> {
    const c = postgres(dbUrl, { max: 1 });
    try {
      const rows = await c`select count(*)::int as n from widgets`;
      return (rows[0] as { n: number }).n;
    } finally {
      await c.end();
    }
  }

  /** GROUND TRUTH — the stored `color` values by name, so a wiped column shows up as lost DATA. */
  async function widgetColors(dbUrl: string): Promise<(string | null)[]> {
    const c = postgres(dbUrl, { max: 1 });
    try {
      const rows = await c`select color from widgets order by name`;
      return rows.map((r) => (r as { color: string | null }).color);
    } finally {
      await c.end();
    }
  }

  async function indexExists(dbUrl: string, name: string): Promise<boolean> {
    const c = postgres(dbUrl, { max: 1 });
    try {
      const rows = await c`select 1 from pg_indexes where indexname = ${name}`;
      return rows.length > 0;
    } finally {
      await c.end();
    }
  }

  /** The v(old)→v(new) delta a reviewed update authors, through the wrapper's REAL reader. */
  function diffDelta(oldYaml: string, newYaml: string, base: string): PlannedMigration[] {
    const diff = diffProductStores(parseValid(oldYaml).stores, parseValid(newYaml).stores, {
      label: base,
    });
    const sqlPath = join(tmpDir, `${base}.sql`);
    writeFileSync(sqlPath, diff.migrationSql, 'utf8');
    const allowlistPath = join(tmpDir, `${base}.allowlist.json`);
    writeFileSync(allowlistPath, JSON.stringify(diff.proposedAllowlist, null, 2), 'utf8');
    return readUpdateMigrations({ migrationPath: sqlPath, allowlistPath });
  }

  /** A hand-authored delta + its reviewed allowlist, through the SAME wrapper reader. */
  function handDelta(
    sql: string,
    base: string,
    allowlist: readonly { kind: string; match: string; reason: string }[],
  ): PlannedMigration[] {
    const sqlPath = join(tmpDir, `${base}.sql`);
    writeFileSync(sqlPath, sql, 'utf8');
    const allowlistPath = join(tmpDir, `${base}.allowlist.json`);
    writeFileSync(allowlistPath, JSON.stringify(allowlist, null, 2), 'utf8');
    return readUpdateMigrations({ migrationPath: sqlPath, allowlistPath });
  }

  /**
   * Register the one account, create an org, switch into it — returns a scoped token AND the org id,
   * because registration is once per email per database: a LATER boot of the same database logs in
   * ({@link loginSwitch}) rather than registering again.
   */
  async function registerCreateOrgSwitch(
    server: BootedServer,
  ): Promise<{ token: string; orgId: string }> {
    const reg = await server.app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    expect(reg.status).toBe(201);
    const t0 = (await reg.json()).accessToken as string;
    const orgRes = await server.app.request('/v1/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t0}` },
      body: JSON.stringify({ name: 'Restart Co' }),
    });
    expect(orgRes.status).toBe(201);
    const newOrgId = (await orgRes.json()).id as string;
    const sw = await server.app.request(`/v1/orgs/${newOrgId}/switch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t0}` },
    });
    expect(sw.status).toBe(200);
    return { token: (await sw.json()).accessToken as string, orgId: newOrgId };
  }

  /** Log the same account back in on a LATER boot of the same database, scoped to the same org. */
  async function loginSwitch(server: BootedServer, targetOrgId: string): Promise<string> {
    const login = await server.app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const t0 = (await login.json()).accessToken as string;
    const sw = await server.app.request(`/v1/orgs/${targetOrgId}/switch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t0}` },
    });
    expect(sw.status).toBe(200);
    return (await sw.json()).accessToken as string;
  }

  /** Write one widget through the SERVED app — the row a restart must not destroy. */
  async function createWidget(
    server: BootedServer,
    token: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const res = await server.app.request('/widgets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
  }

  maybe(
    '(A) a NEVER-APPLIED delta APPLIES on boot 1, then MOUNTS on every restart with the env still set',
    async () => {
      armsRan++;
      const dbUrl = await freshDb('a');
      const delta = diffDelta(V1_YAML, V2_YAML, 'a_v1_to_v2');

      // Boot 0 — materialize v1 and seed one row through the served app.
      let orgId = '';
      const b0 = await boot(v1Path);
      try {
        expect(b0.deployMode).toBe('materialized');
        const session = await registerCreateOrgSwitch(b0);
        orgId = session.orgId;
        await createWidget(b0, session.token, { name: 'aaa-seed' });
      } finally {
        await b0.close();
      }
      expect(await widgetRows(dbUrl)).toBe(1);

      // Boot 1 — the delta has NOT run: the live schema is drifted against v2 → APPLY. The served app
      // then writes a second row, this one carrying the column the delta added.
      const b1 = await boot(v2Path, delta);
      try {
        expect(b1.deployMode).toBe('updated');
        await createWidget(b1, await loginSwitch(b1, orgId), {
          name: 'bbb-after-update',
          color: 'red',
        });
      } finally {
        await b1.close();
      }
      expect(await widgetRows(dbUrl)).toBe(2);
      expect(await widgetColors(dbUrl)).toEqual([null, 'red']);

      // Boots 2 and 3 — the IDENTICAL env, as a `Restart=always` unit re-enters it. The schema now
      // present-matches v2 and the probe finds the delta's own column PRESENT ⇒ MOUNT, no DDL, no
      // re-apply. The row count is the assertion that matters: re-applying would have to re-run
      // `ADD COLUMN "color"` (42701, the boot never serves) or take the column away with its data.
      for (const n of [2, 3]) {
        const b = await boot(v2Path, delta);
        try {
          expect(b.deployMode, `boot ${n} must MOUNT, not re-apply`).toBe('mounted');
        } finally {
          await b.close();
        }
        expect(await widgetRows(dbUrl), `rows after boot ${n}`).toBe(2);
        expect(await widgetColors(dbUrl), `colors after boot ${n}`).toEqual([null, 'red']);
      }
    },
    240_000,
  );

  maybe(
    '(B) a LEFTOVER env on an already-updated database MOUNTS on boot ONE, and on both restarts',
    async () => {
      armsRan++;
      const dbUrl = await freshDb('b');
      const delta = diffDelta(V1_YAML, V2_YAML, 'b_v1_to_v2');

      // Boot 0 — materialize v2 DIRECTLY: the database is already in the state the delta leaves it in,
      // which is what an operator has after a previous deployment they never cleared the flag from.
      const b0 = await boot(v2Path);
      try {
        expect(b0.deployMode).toBe('materialized');
        const { token } = await registerCreateOrgSwitch(b0);
        await createWidget(b0, token, { name: 'aaa-seed', color: 'blue' });
        await createWidget(b0, token, { name: 'bbb-second', color: 'green' });
      } finally {
        await b0.close();
      }
      expect(await widgetRows(dbUrl)).toBe(2);

      // Boots 1, 2 and 3 all carry the stale delta. Unlike (A), boot ONE already mounts — the delta's
      // object is present, so there is nothing un-landed and nothing to apply.
      for (const n of [1, 2, 3]) {
        const b = await boot(v2Path, delta);
        try {
          expect(b.deployMode, `boot ${n} must MOUNT a leftover env`).toBe('mounted');
        } finally {
          await b.close();
        }
        expect(await widgetRows(dbUrl), `rows after boot ${n}`).toBe(2);
        expect(await widgetColors(dbUrl), `colors after boot ${n}`).toEqual(['blue', 'green']);
      }
    },
    240_000,
  );

  maybe(
    '(C) a RECYCLED-NAME delta is undecidable, so every restart MOUNTS and the column keeps its data',
    async () => {
      armsRan++;
      const dbUrl = await freshDb('c');
      // Reviewed: the DROP half of the recycle needs an entry, exactly as an operator would author it.
      const delta = handDelta(RECYCLE_COLOR_SQL, 'c_recycle_color', [
        {
          kind: 'drop-column',
          match: RECYCLE_COLOR_SQL.replace(/;$/, ''),
          reason: 'reviewed: rebuild the color column in place',
        },
      ]);

      const b0 = await boot(v2Path);
      try {
        expect(b0.deployMode).toBe('materialized');
        const { token } = await registerCreateOrgSwitch(b0);
        await createWidget(b0, token, { name: 'aaa-seed', color: 'blue' });
        await createWidget(b0, token, { name: 'bbb-second', color: 'green' });
      } finally {
        await b0.close();
      }
      expect(await widgetColors(dbUrl)).toEqual(['blue', 'green']);

      // The live schema holds `color` whether or not this delta ran, so the boot claims NOTHING and
      // MOUNTS — every time. Re-applying would drop the column and its data on each restart; the
      // colours below are the assertion that it did not.
      for (const n of [1, 2, 3]) {
        const b = await boot(v2Path, delta);
        try {
          expect(b.deployMode, `boot ${n} must MOUNT an undecidable delta`).toBe('mounted');
        } finally {
          await b.close();
        }
        expect(await widgetRows(dbUrl), `rows after boot ${n}`).toBe(2);
        expect(await widgetColors(dbUrl), `colors after boot ${n}`).toEqual(['blue', 'green']);
      }
    },
    240_000,
  );

  maybe(
    '(D) a HALF-LANDED delta is REFUSED fail-closed on every restart — and this arm measures the CALLER',
    async () => {
      armsRan++;
      const dbUrl = await freshDb('d');
      const delta = handDelta(HALF_LANDED_SQL, 'd_half_landed', [
        {
          kind: 'set-not-null',
          match: 'ALTER TABLE "widgets" ALTER COLUMN "name" SET NOT NULL',
          reason: 'reviewed: name is already non-nullable in the spec',
        },
      ]);

      // Boot 0 — materialize v1. `name` is declared non-nullable, so the live column is already
      // NOT NULL: the `SET NOT NULL` half of the delta is in the state an applied delta leaves it in,
      // and the drift check INTROSPECTS that column. The hand-shaped index is absent and invisible
      // to the drift check, so the classification is `present-matching` all the same.
      const b0 = await boot(v1Path);
      try {
        expect(b0.deployMode).toBe('materialized');
        await createWidget(b0, (await registerCreateOrgSwitch(b0)).token, { name: 'aaa-seed' });
      } finally {
        await b0.close();
      }
      expect(await widgetRows(dbUrl)).toBe(1);
      expect(await indexExists(dbUrl, HAND_INDEX)).toBe(false);

      // Landed (the classify measured the SET NOT NULL) beside un-landed (the index is not there) is
      // HALF LANDED: it can be neither re-applied nor called applied, so the boot refuses. No restart
      // clears it — that is the point of fail-closed — and the schema is untouched each time.
      //
      // ACCEPT CONTROL: the landed half exists ONLY because `composition-root.ts` passes
      // `driftInspectedColumns(specStores)`. Hand the backend profile an empty set and `proven` is
      // empty, nothing is landed, the route becomes `apply`, the boot SERVES, and this arm fails —
      // which is what makes it a measurement of the caller's wiring rather than of the router.
      for (const n of [1, 2, 3]) {
        const err = await boot(v1Path, delta).then(
          (s) => {
            void s.close();
            return null;
          },
          (e: unknown) => e,
        );
        expect(err, `boot ${n} must REFUSE, not serve`).toBeInstanceOf(ProductBootError);
        const message = (err as Error).message;
        expect(message).toContain('HALF LANDED');
        expect(message).toContain('set-not-null');
        expect(message).toContain(HAND_INDEX);
        // GROUND TRUTH: the refusal ran no DDL — the index the delta names is still absent, and the
        // seeded row is still there.
        expect(await indexExists(dbUrl, HAND_INDEX), `index after boot ${n}`).toBe(false);
        expect(await widgetRows(dbUrl), `rows after boot ${n}`).toBe(1);
      }
    },
    240_000,
  );
});

/**
 * The ran-guard. `armsRan` is incremented by each arm; a suite whose setup throws-and-skips leaves it
 * at 0 and THIS test FAILS when the DB is required. A local dev with no DB and no opt-in skips.
 */
describe('local-boot restart decision — ran-guard (the restart proof must not silently skip)', () => {
  it('the restart arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      expect(armsRan).toBe(ARM_COUNT);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
