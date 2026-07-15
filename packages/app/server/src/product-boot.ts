/**
 * The ENV-DRIVEN Product-YAML boot composition.
 *
 * `RAYSPEC_SPEC_PATH` pointing at a Product-YAML document composes the product deploy END-TO-END and
 * serves it (instead of an earlier hard-abort): the deployment's Tier-A store bindings are DERIVED
 * from the YAML (product-free), the STT adapter is selected by `STT_PROVIDER`, the extraction executor
 * is the LIVE `runAgent` path (env `live`) or an injected deterministic executor (dev/CI), media-prep
 * runs off-request, and the durable workflow path is the REAL `DbosWorkflowExecutor` +
 * `resolveWorkflowRun` over the composed `buildNodeRegistry`. Fail-closed with NAMED errors on any
 * missing env/config. The classic `rayspec.yaml` boot (deployDeclaredSpec) is untouched.
 *
 * The ENV-DRIVEN update-apply seam: when `RAYSPEC_UPDATE_MIGRATION` (+ optional
 * `RAYSPEC_UPDATE_ALLOWLIST`) is set, the boot CLASSIFIES the live schema vs the NEW spec FIRST, then
 * (reboot-safe by construction, because `RAYSPEC_UPDATE_MIGRATION` is a PERSISTENT
 * deployment env re-read on EVERY boot) routes on the result: `drifted` (the normal update) hands the
 * reviewed forward DELTA to `deploy()`'s gate; `absent` (a first boot) refuses actionably; and
 * `present-matching` PROBES the delta's destructive targets live (FIX-2 — detectDrift is superset-blind,
 * so a leftover-env schema and an UNAPPLIED pure-SUBSET removal both classify present-matching): a genuine
 * LEFTOVER (all drop targets gone / additive-only) SHORT-CIRCUITs to MOUNT with a loud operator log
 * (re-applying a non-idempotent delta would 42P07/42P01 crash-loop the boot), an UNAPPLIED subset removal
 * (a reviewed drop target STILL EXISTS) APPLIES the delta, and an undeterminable destructive statement
 * REFUSES fail-closed. A post-migrate drift GATE then fail-closes an under-reconciling delta (a delayed
 * brick). Unset ⇒ behavior-identical to the pre-S4 mount/materialize boot (the drifted-refuse error TEXT
 * now also points at the update seam).
 *
 * This lives in the composition root (server) — the DBOS wiring belongs here (server/src is where the
 * concrete engines are wired), NOT in the kill-set deploy.ts (the family dispatch already exists).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve as resolvePath } from 'node:path';
import { AnthropicAdapter } from '@rayspec/adapter-anthropic';
import { CodexAdapter } from '@rayspec/adapter-codex';
import { DeepgramSttAdapter } from '@rayspec/adapter-deepgram';
import { OpenAIAdapter } from '@rayspec/adapter-openai';
import { PiAdapter } from '@rayspec/adapter-pi';
import type { AgentRuntimeRegistry } from '@rayspec/agent-runtime';
import {
  type AppDeps,
  createAuthApp,
  createMediaTokenService,
  type DeclarativeEngine,
  type DeployTarget,
  deploy,
  eraseTenant,
  type PlannedMigration,
  type SessionReprocessor,
} from '@rayspec/api-auth';
import { AUDIO_SESSIONS_STORE, chunkKey, remuxChunks } from '@rayspec/audio-runtime';
import { reprocessFinalizedSession } from '@rayspec/capability-bridges';
import {
  CONTEXT_FILTER_PAYLOAD_KEYS,
  type ContextFilterPayloadKey,
  type ConversationStoreContextRead,
  type ConversationTurnResponderFactory,
  DEFAULT_MAX_HISTORY_CHARS,
  DEFAULT_MAX_HISTORY_TURNS,
} from '@rayspec/conversation-runtime';
import { type Backend, capabilitiesFor } from '@rayspec/core';
import {
  type AllowlistEntry,
  buildProductTables,
  classifyProductSchema,
  type Db,
  type DestructiveKind,
  detectDrift,
  formatDrift,
  forTenant,
  generateProductSql,
  type ProductSchemaState,
  type QueryFn,
  scanMigrationSql,
} from '@rayspec/db';
import { DbosDurableExecutor, DbosWorkflowExecutor, type ResolvedRun } from '@rayspec/durable-dbos';
import type { BlobStoreFactory } from '@rayspec/platform';
import { makeFsBlobStoreFactory, makeHandlerDb, type RunJob } from '@rayspec/platform';
import {
  type ComposedProductDeploy,
  composeCapabilityStores,
  declaresAudio,
  declaresConversationInput,
  declaresFileInput,
  deriveConflictKeys,
  deriveProductStores,
  type LiveExtractionInputContext,
  makeLiveExtractionNode,
  makeLiveTurnResponder,
  type ProductYamlRollout,
} from '@rayspec/product-yaml';
import {
  assertProductScope,
  assertSafeIdentifier,
  ProductScopeError,
  type ProductSpec,
  parseProductSpec,
  STORE_READ_DEFAULT_LIMIT,
  STORE_READ_MAX_LIMIT,
} from '@rayspec/spec';
import {
  FakeSttAdapter,
  type SttAdapter,
  type SttFinalizedTrackRef,
  SttMediaResolutionError,
  type SttMediaResolver,
  type SttMediaSource,
} from '@rayspec/stt-port';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { BootedServer, ServerConfig } from './composition-root.js';

/** A fail-closed product-boot config defect (a missing/invalid env or config file). */
export class ProductBootError extends Error {
  constructor(message: string) {
    super(`Boot aborted (Product-YAML) — ${message}`);
    this.name = 'ProductBootError';
  }
}

/** The deployed-product boot result (the subset of BootedServer the dispatcher assembles). */
export interface DeployedProductBoot {
  app: BootedServer['app'];
  declaredRoutes: BootedServer['declaredRoutes'];
  declaredAgents: BootedServer['declaredAgents'];
  declaredCronTriggers: BootedServer['declaredCronTriggers'];
  deployMode: BootedServer['deployMode'];
  /**
   * The REPORT-ONLY drift `deploy()` computed post-migrate, surfaced additively so the
   * composition root / tests can assert the reconciled end-state (mirrors S3's classic BootedServer.drift).
   * EMPTY on every SUCCESSFUL boot: a mount/materialize boot only proceeds on a non-drifted schema (so
   * its post-deploy drift is []); an env-driven UPDATE boot whose reviewed delta UNDER-reconciles fails
   * closed BELOW with a `ProductBootError` rather than returning a green boot with residual drift.
   */
  drift: BootedServer['drift'];
  durableExecutorShutdown?: () => Promise<void>;
  eraseTenantNow?: BootedServer['eraseTenantNow'];
}

export interface DeployProductYamlOpts {
  /** LOCAL A1 stand-in: register the built product tables before deploy()'s identity-keyed verify. */
  registerProductTables?: (tables: ReadonlyMap<string, PgTable>) => void;
  /** Env source (default process.env) — injectable for tests. */
  env?: NodeJS.ProcessEnv;
  /**
   * The deterministic extraction executor for `RAYSPEC_EXTRACTION_MODE=deterministic` (dev/CI). The
   * platform ships none (product-free); a deployment/test injects it. LIVE mode ignores this.
   */
  deterministicAgents?: AgentRuntimeRegistry;
  /**
   * A deployment-supplied STT adapter that SUPERSEDES the `STT_PROVIDER` env construction (dev/CI — a
   * fixtured fake for a no-network drive). Production leaves this unset and selects via STT_PROVIDER.
   */
  sttAdapter?: SttAdapter;
  /**
   * the deterministic REPLY BACKEND for `RAYSPEC_RESPONDER_MODE=deterministic` (dev/CI —
   * the injected-Backend proof). The FULL responder config path (the per-product
   * `<agent_id>.responder.json` resolve + validation) still runs; ONLY the neutral Backend is
   * swapped, so a CI drive proves everything but the provider call. LIVE mode ignores this.
   */
  deterministicResponderBackend?: Backend;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string, why: string): string {
  const v = env[name]?.trim();
  if (!v) throw new ProductBootError(`${name} is required (${why}). Fail-closed.`);
  return v;
}

// ── the ENV-DRIVEN update-apply seam ─────────────────────────────────────────────────

/**
 * The env inputs for the ENV-DRIVEN product UPDATE path (mirrors the local-boot wrapper's
 * `UpdateMigrationEnv` — the same shape the backend boot reads through `RAYSPEC_BOOT_UPDATE`, here
 * consumed DIRECTLY by the live env-driven boot).
 */
export interface ProductUpdateEnv {
  /** RAYSPEC_UPDATE_MIGRATION — the reviewed delta `.sql` the operator authored (its presence = update mode). */
  readonly migrationPath?: string;
  /** RAYSPEC_UPDATE_ALLOWLIST — the reviewed destructive-statement allowlist JSON (OPTIONAL; absent ⇒ []). */
  readonly allowlistPath?: string;
}

/**
 * Parse + fail-closed shape-validate a reviewed allowlist JSON file into `AllowlistEntry[]`. An absent
 * path ⇒ `[]` (a purely-additive delta needs none). A missing/unreadable/malformed file THROWS a named
 * `ProductBootError` — never a silently-empty allowlist. (`deploy()`'s scan gate is the ULTIMATE
 * fail-closed authority regardless: a destructive statement with no MATCHING entry BLOCKS with a
 * DeployError at [lint/gate], however the allowlist was shaped — a wrong `match` re-blocks.)
 */
function readReviewedAllowlist(allowlistPath: string | undefined): AllowlistEntry[] {
  const path = allowlistPath?.trim();
  if (!path) return [];
  const resolved = resolvePath(path);
  let text: string;
  try {
    text = readFileSync(resolved, 'utf8');
  } catch {
    throw new ProductBootError(
      `RAYSPEC_UPDATE_ALLOWLIST points at an unreadable file: ${resolved}. Fail-closed.`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new ProductBootError(
      `RAYSPEC_UPDATE_ALLOWLIST is not valid JSON (${resolved}): ${
        e instanceof Error ? e.message : String(e)
      }. Fail-closed.`,
    );
  }
  if (!Array.isArray(data)) {
    throw new ProductBootError(
      `RAYSPEC_UPDATE_ALLOWLIST must be a JSON array of { kind, match, reason } entries (${resolved}). Fail-closed.`,
    );
  }
  return data.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ProductBootError(
        `RAYSPEC_UPDATE_ALLOWLIST entry [${i}] must be an object. Fail-closed.`,
      );
    }
    const { kind, match, reason } = raw as Record<string, unknown>;
    if (typeof kind !== 'string' || kind.length === 0)
      throw new ProductBootError(
        `RAYSPEC_UPDATE_ALLOWLIST entry [${i}].kind must be non-empty. Fail-closed.`,
      );
    if (typeof match !== 'string' || match.length === 0)
      throw new ProductBootError(
        `RAYSPEC_UPDATE_ALLOWLIST entry [${i}].match must be non-empty. Fail-closed.`,
      );
    if (typeof reason !== 'string' || reason.length === 0)
      throw new ProductBootError(
        `RAYSPEC_UPDATE_ALLOWLIST entry [${i}].reason must be non-empty. Fail-closed.`,
      );
    return { kind: kind as AllowlistEntry['kind'], match, reason };
  });
}

/**
 * Build the reviewed forward-DELTA migration(s) for the ENV-DRIVEN Product-YAML UPDATE path, or
 * `undefined` when `RAYSPEC_UPDATE_MIGRATION` is unset (⇒ today's mount/materialize/drifted classify —
 * behavior-identical). When SET: read the delta `.sql` (REQUIRED, fail-closed) + the OPTIONAL reviewed
 * allowlist JSON, and return exactly ONE `PlannedMigration` keyed by the delta filename (the versioned
 * delta the skill authored via `rayspec plan <new> --against <old>`).
 *
 * TRUST RATIONALE (honest — the gate is NARROW, not total): `RAYSPEC_UPDATE_MIGRATION` /
 * `RAYSPEC_UPDATE_ALLOWLIST` are deploy-time env — the SAME operator-controlled trust level as
 * `RAYSPEC_SPEC_PATH` itself (which already names the whole product document this boot serves).
 * `deploy()` scans the delta and BLOCKS any DESTRUCTIVE statement lacking a covering reviewed allowlist
 * entry (`DeployError` at `lint/gate`) — but ADDITIVE DDL and DATA statements (INSERT, UPDATE-with-WHERE)
 * flow through BY DESIGN (and note the scan asymmetry: DELETE-with-WHERE is flagged, UPDATE-with-WHERE is
 * NOT). Nothing DESTRUCTIVE passes without a reviewed allowlist; additive/data SQL is accepted on the
 * TRUSTED single-node beta because writing the deployment env already implies DB-admin on this box. The
 * The external-exposure hardening (sandbox / RLS / KMS-DEK / DPoP) remains the binding gate before ANY untrusted/self-serve
 * exposure. Path handling is as strict as the spec path's; a leftover env's REBOOT-SAFETY is handled at
 * the boot (see `planUpdateBoot` + the classify preflight), not here.
 */
