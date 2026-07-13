/**
 * The deployer-seam opts builder — the single source of truth shared by BOTH the shipped `rayspec-serve`
 * bin (serve.ts) AND the `rayspec deploy` CLI (packages/app/cli/src/deploy.ts). Both boot a
 * backend-profile spec WITH agents directly by building the SAME `assembleServer` opts from the ambient
 * env + the (optional) spec, so neither hand-rolls the wiring and there is exactly ONE place the boot
 * seams are assembled. Lives in its OWN module (not the bin) so it is a normal, importable/exportable
 * function: the bin self-executes and its top-level `main()` guard means index.ts cannot cleanly
 * re-export it from serve.ts.
 */
import { readFileSync } from 'node:fs';
import type { PlannedMigration } from '@rayspec/api-auth';
import { registerProductStores } from '@rayspec/db/composition';
import { agentBackendsFactoryFromEnv } from './agent-backends-from-env.js';
import type {
  AgentBackendsFactory,
  ProductTableRegistrar,
  ServerConfig,
} from './composition-root.js';
import { readProductUpdateMigrations } from './product-boot.js';

/**
 * Build the two deployer-seam opts `assembleServer` needs from the ambient env + the (optional) spec.
 * EXTRACTED into a shared module so BOTH `rayspec-serve` (serve.ts) and the `rayspec deploy` CLI feed
 * `assembleServer` the RIGHT seams from ONE builder (no duplicated opts logic), and so serve.ts's OWN
 * wiring is unit-testable: the DB e2e drives assembleServer with SUBSTITUTE opts (for determinism), so
 * without this the fact that the entrypoints feed the RIGHT seams would be untested — a revert that
 * stopped wiring them would pass CI. `serve-opts.test.ts` pins this by identity. Behavior:
 *   - NO spec (auth-only boot) → {} (no registrar, no agent factory).
 *   - ANY spec → the SANCTIONED validating product-table registrar (registerProductStores VALIDATES
 *     every table before it joins the deny-by-default chokepoint Set); harmless when the spec declares
 *     no stores. deploy.ts (the kill-set roll-out) is untouched — these are its existing opts.
 *   - a BACKEND-profile spec WITH ≥1 declared agent → additionally an `agentBackendsFactory` built from
 *     env (agentBackendsFactoryFromEnv); a PRODUCT-profile or agent-free spec needs none (undefined),
 *     and the product deploy path builds its own backends.
 *   - `RAYSPEC_UPDATE_MIGRATION` set (+ optional `RAYSPEC_UPDATE_ALLOWLIST`) → additionally the reviewed
 *     forward-DELTA `updateMigrations` for the BACKEND deploy path. A backend-profile boot reaches
 *     deploy()'s `DeployConfig.migrations` seam ONLY through `opts.updateMigrations`, so this is what
 *     lets `rayspec deploy --apply-migration <delta>` apply a delta to a backend deployment. (A
 *     product-profile boot reads the SAME env DIRECTLY inside product-boot, so it does not need this.)
 *     Built via the SAME `readProductUpdateMigrations` helper product-boot uses — undefined unless the
 *     env is set; fail-closed (throws) on an unreadable delta / malformed allowlist.
 */
export function assembleOptsFromEnv(
  config: ServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): {
  registerProductTables?: ProductTableRegistrar;
  agentBackendsFactory?: AgentBackendsFactory;
  updateMigrations?: PlannedMigration[];
} {
  if (!config.specPath) return {};
  const factory = agentBackendsFactoryFromEnv(readFileSync(config.specPath, 'utf8'), env);
  const updateMigrations = readProductUpdateMigrations({
    migrationPath: env.RAYSPEC_UPDATE_MIGRATION,
    allowlistPath: env.RAYSPEC_UPDATE_ALLOWLIST,
  });
  return {
    registerProductTables: registerProductStores,
    ...(factory ? { agentBackendsFactory: factory } : {}),
    ...(updateMigrations ? { updateMigrations } : {}),
  };
}
