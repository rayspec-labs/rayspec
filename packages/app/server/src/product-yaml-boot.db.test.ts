/**
 * The ENV-DRIVEN Product-YAML boot, end-to-end on GROUND
 * TRUTH through the REAL composition root + the REAL DBOS durable path.
 *
 * Boots the REAL `assembleServer` from `RAYSPEC_SPEC_PATH=<the neutral acme-notes.product.yaml>` against a throwaway
 * DATABASE + a real DBOS launch, with a fixtured fake STT + an injected deterministic (in-set) grounded
 * extractor (the platform ships neither — product-free). Then drives the FULL product flow over REAL
 * HTTP and asserts on ground truth (fail-the-fix):
 *   1. the boot dispatched to the Product-YAML path (deployMode 'materialized'; derived stores exist);
 *   2. upload → dual-track finalize → the REAL `DbosWorkflowExecutor` runs the workflow OFF-REQUEST →
 *      the workflow_runs journal completes, EXACTLY ONE run for the deployment tenant (C10);
 *   3. the DECLARED views serve the transcript + the GROUNDED notes (prune/drop visible).
 *
 * (The grounded-through-DBOS artifacts + the real gpt-5 leg + real playback bytes are additionally
 * proven by the acme-notes-e2e.db.test.ts (api-auth); this pins the env-boot + real-DBOS glue.)
 *
 * Skips without DATABASE_URL; a real DBOS launch needs a separate `<appdb>_dbos_sys` (auto-created).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryAgentHandlerRegistry } from '@rayspec/agent-runtime';
import { registerScopedTables } from '@rayspec/db/testing';
import { FakeSttAdapter, type SttDualTrackFixture } from '@rayspec/stt-port';
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer, type BootedServer, loadServerConfig } from './composition-root.js';

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const ACME_YAML = resolve(here, '../../../../examples/acme-notes/acme-notes.product.yaml');

// ran-guard: this suite `skipIf(!baseUrl)`s so a credential-free dev run skips
// ergonomically — but a REQUIRED run (CI / RAYSPEC_REQUIRE_DB_TESTS) that lost
// DATABASE_URL would then SILENTLY SKIP the ledger-6.3 real-DBOS boot proof and still read GREEN. The
// separate, NON-skipped ran-guard describe at the bottom hard-fails on exactly that. Needs NO fixture
// (unlike the migration test) → its guard is unconditional under a required run.
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let bootTestsRan = 0;

const SUITE_DB = `rayspec_product_boot_${process.pid}`;
const TENANT = '00000000-0000-4000-8000-0000000000d9';
const SESSION = 'boot-rec-1';

const STT_FIXTURE: SttDualTrackFixture = {
  fixture_id: 'product-boot',
  session_id: SESSION,
  tracks: [
    {
      track: 'mic',
      status: 'completed',
      segments: [
        { span_id: 'mic:s0', text: 'We decided to ship the boot composition.' },
        { span_id: 'mic:s1', text: 'Dana will write the runbook.' },
      ],
    },
    { track: 'system', status: 'completed', segments: [{ span_id: 'system:s0', text: 'Agreed.' }] },
  ],
};

/** A deterministic in-set grounded extractor (drop + prune probes), injected — the platform ships none. */
function groundedExtractor(): InMemoryAgentHandlerRegistry {
  const registry = new InMemoryAgentHandlerRegistry();
  registry.register('agent.note_extractor', (input) => {
    const output = input.artifact_outputs.find((a) => a.schema_ref === 'acme.notes');
    if (!output) throw new Error('declared output artifact missing');
    return [
      {
        ...output,
        value: {
          headline: 'Boot shipped; runbook owned.',
          detail: 'The team settled the boot composition; Dana owns the runbook.',
          output_language: 'en',
          items: [
            { text: 'Ship the boot composition.', evidence: ['mic:s0'] },
            {
              text: 'Hallucinated — no real evidence.',
              evidence: ['ghost:s9'], // DROP probe — must never persist
            },
          ],
          pointers: [
            {
              text: 'Write the runbook.',
              evidence: ['mic:s1', 'ghost:s9'], // PRUNE probe — ghost removed, mic:s1 kept
            },
          ],
          queries: [],
          labels: [{ text: 'Cutover slips.', evidence: ['system:s0'] }],
          mentions: [],
        },
      },
    ];
  });
  return registry;
}

function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}
function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

