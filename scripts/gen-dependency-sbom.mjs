#!/usr/bin/env node
/**
 * gen-dependency-sbom.mjs — regenerate `docs/dependency-sbom.json`.
 *
 * WHAT THE SBOM IS. A per-package inventory of the third-party dependency tree, used as the factual
 * backing for `THIRD-PARTY-NOTICES.md`. It answers two questions a reader of a legal document is
 * entitled to ask: *which* third-party packages does this project resolve, and *under what licence*.
 *
 * HOW SCOPE IS DERIVED (the load-bearing design choice).
 *   The package SET comes from `pnpm-lock.yaml`'s `packages:` section — one entry per distinct
 *   `name@version` the workspace resolves. That set is HOST-INDEPENDENT: it is the same on macOS, on
 *   Linux, and in CI, because it is what the lockfile pins. It is NOT a scan of the machine's pnpm
 *   store, which is shared across unrelated projects and therefore describes the machine rather than
 *   this repository.
 *
 *   Each row's LICENCE is then read verbatim from the installed `package.json` under
 *   `node_modules/.pnpm/**`, after a `--frozen-lockfile` install. A package whose `os`/`cpu`/`libc`
 *   constraints exclude the generating host is not installed, so its manifest cannot be read: such a
 *   row is emitted with `installed: false`, `license: null` and an explicit `absent_reason`, never
 *   silently dropped. Those rows are per-platform binary variants (and packages reachable only
 *   through one); a deployer installing on their own platform resolves — and can regenerate the
 *   licence for — the variants that platform actually uses.
 *
 * WHAT IT EMITS.
 *   - `packages[]`  — the real per-package table: name, version, license (verbatim), whether the
 *                     package ships its own licence file, whether it is installed here, which of our
 *                     own workspace packages declare it directly, and the platform constraints.
 *   - `license_groups`, `flags` — DERIVED from that table (never measured separately), so the summary
 *                     can never disagree with the rows it summarises. `classification` records the
 *                     exact regexes used, so a reader can audit the copyleft call rather than trust it.
 *   - `lockfile_sha256` — the hash the freshness gate (`scripts/check-sbom-fresh.mjs`) compares
 *                     against the current `pnpm-lock.yaml`. A dependency that moves without a
 *                     regenerated SBOM fails the gate.
 *   - `provenance`  — the generating host and node version. PROVENANCE ONLY. It records where the
 *                     licences were read, never what the inventory covers.
 *
 * Output is piped through the repo's own formatter so a regenerated SBOM is always `pnpm lint`-clean.
 *
 *   pnpm install --frozen-lockfile && node scripts/gen-dependency-sbom.mjs
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCKFILE = 'pnpm-lock.yaml';
const OUTPUT = 'docs/dependency-sbom.json';
const REPRODUCE = `pnpm install --frozen-lockfile && node scripts/gen-dependency-sbom.mjs`;

// ─── licence classification (recorded in the output so a reader can audit the call) ──────────────
// SPDX identifiers are matched as whole tokens. `strong` is the family that would impose source
// obligations on a linked work; `weak` is file-scoped copyleft; `custom` covers the non-SPDX escape
// hatches npm allows (`SEE LICENSE IN <file>` and `UNLICENSED`), which always warrant a human read.
const CLASSIFY = {
  strong_copyleft: /\b(?:AGPL|LGPL|GPL)(?:-[\d.]+(?:-only|-or-later)?)?\b/i,
  weak_copyleft: /\b(?:MPL|EPL|CDDL|CPL|OSL|Ms-RL)\b/i,
  custom_or_proprietary: /^\s*(?:SEE LICENSE IN|UNLICENSED)/i,
};

/** sha256 of a file's bytes, hex. */
function sha256File(rel) {
  return createHash('sha256')
    .update(readFileSync(join(repoRoot, rel)))
    .digest('hex');
}

/**
 * Split a lockfile `packages:` key into `{ name, version }`. The key is `name@version`, where the
 * name may itself begin with `@scope/` — so the version starts at the LAST `@`. pnpm v9 writes peer
 * suffixes (`(zod@4.4.3)`) only under `snapshots:`, never under `packages:`; a key carrying one here
 * would mean the lockfile format changed underneath us, so we fail loudly rather than mis-parse.
 */
