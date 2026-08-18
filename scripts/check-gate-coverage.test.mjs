#!/usr/bin/env node
/**
 * Regression test for the coverage guard on the chokepoint-family gates AND the mutation harness
 * for the state-machine gate.
 *
 * `check-tenant-chokepoint.mjs` and `check-adapter-no-handlers.mjs` walk a fixed list of source
 * roots. `walk()` returns silently when a directory does not exist ("root doesn't exist yet"), so a
 * rename or a move of any declared root made the gate read ZERO files, find zero violations, and exit
 * 0 with its normal PASS line — the guard retired itself without a signal. That is the same FAIL-OPEN
 * that `check-no-pack-imports.mjs` closed with a scanned-count guard (see its
 * `check-no-pack-imports.spacepath.test.mjs`); these gates carry the same guard now.
 *
 * The test drives the REAL scripts. Each script derives its repo root from its own location
 * (`join(dirname(fileURLToPath(import.meta.url)), '..')`), so copying it into `<throwaway>/scripts/`
 * makes `<throwaway>` the repo root — which lets the roots be present, absent, or clean without
 * touching this checkout.
 *
 * Four case classes, so a pass means something:
 *
 *   (C) a populated tree PASSES — the scan actually reached the files, and the count is reported.
 *   (V) a planted violation FAILS — the detector still fires (the accept control for case G).
 *   (G) a root that resolves to nothing FAILS CLOSED, naming the unscanned root.
 *   (T) a planted TABLE mutation FAILS — state-machine gate only; see below.
 *
 * WHY THE STATE-MACHINE GATE IS HERE. `check-state-machine-exhaustive.mjs` is the ONE-WRITER gate
 * for `workforce_tasks.status`, and until now its detectors were mutation-tested only by its OWN
 * in-process `selfTest()` — a gate grading its own homework. Cases (C)/(V)/(G) put its write-monopoly
 * scan under the same EXTERNAL harness the other three gates get, and case (T) covers what
 * `selfTest()` never touched at all: parts 1-3, the structural contract on the BUILT transition
 * table (81 explicit cells, absorbing terminals, `queued` as the one door into `working`, exhaustive
 * `REASON_RULES`).
 *
 * That gate needs two things the others do not, hence the two optional members on each loop entry:
 *
 *   - `support`: files written into the throwaway repo on EVERY case but never counted by the scan.
 *     The gate imports the BUILT table (`packages/kernel/tasks/dist/status.js`) and fail-closes when
 *     it is absent; `walk()` skips `dist/`, so the module never inflates the scanned count and case
 *     (G) still reaches "scanned 0".
 *   - `populate`: what a populated tree means for this gate. `SCAN_ROOT` is `packages`, and a bare
 *     `packages/ok.ts` is excluded for not living under a `/src/`; the gate also fail-closes unless
 *     it scans BOTH monopoly files, so the populated tree IS those two files.
 *
 * The `dist/status.js` fixture below is a STANDALONE fixture for exercising the gate's checks, NOT a
 * second source of truth for the real table: the real table is verified against the real gate by
 * `pnpm gate:state-machine`. Keeping the fixture build-independent is what lets this harness run
 * with no `pnpm build` behind it, exactly like the other three gates' cases.
 *
 * Standalone (no test framework is wired for the gate scripts): `node <thisfile>`; exit 0 = pass.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

/** Run a gate script and capture exit code + streams. */
function runGate(scriptPath) {
  try {
    const stdout = execFileSync('node', [scriptPath], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: stdout, err: '' };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? ''), err: String(e.stderr ?? '') };
  }
}

/**
 * Build a throwaway repo whose root is the workspace itself: the gate script lands in
 * `<ws>/scripts/`, and `files` (relative paths → contents) are written under `<ws>`.
 */
