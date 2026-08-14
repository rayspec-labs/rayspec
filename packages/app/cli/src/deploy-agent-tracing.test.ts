/**
 * `rayspec deploy` — the agent trace export is OFF unless the operator asks for it (issue #287).
 *
 * `@openai/agents` exports traces to OpenAI by default; what leaves on that transport is run metadata
 * and, once an agent calls tools, its tool arguments and outputs (the SDK strips the model prompt
 * fields before export). `deploy` is the strongest available signal that the workload running here
 * belongs to someone other than the operator, so on THAT path the export becomes an affirmative
 * choice — `RAYSPEC_AGENT_TRACING=openai`. What is deploy-only is that DEFAULT, not the variable:
 * `rayspec-serve` honours an explicitly stated value and keeps the SDK default only when it is unset
 * (`applyServeAgentTracing`, issue #383), while the dev-boot wrappers (examples/local-boot,
 * deployments/acme-notes) assemble the server themselves and never read it.
 *
 * WHAT THIS FILE PINS, and what it deliberately does not. The decisive question — does the SDK still
 * export? — is answered against the real SDK, in a child process at `NODE_ENV=production`, by
 * `deploy-agent-tracing.sdk.test.ts`; an in-process assertion cannot answer it, because vitest's
 * `NODE_ENV=test` makes that SDK report tracing as disabled whatever the code does. What THIS file
 * pins is the seam around it: the posture is applied BEFORE `serveDeployment` imports the boot closure
 * (the ordering the SDK's one-shot snapshot depends on), and an unsupported value refuses the boot by
 * name instead of booting.
 *
 * DB-free. The deploy.ts catch blocks are the REAL ones; only the boot closure, the listener and the
 * store-chokepoint seal are stubbed.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** Every module event, in the order deploy.ts caused it. The ordering assertion reads this. */
  events: [] as string[],
  /** What the stubbed apply step should do, per test. */
  applyThrows: undefined as unknown,
}));

// The trace-export module `serveDeployment` reaches through the `@rayspec/server/agent-tracing`
// SUBPATH. Stubbed so this suite can observe WHEN it is called relative to the closure import — the
// property the fix turns on. Its own behaviour is asserted in the server package's agent-tracing.test.ts
// and, against the SDK, in deploy-agent-tracing.sdk.test.ts.
vi.mock('@rayspec/server/agent-tracing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@rayspec/server/agent-tracing')>();
  return {
    ...actual,
    applyDeployAgentTracing: async () => {
      h.events.push('applyDeployAgentTracing');
      if (h.applyThrows !== undefined) throw h.applyThrows;
      return 'off' as const;
    },
  };
});

vi.mock('@rayspec/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@rayspec/server')>();
  // Importing THIS module is what loads the agent SDK in production (through product-boot and the
  // adapters), so the event is recorded at module-factory time — not when a function is called.
  h.events.push('import(@rayspec/server)');
  return {
    ...actual,
    assembleServer: async () => {
      h.events.push('assembleServer');
      return { app: { fetch: () => new Response('ok') }, close: async () => {} };
    },
  };
});
vi.mock('@hono/node-server', () => ({
  // A fake listener: nothing binds a port, and the banner callback is never invoked. It still carries
  // the `'error'`-event surface, because the REAL `attachBindRefusal` (this file spreads the actual
  // module above) registers a listener on it — one that never fires, since nothing here binds.
  serve: () => ({
    close: (done?: () => void) => done?.(),
    on: () => {},
    removeListener: () => {},
    emit: () => false,
  }),
}));
// Only the SEAL is stubbed — `assembleOptsFromEnv` (the real one) still resolves the sanctioned
// registrar from this module, and sealing the chokepoint for real would shut it for the whole worker.
vi.mock('@rayspec/db/composition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@rayspec/db/composition')>()),
  sealProductStores: () => {},
}));

import { readFileSync } from 'node:fs';
import { format } from 'node:util';
import { BootConfigError } from '@rayspec/server/agent-tracing';
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
  h.events = [];
  h.applyThrows = undefined;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
});

describe('rayspec deploy — the trace-export posture is applied BEFORE the boot closure loads', () => {
  // FIRST in the file on purpose: the `import(@rayspec/server)` event is recorded by the mock FACTORY,
  // which a module registry runs once. Only the test that triggers the very first import can observe
  // where it fell in the sequence, so that test has to be this one.
  it('applies it before importing @rayspec/server, not merely before assembleServer', async () => {
    await serveDeployment(ACME_SPEC);
    // The ordering that matters. `@openai/agents` builds its global trace provider while it is being
    // evaluated, and that provider snapshots the kill-switch ONCE — so a posture applied after the
    // closure (which reaches the SDK through the adapters) has already lost. Asserting only "before
    // assembleServer" would pass on a build that applies it 50 lines too late.
    expect(h.events).toEqual([
      'applyDeployAgentTracing',
      'import(@rayspec/server)',
      'assembleServer',
    ]);
  });

  it('refuses the boot BY NAME on an unsupported value, and never assembles anything', async () => {
    h.applyThrows = new BootConfigError(
      "Boot aborted — RAYSPEC_AGENT_TRACING='OpenAI' is not supported (wired: openai | off; unset ⇒ " +
        'off). Fail-closed.',
    );
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
    // …and the refusal REPLACED the boot rather than preceding it: nothing was assembled.
    expect(h.events).toContain('applyDeployAgentTracing');
    expect(h.events).not.toContain('assembleServer');
  });
});

/**
 * The SCOPE of the default, guarded at the source. Both entrypoints boot the same spec through the same
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
