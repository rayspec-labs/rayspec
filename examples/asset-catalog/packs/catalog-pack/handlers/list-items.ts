/**
 * GET /api/items — the tenant's catalog, newest first, through the injected tenant-bound `init.db`.
 * `?limit=` bounds the page (1-100, default 50) and `?offset=` skips rows.
 */
import type { RouteHandler, RouteHandlerInit } from '@rayspec/handler-sdk';

const STORE = 'catalog_items';

function bounded(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || !/^\d{1,6}$/.test(raw)) return fallback;
  return Math.min(Number(raw), max);
}

export const listItems: RouteHandler = async (init: RouteHandlerInit) => {
  const limit = Math.max(1, bounded(init.params.limit, 50, 100));
  const offset = bounded(init.params.offset, 0, 1_000_000);
  const items = await init.db.select(
    STORE,
    {},
    {
      orderBy: [
        { column: 'created_at', dir: 'desc' },
        { column: 'id', dir: 'asc' },
      ],
      limit,
      offset,
    },
  );
  return { items };
};
