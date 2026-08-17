/**
 * The pack ENTRY — the manifest a deployment's `extensions[]` reference resolves to.
 *
 * This pack exists to be LOADED, by the real loader, from a real deployment document, so that the
 * pack seams have something in the repository that exercises them end to end. It contributes no
 * store, no agent and no capability. It claims ONE top-level section, `auditing`, ships the module
 * that validates it, OWNS one platform table through a migration chain of its own — an append-only
 * ledger with hand-shaped indexes and a foreign key, which is exactly what a generated `stores` table
 * is not — brings TWO long-lived SERVICES, which is the one contribution kind the platform boots
 * rather than calls, and contributes TWO ROUTES and ONE TOOL, which are the kinds whose declarations
 * point at handler modules the pack itself has to write.
 *
 * WHY TWO ROUTES AND NOT ONE. A route handler may answer in two SHAPES, and a fixture that witnesses
 * only one leaves the other's auth, tenancy and rate limiting unmeasured. `handlers/list-turns`
 * returns a JSON body; `handlers/replay-journal` reads the run journal through the contracted reader
 * and answers INCREMENTALLY, resuming from the client's last-seen position. Both are declared as
 * ordinary `{kind:'handler'}` actions, so a suite can hold the two against each other and against a
 * deployment-declared route instead of taking "it inherits the chain" on trust.
 *
 * WHY TWO SERVICES AND NOT ONE. `TurnDispatch` goes to services and to nothing else, and a capability
 * measured only where it is present is measured with no control: `services/turn-scheduler.ts` holds it
 * and `services/audit-ledger.ts` never names it, so a suite that drives both can tell "the deployment
 * handed it over" apart from "a service gets one by being a service". The CI dispatch-boundary gate is
 * not involved — it scans the contribution roots it declares, all under `examples/`, and never reads
 * this package.
 *
 * WHY IT IS A NORMAL WORKSPACE MEMBER. The two example packs under the `examples/` tree are named
 * `@spike/...` so CI's `--filter='!@spike/*'` excludes them. That is right for a demo and wrong for a
 * fixture: a fixture that CI never builds cannot fail, and a seam whose only witness cannot fail is
 * unproven. This package is `@rayspec/*`, so the CI filters build and typecheck it like any other.
 *
 * WHY IT BUILDS. `loadExtensions` imports compiled JavaScript only, so a pack authored in TypeScript
 * has to be compiled before a deployment can reference it — `tsc -b` emits `src/` to `dist/`, and the
 * deployment documents beside this file point at that directory. The entry resolves
 * `@rayspec/platform` from this package's own `node_modules`, which is what a pack shipped from its
 * own repository does with a released version of the same package.
 */
import type { DefinedPack } from '@rayspec/pack-sdk';
import { defineExtension } from '@rayspec/platform';

/**
 * `DefinedPack` is the type an out-of-tree pack names for its entry's export — the promised surface,
 * not the platform internal that constructs the brand. Annotating with it here is what keeps the two
 * in step: a manifest the platform helper builds but this contract cannot describe fails the compiler
 * in this package, in CI, rather than in somebody else's repository.
 */
