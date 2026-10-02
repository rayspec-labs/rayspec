/**
 * The team-notes reference application, deployed from its bundles with the real built CLI on a
 * database of its own, and driven over HTTP the way its UI drives it:
 *  - release 1.0.0 deploys from a directory that holds only the bundle; the UI is served with the
 *    application version, which is not the runtime version;
 *  - two users of one organization create, read, update and delete notes (a delete leaves a
 *    tombstone); a request without a token,
 *    a user of another organization and a note of another organization are refused;
 *  - the 100-note seed loads as the two users (a second load replays and adds nothing), and keyset
 *    pages read back exactly the seed's inventory;
 *  - release 1.1.0, packed against 1.0.0, adds the optional label: the rows survive, unlabelled;
 *  - release 2.0.0, which drops the content column, is refused by pack against 1.1.0 and, packed
 *    on its own, by the deploy — the rows and the active version stay as they were.
 *
 * Skips without DATABASE_URL; the ran-guard hard-fails a REQUIRED run that did not run.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  call,
  cli,
  Deployment,
  EXAMPLES,
  inspectAndVerify,
  invitedMember,
  ownerWithOrg,
  type ParsedJson,
  removeScratch,
  runNode,
  SuiteDatabase,
  scratch,
  signingKeyPem,
} from './test-support/reference-apps.js';

const baseUrl = process.env.DATABASE_URL;
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let armsRan = 0;

const APP = join(EXAMPLES, 'team-notes');
const PORT = 24_000 + (process.pid % 300);

interface SeedNote {
  key: string;
  author: 'first' | 'second';
  title: string;
  content: string;
}
const SEED = JSON.parse(readFileSync(join(APP, 'seed', 'notes.json'), 'utf8')) as {
  inventory: { notes: number; byAuthor: Record<string, number>; digest: string };
  notes: SeedNote[];
};

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function digest(notes: { title: string; content: string }[]): string {
  const pairs = notes
    .map((n) => [n.title, n.content])
    .sort((a, b) => byCodePoint(a[0]!, b[0]!) || byCodePoint(a[1]!, b[1]!));
  return createHash('sha256').update(JSON.stringify(pairs)).digest('hex');
}

describe.skipIf(!baseUrl)('team notes — from bundle to served, updated and refused', () => {
  const db = new SuiteDatabase(baseUrl ?? '', `rayspec_ref_team_notes_${process.pid}`);
  let pem = '';
  let deployment: Deployment;
  let deployDir = '';
  const bundles: Record<string, { path: string; sha256: string }> = {};
  const tokens: Record<'first' | 'second', string> = { first: '', second: '' };
  let orgId = '';

  /** Build `release`, pack it (against `against`), and leave only the bundle in the deploy dir. */
  function packRelease(release: string, against?: string, allowlist?: string): CliRunResult {
    const build = join(scratch(`team-notes-${release}-`), 'app');
    runNode(join(APP, 'build.mjs'), [`--release=${release}`, `--out=${build}`]);
    const output = join(build, `${release}.ray`);
    const extra: string[] = [];
    if (against !== undefined) {
      const previous = join(scratch(`team-notes-${against}-`), 'app');
      runNode(join(APP, 'build.mjs'), [`--release=${against}`, `--out=${previous}`]);
      extra.push('--against', join(previous, 'rayspec.yaml'));
      if (allowlist !== undefined) extra.push('--allowlist', allowlist);
    }
    const run = cli(['pack', '--spec', join(build, 'rayspec.yaml'), '--output', output, ...extra], {
      env: packEnv(),
    });
    if (run.status === 0) {
      const target = join(deployDir, `${release}.ray`);
      copyFileSync(output, target);
      bundles[release] = { path: target, sha256: run.envelope.data.sha256 };
    }
    return run;
  }
  type CliRunResult = ReturnType<typeof cli>;

  function packEnv(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      SHADOW_DATABASE_URL: process.env.SHADOW_DATABASE_URL ?? baseUrl ?? '',
    };
  }

  function deployEnv(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      DATABASE_URL: db.url,
      SHADOW_DATABASE_URL: process.env.SHADOW_DATABASE_URL ?? baseUrl ?? '',
      RAYSPEC_JWT_SIGNING_KEY: pem,
      RAYSPEC_API_KEY_PEPPER: 'team-notes-suite-pepper',
      ALLOWED_ORIGINS: '',
    };
  }

  async function notesRows(): Promise<{ title: string; content: string; label?: string | null }[]> {
    return (await db.sql.unsafe(
      'SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY title, content',
    )) as unknown as { title: string; content: string; label?: string | null }[];
  }

  /** Every note the caller's organization holds, read by keyset pages of `limit`. */
  async function readAll(token: string, limit: number): Promise<ParsedJson[]> {
    const all: ParsedJson[] = [];
    let after: string | null = null;
    for (let page = 0; page < 1000; page += 1) {
      const query = new URLSearchParams({ limit: String(limit) });
      if (after !== null) query.set('after', after);
      const res = await call(`${deployment.base}/api/notes?${query}`, { token });
      expect(res.status, res.text).toBe(200);
      const rows = res.body as unknown as ParsedJson[];
      all.push(...rows);
      if (rows.length < limit) return all;
      after = res.headers.get('x-next-cursor');
      expect(after, 'a full page carries a cursor').not.toBeNull();
    }
    throw new Error('more pages than notes');
  }

  beforeAll(async () => {
    if (!baseUrl) return;
    await db.create();
    pem = await signingKeyPem();
    deployDir = scratch('team-notes-deploy-');
    deployment = new Deployment(deployDir, PORT, deployEnv);
    const v1 = packRelease('v1');
    expect(v1.status, v1.stderr).toBe(0);
  }, 180_000);

  afterAll(async () => {
    deployment?.kill();
    removeScratch();
    if (baseUrl) await db.drop();
  }, 60_000);

  it('deploys 1.0.0 from the bundle alone and serves the UI with its own version', async () => {
    const { inspected } = inspectAndVerify(bundles.v1!.path);
    expect(inspected.applicationVersion).toBe('1.0.0');
    const plan = deployment.dryRun(bundles.v1!.path);
    expect(plan.plan.blockers).toEqual([]);
    expect(plan.plan.requiredBindings).toEqual([]);
    const served = await deployment.serve(bundles.v1!.path, plan.planDigest);
    try {
      const page = await call(`${deployment.base}/`);
      expect(page.status).toBe(200);
      expect(page.text).toContain('<span id="app-version">');
      expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
      const version = await call(`${deployment.base}/app-version.json`);
      expect(version.body).toEqual({
        application: 'team-notes',
        version: '1.0.0',
        fields: ['title', 'content'],
      });
      expect(version.body.version).not.toBe(inspected.runtimeVersion);
      expect((await call(`${deployment.base}/app.js`)).text).toContain('/app-version.json');
      // A deep link answers the UI shell (spa: true); an API path never does.
      expect((await call(`${deployment.base}/notes/123`)).text).toContain('Team notes');
      expect((await call(`${deployment.base}/api/notes`)).status).toBe(401);
    } finally {
      const stopped = await deployment.stop(served);
      expect(stopped.envelope.data).toMatchObject({
        bundleSha256: bundles.v1!.sha256,
        status: 'stopped',
      });
    }
    expect(deployment.active()).toBe(bundles.v1!.sha256);
    armsRan += 1;
  }, 240_000);

  it('lets two users of one organization create, read, update and delete; refuses everyone else', async () => {
    const plan = deployment.dryRun(bundles.v1!.path);
    const served = await deployment.serve(bundles.v1!.path, plan.planDigest);
    try {
      const base = deployment.base;
      const owner = await ownerWithOrg(base, 'first@example.test', 'Team');
      orgId = owner.orgId;
      tokens.first = owner.token;
      tokens.second = await invitedMember(base, owner.token, orgId, 'second@example.test');

      const created = await call(`${base}/api/notes`, {
        token: tokens.first,
        method: 'POST',
        body: { title: 'Draft', content: 'first words' },
      });
      expect(created.status).toBe(201);
      const id = created.body.id as string;
      expect(created.body.created_by).toMatch(/^user:/);

      // The second user reads and edits the first user's note: one organization, shared notes.
      const read = await call(`${base}/api/notes/${id}`, { token: tokens.second });
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ title: 'Draft', content: 'first words' });
      const updated = await call(`${base}/api/notes/${id}`, {
        token: tokens.second,
        method: 'PATCH',
        body: { content: 'edited by the second user' },
      });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ title: 'Draft', content: 'edited by the second user' });

      // Nobody else: no token, a malformed one, and a user of another organization.
      expect((await call(`${base}/api/notes/${id}`)).status).toBe(401);
      expect((await call(`${base}/api/notes`, { token: 'not-a-token' })).status).toBe(401);
      const outsider = await ownerWithOrg(base, 'outsider@example.test', 'Elsewhere');
      expect((await call(`${base}/api/notes/${id}`, { token: outsider.token })).status).toBe(404);
      const outsiderList = await call(`${base}/api/notes`, { token: outsider.token });
      expect(outsiderList.status).toBe(200);
      expect(outsiderList.body).toEqual([]);
      const foreignEdit = await call(`${base}/api/notes/${id}`, {
        token: outsider.token,
        method: 'PATCH',
        body: { content: 'taken over' },
      });
      expect(foreignEdit.status).toBe(404);
      // A switch into an organization the user does not belong to is refused.
      const sw = await fetch(`${base}/v1/orgs/${orgId}/switch`, {
        method: 'POST',
        headers: { authorization: `Bearer ${outsider.token}` },
      });
      expect(sw.status).toBe(404);

      const removed = await call(`${base}/api/notes/${id}`, {
        token: tokens.first,
        method: 'DELETE',
      });
      expect([200, 204]).toContain(removed.status);
      expect((await call(`${base}/api/notes/${id}`, { token: tokens.first })).status).toBe(404);
      expect(await notesRows()).toEqual([]);
      // The store deletes softly: the note stays as a tombstone, hidden from every read.
      const tombstones = await db.sql.unsafe('SELECT id FROM notes WHERE deleted_at IS NOT NULL');
      expect(tombstones.map((r) => r.id)).toEqual([id]);
    } finally {
      await deployment.stop(served);
    }
    armsRan += 1;
  }, 240_000);

  it('loads the 100-note seed as the two users and pages back exactly its inventory', async () => {
    const plan = deployment.dryRun(bundles.v1!.path);
    const served = await deployment.serve(bundles.v1!.path, plan.planDigest);
    try {
      const base = deployment.base;
      const load = async () => {
        let createdCount = 0;
        for (const note of SEED.notes) {
          const res = await call(`${base}/api/notes`, {
            token: tokens[note.author],
            method: 'POST',
            body: { title: note.title, content: note.content },
            headers: { 'idempotency-key': note.key },
          });
          expect([200, 201], res.text).toContain(res.status);
          if (res.status === 201) createdCount += 1;
        }
        return createdCount;
      };
      expect(await load()).toBe(100);
      // The same load again replays every note and creates nothing.
      expect(await load()).toBe(0);

      const pages = await readAll(tokens.second, 30);
      expect(pages).toHaveLength(SEED.inventory.notes);
      expect(new Set(pages.map((n) => n.id)).size).toBe(100);
      expect(digest(pages as unknown as { title: string; content: string }[])).toBe(
        SEED.inventory.digest,
      );
      const byAuthor = new Map<string, number>();
      for (const n of pages) byAuthor.set(n.created_by, (byAuthor.get(n.created_by) ?? 0) + 1);
      expect([...byAuthor.values()].sort()).toEqual([50, 50]);
      // The same inventory through the store itself, not only through the API.
      expect(digest(await notesRows())).toBe(SEED.inventory.digest);
    } finally {
      await deployment.stop(served);
    }
    armsRan += 1;
  }, 300_000);

  it('updates to 1.1.0, which adds the optional label, and keeps every row', async () => {
    const v2 = packRelease('v2', 'v1');
    expect(v2.status, `${v2.stderr}\n${JSON.stringify(v2.envelope.errors)}`).toBe(0);
    const plan = deployment.dryRun(bundles.v2!.path);
    expect(plan.plan.schemaImpact.destructive).toBe(false);
    expect(plan.plan.schemaImpact.productDeltaSha256).not.toBeNull();
    expect(plan.plan.blockers).toEqual([]);
    const served = await deployment.serve(bundles.v2!.path, plan.planDigest);
    try {
      const base = deployment.base;
      expect((await call(`${base}/app-version.json`)).body).toMatchObject({
        version: '1.1.0',
        fields: ['title', 'content', 'label'],
      });
      const rows = await notesRows();
      expect(rows).toHaveLength(100);
      expect(rows.every((r) => r.label === null)).toBe(true);
      expect(digest(rows)).toBe(SEED.inventory.digest);
      const labelled = await call(`${base}/api/notes`, {
        token: tokens.second,
        method: 'POST',
        body: { title: 'With a label', content: 'labelled', label: 'ideas' },
      });
      expect(labelled.status).toBe(201);
      expect(labelled.body.label).toBe('ideas');
    } finally {
      await deployment.stop(served);
    }
    expect(deployment.active()).toBe(bundles.v2!.sha256);
    armsRan += 1;
  }, 300_000);

  it('refuses 2.0.0, which drops the content column, at pack and at deploy', async () => {
    const before = await notesRows();
    expect(before).toHaveLength(101);

    // Packed against 1.1.0, the destructive delta is refused before any bundle is written.
    const refusedPack = packRelease('v3', 'v2');
    expect(refusedPack.status).toBe(2);
    expect(refusedPack.envelope.errors[0].code).toBe('RAY_USAGE');
    expect(JSON.stringify(refusedPack.envelope.errors)).toContain('content');
    expect(bundles.v3).toBeUndefined();

    // Packed on its own, it carries no reviewed delta: the deploy plans the drop and refuses it.
    const alone = packRelease('v3');
    expect(alone.status, alone.stderr).toBe(0);
    const plan = deployment.dryRun(bundles.v3!.path);
    expect(plan.plan.schemaImpact.destructive).toBe(true);
    expect(plan.plan.blockers.map((b: ParsedJson) => b.code)).toContain('RAY_MIGRATION_REQUIRED');
    const refused = deployment.run([bundles.v3!.path, '--plan-digest', plan.planDigest]);
    expect(refused.status).toBe(3);
    expect(refused.envelope.errors[0].code).toBe('RAY_MIGRATION_REQUIRED');
    expect(refused.envelope.errors.map((e: ParsedJson) => e.message).join('\n')).toContain(
      'drop-column on notes.content',
    );
    expect(deployment.active()).toBe(bundles.v2!.sha256);
    expect(await notesRows()).toEqual(before);
    armsRan += 1;
  }, 300_000);
});

// The un-skippable ran-guard: a REQUIRED DB run that silently skipped is a false green.
it('team-notes DB-backed arms actually ran when the environment requires them', () => {
  if (dbRequired) expect(armsRan).toBe(5);
  else expect(true).toBe(true);
});
