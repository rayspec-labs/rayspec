/**
 * The pack ENTRY — the manifest a deployment's `extensions[]` reference resolves to.
 *
 * This pack exists to be LOADED, by the real loader, from a real deployment document, so that the
 * pack seams have something in the repository that exercises them end to end. It is therefore
 * deliberately boring: it contributes no store, no handler, no route, no agent and no capability. It
 * claims ONE top-level section, `auditing`, ships the module that validates it, OWNS one
 * platform table through a migration chain of its own — an append-only ledger with hand-shaped
 * indexes and a foreign key, which is exactly what a generated `stores` table is not — and brings TWO
 * long-lived SERVICES, which is the one contribution kind the platform boots rather than calls.
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
  // No spec fragment: what this pack contributes to the document is the section it claims, and what
  // it contributes to the database is the chain below — neither is a `stores` business table.
  fragments: {},
  // The platform tables this pack OWNS. `dir` is pack-relative (the chain is emitted beside the
  // compiled entry by this package's build) and `tablePrefix` is the namespace every object in it
  // carries — mandatory, and the reason the chain can run against the same database as the
  // platform's own without either being able to reach the other's tables.
  migrations: { dir: 'migrations', tablePrefix: 'fixture_pack_' },
  // The LONG-LIVED SERVICES this pack brings — the one contribution kind the platform BOOTS rather
  // than calls, declared in the order it boots them (and the reverse of the order it stops them). Two,
  // deliberately, so the dispatch boundary has something real on BOTH sides: `audit-ledger` never
  // names `TurnDispatch`, `turn-scheduler` holds it. Pack-relative, resolved under the pack root by
  // the same jail (and the same compiled-`.js` sibling preference) as the entry and every handler.
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
