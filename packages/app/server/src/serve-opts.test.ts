/**
 * Unit coverage for `assembleOptsFromEnv` — the opts-building serve.ts (the SHIPPED entrypoint) hands
 * to `assembleServer`. This closes the blind-test gap the DB e2e leaves open: `serve-agent-boot.db.test`
 * drives `assembleServer` DIRECTLY with SUBSTITUTE opts (a test registrar + an injected fake backend),
 * so it proves the SEAM but never that the opts BUILDER assembles the RIGHT things — a revert of
 * `assembleOptsFromEnv`'s BODY that stopped it feeding the validating registrar / the from-env factory
 * would pass the DB e2e. These assertions RED on exactly such a body revert.
 *
 * SCOPE (honest): they pin the opts-BUILDER, not its one-line forwarding at the `main()` call site
 * (`assembleServer(config, assembleOptsFromEnv(config))`), which no test exercises — `main()` is fenced
 * by `isProcessEntrypoint`, so covering it directly would require spawning/mocking the process
 * entrypoint (disproportionate). That one-line call-site wiring is left to review.
 *
 * DB-free / process.env-free: `loadServerConfig` is fed an EXPLICIT env (three dummy boot secrets — it
 * only shape-checks them, never parses the PEM or touches the DB), and `assembleOptsFromEnv` is passed an
 * EXPLICIT env, so the cases pin the real behavior, not the ambient environment.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerProductStores } from '@rayspec/db/composition';
import { afterAll, describe, expect, it } from 'vitest';
import { loadServerConfig, type ServerConfig } from './composition-root.js';
import { assembleOptsFromEnv } from './serve-opts.js';

const here = dirname(fileURLToPath(import.meta.url));
// The committed backend-profile fixture (one store + one tool-using `openai` agent) — the same one the
// DB e2e boots. It declares an agent, so the from-env factory has a backend to build.
const BACKEND_SPEC = resolve(here, '__fixtures__/agent-boot/agent-boot-notes.rayspec.yaml');

// A valid ServerConfig with NO spec path (RAYSPEC_SPEC_PATH absent) — the base for the cases below.
// loadServerConfig only shape-checks the three secrets (non-empty); it never parses the PEM / hits a DB.
const baseConfig = loadServerConfig({
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  RAYSPEC_JWT_SIGNING_KEY: 'dummy-not-a-real-pem',
  RAYSPEC_API_KEY_PEPPER: 'dummy-pepper',
});

function configWithSpec(specPath: string): ServerConfig {
  return { ...baseConfig, specPath };
}

const tmpDirs: string[] = [];
function writeTempSpec(name: string, text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'rayspec-opts-'));
  tmpDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

describe('assembleOptsFromEnv — serve.ts wires the RIGHT deployer seams', () => {
  afterAll(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('NO spec → {} (auth-only boot: no registrar, no agent factory)', () => {
    const opts = assembleOptsFromEnv(baseConfig, {});
    expect(opts).toEqual({});
    expect(opts.registerProductTables).toBeUndefined();
    expect(opts.agentBackendsFactory).toBeUndefined();
  });

  it('a BACKEND-profile spec with agents + OPENAI_API_KEY → the VALIDATING registrar + an agent factory', () => {
    const opts = assembleOptsFromEnv(configWithSpec(BACKEND_SPEC), {
      OPENAI_API_KEY: 'sk-dummy-not-a-real-key',
    });
    // BY IDENTITY: serve.ts wires the ONE SANCTIONED validating registrar (registerProductStores
    // validates every table before it joins the deny-by-default chokepoint Set), not just any function.
    // REDs if serve.ts stops wiring it (a full serve.ts revert to `assembleServer(config)`).
    expect(opts.registerProductTables).toBe(registerProductStores);
    // A backend-profile spec WITH an agent gets its backend instances built from env.
    expect(opts.agentBackendsFactory).toBeTypeOf('function');
  });

  it('a PRODUCT-profile spec → the VALIDATING registrar, but NO agent factory (product builds its own)', () => {
    // A MINIMAL VALID product-profile doc (parses {ok:true, kind:'product'}) so the factory returns
    // undefined via the genuine `kind !== 'rayspec'` PRODUCT branch — NOT via a parse failure (which a
    // malformed BACKEND doc would satisfy identically, proving nothing about product-profile handling).
    const productSpec = writeTempSpec(
      'product.rayspec.yaml',
      "version: '1.0'\nproduct:\n  id: opts_product\n  name: opts-product\n",
    );
    const opts = assembleOptsFromEnv(configWithSpec(productSpec), {});
    expect(opts.registerProductTables).toBe(registerProductStores);
    // The product deploy path builds its own backends from its extraction sidecars — NOT from the YAML.
    expect(opts.agentBackendsFactory).toBeUndefined();
  });
});

/**
 * The backend-profile reach for the reviewed forward-DELTA apply seam: a backend deploy reaches deploy()'s
 * `DeployConfig.migrations` seam ONLY through `opts.updateMigrations`, so `assembleOptsFromEnv` must
 * derive it from `RAYSPEC_UPDATE_MIGRATION` (+ optional `RAYSPEC_UPDATE_ALLOWLIST`) — the wiring that lets
 * `rayspec deploy --apply-migration <delta>` apply a delta to a BACKEND deployment. A revert of this reach
 * REDs these (a default boot yields no updateMigrations; a set env yields exactly one gated delta).
 */
