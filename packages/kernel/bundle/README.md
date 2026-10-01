# @rayspec/bundle

The one reader and writer of RaySpec application bundles (`.ray`). The CLI reads and writes
bundles through it, and a hosting service imports the same package, so every consumer accepts and
refuses exactly the same archives. The format itself — the manifest schema, the canonical JSON
form, the limits and the closed error vocabulary — lives in
[`@rayspec/bundle-contract`](../bundle-contract); this package is the only other thing it depends
on, apart from Node's own modules.

## Reading

- `inspectBundle(archive, options?)` — `archive` is a file path or bytes. Runs the structural
  checks of the reader pipeline in the contract's order and stops at the first failure: the
  archive limit of the operation, the end record, every central record, the name set, the layout
  and each local header, the manifest bytes, schema, kind limit and semantics, and finally every
  entry streamed against the inventory (size, cumulative extracted bytes, CRC-32, SHA-256).
  Writes nothing anywhere.
- `extractBundle(archive, destination, options?)` — the same checks, copying each entry into
  `destination` as it streams. The directory must not exist and its parent must; it is created
  with mode 0700 once the manifest has passed, files are created exclusively with mode 0600
  without following links, and nothing is overwritten. Before a file is opened, and again once it
  is open, the real path of its directory must be the one it has under the root and the path must
  lead to the opened file, so a directory swapped for a link while extraction runs is refused
  (`RAY_INTERNAL`) before a byte is written. On any failure the directory is removed.

A path that is not a regular file (a directory, a device, a FIFO) is `RAY_USAGE`; it is opened
without blocking, so a FIFO with no writer is answered at once.

Both return `{ ok: true, value }` or `{ ok: false, errors }`, where `errors[0]` carries a code and
reason from the contract vocabulary. Hostile input never throws, and a message never repeats a
name or any other content from the archive. The value holds the validated manifest, the archive's
identity (`archiveSha256`, the SHA-256 of its complete bytes, computed on the same pass),
`secretFindings` (paths only), the number of entries (`entryCount`, `ray.json` included) and
whether a `<file>.sig` lies next to the archive.

Neither entry point imports, evaluates or executes anything from an archive: they read bytes,
compare them and copy them. The ZIP parsing is written here on top of Node's built-ins, because
the contract's strict profile (stored entries only, fixed header values, no ZIP64, extra fields,
comments or data descriptors, contiguous layout) is small, and a general-purpose ZIP library
accepts forms the contract refuses.

Options:

- `limits` — any of the contract's reader limits, lowered from the defaults; a raised limit is
  `RAY_USAGE`.
- `operation` — `inspect` (default), `verify`, `deploy`, `prepare` or `import`. It picks the
  archive limit that applies before the kind is known: the larger of the two kind limits for
  `inspect` and `verify`, the application limit for `deploy` and `prepare`, the migration limit
  for `import`.
- `timeBudgetMs` — the wall-time budget, at most `DEFAULT_TIME_BUDGET_MS` (five minutes),
  started before the archive is opened. It is checked before each read, between the steps of the
  name-set checks and before each local header and entry; no step between two checks grows faster
  than the number of names times its logarithm, so the budget also caps CPU time, overshooting it
  by at most one such step. Exceeding it is `RAY_LIMIT_EXCEEDED` `time-budget`.
- `captureSpec` — keep the bytes of the spec file the manifest names, once they have matched
  their inventory size and SHA-256, as `specBytes`, so a caller can parse the spec without
  extracting the archive. Application bundles only; the bytes are bounded by the extracted byte
  limit like every other entry.
- `refuseLinks` — refuse an archive path whose last component is a symbolic link
  (`RAY_USAGE`) instead of following it. The file is opened with `O_NOFOLLOW`, so a link swapped
  in after an earlier check is refused too. A runtime reading a path another process placed sets
  it; off by default.
- `clock` — the monotonic clock the budget is measured with.

Each read stays inside the size taken when the archive was opened. The central directory is read
again at the end of the pass and compared with its first reading, and the file size is checked,
so an archive changed while it is read is refused; a byte changed after the reader has consumed it
cannot be seen, so a caller that needs the identity to describe the file on disk afterwards reads
from a private copy.

Inspection covers what `rayspec bundle inspect` reports. `verify`, `deploy` and `prepare` go on
with `checkRuntimeAdmission` from the contract package, the spec checks (which need the spec
parser), the secret findings (`RAY_SECRET_DETECTED`) and the signature.

## Writing

