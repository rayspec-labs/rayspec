/**
 * WHETHER `doctor` RUNS CODE OUT OF THE DEPLOYMENT TREE — measured, from both directions.
 *
 * Resolving an extension pack means `import()`ing its entry module: code authored and versioned
 * outside this repository, executing in-process. `doctor` is the first command a reader runs against a
 * repository they have just cloned, and it is documented as a static check of the document — so it
 * resolves no pack unless it is asked to. `--with-packs` asks.
 *
 * The probe is the pack itself: its entry writes a marker file at import, and nothing ever calls it.
 * The marker is therefore a direct reading of "was this module executed", and BOTH directions are
 * pinned, because an absence on its own proves nothing — a probe that never fires reads exactly like a
 * command that never loaded it:
 *
 *   • `doctor <doc>`               → the marker does NOT appear (no pack code ran), and
 *   • `doctor --with-packs <doc>`  → the marker DOES appear (the probe fires, so the absence above is
 *                                    the command's behaviour and not a broken fixture).
 *
 * A FRESH pack directory per case is deliberate: a module URL is imported once per process, so a
 * second run against the same directory would re-read the module cache rather than the pack.
 *
 * The other half of the cost is measured here too. Having loaded no pack, the default run cannot know
 * which top-level keys the deployment's packs claim, so it accepts them unexamined rather than
 * refusing configuration that is in fact correct — and says so, in one neutral line. The accept
 * control for that is the same document under `--with-packs`, where the pack's own validator refuses a
 * malformed section: a default run that accepted because nothing could ever refuse would pass the
 * absence arm and fail that one.
 *
 * No database, no network, no secret: the documents declare no store and the marker is a file inside
 * the throwaway deployment tree.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXTENSION_BRAND } from '@rayspec/platform';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from './doctor.js';
import { main } from './index.js';

/** The top-level key the probe pack claims — owned by the pack, not by the core grammar. */
const CLAIMED_KEY = 'probing';

/** The deployment document: it references the probe pack beside it and writes the claimed section. */
const VALID_DOC = `version: '1.0'
metadata:
  name: doctor-pack-probe
extensions:
  - id: probe-pack
    module: ./probe-pack
    version: 1.0.0
${CLAIMED_KEY}:
  enabled: true
`;

/** The same document with the claimed section MALFORMED — only the pack's validator can say so. */
const MALFORMED_DOC = VALID_DOC.replace('enabled: true', 'enabled: yesterday');

/**
 * The probe pack's entry. It writes `marker` the moment the module is imported — before any manifest
 * is read, and with nothing calling it — then default-exports a manifest the loader accepts. The brand
 * is imported from the platform rather than spelled out, so a pack this loader would refuse cannot
 * masquerade as a measurement of the loader.
 */
function probeEntry(marker: string): string {
  return `import { writeFileSync } from 'node:fs';

writeFileSync(${JSON.stringify(marker)}, 'pack entry executed at import');

export default {
  __rayspecExtension: ${JSON.stringify(EXTENSION_BRAND)},
  version: '1.0.0',
  fragments: {},
  sections: [{ key: ${JSON.stringify(CLAIMED_KEY)}, schemaModule: 'section.ts' }],
};
`;
}

/** The pack's validator for the section it claims: `enabled` must be a boolean, and nothing else. */
const PROBE_SECTION_SCHEMA = `export default {
  safeParse(node) {
    const enabled = node === null || typeof node !== 'object' ? undefined : node.enabled;
    return typeof enabled === 'boolean'
      ? { success: true, data: node }
      : {
          success: false,
          error: {
            issues: [{ path: ['enabled'], message: 'enabled must be a boolean (the probe pack says so)' }],
          },
        };
  },
};
`;

let root: string;
let marker: string;
let prevCwd: string;
let prevHandlerRoot: string | undefined;

/**
 * THE ACCEPT CONTROL FOR THE CLEARING BELOW. A hermeticity guard whose suite passes just as well
 * without it proves nothing, and deleting the `delete` left every arm here green — the guard was
 * measured against an environment that happened to be clean. So the suite dirties its own
 * environment once, ahead of every `beforeEach`, with an EMPTY directory: a nonexistent path could be
 * refused by a path check and never reach the loader, which would make this control pass for a reason
 * unrelated to the redirect. Remove the clearing and the arms that resolve packs measure the decoy.
 */
