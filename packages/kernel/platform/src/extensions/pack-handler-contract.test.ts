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
 *       contracts — and annotates both of them: a tool handler and a route handler. (A pack's ENTRY
 *       imports `@rayspec/platform`, and a stream handler imports `@rayspec/handler-sdk`; neither is
 *       what this arm measures.)
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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import type { PackRouteHandler, PackToolHandler } from '@rayspec/pack-sdk';

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
`;

/**
 * (B) The interop pin, parameterized by the platform-side init each arm asserts about. Substituting
 * the real init is the ACCEPT CONTROL; substituting one with a member removed is the degradation the
 * pin exists to catch.
 */
const pinModule = (routeInit: string, toolInit: string): string => `
import type { RouteHandlerInit, ToolHandlerInit } from '@rayspec/handler-sdk';
import type { PackRouteHandlerInit, PackToolHandlerInit } from '@rayspec/pack-sdk';

type Assert<_T extends true> = true;

type _RouteInitFits = Assert<${routeInit} extends PackRouteHandlerInit ? true : false>;
type _ToolInitFits = Assert<${toolInit} extends PackToolHandlerInit ? true : false>;

export const pins: [_RouteInitFits, _ToolInitFits] = [true, true];
`;

describe('the handler contract @rayspec/pack-sdk carries', () => {
  it('(A) a module written against the pack surface ALONE compiles — both handler kinds', () => {
    const { ok, output } = typecheck({ 'handlers.ts': PACK_HANDLER_MODULE });
    expect(output).toBe('');
    expect(ok).toBe(true);
  });

  it('(B accept control) the pin holds against the platform’s REAL route and tool inits', () => {
    const { ok, output } = typecheck({
      'pin.ts': pinModule('RouteHandlerInit', 'ToolHandlerInit'),
    });
    expect(output).toBe('');
    expect(ok).toBe(true);
  });

  it('(B) the pin goes RED when the route init loses a member the contract promises', () => {
    const { ok, output } = typecheck({
      'pin.ts': pinModule(`Omit<RouteHandlerInit, 'params'>`, 'ToolHandlerInit'),
    });
    expect(ok).toBe(false);
    expect(output).toContain('TS2344');
    expect(output).toContain(`does not satisfy the constraint 'true'`);
  });

  it('(B) …and when the tool init loses the store door', () => {
    const { ok, output } = typecheck({
      'pin.ts': pinModule('RouteHandlerInit', `Omit<ToolHandlerInit, 'db'>`),
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
