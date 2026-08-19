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
 *       filesystem (`discoverBy`), so an example added later cannot escape a hand-maintained list.
 *       It asserts registration and wiring only; the behaviour behind that wiring is what arm (a) runs.
 *
 * DISCOVERY IS BY ROLE, NOT BY FILENAME — and that is the whole reason this header changed. The set was
 * once globbed as `examples/<slug>/dev-boot.mjs`, which silently excluded `examples/local-boot/serve.ts`:
 * that entrypoint carries the identical boot-window fix and NOTHING would have gone red if it were
 * reverted (measured — the reverted file passed this suite 5/5 before the rule was widened). A filename
 * list fixes the one path it names and misses the next one, so the rule is now "a non-test source file
 * directly under `examples/<slug>/` that names `@rayspec/server`", cross-checked against the narrower
 * `assembleServer` call every entrypoint makes today. Both markers are deliberately INDEPENDENT of the
 * signal wiring asserted below, so the property under test cannot also remove a file from the set.
 *
 * WHAT THAT DOES AND DOES NOT BUY, stated exactly. It closes the failure that happened: a different file
 * name, a different language, or a different `@rayspec/server` entry point is now DISCOVERED, and a file
 * that reaches for the package without calling `assembleServer` is NAMED by the marker-agreement arm
 * rather than silently held or skipped. It does NOT make the set self-maintaining in general — the floor
 * is a static `>= 4`, and a wrapper that boots without naming `@rayspec/server` at all is outside the
 * rule and would still need this file changed. That case is uncovered, and saying so is the point.
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
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

const baseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = resolve(here, '../../../../examples');

// [SOURCE-MASKER v2 BEGIN] — every copy of this block is pinned byte-identical; see the sameness
// arm at the bottom of this file, which finds the copies on disk rather than trusting a list.
//
// WHAT MAKES "THE MARKER IS CODE" A CHECKABLE CLAIM.
//
// TWO PASSES, AND THE ORDER IS WHAT MAKES THEM EXACT:
//
//   1. LITERALS, from the TypeScript parser's own AST. The parser — not a regex — is what decides
//      whether a `/` opens a regular expression or divides, because that is a parse-context
//      question no lexer can answer alone. Getting it wrong swallows real code.
//   2. COMMENTS, scanned over a copy with pass 1's spans blanked out. On text that holds no
//      string, template or regex literal, `//` and `/*` can ONLY begin a comment: every quote
//      that could confuse the scan is already gone, and division can never leave two adjacent
//      slashes because JavaScript reads those as a comment too. A comment-FIRST pass is the one
//      that gets `'https://example.com'` wrong.
//
// BOTH PASSES ARE LOAD-BEARING, and that was measured rather than assumed: an AST-only masker is
// defeated by exactly the substitution shape these scans exist to refuse, because `forEachChild`
// never visits punctuation tokens and so never reaches a comment that is leading trivia of a bare
// `}`; a comment-first masker breaks on `'https://…'`. Neither pass can be dropped.
//
// THE TWO CONSTRUCTS AN AST WALK STILL CANNOT REACH ARE CLOSED BY MECHANISM, NOT BY ARGUMENT:
//
//   - A SHEBANG is trivia no node carries. It can only sit at offset 0, and is masked as a span.
//   - CONFLICT MARKERS are reported as parse diagnostics (measured: 3 for a two-way conflict), and
//     this REFUSES any source that produces a diagnostic at all. A mis-parse under-masks, and
//     under-masking is the direction that leaves a hole open while looking fixed.
//
// IT ERRS TOWARD OVER-MASKING, DELIBERATELY. Spans are taken at full extent including delimiters,
// and an unterminated comment masks to end of file. Over-masking makes a guard go RED for the
// wrong reason — loud, and survivable. Under-masking would leave the hole open while looking
// fixed, which is silent. Given the choice, this instrument takes the loud failure.

/** Node kinds whose text is DATA, never executable code. */
const MASKED_LITERAL_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.JsxText,
]);

