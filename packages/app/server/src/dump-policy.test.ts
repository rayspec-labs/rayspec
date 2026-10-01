/**
 * The restore allowlist of an import, judged on tables of contents built entry by entry the way
 * `pg_dump` writes them for the platform's databases. A dump of the platform passes and yields the
 * restore list; each way a dump could run something the target's migration role should not — an
 * extension, a role, a grant to a stranger, another owner, an event trigger, an untrusted language,
 * a definer function, `COPY … PROGRAM`, a call into the dump at restore time, a server function,
 * a statement smuggled beside the one its entry may hold — is refused with the contract's code and
 * reason, and so is a dump that disagrees with the tables `snapshot.json` counts. (Real dumps of a
 * deployed application and its workflow engine are judged in the import suite of `@rayspec/cli`.)
 */
import { describe, expect, it } from 'vitest';
import type { DumpToc, DumpTocEntry } from './dump-archive.js';
import { type CountedTable, lexSql, planDumpRestore, splitStatements } from './dump-policy.js';

const OWNER = 'app_migrator';

let nextId = 100;
function entry(
  desc: string,
  namespace: string | null,
  tag: string,
  defn: string | null,
  over: Partial<DumpTocEntry> = {},
): DumpTocEntry {
  nextId += 1;
  return {
    dumpId: nextId,
    hadDumper: false,
    tableoid: '0',
    oid: String(nextId),
    tag,
    desc,
    section: 2,
    defn,
    dropStmt: null,
    copyStmt: null,
    namespace,
    tablespace: '',
    tableam: '',
    owner: OWNER,
    dependencies: [],
    dataState: 3,
    ...over,
  };
}

const SESSION = [
  entry('ENCODING', null, 'ENCODING', "SET client_encoding = 'UTF8';\n", { owner: '' }),
  entry('STDSTRINGS', null, 'STDSTRINGS', "SET standard_conforming_strings = 'on';\n", {
    owner: '',
  }),
  entry(
    'SEARCHPATH',
    null,
    'SEARCHPATH',
    "SELECT pg_catalog.set_config('search_path', '', false);\n",
    {
      owner: '',
    },
  ),
];

const INVITE_DEFINER =
  'CREATE FUNCTION public.rayspec_invite_tenant(p_token_hash text) RETURNS uuid\n' +
  '    LANGUAGE sql STABLE SECURITY DEFINER\n' +
  "    SET search_path TO 'pg_catalog', 'pg_temp'\n" +
  '    AS $$\n\tSELECT tenant_id FROM public.invites WHERE token_hash = p_token_hash\n$$;\n';

const APPEND_ONLY =
  'CREATE FUNCTION public.receipts_append_only() RETURNS trigger\n' +
  '    LANGUAGE plpgsql\n' +
  "    AS $$\nBEGIN\n\tRAISE EXCEPTION 'append-only: % is refused', TG_OP;\nEND;\n$$;\n";

