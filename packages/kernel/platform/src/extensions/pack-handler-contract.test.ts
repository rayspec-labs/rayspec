/**
 * THE PACK HANDLER CONTRACT, measured with the compiler rather than argued about.
 *
 * `pack-sdk-interop.ts` pins the correspondence between the init this platform BUILDS and the type
 * `@rayspec/pack-sdk` tells a pack author to annotate against. A pin is only worth what its accept
 * control proves: an assertion nobody ever watched go red is indistinguishable from a comment. So
 * this suite compiles throwaway modules with the REAL `tsc`, against the REAL built declarations, and
 * measures three things:
 *
 *   (A) A MODULE WRITTEN AGAINST THE PACK SURFACE ALONE COMPILES. It imports `@rayspec/pack-sdk` and
 *       nothing else — the whole of what a pack's handler module needs for the kinds this package
 *       contracts — and annotates all of them: a tool handler, a route handler that returns a JSON
 *       body, and a route handler that READS THE RUN JOURNAL back and answers INCREMENTALLY, resuming
 *       from the client's last-seen position. (A pack's ENTRY imports `@rayspec/platform`, and a
 *       stream handler imports `@rayspec/handler-sdk`; neither is what this arm measures.)
 *   (B) THE PIN IS LOAD-BEARING. The same assertion the interop module makes goes RED when the
 *       platform's real init LOSES a member the contract promises. The undegraded template is the
 *       accept control for this arm: it compiles clean in the same instrument, so a red here is the
 *       degradation and not a broken fixture.
 *   (C) WHAT THE CONTRACT WITHHOLDS IS ACTUALLY WITHHELD. A pack module that reaches for a capability
 *       the contract does not carry fails to compile, so the docblock's refusals are checkable rather
 *       than merely written down.
 *
 * NO DATABASE and no boot: `tsc --noEmit` over a scratch directory is the whole instrument. The
 * scratch sits at the PACKAGE root (never under `src/`, which `tsc -b` globs) so a concurrent build
 * of this package cannot see a half-written file, and it is removed on every path.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(here, '../..'); // packages/kernel/platform
const REPO_ROOT = resolve(PACKAGE_ROOT, '../../..');
const TSC = join(REPO_ROOT, 'node_modules/typescript/bin/tsc');

/**
 * Compile `sources` in a throwaway directory beside this package's `node_modules`, under the SAME
 * compiler options the platform source is built with (NodeNext + `verbatimModuleSyntax` +
 * `noUncheckedIndexedAccess` — the real conditions a pack author's build runs under). Returns whether
 * `tsc` accepted it plus everything it printed, so a red arm can be read rather than merely counted.
 */
