/**
 * The boot's ENVIRONMENT DEMANDS — the ONE place that says which variable the boot requires, when, and
 * what it is. A LEAF module: it imports `@rayspec/spec` and nothing else, so a read-only caller can
 * reach the whole demand map without loading the durable engine, the model adapters or the Postgres
 * driver — and so the boot sites below can consume it without a cycle.
 *
 * WHY THIS EXISTS AT ALL. The demands used to live only as inline throws at their use sites, spread
 * across `loadServerConfig`, `makeExtractionBackend`, the deploy guards in `deployDeclaredSpec`, the
 * product boot and the two speech-capability builders. Anything that wanted to ANSWER "what will this
 * document need in its environment?" without attempting a boot had to re-encode that knowledge, and a
 * re-encoding fails OPEN: it reports a clean environment for a demand it never learned about, and the
 * operator finds out from the refusal anyway. So the knowledge moved HERE and the throw sites became
 * its callers. `checkBootEnv` below is the read-only reader (`rayspec deploy --check-env`); the boot is
 * the other one. Neither has its own copy.
 *
 * BEHAVIOUR-NEUTRAL BY CONSTRUCTION. Every refusal this module feeds keeps the wording it had, byte for
 * byte: where a boot site consumes a record, that record carries the exact `what` clause the message
 * already contained — `DATABASE_URL is the Postgres connection string`, `the Deepgram API key
 * (STT_PROVIDER=deepgram)` — so the message is COMPOSED from the record instead of repeating it. The
 * records NO boot site consumes feed only the read-only report and compose no refusal at all; `what`
 * below says which those are and why. Two of the composed wordings are additionally load-bearing
 * OUTSIDE this package: the CLI appends its searched-`.env`-paths diagnostic by matching
 * `required env var(s) missing: …` and `<VAR> is required (…)` (see `missingEnvSearchedSuffix` in
 * packages/app/cli/src/deploy.ts). Both survive here unchanged, and must.
 *
 * WHAT THIS MODULE IS NOT. It is not a registry the boot consults instead of failing closed — the
 * throws stay exactly where they were, at the moment the value is actually needed. It only stops those
 * throws from being the ONLY statement of the demand.
 */

import {
  detectSpecKind,
  experimentalSpecOptionsFromEnv,
  type ProductSpec,
  parseProductSpec,
  parseSpec,
  type RaySpec,
} from '@rayspec/spec';

// ── the variable catalogue ───────────────────────────────────────────────────────────────────────

/**
 * ONE environment variable the boot reads, described once.
 *
 * `what` is what the variable IS, in one clause. For a record a BOOT SITE consumes it is the clause that
 * site's refusal already used, kept verbatim so the refusal is composed from this record rather than
 * restating it — that is what makes those records load-bearing instead of documentation, and it is why
 * editing one of them reds a suite. The others compose no refusal: `RAYSPEC_BLOB_ROOT`,
 * `RAYSPEC_MEDIA_SIGNING_KEY`, `RAYSPEC_CRON_TENANT_ID`, the two anthropic credentials,
 * `RAYSPEC_ANTHROPIC_REUSE_LOGIN`, `TTS_PROVIDER` and `RAYSPEC_FS_SOURCE_ROOT` are imported by no boot
 * site, because their guards say more than a `what` clause can (the anthropic credential names a CHOICE
 * of two; the deploy guards spend a sentence each on what a stream route or a cron trigger is). For
 * those, `what` is the report's own description and changing it changes no refusal — and for four of
 * them it changes nothing at all: `what` is read in exactly one place, `RequirementSet.demand`, so only
 * `RAYSPEC_BLOB_ROOT`, `RAYSPEC_MEDIA_SIGNING_KEY`, `RAYSPEC_CRON_TENANT_ID` and the anthropic
 * `anyOf` PRIMARY reach it. `ANTHROPIC_API_KEY`, `RAYSPEC_ANTHROPIC_REUSE_LOGIN`, `TTS_PROVIDER` and
 * `RAYSPEC_FS_SOURCE_ROOT` appear only as an `optional` row or an `anyOf` sibling, and neither reads
 * `what`. A variable that is
 * demanded from two different places with two different reasons gets two records (`OPENAI_API_KEY` has
 * three: the `openai` extraction backend, the `pi` backend, and `TTS_PROVIDER=openai`), because the
 * reason is what an operator needs and it genuinely differs.
 */
export interface BootEnvVar {
  /** The variable name, as the environment spells it. */
  readonly name: string;
  /**
   * The `<VAR>_FILE` mount that takes PRECEDENCE over the plain variable, for the boot secrets that
   * resolve through `resolveBootSecret`; `null` for every variable read plainly. Only the three boot
   * secrets have one — a `<VAR>_FILE` variant is not a naming convention every variable follows.
   */
  readonly fileVariant: string | null;
  /** What the variable IS — the refusal's own clause, verbatim, wherever a boot site composes from it. */
  readonly what: string;
}

// ── A. UNCONDITIONAL — the three secrets `loadServerConfig` fail-closes on ────────────────────────

/**
 * The three secrets EVERY non-static boot requires, in the order the refusal lists them. Consumed by
 * `loadServerConfig` (composition-root.ts), which resolves them in this order and composes its
 * `required env var(s) missing: …` abort — both the per-variable "X is Y" clauses and the `<VAR>_FILE`
 * list — from these records. Adding a fourth boot secret therefore means adding it here, and the
 * refusal and this catalogue cannot drift apart into disagreeing about what a boot needs.
 *
 * The STATIC (frontend-only) profile requires NONE of them: `loadStaticServerConfig` is branched to
 * BEFORE `loadServerConfig` runs, and a frontend-only deployment must not be handed platform secrets it
 * has no use for. `checkBootEnv` carries that exemption explicitly.
 */
export const SERVER_BOOT_SECRETS: readonly BootEnvVar[] = [
  {
    name: 'DATABASE_URL',
    fileVariant: 'DATABASE_URL_FILE',
    what: 'the Postgres connection string',
  },
  {
    name: 'RAYSPEC_JWT_SIGNING_KEY',
    fileVariant: 'RAYSPEC_JWT_SIGNING_KEY_FILE',
    what: 'the RS256 PKCS#8 PEM',
  },
  {
    name: 'RAYSPEC_API_KEY_PEPPER',
    fileVariant: 'RAYSPEC_API_KEY_PEPPER_FILE',
    what: 'the api-key pepper',
  },
];

