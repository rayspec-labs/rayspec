/**
 * `rayspec deploy` — the PRODUCTION-MUTATING boot command (distinct from the read-only diagnostic
 * floor and the local-dev `dev` group). Two modes:
 *
 *   rayspec deploy <spec.yaml>              LONG-RUNNING: assemble the platform from the ambient env,
 *                                            register the product stores through the SANCTIONED
 *                                            validating registrar, apply the committed migration chain
 *                                            + roll out the declared product, and SERVE on PORT until
 *                                            SIGINT/SIGTERM. Mutates the target DB (materialize/mount).
 *   rayspec deploy --dry-run <spec.yaml>    ONE-SHOT: validate the product doc + COMPOSE it against a
 *                                            stubbed rollout (NO DB, NO network). Emits a JSON verdict.
 *
 * WHAT deploy IS. It is `deployments/acme-notes/serve.mts` as a first-class operator command: it wraps
 * `assembleServer` (NOT the kill-set `deploy()` — that stays inside the composition root) and injects
 * the deployer seams through the SAME shared `assembleOptsFromEnv` builder `rayspec-serve` uses — the
 * sanctioned `registerProductStores` registrar (the @rayspec/db/composition door — validates every
 * product table's tenant predicate before it joins the deny-by-default chokepoint Set) for any spec,
 * PLUS an env-driven agent-backend factory for a backend-profile spec WITH agents (so those agents boot
 * directly, parity with rayspec-serve). It buys operator ergonomics + the sanctioned store path; it adds
 * NO new platform mechanism (the boot itself is the same one the composition root already runs, proven
 * by product-yaml-boot.db.test.ts).
 *
 * All the heavy machinery (DBOS, Hono, the four adapters, product-yaml) is DYNAMICALLY imported inside
 * the handlers, so importing this module (which index.ts does statically) does NOT drag that weight
 * into `rayspec doctor` / the read-only floor.
 */

import { parseArgs } from 'node:util';
import type { ProductYamlRollout } from '@rayspec/product-yaml';
import { ReadSpecError, readSpecFile, resolveSpecPath } from './read-spec.js';

/** A usage/argument problem in `deploy` (mapped to exit 2 by index.ts, like the other subcommands). */
export class DeployCliError extends Error {}

/** The `--dry-run` verdict (JSON, stdout). ok:false ⇒ exit 1; a usage problem is a DeployCliError → exit 2. */
export interface DeployDryRunResult {
  readonly ok: boolean;
  readonly mode: 'dry-run';
  /** The resolved spec path (operator-supplied; never a secret). */
  readonly spec: string;
  /** What the DB-free compose proved when ok (store/route/trigger/workflow summary), else absent. */
  readonly composed?: {
    readonly product: string;
    readonly stores: readonly string[];
    readonly viewRoutes: readonly string[];
    readonly triggerEvents: readonly string[];
    readonly workflows: readonly string[];
  };
  /** The fail-closed reasons compose/parse rejected the doc (ok:false). */
  readonly errors: readonly string[];
  /** The honest boundary — what --dry-run does NOT prove. */
  readonly notProven: readonly string[];
}

/** What `--dry-run` deliberately does NOT prove (surfaced in the result + `--help`). */
const DRY_RUN_NOT_PROVEN = [
  'the migration (no DB was touched)',
  'boot-env sufficiency (secrets / blob root / media key are not read)',
  'any provider credential (STT / extraction / responder are stubbed)',
  'live-schema drift against an existing deployment',
  'that the app actually serves (no port was bound)',
] as const;

/** The discriminated outcome of `runDeploy`: a dry-run verdict to emit, or a served (long-running) boot. */
export type DeployOutcome =
  | { readonly kind: 'dry-run'; readonly result: DeployDryRunResult }
  | { readonly kind: 'served' };

/**
 * Parse `deploy`'s args: exactly one positional spec path, plus `--dry-run`, an optional `--port`, and
 * the reviewed-forward-migration flags `--apply-migration <delta.sql>` (+ its optional
 * `--allowlist <file.json>`). An unknown flag is a strict parse error (mapped to exit 2).
 */