const AMBIENT_DECOY_PREFIX = join(tmpdir(), 'rayspec-doctor-pack-ambient-decoy-');
let prevAmbientHandlerRoot: string | undefined;
let ambientDecoyDir: string | undefined;
beforeAll(() => {
  prevAmbientHandlerRoot = process.env.RAYSPEC_HANDLER_ROOT;
  ambientDecoyDir = mkdtempSync(AMBIENT_DECOY_PREFIX);
  process.env.RAYSPEC_HANDLER_ROOT = ambientDecoyDir;
});
afterAll(() => {
  if (prevAmbientHandlerRoot === undefined) delete process.env.RAYSPEC_HANDLER_ROOT;
  else process.env.RAYSPEC_HANDLER_ROOT = prevAmbientHandlerRoot;
  if (ambientDecoyDir !== undefined) rmSync(ambientDecoyDir, { recursive: true, force: true });
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rayspec-doctor-pack-probe-'));
  marker = join(root, 'pack-entry-executed.txt');
  const packDir = join(root, 'probe-pack');
  mkdirSync(packDir, { recursive: true });
  // The loader imports compiled JavaScript only, and a `.js` file under this tree is ESM only if a
  // package manifest beside it says so — exactly what a published pack ships.
  writeFileSync(join(packDir, 'package.json'), '{ "type": "module" }\n', 'utf8');
  writeFileSync(join(packDir, 'index.js'), probeEntry(marker), 'utf8');
  writeFileSync(join(packDir, 'section.js'), PROBE_SECTION_SCHEMA, 'utf8');
  writeFileSync(join(root, 'rayspec.yaml'), VALID_DOC, 'utf8');
  writeFileSync(join(root, 'malformed.yaml'), MALFORMED_DOC, 'utf8');
  // The spec path is jailed to the working directory, so every case runs from the deployment tree.
  // `deploymentRootFor` honours RAYSPEC_HANDLER_ROOT OVER `dirname(specPath)` — deliberately, since it
  // mirrors what the boot hands the loader. That makes an ambient value a redirect for a test that
  // resolves packs: it would measure a tree it did not build. Cleared for the run, restored after.
  prevHandlerRoot = process.env.RAYSPEC_HANDLER_ROOT;
  delete process.env.RAYSPEC_HANDLER_ROOT;
  prevCwd = process.cwd();
  process.chdir(root);
});

afterEach(() => {
  process.chdir(prevCwd);
  if (prevHandlerRoot === undefined) delete process.env.RAYSPEC_HANDLER_ROOT;
  else process.env.RAYSPEC_HANDLER_ROOT = prevHandlerRoot;
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Drive the real CLI body and return the parsed JSON envelope it wrote to stdout. */
async function cli(
  args: readonly string[],
): Promise<{ code: number; out: Record<string, unknown> }> {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown, cb?: unknown): boolean => {
    chunks.push(String(chunk));
    if (typeof cb === 'function') (cb as (e?: Error) => void)();
    return true;
  });
  const code = await main(args);
  return { code, out: JSON.parse(chunks.join('')) as Record<string, unknown> };
}

describe('doctor does not run pack code — and the probe that proves it fires', () => {
  it('the default run leaves NO marker: no pack entry was imported', async () => {
    const { code, out } = await cli(['doctor', 'rayspec.yaml']);
    expect(code).toBe(0);
    expect(out.ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it('--with-packs leaves one: the SAME probe fires when the packs are resolved', async () => {
    const { code, out } = await cli(['doctor', '--with-packs', 'rayspec.yaml']);
    expect(code).toBe(0);
    expect(out.ok).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });
});

describe('what the default run says about the sections it did not resolve', () => {
  it('one neutral line, naming the pack it did not load and the section it left unresolved', async () => {
    const result = await runDoctor(['rayspec.yaml']);
    expect(result.ok).toBe(true);
    // ONE line, not a per-section list and not a warning: the document is not wrong.
    expect(result.notResolved).toHaveLength(1);
    const line = (result.notResolved ?? []).join('\n');
    expect(line).toContain('probe-pack');
    expect(line).toContain(CLAIMED_KEY);
    expect(line).toContain('--with-packs');
    // It is not reported as a claim: nothing resolved an owner for the key.
    expect('claimedSections' in result).toBe(false);
  });

  it('--with-packs reports the claim instead, and nothing left unresolved', async () => {
    const result = await runDoctor(['rayspec.yaml'], { withPacks: true });
    expect(result.ok).toBe(true);
    expect(result.claimedSections).toEqual([
      `section '${CLAIMED_KEY}' is claimed by extension pack 'probe-pack'`,
    ]);
    expect('notResolved' in result).toBe(false);
  });

  it('a pack-free document carries neither key — its envelope is untouched', async () => {
    writeFileSync(join(root, 'plain.yaml'), "version: '1.0'\nmetadata:\n  name: plain\n", 'utf8');
    const result = await runDoctor(['plain.yaml']);
    expect(result.ok).toBe(true);
    expect('notResolved' in result).toBe(false);
    expect('claimedSections' in result).toBe(false);
  });
});

describe('the accept control: the section is left unexamined, not silently accepted by a broken pack', () => {
  it('the default run accepts a MALFORMED claimed section — it resolved no owner for the key', async () => {
    const result = await runDoctor(['malformed.yaml']);
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    // The remedy an operator must not be sent to: deleting configuration a pack owns.
    expect(JSON.stringify(result.errors)).not.toContain('unknown_field');
    expect((result.notResolved ?? []).join('\n')).toContain(CLAIMED_KEY);
  });

  it('--with-packs refuses it, in the pack validator’s own words', async () => {
    const result = await runDoctor(['malformed.yaml'], { withPacks: true });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.path)).toContain(`${CLAIMED_KEY}.enabled`);
    expect(JSON.stringify(result.errors)).toContain('the probe pack says so');
  });
});
