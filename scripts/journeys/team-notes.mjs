/**
 * The team-notes journey: a CRUD application with a static UI, in three releases, from source to a
 * second imported environment, driven only through the installed release.
 *
 *   build the three releases → pack 1.0.0 → inspect, verify → deploy on fresh databases (role
 *   separation) → two members and a key-only owner; create, read, update, soft-delete; the 100-note
 *   seed, loaded twice → 1.1.0 (additive, packed against 1.0.0) keeps every row; the largest safe
 *   integers and a decimal past float precision written and read back exactly → 2.0.0 (drops a
 *   column) refused at pack and at deploy → export while serving (the source is fenced: writes 503,
 *   reads 200); the export holds only its manifest and the age payload, and no stored value reads
 *   in it → another identity refused → import into an empty target, cutover, deploy with the
 *   target's own secrets →
 *   identity reset: the source's access token and API key refused, passwords sign in → a new write →
 *   export of that target → import into a second empty target → every note (soft-deleted ones too),
 *   user and membership equal, by digest and by row, the counter and amount exactly → owner recovery for the key-only owner, once →
 *   resume of the first target's fence at its epoch, not at another.
 *
 * A separate source with two organizations is refused by the export (RAY_MULTI_TENANT_UNSUPPORTED)
 * and left unfenced.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  call,
  checkEncryptedExport,
  deployServing,
  Environment,
  exportDeployment,
  importInto,
  leaks,
  newPassword,
  privateFile,
  rayspec,
  register,
  rowsDigest,
  signIn,
  tableText,
} from './lib.mjs';

const NON_ASCII = 'Grüße aus Köln — 東京 ✓';
/** The 1.1.0 counter and amount at the edges of what each column carries exactly. */
const NUMBERS = [
  {
    title: 'Largest counter',
    counter: 9007199254740991,
    amount: '123456789012345678901234.567891',
  },
  { title: 'Smallest counter', counter: -9007199254740991, amount: '-0.000001' },
];

