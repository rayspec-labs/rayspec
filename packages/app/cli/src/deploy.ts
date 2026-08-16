/**
 * `rayspec deploy` — the PRODUCTION-MUTATING boot command (distinct from the read-only diagnostic
 * floor and the local-dev `dev` group). Two modes:
 *
 *   rayspec deploy <spec.yaml>              LONG-RUNNING: assemble the platform from the ambient env,
 *                                            register the product stores through the SANCTIONED
 *                                            validating registrar, apply the committed migration chain
 *                                            + roll out the declared product, and SERVE on PORT until
 *                                            SIGINT/SIGTERM. Mutates the target DB (materialize/mount).
 *   rayspec deploy --dry-run <spec.yaml>    ONE-SHOT: validate the document with the grammar of the
 *                                            profile it boots — and, for a product doc, COMPOSE it
 *                                            against a stubbed rollout (NO DB, NO network). Emits a
 *                                            JSON verdict.
 *   rayspec deploy --check-env <spec.yaml>  ONE-SHOT: enumerate the environment variables THIS document's
 *                                            boot will require, with their <VAR>_FILE equivalents and
 *                                            their set/unset state. Reads the document AND the
 *                                            environment; opens no socket, no database and no
 *                                            credential, and loads no extension pack. Emits a JSON
 *                                            verdict.
 *
 * WHAT deploy IS. It is `deployments/acme-notes/serve.mts` as a first-class operator command: it wraps
 * `assembleServer` (NOT the frozen-surface `deploy()` — that stays inside the composition root) and injects
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

import { type ParseArgsConfig, parseArgs } from 'node:util';
import type { ProductYamlRollout } from '@rayspec/product-yaml';
// TYPE-ONLY (erased at runtime): the shape of the boot-environment report `--check-env` emits. The
// FUNCTION that produces it is imported dynamically, on that flag's path alone, so a `deploy` without
// it — and every other subcommand — loads none of @rayspec/server.
import type { BootEnvReport } from '@rayspec/server/boot-env';
import type { FrontendSpec, SpecError } from '@rayspec/spec';
import { parseFromDeploymentTree, withClaimedSections } from './pack-sections.js';
import { dotenvCandidatePaths } from './read-env.js';
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
  /**
   * What the DB-free detection found when the doc is FRONTEND-ONLY (a static profile), else absent —
   * the counterpart of `composed` for the one document shape there is nothing to compose for. Reported
   * INSTEAD of a compose summary; a product/backend doc's verdict carries `composed` as before.
   */
  readonly staticProfile?: {
    /** The boot profile the doc selects — the DB-less, auth-less static boot. */
    readonly profile: 'static';
    /**
     * The frontend mounts that boot would serve (route → dir, plus the per-mount `spa` SPA-fallback
     * and `cleanUrls` extensionless-resolution flags — every declared mount option, so the preview
     * names the resolution boot will actually use).
     */
    readonly frontendMounts: readonly FrontendSpec[];
    /** What such a deploy does NOT do — stated outright rather than left to inference. */
    readonly notes: readonly string[];
  };
  /**
   * What the DB-free validation found when the doc is the BACKEND profile (a `version:'1.0'` doc with
   * no `product:` section), else absent — the counterpart of `composed` for the profile whose
   * declarations are MOUNTED rather than composed. Reported INSTEAD of a compose summary.
   *
   * DECLARED NAMES ONLY — read straight off the document `parseSpec` validated, with no SQL and
   * nothing derived. It covers the sections `plan` also projects (`stores`, `routes`, `agents`) plus
   * the declared handler ids, but it is NOT `plan`'s payload: `plan` publishes no handlers at all, and
   * its stores/routes are richer objects (column and FK counts; `{method,path,action}`). This is the
   * name-level view, in the vocabulary `composed` already uses for a route. `ok:true` beside it means
   * the document VALIDATES — never that it boots; `notProven` names the boot refusals it can still meet.
   */
  readonly backendProfile?: {
    /** The boot profile the doc selects — the backend (RaySpec) boot. */
    readonly profile: 'rayspec';
    /** The declared store names (the tables that boot materializes or mounts). */
    readonly stores: readonly string[];
    /** The declared routes as `METHOD /path` (the shape `composed.viewRoutes` uses). */
    readonly routes: readonly string[];
    /** The declared agent ids. */
    readonly agents: readonly string[];
    /** The declared handler ids (the escape-hatch modules that boot loads). */
    readonly handlers: readonly string[];
    /**
     * The frontend mounts declared ALONGSIDE the backend, when there are any — omitted otherwise, so a
     * document with no `frontend:` section keeps the payload it had. Surfaced because this profile's
     * boot GATES on them: `deployDeclaredSpec` refuses fail-closed on a mount whose directory is
     * missing/unreadable or whose `spa` mount has no index.html, and that refusal is the one a backend
     * document meets most often (`examples/notes-ui` is exactly this shape). The matching `notProven`
     * line says what was NOT checked; this says what will BE checked. Each mount is echoed WHOLE —
     * `route`, `dir` and both mount options (`spa`, `cleanUrls`) — the same shape `staticProfile`
     * reports, so a mount option means one thing across the two profiles.
     */
    readonly frontendMounts?: readonly FrontendSpec[];
  };
  /** The fail-closed reasons compose/parse rejected the doc (ok:false). */
  readonly errors: readonly string[];
  /** The honest boundary — what --dry-run does NOT prove. */
  readonly notProven: readonly string[];
  /**
   * ONE neutral line per top-level section an extension pack on this deployment claims, naming the
   * section key and the pack that owns it — the same line `plan` and `doctor` report, from the same
   * loader run against the same deployment tree. Present only for a document that references a pack
   * and validated, so every other verdict keeps the exact key set it had. NEVER affects `ok` — and
   * where `ok:true` here is furthest from "it boots", `notProven` says so in the same verdict.
   */
  readonly claimedSections?: readonly string[];
}

