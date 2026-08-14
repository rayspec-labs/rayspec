#!/usr/bin/env node
/**
 * Task state-machine exhaustiveness CI gate — the transition table's structural contract.
 *
 * The durable task engine rests on three invariants that must hold BY CONSTRUCTION, not by review
 * memory, and this gate fails the build when any of them slips:
 *
 *   1. TABLE EXHAUSTIVENESS — `ALLOWED_TRANSITIONS` (@rayspec/tasks) covers all 81 (from, to)
 *      pairs EXPLICITLY: 9 rows, 9 boolean cells each, no defaulting. A missing cell is a decision
 *      nobody made; this gate makes it a build failure instead of an implicit `undefined`-is-false.
 *   2. TERMINAL ABSORPTION + THE ONE DOOR — the three terminal rows (completed/failed/cancelled)
 *      are all-false unconditionally, and the `working` column is true ONLY on the `queued` row:
 *      the only way back into execution is `queued`, the invariant restart survival rests on.
 *   3. REASON EXHAUSTIVENESS — `REASON_RULES` covers every `STATUS_REASONS` member (key-set
 *      equality) and every rule targets real statuses; a reason added without a handling rule is a
 *      build failure, not a runtime surprise.
 *
 * Plus the WRITE MONOPOLY: `applyTransition()` (packages/kernel/tasks/src/apply-transition.ts) is
 * the ONLY writer of `workforce_tasks.status`/`status_reason`, and task creation
 * (packages/kernel/tasks/src/create-task.ts) is the ONLY insert site. This half MIRRORS
 * scripts/check-tenant-chokepoint.mjs: a greppable TRIPWIRE (no AST) over comment-stripped source,
 * with a SELF-TEST proving every detector fires, and a fail-closed refusal when a scan root reads
 * nothing or the monopoly files themselves go missing.
 *
 * Parts 1-3 import the BUILT module (packages/kernel/tasks/dist/status.js) — the same artifact the
 * runtime executes — so the gate verifies the shipped table, not a re-parse of its source. Run
 * `pnpm build` first; a missing dist is a fail-closed refusal, never a skip.
 *
 * HONEST SCOPE / known ceiling — for the WRITE-MONOPOLY half only (parts 1-3 verify a real object
 * and have no ceiling). Because the detectors are REGEXES over comment-stripped source (no AST),
 * they catch the COMMON + previously-seen-regression forms: the chokepoint call, the bare drizzle
 * builder, an arbitrary qualifier (`schema.`, `s.`, a namespace alias), the unqualified import, a
 * quoted or multi-line SET key, and raw SQL in a template literal with quoted/unquoted, optionally
 * schema-qualified identifiers. They do NOT catch every conceivable form:
 *   - a RENAMED table import (`import { workforceTasks as t }`) — the name regex never sees `t`;
 *   - a PATCH IN A VARIABLE (`const patch = { status: next }; tdb.update(workforceTasks, patch)`)
 *     — the SET object is not at the call site to test;
 *   - a computed key (`{ [col]: next }`) or a spread (`{ ...patch }`);
 *   - raw SQL ASSEMBLED from interpolated fragments, where no single string contains the statement.
 * So this half is a loud tripwire for the realistic regressions, NOT a "cannot-escape" guarantee.
 * The LOAD-BEARING defenses are: (1) the renamed-import road is closed at the IMPORT site by the
 * Biome `noRestrictedImports` override and the tenant chokepoint; (2) `applyTransition()` is the
 * only function that can produce a legal transition at all — a foreign write still has to
 * reimplement the table, the reason rules, the compare-and-swap, the transition log and the
 * journal; and (3) code review. The gate is defence-in-depth on top of those, not a substitute.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const STATUS_MODULE = 'packages/kernel/tasks/dist/status.js';

/** The one sanctioned status/status_reason UPDATE site. */
const UPDATE_MONOPOLY = 'packages/kernel/tasks/src/apply-transition.ts';
/** The one sanctioned workforce_tasks INSERT site (rows are born 'planned' there). */
const INSERT_MONOPOLY = 'packages/kernel/tasks/src/create-task.ts';

/** Every packages/<tier>/<pkg>/src tree is scanned; tests and test-support are not shipped code. */
const SCAN_ROOT = 'packages';