export function readProductUpdateMigrations(env: ProductUpdateEnv): PlannedMigration[] | undefined {
  const migrationPath = env.migrationPath?.trim();
  if (!migrationPath) return undefined;
  const resolved = resolvePath(migrationPath);
  let sql: string;
  try {
    sql = readFileSync(resolved, 'utf8');
  } catch {
    throw new ProductBootError(
      `RAYSPEC_UPDATE_MIGRATION points at an unreadable file: ${resolved}. Fail-closed.`,
    );
  }
  const allowlist = readReviewedAllowlist(env.allowlistPath);
  return [{ name: basename(resolved), sql, allowlist }];
}

/**
 * The loud operator log emitted when a LEFTOVER `RAYSPEC_UPDATE_MIGRATION` is mounted (
 * this now EXCLUSIVELY covers a genuine leftover — the delta's additive objects exist AND any destructive
 * targets were PROBED gone; an UNAPPLIED subset drop is applied, not mounted, and an undeterminable
 * destructive statement refuses).
 */
export const LEFTOVER_UPDATE_ENV_MOUNT_LOG =
  '\n⚠️  RAYSPEC PRODUCT BOOT — RAYSPEC_UPDATE_MIGRATION is set but the live schema ALREADY ' +
  'satisfies the new spec (drift-clean) ⚠️\n' +
  '    The reviewed delta was already applied on a PRIOR boot — its additive objects are present and ' +
  'any destructive targets were PROBED gone; this boot MOUNTED without re-applying it (a non-idempotent ' +
  'delta re-applied would crash the boot).\n' +
  '    REMOVE RAYSPEC_UPDATE_MIGRATION (and RAYSPEC_UPDATE_ALLOWLIST) from the deployment env — it ' +
  'is now stale. Set it again only for the NEXT schema change.\n';

// ── the present-matching destructive discriminator ─────────────────────────────

/**
 * A live-schema existence probe for the target of ONE superset-blind destructive statement. The boot
 * builds the concrete probe from its read-only query thunk (`makeSchemaProbe`); the router
 * (`routePresentMatchingUpdate`) stays DB-free and unit-testable by taking it as an injected async fn.
 */
export type DestructiveTargetProbe =
  | { kind: 'drop-table'; table: string }
  | { kind: 'drop-column'; table: string; column: string }
  | { kind: 'drop-index'; index: string }
  | { kind: 'drop-constraint'; table: string; constraint: string };

/**
 * The destructive scan-kinds whose UNAPPLIED effect is INVISIBLE to `detectDrift` (it introspects ONLY
 * the NEW spec's stores/columns/FKs, so an un-dropped table/column/index/constraint is just an EXTRA
 * object it never inspects). A live schema still carrying the target therefore classifies
 * `present-matching` even though the reviewed DROP never ran — so we MUST probe the target's existence to
 * tell "already applied on a prior boot (a leftover env)" from "never applied (a pure-subset update on
 * its first boot)". These are exactly the destructive kinds `diffProductStores` emits for a SUBSET
 * (removal) update. (drop-constraint is included: `diffProductStores` emits it for a removed product FK,
 * which is equally superset-blind — omitting it would send a legitimate FK-removal subset update to the
 * fail-closed refuse path below, contradicting "near-unreachable for skill-authored deltas".)
 */
const PROBEABLE_SUPERSET_BLIND: ReadonlySet<DestructiveKind> = new Set<DestructiveKind>([
  'drop-table',
  'drop-column',
  'drop-index',
  'drop-constraint',
]);

/**
 * Destructive scan-kinds that CANNOT reach `present-matching` UNAPPLIED, because `detectDrift` DOES
 * inspect the affected NEW-spec object: a type change / SET NOT NULL / NOT-NULL ADD / rename all leave a
 * detectable column-type / nullability / missing-column / missing-table difference when unapplied → the
 * boot classifies `drifted`, never `present-matching`. So at `present-matching` these are PROVEN already
 * applied — consistent with a fully-applied leftover env: they never force a re-apply and MUST NOT
 * refuse (refusing them would re-introduce the ENV-1 crash-loop after a legitimate non-subset update).
 */
const APPLIED_AT_PRESENT_MATCHING: ReadonlySet<DestructiveKind> = new Set<DestructiveKind>([
  'using-cast',
  'type-change-no-using',
  'set-not-null',
  'add-column-not-null-no-default',
  'rename-table',
  'rename-column',
]);

/** A safe SQL identifier as the generator / `diffProductStores` emit it (optionally double-quoted). */
const IDENT = '"?([A-Za-z_][A-Za-z0-9_$]*)"?';

function truncateStmt(text: string): string {
  const s = text.replace(/\s*;\s*$/, '').trim();
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

/**
 * Extract the schema target from a superset-blind destructive statement's text (whitespace already
 * collapsed by the scan; a trailing `;` tolerated). Returns `undefined` for anything it cannot parse with
 * confidence — the router treats that as fail-closed REFUSE (never a silent mount). Recognizes the exact
 * forms `diffProductStores` emits (double-quoted identifiers) plus IF EXISTS / bare-DROP variants.
 */
export function extractDestructiveTarget(
  kind: DestructiveKind,
  statementText: string,
): DestructiveTargetProbe | undefined {
  const s = statementText.replace(/\s*;\s*$/, '').trim();
  if (kind === 'drop-table') {
    const m = new RegExp(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${IDENT}\\s*$`, 'i').exec(s);
    return m ? { kind, table: m[1] as string } : undefined;
  }
  if (kind === 'drop-column') {
    // `ALTER TABLE "t" DROP COLUMN "c"` and the bare `ALTER TABLE "t" DROP "c"` (both flagged drop-column).
    const m = new RegExp(
      `^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${IDENT}\\s+DROP\\s+(?:COLUMN\\s+)?(?:IF\\s+EXISTS\\s+)?${IDENT}`,
      'i',
    ).exec(s);
    return m ? { kind, table: m[1] as string, column: m[2] as string } : undefined;
  }
  if (kind === 'drop-index') {
    const m = new RegExp(
      `^DROP\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+EXISTS\\s+)?${IDENT}\\s*$`,
      'i',
    ).exec(s);
    return m ? { kind, index: m[1] as string } : undefined;
  }
  if (kind === 'drop-constraint') {
    const m = new RegExp(
      `^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${IDENT}\\s+DROP\\s+CONSTRAINT\\s+(?:IF\\s+EXISTS\\s+)?${IDENT}`,
      'i',
    ).exec(s);
    return m ? { kind, table: m[1] as string, constraint: m[2] as string } : undefined;
  }
  return undefined;
}

/** How a `present-matching` update delta resolves once its destructive targets are probed live. */
export type PresentMatchingRoute =
  | { kind: 'mount' } // a genuine LEFTOVER env — all drop targets already gone / additive-only
  | { kind: 'apply' } // an UNAPPLIED subset removal — a reviewed drop target STILL EXISTS
  | { kind: 'refuse'; reason: string }; // an UNDETERMINABLE destructive statement — fail-closed

/**
 * Decide, for a `present-matching` classification in UPDATE mode, whether the reviewed delta is a genuine
 * LEFTOVER env (MOUNT) or an UNAPPLIED pure-subset removal that must still run (APPLY) — by PROBING each
 * superset-blind destructive target's live existence. DB-free (the probe is injected), so it is
 * exhaustively unit-testable with a fake probe:
 *   - no destructive findings, OR every probed target is GONE, and no undeterminable statement → MOUNT
 *     (a leftover env; the loud operator log fires at the call site).
 *   - ANY probed target STILL EXISTS → APPLY (the reviewed drop never ran — route to deploy()'s gate).
 *   - a statement we cannot parse a target from, or an undeterminable kind (TRUNCATE / DELETE /
 *     DROP SCHEMA / …) → REFUSE fail-closed (cannot tell applied from unapplied by schema).
 * A destructive kind in {@link APPLIED_AT_PRESENT_MATCHING} is skipped: present-matching already PROVES
 * it applied (detectDrift inspects type/nullability/presence), so it is consistent with a leftover.
 */
export async function routePresentMatchingUpdate(
  migrations: readonly PlannedMigration[],
  probeTarget: (probe: DestructiveTargetProbe) => Promise<boolean>,
): Promise<PresentMatchingRoute> {
  let anyTargetExists = false;
  for (const migration of migrations) {
    const scan = scanMigrationSql(migration.sql, migration.allowlist ?? []);
    for (const finding of scan.findings) {
      if (PROBEABLE_SUPERSET_BLIND.has(finding.kind)) {
        const target = extractDestructiveTarget(finding.kind, finding.text);
        if (!target) {
          return {
            kind: 'refuse',
            reason: `an unparseable ${finding.kind} statement ('${truncateStmt(finding.text)}')`,
          };
        }
        if (await probeTarget(target)) anyTargetExists = true;
      } else if (APPLIED_AT_PRESENT_MATCHING.has(finding.kind)) {
      } else {
        return {
          kind: 'refuse',
          reason: `an undeterminable destructive statement (${finding.kind}: '${truncateStmt(
            finding.text,
          )}')`,
        };
      }
    }
  }
  return anyTargetExists ? { kind: 'apply' } : { kind: 'mount' };
}

/**
 * Build the live-schema existence probe `routePresentMatchingUpdate` injects, over the boot's own
 * read-only query thunk (the SAME `information_schema` / `pg_catalog` handle the classify uses), scoped
 * to one Postgres schema. Read-only; parameterized (never interpolates the extracted identifier).
 */
export function makeSchemaProbe(
  query: QueryFn,
  schema: string,
): (probe: DestructiveTargetProbe) => Promise<boolean> {
  return async (probe) => {
    if (probe.kind === 'drop-table') {
      const rows = await query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
        [schema, probe.table],
      );
      return rows.length > 0;
    }
    if (probe.kind === 'drop-column') {
      const rows = await query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        [schema, probe.table, probe.column],
      );
      return rows.length > 0;
    }
    if (probe.kind === 'drop-index') {
      const rows = await query(
        `SELECT 1 FROM pg_class i JOIN pg_namespace ns ON ns.oid = i.relnamespace
          WHERE i.relkind IN ('i', 'I') AND ns.nspname = $1 AND i.relname = $2`,
        [schema, probe.index],
      );
      return rows.length > 0;
    }
    // drop-constraint
    const rows = await query(
      `SELECT 1 FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace ns ON ns.oid = rel.relnamespace
        WHERE ns.nspname = $1 AND rel.relname = $2 AND con.conname = $3`,
      [schema, probe.table, probe.constraint],
    );
    return rows.length > 0;
  };
}

/**
 * Decide the ENV-DRIVEN UPDATE boot plan from the live-schema classification (
 * makes a PERSISTENT `RAYSPEC_UPDATE_MIGRATION` env REBOOT-SAFE by construction). Called ONLY in update
 * mode (updateMigrations !== undefined); the plain mount/materialize path is unchanged. Deltas are
 * NON-idempotent (CREATE TABLE / ADD COLUMN / DROP … with no IF [NOT] EXISTS, and `deploy()` keeps no
 * applied-ledger) and the env is re-read on every restart — so routing on the classify (+ a live target
 * probe) is what stops a leftover env from re-applying and crash-looping the boot:
 *   - `drifted`          — the NORMAL update: the live schema diverges from the NEW spec; APPLY the
 *                          reviewed delta (→ deploy()'s gate + the post-migrate drift gate). deployMode
 *                          'updated'.
 *   - `present-matching` — the live schema satisfies the NEW spec's load-bearing facts, but detectDrift
 *                          is SUPERSET-BLIND, so this covers TWO indistinguishable-by-classification cases.
 *                          FIX-2 discriminates them by PROBING the delta's destructive targets live
 *                          (`routePresentMatchingUpdate` + `probeTarget`):
 *                            · all drop targets GONE / additive-only  → MOUNT (a leftover env; ZERO
 *                              migrations, loud log). deployMode 'mounted'.
 *                            · a reviewed drop target STILL EXISTS    → APPLY (the delta never ran — a
 *                              pure-SUBSET update on its first boot). deployMode 'updated'. (FIX-1 pre-
 *                              FIX-2 mounted this too and SILENTLY LOST the reviewed drop forever.)
 *                            · an undeterminable destructive statement → REFUSE fail-closed (honest both-
 *                              cases message).
 *   - `absent`           — NOTHING is materialized yet (a first boot). Update mode evolves an EXISTING
 *                          schema; REFUSE fail-closed, actionably.
 */
