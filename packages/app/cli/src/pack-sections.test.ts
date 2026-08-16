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
 *   • a claimed section carries NO boot boundary: the boot resolves the deployment's packs before it
 *     validates the document, so a document that WRITES a claimed key gets the same verdict — and the
 *     same boundary list — as one that only references the pack.
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
/** The same pack, the same pin, and the claimed key MISTYPED — so NO pack claims it. */
const MISTYPED_KEY_DOC = `${PACK_DIR}/rayspec.mistyped-key.yaml`;

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
 * A CLAIMED SECTION CARRIES NO BOOT BOUNDARY — and this is where the disclosure that said it did used
 * to live.
 *
 * It said the boot validated a document with the core grammar alone, before it resolved any pack, and
 * therefore refused a top-level key a pack claims. That was true, and it is not any more: the boot now
 * resolves the deployment's packs BEFORE it validates the document (a pack's `services` contribution
 * is handed its own validated section, which is impossible on any other ordering), so a claimed
 * section boots exactly as this preview validated it. A disclosure that outlives the divergence it
 * disclosed is its own kind of false report, so the disclosure is gone and these cases hold the
 * ABSENCE in place from both directions:
 *
 *   • the dry-run verdict for a document that WRITES a claimed key is now the boundary list every
 *     other backend verdict gets — pinned by EQUALITY against a pack-free document's list, so a
 *     reworded reintroduction is caught as well as a verbatim one;
 *   • `--check-env`, which reads `@rayspec/server`'s own boot-env module and loads no pack by design,
 *     no longer reports a refusal for it either. It cannot validate the section — nothing was loaded
 *     that could — so it says so in `notChecked` rather than refusing a key whose owner it never
 *     asked about;
 *   • and the PRICE of that, measured rather than assumed: having loaded no pack it cannot tell a
 *     claimed key from a MISTYPED one, so on a pack-bearing document it lifts out both. The last two
 *     cases pin that divergence from each side — `doctor`, which does load the packs, refuses the
 *     mistyped document that `--check-env` accepts, and the same key on a PACK-FREE document is still
 *     refused by `--check-env` itself, so the lift is demonstrably what silences it.
 */