/** What `--dry-run` deliberately does NOT prove (surfaced in the result + `--help`). */
const DRY_RUN_NOT_PROVEN = [
  'the migration (no DB was touched)',
  'boot-env sufficiency (secrets / blob root / media key are not read)',
  'any provider credential (STT / extraction / responder are stubbed)',
  'live-schema drift against an existing deployment',
  'that the app actually serves (no port was bound)',
] as const;

/** The work a FRONTEND-ONLY (static-profile) deploy does not do — the substance of its dry-run verdict. */
const STATIC_PROFILE_NOTES = [
  'no database is touched (the static boot opens none)',
  'no migration applies (the static boot reaches no migration engine)',
  'there is nothing to compose (the document declares no store, route, trigger, or workflow)',
] as const;

/**
 * What a STATIC-PROFILE `--dry-run` does NOT prove. The DB/provider entries of DRY_RUN_NOT_PROVEN do not
 * apply to a boot that opens no database and stubs no adapter; what stays unproven is the filesystem the
 * mounts point at (only the document was read) and the serve itself.
 */
const STATIC_DRY_RUN_NOT_PROVEN = [
  'that the declared frontend directories exist or hold built assets (only the document was read)',
  'that the app actually serves (no port was bound)',
] as const;

/**
 * What a BACKEND-PROFILE `--dry-run` does NOT prove. The shared boundary applies in full (that boot
 * does touch a database, does apply the migration chain and does read secrets), so this EXTENDS
 * DRY_RUN_NOT_PROVEN rather than replacing it — with the boot refusals a document meets AFTER it
 * validates. They are stated here, in the verdict itself, because `ok:true` on this arm means the
 * document VALIDATES, never that it boots.
 */
const BACKEND_DRY_RUN_NOT_PROVEN = [
  ...DRY_RUN_NOT_PROVEN,
  "that the boot accepts the declared routes (a 'stream' route with no blob backend configured is refused fail-closed)",
  'that the declared handler modules resolve (the boot loads compiled JavaScript only, under the jailed root)',
  'any speech capability the handlers reach for (selecting STT_PROVIDER / TTS_PROVIDER makes that provider credential a boot demand; leaving one unset is never a boot error)',
  // The refusal a backend document meets most often, and the one the static arm already warns about:
  // this profile's boot GATES on every declared frontend mount (deployDeclaredSpec throws
  // BootConfigError on a missing/unreadable dir, or an `spa` mount with no index.html) where the
  // static boot only degrades its /health. Only the document was read here, so nothing was checked.
  'that the declared frontend directories hold servable built assets (only the document was read; an unservable mount is refused fail-closed at boot)',
] as const;

