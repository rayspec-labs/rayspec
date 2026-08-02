#!/usr/bin/env node
/**
 * RaySpec release identity manifest — the mapping from a published npm closure back to the commit
 * it was built from, and the tool that refutes it.
 *
 * WHY THIS EXISTS
 * ---------------
 * A development checkout legitimately carries the PREVIOUS release version until the release cut,
 * so a commit hash plus a `version` field does not identify a published artifact: the tree can say
 * `1.6.2` while the annotated `v1.6.2` points at an ancestor and the working tree already holds the
 * next release's work. Nothing in this repository closed that gap — there was no artifact that said
 * "these exact tarballs came from this exact commit". This script emits one, and verifies one.
 *
 * WHAT THE MANIFEST RECORDS
 * -------------------------
 *   - the release version and the source commit, plus whether the working tree was CLEAN at that
 *     commit (`git diff --name-only HEAD`: build output, packed tarballs and this manifest itself
 *     are UNTRACKED by design, so only a tracked file that differs from HEAD counts as dirty);
 *   - for every member of the launcher's runtime closure: name, version, tarball integrity and the
 *     unpacked file-list digest;
 *   - the three checked-in JSON Schema artifacts (unified / backend / product), the lockfile digest
 *     and the dependency-SBOM digest;
 *   - the Node and pnpm requirements, read from the repo-root manifest;
 *   - the Git tag and the build workflow run — see HONESTY below.
 * Every digest form is named IN the manifest (`algorithms`), so a third party can reproduce one
 * without reading this script.
 *
 * THE TWO DIGESTS, AND WHAT EACH ONE IDENTIFIES (measured, not assumed)
 * --------------------------------------------------------------------
 * `pnpm pack` rewrites each `workspace:*` dependency to the stamped version in the PACKED manifest,
 * and it does not emit that map in a stable key order: two consecutive `--pack` runs of one commit
 * move a varying subset of the tarballs, bounded by the 15 of 29 packed manifests that declare more
 * than one internal dependency (measured pairs moved 9, 11, 12 and 12 of the 29), and in every
 * single case the difference was confined to `package/package.json` and vanished once its keys were
 * sorted. So:
 *   - `tarball.integrity` (sha512 SRI) identifies ONE ARTIFACT — the exact tarball this manifest was
 *     generated from, i.e. the file an operator attaches to the release. It is not a reproducible
 *     build claim, and re-packing the same commit will legitimately move it.
 *   - `files.list_digest` identifies THE PACKAGE — it digests the unpacked entries, canonicalising
 *     `package.json` (see `algorithms`) so the one measured source of pack noise cannot move it. It
 *     is the digest that still matches after a re-pack of the same commit, and therefore the one
 *     that matches a tarball fetched from the registry: `--publish` packs again at publish time, so
 *     the registry never serves the byte-for-byte file this manifest hashed.
 * Both are recorded because they fail differently: an altered archive that unpacks to identical
 * content is caught only by the first, and altered content is caught by the second.
 *
 * THE SELF-REFERENCE
 * ------------------
 * This manifest SHIPS INSIDE the launcher package (`packages/app/rayspec`, the unscoped `rayspec`
 * tarball), so the launcher cannot record its own tarball integrity: a tarball containing the digest
 * of itself is not a fixed point that exists. Nothing is invented to paper over that. The launcher's
 * `tarball.integrity` is an explicit `null` with a reason, and the invariant recorded in its place
 * IS verifiable on the shipped tarball: its file-list digest over every entry EXCEPT the manifest
 * (`files.excluded`). Verification computes the same exclusion, and — when the tarball carries the
 * manifest — additionally requires those bytes to be byte-identical to the manifest being verified.
 * So the exclusion is not a hole: a launcher carrying some OTHER manifest fails. That holds because
 * `unpack` reads WHICH file each entry is, and WHERE it ends, the way node-tar and libarchive do, and
 * refuses the rest — an archive that carries one path twice, that hides content behind a lone null
 * block, that renames an entry through a pax `path=` the two readers read differently, or that
 * carries a pax record able to move an entry's boundaries in a way this reader does not model.
 * Without those refusals the excluded path is a place to post a second, forged copy that the file
 * list never sees while extraction installs something else.
 * The launcher is also packed FROM a directory a previous release run may have left a manifest in,
 * so generation refuses when the packed launcher already carries a manifest that is not the one it
 * would write — see the `//release-identity` operator sequence, whose first step removes it.
 *
 * HONESTY ABOUT WHAT DOES NOT EXIST
 * ---------------------------------
 * There is no release workflow in `.github/workflows`, by design: a release happens when a human
 * invokes `scripts/publish.mjs` (see its docblock). So the build workflow run is recorded only from
 * a GitHub Actions environment and is otherwise an explicit `null` with a machine-readable reason —
 * never a fabricated value. The tag is recorded the same way: generating a manifest BEFORE the
 * release tag exists is normal, and it is written down as `state: "absent"` rather than guessed.
 * The manifest is also UNSIGNED, and says so in `signature`, with the reason.
 *
 * DETERMINISM
 * -----------
 * The output carries no timestamp, no host and no random ordering: given the same checkout and the
 * same tarballs it is byte-identical, which is what makes "re-derive it yourself" a real offer.
 *
 *   node scripts/release-identity.mjs --tarballs <dir> [--out <file>] [--json]
 *   node scripts/release-identity.mjs --verify --tarballs <dir> [--manifest <file>] [--json]
 *
 * Exit codes: 0 verified / written · 1 verification failed · 2 refused (bad usage or bad inputs).
 * No network, no package manager, no git WRITES: the script reads the workspace, reads tarballs and
 * writes one file. See the repo-root `package.json` `//release-identity` note for the operator
 * sequence, including where the manifest is attached to the GitHub release.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The ONE authoritative manifest — the same source `publish.mjs` derives the release version from. */
const VERSION_SOURCE = 'package.json';
/** The launcher package: the tarball this manifest ships inside, and the root of the closure. */
const LAUNCHER_DIR = 'packages/app/rayspec';
/** The manifest's file name — identical as a release asset and inside the launcher tarball. */
const MANIFEST_NAME = 'rayspec-release-identity.json';
const SCHEMA_ID = 'rayspec-release-identity/1';
/** The checked-in schema artifacts, each named by the profile it describes. */
const SCHEMAS = [
  { path: 'packages/kernel/spec/version-1.0.schema.json', profile: 'unified' },
  { path: 'packages/kernel/spec/spec.schema.json', profile: 'backend' },
  { path: 'packages/kernel/spec/product.schema.json', profile: 'product' },
];
const LOCKFILE = 'pnpm-lock.yaml';
const DEPENDENCY_SBOM = 'docs/dependency-sbom.json';

