/**
 * The asset-catalog journey: custom code — a compiled TypeScript extension with a vendored npm
 * dependency and one declared HTTPS destination — driven only through the installed release.
 *
 *   build (compile the extension, vendor mime-types and mime-db) → pack → inspect (in-process
 *   execution, the declared host), verify → the native-addon fixture refused by pack → deploy from
 *   a directory holding only the bundle, behind an egress proxy programmed from the bundle's
 *   declared hosts, with npm offline → creates classified through the declared host; the static
 *   page → the dependency resolves from the bundle's own tree, and nothing above it holds a copy →
 *   1.1.0 (adds a column) keeps every row → 2.0.0 (drops one) refused at pack and at deploy → 1.1.1
 *   declares no host: the proxy, reprogrammed from it, refuses the call the deployment makes, the
 *   create answers 502 and writes nothing → 1.1.2 declares it again, and the boot records that no
 *   extension provides a blob backend → an encrypted export of the serving source while creates
 *   keep arriving through the extension's handler (each one carried, or refused by the fence with
 *   503), an import into
 *   an empty target that serves the extension and its dependency from the bundle, the same rows and
 *   a reset identity, a new write there, an exit export of that target and an import into a second
 *   empty one that carries the new write.
 *
 * A separate case adds a second extension that provides its own blob backend: the boot records it,
 * and the export refuses the application, naming that extension, and leaves it unfenced.
 *
 * The runtime does not enforce egress; the host network policy does (docs/hardened-posture.md
 * "Egress"). The proxy here plays that policy.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  call,
  checkEncryptedExport,
  deployServing,
  Environment,
  exportDeployment,
  exportDeploymentAsync,
  importInto,
  newPassword,
  privateFile,
  rayspec,
  register,
  rowsDigest,
  signIn,
  startClassifier,
  startEgressProxy,
  tableText,
  testCertificates,
} from './lib.mjs';

const HOST = 'classifier.example.com';
/** At most this many creates are sent while the source export runs, one every 100 ms. */
const DURING_EXPORT_WRITES = 40;