/**
 * The boundary a CLAIMED SECTION has, and the one entry above that is NOT a refusal met after the
 * document validates: it is met INSTEAD of the validation this arm just ran. This preview validates
 * the document with the deployment's packs loaded, so a top-level key a pack claims is judged by its
 * owner. The boot does not: `deployDeclaredSpec` re-reads the document and validates it with the CORE
 * grammar alone BEFORE it resolves a single pack, and that grammar rejects every key it does not own.
 * `--check-env`, which reads the boot's own module, reports exactly that refusal for such a document.
 *
 * So it is stated, in the verdict, rather than left for a `deploy` to discover — a claimed section is
 * the one shape for which `ok:true` here is furthest from "it boots".
 *
 * APPENDED FOR A DOCUMENT THAT WRITES ONE, NOT FOR ONE WHOSE PACKS CLAIM ONE. The two differ, and the
 * entry is only true of the first: what a pack claims is a fact about the deployment, while the boot's
 * core-grammar parse meets what the DOCUMENT wrote. A document that references a claiming pack and
 * writes none of the keys it claims is written entirely in the grammar the boot has — it carries the
 * claim line, and `--check-env` reports no refusal for it, so appending this entry there would send an
 * operator to look for a refusal that is not there. That is the wrong-remedy report this seam exists to
 * remove, and it would be reintroduced on the surface added to be honest about the boot. Every verdict
 * that does not write a claimed key therefore keeps the boundary list it had.
 */
const BOOT_DOES_NOT_ACCEPT_A_CLAIMED_SECTION =
  'that the boot accepts a top-level section an extension pack claims: this preview validated the ' +
  "document with the deployment's packs loaded, but the boot validates it with the core grammar " +
  'alone before it resolves any pack, and that grammar rejects a key it does not own (`--check-env`, ' +
  "which reads the boot's own module, reports that refusal for this document)";

/**
 * The `--check-env` verdict (JSON, stdout). It is the `@rayspec/server` boot-environment report — the
 * demands the BOOT itself raises, read out of the one module that states them — plus the ONE fact only
 * the CLI knows: which `.env` files its auto-loader searched before this environment was read.
 *
 * That last field exists because "unset" is the answer an operator is most likely to dispute, and the
 * usual cause is a populated `.env` that was never a candidate (the same diagnostic the missing-required
 * boot refusal appends as its `(searched: …)` suffix). PATHS ONLY — never file contents, never a value.
 * Empty under `RAYSPEC_SKIP_DOTENV=1`: nothing was searched, so claiming otherwise would be false.
 */
export interface DeployCheckEnvResult extends BootEnvReport {
  /** The `.env` candidate paths the auto-loader searched, in precedence order (paths only). */
  readonly searchedDotenv: readonly string[];
}

/**
 * The discriminated outcome of `runDeploy`: a one-shot verdict to emit (`--dry-run` or `--check-env`),
 * or a served (long-running) boot.
 */
export type DeployOutcome =
  | { readonly kind: 'dry-run'; readonly result: DeployDryRunResult }
  | { readonly kind: 'check-env'; readonly result: DeployCheckEnvResult }
  | { readonly kind: 'served' };

/**
 * `deploy`'s option set — the ONE declaration of which flags the command takes, hoisted out of the
 * `parseArgs` call below so it is readable as a VALUE. `parseDeployArgs` is its only runtime
 * consumer and passes it through unchanged, so the grammar is exactly what it always was.
 *
 * It is exported because the flag set is checked against the prose in `docs/cli-reference.md`, and
 * nothing else in the repository enumerated it: that check used to recover the names with a regular
 * expression over this file's own source text, which made a documentation test depend on how this
 * literal happens to be formatted — a comment added next to an option, or a key written before
 * `type`, was enough to make it miss a flag. Importing the declaration removes that coupling.
 */
export const DEPLOY_ARG_OPTIONS = {
  'dry-run': { type: 'boolean' },
  'check-env': { type: 'boolean' },
  port: { type: 'string' },
  host: { type: 'string' },
  'apply-migration': { type: 'string' },
  allowlist: { type: 'string' },
} as const satisfies NonNullable<ParseArgsConfig['options']>;

/**
 * Parse `deploy`'s args: exactly one positional spec path, plus `--dry-run` / `--check-env`, an optional
 * `--port` and `--host` (the listen interface — LOOPBACK unless explicitly set), and the
 * reviewed-forward-migration flags `--apply-migration <delta.sql>` (+ its optional
 * `--allowlist <file.json>`). An unknown flag is a strict parse error (mapped to exit 2).
 */
