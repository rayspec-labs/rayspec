/**
 * The committed platform migration chain's on-disk location.
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
