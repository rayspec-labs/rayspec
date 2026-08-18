/**
 * The committed platform migration chain: where it lives, and the advisory-lock key every runner
 * of it must agree on.
 *
 * The `drizzle/` folder (drizzle/0000..NNNN.sql + meta/_journal.json) is a sibling of `src`/`dist`
 * in this package. The boot composition root (`@rayspec/server`) applies the chain with the real
 * programmatic migrator (`drizzle-orm/postgres-js/migrator` `migrate(db, { migrationsFolder })`),
 * applying exactly the chain `drizzle-kit migrate` / `gate:migrate-clean` apply.
 *
 * `@rayspec/db` is the authoritative owner of where its OWN chain lives, so it computes the path
 * from its own module URL — robust whether the package runs from compiled `dist/migrations.js`
 * (node) or `src/migrations.ts` (tsx). Both `dist/` and `src/` are one level under the package root,
 * so the folder is always `<this-file-dir>/../drizzle`.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to the committed migration chain folder (drizzle/) in this package. */
export function migrationsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
}

/**
 * The advisory-lock key that serializes every application of the chain above.
 *
 * A Postgres advisory lock is a convention, not an enforced one: two runners serialize only while
 * they name the SAME pair, and there is no way to discover the pair from the database. That is the
 * whole reason it is a constant here rather than a parameter, and the reason it lives beside
 * `migrationsDir()` — the package that owns the chain owns the key to it, so a second runner cannot
 * be written that applies this chain under some other pair and quietly serializes against nothing.
 *
 * `0x72617973` is `rays` in ASCII, a namespace this project owns, so the pair cannot collide with an
 * unrelated application holding advisory locks on the same database. Slot 1 is the platform
 * migration chain; a future serialized step takes a new slot rather than sharing this one.
 *
 * The one consumer is `applyMigrations` in `@rayspec/server`'s composition root, which is also the
 * single function every migration runner in this repo goes through — the boot and
 * `rayspec provision-tenant` alike. **Anything that takes this lock and then calls `applyMigrations`
 * self-deadlocks**, because `applyMigrations` takes it on a connection of its own.
 */
export const MIGRATION_LOCK_NAMESPACE = 0x7261_7973;
/** Slot 1 of {@link MIGRATION_LOCK_NAMESPACE}: the platform migration chain. */
export const MIGRATION_LOCK_SLOT = 1;
