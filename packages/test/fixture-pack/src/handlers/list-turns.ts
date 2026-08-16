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
 * one. Like every escape-hatch module it imports `@rayspec/handler-sdk` and nothing else (the
 * type-only capability contract), which is the boundary `gate:handler-imports` enforces over this
 * subtree once the deployment document beside this pack registers it.
 */
import type { RouteHandler } from '@rayspec/handler-sdk';

/** What the route answers: the turn it was asked about, echoed back as neutral data. */
interface TurnView {
  readonly turnId: string;
}

/**
 * `GET /ext/fixture-pack/turns/{turn_id}` — echo the bound path parameter. `init.params` carries the
 * route's parameters as server-parsed strings; the tenant is never among them (it stays
 * server-derived), so there is nothing here a caller could name to reach another tenant's data.
 */
export const listTurns: RouteHandler<TurnView> = (init) => ({
  turnId: init.params.turn_id ?? '',
});
