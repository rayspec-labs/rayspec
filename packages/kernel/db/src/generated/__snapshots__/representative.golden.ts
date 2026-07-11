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

import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { orgs } from '../schema.js';

/** Generated product store 'projects'. Tenant-scoped by construction (tenant_id -> orgs). */
export const projects = pgTable('projects', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  slug: text('slug').notNull().unique(),
  priority: integer('priority').notNull(),
  active: boolean('active').notNull(),
  metadata: jsonb('metadata'),
  dueAt: timestamp('due_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  retentionDays: integer('retention_days'),
  region: text('region').notNull().default('eu'),
});

/** Generated product store 'tasks'. Tenant-scoped by construction (tenant_id -> orgs). */
export const tasks = pgTable('tasks', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  assigneeId: uuid('assignee_id').references(() => projects.id, { onDelete: 'set null' }),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  retentionDays: integer('retention_days'),
  region: text('region').notNull().default('eu'),
});

/** Generated product store 'audit_rows'. Tenant-scoped by construction (tenant_id -> orgs). */
export const auditRows = pgTable('audit_rows', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  taskId: uuid('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'restrict' }),
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
export const PRODUCT_TENANT_SCOPED_TABLES = [projects, tasks, auditRows] as const;
