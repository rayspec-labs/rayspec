/**
 * THE POSITIVE SIDE OF THE CONTRIBUTION-DISPATCH BOUNDARY, against the REAL fixture pack.
 *
 * `scripts/check-contribution-dispatch-boundary.mjs` proves the NEGATIVE: a module reachable from a
 * pack's `handlers/` subtree, or from a tooling contribution, that so much as names `TurnDispatch`
 * fails the build. A negative proved alone is worth very little — a boundary that forbids everything
 * passes it. So this suite measures the other half, on the pack the repository actually ships:
 *
 *   (A) THE HOLDER IS A SERVICE, AND IT IS THE ONE THAT NAMES THE CAPABILITY. The fixture pack's
 *       `services/turn-scheduler.ts` imports `TurnDispatch`; its sibling `services/audit-ledger.ts`
 *       does not. Both live BESIDE `handlers/`, which is why the gate leaves them alone — the
 *       exemption is structural, not a listed exception. Asserted on the SHIPPED SOURCE, so moving
 *       either module under `handlers/` reds the gate and moving the import reds this.
 *   (B) A SERVICE THAT HOLDS IT SCHEDULES A TURN. Booted with a context carrying the capability and a
 *       document that declares the agent, the service schedules one and gets a runId back.
 *   (C) AND WITHOUT IT, IT SCHEDULES NOTHING. Booted with no capability — the shape of a deployment
 *       that wired no durable worker — it records the absence and schedules nothing, rather than
 *       throwing or silently pretending. This is the accept control for (B): both arms run the same
 *       module, so (B) cannot be passing because the service schedules unconditionally.
 *
 * No database and no boot: the compiled fixture service is driven directly with a context this suite
 * builds, which is what makes the capability's presence the only variable between (B) and (C).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PackServiceContext } from '@rayspec/platform';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const PACK_ROOT = join(repoRoot, 'packages/test/fixture-pack');

/** The declared agent the fixture's dispatch-holding service schedules a turn for. */
const FOLLOW_UP_AGENT = 'fixture_follow_up';

/** The context a service is booted with, with only what these arms vary spelled out. */
function contextFor(over: Partial<PackServiceContext> = {}): PackServiceContext {
  return {
    packId: 'fixture-pack',
    db: { query: async () => [] },
    spec: { metadata: { name: 'fixture' }, agents: [{ id: FOLLOW_UP_AGENT }] },
    sections: {},
    env: {},
    ...over,
  };
}

describe('the fixture pack’s services — the positive side of the dispatch boundary', () => {
  it('(A) the SERVICE that holds TurnDispatch names it; the one beside it does not', () => {
    const holder = readFileSync(join(PACK_ROOT, 'src/services/turn-scheduler.ts'), 'utf8');
    const other = readFileSync(join(PACK_ROOT, 'src/services/audit-ledger.ts'), 'utf8');
    // The import CLAUSE is what the gate matches, so that is what is asserted here — not a mention in
    // a comment, which the gate strips before it reads anything (the sibling's header names the
    // capability in prose precisely to say it does not take one).
    const IMPORTS_DISPATCH = /\b(?:import|export)\b[^;]*\bTurnDispatch\b[^;]*\bfrom\b[^;]*;/;
    expect(holder).toMatch(IMPORTS_DISPATCH);
    expect(holder).toContain("from '@rayspec/pack-sdk'");
    expect(other).not.toMatch(IMPORTS_DISPATCH);
  });

  it('(B) booted WITH the capability, it schedules a durable turn and keeps the runId', async () => {
    const service = (await import(join(PACK_ROOT, 'dist/services/turn-scheduler.js'))) as {
      default: { name: string; boot(ctx: PackServiceContext): Promise<void>; shutdown(): void };
      scheduled: string[];
    };
    service.scheduled.length = 0;

    const asked: unknown[] = [];
    await service.default.boot(
      contextFor({
        dispatch: {
          schedule: async (request) => {
            asked.push(request);
            return { runId: 'run-from-the-platform' };
          },
        },
      }),
    );

    expect(service.scheduled).toEqual(['run-from-the-platform']);
    // The request carries no tenant, and there is nowhere on it to put one — the deployment bound the
    // tenant when it built the capability, which is what "enforced by core" means here.
    expect(asked).toEqual([{ agentId: FOLLOW_UP_AGENT, input: 'reconcile the ledger' }]);
    service.default.shutdown();
  });

  it('(C) ACCEPT CONTROL: booted WITHOUT it, the same service schedules nothing', async () => {
    const service = (await import(join(PACK_ROOT, 'dist/services/turn-scheduler.js'))) as {
      default: { name: string; boot(ctx: PackServiceContext): Promise<void>; shutdown(): void };
      scheduled: string[];
    };
    service.scheduled.length = 0;

    // No `dispatch` on the context — the shape of a deployment with no durable worker wired.
    await service.default.boot(contextFor());
    expect(service.scheduled).toEqual([]);
    service.default.shutdown();
  });
});
