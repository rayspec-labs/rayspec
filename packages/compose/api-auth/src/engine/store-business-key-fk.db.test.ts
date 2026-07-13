/**
 * DB-backed acceptance: a BUSINESS-KEY foreign key (`referencesColumn` → a unique column of the parent)
 * behaves correctly + TENANT-SAFELY through the REAL declared store-routes:
 *   - create/update referencing an EXISTING parent value → ok;
 *   - create referencing a NON-EXISTENT parent value → 400 VALIDATION_ERROR (NOT a 500), naming the FK
 *     COLUMN but never echoing the offending value;
 *   - delete a parent still referenced under onDelete:'restrict' → 409 CONFLICT (NOT a 500), tenant-safe;
 *   - RENAME a referenced unique key while a child still points at the old value (the child's ON UPDATE
 *     no action fires) → 409 CONFLICT (a "still referenced" state conflict, NOT the bad-input 400);
 *   - delete a parent whose only children are onDelete:'cascade' → 204 + the children are removed;
 *   - a child in tenant B CANNOT reference tenant A's parent value (the compound FK is tenant-scoped) →
 *     the cross-tenant reference is an absent-target 400, not a cross-tenant success.
 *
 * Drives the REAL createAuthApp middleware chain over an isolated Postgres schema, from a SELF-CONTAINED
 * throwaway backend-profile spec (product-free platform).
 *
 * Fail-the-fix: WITHOUT the 23503→400 catch in store-routes the non-existent-target create would fall
 * through to a bare `{"code":"INTERNAL"}` 500 — the `expect(...).toBe(400)` assertions go RED; without
 * the delete try/catch the restrict-blocked delete would 500 instead of 409.
 *
 * Skips without DATABASE_URL; HARD-FAILS when the DB is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but
 * absent (un-skippable ran-guard at the bottom).
 */
import { parseSpec, type RaySpec } from '@rayspec/spec';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'store-business-key-fk.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip the business-key FK acceptance suite.',
  );
}
const describeDb = hasDb ? describe : describe.skip;

const SCHEMA = 'rayspec_test_business_key_fk_routes';

// meetings(slug unique) ← notes(restrict business-key FK) + tags(cascade business-key FK). Parents are
// declared before children (build-product-tables invariant).
const YAML = `
version: '1.0'
metadata:
  name: meetings-backend
  description: A backend proving business-key FK behaviour + tenant-safety through the declared routes.
stores:
  - name: meetings
    columns:
      - { name: slug, type: text, unique: true }
      - { name: title, type: text, nullable: true }
  - name: notes
    columns:
      - { name: meeting_slug, type: text }
      - { name: body, type: text, nullable: true }
    foreignKeys:
      - { column: meeting_slug, references: meetings, referencesColumn: slug, onDelete: 'restrict' }
  - name: tags
    columns:
      - { name: meeting_slug, type: text }
      - { name: label, type: text, nullable: true }
    foreignKeys:
      - { column: meeting_slug, references: meetings, referencesColumn: slug, onDelete: 'cascade' }
api:
  - { method: POST, path: '/meetings', action: { kind: store, store: meetings, op: create } }
  - { method: GET, path: '/meetings', action: { kind: store, store: meetings, op: list } }
  - { method: PATCH, path: '/meetings/{id}', action: { kind: store, store: meetings, op: update } }
  - { method: DELETE, path: '/meetings/{id}', action: { kind: store, store: meetings, op: delete } }
  - { method: POST, path: '/notes', action: { kind: store, store: notes, op: create } }
  - { method: PATCH, path: '/notes/{id}', action: { kind: store, store: notes, op: update } }
  - { method: GET, path: '/notes', action: { kind: store, store: notes, op: list } }
  - { method: POST, path: '/tags', action: { kind: store, store: tags, op: create } }
  - { method: GET, path: '/tags', action: { kind: store, store: tags, op: list } }
`;

let testsRan = 0;

