/**
 * `loadExtensions` fail-closed + merge tests — FAIL-THE-FIX.
 *
 * Each asserts a real fail-closed property of the pack mechanism (so weakening it breaks a test):
 *   - VERSION-PIN FAIL-CLOSED: a manifest version ≠ the spec's exact `ref.version` pin ABORTS (the
 *     the silent-skip class — never a silent skip);
 *   - PATH-JAIL FAIL-CLOSED: a `..`/absolute `module` is rejected; a bare npm specifier is rejected
 *     (the npm branch is not built here — directory-only); a `..`-escaping pack HANDLER module is
 *     rejected (jailed against the pack root);
 *   - NON-MANIFEST FAIL-CLOSED: an entry whose default export is not a `defineExtension(...)` is rejected;
 *   - MULTI-ROOT MERGE: a pack's fragments merge + the returned importer redirects the rewritten
 *     virtual handler path to the REAL pack file (the multi-root resolution that keeps deploy()
 *     byte-unchanged);
 *   - CAPABILITY COLLISION: two packs both providing a blobFactory is a fail-closed collision.
 *
 * No DB. The pack entry is provided via an INJECTED importer (a fake module namespace), so these run
 * fast + deterministic without an on-disk pack — except the rewrite test, which asserts the importer
 * maps the virtual path to the jailed-real path the loader would import.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModuleImporter } from '../handlers/loader.js';
import { defineExtension, type ExtensionManifest } from './extension.js';
import { ExtensionLoadError, type ExtensionRefLike, loadExtensions } from './load-extensions.js';

/** A fake importer: maps an absolute entry path → a module namespace `{ default: <manifest> }`. */
function fakeImporter(byPath: Map<string, Record<string, unknown>>): ModuleImporter {
  return async (absolutePath: string) => {
    const mod = byPath.get(absolutePath);
    if (!mod) throw new Error(`fake importer: nothing registered for ${absolutePath}`);
    return mod;
  };
}

/** A minimal valid manifest (one store + one handler) at version `v`. */
function manifest(v: string): ExtensionManifest {
  return {
    version: v,
    fragments: {
      stores: [{ name: 'pack_store', columns: [{ name: 'foo', type: 'text' }] }],
      handlers: [{ id: 'pack_h', module: 'handlers/h.ts', export: 'run', kind: 'route' }],
      api: [
        {
          method: 'POST',
          path: '/pack',
          action: { kind: 'handler', handler: 'pack_h' },
        },
      ],
    },
  };
}