/** The digest forms, stated in the manifest so a third party never has to read this file. */
const ALGORITHMS = {
  tarball_integrity:
    'sha512 over the exact tarball bytes, base64, in Subresource-Integrity form ' +
    '(`sha512-<base64>`) — the same value npm records as `dist.integrity`. Reproduce: ' +
    '`openssl dgst -sha512 -binary <file>.tgz | openssl base64 -A`.',
  file_digest:
    'sha256, hex, over one unpacked entry. `package.json` is CANONICALISED first — parsed and ' +
    "re-serialised as `JSON.stringify(value, null, 2)` with every object's keys sorted ascending " +
    'and one trailing newline — because pnpm rewrites `workspace:*` into that file and does not ' +
    'emit the resulting map in a stable key order. Every other entry is digested verbatim.',
  file_list_digest:
    'sha256, hex, over the UTF-8 concatenation of `<path> <file_digest>\\n` for every unpacked ' +
    'entry not listed in `files.excluded`, paths relative to the package root (the leading ' +
    '`package/` of the tarball removed), lines sorted byte-wise ascending.',
  source_file_digest:
    'sha256, hex, over the file bytes in the checkout the manifest was generated from — identical ' +
    'to the bytes committed at `source.commit` when `source.worktree_clean` is true, and otherwise ' +
    'the working-tree bytes of a file `source.dirty_paths` names. Reproduce: `shasum -a 256 <path>`.',
};

/** What the digests do and do not claim — the same idiom the dependency SBOM uses. */
const SCOPE_NOTE =
  'This manifest identifies the release artifacts produced by `scripts/publish.mjs --pack` at ' +
  '`source.commit` — the tarballs attached to the GitHub release, which are what `--verify` checks. ' +
  '`tarball.integrity` pins those exact files. `files.list_digest` pins their unpacked content and ' +
  'is the digest that survives a re-pack of the same commit, so it is also the digest that matches ' +
  'a tarball fetched from the registry (a real publish packs again at publish time). Measured: two ' +
  'consecutive packs of one commit moved 9, 11, 12 and 12 of the 29 tarballs across four pairs — ' +
  'bounded by the 15 packed manifests that declare more than one internal dependency — and in every ' +
  'case the difference was confined to `package/package.json` and vanished once its keys were ' +
  'sorted, which is exactly what the file digest canonicalises away. Neither digest is a ' +
  'reproducible-build claim about the toolchain.';

/** Parse the flag grammar (no positionals). */
function parseFlags(argv) {
  const flags = { verify: false, tarballs: null, out: null, manifest: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // A value-taking flag with no value reads as `undefined`, which for --out and --manifest used to
    // fall back to the default path — so a mistyped command wrote somewhere the operator did not ask
    // for and exited 0. Every one of them is checked the same way.
    const value = (flag) => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) refuse(`${flag} requires a value.`);
      return v;
    };
    if (a === '--verify') flags.verify = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--tarballs') flags.tarballs = value('--tarballs');
    else if (a === '--out') flags.out = value('--out');
    else if (a === '--manifest') flags.manifest = value('--manifest');
    else refuse(`unknown flag: ${a}`);
  }
  if (!flags.tarballs)
    refuse('--tarballs <dir> is required: the directory holding the release tarballs.');
  return flags;
}

/** A refusal: nothing was written, and the message says what is wrong. */
function refuse(...lines) {
  for (const l of lines) console.error(l);
  process.exit(2);
}

/**
 * Read-only git in the repo root, as `{ ok, value }`. The pair exists so that a COMMAND THAT FAILED
 * is never read as an answer: `git diff` exiting 128 (a corrupt index, a `required` clean filter
 * whose binary is missing) produces no output, and empty output is what a clean tree also looks like.
 */