/** Every `[from, to)` span of `source` whose text is a comment or a literal — never code. */
function maskedSpans(
  source: string,
  scriptKind: ts.ScriptKind = ts.ScriptKind.TS,
): ReadonlyArray<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];

  // PASS 1 — literals, from the parser.
  const parsed = ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, true, scriptKind);
  // FAIL CLOSED on a source the parser could not read: a mis-parse under-masks. `parseDiagnostics`
  // is not on the public `SourceFile` type, so it is read defensively — if the field ever
  // disappears the check degrades to a no-op instead of throwing on every file.
  const diagnostics = (parsed as unknown as { parseDiagnostics?: readonly unknown[] })
    .parseDiagnostics;
  if (Array.isArray(diagnostics) && diagnostics.length > 0) {
    throw new Error(
      `source masking REFUSED a file the TypeScript parser reported ${diagnostics.length} ` +
        'syntax diagnostic(s) in (conflict markers do exactly this). A mis-parse under-masks, ' +
        'which is the silent direction, so this throws rather than guessing.',
    );
  }
  const walk = (node: ts.Node): void => {
    if (MASKED_LITERAL_KINDS.has(node.kind)) spans.push([node.getStart(parsed), node.getEnd()]);
    node.forEachChild(walk);
  };
  parsed.forEachChild(walk);

  // PASS 2 — comments, over literal-free text. Blanking preserves length, so offsets still line
  // up with the original; newlines are kept so a `//` comment still ends where it really ends.
  const chars = source.split('');
  for (const [from, to] of spans) {
    for (let at = from; at < to; at += 1) {
      if (chars[at] !== '\n') chars[at] = ' ';
    }
  }
  const blanked = chars.join('');
  // The shebang, which is trivia the AST never surfaces and which can only sit at offset 0.
  if (blanked.startsWith('#!')) {
    const firstLine = blanked.indexOf('\n');
    spans.push([0, firstLine < 0 ? blanked.length : firstLine]);
  }
  let cursor = 0;
  while (cursor < blanked.length) {
    const slash = blanked.indexOf('/', cursor);
    if (slash < 0) break;
    const next = blanked[slash + 1];
    if (next === '/') {
      const newline = blanked.indexOf('\n', slash);
      const end = newline < 0 ? blanked.length : newline;
      spans.push([slash, end]);
      cursor = end;
    } else if (next === '*') {
      const close = blanked.indexOf('*/', slash + 2);
      const end = close < 0 ? blanked.length : close + 2;
      spans.push([slash, end]);
      cursor = end;
    } else {
      cursor = slash + 1;
    }
  }
  return spans;
}

/** A code-position test over one source text, with the parse done once. */
function codeMask(
  source: string,
  scriptKind: ts.ScriptKind = ts.ScriptKind.TS,
): (offset: number) => boolean {
  const spans = maskedSpans(source, scriptKind);
  return (offset) => !spans.some(([from, to]) => offset >= from && offset < to);
}
// [SOURCE-MASKER v2 END]

/** The source extensions a boot entrypoint may be written in — `local-boot`'s is TypeScript. */
const ENTRYPOINT_EXTENSIONS = ['.mjs', '.js', '.ts', '.mts', '.cjs'];
/** A test file is never an entrypoint, and several of `local-boot`'s DO name both markers below. */
const IS_TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]s$/;
/**
 * TWO markers, and the pair is the point — a single one is a rule whose blind spot nobody can see.
 *
 * `PACKAGE_MARKER` is the DISCOVERY rule: a file that reaches for `@rayspec/server` at all. That is
 * the broader of the two and the one a future entrypoint is least able to avoid, because assembling
 * a RaySpec server is what that package is for.
 *
 * `ASSEMBLE_MARKER` is the narrower CALL every entrypoint makes today. It is CROSS-CHECKED against
 * the discovery set rather than used as the rule, so an entrypoint that boots through some other
 * `@rayspec/server` export lands in the discovery set and is HELD, instead of being silently absent
 * the way `local-boot/serve.ts` was under the old filename glob.
 *
 * Both are deliberately independent of the signal wiring arm (b) asserts, so deleting the property
 * under test cannot also delete the file from the set being tested.
 */
const PACKAGE_MARKER = '@rayspec/server';
const ASSEMBLE_MARKER = 'assembleServer';

/**
 * Every non-test source file directly under `examples/<slug>/` whose source contains `marker`.
 *
 * Matching is over RAW SOURCE, comments included, and that asymmetry is deliberate: a file that only
 * MENTIONS a marker in prose is pulled in and held to the shape assertions (loud, and easy to see),
 * whereas stripping comments to be clever would risk dropping a real entrypoint (silent, and the
 * exact failure mode this suite exists to close). Measured while proving the agreement arm red — a
 * probe whose comment merely said "never calls assembleServer" joined the narrower set on that word
 * alone. Both markers are matched the same way, so the two sets stay comparable.
 */
