/**
 * THE CLAIMED-SECTION SEAM, END TO END, against a REAL pack.
 *
 * `packages/test/fixture-pack` is an in-tree extension pack: a normal `@rayspec/*` workspace member
 * (so the CI filters build and typecheck it — a fixture excluded from CI proves nothing), compiled to
 * JavaScript by its own `tsc -b` (so the loader, which imports compiled JavaScript only, can load it),
 * claiming one top-level section (`auditing`) and shipping the validator for it. The deployment
 * documents beside it are what this suite runs the three commands against, so every step here is the
 * real one: the real loader, the real path jail, the real exact version pin, the pack's own validator.
 *
 * WHAT IT PINS, one case per seam behaviour:
 *   • a valid claimed section parses — and each of `doctor`, `plan` and `deploy --dry-run` reports the
 *     SAME single neutral line for it, naming the section key and the pack that claims it;
 *   • a malformed claimed section is refused by the PACK's validator, at `auditing.<field>`, with the
 *     pack's own wording — nothing in the core grammar can see into that section, so a violation
 *     reported for it can only have come from the pack;
 *   • the SAME document on a deployment that does not have the pack fails with the typed
 *     `extension_pack_unavailable` naming the pack — never as an unknown field on the section, which
 *     would send an operator to delete the configuration instead of installing the pack;
 *   • the exact version pin is load-bearing: a document whose pin does not match the manifest is
 *     `extension_pack_refused` — the pack is present, so deploying it again changes nothing.
 *   • `plan --against` judges its BASELINE by the packs of the deployment being planned, from a
 *     baseline file held outside the deployment tree — which is where an operator's prior revision
 *     actually lives;
 *   • `deploy --dry-run` states, in the verdict, the one thing `ok:true` does not mean for a document
 *     that WRITES a claimed key: the boot validates it with the core grammar alone and refuses that
 *     key — while a document that references the same pack and writes none of the keys it claims is
 *     accepted by that same grammar, and is told no such thing.
 *
 * NO DATABASE, NO NETWORK, NO SECRET: `doctor` and a backend `--dry-run` touch none, and the fixture
 * document declares no store, so `plan`'s optional shadow-apply has nothing to apply and never runs.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpecError } from '@rayspec/spec';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runDeploy } from './deploy.js';
import { runDoctor } from './doctor.js';
import { runPlan } from './plan.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');

/** The fixture pack's directory, and the deployment documents that reference it. */
const PACK_DIR = 'packages/test/fixture-pack';
const VALID_DOC = `${PACK_DIR}/rayspec.yaml`;
const INVALID_SECTION_DOC = `${PACK_DIR}/rayspec.invalid-section.yaml`;
const VERSION_SKEW_DOC = `${PACK_DIR}/rayspec.version-skew.yaml`;
const RANGE_PIN_DOC = `${PACK_DIR}/rayspec.range-pin.yaml`;
/** The same pack, the same pin, and the claimed section NOT written. */
const NO_SECTION_DOC = `${PACK_DIR}/rayspec.no-section.yaml`;

/**
 * The ONE line each command reports for the section this pack claims. It names the key and the pack,
 * and states nothing else: whether the document writes the section, and whether what it wrote is
 * valid, are the commands' own verdicts and are reported as those.
 */
const CLAIMED_LINE = "section 'auditing' is claimed by extension pack 'fixture-pack'";

// The pack has to have been BUILT — the loader imports compiled JavaScript only. `test` runs after
// `^build` in the task graph and the pack is a declared devDependency of this package, so any
// turbo-driven run has it; a bare vitest invocation might not. FAIL, loudly and with the fix, rather
// than skip: a skipped seam proof is a green that means nothing.
const PACK_ENTRY = join(repoRoot, PACK_DIR, 'dist/index.js');
if (!existsSync(PACK_ENTRY)) {
  throw new Error(
    `the fixture pack is not built (${PACK_ENTRY} is absent) — run \`pnpm build\` before this suite; ` +
      'the loader imports compiled JavaScript only, so an unbuilt pack is an absent pack.',
  );
}