describe('loadExtensions — fail-closed resolution + merge', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'rayspec-ext-test-'));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const ref = (over: Partial<ExtensionRefLike> = {}): ExtensionRefLike => ({
    id: 'p1',
    module: './pack',
    version: '1.0.0',
    ...over,
  });

  it('empty extensions[] is a strict NO-OP (no fragments, default importer)', async () => {
    const out = await loadExtensions([], { packsRoot: root, deploymentRoot: root });
    expect(out.stores).toEqual([]);
    expect(out.handlers).toEqual([]);
    expect(out.api).toEqual([]);
    expect(out.packHandlerRoots).toEqual([]);
  });

  it('merges a pack: stores/handlers/api fragments + rewrites the handler module to a virtual path', async () => {
    const entry = resolve(root, 'pack', 'index.ts');
    const importer = fakeImporter(
      new Map([[entry, { default: defineExtension(manifest('1.0.0')) }]]),
    );
    const out = await loadExtensions([ref()], { packsRoot: root, deploymentRoot: root, importer });

    expect(out.stores).toHaveLength(1);
    expect(out.stores[0]?.name).toBe('pack_store');
    // Zod default applied at load (a store gets `foreignKeys: []`).
    expect(out.stores[0]?.foreignKeys).toEqual([]);
    expect(out.api).toHaveLength(1);
    expect(out.handlers).toHaveLength(1);
    // The handler module was REWRITTEN to a jail-safe virtual path under the deployment root. The
    // virtual segment is `<refIndex>__<sanitize(id)>` (FIX C — refIndex makes it collision-proof).
    expect(out.handlers[0]?.module).toMatch(/^\.rayspec-ext\/0__p1\/0__h\.ts$/);
    // The pack handler root is discovered.
    expect(out.packHandlerRoots).toEqual([resolve(root, 'pack')]);
  });

  it('the returned importer maps the virtual handler path → the REAL pack file', async () => {
    const entry = resolve(root, 'pack', 'index.ts');
    // The fake importer answers BOTH the entry AND the real handler file (so we can prove the redirect).
    const realHandler = resolve(root, 'pack', 'handlers', 'h.ts');
    const importer = fakeImporter(
      new Map([
        [entry, { default: defineExtension(manifest('1.0.0')) }],
        [realHandler, { run: () => 'real-handler' }],
      ]),
    );
    const out = await loadExtensions([ref()], { packsRoot: root, deploymentRoot: root, importer });
    // The loader would call out.importer with the JAILED-virtual absolute path; it must resolve to the
    // REAL pack file (not the virtual one — which does not exist on disk).
    const virtualAbsolute = resolve(root, out.handlers[0]?.module ?? '');
    const mod = await out.importer(virtualAbsolute);
    expect(typeof mod.run).toBe('function');
    expect((mod.run as () => string)()).toBe('real-handler');
    // A NON-virtual path falls through to the underlying importer unchanged (a deployment's own handler).
    await expect(out.importer(realHandler)).resolves.toMatchObject({ run: expect.any(Function) });
  });

  it('VERSION-PIN FAIL-CLOSED: a manifest version ≠ the ref pin ABORTS (never a silent skip)', async () => {
    const entry = resolve(root, 'pack', 'index.ts');
    // The pack declares 2.0.0; the spec pins 1.0.0 → a SKEW must abort.
    const importer = fakeImporter(
      new Map([[entry, { default: defineExtension(manifest('2.0.0')) }]]),
    );
    await expect(
      loadExtensions([ref({ version: '1.0.0' })], {
        packsRoot: root,
        deploymentRoot: root,
        importer,
      }),
    ).rejects.toThrow(/version SKEW/);
    // The skew is NOT silently skipped (it would be the silent-skip class): the error names both versions.
    await expect(
      loadExtensions([ref({ version: '1.0.0' })], {
        packsRoot: root,
        deploymentRoot: root,
        importer,
      }),
    ).rejects.toThrow(ExtensionLoadError);
  });

  it('NON-MANIFEST FAIL-CLOSED: an entry not default-exporting defineExtension(...) is rejected', async () => {
    const entry = resolve(root, 'pack', 'index.ts');
    // A plain object (NOT branded) — must be rejected.
    const importer = fakeImporter(
      new Map([[entry, { default: { version: '1.0.0', fragments: {} } }]]),
    );
    await expect(
      loadExtensions([ref()], { packsRoot: root, deploymentRoot: root, importer }),
    ).rejects.toThrow(/does not default-export a defineExtension/);
  });

  it('PATH-JAIL FAIL-CLOSED: a `..` module escape is rejected', async () => {
    await expect(
      loadExtensions([ref({ module: '../outside' })], { packsRoot: root, deploymentRoot: root }),
    ).rejects.toThrow(/traversal|OUTSIDE|UNDER/);
  });

  it('PATH-JAIL FAIL-CLOSED: an absolute module is rejected', async () => {
    await expect(
      loadExtensions([ref({ module: '/etc' })], { packsRoot: root, deploymentRoot: root }),
    ).rejects.toThrow(ExtensionLoadError);
  });

  it('NPM-STYLE FAIL-CLOSED: a bare npm specifier is rejected (directory-only — npm branch not built)', async () => {
    await expect(
      loadExtensions([ref({ module: '@scope/some-pack' })], {
        packsRoot: root,
        deploymentRoot: root,
      }),
    ).rejects.toThrow(/npm package specifier|directory-only/);
  });

  it('PACK-HANDLER JAIL: a `..`-escaping pack HANDLER module is rejected (jailed against the pack root)', async () => {
    const entry = resolve(root, 'pack', 'index.ts');
    const bad: ExtensionManifest = {
      version: '1.0.0',
      // `handlers/../../escape.ts` stays under `handlers/` lexically at segment 0 but carries a `..` —
      // the handlers/-dir gate rejects the `..` segment outright (it would climb out of the subtree).
      fragments: {
        handlers: [{ id: 'h', module: 'handlers/../../escape.ts', export: 'run', kind: 'route' }],
      },
    };
    const importer = fakeImporter(new Map([[entry, { default: defineExtension(bad) }]]));
    await expect(
      loadExtensions([ref()], { packsRoot: root, deploymentRoot: root, importer }),
    ).rejects.toThrow(/traversal|OUTSIDE|UNDER|under the pack's `handlers\/`/);
  });

  it('DUP pack id is rejected', async () => {
    const entry = resolve(root, 'pack', 'index.ts');
    const importer = fakeImporter(
      new Map([[entry, { default: defineExtension(manifest('1.0.0')) }]]),
    );
    await expect(
      loadExtensions([ref(), ref()], { packsRoot: root, deploymentRoot: root, importer }),
    ).rejects.toThrow(/referenced more than once/);
  });

  it('MALFORMED FRAGMENT FAIL-CLOSED: a store fragment with an unknown ColumnType is rejected at load', async () => {
    const entry = resolve(root, 'pack', 'index.ts');
    const bad: ExtensionManifest = {
      version: '1.0.0',
      // `bytea` is NOT a valid ColumnType (closed enum) — must fail at the per-fragment schema gate.
      fragments: { stores: [{ name: 's', columns: [{ name: 'b', type: 'bytea' as never }] }] },
    };
    const importer = fakeImporter(new Map([[entry, { default: defineExtension(bad) }]]));
    await expect(
      loadExtensions([ref()], { packsRoot: root, deploymentRoot: root, importer }),
    ).rejects.toThrow(/store fragment is malformed/);
  });

  // ── FIX A: the loader accept-surface == the gate scan-surface (`<packDir>/handlers/`) ──────────────
  describe('FIX A — a pack handler module OUTSIDE handlers/ is rejected (else it loads UNSCANNED)', () => {
    it('REJECTS a handler module at a non-handlers/ in-pack path (e.g. lib/x.ts)', async () => {
      const entry = resolve(root, 'pack', 'index.ts');
      // `lib/x.ts` is a valid in-pack path the PACK-ROOT jail accepts (it is inside the pack) — but it
      // is NOT under `handlers/`, so BOTH gates' `<packDir>/handlers/` walk would never scan it. BEFORE
      // FIX A this loaded happily (a forbidden import / a self-built raw DB went undetected). It must
      // now FAIL CLOSED at load.
      const bad: ExtensionManifest = {
        version: '1.0.0',
        fragments: {
          handlers: [{ id: 'h', module: 'lib/x.ts', export: 'run', kind: 'route' }],
        },
      };
      const importer = fakeImporter(new Map([[entry, { default: defineExtension(bad) }]]));
      await expect(
        loadExtensions([ref()], { packsRoot: root, deploymentRoot: root, importer }),
      ).rejects.toThrow(/not under the pack's `handlers\/` directory/);
    });

    it('REJECTS a handler module at the pack root (no handlers/ prefix, e.g. x.ts)', async () => {
      const entry = resolve(root, 'pack', 'index.ts');
      const bad: ExtensionManifest = {
        version: '1.0.0',
        fragments: {
          handlers: [{ id: 'h', module: 'x.ts', export: 'run', kind: 'route' }],
        },
      };
      const importer = fakeImporter(new Map([[entry, { default: defineExtension(bad) }]]));
      await expect(
        loadExtensions([ref()], { packsRoot: root, deploymentRoot: root, importer }),
      ).rejects.toThrow(/not under the pack's `handlers\/` directory/);
    });

    it('ACCEPTS a handler module under handlers/ (incl. a nested handlers/sub/x.ts and a leading ./)', async () => {
      const entry = resolve(root, 'pack', 'index.ts');
      const ok: ExtensionManifest = {
        version: '1.0.0',
        fragments: {
          handlers: [
            { id: 'h1', module: 'handlers/h.ts', export: 'run', kind: 'route' },
            { id: 'h2', module: './handlers/nested/deep.ts', export: 'run', kind: 'route' },
          ],
        },
      };
      const importer = fakeImporter(new Map([[entry, { default: defineExtension(ok) }]]));
      const out = await loadExtensions([ref()], {
        packsRoot: root,
        deploymentRoot: root,
        importer,
      });
      expect(out.handlers).toHaveLength(2);
    });
  });

  // ── a pack may contribute an `agents` fragment (the ONE core add for pack agents) ────────────
  describe('agents fragment — a pack contributes OOTB agents', () => {
    /** A manifest with an agent that references a pack-declared tool (which references a pack handler). */
    function manifestWithAgent(): ExtensionManifest {
      return {
        version: '1.0.0',
        fragments: {
          handlers: [
            { id: 'pack_tool_h', module: 'handlers/tool.ts', export: 'run', kind: 'tool' },
          ],
          tooling: [
            {
              id: 'pack_lookup',
              name: 'pack_lookup',
              description: 'a pack tool',
              parameters: { type: 'object', properties: {} },
              handler: 'pack_tool_h',
              idempotent: true,
              timeoutMs: 1000,
            },
          ],
          agents: [
            {
              id: 'pack_agent',
              name: 'Pack Agent',
              instructions: 'you are a pack agent',
              model: 'gpt-4o-mini',
              backend: 'openai',
              tools: ['pack_lookup'],
            },
          ],
        },
      };
    }

    it('MERGES a pack `agents` fragment into the returned `agents[]` (FAIL-THE-FIX: drop the merge → empty)', async () => {
      const entry = resolve(root, 'pack', 'index.ts');
      const importer = fakeImporter(
        new Map([[entry, { default: defineExtension(manifestWithAgent()) }]]),
      );
      const out = await loadExtensions([ref()], {
        packsRoot: root,
        deploymentRoot: root,
        importer,
      });
      // The pack agent is in the merged agents[] — INDISTINGUISHABLE from a deployment agent. Removing
      // the `for (… fragments.agents …) agents.push(…)` thread makes this length 0 → the test fails.
      expect(out.agents).toHaveLength(1);
      expect(out.agents[0]?.id).toBe('pack_agent');
      expect(out.agents[0]?.backend).toBe('openai');
      // Zod defaults applied at load (the wrap's `tools` default + requireNativeStructuredOutput).
      expect(out.agents[0]?.tools).toEqual(['pack_lookup']);
      expect(out.agents[0]?.requireNativeStructuredOutput).toBe(false);
      // The agent's tool + its handler merged alongside (so the post-merge lint can resolve the ref).
      expect(out.tooling.map((t) => t.id)).toContain('pack_lookup');
      expect(out.handlers.map((h) => h.id)).toContain('pack_tool_h');
    });

    it('MALFORMED AGENT FRAGMENT FAIL-CLOSED: an unknown key on an agent is rejected at load', async () => {
      const entry = resolve(root, 'pack', 'index.ts');
      const bad: ExtensionManifest = {
        version: '1.0.0',
        // `outputFormat` is not an AgentSpecConfig key — `.strict()` must reject it at the per-fragment gate.
        fragments: {
          agents: [
            {
              id: 'a',
              name: 'A',
              instructions: 'i',
              model: 'm',
              backend: 'openai',
              outputFormat: 'json',
            } as never,
          ],
        },
      };
      const importer = fakeImporter(new Map([[entry, { default: defineExtension(bad) }]]));
      await expect(
        loadExtensions([ref()], { packsRoot: root, deploymentRoot: root, importer }),
      ).rejects.toThrow(/agent fragment is malformed/);
    });
  });

  // ── FIX C: two packs whose ids sanitize-collide must NOT cross-wire their handlers ────────────────
  it('FIX C — sanitize-colliding pack ids map to DISTINCT virtual paths (no cross-wiring)', async () => {
    // `good@pack` and `good_pack` are DISTINCT raw ids (seenIds does not dedup them) but `sanitize()`
    // maps both to `good_pack`. BEFORE FIX C the virtual path `.rayspec-ext/good_pack/0__h.ts`
    // collided → virtualToReal last-write-wins → pack1's declared handler resolved to pack2's REAL
    // file. With the refIndex prefix the two virtual paths differ; each maps to ITS OWN real file.
    const entry1 = resolve(root, 'packA', 'index.ts');
    const entry2 = resolve(root, 'packB', 'index.ts');
    const realH1 = resolve(root, 'packA', 'handlers', 'h.ts');
    const realH2 = resolve(root, 'packB', 'handlers', 'h.ts');
    const mk = (): ExtensionManifest => ({
      version: '1.0.0',
      fragments: {
        handlers: [{ id: 'h', module: 'handlers/h.ts', export: 'run', kind: 'route' }],
      },
    });
    const importer = fakeImporter(
      new Map<string, Record<string, unknown>>([
        [entry1, { default: defineExtension(mk()) }],
        [entry2, { default: defineExtension(mk()) }],
        [realH1, { run: () => 'real-A' }],
        [realH2, { run: () => 'real-B' }],
      ]),
    );
    const out = await loadExtensions(
      [
        { id: 'good@pack', module: './packA', version: '1.0.0' },
        { id: 'good_pack', module: './packB', version: '1.0.0' },
      ],
      { packsRoot: root, deploymentRoot: root, importer },
    );
    expect(out.handlers).toHaveLength(2);
    // The two virtual paths MUST differ (no collision).
    const m0 = out.handlers[0]?.module ?? '';
    const m1 = out.handlers[1]?.module ?? '';
    expect(m0).not.toBe(m1);
    // Each virtual path resolves to ITS OWN pack's real handler (NOT cross-wired).
    const modA = await out.importer(resolve(root, m0));
    const modB = await out.importer(resolve(root, m1));
    expect((modA.run as () => string)()).toBe('real-A');
    expect((modB.run as () => string)()).toBe('real-B');
  });
});
