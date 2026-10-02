/**
 * The supervisor: with role separation, the process the operator starts never imports application
 * code, and the process that imports it never holds the migration or snapshot role.
 *
 * `rayspec deploy` and `rayspec-serve` keep the migration role's connection in the process the
 * operator started (after re-executing it without the connection in its environment block,
 * supervisor-handoff.ts) and start the application in a child process: the boot rehearsal, which
 * imports the application's handlers and extensions, and then serving. The child's environment never
 * held a privileged connection, nor a variable naming a file that holds one, and no message to it
 * carries one. Each schema change of the boot runs here instead, when the child reaches it in the
 * boot's own order: the bundle apply, the platform migration chain, row-level isolation, each product
 * migration, the workflow engine's schema. The child names a step; the supervisor derives every
 * statement it runs itself — the product DDL from the document, a delta from the file the operator
 * named — and never executes SQL the child sends. Once the child reports the schema work done, the
 * migration connection is closed and no further step is accepted.
 *
 * The supervisor then waits: it forwards SIGINT and SIGTERM to the child, bounds the child's
 * shutdown by its drain plus 30 seconds, and exits with the child's exit code. Runtime control that
 * needs privilege (an export's write barrier and snapshot, a resume, an import) runs in the
 * operator's CLI process, which imports no application code either; the child learns the source
 * fence from the database.
 *
 * What the runtime cannot close by itself is a process of the same operating-system user reading
 * what the supervisor can read: a `_FILE` mount or a `.env` file holding the credential, the
 * supervisor's memory where the kernel allows it, a core file. `sameUserConditions` names each that is
 * open; the managed posture refuses to boot while any is, every other posture warns.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DeployError, type PlannedMigration } from '@rayspec/api-auth';
import type { BundleError } from '@rayspec/bundle-contract';
import {
  installOutputRedaction,
  redactText,
  redactValue,
  registerSecretValues,
} from '@rayspec/core';
import { type Db, generateProductSql, makeDb, scanMigrationSql } from '@rayspec/db';
import {
  migrateWorkflowSystemDatabase,
  preloadWorkflowSystemMigrations,
} from '@rayspec/durable-dbos';
import { detectSpecKind, parseProductSpec, parseSpec, type StoreSpec } from '@rayspec/spec';
import { parseBlobBackendRecord } from './blob-backend-record.js';
import { BootConfigError } from './boot-config-error.js';
import {
  applyMigrations,
  type BeforeSchemaChangeResult,
  type BootFacts,
  currentRole,
  type ServerConfig,
} from './composition-root.js';
import { DeployApply, RuntimeApplyError } from './deploy-apply.js';
import { ProductBootError, productSchemaOf, readProductUpdateMigrations } from './product-boot.js';
import { guardSupervisorImports } from './supervisor-guard.js';
import {
  MIGRATION_CONNECTION_VAR,
  PRIVILEGED_CONNECTION_VARS,
  privilegedOrigin,
  SNAPSHOT_CONNECTION_VAR,
  SUPERVISOR_HANDOFF_VAR,
} from './supervisor-handoff.js';

/** The version of the messages the supervisor and the application process exchange. */
export const SUPERVISOR_PROTOCOL = 1;

/** The largest message the application process may send, but for a product migration's document. */
export const MAX_MESSAGE_BYTES = 64 * 1024;
/** The largest product-migration message: a merged document of up to 4 MiB. */
export const MAX_DOCUMENT_MESSAGE_BYTES = 4 * 1024 * 1024 + MAX_MESSAGE_BYTES;

/** How long past its drain the application process may take to stop before it is killed. */
export const SHUTDOWN_GRACE_MS = 30_000;

/** The name a first product materialization is planned under, by both deployers. */
export const FIRST_PRODUCT_MIGRATION = '0000_product_stores.sql';

/** The schema steps the application process may ask for, in the order a boot asks for them. */
export type SchemaStep =
  | 'before-schema-change'
  | 'platform-chain'
  | 'tenant-isolation'
  | 'product-migration'
  | 'workflow-system-schema'
  | 'schema-done';

