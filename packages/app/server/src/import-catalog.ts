/**
 * WHAT AN IMPORT TARGET'S CATALOG HOLDS — read after each restore and again before the cutover, so
 * the import knows the target holds the objects its restore plan creates and nothing else.
 *
 * The restore allowlist (`dump-policy.ts`) decides what a dump's entries may do; this check sees
 * what the database actually holds afterwards, whatever ran. A function of the dump runs whenever
 * something calls it — a trigger on a table the import itself writes, for one — and as the migration
 * role it could create what the allowlist never restores: an extension, a schema, a function, a view
 * or type, a rule, a large object, an operator or text search object, a publication, default
 * privileges, a setting of the migration or runtime role, or a privilege for a role the target does
 * not grant. Each is counted or listed here, and the import compares the result with its plan:
 *
 *  - extensions, schemas besides `public` and functions (by schema and name, extension members
 *    aside): exactly the plan's;
 *  - triggers: the plan's, plus the ones the import adds itself;
 *  - views, materialized views, foreign tables, composite, enum, domain and range types, table rules,
 *    operators, collations, conversions, text search configurations and dictionaries, publications,
 *    event triggers and large objects: none;
 *  - privileges on relations and schemas: only for the migration role and the roles its default
 *    privileges name;
 *  - the default privileges, and the settings stored for the migration and runtime roles: unchanged
 *    since the import took its baseline.
 */
import { createHash } from 'node:crypto';
import type { Db } from '@rayspec/db';

/** What the catalog holds, in a form two reads can be compared by. */
export interface CatalogState {
  extensions: string[];
  schemas: string[];
  functions: string[];
  triggers: number;
  /** Objects no import restores: their kind and how many. */
  foreign: Record<string, number>;
  /** Privileges on relations and schemas held by a role the target does not grant to. */
  strangerGrants: number;
  /** Every default privilege of the database, one privilege of one grantee per line, sorted. */
  defaultPrivileges: string;
  /** The settings stored for the migration and runtime roles, as text. */
  roleSettings: string;
}

/** What the catalog must hold. */
export interface CatalogExpectation {
  extensions: readonly string[];
  schemas: readonly string[];
  /** `schema.name(arguments)` or `schema.name`. */
  functions: readonly string[];
  triggers: number;
  defaultPrivileges: string;
  roleSettings: string;
}

const USER_SCHEMA = (alias: string) =>
  `${alias}.nspname NOT IN ('pg_catalog', 'information_schema') AND ${alias}.nspname NOT LIKE 'pg\\_%'`;

/** An object that belongs to an extension, by its catalog and oid. */
const EXTENSION_MEMBER = (catalog: string, oid: string) =>
  `EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '${catalog}'::regclass AND d.objid = ${oid} AND d.deptype = 'e')`;

/**
 * Read the connected database's catalog. `runtimeRole` is the target's runtime role; the migration
 * role is the connection's.
 */