/** A dump of the application database, as `pg_dump` writes one for the platform. */
function applicationDump(): DumpTocEntry[] {
  return [
    ...SESSION,
    entry('DATABASE', null, 'app', 'CREATE DATABASE app WITH TEMPLATE = template0;\n', {
      owner: 'cluster_admin',
    }),
    entry('ACL', null, 'DATABASE app', 'GRANT CONNECT ON DATABASE app TO someone_else;\n', {
      owner: 'cluster_admin',
    }),
    entry('SCHEMA', null, 'drizzle', 'CREATE SCHEMA drizzle;\n'),
    entry('ACL', null, 'SCHEMA drizzle', 'GRANT USAGE ON SCHEMA drizzle TO app_runtime;\n'),
    entry(
      'ACL',
      null,
      'SCHEMA public',
      'REVOKE USAGE ON SCHEMA public FROM PUBLIC;\nGRANT ALL ON SCHEMA public TO app_migrator;\n',
      { owner: 'pg_database_owner' },
    ),
    entry('FUNCTION', 'public', 'rayspec_invite_tenant(text)', INVITE_DEFINER),
    entry('FUNCTION', 'public', 'receipts_append_only()', APPEND_ONLY),
    entry(
      'TABLE',
      'drizzle',
      '__drizzle_migrations',
      'CREATE TABLE drizzle.__drizzle_migrations (\n    id integer NOT NULL,\n    hash text NOT NULL\n);\n',
      { tableam: 'heap' },
    ),
    entry(
      'SEQUENCE',
      'drizzle',
      '__drizzle_migrations_id_seq',
      'CREATE SEQUENCE drizzle.__drizzle_migrations_id_seq\n    AS integer\n    START WITH 1\n    CACHE 1;\n',
    ),
    entry(
      'SEQUENCE OWNED BY',
      'drizzle',
      '__drizzle_migrations_id_seq',
      'ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNED BY drizzle.__drizzle_migrations.id;\n',
    ),
    entry(
      'TABLE',
      'public',
      'orgs',
      'CREATE TABLE public.orgs (\n    id uuid DEFAULT gen_random_uuid() NOT NULL,\n    name text NOT NULL,\n' +
        '    CONSTRAINT orgs_name CHECK ((length(name) > 0))\n);\n',
      { tableam: 'heap' },
    ),
    entry(
      'TABLE',
      'public',
      'notes',
      'CREATE TABLE public.notes (\n    id uuid DEFAULT gen_random_uuid() NOT NULL,\n    tenant_id uuid NOT NULL,\n' +
        "    body text NOT NULL,\n    region text DEFAULT 'eu'::text NOT NULL\n);\n\n" +
        'ALTER TABLE ONLY public.notes FORCE ROW LEVEL SECURITY;\n',
      { tableam: 'heap' },
    ),
    entry(
      'TABLE',
      'public',
      'receipts',
      'CREATE TABLE public.receipts (\n    id bigint NOT NULL,\n    detail jsonb\n);\n',
      { tableam: 'heap' },
    ),
    entry(
      'SEQUENCE',
      'public',
      'receipts_id_seq',
      'ALTER TABLE public.receipts ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (\n' +
        '    SEQUENCE NAME public.receipts_id_seq\n    START WITH 1\n    CACHE 1\n);\n',
    ),
    entry(
      'DEFAULT',
      'drizzle',
      '__drizzle_migrations id',
      "ALTER TABLE ONLY drizzle.__drizzle_migrations ALTER COLUMN id SET DEFAULT nextval('drizzle.__drizzle_migrations_id_seq'::regclass);\n",
    ),
    entry('TABLE DATA', 'drizzle', '__drizzle_migrations', '', {
      copyStmt: 'COPY drizzle.__drizzle_migrations (id, hash) FROM stdin;\n',
      hadDumper: true,
      dataState: 2,
      section: 3,
    }),
    entry('TABLE DATA', 'public', 'orgs', '', {
      copyStmt: 'COPY public.orgs (id, name) FROM stdin;\n',
      hadDumper: true,
      dataState: 2,
      section: 3,
    }),
    entry('TABLE DATA', 'public', 'notes', '', {
      copyStmt: 'COPY public.notes (id, tenant_id, body, "position", region) FROM stdin;\n',
      hadDumper: true,
      dataState: 2,
      section: 3,
    }),
    entry(
      'SEQUENCE SET',
      'drizzle',
      '__drizzle_migrations_id_seq',
      "SELECT pg_catalog.setval('drizzle.__drizzle_migrations_id_seq', 16, true);\n",
      { section: 3 },
    ),
    entry(
      'SEQUENCE SET',
      'public',
      'receipts_id_seq',
      "SELECT pg_catalog.setval('public.receipts_id_seq', 1, false);\n",
      { section: 3 },
    ),
    entry(
      'CONSTRAINT',
      'public',
      'notes notes_pkey',
      'ALTER TABLE ONLY public.notes\n    ADD CONSTRAINT notes_pkey PRIMARY KEY (id);\n',
      { section: 4 },
    ),
    entry(
      'CONSTRAINT',
      'public',
      'orgs orgs_pkey',
      'ALTER TABLE ONLY public.orgs\n    ADD CONSTRAINT orgs_pkey PRIMARY KEY (id);\n',
      { section: 4 },
    ),
    entry(
      'INDEX',
      'public',
      'notes_tenant_idx',
      'CREATE INDEX notes_tenant_idx ON public.notes USING btree (tenant_id, lower(body));\n',
      { section: 4 },
    ),
    entry(
      'TRIGGER',
      'public',
      'receipts receipts_no_rewrite',
      'CREATE TRIGGER receipts_no_rewrite BEFORE DELETE OR UPDATE ON public.receipts FOR EACH ROW EXECUTE FUNCTION public.receipts_append_only();\n',
      { section: 4 },
    ),
    entry(
      'FK CONSTRAINT',
      'public',
      'notes notes_tenant_id_orgs_id_fk',
      'ALTER TABLE ONLY public.notes\n    ADD CONSTRAINT notes_tenant_id_orgs_id_fk FOREIGN KEY (tenant_id) REFERENCES public.orgs(id) ON DELETE CASCADE;\n',
      { section: 4 },
    ),
    entry(
      'POLICY',
      'public',
      'notes tenant_isolation',
      "CREATE POLICY tenant_isolation ON public.notes USING ((tenant_id = (NULLIF(current_setting('app.current_tenant'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.current_tenant'::text, true), ''::text))::uuid));\n",
      { section: 4 },
    ),
    entry(
      'ROW SECURITY',
      'public',
      'notes',
      'ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;\n',
      {
        section: 4,
      },
    ),
    entry(
      'COMMENT',
      'public',
      'TABLE notes',
      "COMMENT ON TABLE public.notes IS 'notes; with a semicolon';\n",
    ),
    entry(
      'ACL',
      'public',
      'TABLE notes',
      'GRANT SELECT ON TABLE public.notes TO app_runtime;\nGRANT SELECT ON TABLE public.notes TO app_snapshot;\n',
    ),
    entry(
      'DEFAULT ACL',
      'public',
      'DEFAULT PRIVILEGES FOR TABLES',
      'ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public GRANT INSERT,DELETE,UPDATE ON TABLES TO app_runtime;\n',
    ),
    entry(
      'DEFAULT ACL',
      null,
      'DEFAULT PRIVILEGES FOR TABLES',
      'ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator GRANT SELECT ON TABLES TO app_runtime;\n' +
        'ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator GRANT SELECT ON TABLES TO app_snapshot;\n',
    ),
  ];
}