describeDb('business-key FK — behaviour + tenant-safety through the declared routes', () => {
  let h: Harness;

  async function principal(email: string, orgName: string): Promise<{ token: string }> {
    const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email, password: 'a-long-enough-password' },
    });
    const t0 = (await reg.json()).accessToken as string;
    const orgRes = await jsonRequest(h.app, 'POST', '/v1/orgs', {
      body: { name: orgName },
      headers: { authorization: `Bearer ${t0}` },
    });
    const orgId = (await orgRes.json()).id as string;
    const sw = await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
      headers: { authorization: `Bearer ${t0}` },
    });
    return { token: (await sw.json()).accessToken as string };
  }

  const post = (token: string, path: string, body: unknown) =>
    jsonRequest(h.app, 'POST', path, { body, headers: { authorization: `Bearer ${token}` } });
  const patch = (token: string, path: string, body: unknown) =>
    jsonRequest(h.app, 'PATCH', path, { body, headers: { authorization: `Bearer ${token}` } });
  const del = (token: string, path: string) =>
    jsonRequest(h.app, 'DELETE', path, { headers: { authorization: `Bearer ${token}` } });
  const list = (token: string, path: string) =>
    jsonRequest(h.app, 'GET', path, { headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    if (!hasDb) return;
    const parsed = parseSpec(YAML);
    if (!parsed.ok) throw new Error(`fixture invalid: ${JSON.stringify(parsed.errors)}`);
    const spec: RaySpec = parsed.value;
    h = await createHarness({ engineSpec: spec, schema: SCHEMA });
  });
  beforeEach(async () => {
    if (!hasDb) return;
    await h.reset();
  });
  afterAll(async () => {
    if (!hasDb) return;
    await h.close();
  });

  it('a child referencing an EXISTING parent value creates (201); a NON-EXISTENT value is a 400 (not 500), tenant-safe', async () => {
    testsRan += 1;
    const a = await principal('fk-a@example.com', 'FkOrgA');
    const SLUG = 'ACME-KICKOFF-2026'; // the distinctive value that must NEVER appear in the 400 body

    const meeting = await post(a.token, '/meetings', { slug: SLUG, title: 'Kickoff' });
    expect(meeting.status).toBe(201);

    // reference the EXISTING slug → 201.
    const okNote = await post(a.token, '/notes', { meeting_slug: SLUG, body: 'agenda' });
    expect(okNote.status).toBe(201);

    // reference a NON-EXISTENT slug → 400 VALIDATION_ERROR (NOT a 500).
    const badNote = await post(a.token, '/notes', { meeting_slug: 'DOES-NOT-EXIST', body: 'x' });
    expect(badNote.status).toBe(400);
    const body = await badNote.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    // Tenant-safe: NAMES the local FK column …
    expect(body.error.message).toContain('meeting_slug');
    // … and NEVER echoes the (non-existent) value the client supplied, nor any parent value.
    expect(JSON.stringify(body)).not.toContain('DOES-NOT-EXIST');
    expect(JSON.stringify(body)).not.toContain(SLUG);
  });

  it("deleting a parent still referenced under onDelete:'restrict' is a 409 CONFLICT (not a 500), tenant-safe", async () => {
    testsRan += 1;
    const a = await principal('fk-restrict@example.com', 'FkRestrictOrg');
    const created = await post(a.token, '/meetings', { slug: 'M-RESTRICT' });
    expect(created.status).toBe(201);
    const meetingId = (await created.json()).id as string;

    // a note (restrict FK) references it …
    expect((await post(a.token, '/notes', { meeting_slug: 'M-RESTRICT' })).status).toBe(201);

    // … so deleting the meeting is blocked → 409 CONFLICT (NOT a 500).
    const blocked = await del(a.token, `/meetings/${meetingId}`);
    expect(blocked.status).toBe(409);
    const body = await blocked.json();
    expect(body.error.code).toBe('CONFLICT');
    expect(JSON.stringify(body)).not.toContain('M-RESTRICT'); // no value leak

    // the meeting still exists (the blocked delete was a no-op).
    expect(await (await list(a.token, '/meetings')).json()).toHaveLength(1);
  });

  it('renaming a referenced unique key while a child still points at the OLD value is a 409 CONFLICT (not a 400), tenant-safe', async () => {
    testsRan += 1;
    const a = await principal('fk-rename@example.com', 'FkRenameOrg');
    const OLD = 'M-OLD-SLUG';
    const NEW = 'M-NEW-SLUG'; // a value NO other row holds → NOT a uniqueness conflict
    const created = await post(a.token, '/meetings', { slug: OLD });
    expect(created.status).toBe(201);
    const meetingId = (await created.json()).id as string;

    // a child (restrict business-key FK) references the OLD slug …
    expect((await post(a.token, '/notes', { meeting_slug: OLD })).status).toBe(201);

    // … so PATCHing the parent's referenced unique key fires the CHILD's `ON UPDATE no action`
    // restrict → a "still referenced" CONFLICT (409), NOT the bad-input 400. This is NOT a
    // uniqueness collision (NEW is free) and NOT this store's own FK (meetings declares none) — it is
    // a child restrict on the referenced key, so it must be a 409.
    const blocked = await patch(a.token, `/meetings/${meetingId}`, { slug: NEW });
    expect(blocked.status).toBe(409);
    const body = await blocked.json();
    expect(body.error.code).toBe('CONFLICT');
    // Tenant-safe: names NO child table/column nor either slug value.
    expect(JSON.stringify(body)).not.toContain('notes');
    expect(JSON.stringify(body)).not.toContain(OLD);
    expect(JSON.stringify(body)).not.toContain(NEW);

    // the rename was a no-op — the meeting still holds the OLD slug (the blocked UPDATE rolled back).
    const rows = (await (await list(a.token, '/meetings')).json()) as { slug: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slug).toBe(OLD);
  });

  it("PATCHing a child that OWNS a business-key FK to a NON-EXISTENT parent value is a 400 (its OWN FK, bad input), tenant-safe — the discriminator's 400 branch", async () => {
    testsRan += 1;
    const a = await principal('fk-own-update@example.com', 'FkOwnUpdateOrg');
    const SLUG = 'M-OWN-UPD';
    const MISSING = 'NO-SUCH-MEETING'; // the value that must NEVER appear in the 400 body
    const created = await post(a.token, '/meetings', { slug: SLUG });
    expect(created.status).toBe(201);

    // a note references the EXISTING parent slug (its own business-key FK is satisfied) …
    const note = await post(a.token, '/notes', { meeting_slug: SLUG, body: 'agenda' });
    expect(note.status).toBe(201);
    const noteId = (await note.json()).id as string;

    // … now PATCH the note's OWN business-key FK column to a NON-EXISTENT parent value. This fires
    // THIS store's own 23503 (constraint `notes_meeting_slug_meetings_slug_fk`, which resolves in
    // `store.foreignKeys`) → bad INPUT → 400 VALIDATION_ERROR, NOT the 409 "still referenced" (that is
    // the PARENT-side rename conflict on a child's ON UPDATE no action). This is the POSITIVE half of
    // the store-route 400-vs-409 update discriminator — it goes RED if the discriminator regresses to
    // an unconditional 409.
    const bad = await patch(a.token, `/notes/${noteId}`, { meeting_slug: MISSING });
    expect(bad.status).toBe(400);
    const body = await bad.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    // Tenant-safe: NAMES the local FK column …
    expect(body.error.message).toContain('meeting_slug');
    // … and NEVER echoes the (non-existent) value the client supplied, nor the real parent value.
    expect(JSON.stringify(body)).not.toContain(MISSING);
    expect(JSON.stringify(body)).not.toContain(SLUG);
  });

  it("deleting a parent whose only children are onDelete:'cascade' succeeds (204) and cascades the children", async () => {
    testsRan += 1;
    const a = await principal('fk-cascade@example.com', 'FkCascadeOrg');
    const created = await post(a.token, '/meetings', { slug: 'M-CASCADE' });
    expect(created.status).toBe(201);
    const meetingId = (await created.json()).id as string;

    // a tag (cascade FK) references it (NO restrict note this time) …
    expect((await post(a.token, '/tags', { meeting_slug: 'M-CASCADE', label: 't' })).status).toBe(
      201,
    );
    expect(await (await list(a.token, '/tags')).json()).toHaveLength(1);

    // … deleting the meeting succeeds → 204, and the tag is cascade-removed.
    const gone = await del(a.token, `/meetings/${meetingId}`);
    expect(gone.status).toBe(204);
    expect(await (await list(a.token, '/meetings')).json()).toHaveLength(0);
    expect(await (await list(a.token, '/tags')).json()).toHaveLength(0); // cascade fired
  });

  it("a child in tenant B CANNOT reference tenant A's parent value (the compound FK is tenant-scoped) → 400", async () => {
    testsRan += 1;
    const a = await principal('fk-ta@example.com', 'FkTenantA');
    const b = await principal('fk-tb@example.com', 'FkTenantB');
    const SHARED = 'SHARED-SLUG';

    // tenant A owns a meeting with the slug.
    expect((await post(a.token, '/meetings', { slug: SHARED })).status).toBe(201);

    // tenant B references the SAME slug value → but A's row is invisible to B (tenant-scoped compound
    // FK), so the target is ABSENT for B → 400 (a cross-tenant reference is structurally impossible).
    const bNote = await post(b.token, '/notes', { meeting_slug: SHARED });
    expect(bNote.status).toBe(400);
    expect((await bNote.json()).error.code).toBe('VALIDATION_ERROR');

    // tenant B CAN reference its OWN meeting with that slug (two tenants may hold the same value).
    expect((await post(b.token, '/meetings', { slug: SHARED })).status).toBe(201);
    expect((await post(b.token, '/notes', { meeting_slug: SHARED })).status).toBe(201);
  });
});

describe('business-key FK routes acceptance — ran-guard (must not silently skip in CI)', () => {
  it('the FK-behaviour arms ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (requireDb) {
      expect(testsRan).toBe(6);
    } else {
      expect(requireDb).toBe(false);
    }
  });
});
