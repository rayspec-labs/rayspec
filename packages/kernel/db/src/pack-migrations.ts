/**
 * Pack-owned platform tables — the one door an extension pack's own migration chain reaches the
 * database through.
 *
 * A pack contributes `stores` for product data: generated business tables the platform owns. A pack
 * that needs PLATFORM state instead — hand-shaped indexes, a foreign key, an append-only ledger —
 * declares `migrations: { dir, tablePrefix }` in its manifest, and this applies that chain.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE SAME MIGRATOR, STRICTLY AFTER THE PLATFORM CHAIN, IN ITS OWN JOURNAL.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A pack chain runs through the SAME drizzle migrator the platform chain runs through — not a
 * second apply path with its own transaction discipline — and the boot calls this only after
 * `applyMigrations` has finished, so a pack table may carry a foreign key onto a platform one.
 *
 * Each chain is journaled in ITS OWN `__migrations_<packId>` table in the `drizzle` schema, beside
 * the platform's `__drizzle_migrations`. That is what makes a pack chain a CHAIN OF ITS OWN rather
 * than an extension of the core one: drizzle applies a migration only while the journal's
 * high-water mark is behind it, so a shared journal would mean a pack's `0000` sitting behind the
 * platform's latest entry and being silently skipped forever — and two packs whose chains both
 * start at `0000` would silently skip each other. A pack chain therefore restarts at `0000`, and
 * neither it nor the core one can ever renumber the other.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * FAIL CLOSED, AND NAME BOTH PARTIES.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Everything below is decided BEFORE the first statement of the first chain runs, so a deployment
 * whose packs are mis-declared is refused with nothing half-applied:
 *
 *   - a declared prefix whose NAMESPACE CONTAINS a platform table (`org` would contain `orgs`) is
 *     refused naming both the pack and the table — the pack's namespace must be the pack's alone;
 *   - two packs whose prefixes NEST (or are equal) are refused naming BOTH packs — a table under
 *     the inner prefix would sit in both namespaces, and nothing here could decide whose it is;
 *   - both of those comparisons run on the prefix FOLDED TO LOWER CASE, because that is the name
 *     PostgreSQL gives an unquoted identifier: `Orgs` and `orgs` are ONE namespace to the server, so
 *     comparing the declared text verbatim would have cleared a prefix that contains `orgs` and a
 *     second pack that owns the first one's tables. (`scanPackMigrationChain` separately refuses a
 *     prefix that is not already in that folded form, so the two halves of every comparison — the
 *     declared namespace and the names in the chain — are always in one case space;)
 *   - a chain the SCAN rejects does not apply. It is the same `scanPackMigrationChain`
 *     `gate:pack-migrations` runs, with the same empty allowlist: a pack is code from somewhere
 *     else, and this repository's CI has no opinion about a chain it never saw;
 *   - a `__migrations_<packId>` that would exceed Postgres's 63-byte identifier limit is refused,
 *     because the server would TRUNCATE it and two packs would silently share one journal;
 *   - a chain whose `meta/_journal.json` is absent, or does not list a `.sql` file committed beside
 *     it, is refused — a migration that is shipped and never runs is the silent-skip class.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESERVED_STORE_NAMES } from '@rayspec/spec';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Db } from './client.js';
import { scanPackMigrationChain } from './pack-migration-scan.js';

/** The prefix every pack journal table carries, so the set is greppable in a live database. */
const JOURNAL_PREFIX = '__migrations_';

/** Postgres truncates an identifier past this many bytes (NAMEDATALEN - 1). */
const MAX_IDENTIFIER_BYTES = 63;

/** One pack's migration chain, as the loader resolved it from that pack's manifest. */
export interface PackMigrationChain {
  /** The pack id from the deployment's `extensions[]` entry — the journal's namespace. */
  readonly packId: string;
  /** The ABSOLUTE chain directory (jailed under the pack root by the loader). */
  readonly dir: string;
  /** The namespace every table and index in the chain carries. */
  readonly tablePrefix: string;
}

/** What one applied chain read, for the boot log. */
export interface PackMigrationApplied {
  /** The pack whose chain this was. */
  readonly packId: string;
  /** The journal table it was recorded in. */
  readonly journalTable: string;
  /** How many `.sql` files the chain holds. */
  readonly files: number;
  /** How many statements they hold. */
  readonly statements: number;
}