export async function teamNotes(ctx, journey) {
  const app = join(ctx.repo, 'examples', 'team-notes');
  const { loadSeed, readAll } = await import(join(app, 'seed', 'load-seed.mjs'));
  const { inventoryOf } = await import(join(app, 'seed', 'build-seed.mjs'));
  const seed = JSON.parse(readFileSync(join(app, 'seed', 'notes.json'), 'utf8'));
  const packEnv = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    SHADOW_DATABASE_URL: ctx.shadowUrl,
  };

  // ── Source → build → pack → inspect → verify ──────────────────────────────────────────────────
  journey.step('building and packing the three releases');
  const built = {};
  for (const release of ['v1', 'v2', 'v3']) {
    built[release] = join(ctx.work, 'team-notes-build', release);
    const build = runNode(ctx, join(app, 'build.mjs'), [
      `--release=${release}`,
      `--out=${built[release]}`,
    ]);
    journey.check(`build release ${release}`, build.status === 0, build.stderr);
  }
  const bundles = {};
  const packRelease = (release, against, name) => {
    const output = join(ctx.work, `team-notes-${name}.ray`);
    const args = ['pack', '--spec', join(built[release], 'rayspec.yaml'), '--output', output];
    if (against !== undefined) args.push('--against', join(built[against], 'rayspec.yaml'));
    const run = rayspec(ctx, args, { env: packEnv });
    if (run.status === 0) bundles[name] = { path: output, sha256: run.envelope.data.sha256 };
    return run;
  };
  const v1 = packRelease('v1', undefined, '1.0.0');
  journey.check('pack 1.0.0', v1.status === 0, JSON.stringify(v1.envelope.errors));
  const inspected = rayspec(ctx, ['bundle', 'inspect', bundles['1.0.0'].path]);
  journey.check('bundle inspect 1.0.0', inspected.status === 0, inspected.stderr);
  const verified = rayspec(ctx, ['bundle', 'verify', bundles['1.0.0'].path]);
  journey.check('bundle verify 1.0.0', verified.status === 0, JSON.stringify(verified.envelope));
  journey.check(
    'the bundle states the application version, which is not the runtime version',
    inspected.envelope.data.applicationVersion === '1.0.0' &&
      inspected.envelope.data.runtimeVersion === ctx.version &&
      inspected.envelope.data.runtimeVersion !== '1.0.0',
    JSON.stringify(inspected.envelope.data),
  );

  // ── A source with two organizations is refused on export ──────────────────────────────────────
  journey.step('a source with two organizations');
  await multiTenantRefusal(ctx, journey, bundles['1.0.0'].path);

  // ── The source: deployed from the bundle alone ────────────────────────────────────────────────
  journey.step('deploying 1.0.0 on the source');
  const source = await new Environment(ctx, 'team-notes-source').create();
  source.mintSecrets();
  const v1Bundle = join(source.dir, 'team-notes-1.0.0.ray');
  copyFileSync(bundles['1.0.0'].path, v1Bundle);
  let { plan, served } = await deployServing(ctx, journey, source, v1Bundle);
  journey.check('the first plan needs no binding', plan.plan.requiredBindings.length === 0);
  const base = source.base;
  const version = await call(`${base}/app-version.json`);
  journey.check(
    'the UI shows the application version 1.0.0',
    version.body.version === '1.0.0' && version.body.application === 'team-notes',
    version.text,
  );
  journey.check('the UI is served', (await call(`${base}/`)).text.includes('app-version'));

  // Two members of one organization, and an owner whose only credential is an API key.
  const people = {
    first: { email: 'first@example.test', password: newPassword('first') },
    second: { email: 'second@example.test', password: newPassword('second') },
    keyholder: { email: 'keyholder@example.test', password: newPassword('keyholder') },
  };
  const access = await register(base, people.first.email, people.first.password);
  const org = await call(`${base}/v1/orgs`, {
    method: 'POST',
    token: access,
    body: { name: `Team ${NON_ASCII}` },
  });
  journey.check('the first user creates the organization', org.status === 201, org.text);
  const orgId = org.body.id;
  const first = await signIn(base, people.first.email, people.first.password, orgId);
  const invite = await call(`${base}/v1/orgs/${orgId}/invites`, {
    method: 'POST',
    token: first.token,
    body: { email: people.second.email, role: 'member' },
  });
  journey.check('the owner invites the second user', invite.status === 201, invite.text);
  const accepted = await call(`${base}/v1/invites/accept`, {
    method: 'POST',
    body: { token: invite.body.inviteToken, password: people.second.password },
  });
  journey.check('the second user joins by the invite', accepted.status === 201, accepted.text);
  const tokens = { first: first.token, second: accepted.body.accessToken };

  // A pending invite and a refresh session the source's secrets key, to see them reset.
  const pending = await call(`${base}/v1/orgs/${orgId}/invites`, {
    method: 'POST',
    token: tokens.first,
    body: { email: 'later@example.test', role: 'member' },
  });
  journey.check('a pending invite exists at the source', pending.status === 201);

  // The key-only owner: signs up, becomes an owner, mints an API key, and from then on holds only
  // the key (the password hash removed, as for an account that only ever used a key).
  await register(base, people.keyholder.email, people.keyholder.password);
  await source.query(
    `INSERT INTO memberships (org_id, user_id, role, status)
     SELECT $1, id, 'owner', 'active' FROM users WHERE email = $2`,
    [orgId, people.keyholder.email],
  );
  const keyholder = await signIn(base, people.keyholder.email, people.keyholder.password, orgId);
  const minted = await call(`${base}/v1/orgs/${orgId}/api-keys`, {
    method: 'POST',
    token: keyholder.token,
    body: { name: 'reader', scopes: ['store:read'] },
  });
  journey.check('the key-only owner mints an API key', minted.status === 201, minted.text);
  const apiKey = minted.body.plaintext;
  await source.query('UPDATE users SET password_hash = NULL WHERE email = $1', [
    people.keyholder.email,
  ]);

  // Create, read, update, delete — two users, one organization.
  const created = await call(`${base}/api/notes`, {
    method: 'POST',
    token: tokens.first,
    body: { title: 'Draft', content: NON_ASCII },
  });
  journey.check('create a note', created.status === 201, created.text);
  const noteId = created.body.id;
  const read = await call(`${base}/api/notes/${noteId}`, { token: tokens.second });
  journey.check('the second user reads it', read.status === 200 && read.body.content === NON_ASCII);
  const edited = await call(`${base}/api/notes/${noteId}`, {
    method: 'PATCH',
    token: tokens.second,
    body: { content: `${NON_ASCII} — edited` },
  });
  journey.check('the second user updates it', edited.status === 200, edited.text);
  const reread = await call(`${base}/api/notes/${noteId}`, { token: tokens.first });
  journey.check(
    'the first user reads the edited content back',
    reread.status === 200 &&
      reread.body.content === `${NON_ASCII} — edited` &&
      reread.body.title === 'Draft',
    reread.text,
  );
  journey.check('no token is refused', (await call(`${base}/api/notes`)).status === 401);
  const doomed = await call(`${base}/api/notes`, {
    method: 'POST',
    token: tokens.first,
    body: { title: 'Removed later', content: 'kept as a soft-deleted row' },
  });
  const removed = await call(`${base}/api/notes/${doomed.body.id}`, {
    method: 'DELETE',
    token: tokens.second,
  });
  journey.check('delete a note', [200, 204].includes(removed.status), removed.text);
  journey.check(
    'a deleted note reads 404',
    (await call(`${base}/api/notes/${doomed.body.id}`, { token: tokens.first })).status === 404,
  );
  const [softDeleted] = await source.query(
    'SELECT count(*)::int AS n FROM notes WHERE deleted_at IS NOT NULL',
  );
  journey.check('the deleted note stays as a soft-deleted row', softDeleted.n === 1);

  // The seed: 100 notes as the two users; a second load replays and creates nothing.
  const firstLoad = await loadSeed(base, tokens, seed);
  const secondLoad = await loadSeed(base, tokens, seed);
  journey.check('the seed creates 100 notes', firstLoad === 100, String(firstLoad));
  journey.check('loading the seed again creates none', secondLoad === 0, String(secondLoad));
  const listed = await readAll(base, tokens.second, 30);
  const seedOnly = listed.filter((n) => n.title !== 'Draft');
  journey.check(
    'keyset pages read back the seed inventory exactly',
    listed.length === 101 && inventoryOf(seedOnly).digest === seed.inventory.digest,
    `${listed.length} notes`,
  );
  const keyRead = await call(`${base}/api/notes?limit=5`, { token: apiKey });
  journey.check('the API key reads notes at the source', keyRead.status === 200, keyRead.text);
  journey.check(
    'the key-only owner has no password left',
    (await signIn(base, people.keyholder.email, people.keyholder.password, orgId)).status === 401,
  );
  await served.stop();

  // ── An additive update: 1.1.0 adds the optional label ─────────────────────────────────────────
  journey.step('updating to 1.1.0');
  const before = await notesState(source);
  const v2 = packRelease('v2', 'v1', '1.1.0');
  journey.check('pack 1.1.0 against 1.0.0', v2.status === 0, JSON.stringify(v2.envelope.errors));
  const v2Bundle = join(source.dir, 'team-notes-1.1.0.ray');
  copyFileSync(bundles['1.1.0'].path, v2Bundle);
  ({ plan, served } = await deployServing(ctx, journey, source, v2Bundle));
  journey.check(
    'the 1.1.0 plan is additive and carries a delta',
    plan.plan.schemaImpact.destructive === false &&
      plan.plan.schemaImpact.productDeltaSha256 !== null,
    JSON.stringify(plan.plan.schemaImpact),
  );
  const afterUpdate = await notesState(source);
  journey.check(
    'every note survives the update unchanged',
    afterUpdate.digest === before.digest && afterUpdate.count === before.count,
  );
  const [unlabelled] = await source.query(
    'SELECT count(*)::int AS n FROM notes WHERE label IS NULL',
  );
  journey.check('existing notes read back unlabelled', unlabelled.n === before.count);
  const labelled = await call(`${base}/api/notes`, {
    method: 'POST',
    token: tokens.first,
    body: { title: 'Labelled', content: 'after the update', label: 'ideas' },
  });
  journey.check(
    'a labelled note is written',
    labelled.status === 201 && labelled.body.label === 'ideas',
  );
  journey.check(
    'the UI shows 1.1.0',
    (await call(`${base}/app-version.json`)).body.version === '1.1.0',
  );
  // The largest safe integers and an exact decimal past float precision, written and read back.
  for (const note of NUMBERS) {
    const written = await call(`${base}/api/notes`, {
      method: 'POST',
      token: tokens.first,
      body: { ...note, content: 'numbers' },
    });
    journey.check(`write "${note.title}"`, written.status === 201, written.text);
    const back = await call(`${base}/api/notes/${written.body.id}`, { token: tokens.second });
    journey.check(
      `"${note.title}" reads back exactly`,
      back.status === 200 && back.body.counter === note.counter && back.body.amount === note.amount,
      back.text,
    );
  }
  journey.check(
    'the database holds the numbers exactly',
    JSON.stringify(await numbersOf(source)) === JSON.stringify(expectedNumbers()),
    JSON.stringify(await numbersOf(source)),
  );
  await served.stop();

  // ── A destructive update: 2.0.0 drops content, and is refused ─────────────────────────────────
  journey.step('refusing 2.0.0');
  const kept = await notesState(source);
  const refusedPack = packRelease('v3', 'v2', '2.0.0-against');
  journey.check(
    'pack refuses 2.0.0 against 1.1.0',
    refusedPack.status === 2 && refusedPack.envelope.errors?.[0]?.code === 'RAY_USAGE',
    JSON.stringify(refusedPack.envelope.errors),
  );
  const alone = packRelease('v3', undefined, '2.0.0');
  journey.check('pack 2.0.0 on its own', alone.status === 0);
  const v3Bundle = join(source.dir, 'team-notes-2.0.0.ray');
  copyFileSync(bundles['2.0.0'].path, v3Bundle);
  const dry3 = rayspec(ctx, ['deploy', v3Bundle, '--dry-run', '--state-dir', source.stateDir], {
    env: source.env(),
    cwd: source.dir,
  });
  journey.check(
    'the 2.0.0 plan is destructive and blocked',
    dry3.status === 0 &&
      dry3.envelope.data.plan.schemaImpact.destructive === true &&
      dry3.envelope.data.plan.blockers.some((b) => b.code === 'RAY_MIGRATION_REQUIRED'),
    JSON.stringify(dry3.envelope.data?.plan?.blockers),
  );
  const refused = rayspec(
    ctx,
    [
      'deploy',
      v3Bundle,
      '--plan-digest',
      dry3.envelope.data.planDigest,
      '--state-dir',
      source.stateDir,
    ],
    { env: source.env(), cwd: source.dir },
  );
  journey.check(
    'the deploy refuses 2.0.0 naming the dropped column',
    refused.status === 3 &&
      refused.envelope.errors[0].code === 'RAY_MIGRATION_REQUIRED' &&
      JSON.stringify(refused.envelope.errors).includes('drop-column on notes.content'),
    JSON.stringify(refused.envelope.errors),
  );
  journey.check('1.1.0 stays active', source.active() === bundles['1.1.0'].sha256);
  journey.check('no note changed', (await notesState(source)).digest === kept.digest);

  // ── A frozen encrypted export while the source serves ─────────────────────────────────────────
  journey.step('exporting the source');
  await ctx.tools();
  ({ served } = await deployServing(ctx, journey, source, v2Bundle, {
    label: 'team-notes-source-2',
  }));
  const sourceToken = tokens.first;
  const { identity, recipient } = await ctx.ageKeyPair();
  const identityFile = privateFile(join(ctx.work, 'team-notes-identity.txt'), `${identity}\n`);
  const expected = await sourceState(source);
  const migration = join(ctx.work, 'team-notes-source.migration.ray');
  const exported = exportDeployment(ctx, source, recipient, migration);
  journey.check(
    'the export writes one encrypted bundle and leaves the source fenced',
    exported.status === 0 && exported.envelope.data.sourceState === 'fenced',
    `${exported.status} ${JSON.stringify(exported.envelope.errors)} ${exported.stderr.slice(-1500)}`,
  );
  journey.check(
    'no secret reaches the export output',
    leaks(`${exported.stdout}${exported.stderr}`, [
      identity,
      apiKey,
      ...Object.values(source.passwords),
    ]) === 0,
  );
  checkEncryptedExport(journey, 'the source export', migration, [
    `${NON_ASCII} — edited`,
    ...seed.notes.slice(0, 5).map((n) => n.content),
    people.first.email,
    NUMBERS[0].amount,
  ]);
  journey.note(
    'source export excludedDataCategories',
    exported.envelope.data.excludedDataCategories,
  );
  const fencedWrite = await call(`${base}/api/notes`, {
    method: 'POST',
    token: sourceToken,
    body: { title: 'while fenced', content: 'refused' },
  });
  journey.check(
    'a write to the fenced source answers 503',
    fencedWrite.status === 503,
    fencedWrite.text,
  );
  journey.check(
    'a read of the fenced source answers 200',
    (await call(`${base}/api/notes?limit=1`, { token: sourceToken })).status === 200,
  );
  journey.check(
    'the fenced source is unchanged',
    (await sourceState(source)).notes === expected.notes,
  );
  await served.stop();

  // ── Import into an empty target, cutover, deploy with the target's own secrets ────────────────
  journey.step('importing into the first target');
  const targetA = await new Environment(ctx, 'team-notes-target-a').create();
  // Only the identity the export was encrypted to opens it.
  const stranger = await ctx.ageKeyPair();
  const strangerFile = privateFile(
    join(ctx.work, 'team-notes-other-identity.txt'),
    `${stranger.identity}\n`,
  );
  const wrongIdentity = rayspec(
    ctx,
    [
      'import',
      migration,
      '--target',
      targetA.stateDir,
      '--identity-file',
      strangerFile,
      '--dry-run',
    ],
    { env: targetA.env(), cwd: targetA.dir },
  );
  journey.check(
    'an import with another identity is refused before anything is restored',
    wrongIdentity.status === 2 &&
      wrongIdentity.envelope.errors?.[0]?.code === 'RAY_DECRYPTION_FAILED',
    `${wrongIdentity.status} ${JSON.stringify(wrongIdentity.envelope.errors)}`,
  );
  const importedA = importInto(ctx, journey, targetA, migration, identityFile);
  journey.check(
    'the first import verifies checksums, counts, objects and references',
    JSON.stringify(importedA.data.verification) ===
      JSON.stringify({
        checksums: 'match',
        tableCounts: 'match',
        objects: 'match',
        referenceIntegrity: 'match',
      }),
    JSON.stringify(importedA.data.verification),
  );
  journey.check(
    'the first import resets credentials and keeps password hashes',
    importedA.data.credentialReset.passwordHashes === 'preserved' &&
      importedA.data.credentialReset.apiKeys === 'reset' &&
      importedA.data.credentialReset.sessions === 'reset' &&
      importedA.data.credentialReset.invites === 'reset' &&
      importedA.data.credentialReset.forcedLogin === true,
  );
  const signInLine = importedA.stderr.split('\n').find((l) => l.startsWith('sign in again')) ?? '';
  journey.check(
    'the import names who signs in again',
    signInLine.includes('(2)') &&
      signInLine.includes(people.first.email) &&
      signInLine.includes(people.second.email),
    signInLine,
  );
  const recoveryLine =
    importedA.stderr.split('\n').find((l) => l.startsWith('owner recovery')) ?? '';
  journey.check(
    'the import names the key-only owner for owner recovery',
    recoveryLine.includes(`${people.keyholder.email} (owner)`),
    recoveryLine,
  );
  journey.check(
    'the first target holds the source state',
    sameState(expected, await sourceState(targetA)),
  );
  for (const table of ['sessions', 'api_keys', 'invites']) {
    const [row] = await targetA.query(`SELECT count(*)::int AS n FROM ${table}`);
    journey.check(`the first target carries no ${table}`, row.n === 0);
  }
  const targetABundle = join(targetA.dir, 'team-notes-1.1.0.ray');
  copyFileSync(v2Bundle, targetABundle);
  ({ served } = await deployServing(ctx, journey, targetA, targetABundle));
  await identityReset(journey, targetA.base, {
    orgId,
    people: [people.first, people.second],
    oldTokens: [sourceToken],
    oldKeys: [apiKey],
  });
  const firstOnA = await signIn(targetA.base, people.first.email, people.first.password, orgId);
  const notesOnA = await readAll(targetA.base, firstOnA.token, 50);
  journey.check(
    'the first target serves every live note',
    inventoryOf(notesOnA).digest === inventoryOf(await liveNotes(source)).digest,
  );
  const newWrite = await call(`${targetA.base}/api/notes`, {
    method: 'POST',
    token: firstOnA.token,
    body: { title: 'Written on the first target', content: `${NON_ASCII} (target)`, label: null },
  });
  journey.check('a new write on the first target', newWrite.status === 201, newWrite.text);
  journey.check('the source stays fenced', (await source.fence())?.state === 'fenced');

  // ── Exit export of the first target, import into a second empty target ────────────────────────
  journey.step('exporting the first target and importing into the second');
  const expectedA = await sourceState(targetA);
  journey.check('the new write is in the first target', expectedA.notes === expected.notes + 1);
  const exitBundle = join(ctx.work, 'team-notes-target-a.migration.ray');
  const exitExport = exportDeployment(ctx, targetA, recipient, exitBundle);
  journey.check(
    'the exit export of the first target',
    exitExport.status === 0 && exitExport.envelope.data.sourceState === 'fenced',
    `${exitExport.status} ${JSON.stringify(exitExport.envelope.errors)} ${exitExport.stderr.slice(-1500)}`,
  );
  checkEncryptedExport(journey, 'the exit export', exitBundle, [
    `${NON_ASCII} (target)`,
    NUMBERS[0].amount,
    people.second.email,
  ]);
  const targetAEpoch = exitExport.envelope.data.fenceEpoch;
  await served.stop();
  const targetB = await new Environment(ctx, 'team-notes-target-b').create();
  importInto(ctx, journey, targetB, exitBundle, identityFile);
  const stateB = await sourceState(targetB);
  journey.check('the second target holds the first target state', sameState(expectedA, stateB));
  journey.check(
    'user ids and password hashes are carried, soft-deleted rows included',
    stateB.users === expected.users && stateB.softDeleted === 1,
  );
  journey.check(
    'every note row is carried byte for byte',
    JSON.stringify(await tableText(ctx.adminUrl, targetB.db, 'notes')) ===
      JSON.stringify(await tableText(ctx.adminUrl, targetA.db, 'notes')),
  );
  const targetBBundle = join(targetB.dir, 'team-notes-1.1.0.ray');
  copyFileSync(v2Bundle, targetBBundle);
  ({ served } = await deployServing(ctx, journey, targetB, targetBBundle));
  await identityReset(journey, targetB.base, {
    orgId,
    people: [people.first, people.second],
    oldTokens: [sourceToken, firstOnA.token],
    oldKeys: [apiKey],
  });
  const secondOnB = await signIn(targetB.base, people.second.email, people.second.password, orgId);
  const notesOnB = await readAll(targetB.base, secondOnB.token, 50);
  journey.check(
    'the second target serves every live note, the new write included',
    notesOnB.length === notesOnA.length + 1 &&
      notesOnB.some(
        (n) => n.title === 'Written on the first target' && n.content === `${NON_ASCII} (target)`,
      ),
  );
  journey.check(
    'the counter and amount arrive exactly in both targets',
    JSON.stringify(await numbersOf(targetA)) === JSON.stringify(expectedNumbers()) &&
      JSON.stringify(await numbersOf(targetB)) === JSON.stringify(expectedNumbers()),
    JSON.stringify(await numbersOf(targetB)),
  );
  for (const note of NUMBERS) {
    const [row] = await targetB.query('SELECT id FROM notes WHERE title = $1', [note.title]);
    const back = await call(`${targetB.base}/api/notes/${row?.id}`, { token: secondOnB.token });
    journey.check(
      `the second target serves "${note.title}" exactly`,
      back.status === 200 && back.body.counter === note.counter && back.body.amount === note.amount,
      back.text,
    );
  }
  journey.check(
    'the UI of the second target shows 1.1.0',
    (await call(`${targetB.base}/app-version.json`)).body.version === '1.1.0',
  );

  // Owner recovery for the owner who held only an API key: issued once, redeemed once.
  const recoveryEnv = targetB.env();
  const issued = rayspec(ctx, ['tenant', 'recover-owner', '--email', people.keyholder.email], {
    env: recoveryEnv,
    cwd: targetB.dir,
  });
  let recovery = {};
  try {
    recovery = JSON.parse(issued.stdout);
  } catch {
    recovery = {};
  }
  journey.check(
    'owner recovery is issued for the key-only owner',
    issued.status === 0 && recovery.ok === true,
    issued.stdout.replace(/"recoveryToken":"[^"]*"/, '"recoveryToken":"…"'),
  );
  const newOwnerPassword = newPassword('recovered');
  const redeemed = await call(`${targetB.base}${recovery.redeemPath}`, {
    method: 'POST',
    body: { token: recovery.recoveryToken, password: newOwnerPassword },
  });
  journey.check(
    'the recovery token redeems',
    redeemed.status === 200 && redeemed.body.role === 'owner',
    redeemed.text,
  );
  const again = await call(`${targetB.base}${recovery.redeemPath}`, {
    method: 'POST',
    body: { token: recovery.recoveryToken, password: `${newOwnerPassword}-again` },
  });
  journey.check('the recovery token redeems once', again.status === 400);
  const reissued = await call(`${targetB.base}/v1/orgs/${orgId}/api-keys`, {
    method: 'POST',
    token: redeemed.body.accessToken,
    body: { name: 'reader', scopes: ['store:read'] },
  });
  journey.check('the recovered owner reissues an API key', reissued.status === 201);
  journey.check(
    'the reissued key reads the notes',
    (await call(`${targetB.base}/api/notes?limit=1`, { token: reissued.body.plaintext })).status ===
      200,
  );
  await served.stop();

  // ── resume releases the first target's export fence at its epoch only ─────────────────────────
  journey.step('resuming the first target');
  const wrongEpoch = rayspec(
    ctx,
    [
      'resume',
      '--deployment',
      targetA.deploymentId(),
      '--fence-epoch',
      String(targetAEpoch + 1),
      '--state-dir',
      targetA.stateDir,
    ],
    { env: targetA.env(), cwd: targetA.dir },
  );
  journey.check(
    'resume at another epoch is refused',
    wrongEpoch.status === 4 && wrongEpoch.envelope.errors[0].code === 'RAY_FENCE_MISMATCH',
    JSON.stringify(wrongEpoch.envelope.errors),
  );
  const resumed = rayspec(
    ctx,
    [
      'resume',
      '--deployment',
      targetA.deploymentId(),
      '--fence-epoch',
      String(targetAEpoch),
      '--state-dir',
      targetA.stateDir,
    ],
    { env: targetA.env(), cwd: targetA.dir },
  );
  journey.check(
    'resume at the export epoch releases the fence',
    resumed.status === 0 &&
      resumed.envelope.data.released === true &&
      (await targetA.fence()).state === 'open',
    JSON.stringify(resumed.envelope),
  );

  journey.note('notes carried', {
    source: expected.notes,
    firstTarget: expectedA.notes,
    secondTarget: stateB.notes,
  });
  journey.note('soft-deleted notes carried', stateB.softDeleted);
  journey.note('notes digest', stateB.digest);
}