const STEPS: readonly SchemaStep[] = [
  'before-schema-change',
  'platform-chain',
  'tenant-isolation',
  'product-migration',
  'workflow-system-schema',
  'schema-done',
];

/** What the application process sends. */
export type ChildMessage =
  | {
      type: 'request';
      id: number;
      step: Exclude<SchemaStep, 'before-schema-change' | 'product-migration'>;
    }
  | { type: 'request'; id: number; step: 'before-schema-change'; facts: BootFacts }
  | { type: 'request'; id: number; step: 'product-migration'; name: string; specSource?: string }
  | { type: 'serving' };

/** A refusal raised by a schema step, as it travels back to the application process. */
export interface SerializedRefusal {
  kind: 'apply' | 'config' | 'product' | 'deploy' | 'error';
  message: string;
  errors?: BundleError[];
  missing?: string[];
  step?: DeployError['step'];
}

/** What the supervisor sends. */
export type SupervisorMessage =
  | { type: 'start'; protocol: number; instruction: unknown }
  | { type: 'reply'; protocol: number; id: number; ok: true; result: BeforeSchemaChangeResult }
  | { type: 'reply'; protocol: number; id: number; ok: false; error: SerializedRefusal };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/**
 * Validate one message from the application process: the type, the protocol version, exactly the
 * fields of that type and no other, and the size bound. Returns the message, or what is wrong with
 * it.
 */
export function parseChildMessage(raw: unknown): ChildMessage | string {
  if (!isRecord(raw)) return 'a message that is not an object';
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(raw), 'utf8');
  } catch {
    return 'a message that cannot be serialized';
  }
  if (raw.protocol !== SUPERVISOR_PROTOCOL) return 'a message of another protocol version';
  if (raw.type === 'serving') {
    if (!hasOnlyKeys(raw, ['type', 'protocol'])) return 'a serving message with unknown fields';
    return { type: 'serving' };
  }
  if (raw.type !== 'request') return 'a message of an unknown type';
  const step = raw.step;
  if (typeof step !== 'string' || !STEPS.includes(step as SchemaStep)) {
    return 'a request for an unknown step';
  }
  const id = raw.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
    return 'a request without a valid id';
  }
  const limit = step === 'product-migration' ? MAX_DOCUMENT_MESSAGE_BYTES : MAX_MESSAGE_BYTES;
  if (size > limit) return `a ${step} request over ${limit} bytes`;
  const base = ['type', 'protocol', 'id', 'step'];
  if (step === 'before-schema-change') {
    if (!hasOnlyKeys(raw, [...base, 'facts']) || !isRecord(raw.facts)) {
      return 'a before-schema-change request without its facts';
    }
    const facts = raw.facts;
    if (!hasOnlyKeys(facts, ['blobBackend'])) return 'boot facts with unknown fields';
    if (facts.blobBackend === undefined) {
      return { type: 'request', id, step, facts: {} };
    }
    const blobBackend = parseBlobBackendRecord(facts.blobBackend);
    if (blobBackend === null) return 'boot facts with an invalid blob backend';
    return { type: 'request', id, step, facts: { blobBackend } };
  }
  if (step === 'product-migration') {
    if (!hasOnlyKeys(raw, [...base, 'name', 'specSource'])) {
      return 'a product-migration request with unknown fields';
    }
    if (typeof raw.name !== 'string' || raw.name.length === 0 || raw.name.length > 256) {
      return 'a product-migration request without a valid name';
    }
    if (raw.specSource !== undefined && typeof raw.specSource !== 'string') {
      return 'a product-migration request with a document that is not text';
    }
    return {
      type: 'request',
      id,
      step,
      name: raw.name,
      ...(raw.specSource !== undefined ? { specSource: raw.specSource } : {}),
    };
  }
  if (!hasOnlyKeys(raw, base)) return `a ${step} request with unknown fields`;
  return {
    type: 'request',
    id,
    step: step as Exclude<SchemaStep, 'before-schema-change' | 'product-migration'>,
  };
}