function discoverBy(marker: string): string[] {
  const found: string[] = [];
  for (const slug of readdirSync(EXAMPLES, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue;
    for (const file of readdirSync(resolve(EXAMPLES, slug.name), { withFileTypes: true })) {
      if (!file.isFile()) continue;
      if (!ENTRYPOINT_EXTENSIONS.some((ext) => file.name.endsWith(ext))) continue;
      if (IS_TEST_FILE.test(file.name)) continue;
      const rel = `${slug.name}/${file.name}`;
      if (!readFileSync(resolve(EXAMPLES, rel), 'utf8').includes(marker)) continue;
      found.push(rel);
    }
  }
  return found.sort();
}

/**
 * Every BOOT ENTRYPOINT under examples/ — READ OFF THE FILESYSTEM BY ROLE, never typed out and never
 * globbed by filename, so an example added later cannot escape a list nobody updated (or, as happened
 * with `local-boot/serve.ts`, a glob nobody widened).
 *
 * THE EXACT BOUND, because a claim wider than its mechanism is what this whole suite is about: this
 * holds every non-test source file directly under `examples/<slug>/` that names `@rayspec/server`.
 * A future wrapper that boots WITHOUT reaching for that package at all is outside the rule and would
 * still need this file changed — that case is not covered and is not claimed to be. What IS closed is
 * the failure that actually happened: an entrypoint written in a different file name, or a different
 * language, or calling a different function, is now discovered rather than skipped.
 */
const WRAPPERS = discoverBy(PACKAGE_MARKER);
/** The narrower set, cross-checked against the one above so neither marker can drift alone. */
const ASSEMBLE_SET = discoverBy(ASSEMBLE_MARKER);

/** The entrypoint arm (a) boots: the only one whose boot demands no model-provider key. */
const BOOTABLE_REL = 'support-ticket-triage/dev-boot.mjs';
/**
 * The TypeScript entrypoint the old `dev-boot.mjs` glob missed entirely. Named in the floor below so a
 * rule that quietly stopped matching a `.ts` entrypoint is RED rather than merely narrower — the exact
 * failure this widening exists to close.
 */
const TS_ENTRYPOINT_REL = 'local-boot/serve.ts';
const BOOTABLE_WRAPPER = resolve(EXAMPLES, BOOTABLE_REL);

/**
 * The four markers arm (b) POSITIONS (as opposed to the ones it merely requires to be present).
 *
 * Each must begin with an identifier or keyword and carry no comment or template delimiter — that
 * is the precondition which makes testing where a match BEGINS sufficient, and it is asserted
 * mechanically at the bottom of this file rather than left as a claim in prose.
 */
const SIGINT_REGISTRATION = "process.on('SIGINT', () => phase.handle('SIGINT'));";
const SIGTERM_REGISTRATION = "process.on('SIGTERM', () => phase.handle('SIGTERM'));";
const ORDERING_ANCHOR = 'const server = await';
const SIGTERM_CALL = "process.on('SIGTERM'";
const POSITIONED_MARKERS: Readonly<Record<string, string>> = {
  SIGINT_REGISTRATION,
  SIGTERM_REGISTRATION,
  ORDERING_ANCHOR,
  SIGTERM_CALL,
};

const SUBSTITUTION_REFUSAL =
  'THE REGISTRATION IS PRESENT BUT IT IS NOT CODE — it sits inside a comment or a string literal. ' +
  'That is defeat by SUBSTITUTION: comment the statement out, leave its text behind to satisfy ' +
  'this scan, and put the real registration somewhere this file would have refused. The property ' +
  'here is a STATEMENT and its position, never a string that spells one.';

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

  /**
   * The floor above is a static `>= 4`, which a future entrypoint cannot raise on its own — so the
   * two markers are checked AGAINST EACH OTHER instead of trusting either alone. A file that reaches
   * for `@rayspec/server` but never calls `assembleServer` is a boot path this suite's shape
   * assertions were not written for: it must be NAMED here, not silently held or silently skipped.
   */
  it('the two discovery markers agree — neither can drift alone', () => {
    expect(ASSEMBLE_SET).toEqual(WRAPPERS);
    // …and neither set is empty, which is the reading a broken rule also produces.
    expect(WRAPPERS.length).toBeGreaterThan(0);
  });

  for (const wrapper of WRAPPERS) {
    it(`${wrapper} closes the http server, awaits server.close() and exits 0`, () => {
      const src = readFileSync(resolve(EXAMPLES, wrapper), 'utf8');
      // The entrypoints are a MIX of `.mjs` and `.ts`, so hand the parser the dialect the file is
      // actually written in rather than hoping TS-mode is close enough on JavaScript.
      const isCode = codeMask(src, /\.m?ts$/.test(wrapper) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
      /** The first occurrence of `marker` that is real CODE, or -1. */
      const codeIndexOf = (marker: string): number => {
        for (let at = src.indexOf(marker); at > -1; at = src.indexOf(marker, at + 1)) {
          if (isCode(at)) return at;
        }
        return -1;
      };
      /** How many occurrences of `marker` are real code rather than comment or literal text. */
      const codeCountOf = (marker: string): number => {
        let count = 0;
        for (let at = src.indexOf(marker); at > -1; at = src.indexOf(marker, at + 1)) {
          if (isCode(at)) count += 1;
        }
        return count;
      };

      expect(src).toContain(SIGINT_REGISTRATION);
      expect(src).toContain(SIGTERM_REGISTRATION);
      // …AND EACH REGISTRATION MUST BE CODE, not merely text. `toContain` is satisfied just as
      // well by the same line COMMENTED OUT, and that is not a hypothetical: measured on this file
      // 2026-08-19, commenting the SIGTERM registration out with its text intact and re-registering
      // the real handler BELOW the boot read **9/9 GREEN** — the boot window this suite exists to
      // close, wide open, with every arm passing. Arm (a) cannot see it either: it boots fully
      // before it signals, so the ordering is pinned HERE and nowhere else.
      expect(codeIndexOf(SIGINT_REGISTRATION), SUBSTITUTION_REFUSAL).toBeGreaterThan(-1);
      expect(codeIndexOf(SIGTERM_REGISTRATION), SUBSTITUTION_REFUSAL).toBeGreaterThan(-1);
      // The registration must come BEFORE the boot, not after it — that is the whole point of the
      // `phase` indirection, and the ordering is the property, so assert the ordering.
      //
      // Anchored on `const server = await`, which every entrypoint writes, rather than on
      // `await assembleServer(`: `local-boot/serve.ts` wraps the call as
      // `await withBootTimeout(assembleServer(…), …)`, so the old anchor was ABSENT there and
      // `indexOf` returned -1 — an ordering assertion that fails for the wrong reason. Anchoring on
      // the bare `assembleServer(` instead would be worse: contract-intake and support-intake-chat
      // both print it inside a header COMMENT above their registration, which would invert the test.
      //
      // That comment describes the INCIDENTAL FALSE-RED hazard (a mention accidentally satisfying
      // an anchor). The deliberate FALSE-GREEN one is a different failure and needs a different
      // answer, which is the code-position pair below: the raw assertions stay exactly as they
      // were, and the same ordering is required a second time over CODE ONLY, so neither end of it
      // can be satisfied by a comment.
      const assembleAt = src.indexOf(ORDERING_ANCHOR);
      expect(
        assembleAt,
        'no `const server = await …` — the ordering anchor is gone',
      ).toBeGreaterThan(-1);
      expect(src.indexOf(SIGTERM_CALL)).toBeLessThan(assembleAt);

      const assembleCodeAt = codeIndexOf(ORDERING_ANCHOR);
      expect(
        assembleCodeAt,
        'no `const server = await …` IN CODE — the ordering anchor survives only as comment or ' +
          'string text, so the position this arm pins is the position of prose, not of a boot',
      ).toBeGreaterThan(-1);
      expect(
        codeIndexOf(SIGTERM_CALL),
        'THE SIGTERM REGISTRATION IS NOT CODE — it is present only as comment or string text. ' +
          'Comment the registration out, leave its text to satisfy the assertions above, and ' +
          'register the real handler anywhere else: the wrapper is unkillable for the whole boot ' +
          'window again and every other arm here still passes.',
      ).toBeGreaterThan(-1);
      expect(
        codeIndexOf(SIGTERM_CALL),
        'THE SIGTERM REGISTRATION MOVED BELOW THE BOOT. Between module evaluation and that line ' +
          'the signal is a no-op — @openai/agents-core and signal-exit each act only when they are ' +
          'the sole listener, so with both loaded they defer to each other — and a wrapper killed ' +
          'mid-boot hangs until SIGKILL. Registration goes before the first awaited step.',
      ).toBeLessThan(assembleCodeAt);
      // …and the graceful close REPLACES the boot-phase abort rather than adding a second pair.
      // Matched by regex, not substring: the TypeScript entrypoint annotates the same assignment as
      // `phase.handle = (signal: string): void => {`.
      expect(src).toMatch(/phase\.handle = \(signal(?:: string)?\)(?:: void)? => \{/);
      expect(src.match(/process\.on\('SIGTERM'/g) ?? []).toHaveLength(1);
      // EXACTLY ONE LIVE registration, counted over code. The raw count above already refuses a
      // second one; this refuses the reading where the ONLY one left is commented out.
      expect(
        codeCountOf(SIGTERM_CALL),
        "there must be exactly ONE live `process.on('SIGTERM'` registration in this entrypoint",
      ).toBe(1);
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE MASKER'S OWN BATTERY. `maskedSpans` is now a load-bearing instrument, so it is tested like
// one. The `code: false` rows are the attack; the `code: true` rows are the controls that a
// masker which simply strips too much would fail — a stripper that ate real code would satisfy
// every attack row and still be wrong, and the wrongness would show up as a guard reddening for
// a reason that has nothing to do with the engine.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const M = 'gate(tx, id);';

interface MaskCase {
  readonly name: string;
  readonly source: string;
  /** Which occurrence of `M` to test — default the first. */
  readonly nth?: number;
  /** Whether that occurrence must be judged a real code position. */
  readonly code: boolean;
}

const MASK_BATTERY: readonly MaskCase[] = [
  // ── The attack surface: a marker that is present as TEXT and must not count as code. ────────
  { name: 'inside a // comment', source: `const a = 1;\n// ${M}\n`, code: false },
  { name: 'inside a /* */ block comment', source: `const a = 1;\n/*\n  ${M}\n*/\n`, code: false },
  { name: 'inside a single-quoted string', source: `const s = '${M}';\n`, code: false },
  { name: 'inside a double-quoted string', source: `const s = "${M}";\n`, code: false },
  { name: 'inside a template literal', source: `const s = \`${M}\`;\n`, code: false },
  {
    name: 'inside a template literal that itself contains /* */',
    source: `const s = \`/* ${M} */\`;\n`,
    code: false,
  },
  {
    name: 'inside a comment that is leading trivia of a bare } (the S2 shape, unreachable from the AST)',
    source: `function f() {\n  real();\n  // ${M}\n}\n`,
    code: false,
  },
  {
    name: 'inside a JSDoc block above a declaration',
    source: `/**\n * ${M}\n */\nconst a = 1;\n`,
    code: false,
  },

  // ── The controls: real code that a too-eager stripper would swallow. ────────────────────────
  { name: 'plain executable code (positive control)', source: `${M}\n`, code: true },
  {
    name: 'after a string containing // — on the SAME line, where a comment-first pass eats it',
    source: `const u = 'https://example.com/a'; ${M}\n`,
    code: true,
  },
  {
    name: 'between a template opening /* and a later template closing */',
    source: `const t = \`/* open\`;\n${M}\nconst u = \`close */\`;\n`,
    code: true,
  },
  {
    name: 'after a division whose slashes a regex-guessing stripper would pair with a later /',
    source: `const ratio = a / b;\n${M}\nconst label = 'x/y';\n`,
    code: true,
  },
  {
    name: 'after a regex literal containing both quote kinds',
    source: `const re = /['"]/;\n${M}\n`,
    code: true,
  },
  {
    name: 'after a regex literal containing //',
    source: `const re = /\\/\\//;\n${M}\n`,
    code: true,
  },
  {
    name: "after a comment containing an apostrophe (don't)",
    source: `// don't stop scanning here\nconst a = 1;\n${M}\n`,
    code: true,
  },
  {
    name: 'after a string containing an escaped quote',
    source: `const s = 'it\\'s';\n${M}\n`,
    code: true,
  },
  { name: 'after a string containing /*', source: `const s = '/*';\n${M}\n`, code: true },
  {
    name: 'after a template with an interpolated string expression',
    source: `const t = \`x\${'y'}z\`;\n${M}\n`,
    code: true,
  },

  // ── Both at once: the comment copy is text, the live copy is code. ──────────────────────────
  {
    name: 'present in BOTH a comment and code — the comment copy',
    source: `// ${M}\n${M}\n`,
    nth: 0,
    code: false,
  },
  {
    name: 'present in BOTH a comment and code — the live copy',
    source: `// ${M}\n${M}\n`,
    nth: 1,
    code: true,
  },
];

describe('maskedSpans — the adversarial battery for the instrument itself', () => {
  for (const testCase of MASK_BATTERY) {
    it(`${testCase.name} -> ${testCase.code ? 'CODE' : 'not code'}`, () => {
      let at = -1;
      for (let seen = 0; seen <= (testCase.nth ?? 0); seen += 1) {
        at = testCase.source.indexOf(M, at + 1);
      }
      expect(at, 'the battery case must really contain the marker it claims to').toBeGreaterThan(
        -1,
      );
      expect(codeMask(testCase.source)(at)).toBe(testCase.code);
    });
  }

  it('is not degenerate — the battery contains BOTH verdicts, so a constant masker cannot pass', () => {
    expect(MASK_BATTERY.some((c) => c.code)).toBe(true);
    expect(MASK_BATTERY.some((c) => !c.code)).toBe(true);
  });

  it('every POSITIONED marker in this file is delimiter-free, which is what makes a START-position test enough', () => {
    // The code-position test asks only where a match BEGINS. That is sufficient precisely because
    // no marker can begin in code and continue into a comment: to do so the marker would have to
    // contain the delimiter that opens one. Markers may legitimately reach INTO string literals,
    // which is why the test is not "must not overlap".
    for (const [name, marker] of Object.entries(POSITIONED_MARKERS)) {
      expect(marker.includes('//'), `${name} must not contain a line-comment delimiter`).toBe(
        false,
      );
      expect(marker.includes('/*'), `${name} must not contain a block-comment delimiter`).toBe(
        false,
      );
      expect(marker.includes('`'), `${name} must not contain a template delimiter`).toBe(false);
      expect(/^[A-Za-z_$]/.test(marker), `${name} must begin with an identifier or keyword`).toBe(
        true,
      );
    }
  });
});

/**
 * THE MASKER IS COPIED INTO EVERY SCAN THAT NEEDS IT, SO THE COPIES ARE PINNED HERE.
 *
 * The scans live in different packages and there is no shared test-utility package between them, so
 * the block above is duplicated rather than imported. Duplication without enforcement is how a
 * load-bearing instrument rots in one place and nobody notices, so this arm DISCOVERS the copies on
 * disk by their sentinel — it is not a hand-maintained list, and a fifth copy added tomorrow is
 * covered the day it lands. The floor (`>= 4`) is what makes a sentinel rename red rather than
 * vacuously green: a rule that finds nothing must not read as a rule that found no drift.
 */
const MASKER_OPEN = '// [SOURCE-MASKER v2 BEGIN]';
const MASKER_CLOSE = '// [SOURCE-MASKER v2 END]';

/** Every `*.test.ts` under `packages/` that carries the masker block, with the block itself. */
function maskerCopies(): ReadonlyArray<{ readonly file: string; readonly block: string }> {
  const packagesRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
  const found: Array<{ file: string; block: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.test.ts')) continue;
      const text = readFileSync(full, 'utf8');
      // The FIRST sentinel pair is the real block: the constants above sit below it in every copy.
      const open = text.indexOf(MASKER_OPEN);
      if (open < 0) continue;
      const close = text.indexOf(MASKER_CLOSE, open);
      expect(close, `${full} opens the masker block and never closes it`).toBeGreaterThan(open);
      found.push({ file: full.slice(packagesRoot.length + 1), block: text.slice(open, close) });
    }
  };
  walk(packagesRoot);
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

describe('the source masker — every copy of it, byte-identical', () => {
  it('is carried by at least the four scans that need it, and this file is one of them', () => {
    const copies = maskerCopies();
    expect(
      copies.length,
      'the masker sentinel found fewer copies than the scans that carry it — a rename that hides ' +
        'the block would otherwise make this arm vacuously green',
    ).toBeGreaterThanOrEqual(4);
    const self = fileURLToPath(import.meta.url);
    expect(
      copies.some((copy) => self.endsWith(copy.file)),
      'the discovery did not find THIS file, so it is not actually scanning where it thinks',
    ).toBe(true);
  });

  it('has not drifted — all copies are byte-identical', () => {
    const copies = maskerCopies();
    const distinct = new Set(copies.map((copy) => copy.block));
    expect(
      distinct.size,
      'THE MASKER HAS DRIFTED ACROSS ITS COPIES. It is duplicated because the scans live in ' +
        'packages with no shared test-utility package between them; that is only safe while the ' +
        `copies are identical. Copies found: ${copies.map((copy) => copy.file).join(', ')}`,
    ).toBe(1);
  });
});