const fixturePack: DefinedPack = defineExtension({
  // The pack's OWN version. A deployment pins it EXACTLY; a skew is a hard load failure, never a
  // silent skip — which is why the documents beside this file pin `1.0.0` and one of them does not.
  version: '1.0.0',
  // TWO authenticated routes and ONE tool, and the handler modules behind them — the two contribution
  // kinds whose declarations point at code a pack has to WRITE, so both are declared here rather than
  // one standing in for the other. The two routes are the two SHAPES a route handler may answer with:
  // one returns a JSON body, the other reads the run journal and answers INCREMENTALLY. Both are
  // ordinary `{kind:'handler'}` actions, which is what makes the second one's auth, tenancy and rate
  // limiting inherited rather than re-implemented. Both routes are inside this pack's DEFAULT namespace —
  // `/ext/<packId>/`, and the deployment documents beside this file reference the pack as
  // `fixture-pack` — so no `routePrefix` is declared here: the default is the case worth witnessing,
  // and a route outside the namespace is a load failure naming this pack. Post-merge all of them are
  // ordinary declarations: same app, same auth chain, same interpreter, same tool chokepoint. Both
  // route handlers are `readonly`, so their routes are gated on `store:read` rather than the default
  // `store:write`.
  fragments: {
    handlers: [
      {
        id: 'fixture_pack_list_turns',
        module: 'handlers/list-turns.ts',
        export: 'listTurns',
        kind: 'route',
        readonly: true,
      },
      {
        id: 'fixture_pack_describe_turn',
        module: 'handlers/describe-turn.ts',
        export: 'describeTurn',
        kind: 'tool',
      },
      // The INCREMENTAL route. Same `route` kind and same `readonly: true` gate as the echo route
      // above — what differs is only what its module RETURNS (an event stream the deployment drives
      // instead of a JSON body), which is the point: an incremental answer is a shape a handler
      // chooses, not a second kind of route with a chain of its own.
      {
        id: 'fixture_pack_replay_journal',
        module: 'handlers/replay-journal.ts',
        export: 'replayJournal',
        kind: 'route',
        readonly: true,
      },
      // The route that reads THIS pack's OWN table — the one contribution the pack could not make
      // until a handler was handed the door onto the tables its migration chain creates. `readonly`
      // like its siblings: it counts rows and writes none.
      {
        id: 'fixture_pack_count_audit_events',
        module: 'handlers/count-audit-events.ts',
        export: 'countAuditEvents',
        kind: 'route',
        readonly: true,
      },
    ],
    api: [
      {
        method: 'GET',
        path: '/ext/fixture-pack/turns/{turn_id}',
        action: { kind: 'handler', handler: 'fixture_pack_list_turns' },
      },
      // The route behind the incremental handler — declared as an ORDINARY `{kind:'handler'}` action,
      // because it is one. It rides the same registration as every other declared route: the same
      // throttle, the same auth chain, the same per-route budget, the same tenant resolution and the
      // same permission gate.
      {
        method: 'GET',
        path: '/ext/fixture-pack/journal/{run_id}',
        action: { kind: 'handler', handler: 'fixture_pack_replay_journal' },
      },
      // Same namespace, same chain, same auth: what differs is that this one's handler reads a table
      // this pack owns rather than echoing a parameter.
      {
        method: 'GET',
        path: '/ext/fixture-pack/audit/count',
        action: { kind: 'handler', handler: 'fixture_pack_count_audit_events' },
      },
    ],
    // The TOOL contribution, wired to the handler id above. It is declared without an agent to
    // reference it on purpose: this pack ships no agent, and a tool's declaration resolves against
    // the merged `handlers` section on its own — the seam being witnessed is that a `tooling`
    // contribution now has a typed module at the end of it.
    tooling: [
      {
        id: 'fixture_pack_describe_turn',
        name: 'describe_turn',
        description: 'Echo the turn asked about, together with the tenant the call ran under.',
        handler: 'fixture_pack_describe_turn',
        parameters: {
          type: 'object',
          properties: { turn_id: { type: 'string' } },
          required: ['turn_id'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { turn_id: { type: 'string' }, tenant_id: { type: 'string' } },
          required: ['turn_id', 'tenant_id'],
          additionalProperties: false,
        },
        // The reviewed replay-safety declaration the dispatch chokepoint keys off. This tool reads
        // nothing and writes nothing, so re-running it is indistinguishable from running it once.
        idempotent: true,
        timeoutMs: 5_000,
      },
    ],
  },
  // The platform tables this pack OWNS. `dir` is pack-relative (the chain is emitted beside the
  // compiled entry by this package's build) and `tablePrefix` is the namespace every object in it
  // carries — mandatory, and the reason the chain can run against the same database as the
  // platform's own without either being able to reach the other's tables.
  migrations: { dir: 'migrations', tablePrefix: 'fixture_pack_' },
  // The LONG-LIVED SERVICES this pack brings — the one contribution kind the platform BOOTS rather
  // than calls, declared in the order it boots them (and the reverse of the order it stops them). Two,
  // deliberately, so the capability is measured against a control rather than only where it is
  // present: `audit-ledger` never names `TurnDispatch`, `turn-scheduler` holds it. Pack-relative,
  // resolved under the pack root by the same jail (and the same compiled-`.js` sibling preference)
  // as the entry and every handler.
  services: [{ module: 'services/audit-ledger.ts' }, { module: 'services/turn-scheduler.ts' }],
  sections: [
    {
      key: 'auditing',
      // Pack-relative, resolved under the pack root by the same jail (and the same compiled-`.js`
      // sibling preference) the entry itself goes through — so the authored `.ts` path is what the
      // manifest says and `auditing.js` is what a deployment loads.
      schemaModule: 'auditing.ts',
    },
  ],
});

export default fixturePack;