export async function assetCatalog(ctx, journey) {
  const app = join(ctx.repo, 'examples', 'asset-catalog');
  const packEnv = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    SHADOW_DATABASE_URL: ctx.shadowUrl,
  };

  // ── Build → pack → inspect → verify ───────────────────────────────────────────────────────────
  journey.step('building and packing');
  const builds = join(ctx.work, 'asset-catalog-build');
  const v1 = join(builds, '1.0.0');
  const build = spawnSync(process.execPath, [join(app, 'build.mjs'), `--out=${v1}`], {
    cwd: ctx.work,
    encoding: 'utf8',
  });
  journey.check(
    'build compiles the extension and vendors its dependency',
    build.status === 0,
    build.stderr,
  );
  journey.check(
    'the build vendors mime-types and mime-db',
    existsSync(join(v1, 'packs', 'catalog-pack', 'node_modules', 'mime-types', 'package.json')) &&
      existsSync(join(v1, 'packs', 'catalog-pack', 'node_modules', 'mime-db', 'package.json')),
  );
  const specV1 = readFileSync(join(v1, 'rayspec.yaml'), 'utf8');
  const column = '      - { name: category, type: text }\n';
  const egress = '  egressHosts: [classifier.example.com]\n';
  const versionLine = "  version: '1.0.0'\n";
  journey.check(
    'the built spec has the anchors the releases edit',
    specV1.includes(column) && specV1.includes(egress) && specV1.includes(versionLine),
  );
  const release = (version, edit) => {
    const dir = join(builds, version);
    if (dir !== v1) cpSync(v1, dir, { recursive: true });
    writeFileSync(
      join(dir, 'rayspec.yaml'),
      edit(specV1).split(versionLine).join(`  version: '${version}'\n`),
    );
    return join(dir, 'rayspec.yaml');
  };
  const withNotes = (spec) =>
    spec.split(column).join(`${column}      - { name: notes, type: text, nullable: true }\n`);
  const specs = {
    '1.0.0': join(v1, 'rayspec.yaml'),
    '1.1.0': release('1.1.0', withNotes),
    '1.1.1': release('1.1.1', (spec) =>
      withNotes(spec).split(egress).join('').split('\ndeployment:\n').join('\n'),
    ),
    '2.0.0': release('2.0.0', (spec) => withNotes(spec).split(column).join('')),
    '1.1.2': release('1.1.2', withNotes),
  };
  const bundles = {};
  const pack = (version, against) => {
    const output = join(ctx.work, `asset-catalog-${version}${against ? '' : '-alone'}.ray`);
    const args = ['pack', '--spec', specs[version], '--output', output];
    if (against !== undefined) args.push('--against', specs[against]);
    const run = rayspec(ctx, args, { env: packEnv });
    if (run.status === 0) bundles[version] = output;
    return run;
  };
  const packed1 = pack('1.0.0');
  journey.check('pack 1.0.0', packed1.status === 0, JSON.stringify(packed1.envelope.errors));
  const inspect = (bundle) => rayspec(ctx, ['bundle', 'inspect', bundle]).envelope.data;
  const inspected = inspect(bundles['1.0.0']);
  journey.check(
    'inspect reports in-process execution and the one declared host',
    inspected.execution === 'in-process' &&
      JSON.stringify(inspected.egressHosts) === JSON.stringify([HOST]),
    JSON.stringify(inspected),
  );
  journey.check('bundle verify', rayspec(ctx, ['bundle', 'verify', bundles['1.0.0']]).status === 0);

  // The native-addon fixture: refused by pack, naming the file.
  const native = join(ctx.work, 'asset-catalog-native');
  const made = spawnSync(
    process.execPath,
    [join(app, 'native-fixture', 'make-tree.mjs'), `--out=${native}`],
    { cwd: ctx.work, encoding: 'utf8' },
  );
  journey.check('the native fixture tree is written', made.status === 0, made.stderr);
  const nativeRun = rayspec(
    ctx,
    ['pack', '--spec', join(native, 'rayspec.yaml'), '--output', join(native, 'native.ray')],
    { env: packEnv },
  );
  journey.check(
    'pack refuses a native addon built for macOS',
    nativeRun.status !== 0 &&
      nativeRun.envelope.errors?.[0]?.code === 'RAY_CLOSURE_INVALID' &&
      JSON.stringify(nativeRun.envelope.errors).includes('native-module') &&
      !existsSync(join(native, 'native.ray')),
    JSON.stringify(nativeRun.envelope.errors),
  );

  // ── The deployment, behind the egress policy ──────────────────────────────────────────────────
  journey.step('deploying 1.0.0 behind the egress proxy');
  const certs = testCertificates(join(ctx.work, 'asset-catalog-tls'), HOST);
  const classifier = await startClassifier(certs);
  let policy = [];
  const proxy = await startEgressProxy(classifier.port, () => policy);
  try {
    const source = await new Environment(ctx, 'asset-catalog-source').create();
    source.mintSecrets();
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    const extra = {
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
      NO_PROXY: '127.0.0.1,localhost',
      NODE_EXTRA_CA_CERTS: certs.caFile,
      npm_config_offline: 'true',
    };
    const deployOn = async (environment, version) => {
      const local = join(environment.dir, `asset-catalog-${version}.ray`);
      copyFileSync(bundles[version], local);
      // The host network policy is programmed from the bundle about to run.
      policy = inspect(local).egressHosts;
      return deployServing(ctx, journey, environment, local, { env: environment.env(extra) });
    };
    const deploy = (version) => deployOn(source, version);
    let { plan, served } = await deploy('1.0.0');
    journey.check(
      'the plan reports the declared host as an added permission',
      JSON.stringify(plan.plan.permissionChanges.egressAdded) === JSON.stringify([HOST]),
    );
    const base = source.base;
    journey.check(
      'the static page is served',
      (await call(`${base}/`)).text.includes('<h1>Asset catalog</h1>'),
    );
    const password = newPassword('owner');
    const access = await register(base, 'owner@example.test', password);
    const org = await call(`${base}/v1/orgs`, {
      method: 'POST',
      token: access,
      body: { name: 'Catalog' },
    });
    journey.check('the owner creates the organization', org.status === 201);
    let { token } = await signIn(base, 'owner@example.test', password, org.body.id);
    const cases = [
      { name: 'Logo', file_name: 'logo.png', content_type: 'image/png', category: 'image' },
      {
        name: 'Handbook',
        file_name: 'handbook.pdf',
        content_type: 'application/pdf',
        category: 'document',
      },
      {
        name: 'Unknown',
        file_name: 'data.unknownext',
        content_type: 'application/octet-stream',
        category: 'document',
      },
    ];
    for (const c of cases) {
      const created = await call(`${base}/api/items`, {
        method: 'POST',
        token,
        body: { name: c.name, file_name: c.file_name },
      });
      journey.check(
        `create ${c.name}: content type from the vendored dependency, category from the declared host`,
        created.status === 201 &&
          created.body.content_type === c.content_type &&
          created.body.category === c.category,
        created.text,
      );
    }
    journey.check(
      'every outbound call went through the policy to the declared host only',
      proxy.tunnelled.length > 0 &&
        proxy.tunnelled.every((t) => t === `${HOST}:443`) &&
        proxy.denied.length === 0,
      JSON.stringify({ tunnelled: proxy.tunnelled, denied: proxy.denied }),
    );

    // Offline resolution: the dependency is in the bundle's version directory, and no directory
    // above it holds a copy the runtime could fall back to.
    const versionDir = join(
      source.stateDir,
      'versions',
      inspect(join(source.dir, 'asset-catalog-1.0.0.ray')).sha256,
    );
    const fromBundle = join(
      versionDir,
      'payload',
      'packs',
      'catalog-pack',
      'node_modules',
      'mime-types',
      'package.json',
    );
    journey.check(
      'the bundle carries mime-types into its version directory',
      existsSync(fromBundle),
      fromBundle,
    );
    const shadowing = [];
    for (
      let dir = dirname(join(versionDir, 'payload', 'packs', 'catalog-pack'));
      ;
      dir = dirname(dir)
    ) {
      if (existsSync(join(dir, 'node_modules', 'mime-types'))) shadowing.push(dir);
      if (dirname(dir) === dir) break;
    }
    journey.check(
      'no directory above the version directory holds mime-types',
      shadowing.length === 0 && !realpathSync(versionDir).startsWith(realpathSync(ctx.consumer)),
      JSON.stringify(shadowing),
    );
    journey.note(
      'dependency resolved from',
      'the bundle version directory (npm offline, no registry contact)',
    );
    const rowsOf = () =>
      source.query(
        'SELECT id, tenant_id, name, file_name, content_type, category FROM catalog_items',
      );
    const digestOf = async () =>
      rowsDigest(await rowsOf(), [
        'id',
        'tenant_id',
        'name',
        'file_name',
        'content_type',
        'category',
      ]);
    await served.stop();

    // ── An additive update, then a refused destructive one ──────────────────────────────────────
    journey.step('updating to 1.1.0 and refusing 2.0.0');
    const before = await digestOf();
    const packed2 = pack('1.1.0', '1.0.0');
    journey.check(
      'pack 1.1.0 against 1.0.0',
      packed2.status === 0,
      JSON.stringify(packed2.envelope.errors),
    );
    ({ plan, served } = await deploy('1.1.0'));
    journey.check('the 1.1.0 plan is additive', plan.plan.schemaImpact.destructive === false);
    journey.check('every row survives the update', (await digestOf()) === before);
    ({ token } = await signIn(base, 'owner@example.test', password, org.body.id));
    const added = await call(`${base}/api/items`, {
      method: 'POST',
      token,
      body: { name: 'Banner', file_name: 'banner.jpg' },
    });
    journey.check(
      'a create after the update',
      added.status === 201 && added.body.category === 'image',
    );
    await served.stop();
    const kept = await digestOf();
    const refusedPack = pack('2.0.0', '1.1.0');
    journey.check(
      'pack refuses 2.0.0 against 1.1.0',
      refusedPack.status === 2 && JSON.stringify(refusedPack.envelope.errors).includes('category'),
      JSON.stringify(refusedPack.envelope.errors),
    );
    journey.check('pack 2.0.0 on its own', pack('2.0.0').status === 0);
    const local3 = join(source.dir, 'asset-catalog-2.0.0.ray');
    copyFileSync(bundles['2.0.0'], local3);
    const dry3 = rayspec(ctx, ['deploy', local3, '--dry-run', '--state-dir', source.stateDir], {
      env: source.env(extra),
      cwd: source.dir,
    });
    const refused = rayspec(
      ctx,
      [
        'deploy',
        local3,
        '--plan-digest',
        dry3.envelope.data?.planDigest ?? '',
        '--state-dir',
        source.stateDir,
      ],
      { env: source.env(extra), cwd: source.dir },
    );
    journey.check(
      'the deploy refuses 2.0.0 naming the dropped column',
      refused.status === 3 &&
        refused.envelope.errors[0].code === 'RAY_MIGRATION_REQUIRED' &&
        JSON.stringify(refused.envelope.errors).includes('catalog_items.category'),
      JSON.stringify(refused.envelope.errors),
    );
    journey.check('no row changed', (await digestOf()) === kept);

    // ── An undeclared destination: the bundle that runs declares no host ────────────────────────
    journey.step('refusing an undeclared destination');
    const packed11 = pack('1.1.1', '1.1.0');
    journey.check(
      'pack 1.1.1 (no declared host)',
      packed11.status === 0,
      JSON.stringify(packed11.envelope.errors),
    );
    ({ plan, served } = await deploy('1.1.1'));
    journey.check(
      'the plan reports the host as a removed permission',
      JSON.stringify(plan.plan.permissionChanges.egressRemoved) === JSON.stringify([HOST]) &&
        policy.length === 0,
    );
    ({ token } = await signIn(base, 'owner@example.test', password, org.body.id));
    const callsBefore = classifier.requests.length;
    const deniedBefore = proxy.denied.length;
    const blocked = await call(`${base}/api/items`, {
      method: 'POST',
      token,
      body: { name: 'Blocked', file_name: 'blocked.png' },
    });
    journey.check(
      'the call to the undeclared destination is refused by the policy; the create writes nothing',
      blocked.status === 502 &&
        blocked.body.error === 'classification_unavailable' &&
        proxy.denied.slice(deniedBefore).includes(`${HOST}:443`) &&
        classifier.requests.length === callsBefore,
      `${blocked.status} ${JSON.stringify(proxy.denied)}`,
    );
    journey.check('the rows written before are kept', (await digestOf()) === kept);
    await served.stop();

    // ── The declared host again; the boot records the blob backend ──────────────────────────────
    journey.step('declaring the host again');
    const packed12 = pack('1.1.2', '1.1.1');
    journey.check(
      'pack 1.1.2 against 1.1.1 (the host declared again)',
      packed12.status === 0,
      JSON.stringify(packed12.envelope.errors),
    );
    ({ plan, served } = await deploy('1.1.2'));
    journey.check(
      'the plan reports the host as an added permission again',
      JSON.stringify(plan.plan.permissionChanges.egressAdded) === JSON.stringify([HOST]),
    );
    ({ token } = await signIn(base, 'owner@example.test', password, org.body.id));
    const poster = await call(`${base}/api/items`, {
      method: 'POST',
      token,
      body: { name: 'Poster', file_name: 'poster.webp' },
    });
    journey.check(
      'a create through the declared host again',
      poster.status === 201 && poster.body.content_type === 'image/webp',
      poster.text,
    );
    const [recorded] = await source.query(
      'SELECT blob_backend FROM runtime_control_state WHERE id = 1',
    );
    journey.check(
      'the boot recorded that no extension provides a blob backend',
      JSON.stringify(recorded?.blob_backend) === JSON.stringify({ kind: 'none' }),
      JSON.stringify(recorded),
    );
    const minted = await call(`${base}/v1/orgs/${org.body.id}/api-keys`, {
      method: 'POST',
      token,
      body: { name: 'reader', scopes: ['store:read'] },
    });
    journey.check('the owner mints an API key on the source', minted.status === 201, minted.text);
    const apiKey = minted.body.plaintext;
    journey.check(
      'the API key reads the catalog on the source',
      (await call(`${base}/api/items?limit=1`, { token: apiKey })).status === 200,
    );
    const sourceToken = token;

    // ── A frozen encrypted export while the source serves ───────────────────────────────────────
    journey.step('exporting the source');
    await ctx.tools();
    const { identity, recipient } = await ctx.ageKeyPair();
    const identityFile = privateFile(join(ctx.work, 'asset-catalog-identity.txt'), `${identity}\n`);
    const migration = join(ctx.work, 'asset-catalog-source.migration.ray');
    // Creates through the extension's handler keep arriving while the export runs: each one is
    // either taken before the fence and carried, or refused by the fence with 503.
    let exporting = true;
    const exportRun = exportDeploymentAsync(ctx, source, recipient, migration).finally(() => {
      exporting = false;
    });
    const during = [];
    for (let n = 0; exporting && n < DURING_EXPORT_WRITES; n += 1) {
      const name = `Written during the export ${n}`;
      const res = await call(`${base}/api/items`, {
        method: 'POST',
        token,
        body: { name, file_name: `during-${n}.png` },
      });
      during.push({ name, status: res.status });
      await new Promise((r) => setTimeout(r, 100));
    }
    const exported = await exportRun;
    journey.check(
      'the export of the application with its extension writes one encrypted bundle',
      exported.status === 0 && exported.envelope.data.sourceState === 'fenced',
      `${exported.status} ${JSON.stringify(exported.envelope.errors)} ${exported.stderr.slice(-1500)}`,
    );
    const taken = during.filter((w) => w.status === 201).map((w) => w.name);
    const fencedOut = during.filter((w) => w.status === 503).map((w) => w.name);
    journey.check(
      'every write sent during the export was taken, or refused by the fence with 503',
      taken.length + fencedOut.length === during.length,
      JSON.stringify(during.filter((w) => w.status !== 201 && w.status !== 503)),
    );
    journey.check(
      'writes reached the source both before and after the fence',
      taken.length > 0 && fencedOut.length > 0,
      `taken ${taken.length}, refused ${fencedOut.length}`,
    );
    journey.check(
      'no write was taken after the fence refused one',
      during.findIndex((w) => w.status === 503) === taken.length,
      JSON.stringify(during.map((w) => w.status)),
    );
    const expected = await digestOf();
    const sourceRows = await rowsOf();
    const expectedRows = sourceRows.length;
    const sourceNames = new Set(sourceRows.map((r) => r.name));
    journey.check(
      'the fenced source holds every write it took and none it refused',
      taken.every((n) => sourceNames.has(n)) && !fencedOut.some((n) => sourceNames.has(n)),
    );
    checkEncryptedExport(journey, 'the source export', migration, [
      'handbook.pdf',
      'data.unknownext',
      'owner@example.test',
    ]);
    const fencedWrite = await call(`${base}/api/items`, {
      method: 'POST',
      token,
      body: { name: 'Fenced', file_name: 'fenced.png' },
    });
    journey.check(
      'a write to the fenced source answers 503',
      fencedWrite.status === 503,
      fencedWrite.text,
    );
    journey.check('the fenced source is unchanged', (await digestOf()) === expected);
    await served.stop();

    // ── Import into an empty target, cutover, deploy with the target's own secrets ──────────────
    journey.step('importing into the first target');
    const targetA = await new Environment(ctx, 'asset-catalog-target-a').create();
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
      'the first import carries the application the source ran',
      importedA.data.applicationDigest === inspect(bundles['1.1.2']).sha256,
    );
    journey.check(
      'every catalog row is carried byte for byte',
      JSON.stringify(await tableText(ctx.adminUrl, targetA.db, 'catalog_items')) ===
        JSON.stringify(await tableText(ctx.adminUrl, source.db, 'catalog_items')),
    );
    const namesA = new Set(
      (await targetA.query('SELECT name FROM catalog_items')).map((r) => r.name),
    );
    journey.check(
      'the first target holds every write the source took during the export, and none it refused',
      namesA.size === expectedRows &&
        taken.every((n) => namesA.has(n)) &&
        !fencedOut.some((n) => namesA.has(n)),
      `${namesA.size} of ${expectedRows}`,
    );
    for (const table of ['sessions', 'api_keys', 'invites']) {
      const [row] = await targetA.query(`SELECT count(*)::int AS n FROM ${table}`);
      journey.check(`the first target carries no ${table}`, row.n === 0);
    }
    ({ served } = await deployOn(targetA, '1.1.2'));
    await carried(journey, targetA, bundles['1.1.2'], inspect);
    await identityReset(journey, targetA.base, {
      orgId: org.body.id,
      password,
      oldTokens: [sourceToken],
      oldKeys: [apiKey],
    });
    const onA = await signIn(targetA.base, 'owner@example.test', password, org.body.id);
    const listedA = await call(`${targetA.base}/api/items?limit=100`, { token: onA.token });
    journey.check(
      'the first target serves every catalog item',
      listedA.status === 200 && listedA.body.items?.length === expectedRows,
      listedA.text.slice(0, 500),
    );
    const newWrite = await call(`${targetA.base}/api/items`, {
      method: 'POST',
      token: onA.token,
      body: { name: 'Written on the first target', file_name: 'target.svg' },
    });
    journey.check(
      'a new write on the first target, classified through the declared host',
      newWrite.status === 201 &&
        newWrite.body.content_type === 'image/svg+xml' &&
        newWrite.body.category === 'image',
      newWrite.text,
    );
    journey.check('the source stays fenced', (await source.fence())?.state === 'fenced');

    // ── Exit export of the first target, import into a second empty target ──────────────────────
    journey.step('exporting the first target and importing into the second');
    const rowsA = await tableText(ctx.adminUrl, targetA.db, 'catalog_items');
    journey.check('the new write is in the first target', rowsA.length === expectedRows + 1);
    const exitBundle = join(ctx.work, 'asset-catalog-target-a.migration.ray');
    const exitExport = exportDeployment(ctx, targetA, recipient, exitBundle);
    journey.check(
      'the exit export of the first target',
      exitExport.status === 0 && exitExport.envelope.data.sourceState === 'fenced',
      `${exitExport.status} ${JSON.stringify(exitExport.envelope.errors)} ${exitExport.stderr.slice(-1500)}`,
    );
    checkEncryptedExport(journey, 'the exit export', exitBundle, [
      'Written on the first target',
      'target.svg',
    ]);
    await served.stop();
    const targetB = await new Environment(ctx, 'asset-catalog-target-b').create();
    importInto(ctx, journey, targetB, exitBundle, identityFile);
    journey.check(
      'the second target holds the first target rows, the new write included',
      JSON.stringify(await tableText(ctx.adminUrl, targetB.db, 'catalog_items')) ===
        JSON.stringify(rowsA),
    );
    ({ served } = await deployOn(targetB, '1.1.2'));
    await carried(journey, targetB, bundles['1.1.2'], inspect);
    await identityReset(journey, targetB.base, {
      orgId: org.body.id,
      password,
      oldTokens: [sourceToken, onA.token],
      oldKeys: [apiKey],
    });
    const onB = await signIn(targetB.base, 'owner@example.test', password, org.body.id);
    const listedB = await call(`${targetB.base}/api/items?limit=100`, { token: onB.token });
    journey.check(
      'the second target serves every item, the new write included',
      listedB.status === 200 &&
        listedB.body.items?.length === expectedRows + 1 &&
        listedB.body.items.some(
          (i) => i.name === 'Written on the first target' && i.content_type === 'image/svg+xml',
        ),
      listedB.text.slice(0, 500),
    );
    const onTargetB = await call(`${targetB.base}/api/items`, {
      method: 'POST',
      token: onB.token,
      body: { name: 'Written on the second target', file_name: 'second.pdf' },
    });
    journey.check(
      'the second target writes through the declared host',
      onTargetB.status === 201 && onTargetB.body.category === 'document',
      onTargetB.text,
    );
    await served.stop();
    journey.note('rows', { source: expectedRows, targets: expectedRows + 1 });
    journey.note('export', 'exported and imported twice; the boot recorded no blob backend');

    // ── An extension that keeps the blobs itself: the export refuses it ─────────────────────────
    journey.step('refusing an extension that provides its own blob backend');
    await blobBackendRefusal(ctx, journey, { v1, packEnv, recipient, extra });
  } finally {
    await classifier.close();
    await proxy.close();
  }
}