export async function readCatalog(db: Db, runtimeRole: string): Promise<CatalogState> {
  const [row] = (await db.$client.unsafe(
    `WITH me AS (SELECT oid FROM pg_roles WHERE rolname = current_user),
          granted AS (
            SELECT (SELECT oid FROM me) AS oid
            UNION SELECT a.grantee FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
             WHERE d.defaclrole = (SELECT oid FROM me))
     SELECT
       (SELECT coalesce(array_agg(extname::text ORDER BY extname), '{}') FROM pg_extension
         WHERE extname <> 'plpgsql') AS extensions,
       (SELECT coalesce(array_agg(n.nspname::text ORDER BY n.nspname), '{}') FROM pg_namespace n
         WHERE ${USER_SCHEMA('n')} AND n.nspname <> 'public'
           AND NOT ${EXTENSION_MEMBER('pg_namespace', 'n.oid')}) AS schemas,
       (SELECT coalesce(array_agg(n.nspname || '.' || p.proname ORDER BY n.nspname, p.proname), '{}')
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE ${USER_SCHEMA('n')} AND NOT ${EXTENSION_MEMBER('pg_proc', 'p.oid')}) AS functions,
       (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE NOT t.tgisinternal AND ${USER_SCHEMA('n')}) AS triggers,
       (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('v', 'm', 'f', 'c') AND ${USER_SCHEMA('n')}
           AND NOT ${EXTENSION_MEMBER('pg_class', 'c.oid')}) AS views,
       (SELECT count(*)::int FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE t.typtype IN ('c', 'e', 'd', 'r', 'm') AND t.typrelid = 0 AND ${USER_SCHEMA('n')}
           AND NOT ${EXTENSION_MEMBER('pg_type', 't.oid')}) AS types,
       (SELECT count(*)::int FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r', 'p') AND ${USER_SCHEMA('n')}) AS rules,
       (SELECT count(*)::int FROM pg_operator o JOIN pg_namespace n ON n.oid = o.oprnamespace
         WHERE ${USER_SCHEMA('n')} AND NOT ${EXTENSION_MEMBER('pg_operator', 'o.oid')}) AS operators,
       (SELECT count(*)::int FROM pg_collation o JOIN pg_namespace n ON n.oid = o.collnamespace
         WHERE ${USER_SCHEMA('n')}) AS collations,
       (SELECT count(*)::int FROM pg_conversion o JOIN pg_namespace n ON n.oid = o.connamespace
         WHERE ${USER_SCHEMA('n')}) AS conversions,
       (SELECT count(*)::int FROM pg_ts_config o JOIN pg_namespace n ON n.oid = o.cfgnamespace
         WHERE ${USER_SCHEMA('n')})
         + (SELECT count(*)::int FROM pg_ts_dict o JOIN pg_namespace n ON n.oid = o.dictnamespace
         WHERE ${USER_SCHEMA('n')}) AS text_search,
       (SELECT count(*)::int FROM pg_publication) AS publications,
       (SELECT count(*)::int FROM pg_event_trigger) AS event_triggers,
       (SELECT count(*)::int FROM pg_largeobject_metadata) AS large_objects,
       (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN LATERAL aclexplode(c.relacl) a
         WHERE ${USER_SCHEMA('n')} AND a.grantee NOT IN (SELECT oid FROM granted))
         + (SELECT count(*)::int FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
         WHERE ${USER_SCHEMA('n')} AND n.nspname <> 'public'
           AND a.grantee NOT IN (SELECT oid FROM granted)) AS stranger_grants,
       (SELECT coalesce(string_agg(entry, E'\\n' ORDER BY entry), '')
          FROM (SELECT format('%s %s %s %s %s %s', d.defaclrole::regrole, d.defaclnamespace,
                              d.defaclobjtype, a.grantee, a.privilege_type, a.is_grantable) AS entry
                  FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a) e)
         AS default_privileges,
       (SELECT coalesce(string_agg(
                 format('%s %s %s', s.setrole::regrole, s.setdatabase, s.setconfig::text),
                 E'\\n' ORDER BY s.setrole, s.setdatabase), '')
          FROM pg_db_role_setting s
         WHERE s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
           AND s.setrole IN ((SELECT oid FROM me), (SELECT oid FROM pg_roles WHERE rolname = $1)))
         AS role_settings`,
    [runtimeRole],
  )) as unknown as Record<string, unknown>[];
  const r = row ?? {};
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  return {
    extensions: list(r.extensions),
    schemas: list(r.schemas),
    functions: list(r.functions),
    triggers: Number(r.triggers),
    foreign: {
      'views, foreign tables or composite types': Number(r.views),
      types: Number(r.types),
      'table rules': Number(r.rules),
      operators: Number(r.operators),
      collations: Number(r.collations),
      conversions: Number(r.conversions),
      'text search objects': Number(r.text_search),
      publications: Number(r.publications),
      'event triggers': Number(r.event_triggers),
      'large objects': Number(r.large_objects),
    },
    strangerGrants: Number(r.stranger_grants),
    defaultPrivileges: String(r.default_privileges ?? ''),
    roleSettings: String(r.role_settings ?? ''),
  };
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function same(a: readonly string[], b: readonly string[]): boolean {
  const x = sorted(a);
  const y = sorted(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * How the catalog differs from what it must hold, in words that name no object; null when it holds
 * exactly that.
 */
export function catalogDifference(
  state: CatalogState,
  expected: CatalogExpectation,
): string | null {
  if (!same(state.extensions, expected.extensions)) return 'it holds other extensions';
  if (!same(state.schemas, expected.schemas)) return 'it holds other schemas';
  const names = expected.functions.map((f) => f.replace(/\(.*$/s, ''));
  if (!same(state.functions, names)) return 'it holds other functions';
  if (state.triggers !== expected.triggers) return 'it holds other triggers';
  for (const [kind, count] of Object.entries(state.foreign)) {
    if (count !== 0) return `it holds ${kind}`;
  }
  if (state.strangerGrants !== 0) return 'it grants privileges to a role the target does not';
  if (state.defaultPrivileges !== expected.defaultPrivileges) {
    return 'its default privileges changed';
  }
  if (state.roleSettings !== expected.roleSettings) {
    return 'the settings of its migration or runtime role changed';
  }
  return null;
}

/** SHA-256 of a catalog state, which the cutover compares with the one the import ended with. */
export function catalogDigest(states: readonly CatalogState[]): string {
  return createHash('sha256').update(JSON.stringify(states), 'utf8').digest('hex');
}
