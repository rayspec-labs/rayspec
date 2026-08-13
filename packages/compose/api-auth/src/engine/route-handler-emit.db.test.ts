/**
 * The `init.emit` tenant-event-bus seam, DB-backed, end-to-end through the REAL createAuthApp +
 * declared-route interpreter, asserted on GROUND TRUTH (the rows in `tenant_events`), not on a
 * capability stand-in: this seam's whole value is that the event is DURABLE, ORDERED and
 * TENANT-SCOPED, and only the database can answer that.
 *
 *  (1) DURABLE + ORDERED + TENANT-SCOPED — a `{handler}` route that calls `init.emit(topic, payload)`
 *      leaves rows carrying the request's SERVER-DERIVED tenant, the topics/payloads verbatim, and
 *      consecutive `seq` values in call order.
 *  (2) ATOMIC WITH THE HANDLER'S OWN WRITES + GAP-FREE — a handler that emits and then THROWS leaves
 *      NEITHER its store row NOR its event (the flush rides the engine's route transaction), and the
 *      seq it took is REISSUED to the next emit: a hole in the visible sequence is only ever retention.
 *  (3) ACCEPT CONTROL — with the bus NOT enabled the field is ABSENT: `'emit' in init === false`
 *      (the `in` idiom — never an `undefined`-valued key), so a handler that needs it fail-closes.
 *  (4) CROSS-TENANT — two tenants emitting through the SAME app write only into their OWN stream, and
 *      each stream counts from 1: the tenant is engine-bound (`init.tenantId`), never handler-supplied
 *      (the capability HAS no tenant parameter to supply one through).
 *  (5) MALFORMED CALL — the natural mis-reading (`emit({ topic, payload })`, the shape `init.enqueue`
 *      takes) fail-closes 500 INTERNAL naming the capability and the expected positional shape, never
 *      a 404 and never a silent no-op; nothing is written.
 *  (6) MALFORMED CALL, THE SILENT CLASS — a payload whose JSON form is `undefined` (a function) is
 *      refused BY NAME at the call site. It is the one `JSON.stringify` does not throw on, so an
 *      accepting guard would carry it into the ENGINE's flush, where the `NOT NULL` payload column
 *      rejects the row and the caller gets an ANONYMOUS 500 with the handler's own write rolled back.
 *
 * Skips when DATABASE_URL is absent; HARD-FAILS when the DB is required (CI / RAYSPEC_REQUIRE_DB_TESTS)
 * but absent — this suite proves a durability contract and must never self-skip to a false green.
 */
import type { ResolvedHandler } from '@rayspec/platform';
import { parseSpec, type RaySpec } from '@rayspec/spec';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';
import { makeTenantEventBus } from './event-bus.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
if (requireDb && !hasDb) {
  throw new Error(
    'route-handler-emit.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but ' +
      'absent — refusing to silently skip an event-durability suite.',
  );
}

/**
 * A throwaway spec: a `notes` store plus three `{handler}` routes — one that emits, one that emits and
 * then throws (the atomicity probe), and one that REPORTS whether the capability is present (the
 * accept control reads the `in` idiom from inside the handler, where the init actually is).
 */
const SPEC_YAML = `
version: '1.0'
metadata:
  name: emit-seam-backend
  description: A throwaway backend whose {handler} routes call init.emit.
stores:
  - name: notes
    columns:
      - name: title
        type: text
handlers:
  - id: emit_handler
    module: handlers/emit.ts
    export: emit
    kind: route
  - id: emit_probe_handler
    module: handlers/probe.ts
    export: probe
    kind: route
  - id: mis_emit_handler
    module: handlers/mis-emit.ts
    export: misEmit
    kind: route
api:
  - method: POST
    path: /emit
    action:
      kind: handler
      handler: emit_handler
  - method: POST
    path: /probe
    action:
      kind: handler
      handler: emit_probe_handler
  - method: POST
    path: /mis-emit
    action:
      kind: handler
      handler: mis_emit_handler
`;

function buildSpec(): RaySpec {
  const parsed = parseSpec(SPEC_YAML);
  if (!parsed.ok) throw new Error(`spec invalid: ${JSON.stringify(parsed.errors)}`);
  return parsed.value;
}