/**
 * What the bundle carries arrives with it: the target serves the static page, and its version
 * directory holds the compiled extension and its vendored dependency.
 */
async function carried(journey, target, bundle, inspect) {
  journey.check(
    `${target.label}: the static page is served`,
    (await call(`${target.base}/`)).text.includes('<h1>Asset catalog</h1>'),
  );
  const pack = join(
    target.stateDir,
    'versions',
    inspect(bundle).sha256,
    'payload',
    'packs',
    'catalog-pack',
  );
  journey.check(
    `${target.label}: the version directory holds the extension and its dependency`,
    existsSync(join(pack, 'index.js')) &&
      existsSync(join(pack, 'node_modules', 'mime-types', 'package.json')) &&
      existsSync(join(pack, 'node_modules', 'mime-db', 'package.json')),
    pack,
  );
}

/** The owner signs in with the password they had; tokens and keys of earlier environments are refused. */
async function identityReset(journey, base, { orgId, password, oldTokens, oldKeys }) {
  const signed = await signIn(base, 'owner@example.test', password, orgId);
  journey.check('the owner signs in with the password they had', signed.status === 200);
  for (const [i, token] of oldTokens.entries()) {
    const res = await call(`${base}/api/items?limit=1`, { token });
    journey.check(
      `an access token of an earlier environment is refused (${i + 1})`,
      res.status === 401,
      String(res.status),
    );
  }
  for (const key of oldKeys) {
    const res = await call(`${base}/api/items?limit=1`, { token: key });
    journey.check('an API key of the source is refused', res.status === 401, String(res.status));
  }
}