const APPLICATION_TABLES: CountedTable[] = [
  { schema: 'drizzle', table: '__drizzle_migrations', rows: 16 },
  { schema: 'public', table: 'notes', rows: 3 },
  { schema: 'public', table: 'orgs', rows: 1 },
  { schema: 'public', table: 'receipts', rows: 0 },
];

function toc(entries: DumpTocEntry[]): DumpToc {
  return {
    header: {
      version: '1.15.0',
      intSize: 4,
      offSize: 8,
      compression: 1,
      databaseName: 'app',
      serverVersion: '16.4',
      dumpVersion: '16.4',
    },
    entries,
    tocStart: 0,
    tocEnd: 0,
  };
}

function judge(
  entries: DumpTocEntry[],
  options: {
    database?: 'application' | 'workflow-system';
    tables?: CountedTable[];
    rowsExcluded?: string[];
  } = {},
) {
  return planDumpRestore({
    database: options.database ?? 'application',
    toc: toc(entries),
    tables: options.tables ?? APPLICATION_TABLES,
    rowsExcluded: new Set(options.rowsExcluded ?? ['public.receipts']),
  });
}

function outcome(result: ReturnType<typeof judge>): string {
  return result.ok ? 'ok' : `${result.errors[0]!.code}/${result.errors[0]!.reason ?? ''}`;
}

/** The application dump with one entry replaced (by tag and kind) or added. */
function withEntry(
  match: { desc: string; tag: string } | null,
  replacement: (e: DumpTocEntry) => DumpTocEntry | DumpTocEntry[],
): DumpTocEntry[] {
  const base = applicationDump();
  if (match === null) return [...base, ...([] as DumpTocEntry[]).concat(replacement(base[0]!))];
  const i = base.findIndex((e) => e.desc === match.desc && e.tag === match.tag);
  expect(i, `${match.desc} ${match.tag}`).toBeGreaterThanOrEqual(0);
  return [
    ...base.slice(0, i),
    ...([] as DumpTocEntry[]).concat(replacement(base[i]!)),
    ...base.slice(i + 1),
  ];
}

describe('the lexer', () => {
  it('splits statements at semicolons outside strings, quoted names, dollar quotes and comments', () => {
    const sql =
      "SELECT 'a;b', E'it''s \\\\'';' AS x; -- trailing ; comment\n" +
      'CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; SELECT 2; $body$; /* nested /* ; */ ; */ ' +
      'SELECT "semi;colon";';
    const statements = splitStatements(lexSql(sql));
    expect(statements.map((s) => s[0]?.value)).toEqual(['select', 'create', 'select']);
    expect(statements[2]![1]).toMatchObject({ kind: 'quoted', value: 'semi;colon' });
  });

  it('reads a backslash-escaped quote inside an escape string as part of the string', () => {
    // Read as a standard string, the quote after the backslash would end it and leave a second
    // statement outside; Postgres reads E'…' with backslash escapes, so it is one string.
    const statements = splitStatements(lexSql("SELECT E'a\\'; CREATE ROLE evil; --';"));
    expect(statements).toHaveLength(1);
    expect(statements[0]![1]).toMatchObject({
      kind: 'string',
      value: "a'; CREATE ROLE evil; --",
    });
    expect(splitStatements(lexSql("SELECT 'a\\'; SELECT 2;"))).toHaveLength(2);
  });

  it('refuses SQL it cannot read: an unterminated string, quote, dollar quote or comment', () => {
    for (const sql of ["SELECT 'open", 'SELECT "open', 'SELECT $x$ open', 'SELECT /* open']) {
      expect(() => lexSql(sql), sql).toThrow();
    }
  });
});

