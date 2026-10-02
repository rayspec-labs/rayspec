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
 *   create answers 502 and writes nothing → the export refuses the application, which loads an
 *   extension, and leaves it unfenced.
 *
 * The runtime does not enforce egress; the host network policy does (docs/hardened-posture.md
 * "Egress"). The proxy here plays that policy.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  call,
  deployServing,
  Environment,
  exportDeployment,
  newPassword,
  rayspec,
  register,
  rowsDigest,
  signIn,
  startClassifier,
  startEgressProxy,
  testCertificates,
} from './lib.mjs';

const HOST = 'classifier.example.com';

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
    const deploy = async (version) => {
      const local = join(source.dir, `asset-catalog-${version}.ray`);
      copyFileSync(bundles[version], local);
      // The host network policy is programmed from the bundle about to run.
      policy = inspect(local).egressHosts;
      return deployServing(ctx, journey, source, local, { env: source.env(extra) });
    };
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

    // ── Export: an application that loads an extension is refused ───────────────────────────────
    journey.step('exporting');
    await ctx.tools();
    const { recipient } = await ctx.ageKeyPair();
    const output = join(ctx.work, 'asset-catalog.migration.ray');
    const exported = exportDeployment(ctx, source, recipient, output);
    journey.check(
      'the export refuses an application that loads an extension',
      exported.status === 3 &&
        exported.envelope.errors?.[0]?.code === 'RAY_EXTERNAL_STATE_UNSUPPORTED' &&
        exported.envelope.errors[0].reason === 'unsupported-blob-adapter',
      `${exported.status} ${JSON.stringify(exported.envelope.errors)}`,
    );
    journey.check('nothing is written', !existsSync(output));
    const fence = await source.fence();
    journey.check(
      'the source is not fenced',
      fence === null || fence.state !== 'fenced',
      JSON.stringify(fence),
    );
    journey.note('export', 'refused: RAY_EXTERNAL_STATE_UNSUPPORTED (unsupported-blob-adapter)');
    journey.note('rows', (await rowsOf()).length);
  } finally {
    await classifier.close();
    await proxy.close();
  }
}
