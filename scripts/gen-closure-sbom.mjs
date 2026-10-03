#!/usr/bin/env node
/**
 * gen-closure-sbom.mjs — the CycloneDX 1.5 SBOM of the published closure, `docs/closure-sbom.cdx.json`.
 *
 * WHAT IT DESCRIBES. The packages a release publishes (the publish set of `scripts/publish.mjs`:
 * the launcher, `@rayspec/cli`, `@rayspec/server` and every `@rayspec` package they depend on in
 * production) and every third-party package they reach through production and optional
 * dependencies, with the dependency graph between them. Development dependencies are not part of
 * what a consumer installs and are left out.
 *
 * WHERE EACH FACT COMES FROM. The graph and each third-party package's SHA-512 come from
 * `pnpm-lock.yaml` (`importers`, `snapshots`, `packages`), which makes the document
 * host-independent. Each licence is the row of `docs/dependency-sbom.json` for that exact
 * `name@version` — the inventory THIRD-PARTY-NOTICES.md rests on — so the two documents never
 * disagree; a package whose licence that inventory could not read carries no licence here either,
 * and says why in a property. A `@rayspec` package carries the licence of its own manifest.
 *
 * DETERMINISM. No timestamp, serial number or host: the same lockfile, inventory and manifests give
 * the same bytes, and `scripts/check-sbom-fresh.mjs` compares the committed document with a fresh
 * one. Components and edges are sorted by code point; the output goes through the repository's
 * formatter like the dependency inventory does.
 *
 * WHAT IT DOES NOT DESCRIBE. A consumer's npm resolves the closure afresh from the registry, and a
 * dependency's own npm-shrinkwrap.json can pin copies this lockfile never lists (see
 * `scripts/check-consumer-install.mjs`). This document describes the closure as the workspace
 * resolves and tests it.
 *
 *   node scripts/gen-closure-sbom.mjs                 # writes docs/closure-sbom.cdx.json
 *   node scripts/gen-closure-sbom.mjs --out <file> [--tarballs <dir>]
 *
 * `--tarballs` (the output of `scripts/publish.mjs --pack`) adds the SHA-512 of each packed
 * `@rayspec` tarball; without it those components carry no hash, because none exists before a pack.
 * The release version is the repo-root manifest's, so a candidate pipeline that stamps it gets the
 * candidate version. Exit 0 written, 2 refused (the reason on stderr, nothing written).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { publishSet, workspaceMembers } from './lib/release-closure.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT = 'docs/closure-sbom.cdx.json';
export const LOCKFILE = 'pnpm-lock.yaml';
export const INVENTORY = 'docs/dependency-sbom.json';

export class SbomRefused extends Error {}

const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const unquote = (s) => s.trim().replace(/^'(.*)'$/, '$1');

/** The lines of one top-level block of the lockfile, without its header. */
function block(lines, header) {
  const start = lines.indexOf(header);
  if (start < 0) throw new SbomRefused(`${LOCKFILE} has no top-level '${header}' block`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z]/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

/** A mapping key at exactly `indent` spaces, quoted or bare, or null. `key: {}` is an empty one. */
function keyAt(line, indent) {
  const m = new RegExp(`^ {${indent}}(?:'(.+)'|([^\\s:'][^:]*)):\\s*(?:\\{\\})?\\s*$`).exec(line);
  return m ? (m[1] ?? m[2]) : null;
}

/** A `name: value` pair at exactly `indent` spaces, quoted or bare, or null. */
function pairAt(line, indent) {
  const m = new RegExp(`^ {${indent}}(?:'([^']+)'|([^\\s:'][^:]*)):\\s+(\\S.*)$`).exec(line);
  return m ? { key: m[1] ?? m[2], value: unquote(m[3]) } : null;
}

/** `name@version(peers…)` → `{ name, version }`, the version without its peer suffix. */
export function splitSnapshotKey(key) {
  const paren = key.indexOf('(');
  const bare = paren < 0 ? key : key.slice(0, paren);
  const at = bare.lastIndexOf('@');
  if (at <= 0) throw new SbomRefused(`cannot split '${key}' into name@version`);
  return { name: bare.slice(0, at), version: bare.slice(at + 1) };
}

/**
 * The lockfile, parsed into what the SBOM needs: per importer its production and optional
 * dependencies, per snapshot its dependencies, per package its integrity and platform constraints.
 */
export function parseLockfile(text) {
  const lines = text.split('\n');
  if (!/^lockfileVersion: '9\.\d+'$/.test(lines[0] ?? '')) {
    throw new SbomRefused(`${LOCKFILE} is not a lockfile of format 9: re-check this parser`);
  }
  const importers = new Map();
  let importer = null;
  let section = null;
  let dep = null;
  for (const line of block(lines, 'importers:')) {
    const imp = keyAt(line, 2);
    if (imp !== null) {
      importer = { dependencies: new Map() };
      importers.set(imp, importer);
      section = null;
      continue;
    }
    const sec = keyAt(line, 4);
    if (sec !== null) {
      section = sec;
      dep = null;
      continue;
    }
    if (section !== 'dependencies' && section !== 'optionalDependencies') continue;
    const name = keyAt(line, 6);
    if (name !== null) {
      dep = name;
      continue;
    }
    const version = pairAt(line, 8);
    if (version?.key === 'version' && dep !== null && importer !== null) {
      importer.dependencies.set(dep, {
        resolved: version.value,
        optional: section === 'optionalDependencies',
      });
    }
  }

  const snapshots = new Map();
  let snapshot = null;
  for (const line of block(lines, 'snapshots:')) {
    const key = keyAt(line, 2);
    if (key !== null) {
      snapshot = { dependencies: new Map() };
      snapshots.set(key, snapshot);
      section = null;
      continue;
    }
    const sec = keyAt(line, 4);
    if (sec !== null) {
      section = sec;
      continue;
    }
    if (section !== 'dependencies' && section !== 'optionalDependencies') continue;
    const pair = pairAt(line, 6);
    if (pair !== null && snapshot !== null) {
      snapshot.dependencies.set(pair.key, {
        resolved: pair.value,
        optional: section === 'optionalDependencies',
      });
    }
  }

  const packages = new Map();
  let pkg = null;
  for (const line of block(lines, 'packages:')) {
    const key = keyAt(line, 2);
    if (key !== null) {
      pkg = { integrity: null, constraints: {} };
      packages.set(key, pkg);
      continue;
    }
    if (pkg === null) continue;
    const integrity = /^ {4}resolution: \{.*integrity: (sha512-[A-Za-z0-9+/]+={0,2})/.exec(line);
    if (integrity) pkg.integrity = integrity[1];
    const constraint = /^ {4}(os|cpu|libc):\s*\[(.*)\]\s*$/.exec(line);
    if (constraint) {
      pkg.constraints[constraint[1]] = constraint[2].split(',').map((s) => unquote(s));
    }
  }
  return { importers, snapshots, packages };
}

/**
 * The snapshot key a dependency resolves to. A version names the package under its own name; an
 * npm alias (`'@openai/codex@0.142.2-darwin-arm64'` installed as another name) names the real
 * package itself. Anything else is not something this parser understands.
 */
export function snapshotKey(dep, resolved) {
  if (/^[0-9]/.test(resolved)) return `${dep}@${resolved}`;
  if (/^@?[^@\s]+@[0-9]/.test(resolved)) return resolved;
  throw new SbomRefused(`${dep} resolves to '${resolved}', which is not a version`);
}

/** A package URL for an npm package. */
export function purl(name, version) {
  const encoded = name.startsWith('@') ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encoded}@${version}`;
}

/**
 * The CycloneDX document. `members` is `workspaceMembers()`, `inventory` the parsed dependency
 * inventory, `rootVersion` the release version, `tarballSha512` an optional map of a `@rayspec`
 * package name to the hex SHA-512 of its packed tarball.
 */
export function closureSbom({ lock, members, inventory, rootVersion, tarballSha512 = new Map() }) {
  const licenses = new Map(
    (inventory.packages ?? []).map((row) => [`${row.name}@${row.version}`, row]),
  );
  const names = publishSet(members);
  const dirToName = new Map([...members].map(([name, m]) => [m.dir, name]));
  const components = new Map();
  const edges = new Map();

  const addEdge = (from, to) => {
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from).add(to);
  };

  for (const name of names) {
    const member = members.get(name);
    const ref = purl(name, rootVersion);
    const component = {
      type: name === 'rayspec' ? 'application' : 'library',
      'bom-ref': ref,
      name,
      version: rootVersion,
      purl: ref,
      licenses:
        typeof member.json.license === 'string' ? [{ expression: member.json.license }] : undefined,
    };
    const hex = tarballSha512.get(name);
    if (hex !== undefined) component.hashes = [{ alg: 'SHA-512', content: hex }];
    components.set(ref, component);
    edges.set(ref, edges.get(ref) ?? new Set());
  }

  const queue = [];
  for (const name of names) {
    const dir = members.get(name).dir;
    const importer = lock.importers.get(dir);
    if (importer === undefined) throw new SbomRefused(`${LOCKFILE} has no importer for ${dir}`);
    const from = purl(name, rootVersion);
    for (const [dep, { resolved, optional }] of importer.dependencies) {
      if (resolved.startsWith('link:')) {
        const target = join(dir, resolved.slice('link:'.length));
        const linked = dirToName.get(target);
        if (linked === undefined || !names.includes(linked)) {
          throw new SbomRefused(`${name} links ${dep} to ${target}, which is not published`);
        }
        addEdge(from, purl(linked, rootVersion));
        continue;
      }
      queue.push({ from, key: snapshotKey(dep, resolved), optional });
    }
  }

  const visited = new Map();
  while (queue.length > 0) {
    const { from, key, optional } = queue.shift();
    const { name, version } = splitSnapshotKey(key);
    const ref = purl(name, version);
    addEdge(from, ref);
    const seenOptional = visited.get(key);
    if (seenOptional !== undefined) {
      // A package first reached only through optional edges becomes required once a required
      // edge reaches it.
      if (seenOptional && !optional) {
        visited.set(key, false);
        const c = components.get(ref);
        if (c !== undefined) c.scope = 'required';
        const snap = lock.snapshots.get(key);
        for (const [dep, d] of snap?.dependencies ?? []) {
          if (!d.optional)
            queue.push({ from: ref, key: snapshotKey(dep, d.resolved), optional: false });
        }
      }
      continue;
    }
    visited.set(key, optional);
    const meta = lock.packages.get(`${name}@${version}`);
    if (meta === undefined)
      throw new SbomRefused(`${LOCKFILE} lists no package ${name}@${version}`);
    if (!components.has(ref)) {
      const row = licenses.get(`${name}@${version}`);
      if (row === undefined) {
        throw new SbomRefused(
          `${INVENTORY} has no row for ${name}@${version}: regenerate it with gen-dependency-sbom`,
        );
      }
      const properties = [];
      for (const [key2, values] of Object.entries(meta.constraints).sort(([a], [b]) =>
        byCodePoint(a, b),
      )) {
        properties.push({ name: `cdx:npm:package:${key2}`, value: values.join(',') });
      }
      if (row.license === null) {
        properties.push({
          name: 'rayspec:license-not-read',
          value: `${INVENTORY} records no licence: the package is not installed on the host that generated it`,
        });
      }
      const component = {
        type: 'library',
        'bom-ref': ref,
        name,
        version,
        scope: optional ? 'optional' : 'required',
        purl: ref,
        licenses: row.license === null ? undefined : [{ expression: row.license }],
        hashes:
          meta.integrity === null
            ? undefined
            : [
                {
                  alg: 'SHA-512',
                  content: Buffer.from(meta.integrity.slice('sha512-'.length), 'base64').toString(
                    'hex',
                  ),
                },
              ],
        properties: properties.length > 0 ? properties : undefined,
      };
      components.set(ref, component);
    }
    edges.set(ref, edges.get(ref) ?? new Set());
    const snap = lock.snapshots.get(key);
    if (snap === undefined) throw new SbomRefused(`${LOCKFILE} has no snapshot ${key}`);
    for (const [dep, d] of snap.dependencies) {
      queue.push({
        from: ref,
        key: snapshotKey(dep, d.resolved),
        optional: optional || d.optional,
      });
    }
  }

  const launcher = components.get(purl('rayspec', rootVersion));
  if (launcher === undefined) throw new SbomRefused('the publish set has no launcher');
  const sorted = [...components.values()]
    .filter((c) => c !== launcher)
    .sort((a, b) => byCodePoint(a['bom-ref'], b['bom-ref']));
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      tools: {
        components: [{ type: 'application', name: 'scripts/gen-closure-sbom.mjs' }],
      },
      component: launcher,
      properties: [
        { name: 'rayspec:lockfile', value: LOCKFILE },
        { name: 'rayspec:lockfile-sha256', value: lock.sha256 },
        { name: 'rayspec:license-inventory', value: INVENTORY },
        { name: 'rayspec:license-inventory-sha256', value: inventory.sha256 },
        {
          name: 'rayspec:scope',
          value:
            'The published closure as the workspace lockfile resolves it: the publish set and ' +
            'every package it reaches through production and optional dependencies. A consumer ' +
            'install resolves afresh from the registry.',
        },
      ],
    },
    components: sorted,
    dependencies: [...edges]
      .sort(([a], [b]) => byCodePoint(a, b))
      .map(([ref, to]) => ({ ref, dependsOn: [...to].sort(byCodePoint) })),
  };
}

/** The hex SHA-512 of every `.tgz` in `dir`, keyed by the package name its manifest declares. */
function tarballDigests(dir) {
  const out = new Map();
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.tgz'))
    .sort()) {
    const path = join(dir, file);
    const manifest = JSON.parse(
      execFileSync('tar', ['-xzOf', path, 'package/package.json'], { encoding: 'utf8' }),
    );
    if (out.has(manifest.name)) throw new SbomRefused(`${manifest.name} is packed twice in ${dir}`);
    out.set(manifest.name, createHash('sha512').update(readFileSync(path)).digest('hex'));
  }
  return out;
}

/** The document for the checkout at `repo`, as an object. */
export function closureSbomOf(repo = REPO, { tarballs } = {}) {
  const lockBytes = readFileSync(join(repo, LOCKFILE));
  const lock = { ...parseLockfile(lockBytes.toString('utf8')), sha256: sha256(lockBytes) };
  const inventoryBytes = readFileSync(join(repo, INVENTORY));
  const inventory = {
    ...JSON.parse(inventoryBytes.toString('utf8')),
    sha256: sha256(inventoryBytes),
  };
  const root = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const members = workspaceMembers(repo);
  const digests = tarballs === undefined ? new Map() : tarballDigests(tarballs);
  if (tarballs !== undefined) {
    const expected = publishSet(members);
    const packed = [...digests.keys()].sort(byCodePoint);
    if (JSON.stringify(packed) !== JSON.stringify(expected)) {
      throw new SbomRefused(
        `${tarballs} does not hold exactly the publish set (${packed.length} of ${expected.length} packed)`,
      );
    }
  }
  return closureSbom({
    lock,
    members,
    inventory,
    rootVersion: root.version,
    tarballSha512: digests,
  });
}

/** The formatted text of the document for `repo`, as the formatter writes it. */
export function generate(repo = REPO, options = {}) {
  const sbom = closureSbomOf(repo, options);
  const biome = join(repo, 'node_modules/.bin/biome');
  if (!existsSync(biome)) {
    throw new SbomRefused(`${biome} is missing: run pnpm install --frozen-lockfile first`);
  }
  return execFileSync(biome, ['format', `--stdin-file-path=${OUTPUT}`], {
    cwd: repo,
    input: `${JSON.stringify(sbom, null, 2)}\n`,
    encoding: 'utf8',
  });
}

function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { out: { type: 'string' }, tarballs: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    process.stderr.write(`usage: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  try {
    const text = generate(REPO, {
      tarballs: values.tarballs === undefined ? undefined : resolve(values.tarballs),
    });
    const out = values.out === undefined ? join(REPO, OUTPUT) : resolve(values.out);
    writeFileSync(out, text);
    const doc = JSON.parse(text);
    process.stdout.write(
      `wrote ${out}: ${doc.components.length + 1} components, ` +
        `${doc.metadata.component.name}@${doc.metadata.component.version}\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof SbomRefused) {
      process.stderr.write(`closure SBOM refused: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