function gitTry(...args) {
  try {
    return {
      ok: true,
      value: execFileSync('git', args, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    };
  } catch {
    return { ok: false, value: null };
  }
}

/** The output, or null when git refuses (e.g. no such ref) — for the queries where both mean absent. */
const git = (...args) => gitTry(...args).value;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const integrity = (buf) => `sha512-${createHash('sha512').update(buf).digest('base64')}`;

/** Every object's keys sorted ascending, arrays left in order — the `package.json` canonical form. */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

/**
 * The pax keys this reader can let through: none of them changes WHICH file an entry is or WHERE its
 * content ends, so honouring them or ignoring them cannot make this reader and an installer disagree
 * about the archive's contents. `path` is handled separately (it renames, so both readings of it are
 * compared). Everything else — `size`, which moves the end of the entry and therefore the start of
 * the next one, `linkpath`, the `GNU.sparse.*` family, which reinterprets the content bytes, and any
 * key added to the format after this was written — is refused rather than guessed at.
 */
const PAX_KEYS_WITHOUT_EFFECT = new Set([
  'atime',
  'comment',
  'ctime',
  'dev',
  'gid',
  'gname',
  'ino',
  'mtime',
  'nlink',
  'uid',
  'uname',
  'SCHILY.dev',
  'SCHILY.ino',
  'SCHILY.nlink',
]);

/**
 * The records a length-framed reader takes from a pax extended-header body, as `[key, value]` pairs.
 * A pax body is a sequence of records `"<len> <key>=<value>\n"`, where `len` counts the WHOLE record
 * — its own digits, the separating space and the trailing newline included. This walks them exactly,
 * consuming `len` bytes at a time, and refuses a body that does not frame cleanly. It is how
 * libarchive reads the body.
 */
function paxRecordsByRecord(body) {
  const records = [];
  let off = 0;
  while (off < body.length) {
    let space = off;
    while (space < body.length && body[space] !== 0x20) space++;
    const digits = body.subarray(off, space).toString('latin1');
    if (space >= body.length || !/^[0-9]+$/.test(digits)) {
      throw new Error(`malformed pax record: a record must start with '<length> '`);
    }
    const len = Number.parseInt(digits, 10);
    if (len <= space - off || off + len > body.length || body[off + len - 1] !== 0x0a) {
      throw new Error(`malformed pax record: declared length ${len} does not frame a record`);
    }
    const record = body.subarray(space + 1, off + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq < 0) throw new Error(`malformed pax record: no '<key>=<value>'`);
    records.push([record.slice(0, eq), record.slice(eq + 1)]);
    off += len;
  }
  return records;
}

/**
 * The records a LINE-SCANNING reader takes from the same body — node-tar's rule, transcribed from the
 * reader an `npm i` actually runs: the body loses one trailing newline, is split on the rest, and a
 * line counts as a record when its leading decimal equals the line's own byte length plus the
 * newline it lost. A line that does not is skipped; the key is everything before the first `=`.
 */
function paxRecordsByLine(body) {
  const records = [];
  for (const line of body.toString('utf8').replace(/\n$/, '').split('\n')) {
    const declared = Number.parseInt(line, 10);
    if (declared !== Buffer.byteLength(line) + 1) continue;
    const record = line.slice(`${declared} `.length);
    const eq = record.indexOf('=');
    if (eq <= 0) continue;
    records.push([record.slice(0, eq), record.slice(eq + 1)]);
  }
  return records;
}

/**
 * A NUL-terminated string out of an archive — a header field, or the body of a GNU long-name block —
 * read only when every reader ends it in the same place.
 *
 * Tar pads its string fields with NULs, so a reader has to decide where the value stops. node-tar
 * does it with a pattern whose `.` does NOT match a newline (`decString`), so a value holding a NUL
 * and then a newline KEEPS everything after that newline; a reader that strips to the end of the
 * field drops it. Every path this reader produces comes through here — the 100-byte name, the ustar
 * prefix, a long-name block — because a name is exactly the thing that must not differ from what the
 * installer writes: splice a long-name block before an existing entry, repeat that entry's own name
 * and add a NUL and a newline, and nothing is added, removed or reordered while the installer puts
 * the file somewhere else entirely. Both readings are taken and a disagreement is REFUSED. A packer
 * writes a plain value plus NUL padding, where the two agree exactly.
 */
function headerString(bytes, field) {
  const raw = bytes.toString('utf8');
  const toNewline = raw.replace(/\0.*/, ''); // node-tar's rule: `.` stops at a newline
  const toEnd = raw.replace(/\0.*$/s, ''); // strip everything from the first NUL
  if (toNewline !== toEnd) {
    throw new Error(
      `a ${field} its readers terminate differently (${toEnd} vs ${toNewline}) — tar readers disagree on which file this is`,
    );
  }
  return toEnd;
}

/**
 * The `path` override carried by a pax extended-header body, or null when it carries none — but only
 * a body every reader agrees about, and only one whose other records change nothing this reader
 * models. Anything else is refused.
 *
 * THE RULE. A verifier's whole claim is that the bytes it hashed are the bytes a consumer installs,
 * so wherever it and an installer could name — or delimit — a file differently, the honest answer is
 * to refuse the archive rather than to pick a reading. Two ways a pax header can produce that
 * divergence, both closed here:
 *
 *   1. THE TWO PARSES DISAGREE. A record VALUE may contain a newline, and there the implementations
 *      part ways: libarchive frames records by their declared length, while node-tar — the reader
 *      behind `npm i` — splits the body into lines and keeps every line whose leading number matches
 *      its own length. Its source says so itself: "XXX Values with \n in them will fail this.
 *      Refactor to not be a naive line-by-line parse." A `path=` smuggled inside another record's
 *      value therefore renames the entry for node-tar and for nothing else. Both readings are taken
 *      and a body they name differently is refused. Splicing such a header before an existing entry
 *      is the reason this matters: nothing is added, removed or reordered, so every digest recorded
 *      here still matches while the installed files are different.
 *   2. A RECORD THIS READER DOES NOT MODEL. node-tar copies EVERY pax key onto the entry header
 *      (`lib/header.js`, `SLURP`), so a record can change more than a name: `size` moves the end of
 *      the entry, and therefore the start of the next one — an entry can be swallowed whole into its
 *      predecessor's content, so the installer receives a file list this reader never sees. Only the
 *      keys in PAX_KEYS_WITHOUT_EFFECT are let through; `path` is compared as above; every other
 *      key, present or future, is refused. Both parses are inspected, because a key the line scanner
 *      honours is exactly the one that would otherwise pass unnoticed.
 *
 * A packer emits neither shape for a package of this kind — a real long path produces one `path`
 * record, which is read normally — so nothing legitimate is turned away.
 */
function paxOverrides(body, { global }) {
  const framed = paxRecordsByRecord(body);
  const scanned = paxRecordsByLine(body);
  // A GLOBAL header applies to every following entry, which this reader does not model, so only
  // records that change nothing are tolerated there — `path` reaches its own refusal in the caller.
  const modelled = global ? ['path'] : ['path', 'size'];
  const unmodelled = [...framed, ...scanned]
    .map(([key]) => key)
    .filter((key) => !modelled.includes(key) && !PAX_KEYS_WITHOUT_EFFECT.has(key));
  if (unmodelled.length > 0) {
    throw new Error(
      `a pax ${global ? 'global ' : ''}header carries ${[...new Set(unmodelled)].sort().join(', ')} — a record that can change which files an installer writes, so this reader refuses it rather than ignore it`,
    );
  }
  const last = (records, key) => {
    let value = null;
    for (const [k, v] of records) if (k === key) value = v;
    return value;
  };
  for (const [key, noun] of [
    ['path', 'name'],
    ['size', 'size'],
  ]) {
    if (last(framed, key) !== last(scanned, key)) {
      throw new Error(
        `a pax body its records and its lines ${noun} differently (${last(framed, key) ?? `no ${key}`} vs ${last(scanned, key) ?? `no ${key}`}) — tar readers disagree on which file this is`,
      );
    }
  }
  const size = last(framed, 'size');
  if (size !== null && !/^[0-9]+$/.test(size)) {
    throw new Error(`a pax size record that is not a plain byte count: ${size}`);
  }
  return { path: last(framed, 'path'), size: size === null ? null : Number.parseInt(size, 10) };
}

/**
 * The unpacked entries of a gzipped npm tarball, as `{ path, body }` with the leading `package/`
 * removed. Deliberately FAILS CLOSED: an entry type this reader does not model (a symlink, a hard
 * link, a device node), a header whose checksum does not add up, or a path outside `package/` (a
 * `..` segment included) throws rather than being skipped — a verifier that silently ignores part of
 * an archive verifies nothing. The types npm actually emits are regular files; directories, GNU long
 * names and pax `path=` overrides are handled because the format permits them.
 *
 * The refusals below exist because tar is more permissive than a verifier may be, and the gap
 * between this reader and tar is exactly where a tampered artifact hides. The aim is a reader that
 * agrees with node-tar (what `npm i` runs) and libarchive on WHICH file each entry is and WHERE it
 * ends, then refuses the rest rather than guessing:
 *   - A PATH THAT OCCURS TWICE. Extraction keeps the LAST entry at a path, so a reader that returns
 *     both — or that stops at the first — hashes something no consumer receives. No packer emits a
 *     duplicate path, so refusing costs nothing and closes the general form of that substitution.
 *   - CONTENT PAST THE END-OF-ARCHIVE MARKER. The marker is two zero blocks, but `tar` and node-tar
 *     (what `npm i` runs) treat a LONE zero block as a warning and keep reading, so bytes appended
 *     after one are installed. Everything from the marker to the end of the archive must be zero,
 *     and an archive that simply runs out before a marker is refused too.
 *   - A PAX `path=` OVERRIDE THE READERS DO NOT AGREE ON. An entry's name can be overridden by a GNU
 *     long-name (`L`) block or a pax extended header (`x`), and this reader applies both — but only
 *     where every consumer would apply the same one. A GLOBAL pax header (`g`) carrying `path=` is
 *     refused outright: node-tar and libarchive DELIBERATELY ignore `path` from a global header (it
 *     renames nothing), so honouring it would make this reader name an entry differently from every
 *     consumer — and the excluded manifest path is precisely where that disagreement would hide. A
 *     local (`x`) body is read BOTH ways — framed by record length, as libarchive does, and scanned
 *     line by line, as node-tar does — and refused when the two name different files. A `path=`
 *     smuggled inside another record's value is exactly that case: node-tar honours it, libarchive
 *     does not, and no digest here would move, so the refusal is the only honest answer.
 *   - A PAX RECORD THIS READER DOES NOT MODEL. node-tar copies EVERY pax key onto the entry header,
 *     so a header does more than rename: `size` moves the end of the entry and therefore the start
 *     of the next one, and an entry can be swallowed whole into its predecessor's content. `size` is
 *     therefore APPLIED here, the way both readers apply it — ignoring it would mean hashing an
 *     entry no installer writes. Every other key that could reach that far is refused instead (see
 *     paxOverrides): a `linkpath`, a `GNU.sparse.*`, anything the format gains later. A `size` that
 *     precedes another HEADER is refused outright: node-tar clears its pending pax state only on the
 *     non-meta branch, so the record sizes that header's body for the installer and not for a reader
 *     that frames it by its own field, and the two would part company for the rest of the archive.
 *   - A DIRECTORY THAT DECLARES A BODY. tar gives a directory no content, and node-tar enforces it
 *     by zeroing the size — so bytes behind such a header are the NEXT ENTRIES to an installer, and
 *     it writes them. A reader that believed the declared size would swallow them as opaque content
 *     and record nothing at all: the file list would be unchanged, every digest would still match,
 *     and the package's own files would be whatever the hidden entries say. That is the one shape in
 *     this file that substitutes CONTENT rather than misplacing it, and the launcher — pinned by the
 *     file list alone — is exactly the package it defeats. node-tar also reclassifies a regular entry
 *     whose name ends in '/' as a directory, so that costume is refused too.
 *   - A PREFIX FIELD WITHOUT THE USTAR MAGIC. A ustar header may split a long path across `name` and
 *     `prefix`, but node-tar reads `prefix` only under the exact `ustar\0` + `00` magic; under GNU's
 *     `ustar  \0` it takes `name` alone. Reading it unconditionally is the cheapest tamper of the
 *     set — ONE header rewritten in place, the path split across the two fields, GNU magic, checksum
 *     fixed: nothing added, removed or reordered, every digest byte-identical, and the installer puts
 *     the file somewhere else. The field is read the way node-tar reads it, and a non-empty prefix
 *     under any other magic is refused, because a POSIX reader would honour what node-tar ignores.
 *   - A STRING FIELD THE READERS TERMINATE DIFFERENTLY. Every name here — the 100-byte field, the
 *     prefix, a GNU long-name block's body — is NUL-terminated, and node-tar's terminator stops at a
 *     newline — a value carrying a NUL and then a newline keeps everything after it, where a
 *     strip-to-end terminator drops it (see headerString). Splice such a block before an
 *     entry, repeating that entry's own name, and a reader that drops the tail names the entry
 *     exactly as recorded while the installer writes it somewhere else entirely. Both readings are
 *     taken and a disagreement is refused, as for a pax `path`.
 * The messages carry no file name: the single caller knows which tarball it handed over and says so.
 */
function unpack(gzipped) {
  const buf = gunzipSync(gzipped);
  const entries = [];
  const seen = new Set();
  let override = null;
  let sizeOverride = null;
  let off = 0;
  let ended = false;
  while (off + 512 <= buf.length) {
    const head = buf.subarray(off, off + 512);
    if (head.every((b) => b === 0)) {
      const tail = buf.subarray(off);
      if (tail.length < 1024) {
        throw new Error(
          `the end-of-archive marker is ${tail.length} byte(s), not the two 512-byte zero blocks the format requires`,
        );
      }
      if (!tail.every((b) => b === 0)) {
        throw new Error(
          `content after the end-of-archive marker — tar and npm would read past it, so this reader refuses the archive`,
        );
      }
      ended = true;
      break;
    }
    const text = (from, to) => headerString(head.subarray(from, to), 'header field');
    const octal = (from, to) => {
      const raw = text(from, to).trim();
      if (!/^[0-7]*$/.test(raw)) throw new Error(`unsupported numeric header field`);
      return raw === '' ? 0 : Number.parseInt(raw, 8);
    };
    /**
     * This entry's name. THE PREFIX FIELD IS GATED ON THE MAGIC: a ustar header may split a long
     * path across `name` and `prefix`, but node-tar reads `prefix` only when bytes 257-264 are
     * exactly `ustar\0` + `00` (`header.js`) — under GNU's `ustar  \0` it takes `name` alone.
     * Reading the field unconditionally would let ONE in-place header edit — the real path split
     * across the two fields, GNU magic, checksum fixed — name the entry exactly as recorded here
     * while the installer writes it somewhere else, with nothing added, removed or reordered and
     * every digest byte-identical. A non-empty prefix under any other magic is refused outright:
     * a POSIX reader would honour what node-tar ignores, and this reader picks neither. A prefix
     * that itself ends in '/' and an empty name are refused for the same reason — the join and the
     * emptiness are normalised differently on the way to disk.
     *
     * THE TWO PREFIX BRANCHES ARE ASYMMETRIC, and the asymmetry is load-bearing. node-tar reads 155
     * bytes and prepends `prefix + '/'` UNCONDITIONALLY when byte 475 is non-zero, and 130 bytes
     * prepended only when non-empty otherwise. Collapsing that to only-when-non-empty in both
     * branches is a hole: zero the whole prefix field and set byte 475, and node-tar produces an
     * ABSOLUTE path whose empty leading component an installer's strip consumes — the file lands a
     * level deeper while this reader names it exactly as recorded, every digest unchanged. So the
     * branch is mirrored rather than simplified, and the bare '/' it produces then fails the
     * `package/` rule below, which is the point.
     */
    const entryName = () => {
      const ustarMagic = head.subarray(257, 265).toString('binary') === 'ustar\u000000';
      if (!ustarMagic && text(345, 500) !== '') {
        throw new Error(
          `a header carries a prefix field without the ustar magic — tar readers disagree on whether it names part of the path`,
        );
      }
      const widePrefix = ustarMagic && head[475] !== 0;
      const prefix = text(345, widePrefix ? 500 : 475);
      if (prefix.endsWith('/')) {
        throw new Error(
          `a prefix field ending in '/' — tar readers join it to the name differently`,
        );
      }
      // AN EMPTY NAME FIELD IS REFUSED, because the two readers classify it differently. node-tar
      // decides file-vs-directory from the NAME FIELD before the prefix is joined (`header.js`), so
      // an empty field stays a FILE and the joined path keeps a trailing slash that extraction then
      // strips — it writes a 0-byte file at the prefix's path. A reader that classifies from the
      // JOINED name sees a directory, skips it, and records nothing: aim the prefix at a file the
      // package really ships and the certified artifact installs with that file emptied, with every
      // digest unchanged. Measured on the launcher: `dist/bin.js` 893 bytes to 0, no tar warning.
      // No packer emits a nameless entry, so refusing costs nothing.
      if (override === null && text(0, 100) === '') {
        throw new Error(
          `an entry whose name field is empty — tar readers disagree on whether its prefix alone names a file or a directory`,
        );
      }
      const resolved =
        override ?? (widePrefix || prefix ? `${prefix}/${text(0, 100)}` : text(0, 100));
      if (resolved === '') throw new Error(`an entry with an empty name`);
      return resolved;
    };
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : head[i];
    if (sum !== octal(148, 156)) throw new Error(`tar header checksum mismatch`);
    const type = String.fromCharCode(head[156]) || '0';
    const meta = type === 'x' || type === 'g' || type === 'L';
    // THE NAME IS RESOLVED BEFORE ANY BODY IS CONSUMED, because the name decides whether there IS a
    // body: node-tar reclassifies a regular entry whose name ends in '/' as a directory, and a
    // directory's size is forced to ZERO (`header.js`) — the bytes that follow are parsed as the
    // next entries, not as content. A reader that consumed a declared directory body would swallow
    // whole entries the installer writes, WITHOUT changing anything it records: that is a forged
    // package the file-list digest cannot see. Refused below rather than modelled.
    const name = meta ? null : entryName();
    const declared = octal(124, 136);
    const directory =
      !meta && (type === '5' || ((type === '0' || type === '\0') && name.endsWith('/')));
    if (directory && (declared !== 0 || sizeOverride !== null)) {
      throw new Error(
        `a directory entry declares ${sizeOverride ?? declared} byte(s) of content — tar gives a directory no body, so those bytes are the next entries to an installer and content to this reader`,
      );
    }
    // A pax `size` record replaces the header's own byte count — for node-tar (it copies every pax
    // key onto the header) and for libarchive alike, so it moves both the end of this entry and the
    // start of the next one. It applies to the entry that FOLLOWS the header, never to the header
    // block itself, which is framed by its own field.
    const size = meta ? declared : (sizeOverride ?? declared);
    if (off + 512 + size > buf.length) {
      throw new Error(`an entry declares ${size} byte(s) of content the archive does not contain`);
    }
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;

    if (meta) {
      // A pax `size` sizes the body of the entry that follows — and node-tar lets it size a
      // following HEADER too: it clears its pending pax state only on the non-meta branch, while
      // the header decoder takes `size` from that state unconditionally. A reader that framed the
      // header by its own field would part company with the installer from here to the end of the
      // archive. No packer emits that, so it is refused rather than modelled.
      if (sizeOverride !== null) {
        throw new Error(
          `a pax size record precedes another header — tar readers do not agree on which body it sizes`,
        );
      }
      if (type === 'L') {
        // A GNU long-name block: its body is the next entry's name, NUL-terminated.
        override = headerString(body, 'long-name block');
      } else {
        // Refuses a body that is not well-formed pax records, one the two parses read differently,
        // and one carrying a record this reader does not model.
        const pax = paxOverrides(body, { global: type === 'g' });
        if (type === 'g') {
          // A global header renames nothing for node-tar or libarchive, and no packer emits one that
          // tries: refuse a global `path=` rather than apply a rename no consumer will see.
          if (pax.path !== null) {
            throw new Error(
              `a pax global header carries path= — no packer emits one and tar ignores it`,
            );
          }
        } else {
          if (pax.path !== null) override = pax.path; // overrides the next entry's name, as tar does
          if (pax.size !== null) sizeOverride = pax.size;
        }
      }
      continue;
    }
    override = null;
    sizeOverride = null;
    // Every entry is held to the path rules, including the directories skipped just below: a reader
    // that scrutinised only the entries it hashes would leave one entry type unexamined, and a
    // verifier's refusals are worth what its least-examined path is worth. `pnpm pack` emits no
    // directory entries at all (measured: 0 of 1423 across the packed closure), so this costs
    // nothing legitimate.
    if (!name.startsWith('package/')) throw new Error(`entry outside package/: ${name}`);
    if (name.split('/').includes('..')) throw new Error(`entry escapes package/: ${name}`);
    if (directory) continue; // a directory carries no content of its own
    if (type !== '0' && type !== '\0') {
      throw new Error(`unsupported tar entry type '${type}' at ${name}`);
    }
    const path = name.slice('package/'.length);
    if (seen.has(path)) throw new Error(`duplicate entry path: ${name}`);
    seen.add(path);
    entries.push({ path, body: Buffer.from(body) });
  }
  if (!ended) throw new Error(`the archive ends without an end-of-archive marker`);
  return entries;
}

/** `{ count, digest }` over the entries, minus `excluded`, per `algorithms.file_list_digest`. */
function fileListDigest(entries, excluded) {
  const skip = new Set(excluded);
  const lines = [];
  for (const entry of entries) {
    if (skip.has(entry.path)) continue;
    let bytes = entry.body;
    if (entry.path === 'package.json') {
      bytes = Buffer.from(
        `${JSON.stringify(sortKeysDeep(JSON.parse(entry.body.toString('utf8'))), null, 2)}\n`,
      );
    }
    lines.push(Buffer.from(`${entry.path} ${sha256(bytes)}\n`));
  }
  lines.sort(Buffer.compare);
  return { count: lines.length, digest: sha256(Buffer.concat(lines)) };
}

/** Every `*.tgz` in `dir`, read and unpacked, keyed by the name its own packed manifest declares. */
function loadTarballs(dir) {
  if (!existsSync(dir)) refuse(`--tarballs ${dir} does not exist.`);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.tgz'))
    .sort();
  if (files.length === 0) refuse(`--tarballs ${dir} holds no .tgz file. Pack the release first.`);
  const members = [];
  for (const file of files) {
    const bytes = readFileSync(join(dir, file));
    let entries;
    try {
      entries = unpack(bytes);
    } catch (err) {
      refuse(`${file}: ${err?.message ?? err}`);
    }
    const manifestEntry = entries.find((e) => e.path === 'package.json');
    if (!manifestEntry) refuse(`${file}: the tarball carries no package/package.json.`);
    let json;
    try {
      json = JSON.parse(manifestEntry.body.toString('utf8'));
    } catch (err) {
      // The documented exit code for a bad input is 2; an uncaught SyntaxError would exit 1 with a
      // stack trace instead.
      refuse(`${file}: its packed package.json does not parse: ${err.message}`);
    }
    const already = members.find((m) => m.name === json.name);
    if (already) {
      // A directory holding two tarballs for one package (a stray copy, a re-pack left behind) makes
      // the closure ambiguous: generate would record the package twice and verify keys by name, so
      // one of the two silently decides the result. Which one is not something to leave to readdir.
      refuse(
        `${file} and ${already.file} both declare ${json.name} — the release directory must hold one tarball per package.`,
      );
    }
    members.push({
      file,
      bytes,
      entries,
      name: json.name,
      version: json.version,
      deps: Object.keys(json.dependencies ?? {}).filter((d) => d.startsWith('@rayspec/')),
    });
  }
  // Byte order, not `localeCompare`: the DETERMINISM claim above is that the same inputs give the
  // same bytes anywhere, and collation is locale- and ICU-build-dependent.
  return members.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The directory must BE the launcher's runtime closure: the launcher present, every member at the
 * release version, every internal production dependency of a member also a member, and no member
 * the launcher cannot reach. A manifest over a set that is not closed describes most of a release,
 * which is worse than describing none of it.
 */
function assertClosure(members, launcherName, version) {
  const byName = new Map(members.map((m) => [m.name, m]));
  if (!byName.has(launcherName)) {
    refuse(
      `the launcher package '${launcherName}' has no tarball in this directory, so the closure it ` +
        'roots cannot be identified. Pack the release with `node scripts/publish.mjs --pack`.',
    );
  }
  const drift = members.filter((m) => m.version !== version);
  if (drift.length) {
    refuse(
      `the release version is ${version} (from ${VERSION_SOURCE}), but ${drift.length} tarball(s) ` +
        'carry another version:',
      ...drift.map((m) => `  ${m.file} — ${m.name} at ${m.version}`),
    );
  }
  const reached = new Set();
  const missing = new Map();
  const stack = [launcherName];
  while (stack.length) {
    const name = stack.pop();
    if (reached.has(name)) continue;
    reached.add(name);
    for (const dep of byName.get(name)?.deps ?? []) {
      if (byName.has(dep)) stack.push(dep);
      else missing.set(dep, [...(missing.get(dep) ?? []), name]);
    }
  }
  if (missing.size) {
    refuse(
      `the tarball directory is not a closure — ${missing.size} package(s) are depended on but not ` +
        'packed:',
      ...[...missing]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([dep, by]) => `  ${dep} — required by ${by.sort().join(', ')}`),
    );
  }
  const unreachable = members.filter((m) => !reached.has(m.name));
  if (unreachable.length) {
    refuse(
      `${unreachable.length} tarball(s) are not part of the runtime closure of '${launcherName}', ` +
        'so this manifest cannot claim them:',
      ...unreachable.map((m) => `  ${m.file} — ${m.name}`),
    );
  }
}

/** The release tag as git sees it — `absent` | `lightweight` | `other-commit` | `at-head`. */
function tagIdentity(version, head) {
  const name = `v${version}`;
  const ref = git('rev-parse', '--verify', '--quiet', `refs/tags/${name}`);
  if (!ref) {
    return {
      name,
      state: 'absent',
      commit: null,
      note: `no ref refs/tags/${name} in this checkout — the manifest was generated before the release tag was created.`,
    };
  }
  const commit = git('rev-list', '-n', '1', `refs/tags/${name}`);
  if (git('cat-file', '-t', ref) !== 'tag') {
    return {
      name,
      state: 'lightweight',
      commit,
      note: `${name} is a lightweight tag, not an annotated release tag.`,
    };
  }
  if (commit !== head) {
    return {
      name,
      state: 'other-commit',
      commit,
      note: `annotated ${name} points at ${commit}, not at source.commit.`,
    };
  }
  return { name, state: 'at-head', commit, note: null };
}

/**
 * The build workflow run, from the GitHub Actions environment. There is no release workflow in this
 * repository — a release is human-invoked — so outside Actions this is an explicit null naming the
 * reason, never a value that looks like a run and is not one.
 */
function workflowRun(env) {
  if (env.GITHUB_ACTIONS !== 'true') {
    return {
      value: null,
      reason: 'no-github-actions-environment',
      note:
        'generated outside GitHub Actions. This repository has no release workflow by design: the ' +
        'release path is the human-invoked scripts/publish.mjs.',
    };
  }
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  const repository = env.GITHUB_REPOSITORY ?? null;
  const runId = env.GITHUB_RUN_ID ?? null;
  const attempt = env.GITHUB_RUN_ATTEMPT ?? null;
  return {
    value: {
      repository,
      workflow: env.GITHUB_WORKFLOW ?? null,
      run_id: runId,
      run_attempt: attempt,
      url:
        repository && runId && attempt
          ? `${server}/${repository}/actions/runs/${runId}/attempts/${attempt}`
          : null,
    },
    reason: null,
  };
}

/** Digest a checked-in file, refusing if it is absent — a missing digest is not a manifest. */
function sourceDigest(rel) {
  const path = join(REPO_ROOT, rel);
  if (!existsSync(path)) refuse(`${rel} is missing — the manifest cannot record a digest for it.`);
  return sha256(readFileSync(path));
}

/** The repo-root facts the manifest carries, refusing when the one authoritative manifest is short. */
function readRoot() {
  const json = JSON.parse(readFileSync(join(REPO_ROOT, VERSION_SOURCE), 'utf8'));
  for (const key of ['version', 'packageManager']) {
    if (typeof json[key] !== 'string' || json[key] === '') {
      refuse(`${VERSION_SOURCE} carries no "${key}" — the manifest records it.`);
    }
  }
  if (typeof json.engines?.node !== 'string' || json.engines.node === '') {
    refuse(`${VERSION_SOURCE} carries no "engines.node" — the manifest records it.`);
  }
  return { version: json.version, node: json.engines.node, packageManager: json.packageManager };
}

/**
 * The working tree as the release sees it: TRACKED files that differ from HEAD (see the docblock).
 * `clean` is null when git could not answer — the one value this must never guess, because the
 * favourable guess (`true`) is indistinguishable from a clean tree and is the claim a reader trusts.
 */
function worktreeState() {
  const res = gitTry('diff', '--name-only', 'HEAD');
  if (!res.ok) return { clean: null, paths: [], error: '`git diff --name-only HEAD` failed' };
  const paths = res.value.split('\n').filter(Boolean).sort();
  return { clean: paths.length === 0, paths, error: null };
}

/** Deterministic serialisation: insertion order, 2-space indent, one trailing newline. */
const serialise = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`;

function buildManifest(members, launcherName, root, env) {
  const head = git('rev-parse', 'HEAD');
  if (!head) refuse('cannot read HEAD — the manifest records the source commit.');
  const tree = worktreeState();
  if (tree.clean === null) {
    refuse(
      `cannot read the working tree state — ${tree.error}. The manifest records whether the tree ` +
        'was clean at source.commit, and a failed command is not a clean tree.',
    );
  }
  return {
    schema: SCHEMA_ID,
    generated_by: 'scripts/release-identity.mjs',
    reproduce: `node scripts/release-identity.mjs --verify --tarballs <dir> --manifest ${MANIFEST_NAME}`,
    scope_note: SCOPE_NOTE,
    algorithms: ALGORITHMS,
    version: root.version,
    source: {
      commit: head,
      worktree_clean: tree.clean,
      dirty_paths: tree.paths,
      tag: tagIdentity(root.version, head),
    },
    workflow_run: workflowRun(env),
    runtime: { node: root.node, package_manager: root.packageManager },
    signature: {
      value: null,
      reason: 'unsigned',
      note:
        'this manifest is not signed. Its authenticity rests on the GitHub release it is attached ' +
        'to and on the commit it names; verify the closure with `--verify` against the tarballs.',
    },
    closure: members.map((m) => {
      const isLauncher = m.name === launcherName;
      const excluded = isLauncher ? [MANIFEST_NAME] : [];
      const files = fileListDigest(m.entries, excluded);
      return {
        name: m.name,
        version: m.version,
        tarball: isLauncher
          ? {
              file: m.file,
              bytes: null,
              integrity: null,
              reason: 'ships-this-manifest',
              note:
                `${MANIFEST_NAME} is published inside this tarball, so a tarball integrity recorded ` +
                'here could never match the tarball that ships. The invariant recorded instead is ' +
                'files.list_digest over every entry except files.excluded.',
            }
          : { file: m.file, bytes: m.bytes.length, integrity: integrity(m.bytes) },
        files: { count: files.count, list_digest: files.digest, excluded },
      };
    }),
    schemas: SCHEMAS.map((s) => ({
      path: s.path,
      profile: s.profile,
      sha256: sourceDigest(s.path),
    })),
    lockfile: { path: LOCKFILE, sha256: sourceDigest(LOCKFILE) },
    dependency_sbom: { path: DEPENDENCY_SBOM, sha256: sourceDigest(DEPENDENCY_SBOM) },
  };
}

function launcherName() {
  const path = join(REPO_ROOT, LAUNCHER_DIR, 'package.json');
  if (!existsSync(path)) refuse(`${LAUNCHER_DIR}/package.json is missing — it roots the closure.`);
  const name = JSON.parse(readFileSync(path, 'utf8')).name;
  if (typeof name !== 'string' || name === '')
    refuse(`${LAUNCHER_DIR}/package.json declares no name.`);
  return name;
}

function generate(flags) {
  const root = readRoot();
  const launcher = launcherName();
  const members = loadTarballs(resolve(flags.tarballs));
  assertClosure(members, launcher, root.version);
  const manifest = buildManifest(members, launcher, root, process.env);
  const out = resolve(flags.out ?? join(REPO_ROOT, LAUNCHER_DIR, MANIFEST_NAME));
  const bytes = serialise(manifest);
  // The launcher is packed from a directory that a PREVIOUS release run may have left a manifest in
  // (it is gitignored, and the launcher's `files` ships it). Packing is not byte-reproducible, so a
  // manifest generated now can never equal that one: the release would be unverifiable from the
  // moment it was packed. Refuse before writing anything, and name the step that was skipped.
  const carried = members
    .find((m) => m.name === launcher)
    ?.entries.find((e) => e.path === MANIFEST_NAME);
  if (carried && !carried.body.equals(Buffer.from(bytes))) {
    refuse(
      `the launcher tarball carries a ${MANIFEST_NAME} that is not the one this run would write, so ` +
        'the tarballs could never verify against it. The pack picked up the manifest a previous ' +
        `release run left in ${LAUNCHER_DIR}/. Nothing was written — remove ` +
        `${LAUNCHER_DIR}/${MANIFEST_NAME}, re-pack the release, then generate again.`,
    );
  }
  writeFileSync(out, bytes);
  if (flags.json) {
    process.stdout.write(bytes);
    return;
  }
  console.log(`release identity ${manifest.version} @ ${manifest.source.commit}`);
  console.log(
    `  ${manifest.closure.length} package(s), tag ${manifest.source.tag.name}: ${manifest.source.tag.state}` +
      `, workflow run: ${manifest.workflow_run.value ? manifest.workflow_run.value.url : `none (${manifest.workflow_run.reason})`}`,
  );
  if (!manifest.source.worktree_clean) {
    console.log(`  working tree DIRTY: ${manifest.source.dirty_paths.join(', ')}`);
  }
  console.log(`written → ${relative(REPO_ROOT, out) || out}`);
}

/**
 * Check a manifest against a directory of tarballs, and against this checkout when it is the one
 * the manifest names. Every member is checked and every failure is reported, so one run names the
 * whole divergence instead of the first symptom of it.
 */
function verify(flags) {
  const manifestPath = resolve(flags.manifest ?? join(REPO_ROOT, LAUNCHER_DIR, MANIFEST_NAME));
  if (!existsSync(manifestPath)) refuse(`--manifest ${manifestPath} does not exist.`);
  const manifestBytes = readFileSync(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (err) {
    refuse(`${manifestPath} is not JSON (${err?.message ?? err}).`);
  }
  if (manifest.schema !== SCHEMA_ID) {
    refuse(`${manifestPath} declares schema '${manifest.schema}', not '${SCHEMA_ID}'.`);
  }

  const members = new Map(loadTarballs(resolve(flags.tarballs)).map((m) => [m.name, m]));
  const failures = [];
  const checked = [];
  for (const entry of manifest.closure) {
    const fail = (line) => failures.push(`${entry.name}: ${line}`);
    const member = members.get(entry.name);
    if (!member) {
      fail(`no tarball in the directory carries this package (expected ${entry.tarball.file}).`);
      continue;
    }
    if (member.version !== entry.version) {
      fail(`the tarball is at ${member.version}, the manifest records ${entry.version}.`);
    }
    if (entry.tarball.integrity === null) {
      // The launcher — it ships this manifest, so only the content invariant can be checked. See
      // the SELF-REFERENCE section of the docblock. There is at most ONE entry at this path:
      // `unpack` refuses an archive that carries a path twice, which is what makes comparing a
      // single occurrence the same thing as comparing what a consumer extracts.
      const shipped = member.entries.find((e) => e.path === MANIFEST_NAME);
      if (shipped && !shipped.body.equals(manifestBytes)) {
        fail(
          `the tarball carries a DIFFERENT ${MANIFEST_NAME} than the one being verified — the ` +
            'excluded entry is checked, not trusted.',
        );
      }
      checked.push({ name: entry.name, carries: Boolean(shipped) });
    } else {
      const actual = integrity(member.bytes);
      if (actual !== entry.tarball.integrity) {
        fail(
          `tarball integrity mismatch\n    recorded: ${entry.tarball.integrity}\n    actual:   ${actual}`,
        );
      }
      if (entry.tarball.bytes !== null && member.bytes.length !== entry.tarball.bytes) {
        fail(
          `tarball size mismatch: recorded ${entry.tarball.bytes}, actual ${member.bytes.length}.`,
        );
      }
      checked.push({ name: entry.name, carries: null });
    }
    const files = fileListDigest(member.entries, entry.files.excluded ?? []);
    if (files.digest !== entry.files.list_digest) {
      fail(
        `unpacked file-list digest mismatch (${files.count} entries counted, ` +
          `${entry.files.count} recorded)\n    recorded: ${entry.files.list_digest}\n    actual:   ${files.digest}`,
      );
    } else if (files.count !== entry.files.count) {
      fail(`file count mismatch: recorded ${entry.files.count}, actual ${files.count}.`);
    }
  }
  const extra = [...members.keys()].filter((n) => !manifest.closure.some((e) => e.name === n));
  for (const name of extra.sort()) {
    failures.push(`${name}: a tarball in the directory that the manifest does not record.`);
  }

  // The source side is comparable only against the checkout the manifest names — a verifier run
  // from another commit reports that instead of failing on a difference it cannot interpret.
  const head = git('rev-parse', 'HEAD');
  const tree = worktreeState();
  const comparable = head === manifest.source.commit && tree.clean === true;
  const sourceEntries = [...(manifest.schemas ?? []), manifest.lockfile, manifest.dependency_sbom];
  let sourceNote =
    tree.clean === null
      ? `not compared: the working tree state is unknown (${tree.error})`
      : `not compared: this checkout is ${head ?? 'unknown'}${tree.clean ? '' : ' (dirty)'}, the manifest records ${manifest.source.commit}`;
  if (comparable) {
    for (const artifact of sourceEntries) {
      if (!artifact) continue;
      const path = join(REPO_ROOT, artifact.path);
      if (!existsSync(path)) {
        failures.push(`${artifact.path}: recorded in the manifest but absent from this checkout.`);
        continue;
      }
      const actual = sha256(readFileSync(path));
      if (actual !== artifact.sha256) {
        failures.push(
          `${artifact.path}: digest mismatch\n    recorded: ${artifact.sha256}\n    actual:   ${actual}`,
        );
      }
    }
    const root = readRoot();
    if (root.version !== manifest.version) {
      failures.push(
        `${VERSION_SOURCE}: version ${root.version}, the manifest records ${manifest.version}.`,
      );
    }
    if (
      root.node !== manifest.runtime?.node ||
      root.packageManager !== manifest.runtime?.package_manager
    ) {
      failures.push(
        `${VERSION_SOURCE}: runtime requirements ${root.node} / ${root.packageManager} do not match ` +
          `the recorded ${manifest.runtime?.node} / ${manifest.runtime?.package_manager}.`,
      );
    }
    sourceNote = `compared against this checkout at ${head}: ${sourceEntries.filter(Boolean).length} artifact(s)`;
  }

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          manifest: relative(REPO_ROOT, manifestPath) || manifestPath,
          version: manifest.version,
          commit: manifest.source.commit,
          packages: manifest.closure.length,
          source_compared: comparable,
          ok: failures.length === 0,
          failures,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`release identity ${manifest.version} @ ${manifest.source.commit}`);
    for (const c of checked) {
      const suffix =
        c.carries === null
          ? ''
          : c.carries
            ? ` — the tarball carries this ${MANIFEST_NAME}`
            : ` — this tarball does not carry ${MANIFEST_NAME} yet (packed before the manifest)`;
      console.log(`  checked ${c.name}${suffix}`);
    }
    console.log(`  source: ${sourceNote}`);
  }
  if (failures.length) {
    console.error(
      `release identity VERIFICATION FAILED — ${failures.length} problem(s):\n` +
        failures.map((f) => `  ${f}`).join('\n'),
    );
    process.exit(1);
  }
  if (!flags.json) {
    console.log(`verified: ${manifest.closure.length} package(s), 0 failure(s).`);
  }
}

function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.verify) verify(flags);
  else generate(flags);
}

main();
