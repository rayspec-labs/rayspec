/**
 * API-key store — org-scoped key mint/list/revoke + the UNIFORM auth-resolution path.
 *
 * WHITELISTED global-table module: api_keys is keyed by org_id (orgs.id = tenant_id) but is an
 * auth-plane table reached via the injected raw Db. Plaintext is shown ONCE at mint; only the
 * public key_prefix (indexed) + the HMAC key_hash are stored.
 *
 * AUTH-PATH UNIFORMITY: a MISSING prefix, a REVOKED/EXPIRED key, and
 * a WRONG secret all perform the SAME dummy constant-time HMAC work and return the same generic
 * miss — no observable branch on prefix existence or revocation state.
 */
import { hashApiKey, verifyApiKey } from '@rayspec/auth-core';
import type { Db } from '@rayspec/db';
import { schema } from '@rayspec/db';
import { and, eq } from 'drizzle-orm';

export interface ApiKeyRow {
  id: string;
  orgId: string;
  type: string;
  keyPrefix: string;
  keyHash: string;
  scopes: string[];
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/** A resolved, ACTIVE api-key principal (the only success shape of resolve()). */
export interface ResolvedApiKey {
  id: string;
  orgId: string;
  type: string;
  scopes: string[];
}

// A fixed dummy api-key HASH to compare against on every miss so the work + timing are uniform
// (mirrors the dummy-argon2id-on-unknown-email pattern in auth-service.ts). It is computed ONCE
// lazily at module scope so the miss path does EXACTLY ONE HMAC (the verifyApiKey call below) —
// the same single-HMAC work as the found path. Computing the dummy hash inline per request would
// make a missing prefix do TWO HMACs (hash + verify) vs ONE on a known prefix — the timing
// asymmetry the uniform-constant-time claim forbids. verifyApiKey itself is constant-time.
const DUMMY_PRESENTED_SECRET = 'dummy-secret-that-never-matches-any-stored-key';
let DUMMY_KEY_HASH: string | undefined;
function dummyKeyHash(): string {
  if (DUMMY_KEY_HASH === undefined) DUMMY_KEY_HASH = hashApiKey(DUMMY_PRESENTED_SECRET);
  return DUMMY_KEY_HASH;
}

export class ApiKeyStore {
  constructor(private readonly db: Db) {}

  async mint(input: {
    orgId: string;
    type?: string;
    keyPrefix: string;
    keyHash: string;
    scopes: string[];
    createdBy?: string | null;
  }): Promise<ApiKeyRow> {
    const rows = await this.db
      .insert(schema.apiKeys)
      .values({
        orgId: input.orgId,
        type: input.type ?? 'api_key',
        keyPrefix: input.keyPrefix,
        keyHash: input.keyHash,
        scopes: input.scopes,
        createdBy: input.createdBy ?? null,
      })
      .returning();
    return rows[0] as ApiKeyRow;
  }

  /** List an org's keys (never the hash; never plaintext). */
  async listForOrg(orgId: string): Promise<ApiKeyRow[]> {
    const rows = await this.db.select().from(schema.apiKeys).where(eq(schema.apiKeys.orgId, orgId));
    return rows as ApiKeyRow[];
  }

  async findById(orgId: string, keyId: string): Promise<ApiKeyRow | undefined> {
    const rows = await this.db
      .select()
      .from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.orgId, orgId), eq(schema.apiKeys.id, keyId)))
      .limit(1);
    return rows[0] as ApiKeyRow | undefined;
  }

  /** Revoke a key (org-scoped). Returns whether a row was affected. */
  async revoke(orgId: string, keyId: string): Promise<boolean> {
    const rows = await this.db
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.apiKeys.orgId, orgId), eq(schema.apiKeys.id, keyId)))
      .returning();
    return rows.length > 0;
  }

  /**
   * Resolve a presented api-key plaintext (`<prefix>.<secret>`) to an ACTIVE key principal, with
   * UNIFORM work + timing on every failure mode. Returns undefined on ANY miss (missing prefix,
   * unknown prefix, revoked/expired, wrong secret) AFTER performing the same constant-time HMAC.
   */
  async resolve(presented: string): Promise<ResolvedApiKey | undefined> {
    const dot = presented.indexOf('.');
    const prefix = dot > 0 ? presented.slice(0, dot) : presented;
    const secret = dot > 0 ? presented.slice(dot + 1) : '';

    const rows = prefix
      ? await this.db
          .select()
          .from(schema.apiKeys)
          .where(eq(schema.apiKeys.keyPrefix, prefix))
          .limit(1)
      : [];
    const row = rows[0] as ApiKeyRow | undefined;

    // ALWAYS do EXACTLY ONE HMAC verify — against the real hash if found, else the precomputed
    // module-level dummy hash — so the work and timing do not branch on prefix existence. The
    // boolean result is combined with the revoked/expired check below; a miss ran the same single
    // verify (no extra inline hash).
    const storedHash = row?.keyHash ?? dummyKeyHash();
    const secretOk = verifyApiKey(storedHash, secret);

    if (!row) return undefined;
    const now = Date.now();
    const active = !row.revokedAt && (!row.expiresAt || row.expiresAt.getTime() > now);
    if (!active || !secretOk) return undefined;

    // Best-effort last-used stamp (not on the timing-sensitive miss path).
    await this.db
      .update(schema.apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.apiKeys.id, row.id));

    return { id: row.id, orgId: row.orgId, type: row.type, scopes: row.scopes };
  }
}
