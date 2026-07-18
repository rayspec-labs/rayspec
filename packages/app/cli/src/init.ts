/**
 * `rayspec init [dir]` — scaffold a new RaySpec project.
 *
 * Writes a minimal, VALID `version:'1.0'` backend-profile `rayspec.yaml` (a starter with one store and
 * its CRUD routes) into the target directory (default: the current directory). This is the "hello
 * world" entry point: after `init` a user runs `rayspec doctor ./rayspec.yaml` to validate it and
 * `rayspec plan ./rayspec.yaml` to preview a deploy — neither needs a provider credential, because the
 * starter declares only store-backed routes (no agent), so it plans and deploys with just a
 * `DATABASE_URL` and the platform boot secrets (`rayspec dev gen-secrets`).
 *
 * The starter is PRODUCT-NEUTRAL: a generic `items` store with `title`/`done` columns. It carries no
 * custom code, so it needs no build step — edit the YAML, re-validate, deploy.
 *
 * Output is a stable JSON envelope on stdout (`{ ok, command, created, path?, nextSteps?, errors }`);
 * exit 0 ok / 1 not-ok (e.g. the file already exists without `--force`). A usage/argument problem is
 * raised as an `InitCliError` and mapped to exit 2 by the top level (index.ts). NO secret can appear in
 * the output — the only inputs are the operator-supplied target directory and the fixed template.
 *
 * FAIL-CLOSED FILESYSTEM SURFACE (defence-in-depth; internal/local): the target directory is resolved
 * against the CWD and rejected if it ESCAPES the CWD via `..` (a structural jail, mirroring read-spec.ts
 * / gen-handler.ts). Without `--force`, an existing `rayspec.yaml` is never overwritten (the write uses
 * the exclusive `wx` flag as a race-safe backstop to the up-front existence check).
 */
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

/** The bare filename `init` writes into the target directory. */
export const SPEC_FILENAME = 'rayspec.yaml';

/**
 * The starter backend-profile spec. A minimal, VALID `version:'1.0'` document: one `items` store and
 * the five CRUD routes over it. Store-backed only (no agent) so `plan`/`deploy` need no provider
 * credential. Product-neutral by construction. The `init` round-trip test parses THIS through the same
 * `doctor` parser and asserts it is valid — a malformed template fails that test (fail-the-fix).
 */
export const STARTER_SPEC = `# A starter RaySpec backend — one declarative YAML document.
#
# Edit the sections below to declare your own data and HTTP surface, then:
#   rayspec doctor ./rayspec.yaml   # validate the shape (no database needed)
#   rayspec plan   ./rayspec.yaml   # preview the deploy (read-only)
# See docs/getting-started.md for booting the platform and adding an agent.

version: '1.0'

metadata:
  name: my-backend
  description: A starter RaySpec backend. Edit this file to declare your data and API.

# Declare BUSINESS columns only — the platform injects the tenancy/GDPR columns
# (tenant_id, id, created_at, deleted_at, ...) for you.
stores:
  - name: items
    columns:
      - { name: title, type: text }
      - { name: done, type: boolean }

# CRUD over the store. Each route maps an HTTP method + path to a store operation.
api:
  - { method: POST,   path: '/items',      action: { kind: store, store: items, op: create } }
  - { method: GET,    path: '/items',      action: { kind: store, store: items, op: list } }
  - { method: GET,    path: '/items/{id}', action: { kind: store, store: items, op: get } }
  - { method: PATCH,  path: '/items/{id}', action: { kind: store, store: items, op: update } }
  - { method: DELETE, path: '/items/{id}', action: { kind: store, store: items, op: delete } }
`;

