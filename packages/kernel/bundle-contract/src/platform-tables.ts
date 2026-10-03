/**
 * Every platform table of the application database with its snapshot data category.
 *
 * The list restates `contract/snapshot-categories.json` `tables`, in its order;
 * `platform-tables.test.ts` holds the two equal. A snapshot excludes the rows of every table whose
 * category is always excluded, carries the ledgers' rows, and the product schema head never counts
 * a platform table.
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

/** Every platform table of the application database, in the order of the contract file. */
export const PLATFORM_TABLES: readonly PlatformTable[] = [
  t('api_keys', 'credential-state'),
  t('auth_audit', 'security-audit-log'),
  t('conversation_items', 'run-history'),
  t('idempotency_keys', 'request-replay-state'),
  t('invites', 'credential-state'),
  t('journal_steps', 'run-history'),
  t('memberships', 'identity-and-tenancy'),
  t('oidc_models', 'credential-state'),
  t('orgs', 'identity-and-tenancy'),
  t('owner_recovery_tokens', 'credential-state'),
  t('product_migration_ledger', 'platform-migration-ledger'),
  t('run_events', 'run-history'),
  t('runs', 'run-history'),
  t('runtime_control_processes', 'runtime-control-state'),
  t('runtime_control_receipts', 'runtime-control-state'),
  t('runtime_control_state', 'runtime-control-state'),
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
 * lease, binding revision key), the append-only operation receipts and the process heartbeats.
 */
export const RUNTIME_CONTROL_TABLES: readonly PlatformTable[] = PLATFORM_TABLES.filter(
  (p) => p.category === 'runtime-control-state',
);

/**
 * The product migration ledger: every product schema change the environment applied, in order. It
 * defines the product half of the schema head, as the drizzle ledger defines the platform half.
 */
export const PRODUCT_LEDGER_TABLES: readonly PlatformTable[] = PLATFORM_TABLES.filter(
  (p) => p.table === 'product_migration_ledger',
);

/**
 * The owner recovery tokens: one-time credentials the operator issues for an owner who holds no
 * password. Live credential state keyed by the pepper, so the identity policy resets them like the
 * sessions, API keys and invites, and a snapshot never carries their rows.
 */
export const IDENTITY_RECOVERY_TABLES: readonly PlatformTable[] = PLATFORM_TABLES.filter(
  (p) => p.table === 'owner_recovery_tokens',
);

/** The names of the platform tables in schema `public`: every other table there is a product table. */
export const PUBLIC_PLATFORM_TABLE_NAMES: ReadonlySet<string> = new Set(
  PLATFORM_TABLES.filter((p) => p.schema === 'public').map((p) => p.table),
);