describe('a dump of the platform', () => {
  it('passes, and restores what it may in archive order, leaving privileges, comments and the database out', () => {
    const entries = applicationDump();
    const result = judge(entries);
    expect(outcome(result)).toBe('ok');
    if (!result.ok) return;
    expect(result.value.owner).toBe(OWNER);
    const kinds = result.value.restore.map((e) => e.desc);
    for (const kind of ['ACL', 'DEFAULT ACL', 'COMMENT', 'DATABASE', 'ENCODING', 'SEARCHPATH']) {
      expect(kinds, kind).not.toContain(kind);
    }
    const ids = result.value.restore.map((e) => e.dumpId);
    expect(ids).toEqual(
      [...ids].sort(
        (a, b) =>
          entries.findIndex((e) => e.dumpId === a) - entries.findIndex((e) => e.dumpId === b),
      ),
    );
    expect(result.value.useList.split('\n').filter(Boolean)).toHaveLength(ids.length);
    expect(result.value.useList.startsWith(`${ids[0]}; `)).toBe(true);
    expect(result.value.foreignKeys).toBe(1);
    expect(result.value.functions).toEqual([
      'public.rayspec_invite_tenant(text)',
      'public.receipts_append_only()',
    ]);
    expect(result.value.extensions).toEqual([]);
  });

  it('restores every row before a trigger of the dump exists, whatever order the archive puts them in', () => {
    // A trigger placed before the data in the archive: pg_restore --use-list runs the list's order.
    const base = applicationDump();
    const trigger = base.find((e) => e.desc === 'TRIGGER')!;
    const firstData = base.findIndex((e) => e.desc === 'TABLE DATA');
    const reordered = [
      ...base.slice(0, firstData).filter((e) => e !== trigger),
      trigger,
      ...base.slice(firstData).filter((e) => e !== trigger),
    ];
    expect(reordered.indexOf(trigger)).toBeLessThan(
      reordered.findIndex((e) => e.desc === 'TABLE DATA'),
    );
    const result = judge(reordered);
    expect(outcome(result)).toBe('ok');
    if (!result.ok) return;
    const listed = result.value.useList
      .split('\n')
      .filter(Boolean)
      .map((line) => line.replace(/^[0-9]+; [0-9]+ [0-9]+ /, ''));
    const lastData = listed.lastIndexOf('TABLE DATA');
    expect(lastData).toBeGreaterThan(0);
    expect(listed.indexOf('TRIGGER')).toBeGreaterThan(lastData);
    expect(listed.lastIndexOf('SEQUENCE SET')).toBeLessThan(listed.indexOf('CONSTRAINT'));
    for (const kind of ['FUNCTION', 'TABLE', 'SEQUENCE', 'DEFAULT', 'SCHEMA']) {
      expect(listed.lastIndexOf(kind), kind).toBeLessThan(listed.indexOf('TABLE DATA'));
    }
    expect(result.value.restore.map((e) => e.desc)).toEqual(listed);
  });

  it('refuses an entry in another section than the one pg_dump puts its kind in', () => {
    for (const [desc, tag, section] of [
      ['TRIGGER', 'receipts receipts_no_rewrite', 2],
      ['TRIGGER', 'receipts receipts_no_rewrite', 3],
      ['INDEX', 'notes_tenant_idx', 3],
      ['POLICY', 'notes tenant_isolation', 2],
      ['TABLE DATA', 'orgs', 4],
      ['SEQUENCE SET', '__drizzle_migrations_id_seq', 2],
      ['FUNCTION', 'receipts_append_only()', 4],
      ['TABLE', 'orgs', 3],
    ] as const) {
      expect(
        outcome(judge(withEntry({ desc, tag }, (e) => ({ ...e, section })))),
        `${desc} ${section}`,
      ).toBe('RAY_POLICY_DENIED/privileged-statement');
    }
  });

  it('takes the workflow system database with the uuid-ossp extension its engine creates, and its default', () => {
    const sys: DumpTocEntry[] = [
      ...SESSION,
      entry('SCHEMA', null, 'dbos', 'CREATE SCHEMA dbos;\n'),
      entry(
        'EXTENSION',
        null,
        'uuid-ossp',
        'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;\n',
        {
          owner: '',
        },
      ),
      entry(
        'COMMENT',
        null,
        'EXTENSION "uuid-ossp"',
        'COMMENT ON EXTENSION "uuid-ossp" IS \'uuids\';\n',
        {
          owner: '',
        },
      ),
      entry(
        'TABLE',
        'dbos',
        'notifications',
        'CREATE TABLE dbos.notifications (\n    message_uuid text DEFAULT public.uuid_generate_v4() NOT NULL,\n' +
          '    created_at bigint DEFAULT ((EXTRACT(epoch FROM now()) * 1000.0))::bigint NOT NULL\n);\n',
      ),
    ];
    const tables = [{ schema: 'dbos', table: 'notifications', rows: 0 }];
    expect(outcome(judge(sys, { database: 'workflow-system', tables, rowsExcluded: [] }))).toBe(
      'ok',
    );
    const result = judge(sys, { database: 'workflow-system', tables, rowsExcluded: [] });
    expect(result.ok && result.value.extensions).toEqual(['uuid-ossp']);
  });
});

