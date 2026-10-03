#!/usr/bin/env node
/**
 * gen-image-sbom.mjs — the CycloneDX 1.5 SBOM of the npm packages inside a runtime image.
 *
 * WHY A SECOND SBOM. `docs/closure-sbom.cdx.json` describes the published closure as the workspace
 * lockfile resolves it. The runtime image installs the release tarballs with npm, and npm resolves
 * the third-party packages from the registry when the image's lockfile is written
 * (`deployments/runtime-image/Dockerfile`), so the image can hold other versions than the workspace
 * tests. This document lists what the image itself holds.
 *
 * WHERE EACH FACT COMES FROM. The OCI archive of the image, read once (`readImageWithFile` of
 * `scripts/release-manifest.mjs`, every blob checked against its digest): the image digest, and the
 * tree npm installed, from `/opt/rayspec/node_modules/.package-lock.json`, the record npm keeps of
 * every package it placed. Each component is one `name@version` with the SHA-512 npm checked it
 * against and the licence its manifest declares; a package installed at more than one place is
 * listed once. A `@rayspec` package's SHA-512 is that of the release tarball it was installed from,
 * which `scripts/release-manifest.mjs evidence` compares with the release manifest.
 *
 * WHAT IT DOES NOT DESCRIBE. Node itself and the Debian userland of the base image (pinned by digest
 * in the Dockerfile), and the PostgreSQL client tools copied from the pinned postgres image.
 *
 * DETERMINISM. No timestamp, serial number or host: the same archive gives the same bytes.
 *
 *   node scripts/gen-image-sbom.mjs --image-oci <rayspec-runtime.oci.tar> --out <image-sbom.cdx.json>
 *
 * Exit 0 written, 1 refused (the reason on stderr, nothing written), 2 usage.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { purl } from './gen-closure-sbom.mjs';
import { isEntryPoint } from './lib/entry.mjs';
import { ManifestRefused, readImageWithFile } from './release-manifest.mjs';

export const INSTALLED_TREE = 'opt/rayspec/node_modules/.package-lock.json';
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export class ImageSbomRefused extends Error {}

function refuse(message) {
  throw new ImageSbomRefused(message);
}

/** The name of the package installed at `path` (`node_modules/a/node_modules/@s/b` is `@s/b`). */
export function packageNameAt(path) {
  const at = path.lastIndexOf('node_modules/');
  if (at < 0) return null;
  const name = path.slice(at + 'node_modules/'.length);
  return /^(?:@[^/]+\/)?[^/@][^/]*$/.test(name) ? name : null;
}

/**
 * The SBOM of an image, from its facts (`readOciImage`) and the bytes of its installed tree. Refuses
 * a tree that names no rayspec launcher at the image's version, and a package without a version.
 */
export function imageSbom(image, treeBytes) {
  let tree;
  try {
    tree = JSON.parse(treeBytes.toString('utf8'));
  } catch {
    return refuse(`/${INSTALLED_TREE} in the image is not JSON`);
  }
  const version = image.labels['org.opencontainers.image.version'];
  if (typeof version !== 'string' || version === '')
    refuse('the image is labelled with no version');
  const packages = Object.entries(tree.packages ?? {}).filter(([path]) => path !== '');
  if (packages.length === 0) refuse(`/${INSTALLED_TREE} in the image lists no package`);
  const components = new Map();
  for (const [path, entry] of packages) {
    if (entry.link === true) continue;
    const name = packageNameAt(path);
    if (name === null) refuse(`/${INSTALLED_TREE} holds an entry at an unreadable path: ${path}`);
    if (typeof entry.version !== 'string' || entry.version === '') {
      refuse(`${path} in the image's installed tree has no version`);
    }
    const ref = purl(name, entry.version);
    const known = components.get(ref);
    if (known !== undefined) {
      known.paths.push(path);
      continue;
    }
    const sha512 = /^sha512-([A-Za-z0-9+/=]+)$/.exec(entry.integrity ?? '');
    components.set(ref, {
      ref,
      name,
      version: entry.version,
      optional: entry.optional === true,
      license: typeof entry.license === 'string' ? entry.license : null,
      sha512: sha512 === null ? null : Buffer.from(sha512[1], 'base64').toString('hex'),
      paths: [path],
    });
  }
  const launcher = components.get(purl('rayspec', version));
  if (launcher === undefined)
    refuse(`the image's installed tree holds no rayspec ${version} launcher`);
  const digestHex = image.digest.slice('sha256:'.length);
  const containerRef = `pkg:oci/rayspec@sha256%3A${digestHex}?arch=amd64`;
  const doc = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      tools: { components: [{ type: 'application', name: 'scripts/gen-image-sbom.mjs' }] },
      component: {
        type: 'container',
        'bom-ref': containerRef,
        name: 'rayspec-runtime',
        version,
        purl: containerRef,
        hashes: [{ alg: 'SHA-256', content: digestHex }],
      },
      properties: [
        { name: 'rayspec:image-digest', value: image.digest },
        { name: 'rayspec:image-config-digest', value: image.configDigest },
        { name: 'rayspec:image-platform', value: image.platform },
        { name: 'rayspec:node-version', value: image.nodeVersion ?? 'not named by the image' },
        { name: 'rayspec:installed-tree', value: `/${INSTALLED_TREE}` },
        { name: 'rayspec:installed-tree-sha256', value: sha256(treeBytes) },
        {
          name: 'rayspec:scope',
          value:
            'Every npm package installed under /opt/rayspec in the image. Node and the Debian ' +
            'userland of the base image, pinned by digest in the Dockerfile, and the PostgreSQL ' +
            'client tools are not listed.',
        },
      ],
    },
    components: [...components.values()]
      .sort((a, b) => byCodePoint(a.ref, b.ref))
      .map((c) => ({
        type: 'library',
        'bom-ref': c.ref,
        name: c.name,
        version: c.version,
        ...(c.optional ? { scope: 'optional' } : {}),
        purl: c.ref,
        ...(c.license === null ? {} : { licenses: [{ expression: c.license }] }),
        ...(c.sha512 === null ? {} : { hashes: [{ alg: 'SHA-512', content: c.sha512 }] }),
        properties: c.paths
          .sort(byCodePoint)
          .map((path) => ({ name: 'rayspec:installed-at', value: `/opt/rayspec/${path}` })),
      })),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { 'image-oci': { type: 'string' }, out: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    process.stderr.write(`[image-sbom] usage: ${err instanceof Error ? err.message : err}\n`);
    return 2;
  }
  if (values['image-oci'] === undefined || values.out === undefined) {
    process.stderr.write(
      '[image-sbom] usage: --image-oci <archive> and --out <file> are required\n',
    );
    return 2;
  }
  try {
    const archive = resolve(values['image-oci']);
    const { image, file: tree } = readImageWithFile(archive, INSTALLED_TREE);
    if (tree === null) refuse(`the image holds no /${INSTALLED_TREE}`);
    const text = imageSbom(image, tree);
    writeFileSync(resolve(values.out), text);
    const count = JSON.parse(text).components.length;
    process.stderr.write(
      `[image-sbom] ${resolve(values.out)}: ${count} packages in ${image.digest}\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof ImageSbomRefused || err instanceof ManifestRefused) {
      process.stderr.write(`[image-sbom] refused: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = main();
}
