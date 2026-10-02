/**
 * The document-intake journey: a durable file workflow on the deterministic extraction provider,
 * from source to a second imported environment, driven only through the installed release.
 *
 *   pack → inspect, verify (no binding, no egress) → the organization and its owner settled with
 *   `tenant ensure` → deploy on fresh databases (role separation, a workflow system database, an fs
 *   blob root) → the 50-document seed uploaded and processed into its expected records → a retried
 *   upload and submit replay; different bytes are 409 → an unsupported type (415), a file whose bytes
 *   are not what it declares, and hostile markup → a crash before persistence and a crash after it,
 *   each recovered by a restart into exactly one record → 1.1.0 (adds a column) keeps every record →
 *   2.0.0 (drops one) refused → export → import, cutover, deploy, every record and stored file
 *   carried → a new document processed on the target → export → import into a second target, the
 *   same again.
 *
 * Cancelling a running document workflow is not offered by the runtime: a workflow run is not a
 * run the cancel route reaches. The journey records that the route answers 404 for it.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import postgres from 'postgres';
import {
  call,
  canonical,
  checkEncryptedExport,
  deployServing,
  Environment,
  exportDeployment,
  importInto,
  newPassword,
  pause,
  privateFile,
  rayspec,
  rowsDigest,
  withDbName,
} from './lib.mjs';

const TENANT = '7c3a51e2-0d4b-4c86-9a43-2f1e5b6d8a90';

export async function documentIntake(ctx, journey) {
  const app = join(ctx.repo, 'examples', 'document-intake');
  const manifest = JSON.parse(readFileSync(join(app, 'seed', 'manifest.json'), 'utf8'));
  const packEnv = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    SHADOW_DATABASE_URL: ctx.shadowUrl,
  };
  const specV1 = readFileSync(join(app, 'document-intake.product.yaml'), 'utf8');

  // ── Pack → inspect → verify (there is nothing to build) ───────────────────────────────────────
  journey.step('packing');
  const releases = join(ctx.work, 'document-intake-src');
  const tree = (name, spec) => {
    const dir = join(releases, name);
    copyTree(app, dir);
    writeFileSync(join(dir, 'document-intake.product.yaml'), spec);
    return join(dir, 'document-intake.product.yaml');
  };
  const spec1 = tree('1.0.0', specV1);
  const bundle1 = join(ctx.work, 'document-intake-1.0.0.ray');
  const packed = rayspec(ctx, ['pack', '--spec', spec1, '--output', bundle1], { env: packEnv });
  journey.check('pack 1.0.0', packed.status === 0, JSON.stringify(packed.envelope.errors));
  const inspected = rayspec(ctx, ['bundle', 'inspect', bundle1]);
  journey.check('bundle inspect', inspected.status === 0);
  journey.check(
    'the bundle declares no binding and no egress host',
    inspected.envelope.data.egressHosts.length === 0 &&
      (inspected.envelope.data.bindings ?? []).length === 0,
    JSON.stringify(inspected.envelope.data),
  );
  journey.check('bundle verify', rayspec(ctx, ['bundle', 'verify', bundle1]).status === 0);

  // ── The source ────────────────────────────────────────────────────────────────────────────────
  journey.step('deploying the source');
  const source = await new Environment(ctx, 'document-intake-source', {
    workflowSystem: true,
  }).create();
  source.mintSecrets();
  const extra = { RAYSPEC_PRODUCT_TENANT_ID: TENANT, RAYSPEC_EXTRACTION_MODE: 'deterministic' };
  const inviteFile = join(source.dir, 'owner.token');
  const ensured = rayspec(
    ctx,
    [
      'tenant',
      'ensure',
      '--org-id',
      TENANT,
      '--name',
      'Intake',
      '--owner-email',
      'owner@example.test',
      '--owner-invite-out',
      inviteFile,
    ],
    { env: source.env(), cwd: source.dir },
  );
  journey.check('tenant ensure settles the organization', ensured.status === 0, ensured.stderr);
  const local1 = join(source.dir, 'document-intake-1.0.0.ray');
  copyFileSync(bundle1, local1);
  let { plan, served } = await deployServing(ctx, journey, source, local1, {
    env: source.env(extra),
  });
  journey.check('the plan needs no binding', plan.plan.requiredBindings.length === 0);
  journey.check(
    'the boot says the extraction provider is not for production',
    served.output().includes('not for production extraction'),
  );
  const password = newPassword('owner');
  const accepted = await call(`${source.base}/v1/invites/accept`, {
    method: 'POST',
    body: { token: readFileSync(inviteFile, 'utf8').trim(), password },
  });
  journey.check('the owner redeems the invite', accepted.status === 201, accepted.text);
  let token = accepted.body.accessToken;
  let base = source.base;
  const upload = (id, bytes, type, at = base, bearer = token) =>
    call(`${at}/files/${id}`, {
      method: 'PUT',
      token: bearer,
      raw: bytes,
      headers: { 'content-type': type },
    });
  const submit = (id, at = base, bearer = token) =>
    call(`${at}/files/${id}/submit`, { method: 'POST', token: bearer });

  // The seed: 50 documents, each processed into its expected record.
  journey.step('processing the seed');
  for (const doc of manifest.documents) {
    const bytes = readFileSync(join(app, 'seed', doc.file));
    const up = await upload(doc.file_id, bytes, doc.content_type);
    journey.check(
      `upload ${doc.file_id}`,
      up.status === 200 && up.body.sha256 === doc.sha256,
      up.text,
    );
    journey.check(`submit ${doc.file_id}`, (await submit(doc.file_id)).status === 200);
  }
  const statuses = await settled(
    source,
    manifest.documents.map((d) => d.file_id),
  );
  journey.check(
    'every seed workflow completes',
    [...statuses.values()].every((s) => s === 'completed'),
    JSON.stringify([...statuses]),
  );
  await expectRecords(journey, base, token, manifest, 'source');
  const blobsAfterSeed = blobInventory(source.blobRoot);
  const uploadedDigests = new Set(manifest.documents.map((d) => d.sha256));
  journey.check(
    'precondition: the 50 seed documents are 50 distinct files',
    manifest.documents.length === 50 && uploadedDigests.size === 50,
  );
  journey.check(
    'every uploaded file is stored once, with the bytes uploaded, and nothing else is stored',
    blobsAfterSeed.files === uploadedDigests.size &&
      [...uploadedDigests].every(
        (digest) => blobsAfterSeed.digests.filter((d) => d === digest).length === 1,
      ),
    `${blobsAfterSeed.files} files for ${uploadedDigests.size} documents`,
  );

  // Retries: the same bytes replay, a second submit replays, different bytes are a conflict.
  journey.step('retries, refusals and hostile input');
  const first = manifest.documents[0];
  const firstBytes = readFileSync(join(app, 'seed', first.file));
  const again = await upload(first.file_id, firstBytes, first.content_type);
  journey.check('a retried upload replays', again.status === 200 && again.body.deduped === true);
  const resubmitted = await submit(first.file_id);
  journey.check(
    'a retried submit replays',
    resubmitted.status === 200 && resubmitted.body.deduped === true,
  );
  const divergent = await upload(first.file_id, Buffer.from('Title: changed\n'), 'text/plain');
  journey.check('different bytes under a submitted id are 409', divergent.status === 409);
  const [runs] = await source.query(
    'SELECT count(*)::int AS n FROM workflow_runs WHERE idempotency_key = $1',
    [`file_id:${first.file_id}`],
  );
  journey.check('one workflow run for the retried document', runs.n === 1);

  // An unsupported type, a file whose bytes are not the type it declares, hostile markup.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  journey.check(
    'an unsupported type is 415',
    (await upload('bad-type', png, 'image/png')).status === 415,
  );
  const elf = Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
    Buffer.alloc(120, 0),
  ]);
  const disguised = await upload('bad-disguised', elf, 'application/pdf');
  journey.check(
    'an executable declared as a PDF is accepted for parsing',
    disguised.status === 200,
  );
  journey.check('and submitted', (await submit('bad-disguised')).status === 200);
  const hostile = readFileSync(join(app, 'fixtures', 'markup-and-instructions.txt'));
  journey.check(
    'hostile markup uploads',
    (await upload('bad-hostile', hostile, 'text/plain')).status === 200,
  );
  journey.check('and submits', (await submit('bad-hostile')).status === 200);
  const bad = await settled(source, ['bad-disguised', 'bad-hostile']);
  const [disguisedRun] = await source.query(
    "SELECT error->>'code' AS code FROM workflow_runs WHERE idempotency_key = 'file_id:bad-disguised'",
  );
  journey.check(
    'the disguised executable fails its workflow at the parse and persists nothing',
    bad.get('bad-disguised') === 'terminal_failure' &&
      disguisedRun.code === 'file_text_contains_nul' &&
      (await call(`${base}/records/bad-disguised`, { token })).body.record === null,
    `${JSON.stringify([...bad])} ${disguisedRun.code}`,
  );
  const inert = await call(`${base}/records/bad-hostile`, { token });
  journey.check(
    'hostile markup is stored as data',
    bad.get('bad-hostile') === 'completed' &&
      inert.body.record?.title === '<script>alert(1)</script> & "quotes"',
    inert.text,
  );

  // The cancel route does not reach a document workflow run.
  const [wfRun] = await source.query(
    'SELECT workflow_run_id FROM workflow_runs WHERE idempotency_key = $1',
    [`file_id:${first.file_id}`],
  );
  const cancel = await call(`${base}/v1/runs/${wfRun.workflow_run_id}/cancel`, {
    method: 'POST',
    token,
  });
  journey.check('the run cancel route does not reach a workflow run', cancel.status === 404);
  journey.note('cancel a running document workflow', 'not offered by the runtime (404)');

  // ── Crashes before and after persistence, each recovered by a restart ─────────────────────────
  journey.step('a crash before persistence');
  const crashDoc = (id, title) =>
    Buffer.from(
      `Reference: REF-${id}\nTitle: ${title}\nQuantity: 4\nLine: crash test x 4\n`,
      'utf8',
    );
  ({ served, token } = await crash(ctx, journey, {
    environment: source,
    served,
    local: local1,
    extra,
    password,
    id: 'crash-before',
    bytes: crashDoc('8101', 'Crash before persistence'),
    when: 'before',
    upload,
    submit,
  }));
  journey.step('a crash after persistence');
  ({ served, token } = await crash(ctx, journey, {
    environment: source,
    served,
    local: local1,
    extra,
    password,
    id: 'crash-after',
    bytes: crashDoc('8102', 'Crash after persistence'),
    when: 'after',
    upload,
    submit,
  }));
  await served.stop();

  // ── An additive update, then a refused destructive one ────────────────────────────────────────
  journey.step('updating to 1.1.0 and refusing 2.0.0');
  const before = await recordsState(source);
  const column = '      - { name: status, type: text, nullable: true }\n';
  journey.check('the 1.0.0 spec has the anchor the updates edit', specV1.includes(column));
  const spec2 = tree(
    '1.1.0',
    specV1
      .replace(column, `${column}      - { name: reviewer_note, type: text, nullable: true }\n`)
      .replace('version: "1.0.0"', 'version: "1.1.0"'),
  );
  const bundle2 = join(source.dir, 'document-intake-1.1.0.ray');
  const packed2 = rayspec(ctx, ['pack', '--spec', spec2, '--output', bundle2, '--against', spec1], {
    env: packEnv,
  });
  journey.check(
    'pack 1.1.0 against 1.0.0',
    packed2.status === 0,
    JSON.stringify(packed2.envelope.errors),
  );
  ({ plan, served } = await deployServing(ctx, journey, source, bundle2, {
    env: source.env(extra),
  }));
  journey.check(
    'the 1.1.0 plan is additive',
    plan.plan.schemaImpact.destructive === false &&
      plan.plan.schemaImpact.productDeltaSha256 !== null,
  );
  journey.check(
    'every record survives the update',
    (await recordsState(source)).digest === before.digest,
  );
  token = (await login(source.base, password)).token;
  await served.stop();
  const sizeColumn = '      - { name: size_bytes, type: integer, nullable: true }\n';
  const spec3 = tree(
    '2.0.0',
    specV1
      .replace(column, `${column}      - { name: reviewer_note, type: text, nullable: true }\n`)
      .replace(sizeColumn, '')
      .replace('          size_bytes: { event: size_bytes }\n', '')
      .replace('version: "1.0.0"', 'version: "2.0.0"'),
  );
  const refusedPack = rayspec(
    ctx,
    [
      'pack',
      '--spec',
      spec3,
      '--output',
      join(ctx.work, 'document-intake-2.0.0-against.ray'),
      '--against',
      spec2,
    ],
    { env: packEnv },
  );
  journey.check(
    'pack refuses 2.0.0 against 1.1.0',
    refusedPack.status === 2 && JSON.stringify(refusedPack.envelope.errors).includes('size_bytes'),
    JSON.stringify(refusedPack.envelope.errors),
  );
  const bundle3 = join(source.dir, 'document-intake-2.0.0.ray');
  journey.check(
    'pack 2.0.0 on its own',
    rayspec(ctx, ['pack', '--spec', spec3, '--output', bundle3], { env: packEnv }).status === 0,
  );
  const dry3 = rayspec(ctx, ['deploy', bundle3, '--dry-run', '--state-dir', source.stateDir], {
    env: source.env(extra),
    cwd: source.dir,
  });
  const refused = rayspec(
    ctx,
    [
      'deploy',
      bundle3,
      '--plan-digest',
      dry3.envelope.data?.planDigest ?? '',
      '--state-dir',
      source.stateDir,
    ],
    { env: source.env(extra), cwd: source.dir },
  );
  journey.check(
    'the deploy refuses 2.0.0',
    refused.status === 3 &&
      refused.envelope.errors[0].code === 'RAY_MIGRATION_REQUIRED' &&
      JSON.stringify(refused.envelope.errors).includes('intake_records.size_bytes'),
    JSON.stringify(refused.envelope.errors),
  );
  journey.check('no record changed', (await recordsState(source)).digest === before.digest);

  // ── Export → import → new write → export → import ─────────────────────────────────────────────
  journey.step('exporting the source');
  await ctx.tools();
  const { identity, recipient } = await ctx.ageKeyPair();
  const identityFile = privateFile(join(ctx.work, 'document-intake-identity.txt'), `${identity}\n`);
  const expected = await recordsState(source);
  const expectedBlobs = blobInventory(source.blobRoot);
  const migration = join(ctx.work, 'document-intake-source.migration.ray');
  const exported = exportDeployment(ctx, source, recipient, migration);
  journey.check(
    'the export of the source',
    exported.status === 0 && exported.envelope.data.sourceState === 'fenced',
    `${exported.status} ${JSON.stringify(exported.envelope.errors)} ${exported.stderr.slice(-1500)}`,
  );

  checkEncryptedExport(journey, 'the source export', migration, [
    ...manifest.documents.slice(0, 5).map((d) => d.expected.title),
    readFileSync(join(app, 'seed', first.file), 'utf8').split('\n')[1],
  ]);

  let previous = { environment: source, records: expected, blobs: expectedBlobs };
  const bundleRan = bundle2;
  for (const label of ['document-intake-target-a', 'document-intake-target-b']) {
    journey.step(`importing into ${label}`);
    const bundleIn = label.endsWith('a')
      ? migration
      : join(ctx.work, 'document-intake-target-a.migration.ray');
    const target = await new Environment(ctx, label, { workflowSystem: true }).create();
    const imported = importInto(ctx, journey, target, bundleIn, identityFile);
    journey.check(
      `${label}: verification matches`,
      Object.values(imported.data.verification).every((v) => v === 'match'),
      JSON.stringify(imported.data.verification),
    );
    journey.check(
      `${label}: every record is carried`,
      (await recordsState(target)).digest === previous.records.digest,
    );
    const blobs = blobInventory(target.blobRoot);
    journey.check(
      `${label}: every stored file is carried, at its key, with its bytes`,
      JSON.stringify(blobs) === JSON.stringify(previous.blobs),
      `${blobs.files} vs ${previous.blobs.files}`,
    );
    const local = join(target.dir, 'document-intake-1.1.0.ray');
    copyFileSync(bundleRan, local);
    ({ served } = await deployServing(ctx, journey, target, local, { env: target.env(extra) }));
    const signedIn = await login(target.base, password);
    journey.check(
      `${label}: the owner signs in with the password they had`,
      signedIn.status === 200,
    );
    const oldToken = await call(`${target.base}/records?limit=1`, { token });
    journey.check(
      `${label}: an access token of the earlier environment is refused`,
      oldToken.status === 401,
    );
    token = signedIn.token;
    base = target.base;
    await expectRecords(journey, base, token, manifest, label);
    // Every record still refers to a stored file whose bytes hash to the record's sha256.
    const refs = await target.query('SELECT document_ref, sha256 FROM intake_records');
    journey.check(
      `${label}: every record's file is stored at the target`,
      refs.every((r) => blobs.digests.includes(r.sha256)),
    );
    // A new document, processed on the imported environment.
    const id = `new-on-${label.slice(-1)}`;
    const bytes = Buffer.from(
      `Reference: REF-9${label.endsWith('a') ? '201' : '202'}\nTitle: Written on ${label} — Grüße\nQuantity: 2\nLine: after the move x 2\n`,
      'utf8',
    );
    journey.check(`${label}: a new upload`, (await upload(id, bytes, 'text/plain')).status === 200);
    journey.check(`${label}: and submit`, (await submit(id)).status === 200);
    const done = await settled(target, [id]);
    journey.check(`${label}: the new document is processed`, done.get(id) === 'completed');
    const record = await call(`${base}/records/${id}`, { token });
    journey.check(
      `${label}: the new record reads back`,
      record.body.record?.title === `Written on ${label} — Grüße` &&
        record.body.sha256 === createHash('sha256').update(bytes).digest('hex'),
      record.text,
    );
    const now = {
      environment: target,
      records: await recordsState(target),
      blobs: blobInventory(target.blobRoot),
    };
    journey.check(`${label}: one record more`, now.records.count === previous.records.count + 1);
    if (label.endsWith('a')) {
      const exit = exportDeployment(
        ctx,
        target,
        recipient,
        join(ctx.work, 'document-intake-target-a.migration.ray'),
      );
      journey.check(
        `${label}: the exit export`,
        exit.status === 0,
        `${exit.status} ${JSON.stringify(exit.envelope.errors)} ${exit.stderr.slice(-1500)}`,
      );
    }
    await served.stop();
    journey.note(`${label} records`, now.records.count);
    journey.note(`${label} stored files`, now.blobs.files);
    previous = now;
  }
  journey.note('records digest', previous.records.digest);
}

/** Copy the application's source tree into `dir`. */
function copyTree(from, dir) {
  cpSync(from, dir, { recursive: true });
}

