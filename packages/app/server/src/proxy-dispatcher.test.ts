/**
 * The boot-time env-proxy dispatcher restore (issue #287).
 *
 * The end-to-end counterproof for this defect is a proxy-only deployment running an agent; what THIS
 * file pins is the part a normal CI run can execute:
 *
 *   - the GATE, in all three of its directions. The opt-in is compared exactly the way Node compares
 *     it; the RUNTIME condition is pinned across the whole declared engines range (`node >= 22`), where
 *     `NODE_USE_ENV_PROXY` exists only from 22.21.0 and on the 24 line; and the closed direction asserts
 *     the two global-dispatcher symbols are the SAME OBJECTS afterwards — not merely "still a
 *     dispatcher" — so a deployment with no proxy configuration is untouched.
 *   - NO_PROXY still bypassing. This is the discrimination control: a "fix" that forced everything
 *     through a proxy would pass a naive "the request went through the proxy" assertion. Two loopback
 *     servers stand in for the proxy and the origin, and BOTH directions are measured through
 *     `globalThis.fetch` — the exact client the defect broke, reading the exact symbol it clobbered.
 *
 * No network beyond 127.0.0.1, no credentials.
 */
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  envProxyRequested,
  installEnvProxyDispatcher,
  nodeSupportsEnvProxy,
} from './proxy-dispatcher.js';

/**
 * A Node that DOES implement `NODE_USE_ENV_PROXY`. Injected into every gate assertion below so the
 * suite pins the rule itself rather than whatever Node happens to run it — the repository supports
 * `node >= 22`, and half of that range has no env-proxy support at all.
 */
const NODE_WITH_ENV_PROXY = '24.0.0';
/** A Node inside the declared engines range that does NOT implement it. */
const NODE_WITHOUT_ENV_PROXY = '22.20.0';

/** Node's built-in `fetch` reads this one; it is where NODE_USE_ENV_PROXY installs its agent. */
const V1 = Symbol.for('undici.globalDispatcher.1');
/** npm-undici v8's own slot. Node core never sets it. */
const V2 = Symbol.for('undici.globalDispatcher.2');

type Globals = { v1: unknown; v2: unknown };
const readGlobals = (): Globals => ({
  v1: (globalThis as Record<symbol, unknown>)[V1],
  v2: (globalThis as Record<symbol, unknown>)[V2],
});
const name = (d: unknown): string =>
  d === undefined ? '<undefined>' : ((d as object).constructor?.name ?? '<anonymous>');

// Both slots are defined `writable: true` by undici's setGlobalDispatcher, so a test can put back
// exactly what it found. Restoring keeps one test's install from leaking into the next one's
// byte-identical assertion.
function restoreGlobals(prev: Globals): void {
  const g = globalThis as Record<symbol, unknown>;
  g[V1] = prev.v1;
  g[V2] = prev.v2;
}