/**
 * The OPERATOR PROVISIONING path's own unconditional set — `DATABASE_URL` + `RAYSPEC_API_KEY_PEPPER`,
 * and DELIBERATELY not the JWT signing key (provisioning mints no JWT, so demanding that secret would
 * force an automated job to carry the one secret it can never need). A SEPARATE list from
 * `SERVER_BOOT_SECRETS`, with its own `what` clauses, because the refusal says something different
 * about the same two variables: which database is being provisioned, and why the pepper has to MATCH
 * the target deployment's. Consumed by `loadTenantProvisionSecrets`.
 */
export const PROVISION_BOOT_SECRETS: readonly BootEnvVar[] = [
  {
    name: 'DATABASE_URL',
    fileVariant: 'DATABASE_URL_FILE',
    what: 'the Postgres connection string of the database to provision',
  },
  {
    name: 'RAYSPEC_API_KEY_PEPPER',
    fileVariant: 'RAYSPEC_API_KEY_PEPPER_FILE',
    what:
      'the api-key pepper the invite token is hashed with, and it must be the SAME value the target ' +
      'deployment runs with or the invite can never be redeemed',
  },
];

// ── B. DOCUMENT-CONDITIONAL — demanded iff the deployed document declares the thing ───────────────

/** `RAYSPEC_BLOB_ROOT` — demanded iff a `kind:'stream'` route (or a byte-moving product capability) exists. */
export const BLOB_ROOT: BootEnvVar = {
  name: 'RAYSPEC_BLOB_ROOT',
  fileVariant: null,
  what: 'the writable directory the fs blob backend writes one tenant subdir under',
};

/** `RAYSPEC_MEDIA_SIGNING_KEY` — demanded iff a playback route exists (the `?token=` media-JWT verifier). */
export const MEDIA_SIGNING_KEY: BootEnvVar = {
  name: 'RAYSPEC_MEDIA_SIGNING_KEY',
  fileVariant: null,
  what:
    'the HS256 media-JWT secret a playback route is authenticated by (a DISTINCT key from the RS256 ' +
    'API chain), at least 32 bytes',
};

/**
 * `RAYSPEC_CRON_TENANT_ID` — demanded iff the document declares a `cron` or `manual` trigger.
 *
 * This one demand ALREADY had a read-only surface before this module existed: the spec kernel's lint
 * pass raises a `cron_tenant_required` advisory for every fireable trigger, so `doctor` names the
 * variable. That advisory is necessarily ADVISORY — the lint pass is pure over the document and cannot
 * read an environment, so erroring would reject every valid cron document including the ones that set
 * the variable correctly. `checkBootEnv` is the other half of the same statement rather than a
 * replacement for it: it says the same thing about the same trigger AND reports whether the variable is
 * actually set. Both remain true at once, and neither should ever say the demand is conditional on
 * anything but a declared cron/manual trigger.
 */
export const CRON_TENANT_ID: BootEnvVar = {
  name: 'RAYSPEC_CRON_TENANT_ID',
  fileVariant: null,
  what: 'the org id (8-4-4-4-12 UUID) a cron/manual trigger fires under',
};

/** `RAYSPEC_PRODUCT_TENANT_ID` — the product profile's own unconditional demand. */
export const PRODUCT_TENANT_ID: BootEnvVar = {
  name: 'RAYSPEC_PRODUCT_TENANT_ID',
  fileVariant: null,
  what: 'the deployment tenant every workflow run + dispatcher binds to (single-node posture)',
};

/** `RAYSPEC_EXTRACTION_MODE` — demanded iff a product document declares extractors. */
export const EXTRACTION_MODE: BootEnvVar = {
  name: 'RAYSPEC_EXTRACTION_MODE',
  fileVariant: null,
  what: "the extraction executor: 'live' (real runAgent/gpt-5) | 'deterministic' (injected, dev/CI)",
};

/** `RAYSPEC_RESPONDER_MODE` — demanded iff a product document declares the conversation input. */
export const RESPONDER_MODE: BootEnvVar = {
  name: 'RAYSPEC_RESPONDER_MODE',
  fileVariant: null,
  what:
    "the conversation reply executor: 'live' (real runAgent) | 'deterministic' (injected Backend, " +
    'dev/CI)',
};

/** `RAYSPEC_NORMALIZE_MODE` — demanded iff a product document declares the record input-normalize step. */
export const NORMALIZE_MODE: BootEnvVar = {
  name: 'RAYSPEC_NORMALIZE_MODE',
  fileVariant: null,
  what:
    "the record input-normalize executor: 'live' (real runAgent) | 'deterministic' (injected " +
    'Backend, dev/CI)',
};

// ── the AGENT-BACKEND credentials (document-conditional, raised while the opts are built) ─────────

/**
 * What ONE declared agent backend needs in the environment before it can be constructed.
 *
 * `vars` are ALL required. `anyOf` — used by `anthropic` alone — is a set where ONE set variable is
 * enough; the boot's own refusal for it names both and says "neither is set", which is the same
 * statement read the other way.
 */
export interface AgentBackendDemand {
  /** Variables that must EACH be set. */
  readonly vars: readonly BootEnvVar[];
  /** A set where any ONE being set satisfies the demand (empty when there is no such choice). */
  readonly anyOf: readonly BootEnvVar[];
}

/** `OPENAI_API_KEY` for the `openai` extraction backend. */
export const OPENAI_API_KEY_FOR_OPENAI: BootEnvVar = {
  name: 'OPENAI_API_KEY',
  fileVariant: null,
  what: "the OpenAI API key (extraction backend 'openai')",
};

/** `OPENAI_API_KEY` for the `pi` extraction backend — Pi runs on the same key, for a different reason. */
export const OPENAI_API_KEY_FOR_PI: BootEnvVar = {
  name: 'OPENAI_API_KEY',
  fileVariant: null,
  what: "the OpenAI API key — Pi runs on it (extraction backend 'pi')",
};

