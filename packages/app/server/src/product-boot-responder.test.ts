/**
 * the responder-config resolve + builder (product-boot.ts), fail-closed arms (no DB, no
 * network — pure config law; the wired end-to-end path is the conversation e2e's live-reply arm):
 *
 *  - the STRICT `<agent_id>.responder.json` convention: missing dir / zero files / MULTIPLE files /
 *    a non-SafeIdentifier stem / an `agent_id` that does not match the stem — each a named
 *    ProductBootError (never a silent default or a picked-first);
 *  - config shape: missing instructions/model/backend; malformed history_window; a store_context
 *    limit outside the STORE_READ cap; a filter key outside the closed payload-key set;
 *  - `buildTurnResponder` mode law: RAYSPEC_RESPONDER_MODE demanded; an unknown mode rejected;
 *    `deterministic` without the injected Backend rejected; `live` with an unknown backend id
 *    rejected NAMING the responder; a valid deterministic build yields a factory whose instances
 *    carry the config's agentId/window/storeContext (the values the reply path consumes).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Backend } from '@rayspec/core';
import type { Db } from '@rayspec/db';
import type { ProductSpec } from '@rayspec/spec';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTurnResponder, resolveResponderConfig } from './product-boot.js';

const SPEC = {} as ProductSpec; // v1 resolution keys only on the directory convention.
const DB = {} as Db; // buildTurnResponder only closes over it (never dereferenced here).
const FAKE_BACKEND = { id: 'openai' } as unknown as Backend;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** Build a throwaway product dir with a spec path + optional conversation/ files. */
function productDir(files: Record<string, unknown> | undefined): string {
  const root = mkdtempSync(join(tmpdir(), 'responder-'));
  dirs.push(root);
  if (files !== undefined) {
    mkdirSync(join(root, 'conversation'));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(
        join(root, 'conversation', name),
        typeof content === 'string' ? content : JSON.stringify(content),
      );
    }
  }
  return join(root, 'product.yaml');
}

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent_id: 'support_responder',
    instructions: 'You are a helpful support assistant.',
    model: 'test-model',
    backend: 'openai',
    ...overrides,
  };
}

describe('resolveResponderConfig — the strict <agent_id>.responder.json convention', () => {
  it('resolves a single valid config (stem = agent id)', () => {
    const specPath = productDir({ 'support_responder.responder.json': validConfig() });
    const cfg = resolveResponderConfig(specPath, SPEC);
    expect(cfg.agentId).toBe('support_responder');
    expect(cfg.model).toBe('test-model');
  });

  it('fail-closes on a MISSING conversation/ dir', () => {
    const specPath = productDir(undefined);
    expect(() => resolveResponderConfig(specPath, SPEC)).toThrow(/does not exist/);
  });

  it('fail-closes on ZERO *.responder.json files', () => {
    const specPath = productDir({});
    expect(() => resolveResponderConfig(specPath, SPEC)).toThrow(/no \*\.responder\.json/);
  });

  it('fail-closes on MULTIPLE responder configs (v1 single-responder — never picked-first)', () => {
    const specPath = productDir({
      'a.responder.json': validConfig({ agent_id: 'a' }),
      'b.responder.json': validConfig({ agent_id: 'b' }),
    });
    expect(() => resolveResponderConfig(specPath, SPEC)).toThrow(/2 \*\.responder\.json files/);
  });

  it('fail-closes on a non-SafeIdentifier stem (the id law — no metacharacters/uppercase)', () => {
    const specPath = productDir({ 'Bad-Agent.responder.json': validConfig() });
    expect(() => resolveResponderConfig(specPath, SPEC)).toThrow(/SafeIdentifier/);
  });

  it('fail-closes on an agent_id that does not match the filename stem (the extractor law)', () => {
    const specPath = productDir({
      'support_responder.responder.json': validConfig({ agent_id: 'other_agent' }),
    });
    expect(() => resolveResponderConfig(specPath, SPEC)).toThrow(/names agent 'other_agent'/);
  });

  it('fail-closes on missing/empty instructions, model, and backend (each named)', () => {
    for (const [field, pattern] of [
      ['instructions', /'instructions' must be a non-empty string/],
      ['model', /'model' must be a non-empty string/],
      ['backend', /'backend' must name one of the wired backends/],
    ] as const) {
      const specPath = productDir({
        'support_responder.responder.json': validConfig({ [field]: '' }),
      });
      expect(() => resolveResponderConfig(specPath, SPEC)).toThrow(pattern);
    }
  });

  it('fail-closes on unparseable JSON', () => {
    const specPath = productDir({ 'support_responder.responder.json': '{ not json' });
    expect(() => resolveResponderConfig(specPath, SPEC)).toThrow(/could not read\/parse/);
  });

  it('an UNKNOWN backend id fail-closes AT RESOLVE, naming the id AND the wired set (both modes — not just live)', () => {
    const specPath = productDir({
      'support_responder.responder.json': validConfig({ backend: 'skynet' }),
    });
    expect(() => resolveResponderConfig(specPath, SPEC)).toThrow(
      /responder 'support_responder'.*'skynet' is not wired.*openai \| anthropic \| pi \| codex/s,
    );
  });

  it('an unknown TOP-LEVEL key is a loud boot reject (strict parsing — a typo must never silently fall back to a default)', () => {
    const specPath = productDir({
      'support_responder.responder.json': validConfig({ history_windw: { turns: 5 } }),
    });
    expect(() => resolveResponderConfig(specPath, SPEC)).toThrow(
      /unknown key\(s\).*history_windw/s,
    );
  });

  it('an unknown history_window axis / a non-object history_window are loud boot rejects', () => {
    for (const [window, pattern] of [
      [{ turns: 5, charss: 100 }, /history_window.*charss/s],
      ['20 turns', /history_window must be an object/],
    ] as const) {
      const specPath = productDir({
        'support_responder.responder.json': validConfig({ history_window: window }),
      });
      expect(() => resolveResponderConfig(specPath, SPEC)).toThrow(pattern);
    }
  });

  it('an unknown store_context key is a loud boot reject', () => {
    const specPath = productDir({
      'support_responder.responder.json': validConfig({
        store_context: { store: 'catalog', limit: 10, order_by: 'k' },
      }),
    });
    expect(() => resolveResponderConfig(specPath, SPEC)).toThrow(
      /store_context.*unknown key\(s\).*order_by/s,
    );
  });
});