export async function planUpdateBoot(
  schemaState: ProductSchemaState,
  updateMigrations: PlannedMigration[],
  specPath: string,
  warn: (message: string) => void,
  probeTarget: (probe: DestructiveTargetProbe) => Promise<boolean>,
): Promise<{ migrations: PlannedMigration[]; deployMode: 'mounted' | 'updated' }> {
  if (schemaState === 'present-matching') {
    const route = await routePresentMatchingUpdate(updateMigrations, probeTarget);
    if (route.kind === 'apply') {
      // An UNAPPLIED pure-subset removal: the live schema present-matches the smaller NEW spec ONLY
      // because detectDrift is superset-blind, but a reviewed DROP target STILL EXISTS — so the delta
      // never ran. Route it to deploy()'s gate (+ the post-update drift gate) exactly like 'drifted'.
      return { migrations: updateMigrations, deployMode: 'updated' };
    }
    if (route.kind === 'refuse') {
      throw new ProductBootError(
        `RAYSPEC_UPDATE_MIGRATION is set and the live schema present-matches the NEW spec at ` +
          `${specPath}, but the reviewed delta carries ${route.reason} whose applied-vs-unapplied ` +
          'state this boot CANNOT determine from the schema — fail-closed rather than guess:\n' +
          '    • if this env is a LEFTOVER (the delta already ran on a prior boot) → REMOVE ' +
          'RAYSPEC_UPDATE_MIGRATION (and RAYSPEC_UPDATE_ALLOWLIST); it is stale.\n' +
          '    • if this is an INTENDED destructive change not yet applied → author it as a delta whose ' +
          'targets this boot can probe (a store / column / index / constraint DROP), or apply it via an ' +
          'explicit reviewed re-deploy against a drifted schema. Fail-closed.',
      );
    }
    // 'mount' — a genuine leftover env (all drop targets already gone / additive-only). MOUNT (zero
    // migrations) so a non-idempotent delta is not re-applied (which would crash-loop the boot).
    warn(LEFTOVER_UPDATE_ENV_MOUNT_LOG);
    return { migrations: [], deployMode: 'mounted' };
  }
  if (schemaState === 'absent') {
    throw new ProductBootError(
      `RAYSPEC_UPDATE_MIGRATION is set but NO product schema is materialized yet for the spec at ` +
        `${specPath} (a first boot). Update mode evolves an EXISTING materialized schema — REMOVE ` +
        'RAYSPEC_UPDATE_MIGRATION to let the plain boot materialize the stores, then set it again only ' +
        'for a subsequent schema CHANGE. Fail-closed.',
    );
  }
  // 'drifted' — the normal update: hand the reviewed forward DELTA to deploy()'s gate.
  return { migrations: updateMigrations, deployMode: 'updated' };
}

/**
 * Honor `RAYSPEC_MEDIA_PREP` (the env table advertised it but the boot never read it):
 * `ffmpeg` (or unset ⇒ default `ffmpeg`) wires the fail-soft media-prep hook; `off` disables it (no
 * playable-artifact prep — playback stays 409); any OTHER value fail-closes with a named ProductBootError
 * (the S13.2 env contract: every declared env fail-closes on an invalid value). Returns whether to wire it.
 */
export function mediaPrepEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.RAYSPEC_MEDIA_PREP?.trim();
  if (raw === undefined || raw === '' || raw === 'ffmpeg') return true;
  if (raw === 'off') return false;
  throw new ProductBootError(
    `RAYSPEC_MEDIA_PREP '${raw}' is not supported (wired: ffmpeg | off; unset ⇒ ffmpeg). Fail-closed.`,
  );
}

/**
 * F4: build the loud NON-REAL-PROVIDER boot banner (or `null` when all providers are real). A prod boot
 * that selects `STT_PROVIDER=fake` (no real transcription — every recording fails/empties at STT),
 * `RAYSPEC_EXTRACTION_MODE=deterministic` (no real gpt-5), or `RAYSPEC_RESPONDER_MODE=deterministic`
 * (no real conversation reply model) boots cleanly today and only fails/fakes at first
 * use — an operator-visible marker at boot closes that gap. NOT fail-closed: a dev/CI boot
 * legitimately uses these. Only the ENV-selected fake counts — an INJECTED test adapter (`hasInjectedStt`)
 * is a deliberate dev/CI seam, not a prod misconfig. `responderMode` is passed only when the doc
 * declares `conversation_input` (empty otherwise — the env is not even read for a non-conversation doc).
 */
export function nonRealProviderBanner(
  env: NodeJS.ProcessEnv,
  hasInjectedStt: boolean,
  extractionMode: string,
  responderMode = '',
): string | null {
  const parts: string[] = [];
  if (!hasInjectedStt && env.STT_PROVIDER?.trim() === 'fake') {
    parts.push('STT_PROVIDER=fake (no real transcription — recordings will not transcribe)');
  }
  if (extractionMode === 'deterministic') {
    parts.push('RAYSPEC_EXTRACTION_MODE=deterministic (no real gpt-5 extraction)');
  }
  if (responderMode === 'deterministic') {
    parts.push(
      'RAYSPEC_RESPONDER_MODE=deterministic (no real conversation reply model — the injected ' +
        'deterministic Backend answers turns)',
    );
  }
  if (parts.length === 0) return null;
  return (
    '\n⚠️  RAYSPEC PRODUCT BOOT — NON-REAL PROVIDER(S) SELECTED ⚠️\n' +
    `    ${parts.join('\n    ')}\n` +
    '    This is a DEV/CI posture — NOT a production configuration. If this is prod, fix the env.\n'
  );
}

// ── STT ────────────────────────────────────────────────────────────────────────────────────────

/**
 * A tenant-bound STT media resolver: reads a finalized track's raw Ogg-Opus chunks from the blob store
 * (0,1,2,… until absent — chunks are contiguous) and remuxes them into one Opus file the provider
 * transcribes. Single-node posture: bound to the ONE deployment tenant's blob store.
 */
class BlobRemuxSttMediaResolver implements SttMediaResolver {
  readonly #blob: ReturnType<BlobStoreFactory>;
  constructor(blob: ReturnType<BlobStoreFactory>) {
    this.#blob = blob;
  }
  async resolve(ref: SttFinalizedTrackRef): Promise<SttMediaSource> {
    const chunks: Uint8Array[] = [];
    for (let i = 0; ; i += 1) {
      const read = await this.#blob.get(chunkKey(ref.session_id, ref.track, i));
      if ('notFound' in read) break;
      chunks.push(new Uint8Array(await new Response(read.body).arrayBuffer()));
    }
    if (chunks.length === 0) {
      // Fail-closed with the DECLARED resolver contract ("could not produce bytes for the requested
      // track") — the adapter maps this to `not_ready` (retryable:false), the honest neutral code for
      // unfinalized/absent media. (A `ProductBootError` here would mis-map to `unknown`; this is a
      // request-time media condition, not a boot misconfiguration.)
      throw new SttMediaResolutionError(
        `STT media resolve: no chunks for ${ref.session_id}/${ref.track} in the blob store (fail-closed).`,
      );
    }
    const stitched = await remuxChunks(chunks);
    try {
      return { bytes: stitched.bytes, contentType: 'audio/ogg' };
    } finally {
      await stitched.cleanup();
    }
  }
}

export function buildSttAdapter(
  env: NodeJS.ProcessEnv,
  blob: ReturnType<BlobStoreFactory>,
  defaultModel: string | undefined,
): SttAdapter {
  const provider = requireEnv(env, 'STT_PROVIDER', "the STT provider: 'deepgram' | 'fake'");
  if (provider === 'fake') return new FakeSttAdapter({ fixtures: [] });
  if (provider === 'deepgram') {
    const apiKey = requireEnv(
      env,
      'DEEPGRAM_API_KEY',
      'the Deepgram API key (STT_PROVIDER=deepgram)',
    );
    return new DeepgramSttAdapter({
      apiKey,
      ...(defaultModel ? { model: defaultModel } : {}),
      resolver: new BlobRemuxSttMediaResolver(blob),
    });
  }
  throw new ProductBootError(
    `STT_PROVIDER '${provider}' is not supported (wired: deepgram | fake).`,
  );
}

// ── the LIVE extraction executor (env `live`) ──────────────────────────────────────────────────

interface ExtractorConfig {
  agent_id: string;
  backend: string;
  model: string;
  prompt_file: string;
  schema_file: string;
  output_schema_name: string;
  /**
   * DEPRECATED alias for `structured_output_mode` (kept for back-compat): `true` ⇒ native; an explicit
   * `false` ⇒ validated; absence ⇒ the S5 native DEFAULT. `structured_output_mode` wins when present.
   */
  require_native_structured_output?: boolean;
  /**
   * The per-backend structured-output policy, CONFIG-SIDE (never a YAML graph key —
   * the graph denylists stay untouched). `native` (the DEFAULT) demands native strict structured
   * output (fail-closed BOTH at boot on an emulating backend AND in run-core's assertSpecValid);
   * `validated` allows validate-and-repair / emulated output (the only path for pi).
   */
  structured_output_mode?: 'native' | 'validated';
  /**
   * The GENERIC (non-transcript) branch's input declaration, CONFIG-SIDE like
   * `structured_output_mode` (never a YAML graph key). REQUIRED for an agent that declares no
   * `closed_source_artifacts` (its live extraction runs the generic branch); REJECTED on a
   * transcript-shaped agent (the transcript path never consumes it). Raw here — shape-validated
   * fail-closed by `resolveInputContext` at boot.
   */
  input_context?: unknown;
}

/** The wired extraction backends — the four in-process neutral adapters (consumed via exports only). */
export const WIRED_EXTRACTION_BACKENDS = ['openai', 'anthropic', 'pi', 'codex'] as const;

/**
 * The boot-side backend FACTORY (S5): map an extractor config's `backend` string to the right
 * in-process neutral adapter, demanding ONLY the env the CHOSEN backend needs (fail-closed, actionable).
 * The kill-set `packages/adapters/**` are consumed via their EXPORTED constructors ONLY (zero adapter
 * source edits). Per-backend env contract (doc-first verified against each adapter's source + the
 * neutral `CAPABILITIES` table):
 *  - openai    — OPENAI_API_KEY (the @openai/agents API-key path; no subscription).
 *  - anthropic — CLAUDE_CODE_OAUTH_TOKEN (the sanctioned $0 subscription official-harness) OR a stray
 *                ANTHROPIC_API_KEY (bills the API — the adapter's own self-check surfaces it). The
 *                adapter reads the token from process.env itself, so the factory demands a token IS
 *                present + a per-tenant CLAUDE_CONFIG_DIR root (RAYSPEC_ANTHROPIC_CONFIG_ROOT).
 *  - pi        — OPENAI_API_KEY (Pi runs on the OpenAI key via setRuntimeApiKey('openai', key)).
 *  - codex     — CODEX_HOME (points at the ChatGPT-OAuth auth.json; the adapter STRIPS any stray
 *                OPENAI_API_KEY/CODEX_API_KEY — subscription-only).
 */
/**
 * S5 review (SHOULD-2 — the $0-subscription billing footgun): the AnthropicAdapter passes the WHOLE
 * `process.env` to the child SDK, and the SDK's credential precedence is `ANTHROPIC_API_KEY >
 * CLAUDE_CODE_OAUTH_TOKEN`. So a deployment that INTENDS the $0 subscription (sets CLAUDE_CODE_OAUTH_TOKEN)
 * but ALSO carries a stray `ANTHROPIC_API_KEY` would SILENTLY bill the API — the subscription token is
 * shadowed. We CANNOT strip inside the kill-set adapter (`packages/adapters/**`), so we warn LOUD boot-side
 * when BOTH are present. Returns the banner (NAMES only, never secret VALUES) or null. Does NOT hard-block:
 * a deployer may legitimately want the API-key path.
 */
export function anthropicApiKeyOverrideWarning(env: NodeJS.ProcessEnv): string | null {
  if (!env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || !env.ANTHROPIC_API_KEY?.trim()) return null;
  return (
    '\n⚠️  RAYSPEC PRODUCT BOOT — ANTHROPIC SUBSCRIPTION INTENT WILL BE OVERRIDDEN & BILLED ⚠️\n' +
    '    BOTH CLAUDE_CODE_OAUTH_TOKEN (the $0 subscription harness) AND ANTHROPIC_API_KEY are set.\n' +
    '    The Anthropic SDK precedence is ANTHROPIC_API_KEY > CLAUDE_CODE_OAUTH_TOKEN, so the child\n' +
    '    WILL use the API KEY and BILL the API — the subscription token is shadowed.\n' +
    '    If you intend the $0 subscription path, UNSET ANTHROPIC_API_KEY for this deployment.\n'
  );
}

/**
 * Opt-in `RAYSPEC_ANTHROPIC_REUSE_LOGIN`: when truthy, the anthropic extraction backend boots WITHOUT a
 * CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY in the server env — trusting that the operator has seeded
 * each per-tenant CLAUDE_CONFIG_DIR (`${RAYSPEC_ANTHROPIC_CONFIG_ROOT}/tenant-<tenantId>`) with a valid
 * machine `claude` login, which the child process reuses (the adapter passes that dir to the child and its
 * existsSync guard never overwrites a seeded dir). UNSET (or `false`) ⇒ the token demand is enforced
 * UNCHANGED (byte-identical fail-closed). Accepts `true`/`1`/`on` (enabled) and unset/empty/`false`/`0`/
 * `off` (disabled); any OTHER value fail-closes with a named ProductBootError (the env contract: every
 * declared env fail-closes on an invalid value).
 */
export function anthropicReuseLoginEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.RAYSPEC_ANTHROPIC_REUSE_LOGIN?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'false' || raw === '0' || raw === 'off')
    return false;
  if (raw === 'true' || raw === '1' || raw === 'on') return true;
  throw new ProductBootError(
    `RAYSPEC_ANTHROPIC_REUSE_LOGIN '${env.RAYSPEC_ANTHROPIC_REUSE_LOGIN}' is not supported ` +
      '(wired: true | false; unset ⇒ false). Fail-closed.',
  );
}