`writeBundle(destination, { manifest, files }, options?)` takes a manifest without its inventory
and a list of prepared files (`{ path, bytes }` or `{ path, file }`, a regular file that is never
followed through a link). It computes the inventory, validates the manifest with the contract
validator, and writes entries sorted by name in the strict profile with the canonical manifest
last. The same manifest and file bytes give the same archive bytes wherever and whenever they are
written: no timestamp, path or attribute of the host reaches the archive.

The archive is written to a temporary file beside the destination, read back through the reader,
and then moved into place: linked, which fails if the destination exists, or renamed over it with
`overwrite: true`. A bundle over the kind's archive limit is refused before anything is written
(`archive-size`, or `migration-size` for a migration bundle), and so are payload files that add up
to more than the kind's extracted byte limit (`extracted-size`). A limit the read-back reaches is
reported as that limit; any other refusal of the read-back is `RAY_INTERNAL`. `fileMode` sets the
mode the archive is created with (default 0644); a migration bundle is written with 0600.

## The inner snapshot archive

A migration bundle encrypts one plaintext archive in the same strict profile, rooted at
`snapshot.json` instead of `ray.json`, with the fixed inventory of the snapshot contract
(`payload/application.ray`, `payload/database.dump`, `payload/workflow-system.dump` when that
database exists, `payload/object-index.json`, `payload/objects.bin`) and the migration limits.

- `writeSnapshotArchive(destination, { snapshot, files }, options?)` — takes `snapshot.json`
  without its inventory and the payload files, computes the inventory, validates the document,
  and refuses a snapshot above the migration extracted byte limit before writing
  (`RAY_LIMIT_EXCEEDED` `migration-size`). The archive is written with mode 0600, read back
  through `inspectSnapshotArchive` and linked into place; the destination must not exist
  (`RAY_OUTPUT_EXISTS`). The same input gives the same bytes.
- `inspectSnapshotArchive(archive, options?)` — the container checks with `snapshot.json` as the
  root, then `snapshot.json` (size `snapshot-size`, canonical form, schema, inventory order), the
  archive against the inventory, every entry streamed (size, cumulative bytes, CRC-32, SHA-256),
  `applicationDigest` against `payload/application.ray` (`application-digest`), the object index
  with its ranges covering `objects.bin` exactly (`object-range`), `objectCount`, and each
  object's stored range and logical bytes against the index and the stored blob header
  (`object-sha256`). It writes nothing. The result locates every payload entry in the archive
  (`entries`: path, data offset, size and inventory SHA-256), so a caller holding the archive file
  reads an entry's bytes in place; whoever reads them again hashes them again.

## Signatures

- `createSignatureFile(archiveSha256, privateKey)` — the canonical detached signature document,
  signed with an Ed25519 key over `rayspec-ray-v1\nsha256:<archiveSha256>\n`. `writeBundle` writes
  it to `<destination>.sig` when given `signingKey`.
- `verifySignatureFile(archiveSha256, bytes, trustedKeys)` — checks in the contract's order:
  the document's shape (`malformed`), the archive digest (`mismatch`), a trusted signer
  (`untrusted-key`) and the signature itself (`mismatch`).

A signature establishes origin only when its signer is trusted; it is not proof that the code in
a bundle is safe.

## Secret scan

`isSecretPath` and `PrivateKeyScanner` are the one rule set pack and verify share: a secret file
name (`.env`, `.env.*`, `id_rsa`, `id_ecdsa`, `id_ed25519`, `.pgpass`) and a PEM private-key
header (`-----BEGIN `, words of uppercase letters and digits such as `RSA`, `SM2` or `X25519` each
followed by a space, then `PRIVATE KEY-----`), found while the bytes stream. The reader reports
findings for application bundles, one per file: a file with a secret name is reported by its name
whatever it contains.

Part of [RaySpec](https://rayspec.dev) — **file-deployable AI infrastructure**: describe a
product's backend in one declarative YAML file, and RaySpec stands up accounts and
authentication, in-process agents, an HTTP API, a Postgres-backed data layer, durable
background jobs, and the supporting tooling — deployed GitOps-style from that single file.

Most projects consume this package indirectly — start with
[`npx rayspec init`](https://www.npmjs.com/package/rayspec) or `@rayspec/server` rather
than depending on it directly.

## Links

- Website & docs: <https://rayspec.dev>
- Source (monorepo): <https://github.com/rayspec-labs/rayspec>
- Changelog: <https://github.com/rayspec-labs/rayspec/blob/main/CHANGELOG.md>

## License

Source-available under the **Functional Source License (FSL-1.1-ALv2)** — each release
converts to Apache-2.0 two years after publication. See
[LICENSE](https://github.com/rayspec-labs/rayspec/blob/main/LICENSE).