describe('extensions', () => {
  it('refuses any extension in the application database, and any but uuid-ossp in the workflow system database', () => {
    const pgcrypto = entry(
      'EXTENSION',
      null,
      'pgcrypto',
      'CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;\n',
      {
        owner: '',
      },
    );
    expect(outcome(judge([...applicationDump(), pgcrypto]))).toBe(
      'RAY_POLICY_DENIED/unsupported-extension',
    );
    const uuid = entry(
      'EXTENSION',
      null,
      'uuid-ossp',
      'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;\n',
      { owner: '' },
    );
    expect(outcome(judge([...applicationDump(), uuid]))).toBe(
      'RAY_POLICY_DENIED/unsupported-extension',
    );
    const sys = (e: DumpTocEntry) => [
      ...SESSION,
      entry('SCHEMA', null, 'dbos', 'CREATE SCHEMA dbos;\n'),
      e,
    ];
    const none = { database: 'workflow-system' as const, tables: [], rowsExcluded: [] };
    expect(outcome(judge(sys(pgcrypto), none))).toBe('RAY_POLICY_DENIED/unsupported-extension');
    // uuid-ossp, but into another schema.
    const elsewhere = {
      ...uuid,
      defn: 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA dbos;\n',
    };
    expect(outcome(judge(sys(elsewhere), none))).toBe('RAY_POLICY_DENIED/unsupported-extension');
    expect(outcome(judge(sys(uuid), none))).toBe('ok');
  });

  it('refuses a call of an extension function where it is not the workflow engine’s uuid default', () => {
    expect(
      outcome(
        judge(
          withEntry({ desc: 'TABLE', tag: 'orgs' }, (e) => ({
            ...e,
            defn: (e.defn ?? '').replace('gen_random_uuid()', 'public.uuid_generate_v4()'),
          })),
        ),
      ),
    ).toBe('RAY_POLICY_DENIED/privileged-statement');
  });
});

describe('owners, grants and roles', () => {
  it('refuses an object of another owner', () => {
    expect(
      outcome(
        judge(withEntry({ desc: 'TABLE', tag: 'notes' }, (e) => ({ ...e, owner: 'intruder' }))),
      ),
    ).toBe('RAY_POLICY_DENIED/unmapped-owner');
  });

  it('refuses a grant to a role the dump does not account for, and default privileges of another role', () => {
    expect(
      outcome(
        judge(
          withEntry({ desc: 'ACL', tag: 'TABLE notes' }, (e) => ({
            ...e,
            defn: `${e.defn}GRANT ALL ON TABLE public.notes TO intruder;\n`,
          })),
        ),
      ),
    ).toBe('RAY_POLICY_DENIED/unmapped-owner');
    expect(
      outcome(
        judge(
          withEntry({ desc: 'DEFAULT ACL', tag: 'DEFAULT PRIVILEGES FOR TABLES' }, (e) => ({
            ...e,
            defn: 'ALTER DEFAULT PRIVILEGES FOR ROLE intruder GRANT SELECT ON TABLES TO app_runtime;\n',
          })),
        ),
      ),
    ).toBe('RAY_POLICY_DENIED/unmapped-owner');
  });

  it('refuses privileges of an object another role owns', () => {
    expect(
      outcome(
        judge(withEntry({ desc: 'ACL', tag: 'TABLE notes' }, (e) => ({ ...e, owner: 'intruder' }))),
      ),
    ).toBe('RAY_POLICY_DENIED/unmapped-owner');
  });

  it('refuses a role and a role membership, wherever they are put', () => {
    expect(
      outcome(
        judge([...applicationDump(), entry('ROLE', null, 'evil', 'CREATE ROLE evil SUPERUSER;\n')]),
      ),
    ).toBe('RAY_POLICY_DENIED/privileged-statement');
    expect(
      outcome(
        judge(
          withEntry({ desc: 'TABLE', tag: 'orgs' }, (e) => ({
            ...e,
            defn: `${e.defn}CREATE ROLE evil SUPERUSER;\nALTER SYSTEM SET archive_command = 'x';\n`,
          })),
        ),
      ),
    ).toBe('RAY_POLICY_DENIED/privileged-statement');
    expect(
      outcome(
        judge(
          withEntry({ desc: 'ACL', tag: 'TABLE notes' }, (e) => ({
            ...e,
            defn: 'GRANT app_migrator TO app_runtime;\n',
          })),
        ),
      ),
    ).toBe('RAY_POLICY_DENIED/privileged-statement');
  });
});