/** `CODEX_HOME` for the `codex` extraction backend. */
export const CODEX_HOME: BootEnvVar = {
  name: 'CODEX_HOME',
  fileVariant: null,
  what: "the codex home dir holding the ChatGPT-OAuth auth.json (extraction backend 'codex')",
};

/** `RAYSPEC_ANTHROPIC_CONFIG_ROOT` for the `anthropic` extraction backend. */
export const ANTHROPIC_CONFIG_ROOT: BootEnvVar = {
  name: 'RAYSPEC_ANTHROPIC_CONFIG_ROOT',
  fileVariant: null,
  what: "the per-tenant CLAUDE_CONFIG_DIR root dir (extraction backend 'anthropic')",
};

/** The sanctioned $0 subscription official-harness token for the `anthropic` backend. */
export const CLAUDE_CODE_OAUTH_TOKEN: BootEnvVar = {
  name: 'CLAUDE_CODE_OAUTH_TOKEN',
  fileVariant: null,
  what: "the sanctioned $0 subscription official-harness token (extraction backend 'anthropic')",
};

/** The billed API key alternative for the `anthropic` backend. */
export const ANTHROPIC_API_KEY: BootEnvVar = {
  name: 'ANTHROPIC_API_KEY',
  fileVariant: null,
  what: "the API key that BILLS the Anthropic API (extraction backend 'anthropic')",
};

/** `RAYSPEC_ANTHROPIC_REUSE_LOGIN` — not a demand; it RELAXES the anthropic token demand when truthy. */
export const ANTHROPIC_REUSE_LOGIN: BootEnvVar = {
  name: 'RAYSPEC_ANTHROPIC_REUSE_LOGIN',
  fileVariant: null,
  what:
    'the opt-in that boots the anthropic backend from a SEEDED per-tenant CLAUDE_CONFIG_DIR login ' +
    'instead of a token in the server env (wired: true | false; unset ⇒ false)',
};

/**
 * The per-backend environment contract, keyed by the `backend:` value an agent declares — the SAME map
 * `makeExtractionBackend` builds each adapter from. A backend absent from this record is not wired.
 *
 * The anthropic entry is the only one with a choice: `RAYSPEC_ANTHROPIC_CONFIG_ROOT` is required
 * outright, while the credential is satisfied by EITHER token (and by neither, when
 * `RAYSPEC_ANTHROPIC_REUSE_LOGIN` is on — see `anthropicReuseLogin`).
 */
export const AGENT_BACKEND_DEMANDS: Readonly<Record<string, AgentBackendDemand>> = {
  openai: { vars: [OPENAI_API_KEY_FOR_OPENAI], anyOf: [] },
  pi: { vars: [OPENAI_API_KEY_FOR_PI], anyOf: [] },
  codex: { vars: [CODEX_HOME], anyOf: [] },
  anthropic: {
    vars: [ANTHROPIC_CONFIG_ROOT],
    anyOf: [CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY],
  },
};

/**
 * Read `RAYSPEC_ANTHROPIC_REUSE_LOGIN` WITHOUT deciding what to do about a bad value: `true` / `false`
 * for the two recognised postures, `'unsupported'` for anything else. The boot turns that third answer
 * into its fail-closed `ProductBootError` (`anthropicReuseLoginEnabled`, product-boot.ts); the read-only
 * report turns it into a reported error instead of a throw. One decision procedure, two dispositions —
 * which is the only way the report can agree with the boot about whether the token demand is relaxed.
 */
export function anthropicReuseLogin(env: NodeJS.ProcessEnv): boolean | 'unsupported' {
  const raw = env.RAYSPEC_ANTHROPIC_REUSE_LOGIN?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'false' || raw === '0' || raw === 'off') {
    return false;
  }
  if (raw === 'true' || raw === '1' || raw === 'on') return true;
  return 'unsupported';
}

// ── C. ENV-ONLY — demands NO document signal can predict ──────────────────────────────────────────

/**
 * `STT_PROVIDER` — the transcription provider SELECTION.
 *
 * On the BACKEND profile it is never itself a demand: an unset selector means the `init.stt` capability
 * is simply ABSENT (`buildSttCapability` returns undefined), which is not an error at any point. On the
 * PRODUCT profile it IS demanded, but only when the document declares an `stt.*` workflow step — still
 * document-conditional, never unconditional. `what` is the clause the product boot's refusal uses.
 */
export const STT_PROVIDER: BootEnvVar = {
  name: 'STT_PROVIDER',
  fileVariant: null,
  what: "the STT provider: 'deepgram' | 'fake'",
};

/** `DEEPGRAM_API_KEY` — demanded iff the selection is `deepgram`, on either profile. */
export const DEEPGRAM_API_KEY: BootEnvVar = {
  name: 'DEEPGRAM_API_KEY',
  fileVariant: null,
  what: 'the Deepgram API key (STT_PROVIDER=deepgram)',
};

/**
 * `TTS_PROVIDER` — the speech-synthesis provider SELECTION, under the same law as `STT_PROVIDER` on the
 * backend profile: absent ⇒ no capability is built, and that is never a boot error.
 */
export const TTS_PROVIDER: BootEnvVar = {
  name: 'TTS_PROVIDER',
  fileVariant: null,
  what: "the TTS provider selection: 'openai' | 'fake'",
};

/** `OPENAI_API_KEY` — demanded iff `TTS_PROVIDER=openai` (a different reason from either agent backend). */
export const OPENAI_API_KEY_FOR_TTS: BootEnvVar = {
  name: 'OPENAI_API_KEY',
  fileVariant: null,
  what: 'the OpenAI API key for TTS_PROVIDER=openai',
};

/**
 * `RAYSPEC_FS_SOURCE_ROOT` — OPTIONAL on both profiles and demanded by no document signal whatsoever
 * (unlike the stream→blob guard, no route KIND requires it). Unset ⇒ `init.fsSource` is absent. Only a
 * SET-but-nonexistent value refuses the boot.
 */
export const FS_SOURCE_ROOT: BootEnvVar = {
  name: 'RAYSPEC_FS_SOURCE_ROOT',
  fileVariant: null,
  what: 'the READ-ONLY source root `init.fsSource` reads under',
};

