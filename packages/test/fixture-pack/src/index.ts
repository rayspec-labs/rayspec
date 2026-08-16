/**
 * The pack ENTRY — the manifest a deployment's `extensions[]` reference resolves to.
 *
 * This pack exists to be LOADED, by the real loader, from a real deployment document, so that the
 * claimed-section seam has something in the repository that exercises it end to end. It is therefore
 * deliberately boring: it contributes no store, no handler, no route, no agent and no capability. It
 * claims ONE top-level section, `auditing`, and ships the module that validates it.
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
  // Nothing contributed: this pack is about the section it claims, and only that.
  fragments: {},
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