export function parseDeployArgs(args: readonly string[]): {
  positionals: string[];
  dryRun: boolean;
  port?: string;
  applyMigration?: string;
  allowlist?: string;
} {
  try {
    const { positionals, values } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        'dry-run': { type: 'boolean' },
        port: { type: 'string' },
        'apply-migration': { type: 'string' },
        allowlist: { type: 'string' },
      },
    });
    return {
      positionals,
      dryRun: values['dry-run'] === true,
      ...(values.port !== undefined ? { port: values.port } : {}),
      ...(values['apply-migration'] !== undefined
        ? { applyMigration: values['apply-migration'] }
        : {}),
      ...(values.allowlist !== undefined ? { allowlist: values.allowlist } : {}),
    };
  } catch (e) {
    throw new DeployCliError(`invalid arguments: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The `deploy` entrypoint. Resolves + pre-flight-reads the spec (the same fail-closed path jail + size
 * cap doctor/plan use), then either runs the DB-free `--dry-run` compose (returns a verdict) or boots +
 * serves the deployment (long-running; returns `{kind:'served'}` after the server is listening — the
 * open port + signal handlers keep the process alive until SIGINT/SIGTERM).
 */
export async function runDeploy(args: readonly string[]): Promise<DeployOutcome> {
  const { positionals, dryRun, port, applyMigration, allowlist } = parseDeployArgs(args);

  // Pre-flight the spec path (jail + size cap). assembleServer RE-READS it via RAYSPEC_SPEC_PATH; this
  // early read gives an actionable error before any boot side effect + jails the operator-supplied path.
  let specPath: string;
  let specText: string;
  try {
    specPath = resolveSpecPath(positionals);
    specText = await readSpecFile(specPath);
  } catch (e) {
    if (e instanceof ReadSpecError) throw new DeployCliError(e.message);
    throw e;
  }

  if (dryRun) {
    // --dry-run touches NO DB (it composes against a stubbed rollout), so it can apply no migration —
    // combining it with --apply-migration would silently ignore the delta. Reject the combination.
    if (applyMigration !== undefined || allowlist !== undefined) {
      throw new DeployCliError(
        '--apply-migration/--allowlist cannot be combined with --dry-run (a dry-run touches no DB, ' +
          'so it applies no migration)',
      );
    }
    return { kind: 'dry-run', result: await dryRunCompose(specPath, specText) };
  }

  // Resolve + JAIL the reviewed forward-DELTA (and its optional reviewed allowlist) with the FULL spec-
  // path jail — both are operator-supplied filesystem paths. Each gets BOTH halves the spec path gets:
  // resolveSpecPath (the lexical `..`/absolute jail on the typed string) AND readSpecFile (the realpath
  // symlink RE-jail + regular-file check + MAX_SPEC_BYTES cap). The pre-flight readSpecFile's returned
  // text is DISCARDED here — the boot re-reads the file via env (RAYSPEC_UPDATE_MIGRATION /
  // RAYSPEC_UPDATE_ALLOWLIST) through the gated deploy() engine (product profile: directly in product-
  // boot; backend profile: via serve-opts). Its purpose is the JAIL: without it the delta/allowlist would
  // get ONLY the lexical jail and the boot's later plain readFileSync FOLLOWS symlinks with no re-jail and
  // no size cap — so a delta symlink whose REAL target is OUTSIDE the cwd, or an oversized file, would slip
  // the lexical jail. This closes that gap (a symlink-escape / oversized file is refused up front with a
  // secret-free ReadSpecError), matching the spec path exactly.
  let migrationPath: string | undefined;
  let allowlistPath: string | undefined;
  try {
    if (applyMigration !== undefined) {
      migrationPath = resolveSpecPath([applyMigration]);
      await readSpecFile(migrationPath);
    }
    if (allowlist !== undefined) {
      allowlistPath = resolveSpecPath([allowlist]);
      await readSpecFile(allowlistPath);
    }
  } catch (e) {
    if (e instanceof ReadSpecError) throw new DeployCliError(e.message);
    throw e;
  }
  // The allowlist only REVIEWS a delta's destructive statements — a bare --allowlist would be silently
  // ignored (the boot reads it only in update mode). Refuse it as a usage error rather than no-op.
  if (allowlistPath !== undefined && migrationPath === undefined) {
    throw new DeployCliError(
      '--allowlist requires --apply-migration (the allowlist reviews the delta destructive statements)',
    );
  }

  await serveDeployment(specPath, port, migrationPath, allowlistPath);
  return { kind: 'served' };
}

/**
 * `--dry-run`: parse the product doc + COMPOSE it against a STUBBED rollout — NO DB, NO network. The
 * store bindings come from the REAL `deriveProductStores` (so a store/collection mismatch is caught);
 * the runtime-only instances (the durable enqueuer, the STT adapter, the extraction executors, the
 * conversation responder, the file blob reader) are inert stubs that compose only checks for PRESENCE,
 * never invokes. It proves the doc VALIDATES and COMPOSES against the wired surface — and nothing more.
 */
async function dryRunCompose(specPath: string, specText: string): Promise<DeployDryRunResult> {
  const base = {
    ok: false as const,
    mode: 'dry-run' as const,
    spec: specPath,
    notProven: DRY_RUN_NOT_PROVEN,
  };
  const { parseProductSpec } = await import('@rayspec/spec');
  const {
    composeCapabilityStores,
    composeProductDeploy,
    declaresConversationInput,
    declaresFileInput,
    deriveProductStores,
  } = await import('@rayspec/product-yaml');

  // parseProductSpec returns a fail-closed Result — unwrap it (the caller must check `ok` before
  // touching `value`); a validation failure surfaces every SpecError verbatim.
  const parsed = parseProductSpec(specText);
  if (!parsed.ok) {
    return {
      ...base,
      errors: parsed.errors.map(
        (err) =>
          `spec did not validate: ${err.code}${err.path ? ` at ${err.path}` : ''}: ${err.message}`,
      ),
    };
  }
  const spec = parsed.value;

  try {
    const capabilityStores = composeCapabilityStores(spec);
    const derived = deriveProductStores(spec, capabilityStores.names);

    const usesStt = spec.workflows.some((wf) => wf.steps.some((s) => s.use?.startsWith('stt.')));
    const hasExtractors = spec.extractors.length > 0;
    const usesParseText = spec.workflows.some((wf) =>
      wf.steps.some((s) => s.use === 'file_input.parse_text'),
    );
    const withConversation = declaresConversationInput(spec);
    const withFile = declaresFileInput(spec);

    // A rollout typed against @rayspec/product-yaml; only the runtime-only instances are inert stubs
    // (compose presence-checks them, never calls them). Real store bindings come from deriveProductStores.
    const rollout: ProductYamlRollout = {
      tenantId: '00000000-0000-4000-8000-000000000000',
      // Never enqueues in a dry-run (no trigger fires) — a throwing stub proves that.
      enqueuer: {
        enqueueWorkflowRun: () => {
          throw new Error('dry-run: enqueuer must not be called');
        },
      } as ProductYamlRollout['enqueuer'],
      stores: derived.stores,
      ...(derived.transcripts ? { transcripts: derived.transcripts } : {}),
      artifactCollections: derived.artifactCollections,
      ...(usesStt
        ? { stt: { adapter: {} as unknown as NonNullable<ProductYamlRollout['stt']>['adapter'] } }
        : {}),
      // A `.has()`-only executor registry: compose verifies coverage via agents.has(`agent.<id>`).
      ...(hasExtractors
        ? { agents: { has: () => true } as unknown as ProductYamlRollout['agents'] }
        : {}),
      ...(withConversation
        ? {
            conversation: {
              responder: (() => {
                throw new Error('dry-run: responder must not be called');
              }) as unknown as NonNullable<ProductYamlRollout['conversation']>['responder'],
            },
          }
        : {}),
      ...(withFile
        ? {
            file: {
              ...(usesParseText
                ? {
                    blob: (() => {
                      throw new Error('dry-run: blob reader must not be called');
                    }) as unknown as NonNullable<ProductYamlRollout['file']>['blob'],
                  }
                : {}),
            },
          }
        : {}),
    };

    const composed = composeProductDeploy(spec, rollout);
    return {
      ...base,
      ok: true,
      composed: {
        product: spec.product.id,
        stores: composed.engineSpec.stores.map((s) => s.name),
        viewRoutes: [...composed.viewRoutes],
        triggerEvents: [...composed.triggerEvents],
        workflows: [...composed.workflows.keys()],
      },
      errors: [],
    };
  } catch (e) {
    return { ...base, errors: [`spec did not compose against the wired surface: ${errText(e)}`] };
  }
}

/**
 * Boot + SERVE the deployment (long-running). Wraps `assembleServer` (NOT the kill-set `deploy()`),
 * building its deployer-seam opts from the SHARED `assembleOptsFromEnv` builder (the sanctioned
 * validating registrar as the product-table hook + an env-driven agent-backend factory when the spec is
 * a backend-profile doc WITH agents — so `rayspec deploy <backend-spec-with-agents>` boots those agents
 * directly, parity with rayspec-serve), then SEALS the door (deploy owns its process + boots once). On a
 * fail-closed boot error (missing env / a missing agent credential surfacing as a BootConfigError, an
 * unreviewed destructive migration via DeployError, a product-boot misconfig) it prints an actionable
 * message + exits 1 (mirrors deployments/acme-notes/serve.mts). Returns once the server is listening;
 * the open port + SIGINT/SIGTERM handlers keep the process alive.
 */
export async function serveDeployment(
  specPath: string,
  portOverride?: string,
  migrationPath?: string,
  allowlistPath?: string,
): Promise<void> {
  // RAYSPEC_SPEC_PATH is how loadServerConfig/assembleServer find the doc — set it from the positional
  // (the operator typed the path once). An explicit --port overrides the PORT env.
  process.env.RAYSPEC_SPEC_PATH = specPath;
  if (portOverride !== undefined) process.env.PORT = portOverride;

  // The reviewed forward-DELTA apply seam. Setting RAYSPEC_UPDATE_MIGRATION (from --apply-migration)
  // switches the boot into UPDATE mode: the gated deploy() engine scans the delta (a DESTRUCTIVE
  // statement WITHOUT a covering reviewed --allowlist entry is BLOCKED with a DeployError) then applies
  // it IN PLACE, so existing rows survive. Both profiles reach it: a product-profile boot reads this env
  // DIRECTLY in product-boot; a backend-profile boot reaches deploy()'s DeployConfig.migrations seam via
  // assembleOptsFromEnv (serve-opts.ts).
  //
  // LEFTOVER-ENV REBOOT SEMANTICS (honest): a delta is NON-IDEMPOTENT, and this env PERSISTS in the
  // process — a process manager (systemd/docker `Restart=always`) that RESTARTS the command with
  // --apply-migration still present re-enters update mode on the next boot. BOTH profiles are reboot-safe
  // by construction: they CLASSIFY the live schema FIRST and MOUNT a present-matching schema (the delta
  // already landed on a prior boot) instead of re-applying a non-idempotent delta and crash-looping on a
  // duplicate_column (42701) — the PRODUCT profile in product-boot, the BACKEND profile in the
  // composition root's update branch (both route through the shared planUpdateBoot). Leaving
  // --apply-migration in a process-managed unit is therefore SAFE (it applies once, mounts thereafter);
  // still, drop it once the delta has landed to keep the operator intent explicit.
  if (migrationPath !== undefined) process.env.RAYSPEC_UPDATE_MIGRATION = migrationPath;
  if (allowlistPath !== undefined) process.env.RAYSPEC_UPDATE_ALLOWLIST = allowlistPath;

  // Dynamic imports: keep DBOS/Hono/the adapters + product-yaml OUT of `rayspec doctor`'s load path.
  const { serve } = await import('@hono/node-server');
  const {
    assembleOptsFromEnv,
    assembleServer,
    BootConfigError,
    bootBanner,
    DeployError,
    loadServerConfig,
  } = await import('@rayspec/server');
  const { sealProductStores } = await import('@rayspec/db/composition');

  let server: Awaited<ReturnType<typeof assembleServer>>;
  try {
    const config = loadServerConfig();
    // Build the deployer-seam opts from the SAME shared builder rayspec-serve uses: the sanctioned
    // validating registrar (registerProductStores) for ANY spec, PLUS an env-driven agentBackendsFactory
    // when the spec is a backend-profile doc WITH agents — so `rayspec deploy <backend-spec-with-agents>`
    // boots the declared agents directly (parity with rayspec-serve), not just the bare registrar. A
    // missing agent credential surfaces as a fail-closed BootConfigError the catch below clean-prints.
    server = await assembleServer(config, assembleOptsFromEnv(config));
    // Shut the sanctioned door after the ONE boot registration (deploy owns its process, boots once).
    sealProductStores();

    const httpServer = serve({ fetch: server.app.fetch, port: config.port }, (info) => {
      console.log(bootBanner(server, `http://127.0.0.1:${info.port}`));
    });

    const shutdown = (signal: string): void => {
      console.log(`\n[rayspec deploy] ${signal} received — shutting down…`);
      httpServer.close(async () => {
        await server.close();
        process.exit(0);
      });
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    // DeployError is the roll-out gate's fail-closed signal — re-surface it actionably, pointing at the
    // sanctioned registration path (a verify-not-register failure means the product tables were not
    // registered through registerProductTables → registerProductStores).
    if (err instanceof DeployError) {
      console.error(
        `[rayspec deploy] roll-out refused: ${err.message}\n` +
          '    (the product stores are registered through the sanctioned registerProductTables ' +
          'hook → @rayspec/db/composition registerProductStores; a verify-not-register failure ' +
          'means the built tables did not reach the deny-by-default chokepoint Set.)',
      );
    } else if (err instanceof BootConfigError) {
      console.error(`[rayspec deploy] ${err.message}`);
    } else {
      console.error(
        '[rayspec deploy] boot failed:',
        err instanceof Error ? err.stack : String(err),
      );
    }
    process.exit(1);
  }
}

/** A secret-free message from an unknown throw (never echoes env/DB values). */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
