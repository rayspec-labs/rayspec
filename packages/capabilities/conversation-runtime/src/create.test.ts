/**
 * The create core — the idempotent client-keyed conversation create: closed `{ title? }` body (no
 * spoof channel), C10 re-create dedup (same ack, zero duplicate row), the optional-title-assertion
 * divergence 409 (loud, stored authoritative), the TS-1 display-field shape bound, tenant
 * isolation by construction (tenant-prefixed unique over ONE shared global-unique table), and the
 * concurrent-divergent-create TOCTOU (the authoritative re-read resolves LOUD).
 */
import { describe, expect, it } from 'vitest';
import { resolveConversationConfig } from './config.js';
import { createConversation } from './create.js';
import type { ConversationCoreContext } from './ports.js';
import { CONVERSATIONS_STORE } from './stores.js';
import { makeFakeConversationDb, SharedConversationTables } from './test-support/fake-db.js';

const TENANT_A = 'tenant-aaaa';
const TENANT_B = 'tenant-bbbb';

function ctx(tables: SharedConversationTables, tenantId = TENANT_A): ConversationCoreContext {
  return {
    tenantId,
    db: makeFakeConversationDb(tables, tenantId),
    config: resolveConversationConfig(),
  };
}

describe('createConversation — the idempotent create (C10)', () => {
  it('the FIRST create persists the head row: state open, owner NULL (the v1 seam), title stored', async () => {
    const tables = new SharedConversationTables();
    const res = await createConversation(ctx(tables), { conversation_id: 'c-1' }, { title: 'Q3' });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.value).toEqual({ conversation_id: 'c-1', state: 'open', deduped: false });
    expect(tables.conversations).toHaveLength(1);
    expect(tables.conversations[0]).toMatchObject({
      conversation_id: 'c-1',
      conversation_ref: `${TENANT_A}:c-1`,
      owner: null,
      title: 'Q3',
      state: 'open',
      tenant_id: TENANT_A,
    });
    expect(typeof tables.conversations[0]?.opened_at).toBe('string');
  });

  it('a bare re-create (no body) is the SAME ack — deduped, zero duplicate row, zero change', async () => {
    const tables = new SharedConversationTables();
    await createConversation(ctx(tables), { conversation_id: 'c-1' }, { title: 'Q3' });
    const res = await createConversation(ctx(tables), { conversation_id: 'c-1' }, undefined);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.value.deduped).toBe(true);
    expect(tables.conversations).toHaveLength(1);
    expect(tables.conversations[0]).toMatchObject({ title: 'Q3' });
  });

  it('a re-create with the IDENTICAL title assertion dedups too', async () => {
    const tables = new SharedConversationTables();
    await createConversation(ctx(tables), { conversation_id: 'c-1' }, { title: 'Q3' });
    const res = await createConversation(ctx(tables), { conversation_id: 'c-1' }, { title: 'Q3' });
    expect(res.ok && res.value.deduped).toBe(true);
  });

  it('a DIVERGENT title assertion is a LOUD 409 conversation_conflict — stored authoritative, zero change', async () => {
    const tables = new SharedConversationTables();
    await createConversation(ctx(tables), { conversation_id: 'c-1' }, { title: 'Q3' });
    const res = await createConversation(
      ctx(tables),
      { conversation_id: 'c-1' },
      { title: 'DIFFERENT' },
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(409);
    expect(res.error).toBe('conversation_conflict');
    expect(tables.conversations[0]).toMatchObject({ title: 'Q3' });
  });

  it('a title assertion against a TITLE-LESS conversation is also the loud 409 (null is a stored value)', async () => {
    const tables = new SharedConversationTables();
    await createConversation(ctx(tables), { conversation_id: 'c-1' }, undefined);
    const res = await createConversation(ctx(tables), { conversation_id: 'c-1' }, { title: 'X' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(409);
    expect(res.error).toBe('conversation_conflict');
  });

  it("DP-3: the dedup ack ECHOES the stored head's state — never fabricated (S1 writes only 'open'; this arm pins echo-not-fabricate through the seam)", async () => {
    const tables = new SharedConversationTables();
    // Seed a head row whose state differs from 'open' directly through the store seam (no S1
    // path writes it — the pin is that the ack reads the AUTHORITATIVE row, not a literal).
    tables.conversations.push({
      conversation_id: 'c-1',
      conversation_ref: `${TENANT_A}:c-1`,
      owner: null,
      title: null,
      state: 'closed',
      opened_at: '2026-07-05T00:00:00.000Z',
      tenant_id: TENANT_A,
    });
    const res = await createConversation(ctx(tables), { conversation_id: 'c-1' }, undefined);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.value.deduped).toBe(true);
    expect(String(res.value.state)).toBe('closed');
  });
});

