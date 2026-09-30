/**
 * `rayspec pack --against <old-spec> [--allowlist <file.json>]` — the product delta a bundle carries.
 *
 * The delta is generated from the stores the previous spec declares to the stores the new one
 * declares, by the same function the target runtime regenerates it with (`productDelta` in
 * `@rayspec/server`), so a bundle packed against the spec an environment runs carries exactly the
 * delta that environment will compute. The target never trusts it: it regenerates the delta from its
 * product migration ledger and refuses a difference.
 *
 * The manifest names the product schema digests the delta migrates between. They are computed here,
 * on a throwaway database on the server `SHADOW_DATABASE_URL` names (from the process environment
 * only, like every value pack reads): the platform chain, then the previous spec's stores, give the
 * digest before; the delta gives the digest after. The database is created and dropped within the
 * call; nothing else on that server is touched.
 *
 * A destructive delta is refused here unless the `--allowlist` file clears every finding, with the
 * same scanner and the same allowlist rules the target applies; the refusal names the stores and
 * columns and the review step. The carried `destructive` flag is advisory only: the target scans the
 * delta again.
 *
 * This module is loaded only for `--against`, so a pack without it still loads no server and no
 * database layer.
 */
import { readFile } from 'node:fs/promises';
import {
  type BundleSpec,
  type ProductMigrationInput,
  parseBundleSpec,
} from '@rayspec/bundle-closure';
import { type BundleError, bundleError } from '@rayspec/bundle-contract';
import { parseAllowlistEntries, scanMigrationSql } from '@rayspec/db';
import {
  declaredStoresOf,
  productDelta,
  shadowProductDigests,
  uncoveredDestructiveMessage,
} from '@rayspec/server';

export interface AgainstInput {
  /** The new spec: the one being packed. */
  spec: string;
  /** The previous spec: the one the target environment runs. */
  against: string;
  /** The reviewed allowlist file, when one was given. */
  allowlist?: string;
  /** The server a throwaway database may be created on. */
  shadowDatabaseUrl?: string;
}

export type AgainstOutcome =
  | {
      ok: true;
      /** The migration to carry; absent when the stores did not change. */
      migration?: ProductMigrationInput;
      /** What the summary says about the delta. */
      lines: string[];
    }
  | { ok: false; errors: BundleError[] };

const usage = (message: string): AgainstOutcome => ({
  ok: false,
  errors: [bundleError('RAY_USAGE', message)],
});

async function readInput(path: string, what: string): Promise<Buffer | string> {
  try {
    return await readFile(path);
  } catch {
    return `${what} ${path} cannot be read`;
  }
}

/** The product migration a bundle of `spec` carries when it is packed against `against`. */
export async function productMigrationAgainst(input: AgainstInput): Promise<AgainstOutcome> {
  const newBytes = await readInput(input.spec, 'the spec');
  // A new spec that cannot be read or parsed is reported by the closure resolver, in its own words.
  if (typeof newBytes === 'string') return { ok: true, lines: [] };
  const parsedNew = parseBundleSpec(newBytes);
  if (!parsedNew.ok) return { ok: true, lines: [] };

  const oldBytes = await readInput(input.against, '--against: the previous spec');
  if (typeof oldBytes === 'string') return usage(oldBytes);
  const parsedOld = parseBundleSpec(oldBytes);
  if (!parsedOld.ok) {
    const [first, ...rest] = parsedOld.errors;
    return {
      ok: false,
      errors: [
        { ...first!, message: `--against: the previous spec does not parse: ${first!.message}` },
        ...rest,
      ],
    };
  }
  const previous: BundleSpec = parsedOld.value;
  const next: BundleSpec = parsedNew.value;
  if (previous.kind !== next.kind) {
    return usage(
      '--against: the previous spec is of another profile (a backend spec against a product ' +
        'document or the other way round); pack against the spec the environment runs',
    );
  }

  let allowlistBytes: Buffer | undefined;
  let entries: ReturnType<typeof parseAllowlistEntries> = { ok: true, entries: [] };
  if (input.allowlist !== undefined) {
    const read = await readInput(input.allowlist, '--allowlist: the file');
    if (typeof read === 'string') return usage(read);
    allowlistBytes = read;
    try {
      entries = parseAllowlistEntries(JSON.parse(read.toString('utf8')));
    } catch {
      entries = { ok: false, message: 'the allowlist is not valid JSON' };
    }
    if (!entries.ok) return usage(`--allowlist: ${entries.message}`);
  }

  const from = declaredStoresOf(previous);
  const delta = productDelta(from, declaredStoresOf(next));
  if (delta.migrationSql === '') {
    if (allowlistBytes !== undefined) {
      return usage('--allowlist: the stores did not change, so there is no delta for it to cover');
    }
    return {
      ok: true,
      lines: ['product delta: none — the stores are the ones the previous spec declares'],
    };
  }
  const scan = scanMigrationSql(delta.migrationSql, entries.ok ? entries.entries : []);
  if (!scan.pass) return usage(uncoveredDestructiveMessage(scan.findings));

  const shadowUrl = input.shadowDatabaseUrl?.trim();
  if (shadowUrl === undefined || shadowUrl === '') {
    return usage(
      '--against needs SHADOW_DATABASE_URL in the environment: the product schema digests the ' +
        'bundle names are computed on a throwaway database that pack creates and drops on that server',
    );
  }
  const baseline = productDelta({ stores: [] }, from).migrationSql;
  let digests: Awaited<ReturnType<typeof shadowProductDigests>>;
  try {
    digests = await shadowProductDigests(
      shadowUrl,
      baseline === '' ? [] : [baseline],
      delta.migrationSql,
    );
  } catch {
    // The error may name the server; the envelope never does.
    return usage(
      'SHADOW_DATABASE_URL could not be used to compute the product schema digests: it must name ' +
        'a reachable Postgres server on which pack may create and drop a throwaway database, and ' +
        'the delta must apply there',
    );
  }
  const destructive = scan.findings.length > 0;
  return {
    ok: true,
    migration: {
      delta: Buffer.from(delta.migrationSql, 'utf8'),
      ...(allowlistBytes === undefined ? {} : { allowlist: allowlistBytes }),
      fromProductSchemaDigest: digests.before,
      toProductSchemaDigest: digests.after,
      destructive,
    },
    lines: [
      `product delta: ${delta.statements.length} statement(s) against ${input.against}, product ` +
        `schema ${digests.before} to ${digests.after}${
          destructive ? '; destructive, every finding cleared by the reviewed allowlist' : ''
        }`,
    ],
  };
}
