/**
 * The asset-catalog extension: a catalog of files a tenant describes by name, each classified on
 * create. It carries the application's two route handlers and their routes as a `defineExtension`
 * manifest, which the deployment's `extensions[]` entry loads. The store they write
 * (`catalog_items`) is declared in the deployment spec, where every deploy plan reads the stores
 * from, so an update of the application is planned against it.
 *
 * The entry imports `defineExtension` from `@rayspec/platform` at run time, so the extension's
 * `package.json` declares `@rayspec/platform` on a range that includes the runtime it deploys on.
 * `rayspec pack` leaves `@rayspec/*` out of the bundle — the runtime provides it — and carries the
 * extension's own third-party dependency (`mime-types`, with its dependency `mime-db`).
 *
 * The handler module paths name the compiled `.js` files: the deploy runtime loads compiled
 * JavaScript only, and `build.mjs` compiles this directory before it is packed.
 */
import { defineExtension } from '@rayspec/platform';

export default defineExtension({
  // Must equal the deployment's exact `extensions[].version` pin.
  version: '1.0.0',
  fragments: {
    handlers: [
      {
        id: 'create_item',
        module: 'handlers/create-item.js',
        export: 'createItem',
        kind: 'route',
        uses: [],
      },
      {
        id: 'list_items',
        module: 'handlers/list-items.js',
        export: 'listItems',
        kind: 'route',
        readonly: true,
        uses: [],
      },
    ],
    api: [
      { method: 'POST', path: '/api/items', action: { kind: 'handler', handler: 'create_item' } },
      { method: 'GET', path: '/api/items', action: { kind: 'handler', handler: 'list_items' } },
    ],
  },
});