/**
 * Every object of the fs blob store under `root`: its key, the SHA-256 of the whole file, and the
 * SHA-256 of the bytes it holds. A stored object is a 4-byte big-endian header length, a JSON header
 * (`contentType`, `sha256`, …) and the bytes; the header's digest must be the bytes' digest.
 */
function blobInventory(root) {
  const entries = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const file = readFileSync(path);
      const length = file.readUInt32BE(0);
      const header = JSON.parse(file.subarray(4, 4 + length).toString('utf8'));
      const body = createHash('sha256')
        .update(file.subarray(4 + length))
        .digest('hex');
      if (header.sha256 !== body)
        throw new Error(`${relative(root, path)}: header and bytes disagree`);
      entries.push([relative(root, path), createHash('sha256').update(file).digest('hex'), body]);
    }
  };
  walk(root);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    files: entries.length,
    keys: entries.map((e) => e[0]),
    files256: entries.map((e) => e[1]),
    digests: entries.map((e) => e[2]),
  };
}

async function login(base, password) {
  const res = await call(`${base}/v1/auth/login`, {
    method: 'POST',
    body: { email: 'owner@example.test', password },
  });
  return { status: res.status, token: res.body.accessToken };
}

/** The workflow runs' statuses by file id, once none of `ids` is still running. */
async function settled(environment, ids) {
  const keys = ids.map((id) => `file_id:${id}`);
  const deadline = Date.now() + 180_000;
  for (;;) {
    const rows = await environment.query(
      'SELECT idempotency_key, status FROM workflow_runs WHERE idempotency_key = ANY($1)',
      [keys],
    );
    const done = rows.filter((r) => r.status === 'completed' || r.status === 'terminal_failure');
    if (rows.length === keys.length && done.length === keys.length) {
      return new Map(rows.map((r) => [r.idempotency_key.slice('file_id:'.length), r.status]));
    }
    if (Date.now() > deadline)
      throw new Error(`workflow runs did not settle: ${JSON.stringify(rows)}`);
    await pause(250);
  }
}