// The spec-path jail resolves against the CWD, so every command runs from the repo root (the fixture
// documents are inside it). The missing-pack case chdirs into its own throwaway tree instead.
let prevCwd: string;
beforeEach(() => {
  prevCwd = process.cwd();
  process.chdir(repoRoot);
});
afterEach(() => {
  process.chdir(prevCwd);
});

/** Render a violation list compactly, so a failure names what was actually reported. */
function show(errors: readonly SpecError[]): string {
  return JSON.stringify(errors, null, 2);
}

describe('a claimed section is visible to an operator — one neutral line, from all three commands', () => {
  it('doctor: the document validates and reports the line', async () => {
    const result = await runDoctor([VALID_DOC]);
    expect(result.errors, show(result.errors)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.claimedSections).toEqual([CLAIMED_LINE]);
  });

  it('plan: the same line, from the command operators debug with', async () => {
    const result = await runPlan([VALID_DOC], { shadowDatabaseUrl: undefined });
    expect(result.errors, show(result.errors)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.claimedSections).toEqual([CLAIMED_LINE]);
  });

  it('deploy --dry-run: the same line again', async () => {
    const outcome = await runDeploy(['--dry-run', VALID_DOC]);
    if (outcome.kind !== 'dry-run') throw new Error('expected a dry-run verdict');
    expect(outcome.result.errors, JSON.stringify(outcome.result.errors)).toEqual([]);
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.claimedSections).toEqual([CLAIMED_LINE]);
  });

  it('the three commands report the SAME line — one loader, one sentence', async () => {
    const doctor = await runDoctor([VALID_DOC]);
    const plan = await runPlan([VALID_DOC], { shadowDatabaseUrl: undefined });
    const dryRun = await runDeploy(['--dry-run', VALID_DOC]);
    if (dryRun.kind !== 'dry-run') throw new Error('expected a dry-run verdict');
    expect(plan.claimedSections).toEqual(doctor.claimedSections);
    expect(dryRun.result.claimedSections).toEqual(doctor.claimedSections);
  });
});

describe('the claimed section reaches the pack that owns it', () => {
  it('a malformed section is refused by the PACK validator, at `auditing.<field>`', async () => {
    const result = await runDoctor([INVALID_SECTION_DOC]);
    expect(result.ok).toBe(false);
    // Both violations are the pack's own: the core grammar cannot see into a section it does not own.
    expect(result.errors, show(result.errors)).toEqual([
      {
        code: 'unknown_field',
        message: "unknown field 'retainForever' (unknown keys are rejected)",
        path: 'auditing.retainForever',
      },
      {
        code: 'schema_violation',
        message:
          'retentionDays must be an integer of at least 1 (the audit retention window in days)',
        path: 'auditing.retentionDays',
      },
    ]);
  });

  it('the section is NOT reported as an unknown top-level field — the pack owns the key', async () => {
    const result = await runDoctor([VALID_DOC]);
    expect(result.errors.map((e) => e.code)).not.toContain('unknown_field');
  });

  it('plan and deploy --dry-run refuse the malformed section too, with the same violations', async () => {
    const doctor = await runDoctor([INVALID_SECTION_DOC]);
    const plan = await runPlan([INVALID_SECTION_DOC], { shadowDatabaseUrl: undefined });
    expect(plan.ok).toBe(false);
    expect(plan.phase).toBe('validate');
    expect(plan.errors).toEqual(doctor.errors);

    const dryRun = await runDeploy(['--dry-run', INVALID_SECTION_DOC]);
    if (dryRun.kind !== 'dry-run') throw new Error('expected a dry-run verdict');
    expect(dryRun.result.ok).toBe(false);
    expect(dryRun.result.errors.join('\n')).toContain('auditing.retentionDays');
  });
});

