/**
 * The pack's second SERVICE — the one that DOES hold `TurnDispatch`.
 *
 * This module exists so the capability contract has something real on both sides of it. Its sibling
 * `audit-ledger.ts` never names the capability; this one names it in an import clause, and which
 * module holds it is the load-bearing fact — pinned on this shipped source by
 * `@rayspec/server`'s `pack-service-dispatch.test.ts`, arm (A).
 *
 * NOT BY THE CI GATE. `scripts/check-contribution-dispatch-boundary.mjs` scans the contribution roots
 * it DECLARES, all of which are under `examples/`; it does not read this package at all, so it is a
 * witness neither for nor against this module's placement. What the gate proves — that a module
 * reachable from a pack's `handlers/` subtree may not name the capability, and that a folder named
 * `services` nested inside `handlers/` buys no exemption — it proves over those roots and over its own
 * synthetic self-test trees.
 *
 * WHAT IT DOES WITH IT. It schedules one durable agent turn, and it does so with NO tenant argument,
 * because there is none to give: the deployment bound the tenant when it built the capability. Two
 * conditions have to hold first, and both are read off the context rather than assumed — the
 * deployment must have handed over a capability at all (one with no durable worker hands over none),
 * and the merged document must DECLARE the agent this service would run. Either one missing is
 * recorded and nothing is scheduled: an absent capability is a fail-closed answer to read, not a
 * silent no-op to paper over, and scheduling an undeclared agent is refused by the platform anyway.
 */
import type { PackServiceContext, PackServiceModule, TurnDispatch } from '@rayspec/pack-sdk';
import { contexts, ENV_MARKER_KEY, record, specName } from './observed.js';

/** The agent id this service schedules a turn for when the deployment gives it a way to. */
const FOLLOW_UP_AGENT = 'fixture_follow_up';

/** The capability the deployment handed over, held for the life of the service (absent ⇒ none). */
let dispatch: TurnDispatch | undefined;

/** The runIds this service scheduled, newest last — read back by the tests that drive it. */
export const scheduled: string[] = [];

const turnScheduler: PackServiceModule = {
  name: 'turn-scheduler',

  async boot(ctx: PackServiceContext): Promise<void> {
    record('turn-scheduler:boot');
    dispatch = ctx.dispatch;
    const marker = ctx.env[ENV_MARKER_KEY];
    contexts.set(turnScheduler.name, {
      sectionKeys: Object.keys(ctx.sections),
      ...(specName(ctx.spec) !== undefined ? { specName: specName(ctx.spec) } : {}),
      ...(marker !== undefined ? { envMarker: marker } : {}),
      journal: ctx.journal !== undefined,
      dispatch: ctx.dispatch !== undefined,
    });
    if (dispatch === undefined || !declaresFollowUpAgent(ctx.spec)) return;
    // No tenant is named here, and none can be: the request object has no such field. The turn runs
    // under the tenant the deployment bound when it built the capability.
    const { runId } = await dispatch.schedule({
      agentId: FOLLOW_UP_AGENT,
      input: 'reconcile the ledger',
    });
    scheduled.push(runId);
  },

  shutdown(): void {
    record('turn-scheduler:shutdown');
    dispatch = undefined;
  },
};

/**
 * Does the MERGED document declare the agent this service would run? The document is open on this
 * surface — a pack is given the deployment's validated document, not a copy of the platform's grammar
 * for it — so the read is defensive about shape and asks only the one question it has.
 */
function declaresFollowUpAgent(spec: Readonly<Record<string, unknown>>): boolean {
  const agents = spec.agents;
  return (
    Array.isArray(agents) &&
    agents.some((agent) => (agent as { id?: unknown } | null)?.id === FOLLOW_UP_AGENT)
  );
}

export default turnScheduler;