/**
 * Reuse-login shadow footgun (the companion to anthropicApiKeyOverrideWarning): RAYSPEC_ANTHROPIC_REUSE_LOGIN
 * intends the child to authenticate from the seeded per-tenant CLAUDE_CONFIG_DIR login, but the SDK
 * credential precedence is ANTHROPIC_API_KEY > CLAUDE_CODE_OAUTH_TOKEN > the seeded /login. So a token/key
 * ALSO present in the env SHADOWS the seeded login — and a stray ANTHROPIC_API_KEY then silently BILLS the
 * API. We warn LOUD boot-side (NAMES only, never secret VALUES). Returns the banner or null. Only meaningful
 * when reuse-login is enabled; NOT a hard block (a deployer may deliberately keep a token as a fallback).
 */
export function anthropicReuseLoginShadowWarning(env: NodeJS.ProcessEnv): string | null {
  if (!anthropicReuseLoginEnabled(env)) return null;
  const hasApiKey = Boolean(env.ANTHROPIC_API_KEY?.trim());
  const hasOauth = Boolean(env.CLAUDE_CODE_OAUTH_TOKEN?.trim());
  if (!hasApiKey && !hasOauth) return null;
  const present = [
    hasApiKey ? 'ANTHROPIC_API_KEY' : null,
    hasOauth ? 'CLAUDE_CODE_OAUTH_TOKEN' : null,
  ]
    .filter(Boolean)
    .join(' + ');
  return (
    '\n⚠️  RAYSPEC PRODUCT BOOT — ANTHROPIC REUSE-LOGIN INTENT WILL BE SHADOWED ⚠️\n' +
    `    RAYSPEC_ANTHROPIC_REUSE_LOGIN is set (reuse the seeded per-tenant \`claude\` login), but ${present}\n` +
    '    is ALSO present. The Anthropic SDK precedence is ANTHROPIC_API_KEY > CLAUDE_CODE_OAUTH_TOKEN >\n' +
    '    the seeded /login, so the env credential WINS and the seeded login is IGNORED' +
    (hasApiKey ? ' (a stray ANTHROPIC_API_KEY BILLS the API).' : '.') +
    '\n    To reuse the seeded login, UNSET the token/key for this deployment.\n'
  );
}

/**
 * Reuse-login ACTIVE banner (mirrors nonRealProviderBanner for the "boots clean, fails at first use" class):
 * when RAYSPEC_ANTHROPIC_REUSE_LOGIN is on, boot relaxes the token demand but nothing can verify a
 * per-tenant CLAUDE_CONFIG_DIR is actually seeded — the boot layer has no tenant id (the seed is per-tenant
 * `${RAYSPEC_ANTHROPIC_CONFIG_ROOT}/tenant-<tenantId>`), so an UNSEEDED tenant boots green and fails only at
 * first run. We make the posture LOUD + operator-visible at boot (NAMES only, never secret VALUES); seed
 * validation stays at run time, where the tenant id exists. Returns the banner when enabled, else null.
 */
export function anthropicReuseLoginBanner(env: NodeJS.ProcessEnv): string | null {
  if (!anthropicReuseLoginEnabled(env)) return null;
  return (
    '\n⚠️  RAYSPEC PRODUCT BOOT — ANTHROPIC REUSE-LOGIN ACTIVE ⚠️\n' +
    '    RAYSPEC_ANTHROPIC_REUSE_LOGIN is on: the Anthropic backend boots WITHOUT a token/key in the\n' +
    '    server env. Each tenant CLAUDE_CONFIG_DIR under RAYSPEC_ANTHROPIC_CONFIG_ROOT must carry a\n' +
    '    seeded `claude` login (`<RAYSPEC_ANTHROPIC_CONFIG_ROOT>/tenant-<tenantId>`); an UNSEEDED\n' +
    '    tenant will fail at first run (boot cannot verify the per-tenant seed — no tenant id here).\n'
  );
}

export function makeExtractionBackend(env: NodeJS.ProcessEnv, backend: string): Backend {
  switch (backend) {
    case 'openai': {
      const apiKey = requireEnv(
        env,
        'OPENAI_API_KEY',
        "the OpenAI API key (extraction backend 'openai')",
      );
      return new OpenAIAdapter({ apiKey });
    }
    case 'anthropic': {
      // Opt-in reuse-login (RAYSPEC_ANTHROPIC_REUSE_LOGIN): when the operator has seeded each per-tenant
      // CLAUDE_CONFIG_DIR (`${RAYSPEC_ANTHROPIC_CONFIG_ROOT}/tenant-<tenantId>`) with a valid machine
      // `claude` login, the child authenticates from that dir with NO token in the server env — so we
      // relax the no-token boot throw. The adapter's deterministic per-tenant CLAUDE_CONFIG_DIR is
      // unchanged; it passes that dir to the child, which reuses the seeded login. Absent the flag the
      // throw below is byte-identical (fail-closed).
      const reuseLogin = anthropicReuseLoginEnabled(env);
      if (!reuseLogin && !env.CLAUDE_CODE_OAUTH_TOKEN?.trim() && !env.ANTHROPIC_API_KEY?.trim()) {
        throw new ProductBootError(
          "extraction backend 'anthropic' needs a CLAUDE_CODE_OAUTH_TOKEN (the sanctioned $0 " +
            'subscription official-harness) or an ANTHROPIC_API_KEY (bills the API) — neither is set. ' +
            'Fail-closed.',
        );
      }
      const billingWarning = anthropicApiKeyOverrideWarning(env);
      if (billingWarning) console.warn(billingWarning);
      // Reuse-login ACTIVE: a LOUD banner (the seed is per-tenant, unverifiable at boot).
      const reuseLoginBanner = anthropicReuseLoginBanner(env);
      if (reuseLoginBanner) console.warn(reuseLoginBanner);
      // Reuse-login shadow footgun: a token/key present alongside the flag shadows the seeded login.
      const shadowWarning = anthropicReuseLoginShadowWarning(env);
      if (shadowWarning) console.warn(shadowWarning);
      const configRoot = requireEnv(
        env,
        'RAYSPEC_ANTHROPIC_CONFIG_ROOT',
        "the per-tenant CLAUDE_CONFIG_DIR root dir (extraction backend 'anthropic')",
      );
      return new AnthropicAdapter({ configRoot });
    }
    case 'pi': {
      const apiKey = requireEnv(
        env,
        'OPENAI_API_KEY',
        "the OpenAI API key — Pi runs on it (extraction backend 'pi')",
      );
      return new PiAdapter({ apiKey });
    }
    case 'codex': {
      const codexHome = requireEnv(
        env,
        'CODEX_HOME',
        "the codex home dir holding the ChatGPT-OAuth auth.json (extraction backend 'codex')",
      );
      return new CodexAdapter({ codexHome });
    }
    default:
      throw new ProductBootError(
        `extraction backend '${backend}' is not wired in this boot (wired: ${WIRED_EXTRACTION_BACKENDS.join(
          ' | ',
        )}). Fail-closed.`,
      );
  }
}

/**
 * Resolve the structured-output policy from an extractor config: `native` is the
 * DEFAULT; an explicit `structured_output_mode` wins; the legacy boolean maps (`false` ⇒ validated).
 */
export function resolveStructuredOutputMode(cfg: ExtractorConfig): 'native' | 'validated' {
  if (cfg.structured_output_mode === 'native' || cfg.structured_output_mode === 'validated') {
    return cfg.structured_output_mode;
  }
  if (cfg.structured_output_mode !== undefined) {
    throw new ProductBootError(
      `structured_output_mode '${cfg.structured_output_mode}' is invalid (native | validated). Fail-closed.`,
    );
  }
  // Legacy boolean back-compat: an explicit `false` opts OUT of native; true / absent ⇒ native.
  if (cfg.require_native_structured_output === false) return 'validated';
  return 'native';
}

/**
 * Resolve + fail-closed validate the extractor config's `input_context`
 * against the agent's DECLARED extraction shape, AT BOOT (before any run). The declaration itself is
 * the branch discriminator:
 *  - `closed_source_artifacts` PRESENT (transcript-shaped): the transcript path never
 *    consumes an input_context, so one in the config is a misconfiguration (it would silently
 *    misdescribe what reaches the model) — REJECT. A transcript-shaped product's shipped config carries none ⇒ unchanged.
 *  - ABSENT (the generic document/event path): an input_context is REQUIRED (the node refuses to
 *    assemble an undeclared model input), must be well-shaped, must resolve to at least one OPEN
 *    input channel (non-empty payload_fields, or artifact serialization on WITH ≥1 declared input
 *    artifact — GB-1), and the agent must not demand `grounding.check` (document grounding is out
 *    of v1 — it structurally needs a closed span-set contract; the run-time node guards this too).
 * NOTE (honest limit): `payload_fields` entries are NOT cross-checked against the trigger event's
 * payload keys — a record-style ingress merges the submission contract's fields top-level, which is
 * an OPEN set (additional_properties). A misspelled field is skipped at run time; the node's
 * `agent_input_empty` guard catches the all-absent case.
 */
export function resolveInputContext(
  cfg: ExtractorConfig,
  extractor: ProductSpec['extractors'][number],
  configPath: string,
): LiveExtractionInputContext | undefined {
  const transcriptShaped =
    (extractor.extraction.acceptance_boundary.closed_source_artifacts ?? []).length > 0;
  const raw = cfg.input_context;
  if (transcriptShaped) {
    if (raw !== undefined) {
      throw new ProductBootError(
        `extractor '${extractor.id}': the extraction config at ${configPath} declares an input_context, ` +
          'but the extractor declares closed_source_artifacts (the transcript-shaped path), which ' +
          'never consumes one — remove the input_context (it would be silently ignored). Fail-closed.',
      );
    }
    return undefined;
  }
  if (extractor.extraction.acceptance_boundary.requires.includes('grounding.check')) {
    throw new ProductBootError(
      `extractor '${extractor.id}' declares no closed_source_artifacts but demands grounding.check — ` +
        'document grounding is not supported in v1 (grounding structurally needs a closed ' +
        'span-set contract). Use validation.check as the acceptance boundary. Fail-closed.',
    );
  }
  if (raw === undefined) {
    throw new ProductBootError(
      `extractor '${extractor.id}' declares no closed_source_artifacts, so its live extraction runs the ` +
        `GENERIC branch, which requires an input_context in the extraction config at ${configPath} ` +
        '(e.g. { "payload_fields": ["merchant"], "artifact_inputs": true }) — refusing to assemble ' +
        'an undeclared model input. Fail-closed.',
    );
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProductBootError(
      `extractor '${extractor.id}': input_context must be an object ({ payload_fields?, artifact_inputs? }) ` +
        `in the extraction config at ${configPath}. Fail-closed.`,
    );
  }
  const ctx = raw as Record<string, unknown>;
  const payloadFields = ctx.payload_fields;
  if (payloadFields !== undefined) {
    if (!Array.isArray(payloadFields)) {
      throw new ProductBootError(
        `extractor '${extractor.id}': input_context.payload_fields must be an array of payload field names ` +
          `(${configPath}). Fail-closed.`,
      );
    }
    if (!payloadFields.every((f) => typeof f === 'string' && f.length > 0)) {
      throw new ProductBootError(
        `extractor '${extractor.id}': input_context.payload_fields entries must be non-empty strings ` +
          `(${configPath}). Fail-closed.`,
      );
    }
  }
  const artifactInputs = ctx.artifact_inputs;
  if (artifactInputs !== undefined && typeof artifactInputs !== 'boolean') {
    throw new ProductBootError(
      `extractor '${extractor.id}': input_context.artifact_inputs must be a boolean (${configPath}). Fail-closed.`,
    );
  }
  const fields = (payloadFields as string[] | undefined) ?? [];
  // GB-1: the vacuous-config guard is SYMMETRIC across BOTH channels. The payload
  // channel is open iff payload_fields is non-empty; the artifact channel is open iff
  // artifact_inputs !== false AND the extractor DECLARES at least one input artifact — the compiler
  // mirrors `extraction.input_artifacts` 1:1 into the compiled step's `artifact_inputs`
  // (compileArtifactInputs), so the declared count here IS the compiled count. Zero open channels
  // ⇒ every run would fail `agent_input_empty` at run time; fail it AT BOOT instead.
  // Honest residual: channels that are open only CONDITIONALLY (every declared payload field
  // absent from a given event, or all declared artifacts optional-and-absent upstream) are per-run
  // conditions — the node's run-time `agent_input_empty` guard owns those.
  const artifactChannelOpen =
    artifactInputs !== false && extractor.extraction.input_artifacts.length > 0;
  if (fields.length === 0 && !artifactChannelOpen) {
    throw new ProductBootError(
      `extractor '${extractor.id}': the input_context declares no input channel (payload_fields is ` +
        `${payloadFields === undefined ? 'absent' : 'empty'} and ` +
        `${
          artifactInputs === false
            ? 'artifact_inputs is false'
            : 'the extractor declares zero input artifacts'
        }) — every run would fail agent_input_empty (${configPath}). Fail-closed.`,
    );
  }
  return {
    ...(payloadFields !== undefined ? { payload_fields: fields } : {}),
    ...(artifactInputs !== undefined ? { artifact_inputs: artifactInputs } : {}),
  };
}