/** The init shape the handlers below read (a pack ships as `.mjs`, so this is the authored contract). */
interface EmitInit {
  body?: unknown;
  tenantId: string;
  emit?: (topic: string, payload: unknown) => Promise<void>;
  db: { insert(store: string, values: Record<string, unknown>): Promise<unknown> };
}

/**
 * The emitting route handler — the pack-side consumer. It writes a note (so atomicity has something to
 * be atomic WITH), emits one event per requested topic, and optionally throws afterwards. Fail-closes
 * loudly when the capability is absent — never a silent no-op.
 */
const emitHandler: ResolvedHandler = {
  kind: 'route',
  fn: async (init): Promise<unknown> => {
    const i = init as unknown as EmitInit;
    if (!i.emit) {
      throw new Error(
        'emit: init.emit is not available (the event bus is not enabled). Fail-closed.',
      );
    }
    const body = (i.body ?? {}) as {
      topics?: string[];
      note?: string;
      then_throw?: boolean;
    };
    if (body.note) await i.db.insert('notes', { title: body.note });
    for (const topic of body.topics ?? []) {
      await i.emit(topic, { topic, tenantSeen: i.tenantId });
    }
    if (body.then_throw) throw new Error('emit: deliberate post-emit failure (atomicity probe).');
    return { emitted: (body.topics ?? []).length };
  },
};

/**
 * The ACCEPT-CONTROL probe: it reports the capability's PRESENCE using the `in` idiom, so an
 * `undefined`-valued key would read as PRESENT here and fail the control — the absence contract is
 * "the field is not there", not "the field is undefined".
 */
const probeHandler: ResolvedHandler = {
  kind: 'route',
  fn: async (init): Promise<unknown> => ({
    present: 'emit' in (init as object),
    type: typeof (init as unknown as EmitInit).emit,
  }),
};

/**
 * The MIS-CALLING handler — two mis-calls a pack author actually makes, selected by the request body.
 * A pack ships as an `.mjs` module, so the published positional type never reaches this call site; the
 * casts reproduce that caller exactly.
 *
 *  - `object_topic` (default): `emit({ topic, payload })`, the shape the sibling `init.enqueue` takes.
 *  - `no_json_payload`: a payload whose JSON form is `undefined` (a function). It writes a note FIRST,
 *    so the arm can show what the unguarded version costs — `JSON.stringify` does NOT throw for this
 *    one, so an accepting guard would carry it to the flush, where `payload jsonb NOT NULL` rejects
 *    the row and takes the handler's own note down with it under an anonymous 500.
 */
const misEmitHandler: ResolvedHandler = {
  kind: 'route',
  fn: async (init): Promise<unknown> => {
    const i = init as unknown as EmitInit;
    if (!i.emit) {
      throw new Error('mis-emit: init.emit is not available (the event bus is not enabled).');
    }
    const kind = ((i.body ?? {}) as { kind?: string }).kind ?? 'object_topic';
    const misCall = i.emit as unknown as (...args: unknown[]) => Promise<void>;
    if (kind === 'no_json_payload') {
      await i.db.insert('notes', { title: 'written before the bad emit' });
      await misCall('note.created', () => 'not serializable');
      return { emitted: 1 };
    }
    await misCall({ topic: 'note.created', payload: { id: 1 } });
    return { emitted: 1 };
  },
};

const HANDLERS = new Map<string, ResolvedHandler>([
  ['emit_handler', emitHandler],
  ['emit_probe_handler', probeHandler],
  ['mis_emit_handler', misEmitHandler],
]);