const PROXY_KEYS = [
  'NODE_USE_ENV_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;

let savedEnv: Record<string, string | undefined>;
let savedGlobals: Globals;

beforeEach(() => {
  savedEnv = Object.fromEntries(PROXY_KEYS.map((k) => [k, process.env[k]]));
  for (const k of PROXY_KEYS) delete process.env[k];
  savedGlobals = readGlobals();
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  restoreGlobals(savedGlobals);
});

describe('nodeSupportsEnvProxy — does the RUNNING Node implement NODE_USE_ENV_PROXY at all?', () => {
  /**
   * MEASURED, environment set at process startup, reading `Symbol.for('undici.globalDispatcher.1')`:
   * 22.12.0/22.19.0/22.20.0 and 23.11.1 install NOTHING for `NODE_USE_ENV_PROXY=1` + `HTTP_PROXY`;
   * 22.21.1, 24.0.0 and 25.6.1 install an `EnvHttpProxyAgent`. This is why the predicate exists: half
   * of the declared `node >= 22` range has no env-proxy support, and installing a proxy dispatcher
   * there would ADD routing Node itself would never have added.
   */
  it('is false across the 22.x versions that predate the feature — the whole 22.0–22.20 span', () => {
    for (const version of ['22.0.0', '22.12.0', '22.19.0', '22.20.0', '22.20.9']) {
      expect(nodeSupportsEnvProxy(version), `node ${version} has no env-proxy support`).toBe(false);
    }
  });

  it('is true from 22.21.0 on the 22 line', () => {
    for (const version of ['22.21.0', '22.21.1', '22.23.2', '22.99.0']) {
      expect(nodeSupportsEnvProxy(version), `node ${version} has env-proxy support`).toBe(true);
    }
  });

  it('is false on the 23 line, which never received it, and true from 24 upward', () => {
    expect(nodeSupportsEnvProxy('23.11.1')).toBe(false);
    for (const version of ['24.0.0', '24.5.0', '25.6.1', '26.0.0']) {
      expect(nodeSupportsEnvProxy(version), `node ${version} has env-proxy support`).toBe(true);
    }
  });

  it('fails CLOSED on a version string it cannot read', () => {
    // Unreadable ⇒ "Node would not have" ⇒ touch nothing. The failure mode of a wrong guess here is
    // routing somebody's egress through a proxy they did not ask for, so the unknown case is the
    // do-nothing case.
    expect(nodeSupportsEnvProxy('')).toBe(false);
    expect(nodeSupportsEnvProxy('not-a-version')).toBe(false);
  });
});

describe('envProxyRequested — would THIS Node have installed its env-proxy dispatcher?', () => {
  it('is true for the opt-in plus ANY ONE of the four proxy-URL variables', () => {
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
      expect(
        envProxyRequested(
          { NODE_USE_ENV_PROXY: '1', [key]: 'http://proxy:3128' },
          NODE_WITH_ENV_PROXY,
        ),
        `${key} should arm the gate`,
      ).toBe(true);
    }
  });

  it('is false on a supported-but-older Node, where the opt-in means nothing', () => {
    // The claim this repository makes is that the hook runs only where Node itself would have run it.
    // On Node 22.0–22.20 — inside `engines: node >= 22` — Node installs nothing for ANY value of these
    // variables, so neither does the boot. Without this arm a deployment that carries the variables in
    // anticipation of a newer Node would start routing through a proxy the moment it upgraded RaySpec.
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
      expect(
        envProxyRequested(
          { NODE_USE_ENV_PROXY: '1', [key]: 'http://proxy:3128' },
          NODE_WITHOUT_ENV_PROXY,
        ),
        `${key} must not arm the gate on node ${NODE_WITHOUT_ENV_PROXY}`,
      ).toBe(false);
    }
  });

  it('is false when the operator never opted in, however many proxy variables are set', () => {
    expect(
      envProxyRequested(
        {
          HTTP_PROXY: 'http://proxy:3128',
          HTTPS_PROXY: 'http://proxy:3128',
          http_proxy: 'http://proxy:3128',
          https_proxy: 'http://proxy:3128',
        },
        NODE_WITH_ENV_PROXY,
      ),
    ).toBe(false);
  });

  it('accepts the opt-in ONLY as the exact string Node accepts', () => {
    // Measured on Node 22.21.1: `1` installs the agent; `0`, `true`, `01`, `2`, ` 1`, `1 ` and blank
    // all leave Node's own proxy support off. Nothing here coerces an ambiguous value.
    expect(
      envProxyRequested(
        { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://p:3128' },
        NODE_WITH_ENV_PROXY,
      ),
    ).toBe(true);
    for (const raw of ['0', 'true', 'TRUE', 'yes', 'on', '01', '2', ' 1', '1 ', '']) {
      expect(
        envProxyRequested(
          { NODE_USE_ENV_PROXY: raw, HTTP_PROXY: 'http://p:3128' },
          NODE_WITH_ENV_PROXY,
        ),
        `NODE_USE_ENV_PROXY='${raw}' must not arm the gate`,
      ).toBe(false);
    }
  });

  it('is false for the opt-in with no proxy named — a blank URL counts as absent', () => {
    expect(envProxyRequested({ NODE_USE_ENV_PROXY: '1' }, NODE_WITH_ENV_PROXY)).toBe(false);
    expect(
      envProxyRequested({ NODE_USE_ENV_PROXY: '1', HTTP_PROXY: '' }, NODE_WITH_ENV_PROXY),
    ).toBe(false);
    // NO_PROXY alone names no proxy to route through — Node installs nothing for it either.
    expect(
      envProxyRequested({ NODE_USE_ENV_PROXY: '1', NO_PROXY: 'example.com' }, NODE_WITH_ENV_PROXY),
    ).toBe(false);
  });
});

