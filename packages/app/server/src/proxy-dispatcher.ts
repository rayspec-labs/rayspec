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
 * WHEN. Only when the RUNNING Node would itself have installed that dispatcher at startup — see
 * `envProxyRequested`, which asks Node's question in Node's own terms: a runtime that implements the
 * opt-in at all, the opt-in carrying a value THAT runtime accepts (the accepted set is not the same on
 * every version — see `nodeAcceptsAnyEnvProxyOptIn`), and a named proxy. Miss any one of the three and
 * the boot touches nothing: honouring the proxy variables more widely than Node does would newly route
 * egress through a proxy for deployments that merely happen to carry them. This restores the behaviour
 * the running Node gives; it adds none that Node would not, on any version.
 *
 * The fix belongs HERE — the boot path — rather than in the adapter that pulls undici in: the
 * clobbering is a property of importing that closure at all, so the process that OWNS the closure is
 * the one that has to put the dispatcher back.
 */

/**
 * The proxy-URL variables Node's env-proxy support reads. Measured on Node 22.21.1, 24.0.0 and
 * 25.6.1: setting any ONE of these four (with the opt-in below) makes Node install its
 * `EnvHttpProxyAgent`; setting only `NO_PROXY`/`no_proxy` does not.
 */
export const PROXY_URL_ENV_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
] as const;

/**
 * Does the RUNNING Node implement `NODE_USE_ENV_PROXY` at all?
 *
 * It does not exist on every runtime this repository supports. `engines` is `node >= 22`, and the
 * feature reached the 22 line only in 22.21.0 — so on 22.0–22.20 Node ignores the four proxy-URL
 * variables UNCONDITIONALLY, opt-in or not, and a boot that installed a proxy dispatcher there would
 * be adding egress routing Node itself would never have added. That is the very outcome this gate
 * exists to prevent (a deployment carrying leftover proxy variables from a base image must not
 * silently start routing through a proxy), so the runtime is part of the condition, not an assumption.
 *
 * MEASURED with the environment set at process startup, reading
 * `Symbol.for('undici.globalDispatcher.1')` — `<undefined>` ⇒ Node installed nothing, an
 * `EnvHttpProxyAgent` ⇒ it did:
 *
 *     v22.12.0 <undefined>   v22.19.0 <undefined>   v22.20.0 <undefined>   v22.21.1 EnvHttpProxyAgent
 *     v23.11.1 <undefined>   v24.0.0  EnvHttpProxyAgent                    v25.6.1  EnvHttpProxyAgent
 *
 * Hence: the whole 24 line and above, plus 22.21.0 and later on the 22 line. The 23 line never got it
 * and is end-of-life. `nodeVersion` is injectable so the rule can be pinned across the WHOLE declared
 * engines range from one test run, rather than being re-measured by whichever Node happens to run CI.
 */
export function nodeSupportsEnvProxy(nodeVersion: string = process.versions.node): boolean {
  const { major, minor } = parseNodeVersion(nodeVersion);
  if (Number.isNaN(major)) return false;
  if (major >= 24) return true;
  if (major !== 22) return false;
  return !Number.isNaN(minor) && minor >= 21;
}

/** `NaN` for a component this cannot read; every rule below treats `NaN` as the do-less answer. */
function parseNodeVersion(nodeVersion: string): { major: number; minor: number } {
  const parts = nodeVersion.split('.').map((part) => Number.parseInt(part, 10));
  return { major: parts[0] ?? Number.NaN, minor: parts[1] ?? Number.NaN };
}

/**
 * Does the RUNNING Node accept ANY non-empty `NODE_USE_ENV_PROXY`, rather than only the exact `1`?
 *
 * Node's own opt-in rule is NOT the same on every version that has the feature, and the difference
 * falls inside the range this repository declares supported: the strict "must be `1`" comparison
 * arrived on the 24 line at 24.5.0, and the 24 releases before it arm on any non-empty value.
 *
 * MEASURED, environment set at process startup, `HTTP_PROXY=http://127.0.0.1:3128` in every row,
 * reading `Symbol.for('undici.globalDispatcher.1')`:
 *
 *     NODE_USE_ENV_PROXY   24.0.0 24.1.0 24.2.0 24.3.0 24.4.0 24.4.1 | 24.5.0 25.6.1 22.21.0 22.21.1
 *     '1'                  agent  agent  agent  agent  agent  agent  | agent  agent  agent   agent
 *     'true' / '0' / '2'    agent  agent  agent  agent  agent  agent  | <none> <none> <none>  <none>
 *     '01' / ' 1' / '1 '   agent   —      —      —     agent  agent  | <none> <none> <none>  <none>
 *     ''                   <none> <none> <none> <none> <none> <none> | <none> <none> <none>  <none>
 *
 * (`agent` = `EnvHttpProxyAgent`, `<none>` = `<undefined>`, `—` = not measured at that minor.)
 * So on 24.0–24.4 the rule is "present and non-empty"; from 24.5.0, and on the whole 22 line, which
 * received the feature at 22.21.0 with the strict semantics already in it, the rule is "exactly `1`".
 *
 * The gate mirrors whichever rule the RUNNING Node applies, because the promise this module makes is
 * that it installs where that Node installed — nothing wider. Being uniformly strict would be the
 * cheaper code, but it would leave a deployment on 24.0–24.4 carrying `NODE_USE_ENV_PROXY=true`
 * proxy-aware at startup and direct-connecting after the boot closure loads, which is issue #287
 * itself. An unreadable minor falls to STRICT: the failure direction of a wrong guess here is routing
 * somebody's egress through a proxy they did not ask for, so the unknown case installs less, never more.
 */
function nodeAcceptsAnyEnvProxyOptIn(nodeVersion: string): boolean {
  const { major, minor } = parseNodeVersion(nodeVersion);
  return major === 24 && minor < 5;
}

/**
 * Would THIS Node have installed its env-proxy dispatcher for this environment?
 *
 * Three conditions, all of them Node's own:
 *  - the runtime implements `NODE_USE_ENV_PROXY` — see `nodeSupportsEnvProxy`;
 *  - `NODE_USE_ENV_PROXY` carries a value THAT runtime accepts — see `nodeAcceptsAnyEnvProxyOptIn`.
 *    Nothing here coerces: where Node compares strictly this compares strictly, and where Node takes
 *    any non-empty value so does this. Blank is "no opt-in" on every version;
 *  - at least one of the four proxy-URL variables is non-empty. With the opt-in set and none of them
 *    present Node installs nothing, and an EMPTY value counts as absent there too.
 *
 * Anything else ⇒ `false`, and the caller does nothing at all.
 */
export function envProxyRequested(
  env: NodeJS.ProcessEnv,
  nodeVersion: string = process.versions.node,
): boolean {
  if (!nodeSupportsEnvProxy(nodeVersion)) return false;
  const optIn = env.NODE_USE_ENV_PROXY;
  if (optIn === undefined || optIn === '') return false;
  if (optIn !== '1' && !nodeAcceptsAnyEnvProxyOptIn(nodeVersion)) return false;
  return PROXY_URL_ENV_VARS.some((name) => {
    const value = env[name];
    return value !== undefined && value !== '';
  });
}

/**
 * Install a proxy-aware global dispatcher when — and only when — `envProxyRequested` says this Node
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
  nodeVersion: string = process.versions.node,
): Promise<boolean> {
  if (!envProxyRequested(env, nodeVersion)) return false;
  const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new EnvHttpProxyAgent());
  return true;
}