/** Run an example's own Node script (its build) to completion. */
export function runNode(ctx, script, args) {
  const run = spawnSync(process.execPath, [script, ...args], { cwd: ctx.work, encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** The counter and amount rows, as the database renders them, by title. */
async function numbersOf(environment) {
  return environment.query(
    'SELECT title, counter::text AS counter, amount::text AS amount FROM notes WHERE counter IS NOT NULL ORDER BY title',
  );
}

/** What numbersOf must read: the canonical rendering of NUMBERS, by title. */
function expectedNumbers() {
  return NUMBERS.map((n) => ({
    title: n.title,
    counter: String(n.counter),
    amount: n.amount,
  })).sort((a, b) => (a.title < b.title ? -1 : 1));
}

/** The live notes, as rows, for the seed inventory digest. */
async function liveNotes(environment) {
  return environment.query('SELECT title, content, created_by FROM notes WHERE deleted_at IS NULL');
}

async function notesState(environment) {
  const rows = await environment.query('SELECT id, title, content, deleted_at FROM notes');
  return { count: rows.length, digest: rowsDigest(rows, ['id', 'title', 'content', 'deleted_at']) };
}

/** The state an import must carry: notes (soft-deleted ones too), users, organizations, members. */
async function sourceState(environment) {
  const notes = await environment.query(
    `SELECT id, tenant_id, title, content, label, counter::text AS counter, amount::text AS amount,
            created_by, created_at, deleted_at
       FROM notes`,
  );
  const users = await environment.query('SELECT id, email, password_hash FROM users');
  const orgs = await environment.query('SELECT id, name, slug FROM orgs');
  const members = await environment.query('SELECT org_id, user_id, role, status FROM memberships');
  return {
    notes: notes.length,
    softDeleted: notes.filter((n) => n.deleted_at !== null).length,
    nonAscii: notes.filter((n) => [...n.content].some((c) => c.codePointAt(0) > 0x7f)).length,
    digest: rowsDigest(
      notes.map((n) => ({
        ...n,
        created_at: n.created_at?.toISOString(),
        deleted_at: n.deleted_at?.toISOString() ?? null,
      })),
      [
        'id',
        'tenant_id',
        'title',
        'content',
        'label',
        'counter',
        'amount',
        'created_by',
        'created_at',
        'deleted_at',
      ],
    ),
    users: rowsDigest(users, ['id', 'email', 'password_hash']),
    orgs: rowsDigest(orgs, ['id', 'name', 'slug']),
    members: rowsDigest(members, ['org_id', 'user_id', 'role', 'status']),
  };
}

function sameState(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The documented identity reset on a target: every member signs in with the password they had;
 * every access token and API key the earlier environment issued is refused.
 */
async function identityReset(journey, base, { orgId, people, oldTokens, oldKeys }) {
  for (const person of people) {
    const signed = await signIn(base, person.email, person.password, orgId);
    journey.check(`${person.email} signs in with the password they had`, signed.status === 200);
  }
  for (const [i, token] of oldTokens.entries()) {
    const res = await call(`${base}/api/notes?limit=1`, { token });
    journey.check(
      `an access token of an earlier environment is refused (${i + 1})`,
      res.status === 401,
      String(res.status),
    );
  }
  for (const key of oldKeys) {
    const res = await call(`${base}/api/notes?limit=1`, { token: key });
    journey.check('an API key of the source is refused', res.status === 401, String(res.status));
  }
}

/** A source holding two organizations: the export refuses it and leaves it unfenced. */
async function multiTenantRefusal(ctx, journey, bundle) {
  const env = await new Environment(ctx, 'team-notes-two-orgs').create();
  env.mintSecrets();
  const local = join(env.dir, 'team-notes-1.0.0.ray');
  copyFileSync(bundle, local);
  const { served } = await deployServing(ctx, journey, env, local);
  for (const who of ['one', 'two']) {
    const token = await register(env.base, `${who}@example.test`, newPassword(who));
    const org = await call(`${env.base}/v1/orgs`, {
      method: 'POST',
      token,
      body: { name: `Org ${who}` },
    });
    journey.check(`two organizations: ${who} creates one`, org.status === 201);
  }
  await served.stop();
  await ctx.tools();
  const { recipient } = await ctx.ageKeyPair();
  const output = join(env.dir, 'refused.migration.ray');
  const run = exportDeployment(ctx, env, recipient, output);
  journey.check(
    'the export refuses a source with two organizations',
    run.status === 3 && run.envelope.errors?.[0]?.code === 'RAY_MULTI_TENANT_UNSUPPORTED',
    `${run.status} ${JSON.stringify(run.envelope.errors)}`,
  );
  journey.check('nothing is written', !existsSync(output));
  const fence = await env.fence();
  journey.check(
    'the refused source is not fenced',
    fence === null || fence.state !== 'fenced',
    JSON.stringify(fence),
  );
  await env.drop();
}