describe('kinds of object', () => {
  it('refuses an event trigger, a language, a view, a type, a large object and a publication', () => {
    for (const [desc, defn] of [
      [
        'EVENT TRIGGER',
        'CREATE EVENT TRIGGER evil ON ddl_command_start EXECUTE FUNCTION public.f();\n',
      ],
      ['PROCEDURAL LANGUAGE', 'CREATE OR REPLACE PROCEDURAL LANGUAGE plperlu;\n'],
      ['VIEW', 'CREATE VIEW public.v AS SELECT 1;\n'],
      ['TYPE', 'CREATE TYPE public.t AS (a int);\n'],
      ['BLOB', "SELECT pg_catalog.lo_create('16404');\n"],
      ['PUBLICATION', 'CREATE PUBLICATION p FOR ALL TABLES;\n'],
    ] as const) {
      expect(outcome(judge([...applicationDump(), entry(desc, 'public', 'x', defn)])), desc).toBe(
        'RAY_POLICY_DENIED/privileged-statement',
      );
    }
  });

  it('refuses a comment entry that is not one COMMENT ON, and a COPY statement on an entry that is not data', () => {
    expect(
      outcome(
        judge(
          withEntry({ desc: 'COMMENT', tag: 'TABLE notes' }, (e) => ({
            ...e,
            defn: `${e.defn}CREATE ROLE evil;\n`,
          })),
        ),
      ),
    ).toBe('RAY_POLICY_DENIED/privileged-statement');
    expect(
      outcome(
        judge(
          withEntry({ desc: 'COMMENT', tag: 'TABLE notes' }, (e) => ({
            ...e,
            defn: 'SELECT 1;\n',
          })),
        ),
      ),
    ).toBe('RAY_POLICY_DENIED/privileged-statement');
    expect(
      outcome(
        judge(
          withEntry({ desc: 'TABLE', tag: 'orgs' }, (e) => ({
            ...e,
            copyStmt: 'COPY public.orgs (id, name) FROM stdin;\n',
          })),
        ),
      ),
    ).toBe('RAY_POLICY_DENIED/privileged-statement');
  });

  it('refuses an index of another access method than the built-in ones', () => {
    for (const method of ['bloom', 'evil_am']) {
      expect(
        outcome(
          judge(
            withEntry({ desc: 'INDEX', tag: 'notes_tenant_idx' }, (e) => ({
              ...e,
              defn: (e.defn ?? '').replace('USING btree', `USING ${method}`),
            })),
          ),
        ),
        method,
      ).toBe('RAY_POLICY_DENIED/privileged-statement');
    }
    expect(
      outcome(
        judge(
          withEntry({ desc: 'INDEX', tag: 'notes_tenant_idx' }, (e) => ({
            ...e,
            defn: (e.defn ?? '').replace('USING btree', 'USING gin'),
          })),
        ),
      ),
    ).toBe('ok');
  });

  it('refuses a table that inherits, is partitioned, or names an access method in its definition', () => {
    for (const tail of [
      ')\nINHERITS (orgs);\n',
      ')\nPARTITION BY RANGE (id);\n',
      ')\nUSING heap;\n',
    ]) {
      expect(
        outcome(
          judge(
            withEntry({ desc: 'TABLE', tag: 'notes' }, (e) => ({
              ...e,
              defn: (e.defn ?? '').replace(');\n\n', `${tail}\n`),
            })),
          ),
        ),
        tail,
      ).toBe('RAY_POLICY_DENIED/privileged-statement');
    }
  });

  it('refuses a ROW SECURITY entry that alters its table in any other way too', () => {
    for (const defn of [
      'ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY, ALTER COLUMN body SET DEFAULT public.evil();\n',
      'ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;\n',
      'ALTER TABLE public.notes DISABLE ROW LEVEL SECURITY;\n',
      'ALTER TABLE public.orgs ENABLE ROW LEVEL SECURITY;\n',
    ]) {
      expect(
        outcome(judge(withEntry({ desc: 'ROW SECURITY', tag: 'notes' }, (e) => ({ ...e, defn })))),
        defn,
      ).toBe('RAY_POLICY_DENIED/privileged-statement');
    }
  });

  it('refuses a session set up otherwise, a tablespace and another table access method', () => {
    expect(
      outcome(
        judge(
          withEntry({ desc: 'SEARCHPATH', tag: 'SEARCHPATH' }, (e) => ({
            ...e,
            defn: "SELECT pg_catalog.set_config('search_path', 'public', false);\n",
          })),
        ),
      ),
    ).toBe('RAY_POLICY_DENIED/privileged-statement');
    expect(
      outcome(
        judge(withEntry({ desc: 'TABLE', tag: 'orgs' }, (e) => ({ ...e, tablespace: 'fast' }))),
      ),
    ).toBe('RAY_POLICY_DENIED/privileged-statement');
    expect(
      outcome(
        judge(withEntry({ desc: 'TABLE', tag: 'orgs' }, (e) => ({ ...e, tableam: 'columnar' }))),
      ),
    ).toBe('RAY_POLICY_DENIED/privileged-statement');
  });
});