/** Every seed record, read through the deployment, equal to the manifest's. */
async function expectRecords(journey, base, token, manifest, where) {
  const served = [];
  for (const doc of manifest.documents) {
    const res = await call(`${base}/records/${doc.file_id}`, { token });
    const ok =
      res.status === 200 &&
      canonical(res.body) ===
        canonical({
          document_ref: doc.file_id,
          sha256: doc.sha256,
          content_type: doc.content_type,
          status: 'processed',
          record: doc.expected,
        });
    if (!ok) journey.check(`${where}: the record of ${doc.file_id}`, false, res.text);
    served.push(res.body.record);
  }
  const inventory = {
    documents: served.length,
    total_quantity: served.reduce((s, r) => s + r.quantity, 0),
    total_lines: served.reduce((s, r) => s + r.lines.length, 0),
    without_category: served.filter((r) => r.category === null).length,
    without_received_on: served.filter((r) => r.received_on === null).length,
  };
  const want = {
    documents: manifest.inventory.documents,
    total_quantity: manifest.inventory.total_quantity,
    total_lines: manifest.inventory.total_lines,
    without_category: manifest.inventory.without_category,
    without_received_on: manifest.inventory.without_received_on,
  };
  journey.check(
    `${where}: the 50 seed records and their inventory equal the manifest`,
    JSON.stringify(inventory) === JSON.stringify(want),
    JSON.stringify(inventory),
  );
}