/** The `init` JSON result envelope. */
export interface InitResult {
  readonly ok: boolean;
  readonly command: 'init';
  /** The paths written (relative to the CWD) on success. */
  readonly created: string[];
  /** The written spec path (relative to the CWD) on success. */
  readonly path?: string;
  /** Human next-step hints (product language only; never a secret) on success. */
  readonly nextSteps?: string[];
  /** The fail-closed error list (a single entry today; an array for uniformity with doctor/plan). */
  readonly errors: { readonly code: string; readonly message: string }[];
}

/** A CLI/usage error (exit 2) — mirrors index.ts's CliError contract (re-thrown to the top level). */
export class InitCliError extends Error {}

/**
 * Run `rayspec init` over the subcommand args. Parses an OPTIONAL positional target directory (default
 * `.`) plus the boolean `--force`, scaffolds the starter `rayspec.yaml`, and returns the `{ ok, ... }`
 * envelope. An existing spec without `--force` is `ok:false` (NOT a throw); a usage problem (unknown
 * flag, extra positional, a `..`-escaping directory) throws `InitCliError` (→ exit 2).
 */
export async function runInit(args: readonly string[]): Promise<InitResult> {
  let positionals: string[];
  let force: boolean;
  try {
    const parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: { force: { type: 'boolean' } },
    });
    positionals = parsed.positionals;
    force = parsed.values.force ?? false;
  } catch (e) {
    throw new InitCliError(`invalid arguments: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (positionals.length > 1) {
    throw new InitCliError(
      `expected at most one target directory (got ${positionals.length}: ${positionals
        .map((p) => JSON.stringify(p))
        .join(', ')})`,
    );
  }
  const dirArg = positionals[0] ?? '.';

  // Structural jail: resolve the target dir against the CWD and reject a `..`-escape (defence-in-depth,
  // mirroring read-spec.ts). If the directory already exists, re-jail its symlink-resolved real path so
  // an in-CWD symlink cannot redirect the write outside the CWD.
  const cwd = process.cwd();
  const resolvedDir = resolve(cwd, dirArg);
  const rel = relative(cwd, resolvedDir);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new InitCliError(
      `target directory ${JSON.stringify(dirArg)} escapes the working directory — pass a path inside it`,
    );
  }
  if (existsSync(resolvedDir)) {
    const relReal = relative(cwd, realpathSync(resolvedDir));
    if (relReal.startsWith('..') || isAbsolute(relReal)) {
      throw new InitCliError(
        `target directory ${JSON.stringify(dirArg)} resolves to a target outside the working directory — pass a path inside it`,
      );
    }
  }

  const specPath = join(resolvedDir, SPEC_FILENAME);
  const relSpecPath = relative(cwd, specPath) || SPEC_FILENAME;

  // Never clobber an existing spec without --force. The up-front check gives a friendly error; the
  // exclusive `wx` write flag below is the race-safe backstop when not forcing.
  if (!force && existsSync(specPath)) {
    return {
      ok: false,
      command: 'init',
      created: [],
      errors: [
        {
          code: 'spec_exists',
          message: `${relSpecPath} already exists — pass --force to overwrite it`,
        },
      ],
    };
  }

  await mkdir(resolvedDir, { recursive: true });
  try {
    await writeFile(specPath, STARTER_SPEC, { encoding: 'utf8', flag: force ? 'w' : 'wx' });
  } catch (e) {
    // A concurrent create between the existence check and the write (EEXIST under `wx`) — surface it as
    // the same fail-closed not-ok, not a crash.
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      return {
        ok: false,
        command: 'init',
        created: [],
        errors: [
          {
            code: 'spec_exists',
            message: `${relSpecPath} already exists — pass --force to overwrite it`,
          },
        ],
      };
    }
    throw e;
  }

  return {
    ok: true,
    command: 'init',
    created: [relSpecPath],
    path: relSpecPath,
    nextSteps: [
      `rayspec doctor ${relSpecPath}`,
      `rayspec plan ${relSpecPath}`,
      'rayspec dev gen-secrets   # mint the boot secrets, then set DATABASE_URL to deploy',
    ],
    errors: [],
  };
}