describe('deploy --dry-run reports a claimed section with no boot boundary attached', () => {
  /**
   * A pack-free backend document, under the repo root so the spec-path jail (which resolves against
   * the CWD every case here runs from) accepts it without a chdir. It is the CONTROL: the boundary
   * list every backend verdict receives, whether or not its packs claim anything.
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

  it.each([
    ['a document that WRITES the claimed key', () => VALID_DOC],
    ['a document that references the pack and writes NONE', () => NO_SECTION_DOC],
  ])('%s reports the claim line and the ordinary boundary list', async (_what, doc) => {
    const dryRun = await runDeploy(['--dry-run', doc()]);
    if (dryRun.kind !== 'dry-run') throw new Error('expected a dry-run verdict');
    expect(dryRun.result.ok).toBe(true);
    // The pack claims the key on this deployment either way, so the ownership line is reported either
    // way — it states ownership and nothing else.
    expect(dryRun.result.claimedSections).toEqual([CLAIMED_LINE]);
    // Pinned by EQUALITY against a pack-free document's list, not by the absence of one sentence: a
    // reworded entry would still be an extra entry, and this catches that too.
    const packFree = await runDeploy(['--dry-run', packFreeDoc]);
    if (packFree.kind !== 'dry-run') throw new Error('expected a dry-run verdict');
    expect(dryRun.result.notProven).toEqual(packFree.result.notProven);
  });

  /**
   * THE COST OF LOADING NO PACK, PINNED — and pinned as a DIVERGENCE, not as a feature.
   *
   * `--check-env` cannot know which top-level keys a pack claims, because it loads none. So on a
   * document that DECLARES a pack it lifts out every key the core grammar does not own — which
   * includes a MISTYPED one. `auditting:` (for the claimed `auditing:`) is owned by nothing, and this
   * command accepts it unexamined.
   *
   * The control is the SAME document through `doctor`, which loads the packs exactly as the boot does
   * and refuses it. Two commands, one document, opposite verdicts: that is the divergence, it is
   * deliberate (validating with the core grammar alone refused every legitimately claimed section, and
   * sent an operator to delete correct configuration), and it is what the docs now state. Without the
   * `doctor` half this would read as "the key is fine"; without the `--check-env` half a regression
   * that started refusing claimed sections again would go unmeasured.
   */
  it('a MISTYPED top-level key: --check-env lifts it out, and doctor — which loads the packs — refuses it', async () => {
    const checkEnv = await runDeploy(['--check-env', MISTYPED_KEY_DOC]);
    if (checkEnv.kind !== 'check-env') throw new Error('expected a check-env verdict');
    // No error at all for a key no pack claims: this command did not load the packs, so it cannot say
    // that nothing claims it. `errors` (not `ok`) for the reason the arm below states.
    expect(checkEnv.result.errors, JSON.stringify(checkEnv.result.errors)).toEqual([]);
    // It is NOT silent about it: the key it could not resolve an owner for is named.
    expect(checkEnv.result.notChecked.join('\n')).toContain('auditting');

    // The CONTROL: the same document, judged by a command that loads this deployment's packs — the
    // same resolution the boot performs. No pack claims the key, so it is refused, at the key.
    const doctor = await runDoctor([MISTYPED_KEY_DOC]);
    expect(doctor.ok).toBe(false);
    expect(doctor.errors.map((e) => e.code)).toContain('unknown_field');
    expect(doctor.errors.map((e) => e.path)).toContain('auditting');
  });

  it('the lift is what silences it — the SAME key on a PACK-FREE document is still refused', async () => {
    // The accept control for the arm above: only the `extensions:` declaration differs, so a
    // `--check-env` that had simply stopped reporting unknown fields would fail here.
    const packFreeMistyped = join(packFreeDir, 'mistyped.yaml');
    writeFileSync(
      packFreeMistyped,
      "version: '1.0'\nmetadata:\n  name: no-packs-here\nauditting:\n  retentionDays: 30\n",
      'utf8',
    );
    const checkEnv = await runDeploy([
      '--check-env',
      `${basename(packFreeDir)}/${basename(packFreeMistyped)}`,
    ]);
    if (checkEnv.kind !== 'check-env') throw new Error('expected a check-env verdict');
    expect(checkEnv.result.errors.join('\n')).toContain("unknown field 'auditting'");
  });

  it('and the boot’s own module raises no refusal for either — it says what it did not check', async () => {
    // `--check-env` reads `@rayspec/server`'s own boot-env module, the one the boot refusals are
    // composed from, and it loads no pack by design. Asserted on `errors`, not on `ok` — `ok` also
    // folds in `missing`, which is whatever this environment happens to have set, while every
    // `errors` entry is derived from the document.
    const written = await runDeploy(['--check-env', VALID_DOC]);
    if (written.kind !== 'check-env') throw new Error('expected a check-env verdict');
    expect(written.result.errors, JSON.stringify(written.result.errors)).toEqual([]);
    // It did not silently accept the section: it named it as unchecked, which is the honest verdict
    // for a grammar that belongs to a pack this command did not load.
    expect(written.result.notChecked.join('\n')).toContain('auditing');

    const absent = await runDeploy(['--check-env', NO_SECTION_DOC]);
    if (absent.kind !== 'check-env') throw new Error('expected a check-env verdict');
    expect(absent.result.errors, JSON.stringify(absent.result.errors)).toEqual([]);
    // Nothing to name for a document that writes no claimed key — the entry is a claim's, not
    // everyone's.
    expect(absent.result.notChecked.join('\n')).not.toContain(
      'top-level section(s) the core grammar',
    );
  });
});