describe.skipIf(!hasDb)('route-handler init.emit tenant-event-bus seam', () => {
  let h: Harness;
  const SCHEMA = 'rayspec_test_route_handler_emit';

  beforeAll(async () => {
    h = await createHarness({
      engineSpec: buildSpec(),
      engineHandlers: HANDLERS,
      eventBus: makeTenantEventBus(),
      schema: SCHEMA,
    });
  });
  beforeEach(async () => {
    await h.reset();
  });
  afterAll(async () => {
    await h.close();
  });

  /** Register → org → switch → JWT (member role: store:read/write). */
  async function principal(
    email: string,
    orgName: string,
  ): Promise<{ orgId: string; token: string }> {
    const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
      body: { email, password: 'a-long-enough-password' },
    });
    const t0 = (await reg.json()).accessToken as string;
    const orgId = (
      await (
        await jsonRequest(h.app, 'POST', '/v1/orgs', {
          body: { name: orgName },
          headers: { authorization: `Bearer ${t0}` },
        })
      ).json()
    ).id as string;
    const token = (
      await (
        await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
          headers: { authorization: `Bearer ${t0}` },
        })
      ).json()
    ).accessToken as string;
    return { orgId, token };
  }

  /** Read a tenant's event rows in seq order, straight from the table (ground truth). */
  async function eventsOf(
    tenantId: string,
  ): Promise<{ seq: number; topic: string; payload: unknown }[]> {
    const rows = (await h.db.$client.unsafe(
      'SELECT seq, topic, payload FROM tenant_events WHERE tenant_id = $1 ORDER BY seq',
      [tenantId],
    )) as unknown as { seq: string | number; topic: string; payload: unknown }[];
    return rows.map((r) => ({ seq: Number(r.seq), topic: r.topic, payload: r.payload }));
  }

  it('(1) DURABLE + ORDERED + TENANT-SCOPED: the emitted events are rows under the request tenant, in call order', async () => {
    const { orgId, token } = await principal('emit@example.com', 'EmitOrg');
    const res = await jsonRequest(h.app, 'POST', '/emit', {
      body: { topics: ['note.created', 'note.updated', 'note.archived'] },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ emitted: 3 });

    const rows = await eventsOf(orgId);
    expect(rows.map((r) => r.topic)).toEqual(['note.created', 'note.updated', 'note.archived']);
    // CONSECUTIVE from 1 in CALL order — the per-tenant counter allocates, so the stream a subscriber
    // resumes with `seq > cursor` has no hole and no reordering.
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    // The payload crosses verbatim (jsonb), and the tenant the handler SAW is the engine-bound one.
    expect(rows[0]?.payload).toEqual({ topic: 'note.created', tenantSeen: orgId });
  });

  it('(2) ATOMIC + GAP-FREE: a handler that throws after emitting leaves no row, and its seq is reissued', async () => {
    const { orgId, token } = await principal('atomic@example.com', 'AtomicOrg');
    const failed = await jsonRequest(h.app, 'POST', '/emit', {
      body: { topics: ['note.created'], note: 'rolled back', then_throw: true },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(failed.status).toBe(500);
    // NOTHING committed: not the handler's own write, not the event. A subscriber can therefore never
    // observe an event announcing a state change that is not readable.
    expect(await eventsOf(orgId)).toEqual([]);
    const notes = (await h.db.$client.unsafe(
      'SELECT count(*)::int AS n FROM notes WHERE tenant_id = $1',
      [orgId],
    )) as unknown as { n: number }[];
    expect(notes[0]?.n).toBe(0);

    // The rolled-back allocation is REISSUED — the first surviving event is seq 1, not seq 2.
    const ok = await jsonRequest(h.app, 'POST', '/emit', {
      body: { topics: ['note.created'] },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
    expect((await eventsOf(orgId)).map((r) => r.seq)).toEqual([1]);
  });

  it('(3) ACCEPT CONTROL: with the bus enabled the field is PRESENT (the `in` idiom sees it)', async () => {
    const { token } = await principal('probe@example.com', 'ProbeOrg');
    const res = await jsonRequest(h.app, 'POST', '/probe', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ present: true, type: 'function' });
  });

  it('(3b) ACCEPT CONTROL: with the bus NOT enabled the field is ABSENT — `emit` in init === false', async () => {
    // A SECOND harness whose engine enables NO bus (the deployment shape of a spec without
    // `deployment.eventBus`). Everything else is identical, so the ONLY difference is the enablement.
    const h2 = await createHarness({
      engineSpec: buildSpec(),
      engineHandlers: HANDLERS,
      schema: 'rayspec_test_route_handler_emit_off',
    });
    try {
      const reg = await jsonRequest(h2.app, 'POST', '/v1/auth/register', {
        body: { email: 'bus-off@example.com', password: 'a-long-enough-password' },
      });
      const t0 = (await reg.json()).accessToken as string;
      const orgId = (
        await (
          await jsonRequest(h2.app, 'POST', '/v1/orgs', {
            body: { name: 'BusOffOrg' },
            headers: { authorization: `Bearer ${t0}` },
          })
        ).json()
      ).id as string;
      const token = (
        await (
          await jsonRequest(h2.app, 'POST', `/v1/orgs/${orgId}/switch`, {
            headers: { authorization: `Bearer ${t0}` },
          })
        ).json()
      ).accessToken as string;

      const probe = await jsonRequest(h2.app, 'POST', '/probe', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(probe.status).toBe(200);
      // ABSENT, not undefined-valued: the `in` check is false.
      expect(await probe.json()).toEqual({ present: false, type: 'undefined' });

      // A handler that NEEDS it fail-closes loudly (500), never a silent no-op.
      const res = await jsonRequest(h2.app, 'POST', '/emit', {
        body: { topics: ['note.created'] },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(500);
    } finally {
      await h2.close();
    }
  });

  it('(4) CROSS-TENANT: each tenant writes only into its own stream, and each stream counts from 1', async () => {
    const a = await principal('emitA@example.com', 'EmitTenantA');
    const b = await principal('emitB@example.com', 'EmitTenantB');
    expect(a.orgId).not.toBe(b.orgId);

    await jsonRequest(h.app, 'POST', '/emit', {
      body: { topics: ['a.one', 'a.two'] },
      headers: { authorization: `Bearer ${a.token}` },
    });
    await jsonRequest(h.app, 'POST', '/emit', {
      body: { topics: ['b.one'] },
      headers: { authorization: `Bearer ${b.token}` },
    });

    const rowsA = await eventsOf(a.orgId);
    const rowsB = await eventsOf(b.orgId);
    expect(rowsA.map((r) => r.topic)).toEqual(['a.one', 'a.two']);
    expect(rowsB.map((r) => r.topic)).toEqual(['b.one']);
    // Per-tenant sequences are INDEPENDENT (both start at 1) — one tenant's traffic can neither
    // advance nor leak into another's cursor space.
    expect(rowsA.map((r) => r.seq)).toEqual([1, 2]);
    expect(rowsB.map((r) => r.seq)).toEqual([1]);
    // The tenant on every row is the ENGINE-BOUND one the handler saw — the capability takes no
    // tenant argument, so a handler has no path to name another tenant.
    expect(rowsA[0]?.payload).toEqual({ topic: 'a.one', tenantSeen: a.orgId });
    expect(rowsB[0]?.payload).toEqual({ topic: 'b.one', tenantSeen: b.orgId });
  });

  it('(5) MALFORMED CALL: emit({ topic, payload }) fail-closes 500 naming the positional shape; nothing written', async () => {
    const { orgId, token } = await principal('mis@example.com', 'MisOrg');
    const res = await jsonRequest(h.app, 'POST', '/mis-emit', {
      headers: { authorization: `Bearer ${token}` },
    });
    // Fail-the-fix: without the shape guard the object lands where the topic string is expected and
    // the row's `topic` becomes "[object Object]" — a silently corrupt stream instead of a refusal.
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.message).toContain('init.emit');
    expect(body.error.message).toContain('emit(topic, payload)');
    expect(body.error.message).not.toBe('Internal server error.');
    expect(await eventsOf(orgId)).toEqual([]);
  });

  it('(6) MALFORMED CALL, THE SILENT CLASS: a payload with no JSON form is refused BY NAME at the call, not by the flush', async () => {
    const { orgId, token } = await principal('nojson@example.com', 'NoJsonOrg');
    const res = await jsonRequest(h.app, 'POST', '/mis-emit', {
      body: { kind: 'no_json_payload' },
      headers: { authorization: `Bearer ${token}` },
    });
    // Fail-the-fix: `JSON.stringify(() => {})` returns `undefined` WITHOUT throwing, so a guard that
    // only catches a throw ACCEPTS this. The batch then omits the payload key, `payload jsonb NOT
    // NULL` rejects the row inside the ENGINE's flush — after the handler returned successfully — and
    // the caller gets the anonymous 500 asserted against below, with the handler's own note rolled
    // back beside it. The refusal must carry the capability's name and the fault.
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.message).not.toBe('Internal server error.');
    expect(body.error.message).toContain('init.emit');
    expect(body.error.message).toContain('no JSON form');
    expect(await eventsOf(orgId)).toEqual([]);
    const notes = (await h.db.$client.unsafe(
      'SELECT count(*)::int AS n FROM notes WHERE tenant_id = $1',
      [orgId],
    )) as unknown as { n: number }[];
    expect(notes[0]?.n).toBe(0);
  });
});