describe('installEnvProxyDispatcher — the gate decides whether anything is touched at all', () => {
  it('installs a proxy-aware dispatcher into BOTH symbols when the gate is armed', async () => {
    process.env.NODE_USE_ENV_PROXY = '1';
    process.env.HTTP_PROXY = 'http://127.0.0.1:1';
    const before = readGlobals();

    await expect(installEnvProxyDispatcher(process.env, NODE_WITH_ENV_PROXY)).resolves.toBe(true);

    const after = readGlobals();
    // v2 is undici's own slot; v1 is the one Node's built-in fetch reads, and the one the defect
    // clobbered. BOTH have to change, or half the process keeps connecting directly.
    expect(name(after.v2)).toBe('EnvHttpProxyAgent');
    expect(after.v1).toBeDefined();
    expect(after.v1).not.toBe(before.v1);
  });

  it('leaves BOTH symbols byte-identical on a Node that has no env-proxy support', async () => {
    // Same environment as the armed case above — only the runtime differs. On Node 22.0–22.20 stock
    // Node installs nothing here, so neither may the boot: this is the arm that keeps "it runs only
    // where Node itself would have" true across the whole declared engines range.
    process.env.NODE_USE_ENV_PROXY = '1';
    process.env.HTTP_PROXY = 'http://127.0.0.1:1';
    const before = readGlobals();
    await expect(installEnvProxyDispatcher(process.env, NODE_WITHOUT_ENV_PROXY)).resolves.toBe(
      false,
    );
    const after = readGlobals();
    expect(Object.is(after.v1, before.v1)).toBe(true);
    expect(Object.is(after.v2, before.v2)).toBe(true);
  });

  it('leaves BOTH symbols byte-identical when no proxy is configured', async () => {
    const before = readGlobals();
    await expect(installEnvProxyDispatcher(process.env, NODE_WITH_ENV_PROXY)).resolves.toBe(false);
    const after = readGlobals();
    // The SAME objects, not merely equivalent ones: a deployment with no proxy configuration must be
    // indistinguishable from one built before this change.
    expect(Object.is(after.v1, before.v1)).toBe(true);
    expect(Object.is(after.v2, before.v2)).toBe(true);
  });

  it('leaves BOTH symbols byte-identical when proxy variables are set without the opt-in', async () => {
    process.env.HTTP_PROXY = 'http://127.0.0.1:1';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
    const before = readGlobals();
    await expect(installEnvProxyDispatcher(process.env, NODE_WITH_ENV_PROXY)).resolves.toBe(false);
    const after = readGlobals();
    expect(Object.is(after.v1, before.v1)).toBe(true);
    expect(Object.is(after.v2, before.v2)).toBe(true);
  });

  it('leaves BOTH symbols byte-identical when the opt-in names no proxy', async () => {
    process.env.NODE_USE_ENV_PROXY = '1';
    const before = readGlobals();
    await expect(installEnvProxyDispatcher(process.env, NODE_WITH_ENV_PROXY)).resolves.toBe(false);
    const after = readGlobals();
    expect(Object.is(after.v1, before.v1)).toBe(true);
    expect(Object.is(after.v2, before.v2)).toBe(true);
  });
});

describe('installEnvProxyDispatcher — NO_PROXY still reaches an excluded host directly', () => {
  let origin: Server;
  let proxy: Server;
  let originPort = 0;
  let proxyPort = 0;
  let served: string[] = [];

  beforeEach(async () => {
    served = [];
    // The ORIGIN answers only what reaches it directly; the PROXY answers only what was routed
    // through it (a forward proxy receives the absolute URI in the request line, which is why the two
    // are distinguishable without inspecting anything but the body).
    origin = createServer((_req, res) => {
      served.push('origin');
      res.end('ORIGIN');
    });
    proxy = createServer((_req, res) => {
      served.push('proxy');
      res.end('PROXY');
    });
    await new Promise<void>((r) => {
      origin.listen(0, '127.0.0.1', r);
    });
    await new Promise<void>((r) => {
      proxy.listen(0, '127.0.0.1', r);
    });
    originPort = (origin.address() as { port: number }).port;
    proxyPort = (proxy.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => {
      origin.close(() => r());
    });
    await new Promise<void>((r) => {
      proxy.close(() => r());
    });
  });

  it('proxies a host NOT excluded and goes DIRECT to one that is', async () => {
    process.env.NODE_USE_ENV_PROXY = '1';
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
    // `localhost` and `127.0.0.1` are the same machine but DIFFERENT names, so one origin server can
    // be addressed both as excluded and as not-excluded — everything else about the two calls is equal.
    process.env.NO_PROXY = 'localhost';

    expect(await installEnvProxyDispatcher(process.env, NODE_WITH_ENV_PROXY)).toBe(true);

    // Both calls go through `globalThis.fetch` — Node's built-in client, reading the v1 symbol the
    // defect overwrote. Nothing here passes a dispatcher explicitly.
    const proxied = await (await fetch(`http://127.0.0.1:${originPort}/probe`)).text();
    const direct = await (await fetch(`http://localhost:${originPort}/probe`)).text();

    expect(proxied).toBe('PROXY');
    // The ACCEPT CONTROL for the assertion above: an excluded host is still reachable, so "it went
    // through the proxy" is a real discrimination and not the only thing this dispatcher can do.
    expect(direct).toBe('ORIGIN');
    expect(served).toEqual(['proxy', 'origin']);
  });
});
