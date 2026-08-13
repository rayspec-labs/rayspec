/**
 * EVENT-BUS capability boot test — the composition-root wiring for the BACKEND-profile `init.emit`:
 * the deployed document's `deployment.eventBus` key is what turns the capability on, and the same key
 * is what gives the daily housekeeping pass a retention window to sweep.
 *
 * This drives the REAL composition root (`assembleServer` → `deployDeclaredSpec`) against a throwaway
 * DATABASE, so every arm goes green only because `deployment.eventBus` → `engine.eventBus` →
 * `init.emit` is wired end-to-end through the real boot — not because a harness handed the bus in
 * (that seam is `route-handler-emit.db.test.ts`, which proves the capability's own contract but
 * bypasses the key entirely).
 *
 *   (a) ACCEPT CONTROL: a document that does NOT declare the bus boots, and the handler observes
 *       `'emit' in init === false` — ABSENT, not `undefined`-valued. Nothing warns about a sweep.
 *   (b) THE KEY IS LOAD-BEARING: the SAME handler and the SAME boot with
 *       `deployment: { eventBus: { enabled: true } }` added observes `'emit' in init === true` and
 *       leaves durable, tenant-scoped rows in `tenant_events`. Fail-the-fix: flip the composition
 *       root's `=== true`, or delete its eventBus hunk, and this arm goes red while (a) stays green.
 *       This boot wires no durable worker, so it also asserts the one-line notice that says the
 *       declared window sweeps nothing here.
 *   (c) THE RETENTION WINDOW IS THE DECLARED ONE: with `durableWorker: true` (so the housekeeping
 *       pass exists) and `retentionHours: 6`, `runCleanupNow` reports the event-bus half and sweeps an
 *       8-hour-old event while a fresh one survives — 8 hours is INSIDE the 24-hour default, so this
 *       arm is red if the declared window is ignored and the default is used. The truncation floor
 *       advances to exactly the highest seq deleted, and no unswept-bus notice is emitted.
 *
 * DB ISOLATION: a whole throwaway DATABASE (not a per-schema), exactly as stt-capability-boot.db.test.ts
 * — the migration chain materializes the platform into a database's default + `drizzle` schema. Arm (c)
 * launches DBOS (a process-global singleton), so it is the only arm in this file that may do so.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Backend, BackendId, RunResult } from '@rayspec/core';
import { registerScopedTables } from '@rayspec/db/testing';
import { typeStrippingImporter } from '@rayspec/platform';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assembleServer,
  type BootedServer,
  eventBusUnsweptBootNotice,
  loadServerConfig,
} from './composition-root.js';

function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}
function withDbName(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/** The one `{handler}` route every arm boots — it REPORTS the capability rather than assuming it. */
const ROUTE_SECTION = `
handlers:
  - id: emit_handler
    module: handlers/emit.ts
    export: emitNote
    kind: route
api:
  - method: POST
    path: /emit
    action: { kind: handler, handler: emit_handler }
`;

/** (a) The CONTROL document: no `deployment` section at all. */
const SPEC_CONTROL = `
version: '1.0'
metadata:
  name: event-bus-boot-control
  description: backend-profile spec that does NOT declare an event bus
${ROUTE_SECTION}`;

/** (b) The SAME document plus the one key under test. */
const SPEC_BUS = `
version: '1.0'
metadata:
  name: event-bus-boot-enabled
  description: backend-profile spec whose {handler} route emits through init.emit
deployment:
  eventBus:
    enabled: true
${ROUTE_SECTION}`;

/** The declared window arm (c) asserts on — INSIDE the 24-hour default, so the default cannot pass it. */
const RETENTION_HOURS = 6;

/** (c) The bus plus the durable worker whose daily pass actually performs the sweep. */
const SPEC_BUS_SWEPT = `
version: '1.0'
metadata:
  name: event-bus-boot-swept
  description: backend-profile spec whose declared retention window is swept by the housekeeping pass
deployment:
  durableWorker: true
  eventBus:
    enabled: true
    retentionHours: ${RETENTION_HOURS}
agents:
  - id: echo
    name: echo-agent
    backend: openai
    model: gpt-4o-mini
    instructions: Echo the input back.
    maxTurns: 2
${ROUTE_SECTION}`;

/**
 * The route handler, written to the temp handler root and loaded through the REAL path-jailed loader.
 * It reports PRESENCE with the `in` idiom (an `undefined`-valued key would read as present and fail
 * the control) and emits one event per requested topic when the capability is there.
 */
