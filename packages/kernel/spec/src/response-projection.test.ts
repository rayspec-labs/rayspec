/**
 * The `project` response projection on declared store surfaces — grammar + lint.
 *
 * A store route (or a store, with route override) may declare an OPTIONAL, fail-closed response
 * projection: `casing` (snake default | camel), `omitInjected` (drop the injected columns; `id` is
 * spared unless a `fields` allowlist drops it), `rename` (declared/injected column → wire field
 * name), and `fields` (an allowlist of post-casing/rename WIRE names, applied last — when present
 * it alone decides membership). Read-side only; requests keep the tolerant author-named casing.
 *
 * These tests pin:
 *  - the GRAMMAR: `project` parses on a route and on a store, is `.strict()`, carries NO defaults
 *    (absent ⇒ the key is absent from the parsed document — the byte-identity guarantee), and
 *    rejects malformed members;
 *  - the LINT (doctor errors, not runtime surprises): unknown columns in `rename`/`fields`
 *    (`projection_unknown_column`), post-projection wire-name collisions (`projection_collision`),
 *    a rename target that shadows ANOTHER column's author name — the author-named list query
 *    surface would actively mislead (`projection_query_shadow`) — and the kind/op coherence rules
 *    (`project` on a non-store route or a delete route is dead config → `schema_violation`);
 *  - the ALLOWED forms: the documented `rename: { id: companionId }` split parses + lints clean.
 */
import { describe, expect, it } from 'vitest';
import type { SpecError, SpecErrorCode } from './errors.js';
import { lintSpec } from './lint.js';
import { parseSpec } from './parse.js';

/** A base spec with one store + one projected list route; each test builds a variant. */
function specYaml(args: { storeProject?: string; routeProject?: string; extra?: string }): string {
  const storeProject = args.storeProject ? `    project: ${args.storeProject}\n` : '';
  const routeProject = args.routeProject ? `    project: ${args.routeProject}\n` : '';
  return `
version: '1.0'
metadata:
  name: projection-backend
stores:
  - name: companions
    columns:
      - { name: name, type: text }
      - { name: role, type: text }
      - { name: note_id, type: uuid, nullable: true }
${storeProject}api:
  - method: GET
    path: /companions
    action: { kind: store, store: companions, op: list }
${routeProject}${args.extra ?? ''}`;
}

/** Parse; expect success; return the lint errors of the parsed document (parseSpec already lints). */
function lintOf(yaml: string): SpecError[] {
  const res = parseSpec(yaml);
  if (res.ok) return lintSpec(res.value);
  return res.errors;
}

/** Assert at least one error carries the code (and, when given, the JSON path). */
function expectError(errors: SpecError[], code: SpecErrorCode, path?: string): void {
  const hits = errors.filter((e) => e.code === code);
  expect(hits.length, `expected a '${code}' error in ${JSON.stringify(errors)}`).toBeGreaterThan(0);
  if (path !== undefined) {
    expect(
      hits.some((e) => e.path === path),
      `expected a '${code}' error at '${path}' in ${JSON.stringify(hits)}`,
    ).toBe(true);
  }
}

