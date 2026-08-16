/**
 * `isStaticProfile` + `detectStaticProfile` + `loadStaticServerConfig` — pure-unit proofs (no DB, no
 * network, no secrets).
 *
 * `isStaticProfile` is the FAIL-CLOSED absence predicate that decides whether a frontend-only spec may
 * boot WITHOUT a database / JWT signing key / api-key pepper and mount NO auth surface. The table below
 * is fail-the-fix, not pass-the-shape:
 *   - a frontend-only backend doc → true (and stays true for an explicit `durableWorker:false`, and
 *     for the reserved opaque `managed:` key — the allowlist tripwire's other direction, where an
 *     omission fails LOUD on the very profile the key exists to serve, not safe);
 *   - EACH route/DB/agent/handler/worker-bearing section non-empty → false (INCLUDING a non-empty
 *     `extensions[]`, the pack-merge smuggle path a bare-emptiness check would miss);
 *   - a product-profile doc → false; an unknown top-level key / unsupported version → false;
 *   - a frontend that is empty or absent → false (a static boot with nothing to serve is not static).
 *
 * `detectStaticProfile` is the file-reading wrapper BOTH entrypoints (`rayspec-serve` and `rayspec
 * deploy`) branch on, so its fall-through table is what keeps the two identical: a static doc yields the
 * `assembleStaticServer` input, and EVERY other outcome — non-static, missing, unreadable — yields
 * undefined WITHOUT throwing, so the normal boot still raises its own error.
 *
 * `loadStaticServerConfig` must resolve WITHOUT any of the three boot secrets — that is the whole point
 * — and default the CSP + Permissions-Policy to the secure baselines while honouring an env override.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_FRONTEND_CSP,
  DEFAULT_HOST,
  DEFAULT_PERMISSIONS_POLICY,
  DEFAULT_PORT,
  detectStaticProfile,
  isStaticProfile,
  loadStaticServerConfig,
} from './composition-root.js';

/** A minimal frontend-only backend spec (the canonical static-eligible doc). */
const FRONTEND_ONLY = `
version: '1.0'
metadata:
  name: static-site
frontend:
  - route: /
    dir: web/dist
    spa: true
`;

describe('isStaticProfile — the frontend-only doc is static (positive)', () => {
  it('a frontend-only backend doc is static', () => {
    expect(isStaticProfile(FRONTEND_ONLY)).toBe(true);
  });

  it('an explicit deployment.durableWorker:false stays static', () => {
    const doc = `
version: '1.0'
metadata:
  name: static-site
deployment:
  durableWorker: false
frontend:
  - route: /
    dir: web/dist
`;
    expect(isStaticProfile(doc)).toBe(true);
  });

  it('multiple frontend mounts (no other section) stay static', () => {
    const doc = `
version: '1.0'
metadata:
  name: static-site
frontend:
  - route: /app
    dir: app/dist
    spa: true
  - route: /docs
    dir: docs/dist
`;
    expect(isStaticProfile(doc)).toBe(true);
  });

  it('the reserved `managed:` key does not disqualify — a frontend-only doc carrying it stays static', () => {
    // The OTHER direction of the keys-allowlist tripwire, and the one that fails LOUD rather than
    // safe: `managed` is opaque and bears no route/DB/agent/handler, so its mere presence must not
    // re-route a frontend-only deployment onto the normal boot — that boot would demand a database
    // and two secrets such a deployment must not have. Fail-the-fix: drop 'managed' from
    // STATIC_PROFILE_KNOWN_KEYS and both cases below flip to false.
    const withContents = `${FRONTEND_ONLY}managed:\n  owner: platform\n  nested:\n    flag: true\n`;
    const empty = `${FRONTEND_ONLY}managed: {}\n`;
    expect(isStaticProfile(withContents)).toBe(true);
    expect(isStaticProfile(empty)).toBe(true);
  });
});