/**
 * A fail-closed pack-migration refusal. `packId` carries the offending pack as a FIELD as well as in
 * the message, so a caller that re-reports the failure in its own vocabulary — the boot turns this
 * into an operator-actionable abort — can name the pack without reading it back out of the text.
 */
export class PackMigrationError extends Error {
  readonly packId: string | undefined;
  constructor(message: string, packId?: string) {
    super(message);
    this.name = 'PackMigrationError';
    this.packId = packId;
  }
}

/** The journal table one pack's chain is recorded in — never the platform chain's. */
export function packJournalTable(packId: string): string {
  return `${JOURNAL_PREFIX}${packId}`;
}

/**
 * A declared prefix in the case the SERVER will store its objects under. PostgreSQL folds an
 * UNQUOTED identifier to lower case, so `Orgs` and `orgs` are ONE name to it while every rule below
 * compares text: unfolded, `tablePrefix: 'Orgs'` would contain no platform table and would overlap
 * no sibling's `orgs`, and the chain's unquoted objects would land in exactly the namespace those
 * two rules just cleared. The chain scan additionally refuses a prefix that is not already in this
 * form — this fold is what lets the refusal below NAME the collision instead of reporting a shape.
 */
function foldedPrefix(tablePrefix: string): string {
  return tablePrefix.toLowerCase();
}

/** The platform table names a pack prefix may not swallow, read off the shared reserved set. */
function platformTablesUnder(tablePrefix: string): string[] {
  const folded = foldedPrefix(tablePrefix);
  return [...RESERVED_STORE_NAMES].filter((name) => name.startsWith(folded)).sort();
}

/**
 * Refuse a chain whose `meta/_journal.json` does not describe exactly the `.sql` files committed
 * beside it. Drizzle reads the journal and nothing else, so an unlisted file is a migration that
 * ships and never runs, and a listed tag with no file aborts the apply with a message about a folder
 * rather than about the chain.
 */
function assertJournalDescribesChain(chain: PackMigrationChain): void {
  const journalPath = join(chain.dir, 'meta', '_journal.json');
  if (!existsSync(journalPath)) {
    throw new PackMigrationError(
      `extension pack '${chain.packId}': the migration chain at ${chain.dir} has no ` +
        'meta/_journal.json. A pack chain is applied by the same drizzle migrator as the platform ' +
        'chain, which reads the journal and nothing else — a chain without one applies none of its ' +
        'migrations (fail-closed).',
      chain.packId,
    );
  }
  let tags: string[];
  try {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries?: { tag?: unknown }[];
    };
    tags = (journal.entries ?? []).map((e) => String(e.tag));
  } catch (e) {
    throw new PackMigrationError(
      `extension pack '${chain.packId}': the migration chain's meta/_journal.json (${journalPath}) ` +
        `could not be read: ${e instanceof Error ? e.message : String(e)} (fail-closed).`,
      chain.packId,
    );
  }
  const files = readdirSync(chain.dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.slice(0, -'.sql'.length));
  const unlisted = files.filter((f) => !tags.includes(f)).sort();
  if (unlisted.length > 0) {
    throw new PackMigrationError(
      `extension pack '${chain.packId}': the migration chain at ${chain.dir} commits ` +
        `${unlisted.map((f) => `${f}.sql`).join(', ')}, which meta/_journal.json does not list — ` +
        'the migrator applies the journal, so those migrations would ship and never run ' +
        '(fail-closed).',
      chain.packId,
    );
  }
  const missing = tags.filter((t) => !files.includes(t)).sort();
  if (missing.length > 0) {
    throw new PackMigrationError(
      `extension pack '${chain.packId}': meta/_journal.json lists ` +
        `${missing.map((t) => `${t}.sql`).join(', ')}, which the chain at ${chain.dir} does not ` +
        'contain (fail-closed).',
      chain.packId,
    );
  }
}