describe.skipIf(!baseUrl)(
  'Product-YAML env boot — real composition root + real DBOS durable path',
  () => {
    let server: BootedServer | undefined;
    let appDbUrl = '';
    let dbosSysDb = '';
    let blobDir = '';
    const saved: Record<string, string | undefined> = {};
    const ENV = [
      'RAYSPEC_JWT_SIGNING_KEY',
      'RAYSPEC_API_KEY_PEPPER',
      'DATABASE_URL',
      'ALLOWED_ORIGINS',
      'PORT',
      'RAYSPEC_SPEC_PATH',
      'DBOS_SYSTEM_DATABASE_URL',
      'RAYSPEC_PRODUCT_TENANT_ID',
      'STT_PROVIDER',
      'RAYSPEC_EXTRACTION_MODE',
      'RAYSPEC_BLOB_ROOT',
      'RAYSPEC_MEDIA_SIGNING_KEY',
    ] as const;

    async function drop(admin: postgres.Sql): Promise<void> {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbosSysDb}" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
    }

    beforeAll(async () => {
      if (!baseUrl) return;
      appDbUrl = withDbName(baseUrl, SUITE_DB);
      dbosSysDb = `${SUITE_DB}_dbos_sys`;
      const admin = postgres(adminUrl(baseUrl), { max: 1 });
      try {
        await drop(admin);
        await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
      } finally {
        await admin.end();
      }

      blobDir = mkdtempSync(join(tmpdir(), 'rayspec-product-boot-'));
      for (const k of ENV) saved[k] = process.env[k];
      const { privateKey } = await generateKeyPair('RS256', { extractable: true });
      process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
      process.env.RAYSPEC_API_KEY_PEPPER = 'product-boot-pepper-only';
      process.env.DATABASE_URL = appDbUrl;
      delete process.env.ALLOWED_ORIGINS;
      process.env.PORT = '8802';
      process.env.RAYSPEC_SPEC_PATH = ACME_YAML;
      delete process.env.DBOS_SYSTEM_DATABASE_URL;
      process.env.RAYSPEC_PRODUCT_TENANT_ID = TENANT;
      process.env.STT_PROVIDER = 'fake';
      process.env.RAYSPEC_EXTRACTION_MODE = 'deterministic';
      process.env.RAYSPEC_BLOB_ROOT = blobDir;
      process.env.RAYSPEC_MEDIA_SIGNING_KEY = 'product-boot-media-secret-at-least-32-bytes-xx';

      const config = loadServerConfig();
      server = await assembleServer(config, {
        registerProductTables: (tables) => registerScopedTables([...tables.values()]),
        productDeterministicAgents: groundedExtractor(),
        productSttAdapter: new FakeSttAdapter({ fixtures: [STT_FIXTURE] }),
      });

      // The deployment tenant + a member principal (the workflow_runs FK + the authed tenant must be it).
      const client = postgres(appDbUrl, { max: 2 });
      try {
        await client.unsafe(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Acme', 'acme')`, [
          TENANT,
        ]);
      } finally {
        await client.end();
      }
    }, 180_000);

    afterAll(async () => {
      await server?.close();
      for (const k of ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      if (blobDir) rmSync(blobDir, { recursive: true, force: true });
      if (baseUrl) {
        const admin = postgres(adminUrl(baseUrl), { max: 1 });
        try {
          await drop(admin);
        } finally {
          await admin.end();
        }
      }
    }, 60_000);

    async function token(): Promise<string> {
      const email = `product-boot-${Date.now()}@example.com`;
      const reg = await server!.app.request('/v1/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'a-long-enough-password' }),
      });
      expect([200, 201]).toContain(reg.status);
      const client = postgres(appDbUrl, { max: 2 });
      let userId: string;
      try {
        const rows = (await client.unsafe('SELECT id FROM users WHERE email = $1', [
          email,
        ])) as unknown as Array<{ id: string }>;
        userId = rows[0]!.id;
        await client.unsafe(
          `INSERT INTO memberships (org_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')`,
          [TENANT, userId],
        );
      } finally {
        await client.end();
      }
      const sw = await server!.app.request(`/v1/orgs/${TENANT}/switch`, {
        method: 'POST',
        headers: { authorization: `Bearer ${(await reg.json()).accessToken}` },
      });
      expect(sw.status).toBe(200);
      return (await sw.json()).accessToken as string;
    }

    async function workflowRuns(): Promise<Array<{ status: string; tenant_id: string }>> {
      const client = postgres(appDbUrl, { max: 1 });
      try {
        return (await client.unsafe(
          'SELECT status, tenant_id FROM workflow_runs',
        )) as unknown as Array<{
          status: string;
          tenant_id: string;
        }>;
      } finally {
        await client.end();
      }
    }

    const maybe = baseUrl ? it : it.skip;

    maybe(
      'env boot → Product-YAML dispatch → finalize runs the REAL DBOS workflow → views serve grounded notes',
      async () => {
        bootTestsRan += 1;
        expect(server!.deployMode).toBe('materialized');

        const t = await token();
        const post = (track: string, i: number, bytes: Uint8Array) =>
          server!.app.request(`/sessions/${SESSION}/${track}/chunks/${i}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${t}`, 'content-type': 'audio/ogg' },
            body: bytes,
          });
        const finalize = (track: string, total: number) =>
          server!.app.request(`/sessions/${SESSION}/${track}/finalize`, {
            method: 'POST',
            headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
            body: JSON.stringify({ total_chunks: total }),
          });

        expect((await post('mic', 0, new Uint8Array([1, 2]))).status).toBe(200);
        expect((await post('mic', 1, new Uint8Array([3]))).status).toBe(200);
        expect((await post('system', 0, new Uint8Array([4, 5, 6]))).status).toBe(200);
        expect((await finalize('mic', 2)).status).toBe(200);
        expect((await finalize('system', 1)).status).toBe(200);

        // The REAL DbosWorkflowExecutor runs the workflow OFF-REQUEST — poll the journal for completion.
        const deadline = Date.now() + 60_000;
        let runs: Array<{ status: string; tenant_id: string }> = [];
        for (;;) {
          runs = await workflowRuns();
          if (runs.length > 0 && runs.every((r) => r.status === 'completed')) break;
          if (Date.now() > deadline)
            throw new Error(`workflow did not complete: ${JSON.stringify(runs)}`);
          await new Promise((r) => setTimeout(r, 250));
        }
        expect(runs).toHaveLength(1); // EXACTLY ONE run (C10 single-flight across dual-track finalize)
        expect(runs[0]?.tenant_id).toBe(TENANT);

        // The transcript view serves the REAL persisted transcript.
        const tx = await server!.app.request(`/sessions/${SESSION}/mic/transcript`, {
          headers: { authorization: `Bearer ${t}` },
        });
        expect(tx.status).toBe(200);
        const txBody = (await tx.json()) as Record<string, unknown>;
        expect(txBody.status).toBe('completed');
        expect(txBody.full_text).toContain('ship the boot composition');

        // The notes view serves the GROUNDED artifacts — the drop + prune are visible.
        const notes = await server!.app.request(`/sessions/${SESSION}/notes`, {
          headers: { authorization: `Bearer ${t}` },
        });
        expect(notes.status).toBe(200);
        const notesBody = (await notes.json()) as {
          items: Array<{ text: string; evidence: string[] }>;
          pointers: Array<{ evidence: string[] }>;
          counts: { item: number; pointer: number; total: number };
        };
        // The hallucinated item was DROPPED (only the grounded one survives).
        expect(notesBody.items.map((i) => i.text)).toEqual(['Ship the boot composition.']);
        // The out-of-set 'ghost:s9' citation was PRUNED from the pointer.
        expect(notesBody.pointers[0]?.evidence).toEqual(['mic:s1']);
        expect(notesBody.counts).toMatchObject({ item: 1, pointer: 1, total: 4 });
      },
      120_000,
    );
  },
);

/**
 * ran-guard: a SEPARATE, NON-skipped describe that fails the run when the DB is
 * REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) but the env-boot proof above did NOT run
 * (a lost DATABASE_URL silently skipped the ledger-6.3 real-DBOS composition). Registered LAST with no
 * beforeAll dependency, so even a setup that throws-and-skips leaves `bootTestsRan` at 0 and THIS fails.
 * A local dev with no DB and no CI/opt-in still skips ergonomically (the assertion is a no-op there).
 */
describe('Product-YAML env boot — ran-guard (the real-DBOS proof must not silently skip in CI)', () => {
  it('the env-boot proof ACTUALLY RAN when the DB is required (CI / opt-in)', () => {
    if (dbRequired) {
      expect(bootTestsRan).toBe(1);
    } else {
      expect(dbRequired).toBe(false);
    }
  });
});