/** A request out of order, or one the supervisor will not run: the application process is stopped. */
export class SupervisorProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupervisorProtocolError';
  }
}

/** A step's refusal, ready to send: the class, its message and data, every known secret redacted. */
export function serializeRefusal(err: unknown): SerializedRefusal {
  const message = redactText(err instanceof Error ? err.message : String(err));
  if (err instanceof RuntimeApplyError) {
    return { kind: 'apply', message, errors: redactValue([...err.errors]) };
  }
  if (err instanceof ProductBootError) return { kind: 'product', message };
  if (err instanceof DeployError) return { kind: 'deploy', message, step: err.step };
  if (err instanceof BootConfigError) {
    return { kind: 'config', message, missing: [...err.missing] };
  }
  return { kind: 'error', message };
}

/** The error a serialized refusal stands for, of the same class, so a boot treats it as its own. */
export function refusalError(refusal: SerializedRefusal): Error {
  switch (refusal.kind) {
    case 'apply':
      return new RuntimeApplyError(refusal.errors ?? []);
    case 'config':
      return new BootConfigError(refusal.message, refusal.missing ?? []);
    case 'product': {
      const err = new ProductBootError('');
      err.message = refusal.message;
      return err;
    }
    case 'deploy': {
      const err = new DeployError(refusal.step ?? 'migrate', '');
      err.message = refusal.message;
      return err;
    }
    default:
      return new Error(refusal.message);
  }
}

/** What the schema steps run with. */
export interface SchemaStepsOptions {
  /** The supervisor's configuration: it holds the migration connection. */
  config: ServerConfig;
  /** The supervisor's own step before any schema change (the bundle apply). */
  beforeSchemaChange?: (
    db: Db,
    tenantIsolation: { runtimeRole: string } | undefined,
    facts: BootFacts,
  ) => Promise<BeforeSchemaChangeResult | undefined>;
  /**
   * The reviewed delta the operator named, as the supervisor read it; read from
   * `RAYSPEC_UPDATE_MIGRATION` / `RAYSPEC_UPDATE_ALLOWLIST` when omitted.
   */
  updateMigrations?: PlannedMigration[];
  warn: (line: string) => void;
}

type StepState = 'start' | 'before' | 'platform' | 'isolated' | 'done';

/**
 * The schema steps of one supervised boot, run as the migration role in the order a boot runs them.
 * A step out of that order, a second platform chain, an unknown migration name or any step after the
 * schema work is done is a protocol error.
 */
export class SchemaSteps {
  readonly #options: SchemaStepsOptions;
  #state: StepState = 'start';
  #migrationDb: Db | undefined;
  #runtimeDb: Db | undefined;
  #apply: DeployApply | undefined;
  #runtimeRole: string | undefined;
  #workflowSystem = false;
  readonly #migrated = new Set<string>();
  #specSource: string | undefined;

  constructor(options: SchemaStepsOptions) {
    this.#options = options;
  }

  /** Whether the schema work is over (or never started) and nothing is held open. */
  get done(): boolean {
    return this.#state === 'done';
  }

