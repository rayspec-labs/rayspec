/**
 * Every BOOT ENTRYPOINT under `examples/` owns its shutdown: `SIGINT`/`SIGTERM` stop it.
 *
 * Two arms, and they prove DIFFERENT amounts — read the second before trusting the first for all of them:
 *
 *   (a) BOOT arm — spawns the REAL `examples/support-ticket-triage/dev-boot.mjs` as a subprocess against
 *       a throwaway DATABASE (the wrapper creates it itself), waits for `/health` 200 (the accept
 *       control: the wrapper must still boot and serve exactly as before), signals it, and asserts the
 *       process is GONE with exit code 0 inside the budget. Without an owning handler the process stays
 *       alive and answering `/health` — `@openai/agents-core`'s SIGINT/SIGTERM handler exits only
 *       `if (!hasOtherListenersForSignals(sig))` (`process.listeners(event).length > 1`) and
 *       `signal-exit` re-raises only when `process.listeners(sig).length` equals its own listener count,
 *       so with both loaded each defers to the other. This arm covers ONE entrypoint: it is the only one
 *       whose boot needs no model-provider key (the two other wrappers default to live executor modes
 *       and abort without `OPENAI_API_KEY`; `local-boot`'s is TypeScript and needs a TS runner).
 *   (b) SOURCE arm — pins the shape in EVERY entrypoint it finds by reading them; the set is read off the
 *       filesystem (`discoverBootEntrypoints`), so an example added later is held from the day it lands.
 *       It asserts registration and wiring only; the behaviour behind that wiring is what arm (a) runs.
 *
 * DISCOVERY IS BY ROLE, NOT BY FILENAME — and that is the whole reason this header changed. The set was
 * once globbed as `examples/<slug>/dev-boot.mjs`, which silently excluded `examples/local-boot/serve.ts`:
 * that entrypoint carries the identical boot-window fix and NOTHING would have gone red if it were
 * reverted (measured — the reverted file passed this suite 5/5 before the rule was widened). A filename
 * list fixes the one path it names and misses the next one, so the rule is now "a non-test source file
 * directly under `examples/<slug>/` whose source names `assembleServer`" — the marker that the file boots
 * a RaySpec server. It is deliberately INDEPENDENT of the signal wiring asserted below, so the property
 * under test cannot also be the thing that removes a file from the set.
 *
 * ONE BOUND NEITHER ARM COVERS — a property of the wiring, not a gap in the arms: the exit sits inside
 * `httpServer.close()`'s callback, and Node runs that callback only once every open connection has
 * ended. Arm (a) signals an IDLE server. With a request still in flight the wrapper stops accepting
 * immediately but stays alive until that request finishes.
 *
 * A SECOND bound used to sit here and no longer does. The handler was registered only after `serve()`
 * returned, so a signal during the boot was answered by nobody: before the dependencies named above
 * installed theirs it killed the process, and from then until `serve()` returned it did NOTHING AT
 * ALL — a wrapper killed mid-boot hung until SIGKILL. Every entrypoint now claims SIGINT/SIGTERM before
 * its first awaited step, starting in a boot phase that aborts, and arm (b) asserts that ORDERING
 * rather than merely the registration. `packages/app/server/src/serve.ts` and
 * `packages/app/cli/src/deploy.ts` carry the same fix; `serve-boot-signal.test.ts` and
 * `deploy-boot-signal.test.ts` prove it functionally by signalling real mid-boot processes.
 *
 * `SIGHUP` is deliberately NOT wired: `signal-exit` registers for it and `@openai/agents-core` does not,
 * so signal-exit is its sole listener and re-raises it, which is why that signal already ends these
 * wrappers. Leaving it unlistened keeps that path as it is; arm (b) asserts the absence.
 *
 * Arm (a) skips without DATABASE_URL; the ran-guard at the bottom hard-fails if a REQUIRED run skipped it.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = resolve(here, '../../../../examples');

/** The source extensions a boot entrypoint may be written in — `local-boot`'s is TypeScript. */
const ENTRYPOINT_EXTENSIONS = ['.mjs', '.js', '.ts', '.mts', '.cjs'];
/** A test file is never an entrypoint, and three of `local-boot`'s DO name `assembleServer`. */
const IS_TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]s$/;
/**
 * The marker that says "this file boots a RaySpec server". Chosen because it is what every entrypoint
 * calls and what nothing else under `examples/<slug>/` calls — and, critically, because it is NOT part
 * of the signal wiring arm (b) asserts, so deleting the property under test cannot also delete the file
 * from the set being tested.
 */
const BOOT_MARKER = 'assembleServer';

/**
 * Every BOOT ENTRYPOINT under examples/ — READ OFF THE FILESYSTEM BY ROLE, never typed out and never
 * globbed by filename, so an example added later is held by arm (b) the moment it lands instead of
 * escaping a list nobody updated (or, as happened with `local-boot/serve.ts`, a glob nobody widened).
 * The floor assertion in arm (b) is what keeps a rule that found nothing from passing vacuously.
 */
