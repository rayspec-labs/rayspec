/**
 * Generalized shadow-dryrun — PRODUCT-table invariants.
 *
 * `shadow-dryrun.sh` applies the PLATFORM chain (core-only) to a throwaway DB and asserts the platform
 * end state. The PLATFORM chain carries NO product tables (binding topology: product-empty
 * baseline), so the generic, spec-derived PRODUCT-table invariants are exercised here on a SEPARATE
 * throwaway DB seeded with the orgs root + the THROWAWAY-generated product migration.
 *
 * This script:
 *   1. parses the throwaway `examples/acme-notes-backend/rayspec.yaml` -> stores[];
 *   2. on the throwaway product DB (passed as DRYRUN_PRODUCT_URL), asserts the GENERIC invariant for
 *      EVERY product table: it has a `tenant_id` FK -> orgs with ON DELETE CASCADE, AND the cascade
 *      ACTUALLY removes product rows on an org delete (a live insert -> delete-org -> count==0);
 *   3. META: asserts the generated product-table assertions are NON-EMPTY (a vacuous
 *      pass — zero product tables, zero assertions — FAILS, so the dry-run cannot be blind).
 *
 * The orgs root + the throwaway product migration are applied by shadow-dryrun.sh before this runs;
 * this script only ASSERTS (it does not migrate). It exits non-zero on the first failed assertion.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpec, type StoreSpec } from '@rayspec/spec';
import postgres from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));
const YAML_PATH = resolve(here, '../../../../examples/acme-notes-backend/rayspec.yaml');

/** A minimal per-store seed sufficient to insert one row (business NOT-NULL columns + FK parents). */
function seedValues(store: StoreSpec, parentId: string | undefined): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const fkCols = new Set(store.foreignKeys.map((fk) => fk.column));
  for (const col of store.columns) {
    if (fkCols.has(col.name)) {
      row[col.name] = parentId;
      continue;
    }
    if (col.nullable) continue; // nullable business columns can be omitted
    switch (col.type) {
      case 'text':
        row[col.name] = 'x';
        break;
      case 'uuid':
        row[col.name] = '00000000-0000-0000-0000-0000000000ff';
        break;
      case 'timestamp':
        row[col.name] = new Date().toISOString();
        break;
      case 'integer':
        row[col.name] = 0;
        break;
      case 'boolean':
        row[col.name] = false;
        break;
      case 'jsonb':
        row[col.name] = {};
        break;
    }
  }
  return row;
}

/** Run the SQL the unparameterizable identifiers force; thin wrapper over postgres-js unsafe. */
type Sql = ReturnType<typeof postgres>;

/**
 * Run the generic product-table invariants against an already-migrated product DB (`sql`) for
 * `stores`. Returns the count of tables asserted. THROWS on a failed invariant AND on a vacuous run
 * (zero stores -> zero assertions) — the non-vacuity guard. Exported so a unit test
 * can prove the guard fires for an empty spec without spinning up the bash dry-run.
 */
export async function runProductAssertions(sql: Sql, stores: StoreSpec[]): Promise<number> {
  let asserted = 0;
  {
    // The tenant org the seed rows belong to.
    const tenantId = '00000000-0000-0000-0000-0000000000c5';
    await sql.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1,'ShadowOrg','shadoworg')`, [
      tenantId,
    ]);

    // Seed parents before children (declared order; the throwaway declares notebooks before
    // entries) so a product FK is satisfiable.
    const idByStore = new Map<string, string>();
    for (const store of stores) {
      // GENERIC invariant 1: tenant_id FK -> orgs ON DELETE CASCADE exists.
      const fk = await sql.unsafe(
        `SELECT ccu.table_name AS ref, rc.delete_rule AS rule
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
           JOIN information_schema.constraint_column_usage ccu
             ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
           JOIN information_schema.referential_constraints rc
             ON tc.constraint_name = rc.constraint_name AND tc.table_schema = rc.constraint_schema
          WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_name=$1 AND kcu.column_name='tenant_id'`,
        [store.name],
      );
      const ref = (fk[0] as { ref?: string } | undefined)?.ref;
      const rule = (fk[0] as { rule?: string } | undefined)?.rule;
      if (ref !== 'orgs') {
        throw new Error(`product '${store.name}': tenant_id does not FK -> orgs (got ${ref})`);
      }
      if (rule !== 'CASCADE') {
        throw new Error(`product '${store.name}': tenant_id FK is ON DELETE ${rule}, not CASCADE`);
      }

      // Seed one row (stamp tenant_id; satisfy a product FK via the parent's id).
      const parentName = store.foreignKeys[0]?.references;
      const parentId = parentName ? idByStore.get(parentName) : undefined;
      const values = { tenant_id: tenantId, ...seedValues(store, parentId) };
      const cols = Object.keys(values);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const rows = await sql.unsafe(
        `INSERT INTO ${store.name} (${cols.map((c) => `"${c}"`).join(', ')}) ` +
          `VALUES (${placeholders}) RETURNING id`,
        cols.map((c) => values[c]),
      );
      const id = (rows[0] as { id?: string } | undefined)?.id;
      if (!id) throw new Error(`product '${store.name}': insert returned no id`);
      idByStore.set(store.name, id);
      console.log(
        `  ok: product '${store.name}' has tenant_id FK -> orgs ON DELETE CASCADE + seeded`,
      );
      asserted++;
    }

    // GENERIC invariant 2: deleting the org CASCADES away every product table's rows.
    await sql.unsafe(`DELETE FROM orgs WHERE id=$1`, [tenantId]);
    for (const store of stores) {
      const cnt = await sql.unsafe(
        `SELECT count(*)::int AS c FROM ${store.name} WHERE tenant_id=$1`,
        [tenantId],
      );
      const c = (cnt[0] as { c?: number } | undefined)?.c;
      if (c !== 0) {
        throw new Error(`product '${store.name}': ${c} rows NOT cascaded after org delete`);
      }
      console.log(`  ok: product '${store.name}' rows cascaded away after org delete`);
    }
  }

  // META: a vacuous dry-run (zero product tables -> zero assertions) MUST fail.
  if (asserted === 0) {
    throw new Error(
      'shadow-product-assertions: ZERO product-table assertions ran — a vacuous/blind dry-run ' +
        '(the spec must declare >=1 store). Refusing to pass.',
    );
  }
  return asserted;
}

async function main(): Promise<void> {
  const url = process.env.DRYRUN_PRODUCT_URL;
  if (!url) {
    console.error('shadow-product-assertions: DRYRUN_PRODUCT_URL is required');
    process.exit(1);
  }
  const parsed = parseSpec(readFileSync(YAML_PATH, 'utf8'));
  if (!parsed.ok) {
    console.error(
      `shadow-product-assertions: throwaway spec invalid: ${JSON.stringify(parsed.errors)}`,
    );
    process.exit(1);
  }
  const sql = postgres(url, { max: 1 });
  try {
    const asserted = await runProductAssertions(sql, parsed.value.stores);
    console.log(
      `SHADOW PRODUCT ASSERTIONS: PASS — ${asserted} product table(s) asserted (non-vacuous).`,
    );
  } finally {
    await sql.end();
  }
}

// Only run as a CLI (not when imported by a test). `import.meta.url` matches argv[1] when executed.
const isCli = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isCli) {
  main().catch((err) => {
    console.error(`SHADOW PRODUCT ASSERTIONS: FAIL — ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