// ── the shared PREDICATES — the document questions the boot gates ask ─────────────────────────────

/**
 * Does this document declare a `kind:'stream'` route? The stream→blob guard's condition, shared so the
 * report asks the question the boot asks. Structurally typed over `action.kind` so it accepts both the
 * parsed document's routes and the post-pack-merge `effectiveSpec.api` the guard itself runs on.
 */
export function declaresStreamRoute(
  api: readonly { readonly action: { readonly kind: string } }[],
): boolean {
  return api.some((route) => route.action.kind === 'stream');
}

/** Does this document declare a `kind:'stream', mode:'playback'` route? The media-key guard's condition. */
export function declaresPlaybackRoute(
  api: readonly { readonly action: { readonly kind: string; readonly mode?: string } }[],
): boolean {
  return api.some((route) => route.action.kind === 'stream' && route.action.mode === 'playback');
}

/**
 * The FIREABLE triggers — `cron` (scheduled + on-demand) and `manual` (on-demand only). Both are fired
 * by the durable worker under a known tenant, which is what makes `RAYSPEC_CRON_TENANT_ID` a demand;
 * `webhook` / `event` descriptors stay reserved and demand nothing. Structurally typed so the deploy
 * guard can filter the DEPLOYED trigger registry with it and the report can filter the DECLARED
 * triggers — the same rule either way.
 */
export function fireableTriggers<T extends { readonly kind: string }>(
  triggers: readonly T[],
): readonly T[] {
  return triggers.filter((trigger) => trigger.kind === 'cron' || trigger.kind === 'manual');
}

/**
 * Does a PRODUCT document declare a transcribing step? The `usesStt` predicate the product boot gates
 * its STT construction on — and therefore the one condition under which `STT_PROVIDER` becomes a
 * demand at all. Shared so the report cannot answer it differently: on that profile the selector IS
 * demanded, but only here, and never unconditionally.
 */
export function declaresSttStep(spec: {
  readonly workflows: readonly { readonly steps: readonly { readonly use?: string }[] }[];
}): boolean {
  return spec.workflows.some((wf) => wf.steps.some((step) => step.use?.startsWith('stt.')));
}

/**
 * The DISTINCT backends a set of declared agents selects, each with the agent ids that select it — the
 * same grouping `buildDeclaredBackends` builds its adapters from, so the report names exactly the
 * backends a boot would try to construct.
 */
export function declaredAgentBackends(
  agents: readonly { readonly id: string; readonly backend: string }[],
): ReadonlyMap<string, readonly string[]> {
  const backendToAgents = new Map<string, string[]>();
  for (const agent of agents) {
    const selectors = backendToAgents.get(agent.backend) ?? [];
    selectors.push(agent.id);
    backendToAgents.set(agent.backend, selectors);
  }
  return backendToAgents;
}

/**
 * The top-level RaySpec sections `isStaticProfile` has reasoned about — a SEPARATE allowlist from the
 * grammar's own schema. FAIL-CLOSED tripwire: if the grammar ever grows a NEW top-level section, a
 * parsed doc carrying it has a key OUTSIDE this set and `isStaticProfile` returns false (⇒ the normal
 * boot with full auth, the safe direction). A new ROUTE-BEARING grammar field MUST be added here (and
 * emptiness-checked in `isStaticProfile`) or it can never silently pass the static gate.
 */
const STATIC_PROFILE_KNOWN_KEYS: ReadonlySet<string> = new Set([
  'version',
  'metadata',
  'stores',
  'api',
  'agents',
  'tooling',
  'triggers',
  'handlers',
  'extensions',
  'deployment',
  'frontend',
]);

/**
 * Is `specSource` a STATIC-PROFILE backend document — a frontend-only spec SAFE to boot with NO
 * database, JWT signing key, or api-key pepper, mounting NO auth/OIDC/runs/API route?
 *
 * "Frontend-only" is an ABSENCE predicate, NOT a positive grammar shape: the auth surface
 * (`createAuthApp`) is not spec-derived — it mounts unconditionally — so a spec can only ADD routes,
 * never subtract the always-on auth surface. This predicate is therefore NECESSARY BUT NOT SUFFICIENT
 * on its own; the security guarantee comes from the caller BRANCHING to `assembleStaticServer` (a fresh
 * bare app that never constructs the auth/DB composition), never from a "static" verdict alone.
 *
 * FAIL-CLOSED throughout — any doubt resolves to false:
 *   - a product-profile doc is categorically never static;
 *   - a doc that does not parse as a valid backend RaySpec is not static (the normal path then surfaces
 *     the real parse error rather than silently serving a doc that never validated);
 *   - a doc carrying ANY top-level section outside `STATIC_PROFILE_KNOWN_KEYS` is not static (the
 *     future-grammar-field tripwire);
 *   - EVERY route/DB/agent/handler-bearing section must be empty — `extensions` INCLUDED, because
 *     `mergeExtensions` concatenates each pack's stores/handlers/tooling/api/agents onto the spec
 *     before deploy, so a non-empty `extensions[]` would smuggle in every route-bearing field the
 *     other empty checks catch;
 *   - a durable off-request worker (`deployment.durableWorker`) needs a DB, so it disqualifies;
 *   - an enabled tenant event bus (`deployment.eventBus.enabled`) needs a DB — its whole backend IS
 *     the database — so it disqualifies too. The keys-allowlist above does NOT catch this on its own:
 *     `deployment` is already a known key, so a NEW SUB-key inside it trips no tripwire and would
 *     otherwise pass the static gate silently;
 *   - `frontend` must be non-empty (a static boot with nothing to serve is not a static profile).
 *
 * It lives in this LEAF module — and is re-exported from `composition-root.ts`, so every existing
 * import site keeps naming the same function — because it is the predicate that decides whether the
 * three unconditional secrets apply AT ALL. The read-only environment report has to ask exactly that
 * question, and a second frontend-only grammar written to answer it is precisely the drift this module
 * exists to prevent: it would tell a frontend-only deployment to set secrets it must not have.
 */