function discoverBootEntrypoints(): string[] {
  const found: string[] = [];
  for (const slug of readdirSync(EXAMPLES, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue;
    for (const file of readdirSync(resolve(EXAMPLES, slug.name), { withFileTypes: true })) {
      if (!file.isFile()) continue;
      if (!ENTRYPOINT_EXTENSIONS.some((ext) => file.name.endsWith(ext))) continue;
      if (IS_TEST_FILE.test(file.name)) continue;
      const rel = `${slug.name}/${file.name}`;
      if (!readFileSync(resolve(EXAMPLES, rel), 'utf8').includes(BOOT_MARKER)) continue;
      found.push(rel);
    }
  }
  return found.sort();
}
const WRAPPERS = discoverBootEntrypoints();

/** The entrypoint arm (a) boots: the only one whose boot demands no model-provider key. */
const BOOTABLE_REL = 'support-ticket-triage/dev-boot.mjs';
/**
 * The TypeScript entrypoint the old `dev-boot.mjs` glob missed entirely. Named in the floor below so a
 * rule that quietly stopped matching a `.ts` entrypoint is RED rather than merely narrower — the exact
 * failure this widening exists to close.
 */
const TS_ENTRYPOINT_REL = 'local-boot/serve.ts';
const BOOTABLE_WRAPPER = resolve(EXAMPLES, BOOTABLE_REL);

const SUITE_DB = `rayspec_devboot_shutdown_${process.pid}`;
/** How long the wrapper gets to be gone after the signal. The shutdown itself is milliseconds. */
const EXIT_BUDGET_MS = 15_000;

// Ran-guard: arm (a) skipIf(!baseUrl)s, so a REQUIRED run (CI / RAYSPEC_REQUIRE_DB_TESTS) that lost
// DATABASE_URL would SILENTLY SKIP the only arm that actually signals a process and still read GREEN.
const dbRequired = Boolean(process.env.CI) || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
let signalTestsRan = 0;

function withDbName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** An ephemeral free port: bind :0, read what the OS handed out, release it. */
async function freePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const probe = createServer();
    probe.on('error', rej);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => res(port));
    });
  });
}

interface Booted {
  child: ChildProcess;
  out(): string;
  err(): string;
}

/** Spawn a wrapper with an EXPLICIT env (the ambient one would carry a different DATABASE_URL). */
function spawnWrapper(wrapper: string, dbUrl: string, port: number): Booted {
  const child = spawn(process.execPath, [wrapper], {
    cwd: EXAMPLES,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      DATABASE_URL: dbUrl,
      PORT: String(port),
      // The wrapper reads the two secrets from the repo-root .env only when they are UNSET, so an
      // ambient value (CI writes the PEM into the job env) has to be passed through here. A PEM
      // exported from a .env line keeps its literal \n escapes; restore real newlines exactly as the
      // wrapper does for the values it reads itself, or the boot fails closed on the key format.
      ...(process.env.RAYSPEC_JWT_SIGNING_KEY
        ? { RAYSPEC_JWT_SIGNING_KEY: process.env.RAYSPEC_JWT_SIGNING_KEY.replace(/\\n/g, '\n') }
        : {}),
      ...(process.env.RAYSPEC_API_KEY_PEPPER
        ? { RAYSPEC_API_KEY_PEPPER: process.env.RAYSPEC_API_KEY_PEPPER }
        : {}),
    },
  });
  let out = '';
  let err = '';
  child.stdout?.on('data', (d) => {
    out += String(d);
  });
  child.stderr?.on('data', (d) => {
    err += String(d);
  });
  return { child, out: () => out, err: () => err };
}