describe('isStaticProfile — any route/DB/agent/handler-bearing section disqualifies (fail-closed)', () => {
  it('a store disqualifies', () => {
    const doc = `
version: '1.0'
metadata:
  name: has-store
stores:
  - name: notes
    columns:
      - name: body
        type: text
frontend:
  - route: /
    dir: web/dist
`;
    expect(isStaticProfile(doc)).toBe(false);
  });

  it('an api route disqualifies', () => {
    const doc = `
version: '1.0'
metadata:
  name: has-api
stores:
  - name: notes
    columns:
      - name: body
        type: text
api:
  - method: GET
    path: /notes
    action:
      kind: store
      store: notes
      op: list
frontend:
  - route: /
    dir: web/dist
`;
    expect(isStaticProfile(doc)).toBe(false);
  });

  it('an agent disqualifies', () => {
    const doc = `
version: '1.0'
metadata:
  name: has-agent
agents:
  - id: summarizer
    backend: openai
    name: Summarizer
    instructions: Summarize the input.
    model: gpt-5
frontend:
  - route: /
    dir: web/dist
`;
    expect(isStaticProfile(doc)).toBe(false);
  });

  it('tooling + a handler disqualify', () => {
    const doc = `
version: '1.0'
metadata:
  name: has-tooling
tooling:
  - id: do_thing
    handler: thing
    name: do_thing
    description: Does a thing.
    parameters:
      type: object
    idempotent: true
    timeoutMs: 1000
handlers:
  - id: thing
    module: ./handlers/thing.js
    export: doThing
    kind: tool
frontend:
  - route: /
    dir: web/dist
`;
    expect(isStaticProfile(doc)).toBe(false);
  });

  it('a trigger disqualifies', () => {
    const doc = `
version: '1.0'
metadata:
  name: has-trigger
triggers:
  - name: nightly
    kind: manual
    action:
      kind: handler
      handler: thing
handlers:
  - id: thing
    module: ./handlers/thing.js
    export: doThing
    kind: trigger
frontend:
  - route: /
    dir: web/dist
`;
    expect(isStaticProfile(doc)).toBe(false);
  });

  it('a handler alone disqualifies', () => {
    const doc = `
version: '1.0'
metadata:
  name: has-handler
handlers:
  - id: thing
    module: ./handlers/thing.js
    export: doThing
    kind: route
frontend:
  - route: /
    dir: web/dist
`;
    expect(isStaticProfile(doc)).toBe(false);
  });

  it('a non-empty extensions[] disqualifies — the pack-merge smuggle path', () => {
    // LOAD-BEARING: mergeExtensions concatenates each pack's stores/handlers/tooling/api/agents onto
    // the spec before deploy, so a pack could smuggle in a route-bearing section the other checks would
    // catch. We can not see the pack's contents at this point, so ANY non-empty extensions[] is
    // non-static — even one whose module/version look innocuous here.
    const doc = `
version: '1.0'
metadata:
  name: has-extension
extensions:
  - id: notes-pack
    module: ./packs/notes
    version: '1.0.0'
frontend:
  - route: /
    dir: web/dist
`;
    expect(isStaticProfile(doc)).toBe(false);
  });

  it('deployment.durableWorker:true disqualifies (it needs a database)', () => {
    const doc = `
version: '1.0'
metadata:
  name: worker
deployment:
  durableWorker: true
frontend:
  - route: /
    dir: web/dist
`;
    expect(isStaticProfile(doc)).toBe(false);
  });

  it('deployment.eventBus.enabled:true disqualifies (the event stream IS database rows)', () => {
    // The keys-allowlist tripwire above canNOT catch this one: it reasons about TOP-LEVEL sections,
    // and `deployment` is already a known key — so a NEW SUB-key inside it arrives with no tripwire
    // firing at all. Fail-the-fix: remove the explicit eventBus check in `isStaticProfile` and this
    // doc boots as a frontend-only static profile with NO database, while its own declaration says it
    // keeps a durable per-tenant event stream.
    const doc = `
version: '1.0'
metadata:
  name: bus
deployment:
  eventBus:
    enabled: true
frontend:
  - route: /
    dir: web/dist
`;
    expect(isStaticProfile(doc)).toBe(false);
  });

  it('a declared-but-DISABLED event bus stays static (the disqualifier is the enablement, not the key)', () => {
    const doc = `
version: '1.0'
metadata:
  name: bus-off
deployment:
  eventBus:
    enabled: false
    retentionHours: 12
frontend:
  - route: /
    dir: web/dist
`;
    expect(isStaticProfile(doc)).toBe(true);
  });
});