/**
 * S5 review (S5-TQ-2 — validated-on-native visibility): running a NATIVE-CAPABLE backend
 * (openai/anthropic/codex) in `structured_output_mode: validated` is ALLOWED but silently DROPS native
 * constrained decode (falls back to validate-and-repair). That downgrade was previously invisible. This
 * makes it boot-visible: returns a banner when a native-capable backend runs validated, else null. It is
 * a WARNING, not a rejection — validated-on-native is a legitimate (if lossy) choice.
 */
export function nativeValidatedDowngradeWarning(
  agentId: string,
  backend: string,
  mode: 'native' | 'validated',
  backendIsNativeCapable: boolean,
): string | null {
  if (mode !== 'validated' || !backendIsNativeCapable) return null;
  return (
    `\n⚠️  RAYSPEC PRODUCT BOOT — NATIVE STRUCTURED OUTPUT DOWNGRADED (extractor '${agentId}') ⚠️\n` +
    `    backend '${backend}' supports NATIVE constrained decode, but the extractor config selects\n` +
    "    structured_output_mode: 'validated' — the run will use validate-and-repair (emulated), NOT\n" +
    '    native strict output. If you want the stronger native guarantee, set structured_output_mode:\n' +
    "    'native' (the S5 default). This is allowed; it is only a heads-up.\n"
  );
}

/**
 * Belt-and-suspenders PATH-TRAVERSAL jail (S5 review, SHOULD-1 — the SINK half): a per-agent config
 * path DERIVED from an extractor id MUST stay inside the deployment's `extraction/` dir. The grammar
 * (`ExtractorSpec.id` is a `SafeIdentifier`) closes the SOURCE at parse; this closes the
 * `readFileSync` sink even if a future grammar change reopens the source or a code-built spec bypasses
 * the parser — a `..`/`/` agent id would otherwise escape via `path.resolve` and read an arbitrary file.
 * Fail-closed, naming the offending agent. Returns the resolved path unchanged when it is safely inside.
 */
function jailToExtractionDir(extractionDir: string, resolved: string, agentId: string): string {
  const rel = relative(extractionDir, resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new ProductBootError(
      `extractor '${agentId}': the resolved extractor-config path escapes the deployment extraction ` +
        `directory (${resolved} is not inside ${extractionDir}) — refusing to read outside it ` +
        '(path-traversal guard). Fail-closed.',
    );
  }
  return resolved;
}

/**
 * Resolve the extractor-config PATH for ONE declared agent (S5 per-agent convention):
 * `<specDir>/extraction/<agent_id>.extractor.json`. A SINGLE-agent document keeps the legacy default
 * (`<specDir>/extraction/extractor.json`) + the `RAYSPEC_EXTRACTION_CONFIG` single-file override, so
 * a single-agent product resolves BYTE-IDENTICALLY (no per-agent file exists ⇒ the bare default). A
 * multi-agent document REQUIRES a per-agent file and REJECTS the ambiguous single-file override.
 * Every path DERIVED from the agent id runs through `jailToExtractionDir` (SHOULD-1 traversal guard).
 */
export function resolveExtractorConfigPath(
  env: NodeJS.ProcessEnv,
  specPath: string,
  spec: ProductSpec,
  agentId: string,
): string {
  const override = env.RAYSPEC_EXTRACTION_CONFIG?.trim();
  const extractionDir = resolvePath(dirname(specPath), 'extraction');
  if (spec.extractors.length === 1) {
    if (override) return resolvePath(override);
    const perAgent = jailToExtractionDir(
      extractionDir,
      resolvePath(extractionDir, `${agentId}.extractor.json`),
      agentId,
    );
    if (existsSync(perAgent)) return perAgent;
    return resolvePath(extractionDir, 'extractor.json');
  }
  if (override) {
    throw new ProductBootError(
      'RAYSPEC_EXTRACTION_CONFIG is a single-file override, ambiguous for a multi-extractor document ' +
        `(${spec.extractors.length} declared extractors). Provide a per-extractor config at ` +
        'extraction/<extractor_id>.extractor.json instead. Fail-closed.',
    );
  }
  return jailToExtractionDir(
    extractionDir,
    resolvePath(extractionDir, `${agentId}.extractor.json`),
    agentId,
  );
}

/**
 * Build the `rollout.liveAgent` seam from the deployment's extraction config
 * (`RAYSPEC_EXTRACTION_CONFIG`, default the PRODUCT-NEUTRAL `<specDir>/extraction/extractor.json`).
 * The prompt + schema live runtime-side (banned from the YAML graph); the instructions are ASSEMBLED
 * from the base prompt + the DECLARED `extraction_constraints`. Product-free: the boot reads a config
 * PATH, never hardcoded product meaning (the default filename is product-neutral). The product's
 * deployment now RELIES ON the product-neutral default (`<specDir>/extraction/extractor.json`) and sets
 * NO override — `docker-compose.prod.yml` leaves `RAYSPEC_EXTRACTION_CONFIG` unset. The override exists
 * ONLY for a product whose extraction config is named differently; setting it for a default-named product would be
 * redundant (and could break the default resolution). Do NOT re-couple a product to a bespoke filename.
 */
/**
 * Compose the extraction executor instructions: the base prompt (runtime-side config) + the
 * DECLARED `extraction_constraints` (the YAML's binding rules, appended verbatim). This is the
 * "donor prompt + declared contract" assembly the honesty ledger (1.1) requires.
 */
export function assembleExtractionInstructions(
  promptText: string,
  constraints: readonly string[],
): string {
  if (constraints.length === 0) return promptText;
  return `${promptText}\n\nAdditional binding constraints (declared in the product spec):\n${constraints
    .map((c) => `- ${c}`)
    .join('\n')}\n`;
}

/** One declared agent's fully-resolved live-extraction wiring (its own backend + config + policy). */
interface ResolvedExtractor {
  readonly backend: Backend;
  readonly model: string;
  readonly instructions: string;
  readonly outputSchema: { readonly name: string; readonly schema: Record<string, unknown> };
  readonly requireNative: boolean;
  /** the generic branch's input declaration (undefined for a transcript-shaped agent). */
  readonly inputContext?: LiveExtractionInputContext;
}

/**
 * Build the `rollout.liveAgent` seam (S5 — per-agent, multi-backend). For EACH declared agent it
 * resolves a per-agent extractor config (the single-agent legacy default keeps a single-agent product byte-identical),
 * constructs the config's backend via the boot-side factory (openai/anthropic/pi/codex), enforces the
 * fork-4 structured-output policy (native-default; fail-closed at boot on an emulating backend), and
 * returns `buildNodeForAgent(agentId, deps)` so compose registers a DISTINCT node per agent. All the
 * fail-closed resolution happens UP FRONT (at boot), before any run.
 */
export function buildLiveAgent(
  env: NodeJS.ProcessEnv,
  specPath: string,
  spec: ProductSpec,
): NonNullable<ProductYamlRollout['liveAgent']> {
  if (spec.extractors.length === 0) {
    throw new ProductBootError(
      'buildLiveAgent was called for a document that declares no extractors (the boot builds the live ' +
        'executor only when extractors[] is non-empty). Fail-closed.',
    );
  }

  const resolved = new Map<string, ResolvedExtractor>();
  for (const extractor of spec.extractors) {
    const configPath = resolveExtractorConfigPath(env, specPath, spec, extractor.id);
    let cfg: ExtractorConfig;
    try {
      cfg = JSON.parse(readFileSync(configPath, 'utf8')) as ExtractorConfig;
    } catch (e) {
      throw new ProductBootError(
        `extractor '${extractor.id}': could not read the extraction config at ${configPath} (${
          e instanceof Error ? e.message : String(e)
        }).`,
      );
    }
    if (cfg.agent_id !== extractor.id) {
      throw new ProductBootError(
        `extractor '${extractor.id}': the extraction config at ${configPath} names agent '${cfg.agent_id}', ` +
          `not '${extractor.id}' — a per-extractor config must name the extractor it configures. Fail-closed.`,
      );
    }
    const configDir = dirname(configPath);
    const promptText = readFileSync(resolvePath(configDir, cfg.prompt_file), 'utf8');
    const schema = JSON.parse(
      readFileSync(resolvePath(configDir, cfg.schema_file), 'utf8'),
    ) as Record<string, unknown>;
    const instructions = assembleExtractionInstructions(
      promptText,
      extractor.extraction_constraints ?? [],
    );

    // S5-TQ-3: name the offending extractor when the boot-side factory rejects (unknown/unwired backend,
    // missing per-backend env) — the factory itself is agent-agnostic, so wrap for legible boot errors.
    let backend: Backend;
    try {
      backend = makeExtractionBackend(env, cfg.backend);
    } catch (e) {
      if (e instanceof ProductBootError) {
        throw new ProductBootError(`extractor '${extractor.id}': ${e.message}`);
      }
      throw e;
    }
    const mode = resolveStructuredOutputMode(cfg);
    // S5-TQ-2: a validated-on-native downgrade is legitimate but lossy — make it boot-visible.
    const downgradeWarning = nativeValidatedDowngradeWarning(
      extractor.id,
      cfg.backend,
      mode,
      capabilitiesFor(backend.id).nativeStructuredOutput,
    );
    if (downgradeWarning) console.warn(downgradeWarning);
    // fork-4 fail-closed AT BOOT: a native-demand on a backend that only EMULATES (pi) is a clear
    // misconfiguration — reject with an actionable message NOW, not at the first run (run-core's
    // assertSpecValid would also reject, but later + less legibly). Only pi has nativeStructuredOutput:false.
    if (mode === 'native' && !capabilitiesFor(backend.id).nativeStructuredOutput) {
      throw new ProductBootError(
        `extractor '${extractor.id}': the extractor config demands NATIVE structured output ` +
          `(structured_output_mode: native — the S5 default) but backend '${cfg.backend}' only ` +
          'EMULATES it (validate-and-repair, not native constrained decode). Set ' +
          "structured_output_mode: 'validated' to allow emulation, or choose a native backend " +
          '(openai | anthropic | codex). Fail-closed.',
      );
    }

    // the generic-vs-transcript coherence of the config is decided HERE, at boot — a
    // generic agent (no closed_source_artifacts) REQUIRES a validated input_context; a
    // transcript-shaped agent REJECTS one. A transcript-shaped product (transcript, no input_context) is unchanged.
    const inputContext = resolveInputContext(cfg, extractor, configPath);

    resolved.set(extractor.id, {
      backend,
      model: cfg.model,
      instructions,
      outputSchema: { name: cfg.output_schema_name, schema },
      requireNative: mode === 'native',
      ...(inputContext ? { inputContext } : {}),
    });
  }

  return {
    agentIds: spec.extractors.map((a) => a.id),
    buildNodeForAgent: (agentId, deps) => {
      const e = resolved.get(agentId);
      if (!e) {
        throw new ProductBootError(
          `buildNodeForAgent was called for agent '${agentId}', which has no resolved extractor ` +
            '(not a declared agent). Fail-closed.',
        );
      }
      return makeLiveExtractionNode({
        backend: e.backend,
        model: e.model,
        instructions: e.instructions,
        outputSchema: e.outputSchema,
        ...(e.requireNative ? { requireNativeStructuredOutput: true } : {}),
        ...(e.inputContext ? { inputContext: e.inputContext } : {}),
        tdb: deps.tdb,
        tenantId: deps.tenantId,
      });
    },
  };
}

// ── the conversation responder (the extractor.json precedent, conversation-side) ──────

/**
 * The per-product responder config file shape (`<specDir>/conversation/<agent_id>.responder.json`
 * — STRICT per-agent naming mirroring `<agent_id>.extractor.json`; no bare-default fallback).
 * CONFIG-SIDE by design (the extractor-config precedent): model/backend names + instructions
 * live HERE, never in the capability package and never as YAML graph keys (zero grammar churn).
 */
export interface ResponderConfig {
  /** Must equal the file's name stem (the extractor `cfg.agent_id` check, mirrored). */
  agent_id: string;
  /** The TRUSTED deployer-authored responder instructions (the system channel). */
  instructions: string;
  /** The reply model (config-side). */
  model: string;
  /** The reply backend id (the S5 factory's vocabulary: openai | anthropic | pi | codex). */
  backend: string;
  /** The bounded history window (defaults = the capability's S1 constants). */
  history_window?: { turns?: number; chars?: number };
  /** The optional bounded store-context read (compose cross-checks the store; shape-checked here). */
  store_context?: { store?: unknown; filter?: unknown; limit?: unknown };
}

/**
 * Belt-and-suspenders PATH-TRAVERSAL jail for the conversation dir (the `jailToExtractionDir`
 * SHOULD-1 mirror): a responder-config path derived from a filename stem MUST stay inside the
 * deployment's `conversation/` dir. Fail-closed, naming the offender.
 */