function isExcluded(relPath) {
  return (
    !relPath.includes('/src/') ||
    relPath.includes('/test-support/') ||
    relPath.includes('/__fixtures__/') ||
    relPath.endsWith('.test.ts') ||
    relPath.endsWith('.test.tsx')
  );
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // root doesn't exist
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      yield* walk(full);
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      yield full;
    }
  }
}

/** Strip `//` line comments and slash-star block comments (keep string literals — raw SQL lives there). */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Additionally blank string/template literal BODIES (for the builder-call detectors). */
function stripCommentsAndStrings(src) {
  return stripComments(src).replace(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g, (m) => {
    const q = m[0];
    return q + ' '.repeat(Math.max(0, m.length - 2)) + q;
  });
}

/** Capture the paren-balanced argument list of a call, starting just after its '('. */
function captureCallArgs(s, start) {
  let depth = 1;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return s.slice(start, i);
    }
  }
  return s.slice(start);
}

/** Split a call's argument text into TOP-LEVEL argument strings (nested parens/braces respected). */
function splitTopLevelArgs(args) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      const seg = args.slice(start, i).trim();
      if (seg.length > 0) out.push(seg);
      start = i + 1;
    }
  }
  const tail = args.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

// ---- detectors -------------------------------------------------------------------------------

/** Chokepoint-form update: `.update(<any-qualifier.>workforceTasks, { ...SET... })`. Any
 * qualifier is admitted (`schema.`, `s.`, a namespace alias) — binding to the literal `schema.`
 * would let an import alias walk past the tripwire. A RENAMED table import
 * (`workforceTasks as t`) is the residual a name regex cannot see; the biome
 * `noRestrictedImports` override and the tenant chokepoint close that road at the import site. */
