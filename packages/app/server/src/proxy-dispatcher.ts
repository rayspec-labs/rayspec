/**
 * Restore Node's own environment-proxy egress for the WHOLE boot process.
 *
 * WHY THIS EXISTS. The server's runtime closure contains undici v8 — `@rayspec/server` →
 * `@rayspec/adapter-pi` → `@earendil-works/pi-coding-agent`, whose `dist/core/http-dispatcher.js`
 * opens with `import * as undici from "undici"`. undici v8's `lib/global.js` runs this at MODULE
 * IMPORT TIME:
 *
 *     if (getGlobalDispatcher() === undefined) { setGlobalDispatcher(new Agent()) }
 *
 * `getGlobalDispatcher()` reads `Symbol.for('undici.globalDispatcher.2')`, a slot Node core never
 * sets, so the branch fires on the first import in any process. And `setGlobalDispatcher` ALSO
 * writes `Symbol.for('undici.globalDispatcher.1')` — the slot Node's BUILT-IN `fetch` reads, and
 * exactly where `NODE_USE_ENV_PROXY=1` installed Node's own `EnvHttpProxyAgent` at startup.
 * Importing the boot closure therefore replaces a proxy-aware global dispatcher with a
 * direct-connecting one, and every `globalThis.fetch` caller in the process — the model SDKs among
 * them — silently stops honouring the proxy. On a deployment whose ONLY egress is an HTTP proxy that
 * is the difference between a working agent run and a connection error at the first model call
 * (issue #287).
 *
 * WHAT THIS DOES. Re-install an `EnvHttpProxyAgent` through undici's own `setGlobalDispatcher`,
 * which writes BOTH symbols — so Node's built-in `fetch` and userland undici are proxy-aware again.
 * `EnvHttpProxyAgent` reads the proxy URL *and* `NO_PROXY` from the environment itself, so a host the
 * operator excluded from proxying keeps its direct route.
 *
 * WHEN. Only when the operator has opted into Node's env-proxy behaviour AND named a proxy — see
 * `envProxyRequested`. Stock Node ignores the proxy variables unless the opt-in is set, so honouring
 * them unconditionally would newly route egress through a proxy for deployments that merely happen to
 * carry those variables. This restores the behaviour Node documents; it adds none Node would not give.
 *
 * The fix belongs HERE — the boot path — rather than in the adapter that pulls undici in: the
 * clobbering is a property of importing that closure at all, so the process that OWNS the closure is
 * the one that has to put the dispatcher back.
 */

/**
 * The proxy-URL variables Node's env-proxy support reads. Measured on Node 22.23.2: setting any ONE
 * of these four (with the opt-in below) makes Node install its `EnvHttpProxyAgent`; setting only
 * `NO_PROXY`/`no_proxy` does not.
 */
export const PROXY_URL_ENV_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
] as const;

/**
 * Would STOCK Node have installed its env-proxy dispatcher for this environment?
 *
 * Both halves are Node's own condition, measured on Node 22.23.2:
 *  - `NODE_USE_ENV_PROXY` is accepted ONLY as the exact string `1` — `0`, `true`, `01`, `2`, ` 1`,
 *    `1 ` and blank all leave Node's proxy support off. So this compares strictly, with no
 *    truthy-coercion of an ambiguous value.
 *  - at least one of the four proxy-URL variables must be non-empty. With the opt-in set and none of
 *    them present Node installs nothing, and an EMPTY value counts as absent there too.
 *
 * Anything else ⇒ `false`, and the caller does nothing at all.
 */
export function envProxyRequested(env: NodeJS.ProcessEnv): boolean {
  if (env.NODE_USE_ENV_PROXY !== '1') return false;
  return PROXY_URL_ENV_VARS.some((name) => {
    const value = env[name];
    return value !== undefined && value !== '';
  });
}

/**
 * Install a proxy-aware global dispatcher when — and only when — `envProxyRequested` says stock Node
 * would have. Returns whether it installed one.
 *
 * `undici` is loaded through a DYNAMIC import inside the gated branch, so a deployment with no proxy
 * configuration never even pulls this module's copy of undici in: the two global-dispatcher symbols
 * are left exactly as the process found them, which is what keeps a non-proxied boot byte-identical.
 *
 * Idempotent enough to call once per boot: `setGlobalDispatcher` overwrites both slots outright.
 */
export async function installEnvProxyDispatcher(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!envProxyRequested(env)) return false;
  const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new EnvHttpProxyAgent());
  return true;
}