function throwawayRepo(scriptName, files) {
  const ws = mkdtempSync(join(tmpdir(), 'rayspec-gate-coverage-'));
  mkdirSync(join(ws, 'scripts'), { recursive: true });
  cpSync(join(SCRIPTS_DIR, scriptName), join(ws, 'scripts', scriptName));
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(ws, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { ws, script: join(ws, 'scripts', scriptName) };
}

const BENIGN = "import { readFileSync } from 'node:fs';\nexport const y = readFileSync;\n";

// The roots each gate declares. Kept here deliberately rather than imported: if a root is renamed in
// the gate and not here, case (C) stops finding files and this test goes red — which is exactly the
// drift the guard exists to catch.
const CHOKEPOINT_ROOTS = [
  'packages/kernel/platform/src',
  'packages/compose/api-auth/src',
  'packages/workflow/durable-dbos/src',
  'packages/kernel/tasks/src',
  'packages/kernel/workforce-tools/src',
  'packages/kernel/db/src',
];
const ADAPTER_ROOTS = [
  'packages/adapters/openai/src',
  'packages/adapters/anthropic/src',
  'packages/adapters/pi/src',
  'packages/adapters/codex/src',
];
const DELEGATION_ROOTS = ['packages/kernel/workforce-tools/src'];
/** `check-state-machine-exhaustive.mjs`'s single scan root (its `SCAN_ROOT` constant). */
const STATE_MACHINE_ROOTS = ['packages'];

/** A populated tree: one benign source file under every declared root. */
function populated(roots) {
  return Object.fromEntries(roots.map((r) => [`${r}/ok.ts`, BENIGN]));
}

// ── the state-machine gate's fixtures ───────────────────────────────────────────────────────────
// The gate's two sanctioned writer files. It fail-closes unless the scan SEES both, so for that gate
// "a populated tree" means precisely these two — a bare `packages/ok.ts` is excluded for not being
// under a `/src/`, and would leave the scan at zero.
const STATUS_MODULE_PATH = 'packages/kernel/tasks/dist/status.js';
const UPDATE_MONOPOLY_PATH = 'packages/kernel/tasks/src/apply-transition.ts';
const INSERT_MONOPOLY_PATH = 'packages/kernel/tasks/src/create-task.ts';

/** The nine-status set, its three terminals, and the true cells of each row (mirrors status.ts). */
const FIXTURE_STATUSES = [
  'planned',
  'queued',
  'working',
  'blocked',
  'waiting_for_review',
  'waiting_for_user',
  'completed',
  'failed',
  'cancelled',
];
const FIXTURE_TERMINALS = ['completed', 'failed', 'cancelled'];
const FIXTURE_TRUE_CELLS = {
  planned: ['queued', 'blocked', 'failed', 'cancelled'],
  queued: ['working', 'blocked', 'failed', 'cancelled'],
  working: [
    'queued',
    'blocked',
    'waiting_for_review',
    'waiting_for_user',
    'completed',
    'failed',
    'cancelled',
  ],
  blocked: ['queued', 'waiting_for_user', 'failed', 'cancelled'],
  waiting_for_review: ['queued', 'blocked', 'waiting_for_user', 'completed', 'failed', 'cancelled'],
  waiting_for_user: ['queued', 'blocked', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};
const FIXTURE_REASON_RULES = {
  awaiting_children: ['blocked'],
  awaiting_dependency: ['blocked'],
  dependency_failed: ['failed'],
  escalated: ['blocked'],
  budget_exhausted: ['blocked'],
  deadline_exceeded: ['blocked'],
  approval_pending: ['waiting_for_user', 'blocked'],
  review_pending: ['waiting_for_review'],
  clarification_pending: ['blocked'],
  tool_error: ['queued', 'failed'],
  owner_undeclared: ['blocked'],
  cancelled_by_user: ['cancelled'],
  cancelled_by_parent: ['cancelled'],
  quarantined: ['blocked', 'failed'],
};

/**
 * The BUILT status module the gate imports, as ESM source. `mutate` receives the plain shape and may
 * corrupt it — that is how case (T) plants a table defect the gate must catch.
 */
function statusModuleSource(mutate) {
  const table = {};
  for (const from of FIXTURE_STATUSES) {
    table[from] = Object.fromEntries(
      FIXTURE_STATUSES.map((to) => [to, FIXTURE_TRUE_CELLS[from].includes(to)]),
    );
  }
  const shape = {
    TASK_STATUSES: [...FIXTURE_STATUSES],
    TERMINAL_STATUSES: [...FIXTURE_TERMINALS],
    ALLOWED_TRANSITIONS: table,
    STATUS_REASONS: Object.keys(FIXTURE_REASON_RULES),
    REASON_RULES: structuredClone(FIXTURE_REASON_RULES),
  };
  if (mutate) mutate(shape);
  return Object.entries(shape)
    .map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};\n`)
    .join('');
}

/** The state-machine gate's populated tree: the two monopoly files it refuses to run without. */
function populatedStateMachine(roots) {
  if (roots.length === 0) return {}; // the (G) slice — nothing under `packages`, scan reads zero
  return { [UPDATE_MONOPOLY_PATH]: BENIGN, [INSERT_MONOPOLY_PATH]: BENIGN };
}

/**
 * Case (T)'s mutations of the BUILT table — the half of the gate its own `selfTest()` never covers.
 * `mutate: null` means "do not write the module at all" (the missing-dist fail-closed).
 */
const STATE_MACHINE_TABLE_MUTATIONS = [
  {
    name: 'a terminal row gains a truthy cell',
    mutate: (s) => {
      s.ALLOWED_TRANSITIONS.completed.queued = true;
    },
    pattern: /terminal row 'completed' has a truthy cell/,
  },
  {
    name: 'a cell goes missing (implicit undefined-is-false)',
    mutate: (s) => {
      delete s.ALLOWED_TRANSITIONS.working.cancelled;
    },
    pattern: /row 'working' must spell out all 9 cells explicitly/,
  },
  {
    name: 'a second door into working',
    mutate: (s) => {
      s.ALLOWED_TRANSITIONS.blocked.working = true;
    },
    pattern: /cell blocked -> working must be false/,
  },
  {
    name: 'a reason loses its handling rule',
    mutate: (s) => {
      delete s.REASON_RULES.quarantined;
    },
    pattern: /REASON_RULES keys must equal STATUS_REASONS/,
  },
  {
    name: 'a rule targets a status that does not exist',
    mutate: (s) => {
      s.REASON_RULES.tool_error = ['queued', 'retrying'];
    },
    pattern: /targets unknown status 'retrying'/,
  },
  {
    name: 'the BUILT module is absent',
    mutate: null,
    pattern: /does not exist — the gate verifies the BUILT/,
  },
];

const created = [];
try {
  for (const [
    gate,
    script,
    roots,
    violation,
    violationPattern,
    support = {},
    populate = populated,
    tableMutations = [],
  ] of [
    [
      'tenant-chokepoint',
      'check-tenant-chokepoint.mjs',
      CHOKEPOINT_ROOTS,
      {
        path: 'packages/kernel/platform/src/leak.ts',
        src: "import { makeDb } from '@rayspec/db';\nexport const db = makeDb('u');\n",
      },
      /makeDb/,
    ],
    [
      'adapter-no-handlers',
      'check-adapter-no-handlers.mjs',
      ADAPTER_ROOTS,
      {
        path: 'packages/adapters/openai/src/leak.ts',
        src: 'export const toolHandlers = {\n  lookup: async () => ({ ok: true }),\n};\n',
      },
      /toolHandlers|handler/i,
    ],
    [
      'delegation-dispatch-boundary',
      'check-delegation-dispatch-boundary.mjs',
      DELEGATION_ROOTS,
      {
        path: 'packages/kernel/workforce-tools/src/leak.ts',
        src: "import { DbosTaskScheduler } from '@rayspec/durable-dbos';\nexport const s = DbosTaskScheduler;\n",
      },
      /durable-dbos/,
    ],
    [
      'state-machine-exhaustive',
      'check-state-machine-exhaustive.mjs',
      STATE_MACHINE_ROOTS,
      {
        path: 'packages/kernel/tasks/src/leak.ts',
        src:
          "import { schema } from '@rayspec/db';\n" +
          'export const park = async (tdb, id) =>\n' +
          "  tdb.update(schema.workforceTasks, { status: 'blocked' }).where(id);\n",
      },
      /applyTransition/,
      { [STATUS_MODULE_PATH]: statusModuleSource() },
      populatedStateMachine,
      STATE_MACHINE_TABLE_MUTATIONS,
    ],
  ]) {
    // ── (C) a populated tree passes, and says how much it read ─────────────────────────────────────
    {
      const { ws, script: s } = throwawayRepo(script, { ...support, ...populate(roots) });
      created.push(ws);
      const r = runGate(s);
      assert.equal(r.code, 0, `(C/${gate}) a populated tree must PASS; got ${r.code}: ${r.err}`);
      assert.match(r.out, /PASSED/, `(C/${gate}) a clean scan must report PASSED`);
      assert.match(
        r.out,
        new RegExp(`${roots.length} root\\(s\\)`),
        `(C/${gate}) the PASS line must report the coverage it achieved`,
      );
      console.log(`ok (C/${gate}) — populated tree passes and reports its coverage`);
    }

    // ── (V) the detector still fires (accept control for the guard below) ──────────────────────────
    {
      const files = { ...support, ...populate(roots) };
      files[violation.path] = violation.src;
      const { ws, script: s } = throwawayRepo(script, files);
      created.push(ws);
      const r = runGate(s);
      assert.notEqual(r.code, 0, `(V/${gate}) a planted violation must FAIL`);
      assert.match(r.err, violationPattern, `(V/${gate}) the violation must be named`);
      console.log(`ok (V/${gate}) — planted violation is detected (exit ${r.code})`);
    }

    // ── (G) a root that resolves to nothing fails CLOSED ───────────────────────────────────────────
    // Every root but the first is populated, so this is precisely the "one directory was renamed"
    // case — not a wholly empty checkout, which a coarser guard would also catch.
    {
      const files = { ...support, ...populate(roots.slice(1)) };
      const { ws, script: s } = throwawayRepo(script, files);
      created.push(ws);
      const r = runGate(s);
      assert.notEqual(
        r.code,
        0,
        `(G/${gate}) a root that reads nothing must fail CLOSED, not PASS vacuously`,
      );
      assert.match(
        r.err,
        /scanned 0 source file\(s\)/,
        `(G/${gate}) the fail-closed reason must be named`,
      );
      assert.ok(
        r.err.includes(roots[0]),
        `(G/${gate}) the unscanned root must be named; got: ${r.err}`,
      );
      console.log(`ok (G/${gate}) — an unscanned root fails closed (exit ${r.code})`);
    }

    // ── (T) a planted TABLE mutation fails ────────────────────────────────────────────────────────
    // Parts 1-3 of the state-machine gate inspect a real object rather than grepping source, and the
    // gate's own `selfTest()` covers only its part-4 detectors — so without these the structural
    // contract on the shipped transition table has no mutation coverage anywhere.
    for (const mutation of tableMutations) {
      const files = { ...support, ...populate(roots) };
      if (mutation.mutate === null) delete files[STATUS_MODULE_PATH];
      else files[STATUS_MODULE_PATH] = statusModuleSource(mutation.mutate);
      const { ws, script: s } = throwawayRepo(script, files);
      created.push(ws);
      const r = runGate(s);
      assert.notEqual(
        r.code,
        0,
        `(T/${gate}) "${mutation.name}" must FAIL the gate; got ${r.code}: ${r.out}`,
      );
      assert.match(
        r.err,
        mutation.pattern,
        `(T/${gate}) "${mutation.name}" must be named in the failure; got: ${r.err}`,
      );
      console.log(`ok (T/${gate}) — ${mutation.name} (exit ${r.code})`);
    }
  }

  console.log('\ngate-coverage regression: ALL CASES PASSED');
} finally {
  for (const d of created) rmSync(d, { recursive: true, force: true });
}