function typecheck(sources: Readonly<Record<string, string>>): { ok: boolean; output: string } {
  const scratch = mkdtempSync(join(PACKAGE_ROOT, '.pack-contract-'));
  try {
    for (const [name, src] of Object.entries(sources)) writeFileSync(join(scratch, name), src);
    const tsconfig = join(scratch, 'tsconfig.json');
    writeFileSync(
      tsconfig,
      JSON.stringify({
        extends: '../../../../tsconfig.base.json',
        compilerOptions: { noEmit: true, composite: false, rootDir: '.', types: ['node'] },
        include: ['*.ts'],
      }),
    );
    try {
      execFileSync('node', [TSC, '-p', tsconfig], { cwd: REPO_ROOT, stdio: 'pipe' });
      return { ok: true, output: '' };
    } catch (err) {
      const e = err as { stdout?: Buffer; stderr?: Buffer };
      return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * (A) A pack's handler module, written the way a pack in its OWN repository has to write one: ONE
 * import, `@rayspec/pack-sdk`, for both handler kinds. It reads the members the contract promises —
 * the server-derived tenant, the name-keyed store door, the route's bound parameters — so a member
 * that quietly left the contract takes this arm down with it.
 */
const PACK_HANDLER_MODULE = `
import type {
  PackRouteHandler,
  PackRouteResponse,
  PackToolHandler,
} from '@rayspec/pack-sdk';

interface TurnArgs {
  readonly turnId: string;
}
interface TurnView {
  readonly turnId: string;
  readonly tenantId: string;
  readonly seen: number;
}

export const summarizeTurn: PackToolHandler<TurnArgs, TurnView> = async (args, init) => {
  const rows = await init.db.select('pack_turns', { turn_id: args.turnId }, { limit: 1 });
  return { turnId: args.turnId, tenantId: init.tenantId, seen: rows.length };
};

export const listTurns: PackRouteHandler<TurnView> = async (init) => {
  const turnId = init.params.turn_id ?? '';
  const rows = await init.db.select('pack_turns', { turn_id: turnId });
  return { turnId, tenantId: init.tenantId, seen: rows.length };
};

// The SECOND route shape: read the run journal back through the contracted reader and answer
// INCREMENTALLY, resuming from the position the deployment resolved. Every member it names —
// the reader, the page's cursor and \`hasMore\`, the response constructor, the resume cursor — is
// one this package promises, so a member that quietly left the contract takes this arm down.
export const replayJournal: PackRouteHandler<PackRouteResponse> = async (init) => {
  const journal = init.journal;
  const respond = init.sseResponse;
  if (!journal || !respond) throw new Error('this deployment carries neither door');
  const page = await journal.read({
    runId: init.params.run_id ?? '',
    limit: 2,
    ...(init.resumeFrom !== undefined ? { after: init.resumeFrom } : {}),
  });
  return respond(async (emit, signal) => {
    for (const entry of page.entries) {
      if (signal.aborted) return;
      await emit({ id: entry.cursor, event: 'journal_step', data: JSON.stringify(entry.output) });
    }
    await emit({ event: 'journal_end', data: JSON.stringify({ more: page.hasMore }) });
  });
};
`;

/**
 * (B) The interop pin, parameterized by the platform-side init each arm asserts about. Substituting
 * the real init is the ACCEPT CONTROL; substituting one with a member removed is the degradation the
 * pin exists to catch.
 */
/**
 * The path to the SHIPPED interop module. The pins below are not a copy of it — they are LIFTED OUT
 * OF IT at test time (see `shippedArm`), which is the whole point of this file naming it.
 */
const INTEROP_MODULE = resolve(PACKAGE_ROOT, 'src/extensions/pack-sdk-interop.ts');

/** The arms this suite degrades, by the names they carry in the shipped module. */
const PINNED_ARMS = [
  '_RouteInitFitsWhatAPackAnnotates',
  '_ToolInitFitsWhatAPackAnnotates',
  '_JournalReaderFitsWhatAPackAnnotates',
  '_SseResponderFitsWhatAPackAnnotates',
  '_ResumeCursorFitsWhatAPackAnnotates',
  '_AServiceJournalDoorIsBuiltHere',
  '_AWriteStepAPackBuildsIsAcceptedHere',
] as const;

/**
 * Lift ONE `type _Name = Assert<…>;` declaration out of the shipped interop module, verbatim.
 *
 * WHY THIS READS THE FILE INSTEAD OF RESTATING IT. The obvious way to write this suite is to keep a
 * copy of the pins in a template string and degrade the copy. That version passed for a while and
 * measured the wrong artifact: the copy had already drifted from the shipped module (its write arm
 * tested a different thing entirely), so every arm here was green about assertions the repository
 * does not ship, and an edit to `pack-sdk-interop.ts` could not have turned a single one red. A test
 * that cannot notice the file it is about has changed is a gate that scans nothing.
 *
 * Reading the real declarations removes the copy rather than checking it. What this suite supplies is
 * only the IMPORT HEADER — the scratch project cannot resolve the platform's relative imports — and
 * the substitution that degrades one platform type. The assertions themselves are the shipped bytes.
 *
 * FAIL-CLOSED, because the failure mode of an extractor is silence: a renamed or deleted arm throws
 * here rather than yielding an empty module that would compile clean and prove nothing.
 */
function shippedArm(source: string, name: string): string {
  const decl = `type ${name} = Assert<`;
  const start = source.indexOf(decl);
  if (start === -1) {
    throw new Error(
      `pack-handler-contract: no arm named '${name}' in pack-sdk-interop.ts. It was renamed or ` +
        'removed — refusing to compile a pin module that would measure nothing.',
    );
  }
  let depth = 0;
  let i = start + decl.length - 1; // sits on the '<' of `Assert<`
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '<') depth += 1;
    else if (ch === '>') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) {
    throw new Error(`pack-handler-contract: arm '${name}' has unbalanced angle brackets.`);
  }
  return `${source.slice(start, i + 1)};`;
}

/**
 * The import header the lifted arms compile against. The names match the shipped module's own
 * imports, INCLUDING its `PackSdk*` aliases, because the lifted text spells them. The `Platform*`
 * aliases exist for the degradations: a substitution that replaced `RouteHandlerInit` with an
 * expression naming `RouteHandlerInit` would be circular, so the degraded forms name the alias.
 */
const PIN_HEADER = `
import type { RouteHandlerInit, ToolHandlerInit } from '@rayspec/handler-sdk';
import type { PackServiceContext, PackServiceJournalStep } from '@rayspec/platform';
import type {
  PackJournalReader as PackSdkJournalReader,
  PackJournalStep as PackSdkJournalStep,
  PackRouteHandlerInit as PackSdkRouteHandlerInit,
  PackServiceContext as PackSdkServiceContext,
  PackToolHandlerInit as PackSdkToolHandlerInit,
} from '@rayspec/pack-sdk';

type Assert<_T extends true> = true;

// The degradation aliases. A substitution replacing RouteHandlerInit with an expression that itself
// named RouteHandlerInit would be circular, so the degraded forms name these instead.
type PlatformRouteInit = RouteHandlerInit;
type PlatformToolInit = ToolHandlerInit;
type PlatformServiceContext = PackServiceContext;
type PlatformServiceStep = PackServiceJournalStep;
// Touched so noUnusedLocals — which this scratch project keeps, because it compiles under the SAME
// options the platform source does — does not strip them on the undegraded accept control.
type _DegradationAliases = [
  PlatformRouteInit,
  PlatformToolInit,
  PlatformServiceContext,
  PlatformServiceStep,
];
export type DegradationAliases = _DegradationAliases;
`;

/**
 * Build a compilable module out of the SHIPPED arms, optionally degrading one platform type first.
 * `substitutions` maps a whole identifier in the lifted text to the expression that replaces it.
 */
function pinModule(substitutions: Readonly<Record<string, string>> = {}): string {
  const source = readFileSync(INTEROP_MODULE, 'utf8');
  const arms = PINNED_ARMS.map((name) => shippedArm(source, name));
  let body = arms.join('\n');
  for (const [identifier, replacement] of Object.entries(substitutions)) {
    const before = body;
    body = body.replace(new RegExp(`\\b${identifier}\\b`, 'g'), replacement);
    if (body === before) {
      throw new Error(
        `pack-handler-contract: '${identifier}' does not occur in the lifted arms, so degrading it ` +
          'would measure nothing. The shipped arm stopped naming it.',
      );
    }
  }
  const tuple = PINNED_ARMS.join(',\n  ');
  const values = PINNED_ARMS.map(() => 'true').join(', ');
  return `${PIN_HEADER}\n${body}\n\nexport const pins: [\n  ${tuple},\n] = [${values}];\n`;
}

describe('the handler contract @rayspec/pack-sdk carries', () => {
  it('(A) a module written against the pack surface ALONE compiles — both handler kinds', () => {
    const { ok, output } = typecheck({ 'handlers.ts': PACK_HANDLER_MODULE });
    expect(output).toBe('');
    expect(ok).toBe(true);
  });

  it('(B accept control) the SHIPPED arms hold against the platform’s REAL types', () => {
    const { ok, output } = typecheck({
      'pin.ts': pinModule(),
    });
    expect(output).toBe('');
    expect(ok).toBe(true);
  });

  it('(B) the shipped arms go RED when the route init loses a member the contract promises', () => {
    const { ok, output } = typecheck({
      'pin.ts': pinModule({ RouteHandlerInit: `Omit<PlatformRouteInit, 'params'>` }),
    });
    expect(ok).toBe(false);
    expect(output).toContain('TS2344');
    expect(output).toContain(`does not satisfy the constraint 'true'`);
  });

  it('(B) …and when the tool init loses the store door', () => {
    const { ok, output } = typecheck({
      'pin.ts': pinModule({ ToolHandlerInit: `Omit<PlatformToolInit, 'db'>` }),
    });
    expect(ok).toBe(false);
    expect(output).toContain('TS2344');
    expect(output).toContain(`does not satisfy the constraint 'true'`);
  });

  // The three OPTIONAL members the route init added. Each arm removes exactly one from the
  // PLATFORM's init and demands a red, which is what makes them a contract rather than a docblock:
  // an optional member is the case a plain assignability pin cannot see, so if any of these three
  // ever passed, the corresponding door could leave this repository and only a pack author would
  // find out. The accept control above is the same instrument on the undegraded init.
  it.each([
    ['journal', 'the journal read door'],
    ['sseResponse', 'the incremental-response constructor'],
    ['resumeFrom', 'the resume cursor'],
  ])('(B) …and when the route init loses %s (%s)', (member) => {
    const { ok, output } = typecheck({
      'pin.ts': pinModule({ RouteHandlerInit: `Omit<PlatformRouteInit, '${member}'>` }),
    });
    expect(ok).toBe(false);
    // TS2339: the index names a property the degraded init no longer has — the failure is AT the
    // pin, naming the member, rather than a generic "does not satisfy" three types away from it.
    expect(output).toContain('TS2339');
    expect(output).toContain(member);
  });

  /**
   * (B) THE SERVICE HALF. A service is the surface that WRITES journal steps, so it is the surface
   * with something to read back — and the first shape of this contract handed the reader to routes
   * alone, which left a service writing entries it could not read and reaching for the escape hatch
   * to do it. Degrading the platform's own service journal door proves the arm that would have caught
   * that is load-bearing: losing `read` is a red, and so is losing `record`.
   */
  it('(B) …and when the service journal door loses its READ half', () => {
    const { ok, output } = typecheck({
      'pin.ts': pinModule({
        PackServiceContext: `{ journal?: Omit<NonNullable<PlatformServiceContext['journal']>, 'read'> }`,
      }),
    });
    expect(ok).toBe(false);
    expect(output).toContain('TS2339');
    expect(output).toContain('read');
  });

  /**
   * The WRITE half, degraded the way it actually breaks a pack author: ONE new REQUIRED member on the
   * platform's journal STEP, which stops `ctx.journal.record({…})` compiling in their repository.
   *
   * This is the degradation a signature test cannot see. `record` is method-declared on both sides,
   * so its parameter is compared BIVARIANTLY — a test of the form `['record'] extends (step: never)
   * => Promise<void>` passes for any one-argument shape, `never` being assignable to everything. The
   * shipped arm compares the STEP TYPES directly for exactly this case.
   */
  it('(B) …and when the platform’s journal step gains a required member', () => {
    const { ok, output } = typecheck({
      'pin.ts': pinModule({
        PackServiceJournalStep: `PlatformServiceStep & { readonly driftRequiredMember: string }`,
      }),
    });
    expect(ok).toBe(false);
    expect(output).toContain('TS2344');
    expect(output).toContain(`does not satisfy the constraint 'true'`);
  });

  it('(C) a pack handler cannot reach a capability the contract withholds', () => {
    const { ok, output } = typecheck({
      'reach.ts': `
import type { PackRouteHandler } from '@rayspec/pack-sdk';

export const enqueueFromARoute: PackRouteHandler<{ readonly ok: true }> = async (init) => {
  await init.enqueue({ agentId: 'an-agent', input: 'a task' });
  return { ok: true };
};
`,
    });
    expect(ok).toBe(false);
    expect(output).toContain('TS2339');
    expect(output).toContain('enqueue');
  });
});