function jailToConversationDir(conversationDir: string, resolved: string, stem: string): string {
  const rel = relative(conversationDir, resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new ProductBootError(
      `responder '${stem}': the resolved responder-config path escapes the deployment ` +
        `conversation directory (${resolved} is not inside ${conversationDir}) — refusing to read ` +
        'outside it (path-traversal guard). Fail-closed.',
    );
  }
  return resolved;
}

/**
 * Resolve THE responder config for a conversation-declaring document: scan
 * `<specDir>/conversation/` for `*.responder.json` and require EXACTLY ONE (v1 is single-responder
 * — a multi-responder product is a later fork, rejected loudly rather than picked-first silently).
 * The filename STEM is the responder agent id: SafeIdentifier-shaped (the grammar's id law),
 * path-jailed, and it must equal the config's own `agent_id` (the extractor mirror).
 */
export function resolveResponderConfig(
  specPath: string,
  spec: ProductSpec,
): ResponderConfig & {
  agentId: string;
} {
  const conversationDir = resolvePath(dirname(specPath), 'conversation');
  if (!existsSync(conversationDir)) {
    throw new ProductBootError(
      `the document declares 'conversation_input' but ${conversationDir} does not exist — create ` +
        'conversation/<agent_id>.responder.json (instructions/model/backend/history_window). Fail-closed.',
    );
  }
  const candidates = readdirSync(conversationDir).filter((f) => f.endsWith('.responder.json'));
  if (candidates.length === 0) {
    throw new ProductBootError(
      `the document declares 'conversation_input' but ${conversationDir} contains no ` +
        '*.responder.json — create conversation/<agent_id>.responder.json. Fail-closed.',
    );
  }
  if (candidates.length > 1) {
    throw new ProductBootError(
      `${conversationDir} contains ${candidates.length} *.responder.json files ` +
        `(${candidates.join(', ')}) — v1 is single-responder; keep exactly one (a multi-responder ` +
        'product is a later fork). Fail-closed.',
    );
  }
  const file = candidates[0] as string;
  const stem = file.slice(0, -'.responder.json'.length);
  try {
    assertSafeIdentifier(stem, `responder config filename stem '${stem}'`);
  } catch (e) {
    throw new ProductBootError(
      `responder config filename '${file}': ${e instanceof Error ? e.message : String(e)} ` +
        '(the stem is the responder agent id — SafeIdentifier only). Fail-closed.',
    );
  }
  const path = jailToConversationDir(conversationDir, resolvePath(conversationDir, file), stem);
  let cfg: ResponderConfig;
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8')) as ResponderConfig;
  } catch (e) {
    throw new ProductBootError(
      `could not read/parse the responder config at ${path} (${
        e instanceof Error ? e.message : String(e)
      }). Fail-closed.`,
    );
  }
  // STRICT parsing — an unknown key is a LOUD boot reject, never silently
  // ignored (a typo'd 'history_windw' would otherwise run on the defaults with the operator none
  // the wiser). The nested shapes are strict too (history_window here; store_context in its own
  // resolver below).
  const KNOWN_RESPONDER_KEYS = [
    'agent_id',
    'instructions',
    'model',
    'backend',
    'history_window',
    'store_context',
  ];
  const unknownKeys = Object.keys(cfg).filter((k) => !KNOWN_RESPONDER_KEYS.includes(k));
  if (unknownKeys.length > 0) {
    throw new ProductBootError(
      `the responder config at ${path} carries unknown key(s): ${unknownKeys.join(', ')} — the ` +
        'closed shape is { agent_id, instructions, model, backend, history_window?, ' +
        'store_context? } (strict parsing: a typo would silently fall back to a default). Fail-closed.',
    );
  }
  if (cfg.history_window !== undefined) {
    if (
      typeof cfg.history_window !== 'object' ||
      cfg.history_window === null ||
      Array.isArray(cfg.history_window)
    ) {
      throw new ProductBootError(
        `responder '${stem}': history_window must be an object of { turns?, chars? } ` +
          `(${path}). Fail-closed.`,
      );
    }
    const unknownAxes = Object.keys(cfg.history_window).filter(
      (k) => k !== 'turns' && k !== 'chars',
    );
    if (unknownAxes.length > 0) {
      throw new ProductBootError(
        `responder '${stem}': history_window carries unknown key(s): ${unknownAxes.join(', ')} — ` +
          'the closed shape is { turns?, chars? } (strict parsing). Fail-closed.',
      );
    }
  }
  if (
    cfg.store_context !== undefined &&
    typeof cfg.store_context === 'object' &&
    cfg.store_context !== null &&
    !Array.isArray(cfg.store_context)
  ) {
    // (The non-object case is rejected by resolveResponderStoreContext with its own named error.)
    const unknownContextKeys = Object.keys(cfg.store_context).filter(
      (k) => !['store', 'filter', 'limit'].includes(k),
    );
    if (unknownContextKeys.length > 0) {
      throw new ProductBootError(
        `responder '${stem}': store_context carries unknown key(s): ` +
          `${unknownContextKeys.join(', ')} — the closed shape is { store, filter?, limit? } ` +
          '(strict parsing). Fail-closed.',
      );
    }
  }
  if (cfg.agent_id !== stem) {
    throw new ProductBootError(
      `the responder config at ${path} names agent '${String(cfg.agent_id)}', not '${stem}' — a ` +
        'per-agent config must name the agent it configures (the extractor law). Fail-closed.',
    );
  }
  if (typeof cfg.instructions !== 'string' || cfg.instructions.trim().length === 0) {
    throw new ProductBootError(
      `responder '${stem}': 'instructions' must be a non-empty string (the trusted deployer-authored ` +
        'system prompt). Fail-closed.',
    );
  }
  if (typeof cfg.model !== 'string' || cfg.model.trim().length === 0) {
    throw new ProductBootError(
      `responder '${stem}': 'model' must be a non-empty string. Fail-closed.`,
    );
  }
  if (typeof cfg.backend !== 'string' || cfg.backend.trim().length === 0) {
    throw new ProductBootError(
      `responder '${stem}': 'backend' must name one of the wired backends ` +
        `(${WIRED_EXTRACTION_BACKENDS.join(' | ')}). Fail-closed.`,
    );
  }
  // validate the backend id against the WIRED factory set AT RESOLVE —
  // in BOTH modes (deterministic swaps only the neutral Backend; the config path stays fully
  // validated, so a typo'd backend can never ride a dev/CI boot green and first explode on the
  // live boot). Fail-closed naming both sides.
  if (!(WIRED_EXTRACTION_BACKENDS as readonly string[]).includes(cfg.backend)) {
    throw new ProductBootError(
      `responder '${stem}': backend '${cfg.backend}' is not wired in this boot ` +
        `(wired: ${WIRED_EXTRACTION_BACKENDS.join(' | ')}). Fail-closed.`,
    );
  }
  // spec is threaded for symmetry with the extractor resolver (a future multi-responder fork keys
  // on it); v1 uses only the directory convention.
  void spec;
  return { ...cfg, agentId: stem };
}

/** Validate + default one history_window axis (positive safe integer; the S1 constants default). */
function responderWindowAxis(value: unknown, fallback: number, what: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ProductBootError(
      `responder history_window.${what} must be a positive integer (got ${String(value)}) — a ` +
        'malformed window would unbound or zero the reply model input. Fail-closed.',
    );
  }
  return value;
}

/** Shape-validate the optional store_context (the STORE_READ discipline; compose checks the store). */
function resolveResponderStoreContext(
  cfg: ResponderConfig,
): ConversationStoreContextRead | undefined {
  const raw = cfg.store_context;
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProductBootError(
      'responder store_context must be an object of { store, filter?, limit? }. Fail-closed.',
    );
  }
  if (typeof raw.store !== 'string' || raw.store.trim().length === 0) {
    throw new ProductBootError(
      'responder store_context.store must be a non-empty declared-store name. Fail-closed.',
    );
  }
  const limit = raw.limit === undefined ? STORE_READ_DEFAULT_LIMIT : raw.limit;
  if (
    typeof limit !== 'number' ||
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > STORE_READ_MAX_LIMIT
  ) {
    throw new ProductBootError(
      `responder store_context.limit must be a positive integer ≤ ${STORE_READ_MAX_LIMIT} ` +
        `(the STORE_READ cap discipline; got ${String(raw.limit)}). Fail-closed.`,
    );
  }
  let filter: Record<string, ContextFilterPayloadKey> | undefined;
  if (raw.filter !== undefined) {
    if (typeof raw.filter !== 'object' || raw.filter === null || Array.isArray(raw.filter)) {
      throw new ProductBootError(
        'responder store_context.filter must be an object of { <column>: <payload key> }. Fail-closed.',
      );
    }
    filter = {};
    for (const [column, key] of Object.entries(raw.filter as Record<string, unknown>)) {
      if (
        typeof key !== 'string' ||
        !(CONTEXT_FILTER_PAYLOAD_KEYS as readonly string[]).includes(key)
      ) {
        throw new ProductBootError(
          `responder store_context.filter maps column '${column}' to '${String(key)}' — only the ` +
            `closed turn-payload keys (${CONTEXT_FILTER_PAYLOAD_KEYS.join(', ')}) are addressable. ` +
            'Fail-closed.',
        );
      }
      filter[column] = key as ContextFilterPayloadKey;
    }
  }
  return { store: raw.store, limit, ...(filter ? { filter } : {}) };
}

/**
 * Build the `rollout.conversation.responder` factory for a conversation-declaring document.
 * `RAYSPEC_RESPONDER_MODE` selects WHERE the neutral Backend comes from — `live` (the S5
 * boot-side factory over the config's `backend`) or `deterministic` (the injected PLAN-B5 proof
 * Backend; dev/CI) — while the config resolve + validation run in BOTH modes (the e2e proves the
 * full config path with zero LLM creds). The factory closes over the raw db; the tenant is bound
 * per request from the SERVER-DERIVED value the capability binding passes.
 */
export function buildTurnResponder(
  env: NodeJS.ProcessEnv,
  specPath: string,
  spec: ProductSpec,
  db: Db,
  opts: DeployProductYamlOpts,
): ConversationTurnResponderFactory {
  const mode = requireEnv(
    env,
    'RAYSPEC_RESPONDER_MODE',
    "the conversation reply executor: 'live' (real runAgent) | 'deterministic' (injected Backend, dev/CI)",
  );
  const cfg = resolveResponderConfig(specPath, spec);
  const storeContext = resolveResponderStoreContext(cfg);
  const historyWindow = {
    turns: responderWindowAxis(cfg.history_window?.turns, DEFAULT_MAX_HISTORY_TURNS, 'turns'),
    chars: responderWindowAxis(cfg.history_window?.chars, DEFAULT_MAX_HISTORY_CHARS, 'chars'),
  };

  let backend: Backend;
  if (mode === 'live') {
    try {
      backend = makeExtractionBackend(env, cfg.backend);
    } catch (e) {
      if (e instanceof ProductBootError) {
        throw new ProductBootError(`responder '${cfg.agentId}': ${e.message}`);
      }
      throw e;
    }
  } else if (mode === 'deterministic') {
    if (!opts.deterministicResponderBackend) {
      throw new ProductBootError(
        'RAYSPEC_RESPONDER_MODE=deterministic requires an injected deterministic reply Backend ' +
          '(the platform ships none — product-free). Use live mode in production. Fail-closed.',
      );
    }
    backend = opts.deterministicResponderBackend;
  } else {
    throw new ProductBootError(
      `RAYSPEC_RESPONDER_MODE '${mode}' is not supported (wired: live | deterministic).`,
    );
  }

  return makeLiveTurnResponder({
    agentId: cfg.agentId,
    backend,
    model: cfg.model,
    instructions: cfg.instructions,
    historyWindow,
    ...(storeContext ? { storeContext } : {}),
    tdbFor: (tenantId: string) => forTenant(db, tenantId),
  });
}

// ── the boot ─────────────────────────────────────────────────────────────────────────────────────