/**
 * The application with a second extension that provides its own blob backend and an upload route:
 * the boot records that extension as the blob backend, and the export refuses the application,
 * naming it, before it fences anything.
 */
async function blobBackendRefusal(ctx, journey, { v1, packEnv, recipient, extra }) {
  const dir = join(dirname(v1), 'blob-backend');
  cpSync(v1, dir, { recursive: true });
  const vault = join(dir, 'packs', 'vault-pack');
  mkdirSync(join(vault, 'handlers'), { recursive: true });
  writeFileSync(
    join(vault, 'package.json'),
    JSON.stringify({
      name: 'vault-pack',
      version: '1.0.0',
      private: true,
      type: 'module',
      main: './index.js',
      dependencies: { '@rayspec/platform': `^${ctx.version}` },
    }),
  );
  writeFileSync(join(vault, 'index.js'), VAULT_EXTENSION);
  writeFileSync(join(vault, 'handlers', 'ingest.js'), VAULT_INGEST);
  const specPath = join(dir, 'rayspec.yaml');
  const anchor = '    module: ./packs/catalog-pack\n    version: 1.0.0\n';
  const spec = readFileSync(specPath, 'utf8');
  journey.check('the built spec names the catalog extension once', spec.split(anchor).length === 2);
  writeFileSync(
    specPath,
    spec
      .split(anchor)
      .join(`${anchor}  - id: vault_pack\n    module: ./packs/vault-pack\n    version: 1.0.0\n`),
  );
  const output = join(ctx.work, 'asset-catalog-blob-backend.ray');
  const packed = rayspec(ctx, ['pack', '--spec', specPath, '--output', output], { env: packEnv });
  journey.check(
    'pack the application with an extension that provides a blob backend',
    packed.status === 0,
    JSON.stringify(packed.envelope.errors),
  );
  const env = await new Environment(ctx, 'asset-catalog-blob-backend').create();
  env.mintSecrets();
  const local = join(env.dir, 'asset-catalog-blob-backend.ray');
  copyFileSync(output, local);
  const { served } = await deployServing(ctx, journey, env, local, { env: env.env(extra) });
  await served.stop();
  const [recorded] = await env.query('SELECT blob_backend FROM runtime_control_state WHERE id = 1');
  journey.check(
    'the boot recorded the extension that provides the blob backend',
    JSON.stringify(recorded?.blob_backend) ===
      JSON.stringify({ kind: 'extension', extension: 'vault_pack' }),
    JSON.stringify(recorded),
  );
  const refusedOutput = join(env.dir, 'refused.migration.ray');
  const run = exportDeployment(ctx, env, recipient, refusedOutput);
  const error = run.envelope.errors?.[0];
  journey.check(
    'the export refuses it, naming the extension',
    run.status === 3 &&
      error?.code === 'RAY_EXTERNAL_STATE_UNSUPPORTED' &&
      error.reason === 'unsupported-blob-adapter' &&
      error.message.includes("the extension 'vault_pack' provides the blob backend"),
    `${run.status} ${JSON.stringify(run.envelope.errors)}`,
  );
  journey.check('nothing is written', !existsSync(refusedOutput));
  const fence = await env.fence();
  journey.check(
    'the refused source is not fenced',
    fence === null || fence.state !== 'fenced',
    JSON.stringify(fence),
  );
  journey.note('blob backend refusal', 'RAY_EXTERNAL_STATE_UNSUPPORTED (unsupported-blob-adapter)');
  await env.drop();
}

