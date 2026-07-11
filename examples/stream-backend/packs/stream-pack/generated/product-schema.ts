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

import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { orgs } from '../schema.js';

/** Generated product store 'blob_chunks'. Tenant-scoped by construction (tenant_id -> orgs). */
export const blobChunks = pgTable('blob_chunks', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  uploadId: text('upload_id').notNull(),
  chunkIndex: integer('chunk_index').notNull(),
  chunkRef: text('chunk_ref').notNull().unique(),
  storageKey: text('storage_key').notNull(),
  byteLen: integer('byte_len').notNull(),
  contentType: text('content_type'),
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
export const PRODUCT_TENANT_SCOPED_TABLES = [blobChunks] as const;
