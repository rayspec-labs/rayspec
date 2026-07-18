/**
 * GENERATED product schema — DO NOT EDIT BY HAND.
 *
 * Produced by @rayspec/db generate-product-schema from a validated RaySpec `stores[]`.
 * The tenancy/GDPR columns (id, tenant_id->orgs ON DELETE CASCADE, created_at, deleted_at,
 * retention_days, region, created_by, idempotency_key) are INJECTED to match schema.ts exactly;
 * authors declare business columns only. PRODUCT_TENANT_SCOPED_TABLES is the type-enforced
 * COMPILE-TIME seam schema.ts composes into the `TENANT_SCOPED_TABLES` tuple (the type-level
 * TenantScopedTable union). RUNTIME reachability through the TenantDb chokepoint is a separate
 * BOOT-TIME step: a product table is admitted to the deny-by-default chokepoint Set at boot via the
 * sanctioned `registerProductTables` hook (`@rayspec/db/composition`'s `registerProductStores`); an
 * unregistered table throws (deny-by-default).
 */

import { boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { orgs } from '../schema.js';

/** Generated product store 'notebooks'. Tenant-scoped by construction (tenant_id -> orgs). */
export const notebooks = pgTable('notebooks', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
  subtitle: text('subtitle'),
  completed: boolean('completed').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  retentionDays: integer('retention_days'),
  region: text('region').notNull().default('eu'),
  createdBy: text('created_by'),
  idempotencyKey: text('idempotency_key'),
});

/** Generated product store 'entries'. Tenant-scoped by construction (tenant_id -> orgs). */
export const entries = pgTable('entries', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  notebookId: uuid('notebook_id')
    .notNull()
    .references(() => notebooks.id, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  language: text('language'),
  summary: text('summary'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  retentionDays: integer('retention_days'),
  region: text('region').notNull().default('eu'),
  createdBy: text('created_by'),
  idempotencyKey: text('idempotency_key'),
});

/**
 * The product tables this generated module contributes to TENANT_SCOPED_TABLES (a
 * type-enforced tuple extension, composed in schema.ts — NOT a runtime append). Empty on the
 * platform main line (product-empty baseline); populated in a deployment / the throwaway.
 */
export const PRODUCT_TENANT_SCOPED_TABLES = [notebooks, entries] as const;
