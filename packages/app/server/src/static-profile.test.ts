/**
 * `isStaticProfile` + `loadStaticServerConfig` — pure-unit proofs (no DB, no network, no secrets).
 *
 * `isStaticProfile` is the FAIL-CLOSED absence predicate that decides whether a frontend-only spec may
 * boot WITHOUT a database / JWT signing key / api-key pepper and mount NO auth surface. The table below
 * is fail-the-fix, not pass-the-shape:
 *   - a frontend-only backend doc → true (and stays true for an explicit `durableWorker:false`);
 *   - EACH route/DB/agent/handler/worker-bearing section non-empty → false (INCLUDING a non-empty
 *     `extensions[]`, the pack-merge smuggle path a bare-emptiness check would miss);
 *   - a product-profile doc → false; an unknown top-level key / unsupported version → false;
 *   - a frontend that is empty or absent → false (a static boot with nothing to serve is not static).
 *
 * `loadStaticServerConfig` must resolve WITHOUT any of the three boot secrets — that is the whole point
 * — and default the CSP + Permissions-Policy to the secure baselines while honouring an env override.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRONTEND_CSP,
  DEFAULT_HOST,
  DEFAULT_PERMISSIONS_POLICY,
  DEFAULT_PORT,
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
