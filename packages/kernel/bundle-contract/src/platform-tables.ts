/**
 * Every platform table of the application database with its snapshot data category.
 *
 * The first part restates `contract/snapshot-categories.json` `tables`; `platform-tables.test.ts`
 * holds the two equal. The runtime-control tables and the product migration ledger follow: the
 * contract names their categories (`runtime-control-state`, `platform-migration-ledger`) and leaves
 * the table names to the change that adds them, which is this list, so a snapshot excludes the
 * runtime-control rows, carries the ledger's, and the product schema head never counts either.
 */
import type { DataCategory } from './vocabulary.js';

export interface PlatformTable {
  database: 'application';
  schema: 'public' | 'drizzle';
  table: string;
  category: DataCategory;
}

const t = (
  table: string,
  category: DataCategory,
  schema: PlatformTable['schema'] = 'public',
): PlatformTable => ({ database: 'application', schema, table, category });

/** The platform tables of `contract/snapshot-categories.json`, in its order. */
export const CONTRACT_PLATFORM_TABLES: readonly PlatformTable[] = [
  t('api_keys', 'credential-state'),
  t('auth_audit', 'security-audit-log'),
  t('conversation_items', 'run-history'),
  t('idempotency_keys', 'request-replay-state'),
  t('invites', 'credential-state'),
  t('journal_steps', 'run-history'),
  t('memberships', 'identity-and-tenancy'),
  t('oidc_models', 'credential-state'),
  t('orgs', 'identity-and-tenancy'),
  t('run_events', 'run-history'),
  t('runs', 'run-history'),
  t('sessions', 'credential-state'),
  t('tenant_event_streams', 'application-event-log'),
  t('tenant_events', 'application-event-log'),
  t('users', 'identity-and-tenancy'),
  t('workflow_artifacts', 'run-history'),
  t('workflow_node_states', 'run-history'),
  t('workflow_runs', 'run-history'),
  t('__drizzle_migrations', 'platform-migration-ledger', 'drizzle'),
];

/**
 * The runtime-control tables: the environment's state row (fence, environment revision, operation
 * lease, binding revision key) and the append-only operation receipts.
 */
export const RUNTIME_CONTROL_TABLES: readonly PlatformTable[] = [
  t('runtime_control_state', 'runtime-control-state'),
  t('runtime_control_receipts', 'runtime-control-state'),
  t('runtime_control_processes', 'runtime-control-state'),
];

/**
 * The product migration ledger: every product schema change the environment applied, in order. It
 * defines the product half of the schema head, as the drizzle ledger defines the platform half.
 */
export const PRODUCT_LEDGER_TABLES: readonly PlatformTable[] = [
  t('product_migration_ledger', 'platform-migration-ledger'),
];

/**
 * The owner recovery tokens: one-time credentials the operator issues for an owner who holds no
 * password. Live credential state keyed by the pepper, so the identity policy resets them like the
 * sessions, API keys and invites, and a snapshot never carries their rows.
 */
export const IDENTITY_RECOVERY_TABLES: readonly PlatformTable[] = [
  t('owner_recovery_tokens', 'credential-state'),
];

/** Every platform table of the application database. */
export const PLATFORM_TABLES: readonly PlatformTable[] = [
  ...CONTRACT_PLATFORM_TABLES,
  ...RUNTIME_CONTROL_TABLES,
  ...PRODUCT_LEDGER_TABLES,
  ...IDENTITY_RECOVERY_TABLES,
];

/** The names of the platform tables in schema `public`: every other table there is a product table. */
export const PUBLIC_PLATFORM_TABLE_NAMES: ReadonlySet<string> = new Set(
  PLATFORM_TABLES.filter((p) => p.schema === 'public').map((p) => p.table),
);