describe('project — grammar', () => {
  it('parses the documented route-level projection (casing/omitInjected/rename/fields)', () => {
    const res = parseSpec(
      specYaml({
        routeProject:
          '{ casing: camel, omitInjected: true, rename: { id: companionId }, fields: [companionId, name, role, createdAt] }',
      }),
    );
    expect(res.ok, `expected ok, got ${JSON.stringify(!res.ok && res.errors)}`).toBe(true);
    if (!res.ok) return;
    const route = res.value.api[0];
    expect(route?.project).toEqual({
      casing: 'camel',
      omitInjected: true,
      rename: { id: 'companionId' },
      fields: ['companionId', 'name', 'role', 'createdAt'],
    });
  });

  it('parses a store-level projection, and lints clean', () => {
    const res = parseSpec(specYaml({ storeProject: '{ casing: camel }' }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.stores[0]?.project).toEqual({ casing: 'camel' });
    expect(lintSpec(res.value)).toEqual([]);
  });

  it('absent `project` parses to an ABSENT key on both docks (no default — the byte-identity guarantee)', () => {
    const res = parseSpec(specYaml({}));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Object.hasOwn(res.value.api[0] as object, 'project')).toBe(false);
    expect(Object.hasOwn(res.value.stores[0] as object, 'project')).toBe(false);
  });

  it('is strict: an unknown projection key is rejected (unknown_field)', () => {
    const res = parseSpec(specYaml({ routeProject: '{ casing: camel, dropAll: true }' }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.map((e) => e.code)).toContain('unknown_field');
  });

  it('rejects a casing outside snake|camel, an empty fields list, and a malformed wire name', () => {
    for (const project of [
      '{ casing: kebab }',
      '{ fields: [] }',
      "{ rename: { name: 'has space' } }",
      "{ rename: { name: '' } }",
      "{ fields: ['9starts_with_digit'] }",
    ]) {
      const res = parseSpec(specYaml({ routeProject: project }));
      expect(res.ok, `expected rejection for project: ${project}`).toBe(false);
    }
  });
});

describe('project — lint (doctor errors, not runtime surprises)', () => {
  it('a rename of an UNKNOWN column is projection_unknown_column (route + store dock, exact path)', () => {
    expectError(
      lintOf(specYaml({ routeProject: '{ rename: { ghost: spirit } }' })),
      'projection_unknown_column',
      'api[0].project.rename.ghost',
    );
    expectError(
      lintOf(specYaml({ storeProject: '{ rename: { ghost: spirit } }' })),
      'projection_unknown_column',
      'stores[0].project.rename.ghost',
    );
  });

  it('a fields entry matching NO projected wire name is projection_unknown_column', () => {
    expectError(
      lintOf(specYaml({ routeProject: '{ fields: [name, ghost] }' })),
      'projection_unknown_column',
      'api[0].project.fields[1]',
    );
  });

  it('fields are matched AFTER casing/rename: the author snake name of a re-cased column no longer matches', () => {
    // With casing: camel the wire name is 'noteId'; the author name 'note_id' matches nothing.
    const errors = lintOf(specYaml({ routeProject: '{ casing: camel, fields: [note_id] }' }));
    expectError(errors, 'projection_unknown_column', 'api[0].project.fields[0]');
    // The message points the author at the wire name (the projection is legible from the error).
    expect(errors.some((e) => e.message.includes("'noteId'"))).toBe(true);
  });

  it('a DEAD rename — the projection removes the renamed column from the response — is projection_unknown_column', () => {
    // omitInjected removes created_at and no fields allowlist re-includes it: the rename renames
    // a column the response does not carry.
    expectError(
      lintOf(specYaml({ routeProject: '{ omitInjected: true, rename: { created_at: at } }' })),
      'projection_unknown_column',
      'api[0].project.rename.created_at',
    );
    // A fields allowlist that drops the rename target is the same dead config.
    expectError(
      lintOf(specYaml({ routeProject: '{ rename: { role: kind }, fields: [name] }' })),
      'projection_unknown_column',
      'api[0].project.rename.role',
    );
  });

  it('two columns mapping to the SAME wire name is projection_collision (rename and casing alike)', () => {
    // A rename target colliding with another column's wire name.
    expectError(
      lintOf(specYaml({ routeProject: '{ casing: camel, rename: { role: noteId } }' })),
      'projection_collision',
      'api[0].project',
    );
    // Two snake names that camel-case to the same wire name (a_1 and a1 → a1) collide under camel.
    const yaml = `
version: '1.0'
metadata:
  name: camel-collision
stores:
  - name: things
    columns:
      - { name: a_1, type: text }
      - { name: a1, type: text }
api:
  - method: GET
    path: /things
    action: { kind: store, store: things, op: list }
    project: { casing: camel }
`;
    expectError(lintOf(yaml), 'projection_collision', 'api[0].project');
  });

  it("a rename target equal to ANOTHER column's author name is projection_query_shadow (the query surface stays author-named)", () => {
    // 'role' is a declared column: a response field 'role' that is actually the 'name' column would
    // actively mislead ?role= (which filters the real 'role' column).
    expectError(
      lintOf(specYaml({ routeProject: '{ rename: { name: role }, fields: [role] }' })),
      'projection_query_shadow',
      'api[0].project.rename.name',
    );
    // An INJECTED author name (created_by is filterable) is shadowed the same way.
    expectError(
      lintOf(specYaml({ routeProject: '{ rename: { name: created_by } }' })),
      'projection_query_shadow',
      'api[0].project.rename.name',
    );
  });

  it("the documented split — rename: { id: companionId } — is ALLOWED (no shadow: companionId is no column's author name)", () => {
    expect(
      lintOf(
        specYaml({
          routeProject:
            '{ casing: camel, omitInjected: true, rename: { id: companionId }, fields: [companionId, name, role, createdAt] }',
        }),
      ),
    ).toEqual([]);
  });

  it('duplicate fields entries are duplicate_name', () => {
    expectError(
      lintOf(specYaml({ routeProject: '{ fields: [name, name] }' })),
      'duplicate_name',
      'api[0].project.fields[1]',
    );
  });

  it('project on a NON-store route is dead config → schema_violation (coherence, like catchUp on a non-cron trigger)', () => {
    const yaml = `
version: '1.0'
metadata:
  name: non-store-project
handlers:
  - { id: h, module: handlers/h.ts, export: run, kind: route }
api:
  - method: POST
    path: /custom
    action: { kind: handler, handler: h }
    project: { casing: camel }
`;
    expectError(lintOf(yaml), 'schema_violation', 'api[0].project');
  });

  it('project on a store DELETE route is dead config → schema_violation (a delete answers 204 with no body)', () => {
    const yaml = specYaml({
      extra: `  - method: DELETE
    path: /companions/{id}
    action: { kind: store, store: companions, op: delete }
    project: { casing: camel }
`,
    });
    expectError(lintOf(yaml), 'schema_violation', 'api[1].project');
  });

  it('a store-level projection is checked on the STORE dock (collision reported at stores[i].project)', () => {
    expectError(
      lintOf(specYaml({ storeProject: '{ casing: camel, rename: { role: noteId } }' })),
      'projection_collision',
      'stores[0].project',
    );
  });
});