  #migrationPool(): Db {
    const url = this.#options.config.migrationDatabaseUrl;
    if (url === undefined)
      throw new SupervisorProtocolError('no migration connection is configured');
    this.#migrationDb ??= makeDb(url, 2);
    return this.#migrationDb;
  }

  /**
   * Read everything the schema steps will read or load from disk, before the application process
   * exists: the document, and the workflow engine's migration module. Once the application runs
   * as the same OS user it could change those files; the steps then use what was read here.
   */
  prepareBeforeApplication(): void {
    this.#documentSource();
    if (this.#options.config.migrationDbosSystemDatabaseUrl !== undefined) {
      preloadWorkflowSystemMigrations();
    }
  }

  /** The document as read before the application process started, if any. */
  get documentSnapshot(): string | undefined {
    return this.#specSource;
  }

  #documentSource(): string | undefined {
    const specPath = this.#options.config.specPath;
    if (specPath === undefined) return undefined;
    this.#specSource ??= readFileSync(specPath, 'utf8');
    return this.#specSource;
  }

  async #tenantIsolation(): Promise<{ runtimeRole: string }> {
    if (this.#runtimeRole === undefined) {
      this.#runtimeDb ??= makeDb(this.#options.config.databaseUrl, 1);
      this.#runtimeRole = await currentRole(this.#runtimeDb);
    }
    return { runtimeRole: this.#runtimeRole };
  }

  async #deployApply(): Promise<DeployApply> {
    if (this.#apply === undefined) {
      const db = this.#migrationPool();
      const config = this.#options.config;
      const specSource = this.#documentSource();
      this.#apply = new DeployApply({
        db,
        migratePlatform: () => applyMigrations(db, { lockTimeoutMs: config.schemaLockTimeoutMs }),
        ...(specSource !== undefined ? { specSource } : {}),
        lockTimeoutMs: config.schemaLockTimeoutMs,
        warn: this.#options.warn,
        tenantIsolation: await this.#tenantIsolation(),
      });
    }
    return this.#apply;
  }

  #expect(...states: StepState[]): void {
    if (!states.includes(this.#state)) {
      throw new SupervisorProtocolError(`a step asked for out of order (after ${this.#state})`);
    }
  }

  /** Run one requested step. */
  async run(
    message: Exclude<ChildMessage, { type: 'serving' }>,
  ): Promise<BeforeSchemaChangeResult> {
    switch (message.step) {
      case 'before-schema-change': {
        this.#expect('start');
        this.#state = 'before';
        const hook = this.#options.beforeSchemaChange;
        if (hook === undefined) return {};
        return (
          (await hook(this.#migrationPool(), await this.#tenantIsolation(), message.facts)) ?? {}
        );
      }
      case 'platform-chain':
        this.#expect('start', 'before');
        this.#state = 'platform';
        await (await this.#deployApply()).platformChain();
        return {};
      case 'tenant-isolation':
        this.#expect('platform');
        this.#state = 'isolated';
        await (await this.#deployApply()).tenantIsolation();
        return {};
      case 'product-migration': {
        this.#expect('isolated');
        if (this.#migrated.has(message.name)) {
          throw new SupervisorProtocolError(
            `the product migration ${message.name} asked for twice`,
          );
        }
        this.#migrated.add(message.name);
        const { migration, declared } = this.#productMigration(message.name, message.specSource);
        await (await this.#deployApply()).productMigration(migration, declared);
        return {};
      }
      case 'workflow-system-schema': {
        this.#expect('isolated');
        if (this.#workflowSystem) {
          throw new SupervisorProtocolError('the workflow system schema asked for twice');
        }
        this.#workflowSystem = true;
        const url = this.#options.config.migrationDbosSystemDatabaseUrl;
        if (url !== undefined) await migrateWorkflowSystemDatabase(url);
        return {};
      }
      case 'schema-done':
        this.#expect('isolated');
        this.#state = 'done';
        await this.close();
        return {};
    }
  }

  /**
   * The migration a request names, derived here: the first materialization from the document's
   * stores, or the reviewed delta the operator named, which must pass the destructive-statement gate.
   */
  #productMigration(
    name: string,
    mergedSource: string | undefined,
  ): {
    migration: PlannedMigration;
    declared: { stores: StoreSpec[]; conflictKeys?: Map<string, ReadonlySet<string>> };
  } {
    const source = this.#documentSource();
    if (source === undefined)
      throw new SupervisorProtocolError('a product migration without a document');
    let stores: StoreSpec[];
    let conflictKeys: Map<string, ReadonlySet<string>> | undefined;
    if (detectSpecKind(source) === 'product') {
      const parsed = parseProductSpec(source);
      if (!parsed.ok)
        throw new SupervisorProtocolError('a product migration for an invalid document');
      ({ stores, conflictKeys } = productSchemaOf(parsed.value));
    } else {
      stores = this.#backendStores(source, mergedSource);
    }
    let migration: PlannedMigration;
    if (name === FIRST_PRODUCT_MIGRATION) {
      migration = {
        name,
        sql:
          conflictKeys === undefined
            ? generateProductSql(stores)
            : generateProductSql(stores, conflictKeys),
        allowlist: [],
      };
    } else {
      const delta = this.#options.updateMigrations?.find((m) => m.name === name);
      if (delta === undefined) {
        throw new SupervisorProtocolError(
          `a product migration the operator did not name (${name})`,
        );
      }
      const scan = scanMigrationSql(delta.sql, delta.allowlist ?? []);
      if (!scan.pass) {
        throw new DeployError(
          'lint/gate',
          `1 migration(s) carry a destructive statement WITHOUT a reviewed allowlist entry: ${name}. ` +
            'Add a reviewed allowlist entry or revise.',
        );
      }
      migration = delta;
    }
    return {
      migration,
      declared: conflictKeys === undefined ? { stores } : { stores, conflictKeys },
    };
  }

  /**
   * A backend document's stores. With extensions, the document the application process merged
   * them into is the only one that names a pack's stores (a pack is code the supervisor never
   * loads): it must parse, carry no extension left to load, and keep every store of the operator's
   * document as it is, so a merge can only add stores, as merging does.
   */
  #backendStores(source: string, mergedSource: string | undefined): StoreSpec[] {
    const base = parseSpec(source);
    if (!base.ok) throw new SupervisorProtocolError('a product migration for an invalid document');
    if (base.value.extensions.length === 0) return [...base.value.stores];
    if (mergedSource === undefined) {
      throw new SupervisorProtocolError('a product migration without the merged document');
    }
    const merged = parseSpec(mergedSource);
    if (!merged.ok || merged.value.extensions.length > 0) {
      throw new SupervisorProtocolError('a merged document that does not parse as a merge');
    }
    const mergedStores = new Map(merged.value.stores.map((s) => [s.name, JSON.stringify(s)]));
    for (const store of base.value.stores) {
      if (mergedStores.get(store.name) !== JSON.stringify(store)) {
        throw new SupervisorProtocolError(
          `a merged document that changes the operator's store ${store.name}`,
        );
      }
    }
    return [...merged.value.stores];
  }

  /** End both pools. The steps accept nothing afterwards. */
  async close(): Promise<void> {
    this.#state = 'done';
    const pools = [this.#migrationDb, this.#runtimeDb];
    this.#migrationDb = undefined;
    this.#runtimeDb = undefined;
    await Promise.all(pools.map((db) => db?.$client.end({ timeout: 5 }).catch(() => {})));
  }
}

/** The values the application process's environment may not carry: both connections and their passwords. */
export function privilegedSecretValues(privileged: NodeJS.ProcessEnv): string[] {
  const values: string[] = [];
  for (const name of [MIGRATION_CONNECTION_VAR, SNAPSHOT_CONNECTION_VAR]) {
    const value = privileged[name]?.trim();
    if (value === undefined || value === '') continue;
    values.push(value);
    try {
      const password = decodeURIComponent(new URL(value).password);
      if (password.length >= 8) values.push(password);
    } catch {
      // Not a URL: the value itself is what is looked for.
    }
  }
  return values;
}

/**
 * The application process's environment: the supervisor's, without the privileged connections, their
 * `_FILE` forms and the handoff variable, with `.env` loading off (the supervisor already loaded it).
 * A variable other than `DATABASE_URL` that carries a privileged connection or its password refuses
 * the boot: the application process would hold the credential under another name.
 */
export function childEnvironment(
  env: NodeJS.ProcessEnv,
  secrets: readonly string[],
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of [...PRIVILEGED_CONNECTION_VARS, SUPERVISOR_HANDOFF_VAR]) delete out[name];
  out.RAYSPEC_SKIP_DOTENV = '1';
  for (const [name, value] of Object.entries(out)) {
    if (name === 'DATABASE_URL' || value === undefined) continue;
    if (secrets.some((secret) => value.includes(secret))) {
      throw new BootConfigError(
        `Boot aborted — ${name} carries the migration or snapshot connection, or its password. The ` +
          'application process is started without those connections, so it may not receive them ' +
          `under another name either; remove the value from ${name}.`,
      );
    }
  }
  return out;
}

/** What `sameUserConditions` reads; a test passes its own. */
export interface SameUserProbe {
  platform: NodeJS.Platform;
  /** A file's text, or undefined when it cannot be read. */
  read(path: string): string | undefined;
}

const defaultProbe: SameUserProbe = {
  platform: process.platform,
  read: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
};

/** The hard limit on core-file size `/proc/self/limits` states, or undefined when it cannot tell. */
function coreHardLimit(limits: string | undefined): string | undefined {
  const line = limits?.split('\n').find((l) => l.startsWith('Max core file size'));
  return line?.trim().split(/\s+/)[5];
}

/**
 * The ways a process of the supervisor's operating-system user — the application process — could
 * still reach a privileged connection the supervisor holds, each as one sentence. `privileged` is the
 * environment copy the configuration was read from.
 */
export function sameUserConditions(
  privileged: NodeJS.ProcessEnv,
  probe: SameUserProbe = defaultProbe,
): string[] {
  const open: string[] = [];
  for (const name of PRIVILEGED_CONNECTION_VARS) {
    const value = privileged[name];
    if (value === undefined || value.trim() === '') continue;
    const origin = privilegedOrigin(name);
    if (name.endsWith('_FILE')) {
      open.push(
        `${name} names a file the application process can read: it runs as the supervisor's ` +
          `user. Pass ${name.slice(0, -5)} in the environment instead`,
      );
    } else if (origin === 'dotenv') {
      open.push(
        `${name} was read from a .env file the application process can read: it runs as the ` +
          "supervisor's user. Pass it in the environment instead",
      );
    } else if (origin === 'environment') {
      open.push(
        `${name} stays in the supervisor's environment block, which the application process can ` +
          'read: this Node.js cannot re-execute a process (process.execve)',
      );
    }
  }
  if (probe.platform === 'linux') {
    const scope = probe.read('/proc/sys/kernel/yama/ptrace_scope')?.trim();
    if (scope === undefined || scope === '0') {
      open.push(
        "the kernel lets a process read the memory of another process of its user (Yama's " +
          "ptrace_scope is 0 or absent), so the application process could read the supervisor's; " +
          'set kernel.yama.ptrace_scope to 1 or higher',
      );
    }
    const core = coreHardLimit(probe.read('/proc/self/limits'));
    if (core !== '0') {
      open.push(
        'the supervisor may write a core file, which a process of its user could make it write and ' +
          'then read; start it where /bin/sh exists (the entrypoint sets the hard limit to 0 through ' +
          'it) or with a hard core-file limit of 0',
      );
    }
  }
  return open;
}

/** How a supervised application process ended. */
export interface SupervisedExit {
  /** Its exit code, or null when a signal ended it. */
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The first signal the supervisor forwarded to it, if any. */
  forwarded?: NodeJS.Signals;
  /** Whether it reported that it serves. */
  served: boolean;
  /** What it did wrong, when it broke the protocol and was killed. */
  violation?: string;
  /** The bound it exceeded, in ms, when it did not stop after a forwarded signal and was killed. */
  timedOutAfterMs?: number;
}

/** What `superviseServing` runs. */
export interface SuperviseOptions extends Omit<SchemaStepsOptions, 'warn'> {
  /** The module the application process runs. */
  entry: string;
  /** What it is told to serve, sent first; it never carries a privileged value. */
  instruction: unknown;
  /** The entrypoint's prefix for its own lines (`[rayspec deploy]`). */
  prefix: string;
  /** The environment copy the configuration was read from (it holds the privileged connections). */
  privileged: NodeJS.ProcessEnv;
  /** The application's directories, which this process must never load a module from. */
  applicationDirectories: readonly string[];
  /** The drain the application process is given after a forwarded signal. */
  drainMs: number;
  /**
   * How long past its drain the application process may take to stop after a forwarded signal
   * before it is killed; `SHUTDOWN_GRACE_MS` by default. A test shortens it.
   */
  shutdownGraceMs?: number;
  /** What the same-user conditions are read from; this host by default. A test passes its own. */
  sameUserProbe?: SameUserProbe;
  /** Where a warning goes; `console.warn` by default. */
  warn?: (line: string) => void;
}

/**
 * Start the application process and supervise it until it exits: run the schema steps it asks for,
 * forward SIGINT and SIGTERM, bound its shutdown. Throws a `BootConfigError` before starting it when
 * the boot must be refused (the managed posture with a same-user condition open; a privileged value
 * under another variable).
 */
export async function superviseServing(options: SuperviseOptions): Promise<SupervisedExit> {
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const secrets = privilegedSecretValues(options.privileged);
  registerSecretValues(secrets);
  installOutputRedaction();

  const open = sameUserConditions(options.privileged, options.sameUserProbe);
  if (open.length > 0 && options.config.hostingPosture === 'managed') {
    throw new BootConfigError(
      'Boot aborted — the managed hosting posture keeps the migration and snapshot connections ' +
        'away from the application process, and here it cannot: ' +
        `${open.join('; ')}. See docs/hardened-posture.md.`,
    );
  }
  for (const condition of open) {
    warn(`[rayspec] WARNING — ${condition}. See docs/threat-model.md, "Secrets".`);
  }

  const env = childEnvironment(process.env, secrets);
  const instructionText = JSON.stringify(options.instruction);
  if (secrets.some((secret) => instructionText.includes(secret))) {
    throw new BootConfigError(
      'Boot aborted — a value the application process receives carries the migration or snapshot ' +
        'connection, or its password; remove it.',
    );
  }
  const updateMigrations =
    options.updateMigrations ??
    readProductUpdateMigrations({
      migrationPath: process.env.RAYSPEC_UPDATE_MIGRATION,
      allowlistPath: process.env.RAYSPEC_UPDATE_ALLOWLIST,
    });
  const unguard = guardSupervisorImports(options.applicationDirectories);
  const steps = new SchemaSteps({
    config: options.config,
    warn,
    ...(options.beforeSchemaChange !== undefined
      ? { beforeSchemaChange: options.beforeSchemaChange }
      : {}),
    ...(updateMigrations !== undefined ? { updateMigrations } : {}),
  });
  try {
    steps.prepareBeforeApplication();
  } catch (err) {
    unguard();
    await steps.close();
    throw err;
  }
  const execArgv = process.execArgv.filter((arg) => !/^--(inspect|debug)/.test(arg));
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [...execArgv, options.entry], {
      env,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      serialization: 'json',
    });
  } catch (err) {
    unguard();
    await steps.close();
    throw err;
  }
  return await new Promise<SupervisedExit>((resolve, reject) => {
    const exit: SupervisedExit = { code: null, signal: null, served: false };
    let busy: Promise<unknown> = Promise.resolve();
    let inFlight = false;
    let bound: ReturnType<typeof setTimeout> | undefined;

    const send = (message: SupervisorMessage) => {
      if (child.connected) child.send(message, () => {});
    };
    const violate = (what: string) => {
      if (exit.violation !== undefined) return;
      exit.violation = what;
      child.kill('SIGKILL');
    };
    const forward = (signal: NodeJS.Signals) => {
      exit.forwarded ??= signal;
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      const limit = options.drainMs + (options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS);
      bound ??= setTimeout(() => {
        exit.timedOutAfterMs = limit;
        child.kill('SIGKILL');
      }, limit);
    };
    const onSigint = () => forward('SIGINT');
    const onSigterm = () => forward('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    child.on('message', (raw: unknown) => {
      const message = parseChildMessage(raw);
      if (typeof message === 'string') return violate(message);
      if (message.type === 'serving') {
        exit.served = true;
        return;
      }
      if (inFlight) return violate('a request before the previous one was answered');
      inFlight = true;
      busy = steps
        .run(message)
        .then(
          (result) =>
            send({
              type: 'reply',
              protocol: SUPERVISOR_PROTOCOL,
              id: message.id,
              ok: true,
              result,
            }),
          (err: unknown) => {
            if (err instanceof SupervisorProtocolError) return violate(err.message);
            send({
              type: 'reply',
              protocol: SUPERVISOR_PROTOCOL,
              id: message.id,
              ok: false,
              error: serializeRefusal(err),
            });
          },
        )
        .finally(() => {
          inFlight = false;
        });
    });
    child.once('error', (err) => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      unguard();
      void steps.close().then(() => reject(err));
    });
    child.once('exit', (code, signal) => {
      exit.code = code;
      exit.signal = signal;
      if (bound !== undefined) clearTimeout(bound);
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      unguard();
      // A step still running finishes (each is all-or-nothing under its lease) before the pools end.
      void busy
        .catch(() => {})
        .then(() => steps.close())
        .then(() => resolve(exit));
    });
    send({ type: 'start', protocol: SUPERVISOR_PROTOCOL, instruction: options.instruction });
  });
}