/** Every namespace rule, decided across the WHOLE set before a single statement runs. */
function assertNamespaces(chains: readonly PackMigrationChain[]): void {
  /** FOLDED prefix → the pack that declared it, plus the text it declared (for the diagnostic). */
  const byPrefix = new Map<string, { readonly declared: string; readonly ownerId: string }>();
  const seenIds = new Set<string>();
  for (const chain of chains) {
    if (seenIds.has(chain.packId)) {
      throw new PackMigrationError(
        `extension pack '${chain.packId}': two migration chains were declared for one pack id — ` +
          'a pack has exactly one chain, journaled in exactly one table (fail-closed).',
        chain.packId,
      );
    }
    seenIds.add(chain.packId);

    const journalTable = packJournalTable(chain.packId);
    if (Buffer.byteLength(journalTable, 'utf8') > MAX_IDENTIFIER_BYTES) {
      throw new PackMigrationError(
        `extension pack '${chain.packId}': its journal table '${journalTable}' is longer than the ` +
          `${MAX_IDENTIFIER_BYTES}-byte identifier limit Postgres TRUNCATES at, so two packs could ` +
          'end up sharing one journal and silently skipping each other. Use a shorter pack id ' +
          '(fail-closed).',
        chain.packId,
      );
    }

    // Both rules below run on the FOLDED prefix, which is the namespace the server will actually
    // hand the chain. When the declared text differs from it, say so — otherwise a refusal naming
    // 'Orgs' and `orgs` in one sentence reads like a typo rather than like the rule it is.
    const folded = foldedPrefix(chain.tablePrefix);
    const foldNote =
      folded === chain.tablePrefix
        ? ''
        : ` (PostgreSQL folds an UNQUOTED identifier to lower case, so that prefix is the namespace '${folded}')`;

    const swallowed = platformTablesUnder(chain.tablePrefix);
    if (swallowed.length > 0) {
      throw new PackMigrationError(
        `extension pack '${chain.packId}': its declared table prefix '${chain.tablePrefix}'` +
          `${foldNote} contains the platform table${swallowed.length > 1 ? 's' : ''} ` +
          `${swallowed.join(', ')} — a pack's namespace must be the pack's alone, and the platform ` +
          'already owns that name (fail-closed collision).',
        chain.packId,
      );
    }

    for (const [prefix, owner] of byPrefix) {
      if (folded.startsWith(prefix) || prefix.startsWith(folded)) {
        throw new PackMigrationError(
          `extension pack '${chain.packId}': its declared table prefix '${chain.tablePrefix}'` +
            `${foldNote} overlaps the prefix '${owner.declared}' extension pack '${owner.ownerId}' ` +
            'declares — a table under the longer prefix would sit in both namespaces, and nothing ' +
            'decides whose it is (fail-closed collision).',
          chain.packId,
        );
      }
    }
    byPrefix.set(folded, { declared: chain.tablePrefix, ownerId: chain.packId });
  }
}

/**
 * Apply every pack's migration chain, in the order the deployment declares its packs, AFTER the
 * platform chain has been applied to the same database.
 *
 * Fail-closed in two phases: nothing is applied until EVERY chain has passed every rule, so a
 * deployment with one mis-declared pack does not come up with the other packs' tables already
 * created. Idempotent, exactly as the platform chain is: a chain already recorded in its journal
 * re-applies nothing, so a reboot is a no-op.
 */
export async function applyPackMigrations(
  db: Db,
  chains: readonly PackMigrationChain[],
): Promise<PackMigrationApplied[]> {
  if (chains.length === 0) return [];

  assertNamespaces(chains);

  const planned: PackMigrationApplied[] = [];
  for (const chain of chains) {
    const scan = scanPackMigrationChain(chain.dir, chain.tablePrefix);
    if (scan.violations.length > 0) {
      throw new PackMigrationError(
        `extension pack '${chain.packId}': its migration chain is REFUSED — every table and index ` +
          "a pack chain creates must carry the pack's declared table prefix " +
          `'${chain.tablePrefix}', and the chain must survive the platform destructive scan with ` +
          'NO allowlist (a pack chain has none, and no mechanism to author one):\n' +
          scan.violations.map((v) => `  - ${v}`).join('\n'),
        chain.packId,
      );
    }
    assertJournalDescribesChain(chain);
    planned.push({
      packId: chain.packId,
      journalTable: packJournalTable(chain.packId),
      files: scan.files,
      statements: scan.statements,
    });
  }

  for (const chain of chains) {
    await migrate(db, {
      migrationsFolder: chain.dir,
      // The pack's OWN journal, beside the platform's in the same `drizzle` bookkeeping schema.
      migrationsTable: packJournalTable(chain.packId),
    });
  }
  return planned;
}