function splitKey(key) {
  if (key.includes('(')) {
    throw new Error(
      `unexpected peer suffix in a ${LOCKFILE} 'packages:' key: ${key} — the lockfile format changed; ` +
        `re-check this parser before trusting the SBOM.`,
    );
  }
  const at = key.lastIndexOf('@');
  if (at <= 0) throw new Error(`cannot split '${key}' into name@version`);
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

/** The lines of one top-level YAML block (`packages:` / `importers:`), exclusive of the header. */
function topLevelBlock(lines, header) {
  const start = lines.indexOf(header);
  if (start < 0) throw new Error(`${LOCKFILE} has no top-level '${header}' block`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z]/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

/** A YAML mapping key at exactly `indent` spaces, quoted or bare. Returns null for any other line. */
function keyAt(line, indent) {
  const m = line.match(new RegExp(`^ {${indent}}(?:'(.+)'|([^\\s:][^:]*)):\\s*$`));
  return m ? (m[1] ?? m[2]) : null;
}

/**
 * Parse `packages:` → one record per distinct `name@version`, carrying the platform constraints
 * (`os`/`cpu`/`libc`) that decide whether this host installs it. Values are kept as the lockfile's own
 * inline-array text (e.g. `[darwin]`), normalised to a string array.
 */
function parsePackages(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const key = keyAt(lines[i], 2);
    if (key === null) continue;
    const { name, version } = splitKey(key);
    const constraints = {};
    for (let j = i + 1; j < lines.length && !/^ {2}\S/.test(lines[j]); j++) {
      const f = lines[j].match(/^ {4}(os|cpu|libc):\s*\[(.*)\]\s*$/);
      if (f) constraints[f[1]] = f[2].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    }
    out.push({ name, version, ...constraints });
  }
  return out;
}

/**
 * Parse `importers:` → `Map<'name@version', string[]>`: for every external package one of OUR OWN
 * workspace packages declares directly, the list of declaring workspace paths. `link:` versions are
 * workspace-internal (`@rayspec/*`) and are excluded — they are not third-party.
 */
function parseDirectDependents(lines) {
  const byPkg = new Map();
  let importer = null;
  let inDepSection = false;
  let depName = null;
  for (const line of lines) {
    const imp = keyAt(line, 2);
    if (imp !== null) {
      importer = imp === '.' ? '<workspace root>' : imp;
      inDepSection = false;
      depName = null;
      continue;
    }
    const section = keyAt(line, 4);
    if (section !== null) {
      inDepSection = ['dependencies', 'devDependencies', 'optionalDependencies'].includes(section);
      depName = null;
      continue;
    }
    if (!inDepSection) continue;
    const dep = keyAt(line, 6);
    if (dep !== null) {
      depName = dep;
      continue;
    }
    const ver = line.match(/^ {8}version:\s*(.*)$/);
    if (!ver || depName === null || importer === null) continue;
    const resolved = ver[1].trim().replace(/^'|'$/g, '');
    if (resolved.startsWith('link:')) continue; // workspace-internal, not third-party
    // Strip the peer suffix pnpm appends to an importer's resolved version: `0.11.8(zod@4.4.3)`.
    const version = resolved.replace(/\(.*\)$/, '');
    const key = `${depName}@${version}`;
    if (!byPkg.has(key)) byPkg.set(key, []);
    if (!byPkg.get(key).includes(importer)) byPkg.get(key).push(importer);
  }
  for (const list of byPkg.values()) list.sort();
  return byPkg;
}

/**
 * Index every package REALLY present under `node_modules/.pnpm/<dir>/node_modules/` by
 * `name@version`. Only real directories are read: pnpm materialises a package once and links its own
 * dependencies in as SYMLINKS beside it, so skipping symlinks visits each package exactly once.
 */
function indexInstalled() {
  const base = join(repoRoot, 'node_modules/.pnpm');
  if (!existsSync(base)) {
    throw new Error(
      `${base} is missing — run \`pnpm install --frozen-lockfile\` before generating the SBOM.`,
    );
  }
  const index = new Map();
  const isRealDir = (p) => {
    try {
      return !lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  };
  for (const entry of readdirSync(base)) {
    const nm = join(base, entry, 'node_modules');
    if (!existsSync(nm)) continue;
    for (const child of readdirSync(nm)) {
      const childPath = join(nm, child);
      if (!isRealDir(childPath)) continue;
      const candidates = child.startsWith('@')
        ? readdirSync(childPath).map((scoped) => join(childPath, scoped))
        : [childPath];
      for (const dir of candidates) {
        if (!isRealDir(dir)) continue;
        const manifestPath = join(dir, 'package.json');
        if (!existsSync(manifestPath)) continue;
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (!manifest.name || !manifest.version) continue;
        const key = `${manifest.name}@${manifest.version}`;
        if (index.has(key)) continue;
        index.set(key, {
          // Verbatim: whatever string the publisher put in `license`. A non-string (the deprecated
          // object/array forms) is preserved as JSON text rather than silently normalised away.
          license:
            typeof manifest.license === 'string'
              ? manifest.license
              : manifest.license
                ? JSON.stringify(manifest.license)
                : null,
          license_file_present: readdirSync(dir).some((f) =>
            /^(licen[cs]e|copying|notice)/i.test(f),
          ),
        });
      }
    }
  }
  return index;
}

// ─── build the table ────────────────────────────────────────────────────────────────────────────
const lockLines = readFileSync(join(repoRoot, LOCKFILE), 'utf8').split('\n');
const lockPackages = parsePackages(topLevelBlock(lockLines, 'packages:'));
const directDependents = parseDirectDependents(topLevelBlock(lockLines, 'importers:'));
const installed = indexInstalled();

const packages = lockPackages
  .map(({ name, version, os, cpu, libc }) => {
    const key = `${name}@${version}`;
    const hit = installed.get(key);
    const row = {
      name,
      version,
      license: hit?.license ?? null,
      license_file_present: hit ? hit.license_file_present : null,
      installed: Boolean(hit),
    };
    const constraints = {
      ...(os ? { os } : {}),
      ...(cpu ? { cpu } : {}),
      ...(libc ? { libc } : {}),
    };
    if (Object.keys(constraints).length > 0) row.platform_constraints = constraints;
    if (!hit) {
      row.absent_reason = Object.keys(constraints).length
        ? 'optional, platform-gated: this host does not satisfy its os/cpu/libc constraints, so it is ' +
          'not installed and its licence was NOT read from disk'
        : 'not installed: reachable only through an optional, platform-gated package this host skips, ' +
          'so its licence was NOT read from disk';
    }
    const dependents = directDependents.get(key);
    if (dependents) row.direct_dependents = dependents;
    return row;
  })
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

// ─── derive every summary FROM the table (never measured separately) ────────────────────────────
const license_groups = {};
for (const row of packages) {
  if (row.license === null) continue;
  license_groups[row.license] = (license_groups[row.license] ?? 0) + 1;
}
const sortedGroups = Object.fromEntries(
  Object.entries(license_groups).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
);

const label = (row) => `${row.name}@${row.version} [${row.license}]`;
const licensed = packages.filter((row) => row.license !== null);
const flags = {
  strong_copyleft: licensed.filter((r) => CLASSIFY.strong_copyleft.test(r.license)).map(label),
  weak_copyleft: licensed.filter((r) => CLASSIFY.weak_copyleft.test(r.license)).map(label),
  custom_or_proprietary: licensed
    .filter((r) => CLASSIFY.custom_or_proprietary.test(r.license))
    .map(label),
  // Where a publisher ships NO in-tarball licence file, the attribution obligation cannot be met by
  // the installed tree alone — THIRD-PARTY-NOTICES.md carries it. This list is what makes that claim
  // checkable rather than decorative.
  ships_no_license_file: packages
    .filter((r) => r.installed && r.license_file_present === false)
    .map(label),
  license_not_read_on_this_host: packages
    .filter((r) => !r.installed)
    .map((r) => `${r.name}@${r.version}`),
};

const counts = {
  lockfile_distinct: packages.length,
  installed_here: packages.filter((r) => r.installed).length,
  license_read_from_manifest: licensed.length,
  license_not_read: flags.license_not_read_on_this_host.length,
};

const sbom = {
  schema: 'rayspec-dependency-sbom/1',
  generated_by: 'scripts/gen-dependency-sbom.mjs',
  reproduce: REPRODUCE,
  scope_note:
    `The package SET is derived from ${LOCKFILE} (host-independent). Each licence is read verbatim ` +
    `from the installed package.json after a --frozen-lockfile install. Rows with installed:false are ` +
    `optional, platform-gated packages this host does not install; their licence was not read from ` +
    `disk and is recorded as null with an absent_reason, never dropped. 'provenance' below records ` +
    `WHERE the licences were read — it does not describe the scope of this inventory.`,
  lockfile: LOCKFILE,
  lockfile_sha256: sha256File(LOCKFILE),
  provenance: {
    host: `${process.platform}-${process.arch}`,
    node: process.version,
  },
  counts,
  classification: Object.fromEntries(
    Object.entries(CLASSIFY).map(([name, re]) => [name, re.source]),
  ),
  license_groups: sortedGroups,
  flags,
  packages,
};

// Format through the repo's own formatter so a regenerated SBOM never breaks `pnpm lint`.
const biome = join(repoRoot, 'node_modules/.bin/biome');
if (!existsSync(biome)) {
  throw new Error(`${biome} is missing — run \`pnpm install --frozen-lockfile\` first.`);
}
const formatted = execFileSync(biome, ['format', `--stdin-file-path=${OUTPUT}`], {
  input: `${JSON.stringify(sbom, null, 2)}\n`,
  encoding: 'utf8',
});
writeFileSync(join(repoRoot, OUTPUT), formatted);

console.log(
  `wrote ${OUTPUT}: ${counts.lockfile_distinct} distinct packages from ${LOCKFILE} ` +
    `(${counts.installed_here} installed on ${sbom.provenance.host}, ` +
    `${counts.license_not_read} platform-gated and not installed here).\n` +
    `  strong copyleft: ${flags.strong_copyleft.length} | weak copyleft: ${flags.weak_copyleft.length} | ` +
    `custom/proprietary: ${flags.custom_or_proprietary.length} | ship no licence file: ${flags.ships_no_license_file.length}\n` +
    `  lockfile_sha256: ${sbom.lockfile_sha256}`,
);
