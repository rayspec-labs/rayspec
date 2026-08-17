/**
 * The fixture pack's ROUTE handler — the code behind the one authenticated route this pack contributes.
 *
 * It exists so the pack seams have a route in the repository that is served the way a contributed route
 * is actually served: mounted on the deployment's own app, behind the same
 * `requireAuth → resolveTenant → requirePermission` chain a deployment-declared route rides, reached
 * only through the api chokepoint, and confined to the pack's own route namespace
 * (`/ext/fixture-pack/…`) — a route outside it is a load failure naming this pack.
 *
 * It is deliberately trivial: it reads its bound path parameter and answers with it. What is being
 * witnessed is WHERE the route is allowed to live and WHO the merge says brought it, not what the
 * handler computes — and a handler that touched the database would make the namespace test depend on
 * one. It names `@rayspec/pack-sdk` and nothing else, now that the same package carries the contract a
 * handler is written against — which keeps this subtree inside the boundary `gate:handler-imports`
 * enforces over it once the deployment document beside this pack registers it: that gate sanctions
 * the two handler contracts and refuses every other `@rayspec/`-scoped import under that root.
 */
import type { PackRouteHandler } from '@rayspec/pack-sdk';

/** What the route answers: the turn it was asked about, echoed back as neutral data. */
interface TurnView {
  readonly turnId: string;
}

/**
 * `GET /ext/fixture-pack/turns/{turn_id}` — echo the bound path parameter. `init.params` carries the
 * route's parameters as server-parsed strings; the tenant is never among them (it stays
 * server-derived), so there is nothing here a caller could name to reach another tenant's data.
 */
export const listTurns: PackRouteHandler<TurnView> = (init) => ({
  turnId: init.params.turn_id ?? '',
});