/** An extension that keeps uploads in a backend of its own (in memory) behind an upload route. */
const VAULT_EXTENSION = `import { defineExtension } from '@rayspec/platform';

const objects = new Map();
function vault(tenantId) {
  const at = (key) => tenantId + '/' + key;
  const missing = (key) => ({ notFound: true, key });
  return {
    async put(key, body) {
      objects.set(at(key), body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer()));
    },
    async get(key) {
      const b = objects.get(at(key));
      return b === undefined ? missing(key) : { body: new Response(b).body, contentLength: b.length };
    },
    async createReadStream(key) {
      const b = objects.get(at(key));
      return b === undefined ? missing(key) : new Response(b).body;
    },
    async stat(key) {
      const b = objects.get(at(key));
      return b === undefined ? missing(key) : { len: b.length, etagSource: String(b.length) };
    },
    async delete(key) {
      objects.delete(at(key));
    },
    async deleteTenant(id) {
      if (id !== tenantId) throw new Error('another tenant');
      for (const key of [...objects.keys()]) if (key.startsWith(tenantId + '/')) objects.delete(key);
    },
  };
}

export default defineExtension({
  version: '1.0.0',
  fragments: {
    handlers: [{ id: 'vault_ingest', module: 'handlers/ingest.js', export: 'ingest', kind: 'route', uses: ['blob'] }],
    api: [{ method: 'POST', path: '/api/uploads/{upload_id}', action: { kind: 'stream', handler: 'vault_ingest', mode: 'ingest' } }],
  },
  capabilities: { blobFactory: vault },
});
`;

const VAULT_INGEST = `export async function ingest(init) {
  const bytes = new Uint8Array(await init.request.arrayBuffer());
  await init.blob.put('uploads/' + init.params.upload_id, bytes);
  return new Response(JSON.stringify({ stored: bytes.length }), { status: 200, headers: { 'content-type': 'application/json' } });
}
`;