export function parseDeployArgs(args: readonly string[]): {
  positionals: string[];
  dryRun: boolean;
  checkEnv: boolean;
  port?: string;
  host?: string;
  applyMigration?: string;
  allowlist?: string;
} {
  try {
    const { positionals, values } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: DEPLOY_ARG_OPTIONS,
    });
    return {
      positionals,
      dryRun: values['dry-run'] === true,
      checkEnv: values['check-env'] === true,
      ...(values.port !== undefined ? { port: values.port } : {}),
      ...(values.host !== undefined ? { host: values.host } : {}),
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
 * serves the deployment (long-running; returns `{kind:'served'}` once the listener has been CREATED,
 * with the bind still pending — a failed bind is refused by the listener's own `'error'` handler, not
 * through this return — and the open port + signal handlers keep the process alive until
 * SIGINT/SIGTERM).
 */
export async function runDeploy(args: readonly string[]): Promise<DeployOutcome> {
  const { positionals, dryRun, checkEnv, port, host, applyMigration, allowlist } =
    parseDeployArgs(args);
  // The two one-shot modes answer different questions and neither is a stage of the other: --dry-run
  // reads the DOCUMENT, --check-env reads the document AND THE ENVIRONMENT. Accepting both would have to
  // pick one verdict to print and silently drop the other, so refuse the combination outright.
  if (dryRun && checkEnv) {
    throw new DeployCliError(
      '--dry-run and --check-env cannot be combined (each emits its own one-shot verdict); run them ' +
        'one at a time',
    );
  }

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

  if (checkEnv) {
    // Same rule, same reason: --check-env opens no database, so a reviewed delta handed to it would be
    // accepted and then dropped behind a verdict that says nothing about it.
    if (applyMigration !== undefined || allowlist !== undefined) {
      throw new DeployCliError(
        '--apply-migration/--allowlist cannot be combined with --check-env (a check-env touches no ' +
          'DB, so it applies no migration)',
      );
    }
    return { kind: 'check-env', result: await checkDeployEnv(specPath, specText) };
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
  // Same rule, third database-free path: a FRONTEND-ONLY (static-profile) document takes the DB-less
  // static boot, which — exactly like --dry-run — touches no database and so can apply no migration.
  // Refuse the combination up front rather than accepting the reviewed delta and dropping it behind a
  // green boot banner. Checked with the SAME predicate the boot branch uses (isStaticProfile, which
  // already proves the doc parses as a backend RaySpec with a non-empty frontend), against the spec
  // text the pre-flight read returned. Reached ONLY when the operator passed the flag, so the
  // @rayspec/server import stays off the flagless path (it is dynamic here for the same reason it is
  // in serveDeployment: `rayspec doctor` must not drag the boot dependencies in).
  if (migrationPath !== undefined) {
    const { isStaticProfile } = await import('@rayspec/server');
    if (isStaticProfile(specText)) {
      throw new DeployCliError(
        '--apply-migration/--allowlist cannot be combined with a frontend-only (static-profile) ' +
          'document (it boots the static profile, which touches no database, so it applies no ' +
          'migration)',
      );
    }
  }

  await serveDeployment(specPath, port, migrationPath, allowlistPath, host);
  return { kind: 'served' };
}

/**
 * `--check-env`: enumerate the boot-environment demands of THIS document against THIS environment, and
 * report each one's set/unset state — WITHOUT attempting a boot. It answers the question `doctor`,
 * `plan` and `--dry-run` leave open and that only a refused `deploy` used to answer — and that answer
 * is not cheap: the demands a declared `stream` route, playback route or `cron` trigger raise are
 * reached only AFTER the boot has opened the database and applied the whole committed migration
 * chain.
 *
 * IT IS NOT A CLI-SIDE REIMPLEMENTATION. The demands come from `@rayspec/server`'s own
 * `checkBootEnv` — the module the boot refusals themselves are composed from — so a demand the boot
 * raises is a demand this prints. A CLI-side copy would fail OPEN: it would report a clean environment
 * for every demand it had not been taught about, which is exactly the failure this command exists to
 * prevent. Imported through the `@rayspec/server/boot-env` SUBPATH, which pulls in no adapter, no
 * durable engine and no database driver — the same reason `serveDeployment` reaches for the
 * `agent-tracing` subpath before the barrel.
 *
 * NO PACK IS LOADED. An extension pack is arbitrary code; running it is precisely what would open a
 * socket, a database or a credential, which is the promise this command is FOR. The consequence runs in
 * both directions — a pack can supply a blob backend that REMOVES a demand, and it ADDS demands two
 * ways: a contributed `kind:'stream'` / `mode:'playback'` route raises the blob-root and media-key
 * demands, and a contributed agent raises its backend's credential demand. The boot guards ask their
 * questions of the POST-merge document; this reads the base one. That is stated in the verdict's
 * `notChecked`, which also NAMES the packs the document declares, rather than left for the operator to
 * discover from a refusal.
 *
 * NO VALUE IS PRINTED. Every variable is reported as a `set` boolean; no environment value, no `.env`
 * content and no secret-file content is read out or echoed.
 */
async function checkDeployEnv(specPath: string, specText: string): Promise<DeployCheckEnvResult> {
  const { checkBootEnv } = await import('@rayspec/server/boot-env');
  const report = await checkBootEnv(specPath, specText, process.env);
  return {
    ...report,
    searchedDotenv: process.env.RAYSPEC_SKIP_DOTENV === '1' ? [] : dotenvCandidatePaths(),
  };
}

/** Render a parser's `SpecError`s as the verdict's `errors` lines — one wording, whichever grammar judged the doc. */
function specDidNotValidate(errors: readonly SpecError[]): string[] {
  return errors.map(
    (err) =>
      `spec did not validate: ${err.code}${err.path ? ` at ${err.path}` : ''}: ${err.message}`,
  );
}

/**
 * `--dry-run`: validate the document + (product profile) COMPOSE it against a STUBBED rollout — NO DB,
 * NO network. The store bindings come from the REAL `deriveProductStores` (so a store/collection
 * mismatch is caught); the runtime-only instances (the durable enqueuer, the STT adapter, the
 * extraction executors, the conversation responder, the file blob reader) are inert stubs that compose
 * only checks for PRESENCE, never invokes. It proves the doc VALIDATES and COMPOSES against the wired
 * surface — and nothing more.
 *
 * It dispatches on the document PROFILE BEFORE parsing (the order `runPlan` uses), so each of the three
 * profiles `deploy` boots is judged by the grammar that boot uses and the verdict never reports one
 * profile's document in another's vocabulary:
 *
 *   • PRODUCT  — `parseProductSpec` + compose, the summary in `composed`.
 *   • FRONTEND-ONLY (static) — nothing to compose; its mounts ARE the plan. Classified with the SAME
 *     shared `detectStaticProfile` the boot branches on, so the check and the boot cannot disagree.
 *   • BACKEND (`rayspec`) — `parseSpec`, the parser `doctor` and `plan` use for it; the declarations go
 *     in `backendProfile`. Its verdict is `ok:true` for a document those two commands accept, and its
 *     OWN violations (a dangling reference, an unknown key) for one they reject.
 *
 * ORDER IS LOAD-BEARING between the last two: a static-profile document is a backend document with a
 * frontend section, so `parseSpec` ACCEPTS it — `detectSpecKind` calls both `'rayspec'` and cannot tell
 * them apart. The static classification therefore runs FIRST; a backend arm ahead of it would swallow
 * the `staticProfile` verdict.
 *
 * Both non-product arms sit behind the `detectSpecKind` check, so no product document — valid or still
 * being fixed — pays for the boot-side import: @rayspec/server's barrel re-exports the boot dependency
 * graph (the durable engine, the model adapters, the postgres driver). Keyed on the same `product:`
 * discriminant `isStaticProfile` fails closed on in its own first line — "a product-profile doc is
 * categorically never static", the invariant static-profile.test.ts pins. Dynamic for the same reason it
 * is dynamic in serveDeployment: `rayspec doctor` must not drag the boot dependencies in. The
 * product-yaml compose graph is imported on the product arm alone, on exactly the same terms.
 */
async function dryRunCompose(specPath: string, specText: string): Promise<DeployDryRunResult> {
  const base = {
    ok: false as const,
    mode: 'dry-run' as const,
    spec: specPath,
    notProven: DRY_RUN_NOT_PROVEN,
  };

  const { detectSpecKind, parseProductSpec, parseSpec } = await import('@rayspec/spec');

  if (detectSpecKind(specText) !== 'product') {
    const { detectStaticProfile } = await import('@rayspec/server');
    const staticBoot = detectStaticProfile(specPath);
    if (staticBoot) {
      return {
        ...base,
        ok: true,
        staticProfile: {
          profile: 'static',
          frontendMounts: staticBoot.frontend,
          notes: STATIC_PROFILE_NOTES,
        },
        errors: [],
        notProven: STATIC_DRY_RUN_NOT_PROVEN,
      };
    }
    // The BACKEND profile — the shape `serveDeployment` boots through assembleServer. There is nothing
    // to compose (a backend document declares its own routes/handlers rather than lowering to them), so
    // the verdict is the validation `doctor` runs plus the names the document declares.
    //
    // It is the validation `doctor` runs including its packs: this is the profile whose grammar carries
    // `extensions[]`, and the boot this previews resolves them from this same deployment tree. A
    // document with no pack takes the unchanged `parseSpec` and is unaffected.
    const fromTree = await parseFromDeploymentTree(specPath, specText);
    const backend =
      fromTree === undefined
        ? parseSpec(specText)
        : fromTree.spec !== undefined
          ? ({ ok: true, value: fromTree.spec } as const)
          : ({ ok: false, errors: fromTree.errors } as const);
    if (!backend.ok) return { ...base, errors: specDidNotValidate(backend.errors) };
    // A backend document MAY also declare frontend mounts (examples/notes-ui does). It is not the
    // static profile — it boots the full platform, which GATES on every mount — so the mounts are
    // reported here rather than silently dropped; omitted entirely when the document declares none.
    const mounts = backend.value.frontend ?? [];
    const claimedSections = fromTree?.claimedSections ?? [];
    // The claim LINE rides every document whose packs claim a section; the boot BOUNDARY rides only a
    // document that actually writes one, which is the only document the boot's core-grammar parse
    // refuses. See the constant.
    const writtenSections = fromTree?.writtenSections ?? [];
    return withClaimedSections(
      {
        ...base,
        ok: true,
        backendProfile: {
          profile: 'rayspec',
          stores: backend.value.stores.map((store) => store.name),
          routes: backend.value.api.map((route) => `${route.method} ${route.path}`),
          agents: backend.value.agents.map((agent) => agent.id),
          handlers: backend.value.handlers.map((handler) => handler.id),
          ...(mounts.length > 0 ? { frontendMounts: mounts } : {}),
        },
        errors: [],
        // A claimed section the document WROTE is also a boundary this preview does not cross.
        notProven:
          writtenSections.length > 0
            ? [...BACKEND_DRY_RUN_NOT_PROVEN, BOOT_DOES_NOT_ACCEPT_A_CLAIMED_SECTION]
            : BACKEND_DRY_RUN_NOT_PROVEN,
      },
      claimedSections,
    );
  }

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
  if (!parsed.ok) return { ...base, errors: specDidNotValidate(parsed.errors) };
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
 * Boot + SERVE the deployment (long-running). Wraps `assembleServer` (NOT the frozen-surface `deploy()`),
 * building its deployer-seam opts from the SHARED `assembleOptsFromEnv` builder (the sanctioned
 * validating registrar as the product-table hook + an env-driven agent-backend factory when the spec is
 * a backend-profile doc WITH agents — so `rayspec deploy <backend-spec-with-agents>` boots those agents
 * directly, parity with rayspec-serve), then SEALS the door (deploy owns its process + boots once). On a
 * fail-closed boot error (missing env / a missing agent credential surfacing as a BootConfigError, an
 * unreviewed destructive migration via DeployError, a product-boot misconfig) it prints an actionable
 * message + exits 1 (mirrors deployments/acme-notes/serve.mts). Returns once the listener has been
 * CREATED, with the bind still PENDING — `serve()` does not wait for it, which is why a taken port is
 * refused by that listener's own `'error'` handler (attachBindRefusal) and never by the catch below;
 * the open port + SIGINT/SIGTERM handlers keep the process alive.
 *
 * All of the above is the NORMAL boot. A FRONTEND-ONLY (static-profile) spec takes the DB-less /
 * auth-less static boot instead — the same branch rayspec-serve takes, entered BEFORE any secret is
 * read — and is otherwise served identically (same port/host wiring, same signal handling).
 */
export async function serveDeployment(
  specPath: string,
  portOverride?: string,
  migrationPath?: string,
  allowlistPath?: string,
  hostOverride?: string,
): Promise<void> {
  // RAYSPEC_SPEC_PATH is how loadServerConfig/assembleServer find the doc — set it from the positional
  // (the operator typed the path once). An explicit --port overrides the PORT env.
  process.env.RAYSPEC_SPEC_PATH = specPath;
  if (portOverride !== undefined) process.env.PORT = portOverride;
  // A non-loopback bind is an EXPLICIT operator choice: --host sets RAYSPEC_HOST, which loadServerConfig
  // resolves into config.host (unset ⇒ 127.0.0.1 loopback default). Mirrors the --port/PORT wiring.
  if (hostOverride !== undefined) process.env.RAYSPEC_HOST = hostOverride;

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

  // The agent trace export is DEFAULTED OFF on this path, and only on this path. `@openai/agents`
  // exports traces to OpenAI by default; what leaves on that transport is run metadata and, once an
  // agent calls tools, its tool arguments and outputs (the SDK strips the model prompt fields before
  // export). `deploy` is the strongest available signal that the workload running here is somebody
  // else's, so on it the export becomes an affirmative choice — RAYSPEC_AGENT_TRACING=openai —
  // instead of a default. What is deploy-only is that DEFAULT, not the variable: `rayspec-serve` reads
  // the same variable and honours an explicitly stated value (applyServeAgentTracing, issue #383), but
  // keeps the SDK's default when it is unset, because a developer tracing their own agent is looking
  // at their own run — which was never the risk case. The boot wrappers that assemble the server
  // themselves (examples/local-boot, deployments/acme-notes) read it on the same explicit-only terms
  // as `rayspec-serve`; the per-example demo wrappers (examples/<slug>/dev-boot.mjs) read nothing.
  //
  // FIRST, and through the `@rayspec/server/agent-tracing` SUBPATH rather than the barrel below. The
  // agent SDK builds its global trace provider while its module is being evaluated, and that provider
  // SNAPSHOTS the kill-switch it was built with — so a write that lands after `import('@rayspec/server')`
  // (whose closure reaches `@openai/agents` through the adapters) changes nothing. The subpath module
  // pulls in no adapter, so this runs while nothing agent-shaped is loaded yet. It also drives the SDK's
  // own programmatic switch, which covers the shapes where something ELSE already loaded the closure —
  // `--apply-migration`, whose pre-flight imports it above. An unsupported value fail-closes by name
  // here, in the same message-only form the boot refusals below use.
  const { applyDeployAgentTracing, BootConfigError } = await import(
    '@rayspec/server/agent-tracing'
  );
  try {
    await applyDeployAgentTracing();
  } catch (err) {
    if (err instanceof BootConfigError) {
      console.error(`[rayspec deploy] ${err.message}`);
      process.exit(1);
      return; // unreachable in production; keeps a test that stubs process.exit from booting on anyway.
    }
    throw err;
  }

  // Dynamic imports: keep DBOS/Hono/the adapters + product-yaml OUT of `rayspec doctor`'s load path.
  const { serve } = await import('@hono/node-server');
  const {
    assembleOptsFromEnv,
    assembleServer,
    assembleStaticServer,
    attachBindRefusal,
    BootTimeoutError,
    bootBanner,
    bootBaseUrl,
    DeployError,
    detectStaticProfile,
    loadServerConfig,
    loadStaticServerConfig,
    ProductBootError,
    staticBootBanner,
  } = await import('@rayspec/server');
  const { sealProductStores } = await import('@rayspec/db/composition');

  let server: Awaited<ReturnType<typeof assembleServer>>;
  try {
    // Static-profile detection BEFORE the secret-requiring config load: a frontend-only spec boots with
    // NO database/JWT/pepper and mounts NO auth surface (see assembleStaticServer). It branches AWAY
    // from the whole DB/auth composition, so it must run before loadServerConfig (which fail-closes on
    // the three secrets) — and it is what makes `rayspec deploy <frontend-only-spec>` the documented
    // equivalent of `RAYSPEC_SPEC_PATH=<spec> rayspec-serve`. Every non-static deploy is unchanged below.
    // (Nothing to seal here: a static boot registers no product store — it never reaches the chokepoint.)
    // This branch reaches no migration engine, which is why runDeploy REFUSES --apply-migration against
    // a static-profile document up front — the update env above is unreachable here, never ignored.
    // `detectStaticProfile` is the SHARED detection the `rayspec-serve` bin branches on (it lives beside
    // `isStaticProfile` in the composition root), so neither entrypoint carries its own read+classify
    // wrapper that could drift from the other's.
    const staticBoot = detectStaticProfile(specPath);
    if (staticBoot) {
      console.log(
        '[rayspec deploy] booting — static profile (frontend-only): no database, no auth surface…',
      );
      const staticConfig = loadStaticServerConfig();
      const staticServer = assembleStaticServer(staticConfig, staticBoot);
      const httpStatic = serve(
        { fetch: staticServer.app.fetch, hostname: staticConfig.host, port: staticConfig.port },
        (info) => {
          console.log(staticBootBanner(staticServer, bootBaseUrl(info.address, info.port)));
        },
      );
      // `serve()` returns with the bind still PENDING, so a taken port arrives as an `'error'` event
      // rather than as a throw the catch below could see — hence a listener, which answers a
      // collision with one line and re-emits any other listen error untouched (bind-refusal.ts).
      attachBindRefusal(httpStatic, {
        host: staticConfig.host,
        port: staticConfig.port,
        prefix: '[rayspec deploy]',
      });
      const shutdownStatic = (signal: string): void => {
        console.log(`\n[rayspec deploy] ${signal} received — shutting down…`);
        httpStatic.close(async () => {
          await staticServer.close();
          process.exit(0);
        });
      };
      process.on('SIGINT', () => shutdownStatic('SIGINT'));
      process.on('SIGTERM', () => shutdownStatic('SIGTERM'));
      return;
    }

    const config = loadServerConfig();
    // Build the deployer-seam opts from the SAME shared builder rayspec-serve uses: the sanctioned
    // validating registrar (registerProductStores) for ANY spec, PLUS an env-driven agentBackendsFactory
    // when the spec is a backend-profile doc WITH agents — so `rayspec deploy <backend-spec-with-agents>`
    // boots the declared agents directly (parity with rayspec-serve), not just the bare registrar. A
    // missing agent credential surfaces as a fail-closed BootConfigError the catch below clean-prints.
    server = await assembleServer(config, assembleOptsFromEnv(config));
    // Shut the sanctioned door after the ONE boot registration (deploy owns its process, boots once).
    sealProductStores();

    const httpServer = serve(
      { fetch: server.app.fetch, hostname: config.host, port: config.port },
      (info) => {
        // Log the ACTUAL bound address (info.address), never a hard-coded loopback (parity with
        // rayspec-serve) — a non-loopback --host/RAYSPEC_HOST bind must show in the banner.
        console.log(bootBanner(server, bootBaseUrl(info.address, info.port)));
      },
    );
    // The same bind refusal the static branch above attaches: a taken port refuses the boot instead
    // of landing as an unhandled listen `'error'` after the migrations have already been applied.
    attachBindRefusal(httpServer, {
      host: config.host,
      port: config.port,
      prefix: '[rayspec deploy]',
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
    } else if (
      err instanceof BootConfigError ||
      err instanceof ProductBootError ||
      err instanceof BootTimeoutError
    ) {
      // A fail-closed CONFIG abort (a missing secret / a missing agent credential) or a product-boot
      // refusal (a RAYSPEC_PRODUCT_TENANT_ID that is not a valid org UUID or names no live org, an
      // unsupported RAYSPEC_MEDIA_PREP, …) — an operator-actionable message, not an unexpected crash.
      // Print the message only, no stack: absolute paths from the machine that BUILT the artifact tell
      // the operator nothing and bury the one line that does. Anything else is genuinely unexpected and
      // keeps its stack below.
      //
      // This list is meant to stay IDENTICAL to the rayspec-serve entrypoint's
      // (packages/app/server/src/serve.ts): both boot the same spec and must give the same refusal the
      // same treatment. BootTimeoutError is named for that parity alone — withBootTimeout is wired only
      // in serve.ts, so no boot timeout can reach THIS catch; listing it keeps the two lists comparable
      // as wholes instead of leaving a difference that has to be re-justified on every change.
      //
      // A missing-REQUIRED-variable refusal additionally names the `.env` paths the CLI's auto-loader
      // searched — the one fact the operator whose ./.env sits in the invoking project needs.
      console.error(`[rayspec deploy] ${err.message}${missingEnvSearchedSuffix(err.message)}`);
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

/**
 * The trailing "(searched: …)" a MISSING-REQUIRED-VARIABLE boot refusal gains: the `.env` candidate
 * paths the CLI's auto-loader searches (in precedence order — $PWD first, install root second),
 * listed whether or not each file existed — that is the diagnostic: an operator whose ./.env sits in
 * the invoking project sees at once whether the file they populated was even a candidate. Paths only,
 * never file contents or values. Keyed on the two missing-required wordings the boot raises
 * ("required env var(s) missing: …" from loadServerConfig, "<VAR> is required (…)" from the product
 * boot / agent-backend wiring — the wording itself is owned by @rayspec/server); every other refusal
 * (an invalid value, an unsupported option) keeps its bare message. Empty under RAYSPEC_SKIP_DOTENV=1:
 * nothing was searched, so claiming so would be false.
 */
function missingEnvSearchedSuffix(message: string): string {
  if (process.env.RAYSPEC_SKIP_DOTENV === '1') return '';
  if (!/\bis required\b|required env var\(s\) missing/.test(message)) return '';
  return ` (searched: ${dotenvCandidatePaths().join(', ')})`;
}