export async function deployProductYamlSpec(
  db: Db,
  config: ServerConfig,
  baseDeps: Omit<AppDeps, 'engine'>,
  opts: DeployProductYamlOpts = {},
): Promise<DeployedProductBoot> {
  const env = opts.env ?? process.env;
  const specPath = config.specPath as string;
  const escapeHatchRoot = config.escapeHatchRoot as string;
  const specSource = readFileSync(specPath, 'utf8');

  const parsed = parseProductSpec(specSource);
  if (!parsed.ok) {
    throw new ProductBootError(
      `the Product-YAML spec at ${specPath} is invalid:\n${JSON.stringify(parsed.errors, null, 2)}`,
    );
  }
  const spec = parsed.value;

  // ── the fail-closed BOOT-SCOPE GATE ──────────────────────────────────────
  // A grammar-valid product doc can still declare a shape the composable v1 envelope cannot serve
  // end-to-end (the sufficiency finding): MULTI-SCOPE persistence (the single-scope law, enforced 3×
  // deeper in derive/compose/nodes but with an internal, less-actionable error) or a product-declared
  // WRITE/ADMIN surface (a non-capability POST view — an interpreted read on POST mounts + boots today,
  // caught by nothing else). Reject those HERE, at the front door, before any compose/derive/DBOS work,
  // with ONE actionable operator message. The SUPPORTED shape (an audio+stt+agents acceptance product) is a
  // no-op — it composes + boots unchanged (FENCE PARITY).
  try {
    assertProductScope(spec);
  } catch (e) {
    if (e instanceof ProductScopeError) throw new ProductBootError(e.message);
    throw e;
  }

  const tenantId = requireEnv(
    env,
    'RAYSPEC_PRODUCT_TENANT_ID',
    'the deployment tenant every workflow run + dispatcher binds to (single-node posture)',
  );

  // ── S4: DOC-DRIVEN env demands — each capability's env is demanded iff the spec USES it ────────
  // `withAudio` (declares audio_input/media_playback — the SAME predicate compose's conditional mount
  // keys off) ⇒ demand RAYSPEC_BLOB_ROOT + RAYSPEC_MEDIA_SIGNING_KEY (the audio stream/playback
  // byte-movers). `withFileInput` (the SAME compose predicate for the file mount) ⇒ demand
  // RAYSPEC_BLOB_ROOT only (the file upload is a stream ingest; there is NO file download in v1, so
  // the media-token service + RAYSPEC_MEDIA_SIGNING_KEY stay AUDIO-ONLY demands). `usesStt` ⇒ demand
  // STT_PROVIDER. `hasAgents` ⇒ demand RAYSPEC_EXTRACTION_MODE. A NON-audio, non-file, zero-agent,
  // no-stt doc boots demanding NONE of the four; an audio+stt+agents product demands ALL FOUR
  // exactly as before — a predicate that dropped a demand it needs would boot green and fail at
  // the first recording, so the demanded-env set for both is asserted in tests.
  const withAudio = declaresAudio(spec);
  const withFileInput = declaresFileInput(spec);
  // `withConversationInput` (the SAME compose predicate for the conversation mount) ⇒
  // demand RAYSPEC_RESPONDER_MODE + the per-product responder config (a submitted turn produces a
  // REAL reply; compose fail-closes without a wired responder). A non-conversation doc demands
  // NEITHER — the S2 negative-env law grows by exactly this one conditional demand.
  const withConversationInput = declaresConversationInput(spec);
  const usesStt = spec.workflows.some((wf) => wf.steps.some((s) => s.use?.startsWith('stt.')));
  const hasAgents = spec.extractors.length > 0;

  // ── 1. derive the Tier-A store bindings from the YAML (product-free) ──────────────────────────
  // S3: the capability-owned half comes from the SHARED spec-aware helper (composeCapabilityStores
  // — audio unconditional until S4; record_submissions iff the doc declares record_input), the
  // SAME source `composeProductDeploy` mounts from, so boot DDL and composed engineSpec can never
  // drift on which capability stores exist (the lockstep hazard, killed structurally).
  const capabilityStores = composeCapabilityStores(spec);
  const derived = deriveProductStores(spec, capabilityStores.names);
  const composedStores = [...capabilityStores.stores, ...derived.stores];
  // The durable `ON CONFLICT` target columns (declared `key` + the capability/collection/
  // transcript `*_ref` idiom) keep a SINGLE-column unique index; any other author `unique: true` column
  // is TENANT-SCOPED compound. Threaded to every product-store materializer below.
  const conflictKeys = deriveConflictKeys(spec, composedStores);
  const productTables = buildProductTables(composedStores, conflictKeys);
  opts.registerProductTables?.(productTables);

  // ── 2. reboot-safety: mount-vs-materialize (existing data survives a reboot) ──────────
  const queryFn = async (sql: string, params: unknown[]): Promise<Record<string, unknown>[]> =>
    (await db.$client.unsafe(sql, params as never[])) as unknown as Record<string, unknown>[];

  // The ENV-DRIVEN update-apply seam. `RAYSPEC_UPDATE_MIGRATION` is a PERSISTENT
  // deployment env re-read on EVERY boot, so we CLASSIFY the live schema vs the NEW spec FIRST (the same
  // read-only detectDrift the plain path uses) and then ROUTE — which is what makes a LEFTOVER update env
  // reboot-safe: a `present-matching` schema (the delta already applied on a prior boot) MOUNTS instead of
  // re-applying a non-idempotent delta (which would 42P07/duplicate-column crash-loop the boot). `deploy()`
  // stays BYTE-UNCHANGED throughout: it GATES each migration (scanMigrationSql over the reviewed allowlist —
  // a destructive statement WITHOUT a covering entry BLOCKS with a DeployError at [lint/gate], never a
  // silent apply) then applies it, evolving the live schema in place while existing rows survive.
  const updateMigrations = readProductUpdateMigrations({
    migrationPath: env.RAYSPEC_UPDATE_MIGRATION,
    allowlistPath: env.RAYSPEC_UPDATE_ALLOWLIST,
  });
  const preDrift = await detectDrift(composedStores, 'public', queryFn);
  const schemaState = classifyProductSchema(composedStores, preDrift);
  let migrations: PlannedMigration[];
  let deployMode: BootedServer['deployMode'];
  if (updateMigrations !== undefined) {
    // ENV-DRIVEN UPDATE mode. planUpdateBoot routes on the classify (FIX-1 — reboot-safe): drifted →
    // apply; absent → refuse actionably; present-matching → PROBE the delta's destructive targets live
    // (FIX-2) — a leftover env MOUNTS + loud log, but an UNAPPLIED pure-subset removal (a drop target
    // still exists) APPLIES, and an undeterminable destructive statement REFUSES fail-closed.
    // (S4: audio is now conditional, so a doc composing ZERO stores — no capability/declared/collection
    // stores — classifies 'present-matching' [classifyProductSchema: stores.length===0, UNIT-PINNED at
    // the db layer in classify-product-schema.test.ts], so the update path here never crashes on a
    // zero-store doc. NOTE — this specific zero-store→present-matching boot path is UNPROVEN-BY-TEST at
    // THIS layer: a truly-zero-store doc [no capabilities + no stores + no collections] composes to
    // nothing useful [no routes/workflows to serve], so it is not a realistic deploy target and no
    // fixture exercises it end-to-end; the load-bearing property is the db-layer classification above.)
    const plan = await planUpdateBoot(
      schemaState,
      updateMigrations,
      specPath,
      (m) => console.warn(m),
      makeSchemaProbe(queryFn, 'public'),
    );
    migrations = plan.migrations;
    deployMode = plan.deployMode;
  } else {
    // The plain (no update env) mount/materialize path — behavior-identical to the pre-S4 boot (the
    // drifted-refuse error TEXT now also points at the update seam).
    if (schemaState === 'drifted') {
      throw new ProductBootError(
        `the live product schema has DRIFTED from the spec at ${specPath}:\n${formatDrift(preDrift)}\n` +
          'mount-without-deploy refuses a drifted schema — reconcile via a reviewed forward migration: ' +
          'author the delta with `rayspec plan <new-spec> --against <old-spec>`, then boot with ' +
          '`rayspec deploy --apply-migration <delta.sql>` (or set RAYSPEC_UPDATE_MIGRATION to that ' +
          'delta) — or deploy against a clean DB. Fail-closed.',
      );
    }
    migrations =
      schemaState === 'absent'
        ? [
            {
              name: '0000_product_stores.sql',
              sql: generateProductSql(composedStores, conflictKeys),
              allowlist: [],
            },
          ]
        : [];
    deployMode = schemaState === 'absent' ? 'materialized' : 'mounted';
  }

  // ── 3. blob + media byte-movers — DEMANDED iff the doc moves blob bytes ─
  // A capability that moves binary bytes through stream routes needs the blob factory: audio (chunk
  // ingest + playback) and file_input (bounded upload ingest). `withBlob = withAudio || withFileInput`
  // drives the blobFactory + the RAYSPEC_BLOB_ROOT demand; the media-token service +
  // RAYSPEC_MEDIA_SIGNING_KEY stay AUDIO-ONLY (no file download in v1 — a playback route is the only
  // consumer). A non-audio, non-file doc demands NEITHER (and builds no blob factory / media-token
  // service). An audio-declaring product ⇒ both stay demanded with the EXACT messages in the EXACT
  // order (blob before media), byte-behavior-identical; a file-only doc's blob demand NAMES file_input.
  let blobFactory: BlobStoreFactory | undefined;
  let mediaTokenService: ReturnType<typeof createMediaTokenService> | undefined;
  const withBlob = withAudio || withFileInput;
  if (withBlob) {
    if (!config.blobRoot) {
      if (withAudio) {
        throw new ProductBootError(
          'the audio capability moves binary bytes through a stream route but RAYSPEC_BLOB_ROOT is ' +
            'unset. Set it to a writable directory (one subdir per tenant). Fail-closed.',
        );
      }
      throw new ProductBootError(
        'the file_input capability moves binary bytes through a stream route but RAYSPEC_BLOB_ROOT ' +
          'is unset. Set it to a writable directory (one subdir per tenant). Fail-closed.',
      );
    }
    blobFactory = makeFsBlobStoreFactory(config.blobRoot);
  }
  if (withAudio) {
    if (!config.mediaSigningKey) {
      throw new ProductBootError(
        'the audio capability declares a playback route but RAYSPEC_MEDIA_SIGNING_KEY is unset (the ' +
          'media-JWT verifier). Set a high-entropy secret ≥ 32 bytes. Fail-closed.',
      );
    }
    try {
      mediaTokenService = createMediaTokenService(config.mediaSigningKey);
    } catch (e) {
      throw new ProductBootError(`RAYSPEC_MEDIA_SIGNING_KEY is invalid: ${(e as Error).message}`);
    }
  }

  // ── 4. the extraction executor — DEMANDED iff the doc declares agents (S4) ────────────────────
  // A zero-agent doc has nothing to extract, so it demands NO RAYSPEC_EXTRACTION_MODE (the env is
  // only read inside the `hasAgents` guard). An agent-declaring product ⇒ the demand + the live/
  // deterministic dispatch stay exactly as before.
  let extractionMode: string | undefined;
  let liveAgent: ProductYamlRollout['liveAgent'] | undefined;
  let agents: AgentRuntimeRegistry | undefined;
  if (hasAgents) {
    extractionMode = requireEnv(
      env,
      'RAYSPEC_EXTRACTION_MODE',
      "the extraction executor: 'live' (real runAgent/gpt-5) | 'deterministic' (injected, dev/CI)",
    );
    if (extractionMode === 'live') {
      liveAgent = buildLiveAgent(env, specPath, spec);
    } else if (extractionMode === 'deterministic') {
      if (!opts.deterministicAgents) {
        throw new ProductBootError(
          'RAYSPEC_EXTRACTION_MODE=deterministic requires an injected deterministic executor (the ' +
            'platform ships none — product-free). Use live mode in production. Fail-closed.',
        );
      }
      agents = opts.deterministicAgents;
    } else {
      throw new ProductBootError(
        `RAYSPEC_EXTRACTION_MODE '${extractionMode}' is not supported (wired: live | deterministic).`,
      );
    }
  }

  // ── 5. the STT adapter — DEMANDED iff the doc declares an stt.* step (S4) ──────────────────────
  // STT_PROVIDER (and DEEPGRAM_API_KEY) are only demanded when the doc actually transcribes. A
  // deployment override (a fixtured fake) still wins. The real STT resolver reads the AUDIO
  // capability's blob chunks, so an stt.* step needs the audio capability's blob factory — a doc that
  // declares stt without audio is a fail-closed misconfiguration (never a crash on an absent factory).
  let stt: SttAdapter | undefined;
  if (usesStt) {
    if (opts.sttAdapter) {
      stt = opts.sttAdapter;
    } else if (!withAudio || !blobFactory) {
      // keyed on `withAudio`, NOT on the (now-generalized) blobFactory — a file-only doc
      // HAS a blob factory but no audio chunks for the STT resolver to read, so an stt.* step
      // without the audio capability keeps failing closed with this same named error.
      throw new ProductBootError(
        "the document declares an 'stt.*' workflow step, whose media resolver reads the audio " +
          "capability's blob-backed chunks, but no audio capability (audio_input/media_playback) is " +
          'declared — declare the audio capability or remove the stt step. Fail-closed.',
      );
    } else {
      stt = buildSttAdapter(env, blobFactory(tenantId), providerDefaultModel(spec, 'deepgram'));
    }
  }

  // ── 5b. F4: a NON-REAL provider selection boots fine but silently produces nothing usable in prod.
  //         Do NOT fail-close (a dev/CI boot legitimately uses these) — but make it LOUD so a
  //         fake-provider prod boot is operator-visible. (A zero-agent/no-stt/non-conversation doc
  //         trips no arm; the responder mode joins the banner for a conversation doc.)
  const banner = nonRealProviderBanner(
    env,
    Boolean(opts.sttAdapter),
    extractionMode ?? '',
    withConversationInput ? (env.RAYSPEC_RESPONDER_MODE?.trim() ?? '') : '',
  );
  if (banner) console.warn(banner);

  // ── 6. the REAL DBOS durable path (shared executor + workflow executor) ───────────────────────
  // resolveWorkflowRun rebuilds the tenant-bound registry off the composed product at FIRE time. The
  // composed product is bound AFTER deploy() (below) — the queue only fires at runtime, after launch.
  let composedProduct: ComposedProductDeploy | undefined;
  const wfExecutor = new DbosWorkflowExecutor({
    db,
    resolveWorkflowRun: (job, tdb) => {
      if (!composedProduct) {
        throw new Error(
          'resolveWorkflowRun before the product composition was bound (fail-closed).',
        );
      }
      const workflow = composedProduct.workflows.get(job.workflowId);
      if (!workflow)
        throw new Error(`durable worker: unknown workflow '${job.workflowId}' (fail-closed).`);
      return {
        workflow,
        registry: composedProduct.buildNodeRegistry({
          tdb,
          productTables,
          tenantId: job.tenantId,
        }),
      };
    },
  });
  const executor = new DbosDurableExecutor(
    {
      db,
      // No DIRECT agent RunJobs in the product workflow path (agent runs happen INSIDE workflow nodes
      // via runAgent) — a fail-closed resolver documents that.
      resolveRun: (job: RunJob): ResolvedRun => {
        throw new Error(
          `no direct agent runs in the product workflow path (got '${job.agentId}').`,
        );
      },
    },
    { name: spec.product.id, systemDatabaseUrl: config.dbosSystemDatabaseUrl },
  );
  executor.attachPreLaunchHook(() => wfExecutor.registerWorkflowJob());

  // ── 6b. the OPERATIONAL session-reprocess seam (audio products only) ──────────────────────────
  // Re-drives a session's declared finalized-session workflow as a FRESH durable run — a DISTINCT
  // idempotency key via the dispatcher's forceKey seam — over the session's CURRENT store state (the
  // operational recovery path: re-extract after a fix / recover a stuck session, with no manual DB
  // surgery). Injected into the app as `deps.sessionReprocessor`; `POST /v1/sessions/:id/reprocess`
  // drives it. TENANT-SCOPED: the existence check reads audio_sessions through the forTenant chokepoint
  // (a foreign/absent session → found:false → the route's uniform 404). The closure reads the OUTER
  // `composedProduct` (bound after deploy() below) at REQUEST time — long after boot — so its
  // ingress/workflows are resolved. Wired ONLY for an AUDIO doc (sessions exist); a non-audio product
  // omits it and the route fail-closes 501.
  const sessionReprocessor: SessionReprocessor | undefined = withAudio
    ? {
        async reprocessSession({ tenantId: reqTenant, sessionId, reason }) {
          if (!composedProduct) {
            throw new ProductBootError(
              'reprocess before the product composition was bound (fail-closed).',
            );
          }
          // STRUCTURAL tenant reconciliation (fail-closed) — MIRRORS the live finalize sink
          // (`WorkflowIngressSessionFinalizedSink`). The workflow dispatcher is BOUND to the deployment
          // `tenantId` at construction and enqueues EVERY run under it, IGNORING the request tenant. So
          // in a multi-org deployment a FOREIGN tenant whose own (tenant-namespaced) session collides on
          // the same client-chosen `session_id` (`unique:false`) would pass its OWN existence check
          // below and enqueue a durable run under the DEPLOYMENT tenant — a cross-tenant run that drops
          // the fail-closed reconciliation the live sink enforces. Reject a request tenant that is not
          // the bound deployment tenant with the route's uniform 404 (zero enqueue), exactly as the sink
          // throws rather than silently running under the wrong tenant. The existence check still runs
          // for the matching tenant (both must pass).
          if (reqTenant !== tenantId) return { found: false };
          // Tenant-scoped existence check via the SAME store facade the workflow nodes read through
          // (makeHandlerDb over forTenant — the tenant predicate is AND-combined by the chokepoint, so
          // a tenant can only ever see ITS OWN session).
          const handlerDb = makeHandlerDb(forTenant(db, reqTenant), productTables);
          const rows = await handlerDb.select(AUDIO_SESSIONS_STORE, { session_id: sessionId });
          if (rows.length === 0) return { found: false };
          // A DISTINCT run per reprocess (a fresh nonce) — never deduped to the session's finalized run.
          const { enqueued } = await reprocessFinalizedSession({
            ingress: composedProduct.ingress,
            tenantId: reqTenant,
            sessionId,
            nonce: randomUUID(),
            ...(reason !== undefined ? { reason } : {}),
          });
          return {
            found: true,
            enqueued: enqueued.map((e) => ({ workflowId: e.workflowId, runId: e.workflowRunId })),
          };
        },
      }
    : undefined;

  // ── 7. the rollout + deploy ───────────────────────────────────────────────────────────────────
  const productYaml: ProductYamlRollout = {
    tenantId,
    enqueuer: wfExecutor,
    stores: derived.stores,
    ...(derived.transcripts ? { transcripts: derived.transcripts } : {}),
    artifactCollections: derived.artifactCollections,
    // S4: stt/mediaPrep ride only when the doc uses them (compose requires rollout.stt iff usesStt).
    ...(stt ? { stt: { adapter: stt } } : {}),
    ...(liveAgent ? { liveAgent } : {}),
    ...(agents ? { agents } : {}),
    // media-prep is honored via RAYSPEC_MEDIA_PREP (ffmpeg | off; unset ⇒ ffmpeg). `off`
    // omits the hook entirely (playback stays the honest 409); an invalid value fail-closed above.
    // S4: only when the doc declares AUDIO — `&&` short-circuits so RAYSPEC_MEDIA_PREP is not even
    // read for a non-audio doc. (keyed on `withAudio`, not the generalized blobFactory —
    // media prep remuxes AUDIO chunks; a file-only doc has a blob factory but nothing to prep.)
    ...(withAudio && blobFactory !== undefined && mediaPrepEnabled(env)
      ? { mediaPrep: { blob: blobFactory } }
      : {}),
    // the tenant-bound blob READER for the `file_input.parse_text` node (the mediaPrep
    // mirror) — threaded iff the doc declares file_input (the same predicate that demanded
    // RAYSPEC_BLOB_ROOT above, so the factory is guaranteed here; the second guard is type
    // narrowing). compose fail-closes a parse_text step without it, so a file doc that never
    // parses composes unchanged and one that does gets the reader with zero extra env.
    ...(withFileInput && blobFactory !== undefined ? { file: { blob: blobFactory } } : {}),
    // the conversation turn responder — built iff the doc declares conversation_input
    // (demands RAYSPEC_RESPONDER_MODE + the per-product conversation/<agent_id>.responder.json;
    // compose fail-closes a conversation-declaring doc without it, so the guard here and the
    // compose guard can never disagree on when a responder exists).
    ...(withConversationInput
      ? { conversation: { responder: buildTurnResponder(env, specPath, spec, db, opts) } }
      : {}),
  };

  const PROBE_TENANT = '00000000-0000-0000-0000-0000000000aa';
  const target: DeployTarget = {
    driftSchema: 'public',
    async applyMigration(migration: PlannedMigration): Promise<void> {
      const ddl = migration.sql.replace(/-->\s*statement-breakpoint/g, '');
      await db.$client.begin(async (tx) => {
        await tx.unsafe(ddl);
      });
    },
    verifyTenantScoped(table: PgTable): void {
      const tdb = forTenant(db, PROBE_TENANT);
      (tdb.select as (t: PgTable) => unknown)(table);
    },
    query: queryFn,
  };

  const result = await deploy<ReturnType<typeof createAuthApp>>({
    specSource,
    migrations,
    target,
    rollout: {
      productTables,
      escapeHatchRoot,
      buildApp<App>(engine: DeclarativeEngine): App {
        // S4: the byte-movers ride only when the doc demands them — the blob
        // factory for audio OR file_input (stream routes), the media-token service for audio only
        // (both `undefined` otherwise — DeclarativeEngine.blobFactory/mediaTokenService are optional).
        const engineWithByteMovers: DeclarativeEngine = {
          ...engine,
          // Thread the product-profile conflict-key carve-out (computed above from
          // `deriveConflictKeys`) onto the engine so a store-route 409 on a GLOBAL-unique key column
          // uses the generic message (no cross-tenant existence oracle), while a tenant-scoped author-
          // `unique` column is still named. deploy() builds `engine` WITHOUT this (kill-set, byte-frozen);
          // we add it HERE, in the deployer-owned buildApp seam, so the kill-set stays untouched.
          conflictKeys,
          ...(blobFactory ? { blobFactory } : {}),
          ...(mediaTokenService ? { mediaTokenService } : {}),
        };
        return createAuthApp({
          ...baseDeps,
          ...(sessionReprocessor ? { sessionReprocessor } : {}),
          engine: engineWithByteMovers,
        }) as App;
      },
      productYaml,
    },
  });

  // ── 7b. the post-UPDATE drift GATE (fail-closed on an under-reconciling reviewed delta) ─
  // SCOPED to the branch that ACTUALLY applied a reviewed delta (deployMode === 'updated' — a 'drifted'
  // classify OR, per FIX-2, a 'present-matching' classify whose reviewed drop target still existed).
  // `deploy()`'s drift step is REPORT-ONLY: it returns `result.drift` but never aborts. A mount/materialize
  // boot (and, per FIX-1/FIX-2, an update env that classified 'present-matching' as a genuine LEFTOVER and
  // short-circuited to MOUNT) already has a drift-clean live schema, so this gate never fires for them;
  // only the 'updated' branch APPLIED a delta whose completeness `result.drift` must confirm — including a
  // present-matching subset DROP that must fully reconcile to the smaller spec. A delta that applies cleanly but UNDER-reconciles
  // (e.g. adds one of two new stores) would otherwise boot GREEN as `deployMode: 'updated'` — and the NEXT
  // plain reboot (no update env) would then classify 'drifted' and fail-close, bricking the live deployment
  // on a DELAY. We fail NOW instead (BEFORE the DBOS launch below). This mirrors the composition-root S3
  // gate exactly, for the LIVE env-driven boot path.
  if (deployMode === 'updated' && result.drift.length > 0) {
    throw new ProductBootError(
      `the reviewed UPDATE delta applied but the live product schema is STILL DRIFTED from the NEW ` +
        `spec at ${specPath} (the delta UNDER-reconciled — it did not fully close the gap):\n` +
        `${formatDrift(result.drift)}\n` +
        'IMPORTANT — the delta migration(s) are ALREADY COMMITTED: deploy() applies each migration in ' +
        'its own transaction and this drift check fires POST-migrate, so the schema is now in a ' +
        'partially-evolved MID-STATE. This gate fails the update NOW rather than booting green as ' +
        "'updated' and letting the NEXT plain reboot fail-close on the residual drift (a delayed brick). " +
        'Recovery (FORWARD-FIX discipline — NEVER a down-migration / hand-patch): re-diff the live ' +
        'schema vs the NEW spec, author the COMPLETING forward migration that closes the remaining ' +
        'drift, and re-run the update with it. Fail-closed.',
    );
  }

  // ── 8. bind the composed product, THEN launch (a recovered job resolves cleanly) ──────────────
  composedProduct = result.product;
  if (!composedProduct) {
    throw new ProductBootError('deploy() returned no composed product runtime (unexpected).');
  }
  await executor.start();
  await wfExecutor.registerQueueAfterLaunch();

  const durableExecutorShutdown = async (): Promise<void> => {
    await executor.shutdown();
  };

  const eraseTenantNow: BootedServer['eraseTenantNow'] = (
    targetTenant: string,
    eraseOpts?: { dryRun?: boolean; journalScrub?: boolean },
  ) =>
    eraseTenant({
      db,
      tenantId: targetTenant,
      productTables,
      // A deploy that moves NO blob bytes (non-audio, non-file) wires no
      // blob factory — eraseTenant tolerates an absent blob store (blobs:'no-backend'). Any doc
      // that DOES (audio or file_input) supplies its tenant-bound blob store, so a tenant erasure
      // sweeps the uploaded file blobs too (closing the sweep's GDPR-hole insufficiency).
      ...(blobFactory ? { blob: blobFactory(targetTenant) } : {}),
      audit: baseDeps.auditStore,
      enabled: config.erasureEnabled,
      dryRun: eraseOpts?.dryRun ?? false,
      journalScrub: eraseOpts?.journalScrub ?? false,
      stores: composedStores,
    });

  return {
    app: result.app,
    declaredRoutes: result.spec.api.map((route) => {
      const a = route.action;
      const action =
        a.kind === 'stream'
          ? `stream:${a.mode}.${a.handler}`
          : a.kind === 'handler'
            ? `handler:${a.handler}`
            : a.kind === 'store'
              ? `store:${a.store}.${a.op}`
              : a.kind === 'agent'
                ? `agent:${a.agent}`
                : `unknown`;
      return { method: route.method, path: route.path, action };
    }),
    declaredAgents: [],
    declaredCronTriggers: [],
    deployMode,
    // The report-only post-migrate drift (empty on a successful mount/materialize/update boot;
    // a residual UPDATE drift threw the fail-closed gate above and never reaches here).
    drift: result.drift,
    durableExecutorShutdown,
    eraseTenantNow,
  };
}

/** The declared default model for a provider (from `deployment_overrides.providers`), if any. */
function providerDefaultModel(spec: ProductSpec, provider: string): string | undefined {
  const providers = spec.deployment_overrides?.providers as
    | Record<string, { default_model?: string }>
    | undefined;
  return providers?.[provider]?.default_model;
}