describe('functions', () => {
  const fn = (defn: string) =>
    withEntry({ desc: 'FUNCTION', tag: 'receipts_append_only()' }, (e) => ({ ...e, defn }));

  it('refuses an untrusted language and a C function', () => {
    expect(outcome(judge(fn(APPEND_ONLY.replace('LANGUAGE plpgsql', 'LANGUAGE plpython3u'))))).toBe(
      'RAY_POLICY_DENIED/privileged-statement',
    );
    expect(
      outcome(
        judge(
          fn(
            "CREATE FUNCTION public.receipts_append_only() RETURNS trigger\n    LANGUAGE c\n    AS '/tmp/evil.so', 'evil';\n",
          ),
        ),
      ),
    ).toBe('RAY_POLICY_DENIED/privileged-statement');
  });

  it('refuses a SECURITY DEFINER function unless it is one of the platform’s two lookups, unchanged', () => {
    expect(
      outcome(
        judge(fn(APPEND_ONLY.replace('LANGUAGE plpgsql', 'LANGUAGE plpgsql SECURITY DEFINER'))),
      ),
    ).toBe('RAY_POLICY_DENIED/privileged-statement');
    const changed = (to: string) =>
      withEntry({ desc: 'FUNCTION', tag: 'rayspec_invite_tenant(text)' }, (e) => ({
        ...e,
        defn: to,
      }));
    expect(
      outcome(
        judge(changed(INVITE_DEFINER.replace('WHERE token_hash', 'WHERE true OR token_hash'))),
      ),
    ).toBe('RAY_POLICY_DENIED/privileged-statement');
    expect(
      outcome(judge(changed(INVITE_DEFINER.replace("'pg_catalog', 'pg_temp'", "'public'")))),
    ).toBe('RAY_POLICY_DENIED/privileged-statement');
    expect(
      outcome(
        judge(changed(INVITE_DEFINER.replace('p_token_hash text', 'p_token_hash text, x int'))),
      ),
    ).toBe('RAY_POLICY_DENIED/privileged-statement');
    // Whitespace alone does not change the body.
    expect(outcome(judge(changed(INVITE_DEFINER.replace('\tSELECT', '   SELECT'))))).toBe('ok');
  });

  it('refuses LEAKPROOF, a setting other than the search path, and a body that does what only a superuser may', () => {
    expect(
      outcome(judge(fn(APPEND_ONLY.replace('LANGUAGE plpgsql', 'LANGUAGE plpgsql LEAKPROOF')))),
    ).toBe('RAY_POLICY_DENIED/privileged-statement');
    expect(
      outcome(
        judge(
          fn(
            APPEND_ONLY.replace(
              '    LANGUAGE plpgsql\n',
              "    LANGUAGE plpgsql\n    SET work_mem TO '1GB'\n",
            ),
          ),
        ),
      ),
    ).toBe('RAY_POLICY_DENIED/privileged-statement');
    for (const body of [
      "COPY public.notes FROM PROGRAM 'id';",
      'CREATE ROLE evil SUPERUSER;',
      "ALTER SYSTEM SET archive_command = 'x';",
      "PERFORM query_to_xml('select 1', true, true, '');",
      "PERFORM pg_read_file('/etc/passwd');",
      'GRANT ALL ON public.notes TO PUBLIC;',
    ]) {
      expect(
        outcome(judge(fn(APPEND_ONLY.replace('RAISE EXCEPTION', `${body}\n\tRAISE EXCEPTION`)))),
        body,
      ).toBe('RAY_POLICY_DENIED/privileged-statement');
    }
  });
});

describe('no dump code at restore time', () => {
  it('refuses an index, a check, a default or a policy that calls a function of the dump', () => {
    for (const [match, change] of [
      [
        { desc: 'INDEX', tag: 'notes_tenant_idx' },
        (d: string) => d.replace('lower(body)', 'public.receipts_append_only()'),
      ],
      [
        { desc: 'TABLE', tag: 'orgs' },
        (d: string) => d.replace('length(name) > 0', 'public.evil(name)'),
      ],
      [
        { desc: 'DEFAULT', tag: '__drizzle_migrations id' },
        (d: string) =>
          d.replace("nextval('drizzle.__drizzle_migrations_id_seq'::regclass)", 'drizzle.evil()'),
      ],
      [
        { desc: 'POLICY', tag: 'notes tenant_isolation' },
        (d: string) => d.replace('USING ((', 'USING ((public.evil() AND '),
      ],
    ] as const) {
      expect(
        outcome(judge(withEntry(match, (e) => ({ ...e, defn: change(e.defn ?? '') })))),
        match.desc,
      ).toBe('RAY_POLICY_DENIED/privileged-statement');
    }
  });

  it('refuses a server function in any expression, qualified or not', () => {
    for (const call of [
      "pg_read_file('/etc/passwd')",
      "pg_catalog.query_to_xml('select 1', true, true, '')",
      "set_config('role', 'x', false)",
    ]) {
      expect(
        outcome(
          judge(
            withEntry({ desc: 'TABLE', tag: 'orgs' }, (e) => ({
              ...e,
              defn: (e.defn ?? '').replace('length(name) > 0', `${call} IS NOT NULL`),
            })),
          ),
        ),
        call,
      ).toBe('RAY_POLICY_DENIED/privileged-statement');
    }
  });

  it('refuses a large-object, notify or advisory-lock function in an expression the restore evaluates, and in a body', () => {
    for (const call of [
      'lo_creat(-1)',
      'pg_catalog.lowrite(lo_open(1, 131072), name::bytea)',
      'pg_catalog.lo_open(1, 131072)',
      'loread(1, 1)',
      'lo_get(1)',
      'pg_catalog.lo_truncate(0, 0)',
      'lo_put(1, 0, name::bytea)',
      'pg_notify(name, name)',
      'pg_advisory_unlock_all()',
      'pg_catalog.pg_advisory_unlock(1)',
    ]) {
      expect(
        outcome(
          judge(
            withEntry({ desc: 'TABLE', tag: 'orgs' }, (e) => ({
              ...e,
              defn: (e.defn ?? '').replace('length(name) > 0', `${call} IS NOT NULL`),
            })),
          ),
        ),
        call,
      ).toBe('RAY_POLICY_DENIED/privileged-statement');
    }
    expect(
      outcome(
        judge(
          withEntry({ desc: 'FUNCTION', tag: 'receipts_append_only()' }, (e) => ({
            ...e,
            defn: APPEND_ONLY.replace(
              'RAISE EXCEPTION',
              'PERFORM lo_creat(-1);\n\tRAISE EXCEPTION',
            ),
          })),
        ),
      ),
    ).toBe('RAY_POLICY_DENIED/privileged-statement');
    // A function body may notify, as the workflow engine's triggers do; it runs only on a write.
    expect(
      outcome(
        judge(
          withEntry({ desc: 'FUNCTION', tag: 'receipts_append_only()' }, (e) => ({
            ...e,
            defn: APPEND_ONLY.replace(
              'RAISE EXCEPTION',
              "PERFORM pg_notify('channel', TG_OP);\n\tRAISE EXCEPTION",
            ),
          })),
        ),
      ),
    ).toBe('ok');
    // A built-in of the same shape that touches nothing stays allowed.
    expect(
      outcome(
        judge(
          withEntry({ desc: 'TABLE', tag: 'orgs' }, (e) => ({
            ...e,
            defn: (e.defn ?? '').replace('length(name) > 0', 'lower(name) <> upper(name)'),
          })),
        ),
      ),
    ).toBe('ok');
  });

  it('refuses a trigger whose function the dump does not define as a trigger function', () => {
    expect(
      outcome(
        judge(
          withEntry({ desc: 'TRIGGER', tag: 'receipts receipts_no_rewrite' }, (e) => ({
            ...e,
            defn: (e.defn ?? '').replace(
              'public.receipts_append_only()',
              'public.rayspec_invite_tenant()',
            ),
          })),
        ),
      ),
    ).toBe('RAY_POLICY_DENIED/privileged-statement');
  });
});

