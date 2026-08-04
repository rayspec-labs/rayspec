/**
 * `rayspec deploy` — the agent trace export is OFF unless the operator asks for it (issue #287).
 *
 * `@openai/agents` exports traces to OpenAI by default and those traces carry prompts and tool
 * arguments. `deploy` is the strongest available signal that the workload running here belongs to
 * someone other than the operator, so on THAT path the export becomes an affirmative choice —
 * `RAYSPEC_AGENT_TRACING=openai` — while `rayspec-serve` and the local dev wrapper keep the SDK
 * default (a developer tracing their own agent sees their own prompts; that was never the risk case).
 *
 * DB-free. `applyDeployAgentTracing` and the deploy.ts catch block are the REAL ones; only the assemble
 * step, the listener and the store-chokepoint seal are stubbed. The SDK switch is captured AT
 * `assembleServer` CALL TIME — the whole point: a revert that dropped the call, or moved it after the
 * boot, leaves the captured value undefined and REDs the ordering assertion.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ captured: null as null | Record<string, string | undefined> }));

vi.mock('@rayspec/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@rayspec/server')>();
  return {
    ...actual,
    assembleServer: async () => {
      h.captured = { OPENAI_AGENTS_DISABLE_TRACING: process.env.OPENAI_AGENTS_DISABLE_TRACING };
      return { app: { fetch: () => new Response('ok') }, close: async () => {} };
    },
  };
});
vi.mock('@hono/node-server', () => ({
  // A fake listener: nothing binds a port, and the banner callback is never invoked.
  serve: () => ({ close: (done?: () => void) => done?.() }),
}));
// Only the SEAL is stubbed — `assembleOptsFromEnv` (the real one) still resolves the sanctioned
// registrar from this module, and sealing the chokepoint for real would shut it for the whole worker.
vi.mock('@rayspec/db/composition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@rayspec/db/composition')>()),
  sealProductStores: () => {},
}));

import { readFileSync } from 'node:fs';
import { format } from 'node:util';
import { serveDeployment } from './deploy.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
/** A committed PRODUCT document — the shape that takes the normal (non-static) boot. */
const ACME_SPEC = join(repoRoot, 'examples/acme-notes/acme-notes.product.yaml');

/** Dummy boot secrets: `loadServerConfig` shape-checks them; the stubbed assemble never uses them. */
const DUMMY_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  RAYSPEC_JWT_SIGNING_KEY: 'dummy-not-a-real-pem',
  RAYSPEC_API_KEY_PEPPER: 'dummy-pepper',
};

const TOUCHED = [
  'DATABASE_URL',
  'RAYSPEC_JWT_SIGNING_KEY',
  'RAYSPEC_API_KEY_PEPPER',
  'RAYSPEC_SPEC_PATH',
  'RAYSPEC_AGENT_TRACING',
  'OPENAI_AGENTS_DISABLE_TRACING',
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  for (const k of TOUCHED) delete process.env[k];
  for (const [k, v] of Object.entries(DUMMY_ENV)) process.env[k] = v;
  h.captured = null;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
});

describe('rayspec deploy — the trace-export default, applied BEFORE the boot', () => {
  it('turns the export off when RAYSPEC_AGENT_TRACING is unset — and does it before assembleServer', async () => {
    await serveDeployment(ACME_SPEC);
    expect(h.captured).not.toBeNull();
    expect(h.captured?.OPENAI_AGENTS_DISABLE_TRACING).toBe('1');
  });

  it('leaves the export on when the operator affirmatively selected it', async () => {
    process.env.RAYSPEC_AGENT_TRACING = 'openai';
    await serveDeployment(ACME_SPEC);
    expect(h.captured).not.toBeNull();
    expect(h.captured?.OPENAI_AGENTS_DISABLE_TRACING).toBeUndefined();
  });

  it('refuses the boot BY NAME on an unsupported value, and never reaches assembleServer', async () => {
    process.env.RAYSPEC_AGENT_TRACING = 'OpenAI';
    const written: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      written.push(`${format(...args)}\n`);
    });
    let exitCode: number | undefined;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code;
    }) as never);
    try {
      await serveDeployment(ACME_SPEC);
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
    expect(exitCode).toBe(1);
    // The house treatment for a fail-closed config abort: the diagnosis, prefixed, no stack frames.
    expect(written.join('')).toContain('RAYSPEC_AGENT_TRACING');
    expect(written.join('')).toMatch(/^\[rayspec deploy\] /);
    expect(written.join('')).not.toMatch(/\n\s+at /);
    expect(h.captured).toBeNull();
  });
});

/**
 * The SCOPE of half two, guarded at the source. Both entrypoints boot the same spec through the same
 * `assembleServer`, so nothing in a boot test can distinguish them; what makes `deploy` different is
 * that it — and only it — applies the default. A copy of the call into `rayspec-serve` would silently
 * take tracing away from the developer case this deliberately leaves alone.
 */
describe('the trace-export default is applied on the deploy path and nowhere else', () => {
  const callsIt = (file: string): boolean =>
    /applyDeployAgentTracing\s*\(/.test(
      readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1'),
    );

  it('rayspec deploy applies it; rayspec-serve and the local dev wrapper do not', () => {
    expect(callsIt(join(here, 'deploy.ts'))).toBe(true);
    expect(callsIt(join(repoRoot, 'packages/app/server/src/serve.ts'))).toBe(false);
    expect(callsIt(join(repoRoot, 'examples/local-boot/serve.ts'))).toBe(false);
  });
});