/** Poll GET /health until it answers 200 (the wrapper is serving), or throw with both streams. */
async function waitForBoot(booted: Booted, port: number, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (booted.child.exitCode !== null) {
      throw new Error(
        `dev-boot subprocess exited early (code ${booted.child.exitCode}) before serving\n` +
          `--- child stdout ---\n${booted.out()}\n--- child stderr ---\n${booted.err()}`,
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      throw new Error(
        `dev-boot did not become ready before the deadline\n` +
          `--- child stdout ---\n${booted.out()}\n--- child stderr ---\n${booted.err()}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Wait for the child to be gone; null means it was STILL RUNNING when the budget ran out. */
async function waitForExit(
  booted: Booted,
  budgetMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (booted.child.exitCode !== null || booted.child.signalCode !== null) {
      return { code: booted.child.exitCode, signal: booted.child.signalCode };
    }
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** SIGKILL a survivor so a failing run cannot leave a listening process behind. */
async function reap(booted: Booted | undefined): Promise<void> {
  if (!booted || booted.child.exitCode !== null || booted.child.signalCode !== null) return;
  booted.child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 250));
}

describe.skipIf(!baseUrl)('examples/*/dev-boot.mjs — a signal stops the wrapper', () => {
  const spawned: Booted[] = [];

  afterAll(async () => {
    for (const booted of spawned) await reap(booted);
    if (!baseUrl) return;
    const admin = postgres(withDbName(baseUrl, 'postgres'), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}_dbos_sys" WITH (FORCE)`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`boots, serves /health, and exits 0 within ${EXIT_BUDGET_MS} ms of ${signal}`, async () => {
      if (!baseUrl) return;
      const port = await freePort();
      const booted = spawnWrapper(BOOTABLE_WRAPPER, withDbName(baseUrl, SUITE_DB), port);
      spawned.push(booted);

      // Accept control: the wrapper still boots and serves. Without it a wrapper that failed to
      // start would pass the exit assertion below for the wrong reason.
      await waitForBoot(booted, port, 60_000);
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);

      booted.child.kill(signal);
      const exit = await waitForExit(booted, EXIT_BUDGET_MS);
      expect(
        exit,
        `the wrapper was STILL RUNNING ${EXIT_BUDGET_MS} ms after ${signal}\n` +
          `--- child stdout ---\n${booted.out()}\n--- child stderr ---\n${booted.err()}`,
      ).not.toBeNull();
      // Exit code 0 — the contract serve.ts sets — reached through the wrapper's OWN handler: not a
      // signal death, and the shutdown line on stdout is that handler having run.
      expect(exit?.code).toBe(0);
      expect(exit?.signal).toBeNull();
      expect(booted.out()).toContain(`${signal} received`);

      // The listener is gone with the process — the port refuses connections.
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
      signalTestsRan += 1;
    }, 120_000);
  }
});

describe('examples/* boot entrypoints — every one registers the same owning handler', () => {
  // The floor under the discovery above: an EMPTY or truncated rule would collect zero `it`s below and
  // this file would still read GREEN while pinning nothing. Four entrypoints exist today; the boot arm's
  // own wrapper must be among them, or arm (a) is signalling a path arm (b) never reads — and so must
  // the TypeScript one, which is what the previous filename glob dropped on the floor.
  it('discovers every examples/<slug> boot entrypoint on disk', () => {
    expect(WRAPPERS.length).toBeGreaterThanOrEqual(4);
    expect(WRAPPERS).toContain(BOOTABLE_REL);
    expect(WRAPPERS).toContain(TS_ENTRYPOINT_REL);
  });

  for (const wrapper of WRAPPERS) {
    it(`${wrapper} closes the http server, awaits server.close() and exits 0`, () => {
      const src = readFileSync(resolve(EXAMPLES, wrapper), 'utf8');
      expect(src).toContain("process.on('SIGINT', () => phase.handle('SIGINT'));");
      expect(src).toContain("process.on('SIGTERM', () => phase.handle('SIGTERM'));");
      // The registration must come BEFORE the boot, not after it — that is the whole point of the
      // `phase` indirection, and the ordering is the property, so assert the ordering.
      //
      // Anchored on `const server = await`, which every entrypoint writes, rather than on
      // `await assembleServer(`: `local-boot/serve.ts` wraps the call as
      // `await withBootTimeout(assembleServer(…), …)`, so the old anchor was ABSENT there and
      // `indexOf` returned -1 — an ordering assertion that fails for the wrong reason. Anchoring on
      // the bare `assembleServer(` instead would be worse: contract-intake and support-intake-chat
      // both print it inside a header COMMENT above their registration, which would invert the test.
      const assembleAt = src.indexOf('const server = await');
      expect(assembleAt, 'no `const server = await …` — the ordering anchor is gone').toBeGreaterThan(
        -1,
      );
      expect(src.indexOf("process.on('SIGTERM'")).toBeLessThan(assembleAt);
      // …and the graceful close REPLACES the boot-phase abort rather than adding a second pair.
      // Matched by regex, not substring: the TypeScript entrypoint annotates the same assignment as
      // `phase.handle = (signal: string): void => {`.
      expect(src).toMatch(/phase\.handle = \(signal(?:: string)?\)(?:: void)? => \{/);
      expect(src.match(/process\.on\('SIGTERM'/g) ?? []).toHaveLength(1);
      expect(src).toContain('received during boot — aborting before the server listens.');
      expect(src).toContain('httpServer.close(async () => {');
      // server.close() drains the durable worker and ends the DB pool; skipping it would orphan both.
      expect(src).toContain('await server.close();');
      expect(src).toContain('process.exit(0);');
      // No SIGHUP REGISTRATION (the entrypoint's comment names the signal, so match the call):
      // signal-exit is its only listener today and re-raises it — see the header.
      expect(src).not.toContain("process.on('SIGHUP'");
    });
  }
});

// The un-skippable ran-guard: fail loudly if a REQUIRED (CI / RAYSPEC_REQUIRE_DB_TESTS) run SKIPPED
// the arm that signals a real process (a lost DATABASE_URL would otherwise read GREEN).
describe('examples/* boot entrypoints — ran-guard', () => {
  it('the signal arm actually ran when the DB was required', () => {
    if (dbRequired) expect(signalTestsRan).toBe(2);
    else expect(true).toBe(true);
  });
});