describe('createConversation — the closed body shape (no spoof channel)', () => {
  it('accepts an absent body and an empty object body', async () => {
    for (const body of [undefined, {}]) {
      const tables = new SharedConversationTables();
      const res = await createConversation(ctx(tables), { conversation_id: 'c-1' }, body);
      expect(res.ok, JSON.stringify(body)).toBe(true);
    }
  });

  it('rejects a non-object body (422 invalid_conversation_body)', async () => {
    for (const body of [null, 42, 'text', ['a']]) {
      const tables = new SharedConversationTables();
      const res = await createConversation(ctx(tables), { conversation_id: 'c-1' }, body);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(422);
      expect(res.error).toBe('invalid_conversation_body');
    }
  });

  it('rejects ANY unknown key (owner/state/timestamps are server-derived — nothing else to set)', async () => {
    for (const body of [
      { owner: 'spoof' },
      { state: 'closed' },
      { conversation_ref: 'spoof' },
      { tenant_id: 'spoof' },
      { anything: 1 },
    ]) {
      const tables = new SharedConversationTables();
      const res = await createConversation(ctx(tables), { conversation_id: 'c-1' }, body);
      expect(res.ok, JSON.stringify(body)).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(422);
      expect(res.error).toBe('invalid_conversation_body');
    }
  });

  it('bounds the title as a DISPLAY field (TS-1): control/bidi/zero-width chars and oversize/empty/non-string are 422', async () => {
    for (const bad of [
      'a\nb', // C0 control
      'a\u0007b', // C0 control (BEL)
      'a\u0085b', // C1 control
      'a\u202Eb', // RLO override — the extension-spoof class
      'a\u2066b', // bidi isolate
      'a\u200Bb', // zero-width space
      '\uFEFFa', // BOM/zero-width no-break
      'x'.repeat(256),
      '',
      42,
      null,
    ]) {
      const tables = new SharedConversationTables();
      const res = await createConversation(ctx(tables), { conversation_id: 'c-1' }, { title: bad });
      expect(res.ok, JSON.stringify(bad)).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(422);
      expect(res.error).toBe('conversation_title_invalid');
    }
  });

  it('BOUNDS-2: the STANDALONE bidi marks U+200E (LRM), U+200F (RLM), U+061C (ALM) are rejected in the title (the TS-1 set was embeddings/isolates-only)', async () => {
    for (const bad of ['a\u200Eb', 'a\u200Fb', 'a\u061Cb']) {
      const tables = new SharedConversationTables();
      const res = await createConversation(ctx(tables), { conversation_id: 'c-1' }, { title: bad });
      expect(res.ok, JSON.stringify(bad)).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(422);
      expect(res.error).toBe('conversation_title_invalid');
    }
  });

  it('accepts legitimate unicode in the title (umlauts/CJK/emoji/Arabic — a shape bound, not an ASCII allowlist; rejecting ALM must not reject Arabic LETTERS)', async () => {
    for (const good of ['Kündigung 会議 🎯', 'مرحبا بالعالم']) {
      const tables = new SharedConversationTables();
      const res = await createConversation(
        ctx(tables),
        { conversation_id: 'c-1' },
        { title: good },
      );
      expect(res.ok, JSON.stringify(good)).toBe(true);
    }
  });
});