describe("the exact version pin is the loader's, and it is load-bearing", () => {
  it('a pin the manifest does not declare is `extension_pack_refused` — the pack IS here', async () => {
    const result = await runDoctor([VERSION_SKEW_DOC]);
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toEqual(['extension_pack_refused']);
    const [error] = result.errors;
    expect(error?.path).toBe('extensions[0]');
    expect(error?.message).toContain("pins version '9.9.9'");
    expect(error?.message).toContain("manifest declares version '1.0.0'");
    // No claim was resolved, so there is no line to report — and none is invented.
    expect(result.claimedSections).toBeUndefined();
  });

  it('a pin that is a RANGE reports the pin error and NOTHING about the section it declares', async () => {
    const result = await runDoctor([RANGE_PIN_DOC]);
    expect(result.ok).toBe(false);
    // Which keys the packs own is unknowable while the reference does not typecheck, so the verdict
    // says only that. An `unknown_field` on `auditing` here is the report this whole seam exists to
    // avoid: it names the wrong line and prescribes the wrong fix.
    expect(result.errors.map((e) => e.path)).toEqual(['extensions[0].version']);
    expect(show(result.errors)).not.toContain('auditing');
    expect(result.errors.map((e) => e.code)).not.toContain('unknown_field');
  });
});

describe('the SAME document on a deployment WITHOUT the pack', () => {
  let root = '';
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'rayspec-fixture-pack-absent-'));
    // Byte-for-byte the document that parses beside the pack — only the deployment tree differs.
    writeFileSync(
      join(root, 'rayspec.yaml'),
      readFileSync(join(repoRoot, VALID_DOC), 'utf8'),
      'utf8',
    );
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('fails with the typed missing-pack error, naming the pack — never an unknown field', async () => {
    process.chdir(root);
    const result = await runDoctor(['rayspec.yaml']);
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toEqual(['extension_pack_unavailable']);
    const [error] = result.errors;
    expect(error?.path).toBe('extensions[0]');
    expect(error?.message).toContain("extension pack 'fixture-pack' is not available");
    // The remedy the operator is sent to must be "install the pack", not "delete the section".
    expect(show(result.errors)).not.toContain('unknown field');
  });

  it('plan and deploy --dry-run report the same typed failure', async () => {
    process.chdir(root);
    const plan = await runPlan(['rayspec.yaml'], { shadowDatabaseUrl: undefined });
    expect(plan.ok).toBe(false);
    expect(plan.errors.map((e) => e.code)).toEqual(['extension_pack_unavailable']);

    const dryRun = await runDeploy(['--dry-run', 'rayspec.yaml']);
    if (dryRun.kind !== 'dry-run') throw new Error('expected a dry-run verdict');
    expect(dryRun.result.ok).toBe(false);
    expect(dryRun.result.errors.join('\n')).toContain('extension_pack_unavailable');
  });
});

describe('a pack-free document is untouched', () => {
  const DOC = "version: '1.0'\nmetadata:\n  name: no-packs-here\n";
  let root = '';
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'rayspec-fixture-pack-free-'));
    writeFileSync(join(root, 'rayspec.yaml'), DOC, 'utf8');
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('carries NO claimed-section field at all, in any of the three envelopes', async () => {
    process.chdir(root);
    const doctor = await runDoctor(['rayspec.yaml']);
    expect(doctor.ok).toBe(true);
    expect('claimedSections' in doctor).toBe(false);

    const plan = await runPlan(['rayspec.yaml'], { shadowDatabaseUrl: undefined });
    expect(plan.ok).toBe(true);
    expect('claimedSections' in plan).toBe(false);

    const dryRun = await runDeploy(['--dry-run', 'rayspec.yaml']);
    if (dryRun.kind !== 'dry-run') throw new Error('expected a dry-run verdict');
    expect(dryRun.result.ok).toBe(true);
    expect('claimedSections' in dryRun.result).toBe(false);
  });

  it("keeps the dry-run boundary list it had — the claimed-section line is a claim's, not everyone's", async () => {
    process.chdir(root);
    const dryRun = await runDeploy(['--dry-run', 'rayspec.yaml']);
    if (dryRun.kind !== 'dry-run') throw new Error('expected a dry-run verdict');
    expect(dryRun.result.notProven.join('\n')).not.toContain('extension pack claims');
  });
});