async function recordsState(environment) {
  const rows = await environment.query(
    'SELECT id, tenant_id, document_ref, sha256, size_bytes, content_type, record::text AS record, status FROM intake_records',
  );
  return {
    count: rows.length,
    digest: rowsDigest(rows, [
      'id',
      'tenant_id',
      'document_ref',
      'sha256',
      'size_bytes',
      'content_type',
      'record',
      'status',
    ]),
  };
}

/**
 * A crash of the serving process while a document's workflow is held at one point, then a restart.
 *
 * `before`: the record table is locked, so the persist step waits on it; the process is killed
 * there. `after`: the persist step is let through while the run's header row is held, so the record
 * is written and the run cannot be closed; the process is killed there. In both cases the sessions
 * the killed process left are ended before the lock is released, so nothing the killed process
 * started can finish behind its back. The restart recovers the run, which ends with exactly one
 * record and the persist step executed once.
 */
async function crash(
  ctx,
  journey,
  { environment, served, local, extra, password, id, bytes, when, upload, submit },
) {
  const db = withDbName(ctx.adminUrl, environment.db);
  const tableLock = postgres(db, { max: 1, onnotice: () => {} });
  const rowLock = postgres(db, { max: 1, onnotice: () => {} });
  const key = `file_id:${id}`;
  try {
    await tableLock.unsafe('BEGIN');
    await tableLock.unsafe('LOCK TABLE intake_records IN ACCESS EXCLUSIVE MODE');
    journey.check(`${id}: upload`, (await upload(id, bytes, 'text/plain')).status === 200);
    journey.check(`${id}: submit`, (await submit(id)).status === 200);
    await waitFor(`${id}: the persist step waits on the record table`, async () => {
      const [row] = await environment.query(
        `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
          WHERE c.relname = 'intake_records' AND NOT l.granted`,
      );
      return row.n > 0;
    });
    if (when === 'after') {
      await rowLock.unsafe('BEGIN');
      const held = await rowLock.unsafe(
        'SELECT workflow_run_id FROM workflow_runs WHERE idempotency_key = $1 FOR NO KEY UPDATE',
        [key],
      );
      journey.check(`${id}: the run header is held`, held.length === 1);
      await tableLock.unsafe('ROLLBACK');
      await waitFor(`${id}: the record is persisted`, async () => {
        const [row] = await environment.query(
          `SELECT (SELECT count(*)::int FROM intake_records WHERE document_ref = $1) AS records,
                  (SELECT count(*)::int FROM workflow_node_states n JOIN workflow_runs r USING (workflow_run_id)
                    WHERE r.idempotency_key = $2 AND n.node_id = 'persist' AND n.status = 'completed') AS persisted`,
          [id, key],
        );
        return row.records === 1 && row.persisted === 1;
      });
    }
    await served.kill();
    await environment.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND usename = ANY($2) AND pid <> pg_backend_pid()`,
      [environment.db, [environment.roles.runtime, environment.roles.migration]],
    );
  } finally {
    await tableLock.unsafe('ROLLBACK').catch(() => {});
    await rowLock.unsafe('ROLLBACK').catch(() => {});
    await tableLock.end();
    await rowLock.end();
  }
  const [interrupted] = await environment.query(
    `SELECT r.status, (SELECT count(*)::int FROM intake_records WHERE document_ref = $1) AS records
       FROM workflow_runs r WHERE r.idempotency_key = $2`,
    [id, key],
  );
  journey.check(
    `${id}: the crash left the run open with ${when === 'before' ? 'no record' : 'its record'}`,
    interrupted.status === 'running' && interrupted.records === (when === 'before' ? 0 : 1),
    JSON.stringify(interrupted),
  );
  const restarted = await deployServing(ctx, journey, environment, local, {
    env: environment.env(extra),
    label: `${environment.label}-${id}`,
  });
  const done = await settled(environment, [id]);
  journey.check(`${id}: the restart completes the run`, done.get(id) === 'completed');
  const [after] = await environment.query(
    `SELECT (SELECT count(*)::int FROM intake_records WHERE document_ref = $1) AS records,
            (SELECT attempt_count::int FROM workflow_node_states n JOIN workflow_runs r USING (workflow_run_id)
              WHERE r.idempotency_key = $2 AND n.node_id = 'persist') AS attempts`,
    [id, key],
  );
  journey.check(`${id}: exactly one record`, after.records === 1, JSON.stringify(after));
  journey.note(`${id}: persist attempts`, after.attempts);
  if (when === 'after') {
    journey.check(
      `${id}: the persisted step is not executed again`,
      after.attempts === 1,
      String(after.attempts),
    );
  }
  const signedIn = await login(environment.base, password);
  const record = await call(`${environment.base}/records/${id}`, { token: signedIn.token });
  journey.check(
    `${id}: the record reads back`,
    record.body.status === 'processed' && record.body.record?.quantity === 4,
    record.text,
  );
  return { served: restarted.served, token: signedIn.token };
}

async function waitFor(what, probe, ms = 60_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await pause(100);
  }
}