describe('createConversation — conversation-id validation (the HS-2 belt, point of use)', () => {
  it('rejects invalid shapes (422 conversation_id_invalid)', async () => {
    for (const bad of ['', 'has space', 'a:b', 'ä-umlaut', 'x'.repeat(129)]) {
      const res = await createConversation(
        ctx(new SharedConversationTables()),
        { conversation_id: bad },
        undefined,
      );
      expect(res.ok, `conversation_id '${bad}'`).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.status).toBe(422);
      expect(res.error).toBe('conversation_id_invalid');
    }
  });

  it("the ':' belt holds even for a hand-built (resolver-bypassing) config", async () => {
    const config = {
      conversationIdPattern: /^[a-z:-]{1,64}$/,
      messageIdPattern: /^[a-z-]{1,64}$/,
      maxMessageBytes: 1024,
      maxTurnBodyBytes: 5120,
      maxHistoryTurns: 4,
      maxHistoryChars: 4096,
    };
    const tables = new SharedConversationTables();
    const res = await createConversation(
      { tenantId: TENANT_A, db: makeFakeConversationDb(tables, TENANT_A), config },
      { conversation_id: 'a:b' },
      undefined,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(422);
    expect(res.error).toBe('conversation_id_invalid');
  });
});

describe('createConversation — tenant isolation by construction', () => {
  it('two tenants create the SAME conversation_id over ONE shared table — two rows, no collision, no cross-dedup (the tenant-prefixed ref isolates)', async () => {
    const tables = new SharedConversationTables();
    const a = await createConversation(
      ctx(tables, TENANT_A),
      { conversation_id: 'c-1' },
      undefined,
    );
    const b = await createConversation(
      ctx(tables, TENANT_B),
      { conversation_id: 'c-1' },
      undefined,
    );
    expect(a.ok && !a.value.deduped).toBe(true);
    // Tenant B's create is a FIRST create (A's row is invisible + non-colliding), never a dedup.
    expect(b.ok && !b.value.deduped).toBe(true);
    expect(tables.conversations).toHaveLength(2);
    expect(new Set(tables.conversations.map((r) => r.conversation_ref)).size).toBe(2);
  });
});