describe('assembleOptsFromEnv — the reviewed forward-DELTA reach (RAYSPEC_UPDATE_MIGRATION)', () => {
  it('no RAYSPEC_UPDATE_MIGRATION → NO updateMigrations (the default backend boot is unchanged)', () => {
    const opts = assembleOptsFromEnv(configWithSpec(BACKEND_SPEC), {
      OPENAI_API_KEY: 'sk-dummy-not-a-real-key',
    });
    expect(opts.updateMigrations).toBeUndefined();
  });

  it('RAYSPEC_UPDATE_MIGRATION set → ONE gated delta, keyed by filename, empty allowlist by default', () => {
    const deltaSql = 'ALTER TABLE parts ADD COLUMN note text;\n';
    const deltaPath = writeTempSpec('0001_add_note.sql', deltaSql);
    const opts = assembleOptsFromEnv(configWithSpec(BACKEND_SPEC), {
      OPENAI_API_KEY: 'sk-dummy-not-a-real-key',
      RAYSPEC_UPDATE_MIGRATION: deltaPath,
    });
    expect(opts.updateMigrations).toHaveLength(1);
    expect(opts.updateMigrations?.[0]?.sql).toBe(deltaSql);
    expect(opts.updateMigrations?.[0]?.name).toBe('0001_add_note.sql');
    expect(opts.updateMigrations?.[0]?.allowlist).toEqual([]);
    // The update reach is ADDITIVE — the registrar + agent factory are still wired.
    expect(opts.registerProductTables).toBe(registerProductStores);
    expect(opts.agentBackendsFactory).toBeTypeOf('function');
  });

  it('a reviewed RAYSPEC_UPDATE_ALLOWLIST is threaded onto the delta', () => {
    const deltaPath = writeTempSpec('0002_drop.sql', 'ALTER TABLE parts DROP COLUMN note;\n');
    const entry = { kind: 'drop_column', match: 'parts.note', reason: 'reviewed by an operator' };
    const allowPath = writeTempSpec('allow.json', JSON.stringify([entry]));
    const opts = assembleOptsFromEnv(configWithSpec(BACKEND_SPEC), {
      OPENAI_API_KEY: 'sk-dummy-not-a-real-key',
      RAYSPEC_UPDATE_MIGRATION: deltaPath,
      RAYSPEC_UPDATE_ALLOWLIST: allowPath,
    });
    expect(opts.updateMigrations?.[0]?.allowlist).toEqual([entry]);
  });
});