const HANDLER_TS = `
export const emitNote = async (init) => {
  if (!('emit' in init)) return { emit_present: false, tenant: init.tenantId };
  const topics = (init.body ?? {}).topics ?? ['note.created'];
  for (const topic of topics) await init.emit(topic, { topic, tenantSeen: init.tenantId });
  return { emit_present: true, emitted: topics.length, tenant: init.tenantId };
};
`;

/** The `openai` slot arm (c)'s declared agent resolves to. Never invoked — a run here would be a bug. */
class UnusedBackend implements Backend {
  readonly id = 'openai' as const;
  async resolveAuth() {
    return 'api-key' as const;
  }
  async run(): Promise<RunResult> {
    throw new Error('the event-bus boot fixture never fires an agent run');
  }
}

const SUITE_DB = `rayspec_server_eventbus_${process.pid}`;
const DBOS_SYS_DB = `${SUITE_DB}_dbos_sys`;

describe('event-bus capability boot — deployment.eventBus → engine → init.emit, and its retention', () => {
  const baseUrl = process.env.DATABASE_URL;
  const maybe = baseUrl ? it : it.skip;
  const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
  // un-skippable ran-guard (fires synchronously at collection): when the DB is REQUIRED but absent,
  // hard-fail rather than let this DB-backed boot suite silently self-skip to a false green.
  if (requireDb && !baseUrl) {
    throw new Error(
      'event-bus-capability-boot.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) ' +
        'but absent — refusing to silently skip this DB-backed boot suite.',
    );
  }

  let server: BootedServer | undefined;
  let sql: postgres.Sql | undefined;
  let tmpDir = '';
  let specPath = '';
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'DATABASE_URL',
    'ALLOWED_ORIGINS',
    'PORT',
    'RAYSPEC_SPEC_PATH',
    'RAYSPEC_HANDLER_ROOT',
    'DBOS_SYSTEM_DATABASE_URL',
    'RAYSPEC_CLEANUP_SCHEDULE',
    'RAYSPEC_GDPR_PURGE_ENABLED',
  ] as const;

  beforeAll(async () => {
    if (!baseUrl) return;
    const appDbUrl = withDbName(baseUrl, SUITE_DB);

    const admin = postgres(adminUrl(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${DBOS_SYS_DB}" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    tmpDir = mkdtempSync(join(tmpdir(), 'rayspec-eventbus-boot-'));
    specPath = join(tmpDir, 'rayspec.yaml');
    mkdirSync(join(tmpDir, 'handlers'), { recursive: true });
    writeFileSync(join(tmpDir, 'handlers', 'emit.ts'), HANDLER_TS, 'utf8');

    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'event-bus-boot-pepper-only';
    process.env.DATABASE_URL = appDbUrl;
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8805';
    process.env.RAYSPEC_SPEC_PATH = specPath;
    process.env.RAYSPEC_HANDLER_ROOT = tmpDir;
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    delete process.env.RAYSPEC_CLEANUP_SCHEDULE;
    delete process.env.RAYSPEC_GDPR_PURGE_ENABLED;

    sql = postgres(appDbUrl, { max: 2 });
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await sql?.end();
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    if (baseUrl) {
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${DBOS_SYS_DB}" WITH (FORCE)`);
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  }, 120_000);

  /** Boot the given document through the REAL composition root, collecting its boot notices. */
  async function boot(
    specYaml: string,
    opts: { readonly withBackends?: boolean } = {},
  ): Promise<{ booted: BootedServer; warnings: string[] }> {
    writeFileSync(specPath, specYaml, 'utf8');
    const warnings: string[] = [];
    const booted = await assembleServer(loadServerConfig(), {
      registerProductTables: (tables) => {
        registerScopedTables([...tables.values()]);
      },
      // The temp handler is un-built `.ts`; opt into the type-stripping importer seam (production
      // loads compiled `.js` only and never sets this).
      moduleImporter: typeStrippingImporter,
      bootWarn: (line: string) => warnings.push(line),
      ...(opts.withBackends
        ? {
            agentBackendsFactory: (): ReadonlyMap<BackendId, Backend> =>
              new Map<BackendId, Backend>([['openai', new UnusedBackend()]]),
          }
        : {}),
    });
    return { booted, warnings };
  }

  /** Register → org → switch → a member token (store:write gates a `{handler}` route). */
  async function memberToken(app: BootedServer['app'], email: string): Promise<string> {
    const reg = await app.request('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'correct-horse-battery-staple-9' }),
    });
    expect(reg.status).toBe(201);
    const t0 = (await reg.json()).accessToken as string;
    const orgRes = await app.request('/v1/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t0}` },
      body: JSON.stringify({ name: 'Event Bus Boot Co' }),
    });
    expect(orgRes.status).toBe(201);
    const orgId = (await orgRes.json()).id as string;
    const switchRes = await app.request(`/v1/orgs/${orgId}/switch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t0}` },
    });
    expect(switchRes.status).toBe(200);
    return (await switchRes.json()).accessToken as string;
  }

  async function callEmit(
    app: BootedServer['app'],
    token: string,
    topics?: readonly string[],
  ): Promise<Response> {
    return app.request('/emit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(topics ? { topics } : {}),
    });
  }

  /** Open the subscription surface (SSE) on a booted app. */
  async function callSubscribe(
    app: BootedServer['app'],
    token: string,
    query = '',
  ): Promise<Response> {
    return app.request(`/v1/subscribe${query}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    });
  }

  /**
   * Read `want` frames off a LIVE subscription and then cancel it. A subscription stays open for its
   * whole lifetime (here the access-token TTL), so a test MUST cancel rather than drain to the end.
   */
  async function readSse(
    res: Response,
    want: number,
    budgetMs = 20_000,
  ): Promise<{ id?: string; event?: string }[]> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error('subscribe response carried no body stream');
    const decoder = new TextDecoder();
    const deadline = Date.now() + budgetMs;
    const frames: { id?: string; event?: string }[] = [];
    let buffer = '';
    while (frames.length < want && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: false; value: undefined }>((r) =>
          setTimeout(
            () => r({ done: false, value: undefined }),
            Math.max(1, deadline - Date.now()),
          ),
        ),
      ]);
      if (chunk.done || chunk.value === undefined) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let idx = buffer.indexOf('\n\n');
      while (idx >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const frame: { id?: string; event?: string } = {};
        let sawField = false;
        for (const line of block.split('\n')) {
          if (line.startsWith('id:')) {
            frame.id = line.slice(3).trim();
            sawField = true;
          } else if (line.startsWith('event:')) {
            frame.event = line.slice(6).trim();
            sawField = true;
          } else if (line.startsWith('data:')) sawField = true;
        }
        if (sawField) frames.push(frame);
        idx = buffer.indexOf('\n\n');
      }
    }
    await reader.cancel().catch(() => {});
    return frames;
  }

  /** Ground truth: a tenant's event rows in seq order, read straight from the table. */
  async function eventsOf(tenantId: string): Promise<{ seq: number; topic: string }[]> {
    const rows = (await sql!.unsafe(
      'SELECT seq, topic FROM tenant_events WHERE tenant_id = $1 ORDER BY seq',
      [tenantId],
    )) as unknown as { seq: string | number; topic: string }[];
    return rows.map((r) => ({ seq: Number(r.seq), topic: r.topic }));
  }

  maybe(
    '(a) ACCEPT CONTROL: a document without deployment.eventBus boots and init.emit is ABSENT',
    async () => {
      const { booted, warnings } = await boot(SPEC_CONTROL);
      server = booted;
      const token = await memberToken(booted.app, 'bus-control@example.test');
      const res = await callEmit(booted.app, token);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { emit_present: boolean; tenant: string };
      // ABSENT, not undefined — the undeclared key leaves the init shape exact, so a handler that
      // needs the bus fail-closes loudly instead of emitting into a no-op.
      expect(body.emit_present).toBe(false);
      expect(await eventsOf(body.tenant)).toEqual([]);
      // No bus ⇒ nothing to sweep ⇒ no sweep notice.
      expect(warnings.filter((w) => w.startsWith('[events]'))).toEqual([]);
      // …and no stream to read either: the subscription surface fail-closes on the SAME signal that
      // decides whether the init carries `emit`, naming the key to set. Never a 404 (which would send
      // an operator hunting for a routing fault), and never an empty stream that reports itself fine.
      const sub = await callSubscribe(booted.app, token);
      expect(sub.status).toBe(501);
      expect((await sub.json()).error.message).toContain('deployment.eventBus.enabled');
      await booted.close();
      server = undefined;
    },
    180_000,
  );

  maybe(
    '(b) THE KEY IS LOAD-BEARING: deployment.eventBus.enabled:true puts init.emit on the SAME handler and the rows are durable',
    async () => {
      const { booted, warnings } = await boot(SPEC_BUS);
      server = booted;
      const token = await memberToken(booted.app, 'bus-enabled@example.test');
      const res = await callEmit(booted.app, token, ['note.created', 'note.updated']);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        emit_present: boolean;
        emitted: number;
        tenant: string;
      };
      // GROUND TRUTH: spec key → engine.eventBus → init.emit, wired through the REAL composition root.
      expect(body.emit_present).toBe(true);
      expect(body.emitted).toBe(2);
      // Durable, tenant-scoped and consecutive from 1 in call order.
      expect(await eventsOf(body.tenant)).toEqual([
        { seq: 1, topic: 'note.created' },
        { seq: 2, topic: 'note.updated' },
      ]);

      // The SAME key also opens the read side, through the SAME real composition root: a subscriber
      // resuming from the start of this tenant's stream receives both events, with TENANT-QUALIFIED
      // cursors, and then the backlog-drained control frame. This is the only place the boot's own
      // wiring of the subscription surface (route mount + event bus + the process wake) is exercised
      // — the api-auth suites inject those directly.
      const sub = await callSubscribe(booted.app, token, `?since=${body.tenant}:0`);
      expect(sub.status).toBe(200);
      expect(sub.headers.get('content-type')).toContain('text/event-stream');
      expect(await readSse(sub, 3)).toEqual([
        { id: `${body.tenant}:1`, event: 'note.created' },
        { id: `${body.tenant}:2`, event: 'note.updated' },
        { event: 'rayspec.live' }, // a control frame carries NO id — it can never be sent back
      ]);

      // This boot declared no durable worker, so no housekeeping pass exists to sweep the window.
      // The boot says so, once, naming the DEFAULT window it resolved (the key omitted retentionHours).
      expect(warnings).toContain(eventBusUnsweptBootNotice(24));
      await booted.close();
      server = undefined;
    },
    180_000,
  );

  maybe(
    '(c) THE DECLARED WINDOW IS THE ONE SWEPT: retentionHours:6 removes an 8-hour-old event and advances the floor',
    async () => {
      const { booted, warnings } = await boot(SPEC_BUS_SWEPT, { withBackends: true });
      server = booted;
      // A worker IS wired here, so the pass exists and the boot must NOT emit the unswept notice.
      expect(warnings.filter((w) => w.startsWith('[events]'))).toEqual([]);
      expect(typeof booted.runCleanupNow).toBe('function');

      const token = await memberToken(booted.app, 'bus-swept@example.test');
      const res = await callEmit(booted.app, token, ['old.event', 'fresh.event']);
      expect(res.status).toBe(200);
      const tenant = ((await res.json()) as { tenant: string }).tenant;
      expect(await eventsOf(tenant)).toEqual([
        { seq: 1, topic: 'old.event' },
        { seq: 2, topic: 'fresh.event' },
      ]);

      // Age ONLY the first event to 8 hours — OUTSIDE the declared 6-hour window but well INSIDE the
      // 24-hour default. If the composition root ignored `retentionHours` and passed the default, this
      // row survives and the arm fails: that is what makes the declared window load-bearing here.
      await sql!.unsafe(
        `UPDATE tenant_events SET at = now() - interval '8 hours' WHERE tenant_id = $1 AND seq = 1`,
        [tenant],
      );

      const result = await booted.runCleanupNow!();
      // The event-bus half is PRESENT (this deployment declared a bus) and it swept exactly the aged row.
      expect(result.eventBus).toEqual({ deleted: 1, tenants: 1 });
      expect(await eventsOf(tenant)).toEqual([{ seq: 2, topic: 'fresh.event' }]);

      // The truncation floor advanced to exactly the highest seq deleted, written in the same
      // statement as the delete — so a subscriber resuming from a cursor below it is detectable.
      const streams = (await sql!.unsafe(
        'SELECT last_seq, truncated_through FROM tenant_event_streams WHERE tenant_id = $1',
        [tenant],
      )) as unknown as { last_seq: string | number; truncated_through: string | number }[];
      expect(Number(streams[0]?.last_seq)).toBe(2);
      expect(Number(streams[0]?.truncated_through)).toBe(1);
    },
    180_000,
  );
});