describe('createConversation — the concurrent-divergent-create TOCTOU (the authoritative re-read)', () => {
  it('a DIVERGENT create racing between our upsert and our re-read resolves LOUD: the overwritten request gets the 409, never a silent title swallow', async () => {
    const tables = new SharedConversationTables();
    // Interpose on the SECOND select (the authoritative re-read): the racer creates the same id
    // with a DIFFERENT title after our upsert landed (the fakes are single-threaded, so the race
    // interleaving is staged deterministically — the SM-1 interposer pattern).
    const inner = makeFakeConversationDb(tables, TENANT_A);
    let selects = 0;
    let raced = false;
    const db: typeof inner = {
      ...inner,
      async select(store, filter, opts) {
        selects += 1;
        if (selects === 2 && !raced) {
          raced = true;
          // Model the RACER's first-create upsert landing AFTER ours (a racer that read "no row"
          // BEFORE our upsert — un-stageable directly under single-threaded fakes) through the
          // REAL fake upsert semantics: the DO-UPDATE overwrite is exactly the record-donor
          // race-window caveat create.ts documents.
          await makeFakeConversationDb(tables, TENANT_A).upsert(
            CONVERSATIONS_STORE,
            ['conversation_ref'],
            {
              conversation_id: 'c-1',
              conversation_ref: `${TENANT_A}:c-1`,
              owner: null,
              title: 'RACER WINS',
              state: 'open',
              opened_at: '2026-07-05T00:00:00.000Z',
            },
          );
        }
        return inner.select(store, filter, opts);
      },
    };
    const res = await createConversation(
      { tenantId: TENANT_A, db, config: resolveConversationConfig() },
      { conversation_id: 'c-1' },
      { title: 'ours' },
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.status).toBe(409);
    expect(res.error).toBe('conversation_conflict');
    // The stored row is authoritative (the racer's write stands; ours was not silently reasserted).
    expect(tables.conversations[0]).toMatchObject({ title: 'RACER WINS' });
  });

  it('C10-1: a BARE create racing a TITLED first-create CONVERGES to the dedup outcome — never a spurious 409 (absent title = NO assertion, the found-path mirror)', async () => {
    const tables = new SharedConversationTables();
    // The same staged interleaving as the divergent arm above — but OUR request is BARE. The
    // module contract ("absent = no assertion; a bare retry is always safe", and the found-path's
    // own `title !== undefined` guard) says a bare create can never lose a title race: it
    // asserted nothing, so the racer's titled head simply stands and we converge (dedup).
    const inner = makeFakeConversationDb(tables, TENANT_A);
    let selects = 0;
    let raced = false;
    const db: typeof inner = {
      ...inner,
      async select(store, filter, opts) {
        selects += 1;
        if (selects === 2 && !raced) {
          raced = true;
          await makeFakeConversationDb(tables, TENANT_A).upsert(
            CONVERSATIONS_STORE,
            ['conversation_ref'],
            {
              conversation_id: 'c-1',
              conversation_ref: `${TENANT_A}:c-1`,
              owner: null,
              title: 'RACER TITLE',
              state: 'open',
              opened_at: '2026-07-05T00:00:00.000Z',
            },
          );
        }
        return inner.select(store, filter, opts);
      },
    };
    const res = await createConversation(
      { tenantId: TENANT_A, db, config: resolveConversationConfig() },
      { conversation_id: 'c-1' },
      undefined, // BARE create — no title assertion
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.value.deduped).toBe(true); // converged to the dedup outcome
    // The racer's titled head is authoritative and untouched.
    expect(tables.conversations).toHaveLength(1);
    expect(tables.conversations[0]).toMatchObject({ title: 'RACER TITLE' });
  });

  it('the vanished-row arm fails CLOSED (a re-read that finds nothing is a fault, never a silent ok)', async () => {
    const tables = new SharedConversationTables();
    const inner = makeFakeConversationDb(tables, TENANT_A);
    let selects = 0;
    const db: typeof inner = {
      ...inner,
      async select(store, filter, opts) {
        selects += 1;
        if (selects === 2) {
          // Model a hard mid-request deletion (retention sweep etc.) — the row vanishes.
          tables.conversations.length = 0;
        }
        return inner.select(store, filter, opts);
      },
    };
    await expect(
      createConversation(
        { tenantId: TENANT_A, db, config: resolveConversationConfig() },
        { conversation_id: 'c-1' },
        undefined,
      ),
    ).rejects.toThrow(/vanished/);
  });
});

describe('createConversation — store shape', () => {
  it('writes ONLY the declared business columns (subset/superset semantics — MINOR-2 fake-vs-real honesty)', async () => {
    const tables = new SharedConversationTables();
    await createConversation(ctx(tables), { conversation_id: 'c-1' }, { title: 'T' });
    const row = tables.conversations[0];
    if (!row) throw new Error('row missing');
    // NOT exact-equality (MINOR-2): the REAL DB returns the declared business columns PLUS the
    // generator-INJECTED columns (id/tenant_id/created_at/deleted_at/retention_days/region —
    // stores.ts header), so `keys === business+tenant_id` holds only under the fake. The
    // fake-and-real-true invariant is two-sided: every business column was written (subset), and
    // nothing OUTSIDE business ∪ injected appears (superset) — the facade fail-closes an
    // undeclared write column either way.
    const businessCols = [
      'conversation_id',
      'conversation_ref',
      'owner',
      'title',
      'state',
      'opened_at',
    ];
    const injectedCols = [
      'id',
      'tenant_id',
      'created_at',
      'deleted_at',
      'retention_days',
      'region',
    ];
    const keys = Object.keys(row);
    expect(keys).toEqual(expect.arrayContaining(businessCols));
    for (const key of keys) {
      expect([...businessCols, ...injectedCols], `unexpected column '${key}'`).toContain(key);
    }
  });

  it(`persists under the ${CONVERSATIONS_STORE} store only`, async () => {
    const tables = new SharedConversationTables();
    await createConversation(ctx(tables), { conversation_id: 'c-1' }, undefined);
    expect(tables.conversations).toHaveLength(1);
    expect(tables.turns).toHaveLength(0);
  });
});