/**
 * `plan --against` — the BASELINE is a diff INPUT, and the deployment is the new document's.
 *
 * An operator produces a prior revision wherever it suits them (`git show HEAD~1:rayspec.yaml > …`),
 * so the file holding it is almost never inside the deployment tree. It is still a prior revision of
 * THIS deployment's document, so the packs that can validate it are the ones installed here. Resolving
 * them from the baseline FILE's own directory answers with a pack set this deployment does not have —
 * and reports `extension_pack_unavailable` for a pack that is deployed, which is the wrong-remedy
 * report this whole seam exists to remove.
 *
 * The baseline is written to a throwaway directory under the repo root because `--against` is jailed to
 * the working directory (the repo root, as everywhere in this suite) — and the point of the case is a
 * baseline OUTSIDE `packages/test/fixture-pack`.
 */
describe("plan --against: the baseline is judged by the DEPLOYMENT's packs", () => {
  let baselineDir = '';
  /** The `--against` argument: repo-root-relative (the jail), and outside the deployment tree. */
  const against = (file: string): string => `${basename(baselineDir)}/${file}`;

  beforeAll(() => {
    baselineDir = mkdtempSync(join(repoRoot, '.rayspec-plan-baseline-'));
    // Byte-for-byte the documents that sit beside the pack — only the directory differs, and that
    // directory holds no pack, no `dist/`, nothing.
    for (const doc of [VALID_DOC, INVALID_SECTION_DOC]) {
      writeFileSync(
        join(baselineDir, basename(doc)),
        readFileSync(join(repoRoot, doc), 'utf8'),
        'utf8',
      );
    }
  });
  afterAll(() => {
    rmSync(baselineDir, { recursive: true, force: true });
  });

  it('a prior revision carrying the claimed section no longer blocks the update it is the baseline for', async () => {
    const result = await runPlan([VALID_DOC], {
      against: against('rayspec.yaml'),
      shadowDatabaseUrl: undefined,
    });
    expect(result.errors, show(result.errors)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.claimedSections).toEqual([CLAIMED_LINE]);
  });

  it("the baseline reaches the pack's OWN validator — the deployment's pack, not the baseline directory's", async () => {
    const result = await runPlan([VALID_DOC], {
      against: against('rayspec.invalid-section.yaml'),
      shadowDatabaseUrl: undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.phase).toBe('validate');
    // The pack's own two violations, identical to what `doctor` reports for that document — so the
    // baseline was validated by the pack that owns the section, from a directory that holds no pack.
    const doctor = await runDoctor([INVALID_SECTION_DOC]);
    expect(result.errors, show(result.errors)).toEqual(doctor.errors);
    // The planned document's claim is a fact about the planned document: a baseline that fails later
    // does not unmake it, and the envelope carries it on the refusal too.
    expect(result.claimedSections).toEqual([CLAIMED_LINE]);
  });
});

/**
 * WHAT `deploy --dry-run` DOES NOT PROVE ABOUT A CLAIMED SECTION, stated in the verdict.
 *
 * The preview validates the document with the deployment's packs loaded. The BOOT validates it with
 * the core grammar alone, before it resolves any pack, and that grammar rejects a key it does not own.
 * So for this one class of document `ok:true` is further from "it boots" than anywhere else on this
 * arm, and the verdict says so rather than leaving it to a refused `deploy`.
 *
 * WHICH DOCUMENTS ARE THAT CLASS is what the last two cases pin, and the two facts differ: the pack
 * here CLAIMS `auditing` for both documents, and only one of them WRITES it. The boundary belongs to
 * the one that writes it — the other is written entirely in the grammar the boot has, so telling it
 * that the boot refuses a claimed key would send an operator to `--check-env` to read a refusal that
 * is not there. So the third case runs `--check-env` on it too: the entry is withheld for exactly the
 * reason the boot accepts the document, not by coincidence.
 *
 * The disclosure and the divergence are pinned together, because a disclosure that outlives the
 * divergence is its own kind of false report: when the boot is taught the pack-aware parse, the
 * second case reds and the line goes.
 */
describe('deploy --dry-run names the boot boundary a claimed section has', () => {
  /**
   * A pack-free backend document, under the repo root so the spec-path jail (which resolves against
   * the CWD every case here runs from) accepts it without a chdir. It is the CONTROL for the third
   * case: the boundary list every backend verdict that diverges from the boot in no way receives.
   */
  let packFreeDir = '';
  let packFreeDoc = '';
  beforeAll(() => {
    packFreeDir = mkdtempSync(join(repoRoot, '.rayspec-dry-run-control-'));
    writeFileSync(
      join(packFreeDir, 'rayspec.yaml'),
      "version: '1.0'\nmetadata:\n  name: no-packs-here\n",
      'utf8',
    );
    packFreeDoc = `${basename(packFreeDir)}/rayspec.yaml`;
  });
  afterAll(() => {
    rmSync(packFreeDir, { recursive: true, force: true });
  });

  it('states it in `notProven`, in the same verdict that reports the claim', async () => {
    const dryRun = await runDeploy(['--dry-run', VALID_DOC]);
    if (dryRun.kind !== 'dry-run') throw new Error('expected a dry-run verdict');
    expect(dryRun.result.ok).toBe(true);
    expect(dryRun.result.claimedSections).toEqual([CLAIMED_LINE]);
    expect(dryRun.result.notProven.join('\n')).toContain(
      'that the boot accepts a top-level section an extension pack claims',
    );
  });

  it('and the boot still refuses that document — the fact the line states', async () => {
    // `--check-env` reads `@rayspec/server`'s own boot-env module, the one the boot refusals are
    // composed from, and it loads no pack by design. Its verdict for this document IS the boot's.
    const outcome = await runDeploy(['--check-env', VALID_DOC]);
    if (outcome.kind !== 'check-env') throw new Error('expected a check-env verdict');
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.errors.join('\n')).toContain(
      "spec did not validate: unknown_field at auditing: unknown field 'auditing'",
    );
  });

  it('a document that references the pack and writes NO claimed key keeps the claim line and NOT the boundary', async () => {
    const dryRun = await runDeploy(['--dry-run', NO_SECTION_DOC]);
    if (dryRun.kind !== 'dry-run') throw new Error('expected a dry-run verdict');
    expect(dryRun.result.ok).toBe(true);
    // The pack still claims the key on this deployment, so the ownership line is still reported.
    expect(dryRun.result.claimedSections).toEqual([CLAIMED_LINE]);
    // But nothing here diverges from the boot, so the boundary list is the one every other backend
    // verdict gets. Pinned by EQUALITY against a pack-free document's list, not only by the absence of
    // the sentence: a reworded entry would still be an extra entry, and this catches that too.
    expect(dryRun.result.notProven.join('\n')).not.toContain(
      'that the boot accepts a top-level section an extension pack claims',
    );
    const packFree = await runDeploy(['--dry-run', packFreeDoc]);
    if (packFree.kind !== 'dry-run') throw new Error('expected a dry-run verdict');
    expect(dryRun.result.notProven).toEqual(packFree.result.notProven);

    // And the REASON it is withheld: the boot's own module accepts this document's grammar. Asserted
    // on `errors`, not on `ok` — `ok` also folds in `missing`, which is whatever this environment
    // happens to have set, while every `errors` entry is derived from the document (this one declares
    // no agent, so no backend selection can contribute one either). An empty list here is exactly
    // "the boot raises no refusal for this document", which is what the withheld entry would claim.
    const outcome = await runDeploy(['--check-env', NO_SECTION_DOC]);
    if (outcome.kind !== 'check-env') throw new Error('expected a check-env verdict');
    expect(outcome.result.errors, JSON.stringify(outcome.result.errors)).toEqual([]);
  });
});
