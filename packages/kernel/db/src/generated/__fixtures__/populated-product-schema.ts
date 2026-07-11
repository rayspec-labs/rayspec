// FIXTURE: a POPULATED generated product module, compiled by tsc -b so the
// populated-deployment compile path is actually typechecked (the platform baseline is product-empty).
// Mirrors examples/acme-notes-backend/generated/product-schema.ts with the import path adjusted for
// this fixtures dir. NOT used at runtime; its ONLY job is to make the populated A1 composition typecheck.

/**
 * GENERATED product schema — DO NOT EDIT BY HAND.
 *
 * Produced by @rayspec/db generate-product-schema from a validated RaySpec `stores[]`.
 * The tenancy/GDPR columns (id, tenant_id->orgs ON DELETE CASCADE,
 * created_at, deleted_at, retention_days, region) are INJECTED to match schema.ts exactly;
 * authors declare business columns only. PRODUCT_TENANT_SCOPED_TABLES is the type-enforced
 * seam schema.ts composes into TENANT_SCOPED_TABLES — a generated table is
 * reachable through the TenantDb chokepoint, an unregistered one throws (deny-by-default).
 */

import { boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { orgs } from '../../schema.js';

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
});

/**
 * The product tables this generated module contributes to TENANT_SCOPED_TABLES (a
 * type-enforced tuple extension, composed in schema.ts — NOT a runtime append). Empty on the
 * platform main line (product-empty baseline); populated in a deployment / the throwaway.
 */
export const PRODUCT_TENANT_SCOPED_TABLES = [notebooks, entries] as const;