describe('isStaticProfile — product / malformed / empty-frontend docs are not static', () => {
  it('a product-profile doc is categorically never static', () => {
    const doc = `
version: '1.0'
metadata:
  name: a-product
product:
  id: a-product
`;
    expect(isStaticProfile(doc)).toBe(false);
  });

  it('an unknown top-level key → not static (strict grammar rejects it, fail-closed)', () => {
    const doc = `
version: '1.0'
metadata:
  name: future
webhooks:
  - path: /hook
frontend:
  - route: /
    dir: web/dist
`;
    expect(isStaticProfile(doc)).toBe(false);
  });

  it('an unsupported / missing version → not static', () => {
    const missingVersion = `
metadata:
  name: no-version
frontend:
  - route: /
    dir: web/dist
`;
    expect(isStaticProfile(missingVersion)).toBe(false);
    expect(isStaticProfile('not: valid: yaml: [')).toBe(false);
  });

  it('an EMPTY frontend[] → not static (nothing to serve)', () => {
    const doc = `
version: '1.0'
metadata:
  name: empty-frontend
frontend: []
`;
    expect(isStaticProfile(doc)).toBe(false);
  });

  it('an ABSENT frontend → not static (nothing to serve)', () => {
    const doc = `
version: '1.0'
metadata:
  name: no-frontend
`;
    expect(isStaticProfile(doc)).toBe(false);
  });
});

describe('detectStaticProfile — the shared wrapper both entrypoints branch on', () => {
  let root = ''; // a temp project: the static doc, the non-static doc, and a path that is not a file

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'rayspec-detect-static-'));
    writeFileSync(join(root, 'static.yaml'), FRONTEND_ONLY, 'utf8');
    writeFileSync(
      join(root, 'with-api.yaml'),
      `
version: '1.0'
metadata:
  name: not-static
stores:
  - name: notes
    columns:
      - name: body
        type: text
api:
  - method: GET
    path: /notes
    action:
      kind: store
      store: notes
      op: list
frontend:
  - route: /
    dir: web/dist
`,
      'utf8',
    );
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('a STATIC doc yields the path + the parsed frontend mounts assembleStaticServer needs', () => {
    const specPath = join(root, 'static.yaml');
    const detected = detectStaticProfile(specPath);
    expect(detected).toBeDefined();
    expect(detected?.specPath).toBe(specPath);
    // The TYPED mounts, not the raw source — assembleStaticServer mounts these verbatim.
    expect(detected?.frontend).toEqual([
      { route: '/', dir: 'web/dist', spa: true, cleanUrls: false },
    ]);
  });

  it('a NON-static doc (stores + api alongside the frontend) yields undefined ⇒ the normal boot', () => {
    expect(detectStaticProfile(join(root, 'with-api.yaml'))).toBeUndefined();
  });

  it('a MISSING spec falls through (undefined, never a throw) — the normal boot raises its own error', () => {
    expect(detectStaticProfile(join(root, 'does-not-exist.yaml'))).toBeUndefined();
  });

  it('an UNREADABLE spec path (a directory) falls through the same way', () => {
    // readFileSync on a directory throws EISDIR; the wrapper must swallow it exactly like a missing
    // file, so an operator typo can never turn into a boot crash from THIS branch.
    expect(detectStaticProfile(root)).toBeUndefined();
  });
});

describe('loadStaticServerConfig — resolves with NO boot secrets + secure header defaults', () => {
  it('resolves from an empty env (no DATABASE_URL / JWT key / pepper) — the whole point', () => {
    const cfg = loadStaticServerConfig({});
    expect(cfg.port).toBe(DEFAULT_PORT);
    expect(cfg.host).toBe(DEFAULT_HOST);
    expect(cfg.frontendCsp).toBe(DEFAULT_FRONTEND_CSP);
    expect(cfg.permissionsPolicy).toBe(DEFAULT_PERMISSIONS_POLICY);
  });

  it('the secure CSP default is same-origin with NO unsafe-inline', () => {
    expect(DEFAULT_FRONTEND_CSP).toContain("default-src 'self'");
    expect(DEFAULT_FRONTEND_CSP).not.toContain('unsafe-inline');
  });

  it('honours PORT / RAYSPEC_HOST / CSP / Permissions-Policy overrides', () => {
    const cfg = loadStaticServerConfig({
      PORT: '9099',
      RAYSPEC_HOST: '0.0.0.0',
      RAYSPEC_FRONTEND_CSP: "default-src 'self'; style-src 'self' 'unsafe-inline'",
      RAYSPEC_PERMISSIONS_POLICY: 'geolocation=(self)',
    });
    expect(cfg.port).toBe(9099);
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.frontendCsp).toBe("default-src 'self'; style-src 'self' 'unsafe-inline'");
    expect(cfg.permissionsPolicy).toBe('geolocation=(self)');
  });
});