describe('buildTurnResponder — the mode law + config threading', () => {
  it('demands RAYSPEC_RESPONDER_MODE (fail-closed absent)', () => {
    const specPath = productDir({ 'support_responder.responder.json': validConfig() });
    expect(() => buildTurnResponder({}, specPath, SPEC, DB, {})).toThrow(
      /RAYSPEC_RESPONDER_MODE is required/,
    );
  });

  it('rejects an unknown mode (wired: live | deterministic)', () => {
    const specPath = productDir({ 'support_responder.responder.json': validConfig() });
    expect(() =>
      buildTurnResponder({ RAYSPEC_RESPONDER_MODE: 'yolo' }, specPath, SPEC, DB, {}),
    ).toThrow(/'yolo' is not supported/);
  });

  it('deterministic mode REQUIRES the injected Backend (the proof seam)', () => {
    const specPath = productDir({ 'support_responder.responder.json': validConfig() });
    expect(() =>
      buildTurnResponder({ RAYSPEC_RESPONDER_MODE: 'deterministic' }, specPath, SPEC, DB, {}),
    ).toThrow(/requires an injected deterministic reply Backend/);
  });

  it('live mode with an UNKNOWN backend id fail-closes NAMING the responder', () => {
    const specPath = productDir({
      'support_responder.responder.json': validConfig({ backend: 'skynet' }),
    });
    expect(() =>
      buildTurnResponder({ RAYSPEC_RESPONDER_MODE: 'live' }, specPath, SPEC, DB, {}),
    ).toThrow(/responder 'support_responder'.*'skynet' is not wired/s);
  });

  it('malformed history_window axes fail-closed (zero / negative / non-integer)', () => {
    for (const window of [{ turns: 0 }, { chars: -5 }, { turns: 1.5 }]) {
      const specPath = productDir({
        'support_responder.responder.json': validConfig({ history_window: window }),
      });
      expect(() =>
        buildTurnResponder({ RAYSPEC_RESPONDER_MODE: 'deterministic' }, specPath, SPEC, DB, {
          deterministicResponderBackend: FAKE_BACKEND,
        }),
      ).toThrow(/history_window\.(turns|chars) must be a positive integer/);
    }
  });

  it('a store_context limit above the STORE_READ cap fail-closes', () => {
    const specPath = productDir({
      'support_responder.responder.json': validConfig({
        store_context: { store: 'catalog', limit: 5000 },
      }),
    });
    expect(() =>
      buildTurnResponder({ RAYSPEC_RESPONDER_MODE: 'deterministic' }, specPath, SPEC, DB, {
        deterministicResponderBackend: FAKE_BACKEND,
      }),
    ).toThrow(/store_context\.limit must be a positive integer/);
  });

  it('a store_context filter key outside the closed payload-key set fail-closes', () => {
    const specPath = productDir({
      'support_responder.responder.json': validConfig({
        store_context: { store: 'catalog', filter: { col: 'tenant_id' }, limit: 10 },
      }),
    });
    expect(() =>
      buildTurnResponder({ RAYSPEC_RESPONDER_MODE: 'deterministic' }, specPath, SPEC, DB, {
        deterministicResponderBackend: FAKE_BACKEND,
      }),
    ).toThrow(/only the closed turn-payload keys/);
  });

  it('a VALID deterministic build threads agentId/window/storeContext onto the responder instances', () => {
    const specPath = productDir({
      'support_responder.responder.json': validConfig({
        history_window: { turns: 6, chars: 2048 },
        store_context: { store: 'catalog', filter: { conversation: 'conversation_id' }, limit: 25 },
      }),
    });
    const factory = buildTurnResponder(
      { RAYSPEC_RESPONDER_MODE: 'deterministic' },
      specPath,
      SPEC,
      DB,
      { deterministicResponderBackend: FAKE_BACKEND },
    );
    const responder = factory('tenant-x');
    expect(responder.agentId).toBe('support_responder');
    expect(responder.historyWindow).toEqual({ turns: 6, chars: 2048 });
    expect(responder.storeContext).toEqual({
      store: 'catalog',
      filter: { conversation: 'conversation_id' },
      limit: 25,
    });
  });
});