export function isStaticProfile(specSource: string): boolean {
  // A product-profile doc implies capabilities/workflows/stores/views — never static.
  if (detectSpecKind(specSource) === 'product') return false;
  // Must parse as a valid backend RaySpec; a parse failure is NOT static (fail closed → the normal boot
  // surfaces the real error instead of statically serving a doc that never validated).
  const parsed = parseSpec(specSource);
  if (!parsed.ok) return false;
  const spec = parsed.value;
  // FAIL-CLOSED keys-allowlist: a future top-level section this predicate has not reasoned about makes
  // the doc non-static (see STATIC_PROFILE_KNOWN_KEYS).
  for (const key of Object.keys(spec)) {
    if (!STATIC_PROFILE_KNOWN_KEYS.has(key)) return false;
  }
  // No route/DB/agent/handler-bearing section (extensions INCLUDED — the pack-merge smuggle path).
  if (
    spec.stores.length > 0 ||
    spec.api.length > 0 ||
    spec.agents.length > 0 ||
    spec.tooling.length > 0 ||
    spec.triggers.length > 0 ||
    spec.handlers.length > 0 ||
    spec.extensions.length > 0
  ) {
    return false;
  }
  // A durable off-request worker needs a database — disqualifies the static boot.
  if (spec.deployment?.durableWorker === true) return false;
  // An enabled event bus needs a database (the stream IS database rows) — disqualifies it too. This
  // check is NOT redundant with the keys-allowlist: that allowlist reasons about TOP-LEVEL sections,
  // and `deployment` is already in it, so a new sub-key of an allowed section arrives unnoticed.
  if (spec.deployment?.eventBus?.enabled === true) return false;
  // The one field a static profile MUST carry: something to serve.
  return spec.frontend !== undefined && spec.frontend.length > 0;
}

// ── the READ-ONLY report ─────────────────────────────────────────────────────────────────────────

/** One variable's presence in the environment, with no value ever read out of it. */
export interface BootEnvVarState {
  /** The variable name. */
  readonly name: string;
  /** Whether that name is set and non-blank. NEVER the value — this report prints no secret. */
  readonly set: boolean;
}

/** ONE demand this document + this environment raises, and whether the environment meets it. */
export interface BootEnvRequirement {
  /** The variable the demand is on. */
  readonly name: string;
  /** Its `<VAR>_FILE` mount, when it has one (that mount TAKES PRECEDENCE over the plain variable). */
  readonly fileVariant: string | null;
  /** Whether `name` (or its `<VAR>_FILE` mount) is set and non-blank. */
  readonly set: boolean;
  /**
   * The alternatives, when ANY ONE of them closes this demand instead — present only for the anthropic
   * credential, where a subscription token and an API key are interchangeable. Absent otherwise.
   */
  readonly orAnyOf?: readonly BootEnvVarState[];
  /** Whether the demand is MET: `name`, its `<VAR>_FILE`, or one of `orAnyOf` is set. */
  readonly satisfied: boolean;
  /**
   * Why this document + environment demands it — one entry per demand site, naming the declaration (or
   * the environment fact) that raised it and what the variable is for. More than one entry means more
   * than one thing needs the same variable.
   */
  readonly because: readonly string[];
}

/** ONE variable the check consulted and found NOT to be a demand for this document + environment. */
export interface BootEnvOptional {
  /** The variable name. */
  readonly name: string;
  /** Its `<VAR>_FILE` mount, when it has one. */
  readonly fileVariant: string | null;
  /** Whether it is set and non-blank. */
  readonly set: boolean;
  /** What it does, and why leaving it unset is not a boot error. */
  readonly note: string;
}

/** The `rayspec deploy --check-env` verdict (JSON, stdout). `ok:false` ⇒ exit 1. */
export interface BootEnvReport {
  /** Every demand this document + environment raises is met. */
  readonly ok: boolean;
  /** The mode marker, matching `--dry-run`'s verdict shape. */
  readonly mode: 'check-env';
  /** The resolved spec path (operator-supplied; never a secret). */
  readonly spec: string;
  /** The boot profile the document selects — each has a DIFFERENT demand set. */
  readonly profile: 'rayspec' | 'product' | 'static' | 'unknown';
  /** Every demand, met or not, with what raised it. */
  readonly required: readonly BootEnvRequirement[];
  /** Variables the check consulted that are NOT demands here — stated so an unset one is not read as a gap. */
  readonly optional: readonly BootEnvOptional[];
  /**
   * The names of the unmet demands. Where a `required` entry carries `orAnyOf`, ANY ONE of the named
   * variables closes it — this list gives the primary name only, and that entry says what else does.
   */
  readonly missing: readonly string[];
  /** The honest boundary — what this check does NOT establish. */
  readonly notChecked: readonly string[];
  /**
   * The refusals this document + environment already raises that are NOT an unset variable, so no
   * `missing` entry could carry them: a document that does not validate, an agent selecting a backend
   * that is not wired, an `stt.*` step declared without the audio capability, an unrecognised
   * `RAYSPEC_ANTHROPIC_REUSE_LOGIN` on a document that selects the anthropic backend. Each is a boot
   * refusal, so a non-empty list is `ok:false` exactly as an unmet demand is. Empty ⇒ the verdict is a
   * complete demand set and nothing else stands in the way of a boot that this check can see.
   */
  readonly errors: readonly string[];
}

/** Is a variable set and non-blank? A blank value is treated as unset, exactly as every boot reader does. */
function isSet(env: NodeJS.ProcessEnv, name: string): boolean {
  return (env[name]?.trim() ?? '') !== '';
}

/**
 * Accumulates requirements KEYED BY VARIABLE, so a variable two declarations both need (an `openai`
 * agent and `TTS_PROVIDER=openai` both want `OPENAI_API_KEY`) is reported once carrying both reasons
 * rather than twice carrying one each.
 */
class RequirementSet {
  readonly #env: NodeJS.ProcessEnv;
  readonly #byName = new Map<
    string,
    { variable: BootEnvVar; because: string[]; orAnyOf: readonly BootEnvVar[] }
  >();

  constructor(env: NodeJS.ProcessEnv) {
    this.#env = env;
  }