describe('data and values', () => {
  it('refuses data loaded from a program, to a program, with options, or into another table', () => {
    for (const copy of [
      "COPY public.orgs (id, name) FROM PROGRAM 'id';\n",
      "COPY public.orgs (id, name) TO PROGRAM 'id';\n",
      'COPY public.orgs (id, name) FROM stdin WITH (FORMAT binary);\n',
      'COPY public.notes (id, name) FROM stdin;\n',
      "COPY public.orgs (id, name) FROM '/etc/passwd';\n",
      'COPY public.orgs (id, name) FROM stdin; SELECT 1;\n',
    ]) {
      expect(
        outcome(
          judge(withEntry({ desc: 'TABLE DATA', tag: 'orgs' }, (e) => ({ ...e, copyStmt: copy }))),
        ),
        copy,
      ).toBe('RAY_POLICY_DENIED/privileged-statement');
    }
    expect(
      outcome(
        judge(
          withEntry({ desc: 'TABLE DATA', tag: 'orgs' }, (e) => ({ ...e, defn: 'SELECT 1;\n' })),
        ),
      ),
    ).toBe('RAY_POLICY_DENIED/privileged-statement');
  });

  it('refuses a sequence value set by anything but pg_catalog.setval of its sequence', () => {
    for (const defn of [
      "SELECT public.evil('drizzle.__drizzle_migrations_id_seq', 16, true);\n",
      "SELECT pg_catalog.setval('public.receipts_id_seq', 16, true);\n",
      "SELECT pg_catalog.setval('drizzle.__drizzle_migrations_id_seq', 16, true); SELECT 1;\n",
    ]) {
      expect(
        outcome(
          judge(
            withEntry({ desc: 'SEQUENCE SET', tag: '__drizzle_migrations_id_seq' }, (e) => ({
              ...e,
              defn,
            })),
          ),
        ),
        defn,
      ).toBe('RAY_POLICY_DENIED/privileged-statement');
    }
  });
});

describe('the tables against snapshot.json', () => {
  it('refuses another set of tables, data of an excluded table and a counted table without its data', () => {
    expect(outcome(judge(applicationDump(), { tables: APPLICATION_TABLES.slice(1) }))).toBe(
      'RAY_DIGEST_MISMATCH/inner-metadata',
    );
    expect(
      outcome(
        judge(applicationDump(), {
          tables: [...APPLICATION_TABLES, { schema: 'public', table: 'missing', rows: 0 }],
        }),
      ),
    ).toBe('RAY_DIGEST_MISMATCH/inner-metadata');
    expect(outcome(judge(applicationDump(), { rowsExcluded: ['public.orgs'] }))).toBe(
      'RAY_DIGEST_MISMATCH/inner-metadata',
    );
    expect(
      outcome(
        judge(applicationDump(), {
          tables: APPLICATION_TABLES.map((t) => (t.table === 'receipts' ? { ...t, rows: 2 } : t)),
        }),
      ),
    ).toBe('RAY_DIGEST_MISMATCH/inner-metadata');
  });

  it('refuses a schema the platform does not use', () => {
    expect(
      outcome(
        judge(
          withEntry({ desc: 'SCHEMA', tag: 'drizzle' }, (e) => ({
            ...e,
            tag: 'other',
            defn: 'CREATE SCHEMA other;\n',
          })),
        ),
      ),
    ).toBe('RAY_POLICY_DENIED/privileged-statement');
  });
});