const CHOKEPOINT_UPDATE_RE = /\.update\(\s*(?:[\w$]+\s*\.\s*)?workforceTasks\s*,/g;
/** Bare drizzle-form update: `.update(workforceTasks).set({ ... })`. */
const RAW_BUILDER_UPDATE_RE = /\.update\(\s*(?:[\w$]+\s*\.\s*)?workforceTasks\s*\)\s*\.set\s*\(/g;
/** Any insert on the table (chokepoint or bare builder). */
const INSERT_RE = /\.insert\(\s*(?:[\w$]+\s*\.\s*)?workforceTasks\b/;
/** A SET object that assigns the status or status_reason column — bare OR quoted key form
 * (`status:`, `'status':`, `"statusReason":`). Tested against the STRINGS-INTACT capture so the
 * quoted form is visible. */
const STATUS_KEY_RE = /['"]?\b(?:status|statusReason)\b['"]?\s*:/;
/** Raw-SQL writes (checked on comment-stripped source with STRINGS INTACT — SQL lives in
 * strings). Every identifier part admits optional double quotes (`UPDATE "workforce_tasks"` is
 * this repo's own migration dialect) and UPDATE admits the ONLY keyword. */
const RAW_SQL_UPDATE_RE = /\bupdate\s+(?:only\s+)?(?:"?\w+"?\s*\.\s*)*"?workforce_tasks"?/i;
const RAW_SQL_INSERT_RE = /\binsert\s+into\s+(?:"?\w+"?\s*\.\s*)*"?workforce_tasks"?/i;

/**
 * Detect status-write-monopoly violations in one file's source. Pure (no I/O) so the self-test
 * exercises the exact logic. Returns violation strings.
 */
export function detectViolations(rel, src) {
  const found = [];
  const code = stripCommentsAndStrings(src);
  const codeWithStrings = stripComments(src);

  if (rel !== UPDATE_MONOPOLY) {
    // Chokepoint-form updates: flag when the SET object assigns status / statusReason. The CALL
    // is located on the strings-blanked source (string content cannot fake a call site), but the
    // SET object is captured from the strings-INTACT source at the same index — the two derive
    // from the same comment-stripped text with length-preserving blanking, so indexes align, and
    // a quoted key (`'status':`) stays visible to the key test.
    const setAssignsStatus = (start) => {
      const blanked = captureCallArgs(code, start);
      const intact = captureCallArgs(codeWithStrings, start);
      const setBlanked = splitTopLevelArgs(`x,${blanked}`)[1] ?? blanked;
      const setIntact = splitTopLevelArgs(`x,${intact}`)[1] ?? intact;
      return STATUS_KEY_RE.test(setBlanked) || STATUS_KEY_RE.test(setIntact);
    };
    let m;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop.
    while ((m = CHOKEPOINT_UPDATE_RE.exec(code)) !== null) {
      if (setAssignsStatus(m.index + m[0].length)) {
        found.push(
          `${rel}: updates workforce_tasks.status/status_reason outside applyTransition() — the ` +
            'transition gate is the ONLY status writer. Route the change through applyTransition.',
        );
      }
    }
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop.
    while ((m = RAW_BUILDER_UPDATE_RE.exec(code)) !== null) {
      const setBlanked = captureCallArgs(code, m.index + m[0].length);
      const setIntact = captureCallArgs(codeWithStrings, m.index + m[0].length);
      if (STATUS_KEY_RE.test(setBlanked) || STATUS_KEY_RE.test(setIntact)) {
        found.push(
          `${rel}: updates workforce_tasks.status/status_reason via a raw builder outside ` +
            'applyTransition() — the transition gate is the ONLY status writer.',
        );
      }
    }
    if (RAW_SQL_UPDATE_RE.test(codeWithStrings)) {
      found.push(
        `${rel}: raw-SQL UPDATE on workforce_tasks — every write to the task row goes through the ` +
          'engine (applyTransition for status; the engine modules for the rest), never raw SQL.',
      );
    }
  }

  if (rel !== INSERT_MONOPOLY) {
    if (INSERT_RE.test(code)) {
      found.push(
        `${rel}: inserts workforce_tasks rows outside create-task.ts — task creation (and its ` +
          "'planned' initial status) has exactly one sanctioned site.",
      );
    }
    if (RAW_SQL_INSERT_RE.test(codeWithStrings)) {
      found.push(
        `${rel}: raw-SQL INSERT INTO workforce_tasks — task creation has exactly one sanctioned ` +
          'site (create-task.ts), never raw SQL.',
      );
    }
  }

  return found;
}

// ---- self-test: prove each detector fires, and that the sanctioned sites pass -----------------
function selfTest() {
  const foreign = 'packages/workflow/durable-dbos/src/task-scheduler.ts';
  const cases = [
    // A chokepoint update assigning status outside the monopoly file -> FLAG.
    {
      rel: foreign,
      src: "await tdb.update(schema.workforceTasks, { status: 'queued', version: 2 }).where(w);",
      expect: true,
    },
    // Assigning statusReason alone is still a status write -> FLAG.
    {
      rel: foreign,
      src: "await tx.update(schema.workforceTasks, { statusReason: 'escalated' }).where(w);",
      expect: true,
    },
    // A non-status update (the journal seq counter) is legitimate -> PASS.
    {
      rel: foreign,
      src: 'await tdb.update(schema.workforceTasks, { lastEventSeq: sql`x + 1` }).where(w);',
      expect: false,
    },
    // A multi-line SET object still has its status key seen (brace-balanced capture) -> FLAG.
    {
      rel: foreign,
      src: 'await tdb.update(schema.workforceTasks, {\n  version: 3,\n  status: next,\n}).where(w);',
      expect: true,
    },
    // The bare drizzle builder form -> FLAG.
    {
      rel: foreign,
      src: "await raw.update(schema.workforceTasks).set({ status: 'failed' }).where(w);",
      expect: true,
    },
    // The unqualified import form -> FLAG.
    {
      rel: foreign,
      src: "await tdb.update(workforceTasks, { status: 'queued' }).where(w);",
      expect: true,
    },
    // Raw SQL in a template literal -> FLAG (strings are deliberately NOT blanked for this check).
    {
      rel: foreign,
      src: 'await db.$client.unsafe(`UPDATE workforce_tasks SET status = $1`);',
      expect: true,
    },
    // The same words in a comment are prose -> PASS (comments are stripped first).
    {
      rel: foreign,
      src: '// a recovered turn must never UPDATE workforce_tasks SET status directly\nconst x = 1;',
      expect: false,
    },
    // An insert outside create-task.ts -> FLAG.
    {
      rel: foreign,
      src: "await tdb.insert(schema.workforceTasks, { taskId, status: 'planned' });",
      expect: true,
    },
    // Raw-SQL insert -> FLAG.
    {
      rel: foreign,
      src: 'await db.$client.unsafe(`INSERT INTO workforce_tasks (task_id) VALUES ($1)`);',
      expect: true,
    },
    // The sanctioned monopoly files pass their own writes.
    {
      rel: UPDATE_MONOPOLY,
      src: 'await tx.update(schema.workforceTasks, { status: input.to, version: v }).where(w);',
      expect: false,
    },
    {
      rel: INSERT_MONOPOLY,
      src: "await tx.insert(schema.workforceTasks, { ...row, status: 'planned' });",
      expect: false,
    },
    // Another table's status column is not this gate's business -> PASS.
    {
      rel: foreign,
      src: "await tdb.update(schema.workforceApprovals, { status: 'approved' }).where(w);",
      expect: false,
    },
    // Quoted SQL identifiers — the repo's own migration dialect -> FLAG.
    {
      rel: foreign,
      src: 'await db.$client.unsafe(`UPDATE "workforce_tasks" SET status = $1`);',
      expect: true,
    },
    {
      rel: foreign,
      src: 'await db.$client.unsafe(`update "public"."workforce_tasks" set status = $1`);',
      expect: true,
    },
    {
      rel: foreign,
      src: 'await db.$client.unsafe(`UPDATE ONLY workforce_tasks SET status = $1`);',
      expect: true,
    },
    {
      rel: foreign,
      src: 'await db.$client.unsafe(`INSERT INTO "workforce_tasks" (task_id) VALUES ($1)`);',
      expect: true,
    },
    // A namespace-alias qualifier is still the same table -> FLAG.
    {
      rel: foreign,
      src: "await tdb.update(s.workforceTasks, { status: 'queued' }).where(w);",
      expect: true,
    },
    // A QUOTED set key is still the status column -> FLAG.
    {
      rel: foreign,
      src: "await tdb.update(schema.workforceTasks, { 'status': next }).where(w);",
      expect: true,
    },
    {
      rel: foreign,
      src: 'await raw.update(schema.workforceTasks).set({ "statusReason": r }).where(w);',
      expect: true,
    },
  ];
  for (const { rel, src, expect } of cases) {
    const hit = detectViolations(rel, src).length > 0;
    if (hit !== expect) {
      console.error(
        `state-machine gate SELF-TEST FAILED: detector returned ${hit} (expected ${expect}) ` +
          `for [${rel}]: ${src}`,
      );
      process.exit(2);
    }
  }
}

selfTest();

// ---- parts 1-3: the shipped table's structural contract ---------------------------------------

const statusModulePath = join(repoRoot, STATUS_MODULE);
if (!existsSync(statusModulePath)) {
  console.error(
    `state-machine gate FAILED: ${STATUS_MODULE} does not exist — the gate verifies the BUILT ` +
      'transition table and refuses to pass without it (fail-closed). Run `pnpm build` first.',
  );
  process.exit(1);
}

const failures = [];
const mod = await import(pathToFileURL(statusModulePath).href);
const { ALLOWED_TRANSITIONS, REASON_RULES, STATUS_REASONS, TASK_STATUSES, TERMINAL_STATUSES } = mod;

if (!Array.isArray(TASK_STATUSES) || TASK_STATUSES.length !== 9) {
  failures.push(
    `TASK_STATUSES must be the closed nine-status set (found ${TASK_STATUSES?.length}).`,
  );
} else {
  const rows = Object.keys(ALLOWED_TRANSITIONS ?? {});
  if (rows.length !== 9 || !TASK_STATUSES.every((s) => rows.includes(s))) {
    failures.push(
      `ALLOWED_TRANSITIONS must carry exactly one row per status (found rows: ${rows.join(', ')}).`,
    );
  }
  for (const from of TASK_STATUSES) {
    const row = ALLOWED_TRANSITIONS[from] ?? {};
    const cells = Object.keys(row);
    if (cells.length !== 9 || !TASK_STATUSES.every((s) => cells.includes(s))) {
      failures.push(`row '${from}' must spell out all 9 cells explicitly (found ${cells.length}).`);
      continue;
    }
    for (const to of TASK_STATUSES) {
      if (typeof row[to] !== 'boolean') {
        failures.push(
          `cell ${from} -> ${to} must be an explicit boolean (found ${typeof row[to]}).`,
        );
      }
    }
  }
  for (const from of TERMINAL_STATUSES ?? []) {
    for (const to of TASK_STATUSES) {
      if (ALLOWED_TRANSITIONS[from]?.[to] === true) {
        failures.push(
          `terminal row '${from}' has a truthy cell (-> ${to}) — terminal statuses have NO outgoing ` +
            'transitions; re-opening work means a NEW task.',
        );
      }
    }
  }
  // The one door into execution: `working` is enterable from `queued` and nowhere else.
  for (const from of TASK_STATUSES) {
    const expected = from === 'queued';
    if (ALLOWED_TRANSITIONS[from]?.working !== expected) {
      failures.push(
        `cell ${from} -> working must be ${expected} — the only way back into execution is 'queued'.`,
      );
    }
  }
  // Reason exhaustiveness: every reason has a rule; every rule targets real statuses.
  const ruleKeys = Object.keys(REASON_RULES ?? {}).sort();
  const reasons = [...(STATUS_REASONS ?? [])].sort();
  if (JSON.stringify(ruleKeys) !== JSON.stringify(reasons)) {
    failures.push(
      `REASON_RULES keys must equal STATUS_REASONS (rules: [${ruleKeys.join(', ')}] vs reasons: ` +
        `[${reasons.join(', ')}]) — a reason without a handling rule is unhandled.`,
    );
  }
  for (const [reason, targets] of Object.entries(REASON_RULES ?? {})) {
    if (!Array.isArray(targets) || targets.length === 0) {
      failures.push(`REASON_RULES['${reason}'] must name at least one target status.`);
      continue;
    }
    for (const t of targets) {
      if (!TASK_STATUSES.includes(t)) {
        failures.push(`REASON_RULES['${reason}'] targets unknown status '${t}'.`);
      }
    }
  }
}

// ---- part 4: the status-write monopoly scan ---------------------------------------------------

const violations = [];
let scanned = 0;
let sawUpdateMonopoly = false;
let sawInsertMonopoly = false;
for (const file of walk(join(repoRoot, SCAN_ROOT))) {
  const rel = relative(repoRoot, file).split('\\').join('/');
  if (isExcluded(rel)) continue;
  scanned++;
  if (rel === UPDATE_MONOPOLY) sawUpdateMonopoly = true;
  if (rel === INSERT_MONOPOLY) sawInsertMonopoly = true;
  violations.push(...detectViolations(rel, readFileSync(file, 'utf8')));
}

// Fail-closed: a scan that read nothing certifies nothing, and a scan that never saw the monopoly
// files means the sanctioned writer moved without this gate following it.
if (scanned === 0) {
  console.error(
    `state-machine gate FAILED: scanned 0 source file(s) under ${SCAN_ROOT} (repo root: ` +
      `'${repoRoot}'). Refusing on an unscanned root (fail-closed).`,
  );
  process.exit(1);
}
if (!sawUpdateMonopoly || !sawInsertMonopoly) {
  console.error(
    `state-machine gate FAILED: the sanctioned writer file(s) were not scanned — ` +
      `${UPDATE_MONOPOLY} ${sawUpdateMonopoly ? 'seen' : 'MISSING'}, ` +
      `${INSERT_MONOPOLY} ${sawInsertMonopoly ? 'seen' : 'MISSING'}. If the engine moved, update ` +
      'the monopoly paths here so the gate follows it (fail-closed).',
  );
  process.exit(1);
}

if (failures.length > 0 || violations.length > 0) {
  console.error('state-machine gate FAILED:');
  for (const f of failures) console.error(`  - [table] ${f}`);
  for (const v of violations) console.error(`  - [write] ${v}`);
  console.error(
    '\nThe transition table must stay exhaustive (81 explicit cells, absorbing terminals, queued as ' +
      'the one door into execution, every reason ruled), and applyTransition() must remain the only ' +
      'status writer.',
  );
  process.exit(1);
}

console.log(
  `state-machine gate PASSED: ALLOWED_TRANSITIONS covers all 81 pairs explicitly (terminal rows ` +
    `all-false, 'queued' the only door into 'working'), REASON_RULES covers all ` +
    `${STATUS_REASONS.length} reasons, and ${scanned} source file(s) across 1 root(s) carry no ` +
    'status write outside applyTransition() and no task insert outside create-task.ts.',
);