  /** Record that `variable` is demanded, `because` of one declaration or environment fact. */
  demand(variable: BootEnvVar, because: string, orAnyOf: readonly BootEnvVar[] = []): void {
    const reason = `${because} — ${variable.what}`;
    const existing = this.#byName.get(variable.name);
    if (existing) {
      existing.because.push(reason);
      return;
    }
    this.#byName.set(variable.name, { variable, because: [reason], orAnyOf });
  }

  /** The accumulated requirements, in the order they were FIRST demanded, resolved against the env. */
  list(): readonly BootEnvRequirement[] {
    return [...this.#byName.values()].map(({ variable, because, orAnyOf }) => {
      const set =
        isSet(this.#env, variable.name) ||
        (variable.fileVariant !== null && isSet(this.#env, variable.fileVariant));
      const alternatives = orAnyOf
        .filter((alt) => alt.name !== variable.name)
        .map((alt) => ({ name: alt.name, set: isSet(this.#env, alt.name) }));
      return {
        name: variable.name,
        fileVariant: variable.fileVariant,
        set,
        ...(alternatives.length > 0 ? { orAnyOf: alternatives } : {}),
        satisfied: set || alternatives.some((alt) => alt.set),
        because,
      };
    });
  }
}

/** What NO read-only environment check can establish — stated in the verdict rather than left implied. */
const NOT_CHECKED = [
  'no extension pack is loaded (running pack code is exactly what would open a socket, a database or ' +
    'a credential), so every demand a pack changes is invisible here — it can REMOVE one (a ' +
    'pack-provided blob backend removes the RAYSPEC_BLOB_ROOT demand) and it can ADD one: a ' +
    "pack-contributed api route adds the RAYSPEC_BLOB_ROOT demand (any kind:'stream') and the " +
    "RAYSPEC_MEDIA_SIGNING_KEY demand (mode:'playback'), and a pack-contributed agent adds its " +
    'backend credential demand. The guards run on the POST-merge document; this reads the base one',
  'a set <VAR>_FILE mount counts as set from the variable alone — the file is never opened, so a ' +
    'missing, unreadable or empty secret file still refuses the boot (it NEVER falls back to the ' +
    'plain variable)',
  'no VALUE is validated: a malformed PKCS#8 PEM, a non-UUID RAYSPEC_CRON_TENANT_ID, a media key ' +
    'under 32 bytes, an unsupported provider selection or an unparseable schedule all still refuse ' +
    'the boot. A value is READ only where it decides WHICH demands apply — a selected ' +
    'STT_PROVIDER/TTS_PROVIDER, and RAYSPEC_ANTHROPIC_REUSE_LOGIN, whose unrecognised value IS ' +
    'reported because it decides whether the anthropic token demand exists at all — and no value is ' +
    'ever echoed',
  'nothing about the deployment itself: no database is opened, no migration is applied, no port is ' +
    'bound and no provider is called',
  'a deployment that injects its own boot seams (an agent-backend factory, a deterministic executor) ' +
    'can satisfy demands listed here — or raise ones that are not',
] as const;

/** The product profile's extra boundary — its per-extractor backends are named in files beside the document. */
const PRODUCT_NOT_CHECKED = [
  "a product document's per-extractor backends are named in the extraction sidecar files beside it, " +
    'which this check does not open; under RAYSPEC_EXTRACTION_MODE=live each selected backend then ' +
    'demands its own credential (the same per-backend contract a declared agent raises)',
] as const;

/**
 * Enumerate the boot-environment demands of `specText` against `env` — the READ-ONLY answer to "what
 * will this document need before it can boot?", produced WITHOUT attempting one.
 *
 * It reads the DOCUMENT AND THE ENVIRONMENT, and it has to read both: a whole class of demands has no
 * document signal at all. `DEEPGRAM_API_KEY` becomes required because `STT_PROVIDER=deepgram` is in the
 * environment, not because anything in the document asked for transcription; the same holds for
 * `OPENAI_API_KEY` under `TTS_PROVIDER=openai`. A purely document-derived enumerator is blind to those
 * by construction. Note carefully what is NOT said there: the SELECTORS are not demands. An unset
 * `STT_PROVIDER` / `TTS_PROVIDER` is never a boot error on this profile — the capability is simply
 * absent — so they are reported as optional, and only a SELECTED provider makes its credential a demand.
 *
 * It dispatches on the document PROFILE in the same order the deploy path does (product, then
 * frontend-only static, then backend), because the three have genuinely different demand sets and the
 * static one requires NONE of the three unconditional secrets.
 *
 * It opens no socket, no database and no credential file, and it loads no extension pack — executing
 * pack code is precisely what would break that promise. The consequences of not loading packs run in
 * BOTH directions — a pack can REMOVE a demand (it supplies a blob backend) and it can ADD one (its
 * routes and its agents both raise demands, on a document whose own sections may declare neither) —
 * and are stated in `notChecked`, naming the packs the document declares, rather than hidden.
 */
export async function checkBootEnv(
  specPath: string,
  specText: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BootEnvReport> {
  const base = { mode: 'check-env' as const, spec: specPath };

  if (detectSpecKind(specText) === 'product') {
    const parsed = parseProductSpec(specText);
    if (!parsed.ok) {
      return {
        ok: false,
        ...base,
        profile: 'product',
        required: [],
        optional: [],
        missing: [],
        notChecked: [...NOT_CHECKED, ...PRODUCT_NOT_CHECKED],
        errors: parsed.errors.map(
          (err) =>
            `spec did not validate: ${err.code}${err.path ? ` at ${err.path}` : ''}: ${err.message}`,
        ),
      };
    }
    return await productReport(base, parsed.value, env);
  }

  // ORDER IS LOAD-BEARING, exactly as it is in `--dry-run`: a static-profile document is a backend
  // document with a frontend section, so `parseSpec` ACCEPTS it. Classify it FIRST, or the backend arm
  // swallows the one profile that requires none of the three secrets.
  if (isStaticProfile(specText)) {
    return {
      ok: true,
      ...base,
      profile: 'static',
      required: [],
      optional: [],
      missing: [],
      notChecked: [
        'the static boot reads NONE of the three platform secrets (DATABASE_URL, ' +
          'RAYSPEC_JWT_SIGNING_KEY, RAYSPEC_API_KEY_PEPPER): it is branched to before they are read, ' +
          'and a frontend-only deployment must not be given secrets it has no use for',
        'that the declared frontend directories exist or hold built assets (only the document was read)',
      ],
      errors: [],
    };
  }

  const parsed = parseSpec(specText, experimentalSpecOptionsFromEnv(env));
  if (!parsed.ok) {
    return {
      ok: false,
      ...base,
      profile: 'unknown',
      required: [],
      optional: [],
      missing: [],
      notChecked: [...NOT_CHECKED],
      errors: parsed.errors.map(
        (err) =>
          `spec did not validate: ${err.code}${err.path ? ` at ${err.path}` : ''}: ${err.message}`,
      ),
    };
  }
  return backendReport(base, parsed.value, env);
}

/** The demand set of a BACKEND-profile (`version:'1.0'`, no `product:`) document. */
function backendReport(
  base: { mode: 'check-env'; spec: string },
  spec: RaySpec,
  env: NodeJS.ProcessEnv,
): BootEnvReport {
  const required = new RequirementSet(env);
  const errors: string[] = [];

  // A. the three the config load fail-closes on, for every non-static boot.
  for (const secret of SERVER_BOOT_SECRETS) {
    required.demand(secret, 'every non-static boot reads it at config load');
  }

  // B. the document-conditional deploy guards, asked with the guards' own predicates.
  if (declaresStreamRoute(spec.api)) {
    required.demand(BLOB_ROOT, "the document declares a 'stream' route");
  }
  if (declaresPlaybackRoute(spec.api)) {
    required.demand(
      MEDIA_SIGNING_KEY,
      "the document declares a 'stream' route with mode 'playback'",
    );
  }
  const fireable = fireableTriggers(spec.triggers);
  if (fireable.length > 0) {
    required.demand(
      CRON_TENANT_ID,
      `the document declares ${fireable.length} cron/manual trigger(s)`,
    );
  }

  // B.5 the agent-backend credentials — raised while the boot opts are built, before the server is
  // assembled, from the SAME per-backend contract makeExtractionBackend constructs each adapter under.
  const backends = declaredAgentBackends(spec.agents);
  // RAYSPEC_ANTHROPIC_REUSE_LOGIN is CONSULTED EXACTLY WHERE THE BOOT CONSULTS IT: inside the anthropic
  // backend's construction, and nowhere else (`makeExtractionBackend` case 'anthropic', plus the banner
  // and shadow-footgun helpers that same-gate on it). A document whose declared agents select no
  // anthropic backend never reaches a reader of it, so an unrecognised value is NOT a refusal for that
  // document — reporting one would invent a demand the boot does not raise, which is the one failure
  // this module exists to prevent. Same predicate as the `optional` row for it below.
  const reuseLogin = backends.has('anthropic') ? anthropicReuseLogin(env) : false;
  if (reuseLogin === 'unsupported') {
    // The variable is NAMED, never quoted: this verdict prints no environment value, and this is the
    // one place a value could otherwise have reached it. (The boot's own refusal does echo the value —
    // that wording is unchanged; this report is the surface that promises not to.)
    errors.push(
      'RAYSPEC_ANTHROPIC_REUSE_LOGIN is set to an unsupported value (wired: true | false; unset ⇒ ' +
        'false) — the boot refuses fail-closed on it. The value itself is not echoed here.',
    );
  }
  for (const [backend, selectors] of backends) {
    const demand = AGENT_BACKEND_DEMANDS[backend];
    const declaredBy = `declared agent(s) [${selectors.join(', ')}] select backend '${backend}'`;
    if (!demand) {
      errors.push(
        `${declaredBy}, which is not a wired extraction backend — the boot refuses fail-closed on it`,
      );
      continue;
    }
    for (const variable of demand.vars) required.demand(variable, declaredBy);
    // The anthropic token pair, and ONLY when reuse-login is off: the opt-in boots that backend from a
    // seeded per-tenant login instead, so demanding a token then would report a gap the boot does not
    // have. An unsupported value is reported above and treated as off here (the boot never gets past it).
    const [primaryToken] = demand.anyOf;
    if (primaryToken && reuseLogin !== true) {
      // ONE requirement carrying the whole choice: the siblings ride on its `orAnyOf` rather than
      // becoming demands of their own, so `missing` never reads as "set both".
      required.demand(primaryToken, declaredBy, demand.anyOf);
    }
  }

  // C. the ENV-ONLY demands — a selected speech provider makes ITS credential a demand, and no document
  // signal could have predicted either one.
  const sttProvider = env.STT_PROVIDER?.trim();
  if (sttProvider === 'deepgram') {
    required.demand(DEEPGRAM_API_KEY, "STT_PROVIDER='deepgram' is selected in the environment");
  }
  const ttsProvider = env.TTS_PROVIDER?.trim();
  if (ttsProvider === 'openai') {
    required.demand(OPENAI_API_KEY_FOR_TTS, "TTS_PROVIDER='openai' is selected in the environment");
  }

  const optional: BootEnvOptional[] = [
    optionalRow(env, STT_PROVIDER, {
      note:
        'the transcription provider SELECTION, and NOT a boot demand: unset ⇒ the `init.stt` ' +
        'capability is simply absent, which is never a boot error. Selecting `deepgram` makes ' +
        'DEEPGRAM_API_KEY a demand; `fake` is an offline dev/CI selection that demands nothing',
    }),
    optionalRow(env, TTS_PROVIDER, {
      note:
        'the speech-synthesis provider SELECTION, and NOT a boot demand either: unset ⇒ the ' +
        '`init.tts` capability is simply absent, which is never a boot error. Selecting `openai` ' +
        'makes OPENAI_API_KEY a demand; `fake` is an offline dev/CI selection that demands nothing',
    }),
    optionalRow(env, FS_SOURCE_ROOT, {
      note:
        'OPTIONAL and demanded by no document signal — no route kind requires it. Unset ⇒ ' +
        '`init.fsSource` is absent; only a SET value naming a nonexistent directory refuses the boot',
    }),
  ];
  if (backends.has('anthropic')) {
    optional.push(
      optionalRow(env, ANTHROPIC_REUSE_LOGIN, {
        note:
          'not a demand — it RELAXES one: when truthy the anthropic backend boots from a SEEDED ' +
          'per-tenant CLAUDE_CONFIG_DIR login and neither CLAUDE_CODE_OAUTH_TOKEN nor ' +
          'ANTHROPIC_API_KEY is required. An unrecognised value refuses the boot',
      }),
    );
  }

  // A pack-BEARING document is never a silent green: the base document is all this check reads, and the
  // stream/playback guards run on the post-merge one, so the packs this document names are stated —
  // PARSED off the document, never loaded. Without this an operator reads a green verdict for a
  // document whose whole route surface (and therefore whole demand set) arrives from a pack.
  const notChecked = [...NOT_CHECKED];
  if (spec.extensions.length > 0) {
    notChecked.unshift(
      `this document declares ${spec.extensions.length} extension pack(s) — ` +
        `[${spec.extensions.map((ext) => ext.id).join(', ')}] — whose stores, routes, handlers and ` +
        'agents merge into the deployed document BEFORE the boot guards ask their questions. None ' +
        'was loaded, so every demand they carry is missing from this verdict',
    );
  }

  return assemble(base, 'rayspec', required.list(), optional, notChecked, errors);
}

/** The demand set of a PRODUCT-profile (`product:`-bearing) document. */
async function productReport(
  base: { mode: 'check-env'; spec: string },
  spec: ProductSpec,
  env: NodeJS.ProcessEnv,
): Promise<BootEnvReport> {
  // The capability predicates are the product compose graph's OWN — imported here rather than
  // re-derived, and DYNAMICALLY so a backend or frontend-only document never pays for that closure
  // (the same reason `--dry-run` imports it on the product arm alone). It is a module load, not a
  // connection: nothing in it opens a socket or a database at import time.
  const {
    declaresAudio,
    declaresConversationInput,
    declaresFileInput,
    declaresRecordInput,
    recordInputNormalize,
  } = await import('@rayspec/product-yaml');

  const required = new RequirementSet(env);
  const errors: string[] = [];

  for (const secret of SERVER_BOOT_SECRETS) {
    required.demand(secret, 'every non-static boot reads it at config load');
  }
  required.demand(PRODUCT_TENANT_ID, 'every product-profile boot demands it');

  const withAudio = declaresAudio(spec);
  const withFileInput = declaresFileInput(spec);
  if (withAudio) {
    required.demand(BLOB_ROOT, 'the document declares the audio capability');
    required.demand(MEDIA_SIGNING_KEY, 'the audio capability declares a playback route');
  } else if (withFileInput) {
    required.demand(BLOB_ROOT, 'the document declares the file_input capability');
  }
  if (spec.extractors.length > 0) {
    required.demand(
      EXTRACTION_MODE,
      `the document declares ${spec.extractors.length} extractor(s)`,
    );
  }
  if (declaresConversationInput(spec)) {
    required.demand(RESPONDER_MODE, 'the document declares the conversation input');
  }
  if (declaresRecordInput(spec) && recordInputNormalize(spec)) {
    required.demand(NORMALIZE_MODE, 'the record_input capability declares an input_normalize step');
  }
  // The ONE place a provider SELECTOR is itself a demand — and it is still DOCUMENT-conditional, raised
  // only when the document declares a transcribing step, never unconditionally.
  //
  // AND ONLY ALONGSIDE THE AUDIO CAPABILITY, which is the boot's own condition: the STT media resolver
  // reads the audio capability's blob-backed chunks, so the product boot rejects an `stt.*` step
  // declared WITHOUT audio on the document SHAPE — before it reads STT_PROVIDER at all. Demanding the
  // selector for such a document would send an operator to set a variable that changes nothing, and the
  // boot would refuse anyway. The shape refusal is reported instead, as the refusal it is.
  if (declaresSttStep(spec)) {
    if (withAudio) {
      required.demand(STT_PROVIDER, 'the document declares an stt.* workflow step');
      if (env.STT_PROVIDER?.trim() === 'deepgram') {
        required.demand(DEEPGRAM_API_KEY, "STT_PROVIDER='deepgram' is selected in the environment");
      }
    } else {
      errors.push(
        "the document declares an 'stt.*' workflow step but no audio capability " +
          '(audio_input/media_playback), whose blob-backed chunks the stt media resolver reads — the ' +
          'boot refuses fail-closed on that document SHAPE, before it reads STT_PROVIDER at all. ' +
          'Declare the audio capability or remove the stt step',
      );
    }
  }

  const optional: BootEnvOptional[] = [
    optionalRow(env, FS_SOURCE_ROOT, {
      note:
        'OPTIONAL and demanded by no document signal. Unset ⇒ `init.fsSource` is absent; only a SET ' +
        'value naming a nonexistent directory refuses the boot',
    }),
  ];

  return assemble(
    base,
    'product',
    required.list(),
    optional,
    [...NOT_CHECKED, ...PRODUCT_NOT_CHECKED],
    errors,
  );
}

/** One `optional` row, read off the environment (presence only — never a value). */
function optionalRow(
  env: NodeJS.ProcessEnv,
  variable: BootEnvVar,
  { note }: { note: string },
): BootEnvOptional {
  return {
    name: variable.name,
    fileVariant: variable.fileVariant,
    set:
      isSet(env, variable.name) ||
      (variable.fileVariant !== null && isSet(env, variable.fileVariant)),
    note,
  };
}

/** Close the verdict: `missing` is derived from the requirements, and `ok` from `missing` + `errors`. */
function assemble(
  base: { mode: 'check-env'; spec: string },
  profile: BootEnvReport['profile'],
  required: readonly BootEnvRequirement[],
  optional: readonly BootEnvOptional[],
  notChecked: readonly string[],
  errors: readonly string[],
): BootEnvReport {
  const missing = required.filter((req) => !req.satisfied).map((req) => req.name);
  return {
    ok: missing.length === 0 && errors.length === 0,
    ...base,
    profile,
    required,
    optional,
    missing,
    notChecked,
    errors,
  };
}