/** How the supervisor ends after its application process ended. */
export interface SupervisorEnding {
  /** The exit code. */
  code: number;
  /**
   * Why, when the application process ended in a way it did not explain itself (a crash, a kill, a
   * protocol violation): the supervisor prints it after the entrypoint's prefix. Absent when the
   * application process reported its own ending.
   */
  reason?: string;
  /**
   * Whether the application process could not write its own report: a signal it was not sent by the
   * supervisor ended it, or the supervisor killed it. Only then does the supervisor record the
   * reason as the refusal its report carries; an application process that exited wrote its report
   * as it left, and a second one would break the one-envelope contract of `--json`.
   */
  unreported: boolean;
  /** The signal to end by instead, when a forwarded signal ended the application process. */
  signal?: NodeJS.Signals;
}

/**
 * Decide how the supervisor ends: with the application process's own exit code, by the signal the
 * supervisor forwarded when that ended it (as the single process ended before), or with 1 and the
 * reason when it was killed, crashed or broke the protocol.
 */
export function supervisorEnding(exit: SupervisedExit): SupervisorEnding {
  if (exit.violation !== undefined) {
    return {
      code: 1,
      reason: `the application process broke the supervisor protocol (${exit.violation}); it was stopped`,
      unreported: true,
    };
  }
  if (exit.timedOutAfterMs !== undefined) {
    return {
      code: 1,
      reason:
        `the application process did not stop within ${exit.timedOutAfterMs} ms of the signal ` +
        '(its drain and the grace after it); it was killed',
      unreported: true,
    };
  }
  if (exit.signal !== null) {
    // Ended by the signal the supervisor forwarded, as the single process was: neither reports.
    if (exit.forwarded === exit.signal) return { code: 1, signal: exit.signal, unreported: false };
    return {
      code: 1,
      reason: `the application process ended (signal ${exit.signal})`,
      unreported: true,
    };
  }
  const code = exit.code ?? 1;
  if (code !== 0 && exit.served && exit.forwarded === undefined) {
    return { code, reason: `the application process exited with code ${code}`, unreported: false };
  }
  return { code, unreported: false };
}

/**
 * End the supervisor as `supervisorEnding` decided: print the reason, if any, then end by the
 * forwarded signal or with the exit code. `report` records the reason as the refusal, and is called
 * only when the application process could not write its own report.
 */
export function endSupervisor(
  exit: SupervisedExit,
  prefix: string,
  report: (reason: string) => void = () => {},
): void {
  const ending = supervisorEnding(exit);
  if (ending.reason !== undefined) {
    console.error(`${prefix} ${ending.reason}`);
    if (ending.unreported) report(ending.reason);
  }
  if (ending.signal !== undefined) {
    // As the single process did: the signal ends it, unhandled.
    process.removeAllListeners(ending.signal);
    process.kill(process.pid, ending.signal);
    return;
  }
  process.exit(ending.code);
}
