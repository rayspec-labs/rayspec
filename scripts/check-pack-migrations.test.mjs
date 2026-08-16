#!/usr/bin/env node
/**
 * Regression test for the pack-migration chain gate (`scripts/check-pack-migrations.mjs`).
 *
 * The gate binds every table and index a pack migration chain creates — and every table it alters
 * or indexes — to the pack's declared table prefix, and holds the chain to the PLATFORM's own
 * destructive scan run with NO allowlist. Every half is worth nothing unless something can make it
 * go red, so this drives the REAL gate against throwaway chains and pins the arms that matter:
 *
 *   (C) a conforming chain PASSES, and the pass line reports how much it read. Its literal holds a
 *       `;`, a `--` and a `CREATE TABLE orgs` that are CONTENT, not structure, so the statement
 *       count and the verdict both depend on the splitter's quote handling and on the literal
 *       blanking: delete either and this arm reds.
 *   (V) a planted unprefixed CREATE TABLE FAILS, a planted unprefixed CREATE UNIQUE INDEX FAILS,
 *       an ALTER TABLE on a platform table FAILS, and a correctly-prefixed index built ON a
 *       platform table FAILS. Four accept controls, not one: a scan that only read created names
 *       would pass the last two, and those are the ways a chain reaches out of its namespace.
 *   (D) a destructive statement FAILS — standalone, AND riding in the same comma-separated action
 *       list as an `ADD`, which is one legal Postgres statement and the shape an accepted-form
 *       check alone waves through.
 *   (A) the HIGHER bar: a statement NO destructive detector names (an `INSERT`, a `GRANT`) still
 *       FAILS, because nothing accepted it. Each is asserted clean against the core first, so the
 *       arm cannot be passing on the destructive half.
 *   (P) PARITY WITH THE CORE: every statement the platform scan refuses with an empty allowlist,
 *       this gate refuses too. Measured against `scanMigrationSql` itself over a corpus, with an
 *       accept control so the corpus cannot be passing because everything fails.
 *   (U) an UNNAMED index FAILS with the unnamed-index message — including the `CONCURRENTLY` form,
 *       where a backtracking name capture used to bind a keyword as the index name.
 *   (S) a conforming chain separated only by drizzle's `--> statement-breakpoint`, with no
 *       semicolons, PASSES and is counted as SEVERAL statements — nothing but the marker boundary
 *       produces that count. A `DROP TABLE` planted behind a marker FAILS, and a statement holding
 *       a second top-level verb after all splitting FAILS rather than being judged at its head.
 *       A marker with text AHEAD of it on the same line — `-- x --> statement-breakpoint DROP
 *       TABLE "orgs";` — FAILS too, in all four payload classes: drizzle splits the RAW file and
 *       parses no comments, so that line is two statements to it and the second one RUNS. With an
 *       accept control (the same line with no marker is a plain comment and still passes) so the
 *       arm cannot be green because the gate started reading comments as SQL. A marker INSIDE a
 *       literal cuts it, which fails closed as an unterminated literal.
 *   (Q) a digit-tagged dollar-quoted literal (`$tag1$…$tag1$`) does not swallow the rest of the
 *       file: the statement behind one is scanned on its own, and is planted as a NAMESPACE
 *       violation so only the splitter can catch it. An UNTERMINATED literal FAILS.
 *   (G) a chain directory that reads nothing — empty, or absent altogether — FAILS CLOSED rather
 *       than reporting a vacuous pass over zero files; and so does an EMPTY declared set, driven
 *       through the no-argument door CI actually uses.
 *
 * The gate takes the chain directory and the required prefix as arguments, so a throwaway chain is
 * just a directory of `.sql` files; the (G/declared) arm additionally copies the gate into a
 * throwaway repo root so the gate's OWN declared set resolves there. Nothing about this checkout
 * is touched.
 *
 * NEEDS THE BUILD: the gate imports the platform scan from `@rayspec/db`, and (P) imports it here
 * too. Run `pnpm build` first.
 *
 * Standalone (no test framework is wired for the gate scripts): `node <thisfile>`; exit 0 = pass.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanMigrationSql } from '@rayspec/db';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, '..');
const GATE_NAME = 'check-pack-migrations.mjs';
const GATE = join(SCRIPTS_DIR, GATE_NAME);

/** The prefix every throwaway chain below declares. */
const PREFIX = 'fx_';

/** Run the gate against one chain directory + required prefix; capture exit code + streams. */
function runGate(dir, prefix) {
  return run([GATE, dir, prefix]);
}

/** Run any gate copy with any argv; capture exit code + streams. */
function run(args) {
  try {
    const stdout = execFileSync('node', args, { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: stdout, err: '' };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? ''), err: String(e.stderr ?? '') };
  }
}

const created = [];
/** Write a throwaway chain directory from `{ filename: sql }` and return its path. */
function chain(files) {
  const dir = mkdtempSync(join(tmpdir(), 'rayspec-pack-migrations-'));
  created.push(dir);
  mkdirSync(dir, { recursive: true });
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

/** A one-file throwaway chain holding `sql`, plus the conforming chain it sits beside. */
function planted(sql) {
  return chain({ '0000_ledger.sql': CONFORMING, '0001_planted.sql': sql });
}

/**
 * A throwaway repo root with the REAL gate in `<ws>/scripts/` and its `DECLARED_CHAINS` rewritten
 * to `entries`. The gate derives its repo root from its own location, so `<ws>` becomes the root
 * and the declared paths resolve under it — which is the only way to drive the no-argument door CI
 * uses. `node_modules` is symlinked so the gate's `@rayspec/db` import still resolves.
 */
function declaredSetGate(entries) {
  const ws = mkdtempSync(join(tmpdir(), 'rayspec-pack-migrations-declared-'));
  created.push(ws);
  mkdirSync(join(ws, 'scripts'), { recursive: true });
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(ws, 'node_modules'), 'dir');
  const source = readFileSync(GATE, 'utf8');
  const rewritten = source.replace(
    /const DECLARED_CHAINS = \[[\s\S]*?\n\];/,
    `const DECLARED_CHAINS = ${JSON.stringify(entries)};`,
  );
  assert.notEqual(rewritten, source, 'the DECLARED_CHAINS rewrite must apply — the gate moved');
  writeFileSync(join(ws, 'scripts', GATE_NAME), rewritten);
  return { ws, script: join(ws, 'scripts', GATE_NAME) };
}

/**
 * A conforming chain: every created object carries `fx_`, every altered and indexed table too, and
 * every statement survives the platform scan. Its `kind` default is the load-bearing fixture — the
 * literal holds a `;` (structure to a naive splitter), a `--` (a comment to a naive strip) and a
 * `CREATE TABLE orgs` (a second statement verb to a naive match), and all three are CONTENT.
 */
const CONFORMING = [
  '-- The chain the pack owns. Nothing here creates a bare `orgs` table.',
  'CREATE TABLE "fx_ledger" (',
  '\t"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,',
  '\t"tenant_id" uuid NOT NULL,',
  '\t"kind" text DEFAULT \'a; CREATE TABLE orgs ( -- x\' NOT NULL,',
  '\t"recorded_at" timestamp with time zone DEFAULT now() NOT NULL',
  ');',
  '--> statement-breakpoint',
  'ALTER TABLE "fx_ledger" ADD CONSTRAINT "fx_ledger_tenant_id_orgs_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;',
  '--> statement-breakpoint',
  'CREATE INDEX "fx_ledger_tenant_idx" ON "fx_ledger" USING btree ("tenant_id");',
  '--> statement-breakpoint',
  'CREATE UNIQUE INDEX "fx_ledger_kind_unique" ON "fx_ledger" USING btree ("tenant_id", "kind");',
  '',
].join('\n');

try {
  // ── (C) a conforming chain passes, and says how much it read ─────────────────────────────────
  {
    const dir = chain({ '0000_ledger.sql': CONFORMING });
    const r = runGate(dir, PREFIX);
    assert.equal(r.code, 0, `(C) a conforming chain must PASS; got ${r.code}: ${r.err}`);
    assert.match(r.out, /PASSED/, '(C) a clean scan must report PASSED');
    assert.match(r.out, /1 migration file\(s\)/, '(C) the pass line must report the files it read');
    // 4, not 5: the `;` inside the `kind` default is content. A splitter that is not quote-aware
    // reads 5 here, and a match that is not literal-aware sees a second CREATE TABLE in statement 1.
    assert.match(r.out, /4 statement\(s\)/, '(C) the pass line must report the statements it read');
    console.log('ok (C) — a conforming chain passes and reports what it read');
  }

  // ── (V) an unprefixed TABLE fails ────────────────────────────────────────────────────────────
  {
    const r = runGate(planted('CREATE TABLE "audit_events" ("id" uuid PRIMARY KEY);\n'), PREFIX);
    assert.notEqual(r.code, 0, '(V/table) an unprefixed CREATE TABLE must FAIL');
    assert.match(r.err, /audit_events/, '(V/table) the offending table must be named');
    assert.match(r.err, /fx_/, '(V/table) the required prefix must be named');
    console.log(`ok (V/table) — an unprefixed table is detected (exit ${r.code})`);
  }

  // ── (V) an unprefixed INDEX fails — the second accept control ────────────────────────────────
  {
    const r = runGate(
      planted('CREATE UNIQUE INDEX "ledger_kind_unique" ON "fx_ledger" USING btree ("kind");\n'),
      PREFIX,
    );
    assert.notEqual(r.code, 0, '(V/index) an unprefixed CREATE UNIQUE INDEX must FAIL');
    assert.match(r.err, /ledger_kind_unique/, '(V/index) the offending index must be named');
    console.log(`ok (V/index) — an unprefixed index is detected (exit ${r.code})`);
  }

  // ── (V) reaching into a PLATFORM table — altering it, or indexing it ─────────────────────────
  {
    const r = runGate(planted('ALTER TABLE "orgs" ADD COLUMN "fx_note" text;\n'), PREFIX);
    assert.notEqual(r.code, 0, '(V/alter) an ALTER TABLE on a platform table must FAIL');
    assert.match(r.err, /ALTER TABLE "orgs"/, '(V/alter) the platform table must be named');
    console.log(`ok (V/alter) — a pack altering a platform table is detected (exit ${r.code})`);

    const r2 = runGate(planted('CREATE INDEX "fx_orgs_slug_idx" ON "orgs" ("slug");\n'), PREFIX);
    assert.notEqual(r2.code, 0, '(V/index-target) an index ON a platform table must FAIL');
    assert.match(r2.err, /ON table "orgs"/, '(V/index-target) the indexed table must be named');
    console.log(
      `ok (V/index-target) — a pack indexing a platform table is detected (exit ${r2.code})`,
    );
  }

  // ── (D) a destructive statement fails — there is no allowlist to clear it ────────────────────
  {
    const r = runGate(planted('DROP TABLE "fx_ledger";\n'), PREFIX);
    assert.notEqual(r.code, 0, '(D) a destructive statement must FAIL');
    assert.match(r.err, /destructive/i, '(D) the failure must say the statement is destructive');
    console.log(`ok (D) — a destructive statement is refused (exit ${r.code})`);
  }
  for (const sql of [
    'ALTER TABLE "fx_ledger" DROP COLUMN "old", ADD COLUMN "new" text;',
    'ALTER TABLE "fx_ledger" ALTER COLUMN "kind" TYPE uuid USING "kind"::uuid, ADD COLUMN "b" text;',
    'ALTER TABLE "fx_ledger" ADD COLUMN "c" text, ALTER COLUMN "tenant_id" SET NOT NULL;',
    'ALTER TABLE "fx_ledger" DROP CONSTRAINT "c1", ADD CONSTRAINT "fx_c2" CHECK ("kind" <> \'\');',
  ]) {
    const r = runGate(planted(`${sql}\n`), PREFIX);
    assert.notEqual(r.code, 0, `(D/combined) must FAIL: ${sql}`);
    assert.match(r.err, /destructive/i, `(D/combined) must be named destructive: ${sql}`);
  }
  console.log('ok (D/combined) — a destructive action beside an ADD is refused (4 shapes)');
  for (const sql of [
    'INSERT INTO "fx_ledger" ("kind") VALUES (\'seed\');',
    'GRANT SELECT ON "fx_ledger" TO "reporting";',
  ]) {
    assert.equal(
      scanMigrationSql(sql, []).findings.length,
      0,
      `(A) the control requires a statement the core does NOT name: ${sql}`,
    );
    const r = runGate(planted(`${sql}\n`), PREFIX);
    assert.notEqual(r.code, 0, `(A) an unanticipated statement must FAIL closed: ${sql}`);
    assert.match(
      r.err,
      /not an additive statement/,
      `(A) the reason must be the accepted set: ${sql}`,
    );
  }
  console.log('ok (A) — a statement no detector names is refused by the accepted set (2 shapes)');

  // ── (P) parity with the platform scan: what the core refuses, this gate refuses ──────────────
  // The claim the gate is built on is a RELATION between two scanners, so it is measured against
  // the other scanner rather than asserted. The last entry is the accept control: the core passes
  // it and so does the gate, so the arm cannot be green because everything fails.
  {
    const CORPUS = [
      'ALTER TABLE "fx_t" DROP COLUMN "old", ADD COLUMN "new" text;',
      'ALTER TABLE "fx_t" ALTER COLUMN "a" TYPE uuid USING "a"::uuid, ADD COLUMN "b" text;',
      'ALTER TABLE "fx_t" ADD COLUMN "b" text NOT NULL;',
      'ALTER TABLE "fx_t" ADD COLUMN "c" text, ALTER COLUMN "d" SET NOT NULL;',
      'ALTER TABLE "fx_t" DROP COLUMN "add";',
      'ALTER TABLE "fx_t" RENAME TO "fx_u";',
      'TRUNCATE TABLE "fx_t";',
      'DELETE FROM "fx_t" WHERE "a" = 1;',
      'CREATE TABLE "fx_t" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL);',
    ];
    let refusedByCore = 0;
    let acceptedByCore = 0;
    for (const sql of CORPUS) {
      const core = scanMigrationSql(sql, []); // NO allowlist — a pack chain has none
      const r = runGate(chain({ '0000.sql': `${sql}\n` }), PREFIX);
      if (core.findings.length > 0) {
        refusedByCore += 1;
        assert.notEqual(
          r.code,
          0,
          `(P) the core refuses this [${core.findings.map((f) => f.kind).join(', ')}] but the ` +
            `pack gate passed it — a LOWER bar than the core: ${sql}`,
        );
      } else {
        acceptedByCore += 1;
        assert.equal(r.code, 0, `(P/control) the core accepts this and so must the gate: ${sql}`);
      }
    }
    assert.ok(
      refusedByCore >= 8,
      `(P) the corpus must exercise the refusals; got ${refusedByCore}`,
    );
    assert.ok(acceptedByCore >= 1, '(P) the corpus needs an accept control');
    console.log(
      `ok (P) — no lower bar than the core (${refusedByCore} refused by both, ` +
        `${acceptedByCore} accepted by both)`,
    );
  }
  for (const sql of [
    'CREATE INDEX ON "fx_ledger" ("kind");',
    'CREATE UNIQUE INDEX CONCURRENTLY ON "fx_ledger" ("kind");',
  ]) {
    const r = runGate(planted(`${sql}\n`), PREFIX);
    assert.notEqual(r.code, 0, `(U) an unnamed index must FAIL: ${sql}`);
    assert.match(
      r.err,
      /UNNAMED index/,
      `(U) the reason must be the missing NAME, not a ` +
        `fabricated prefix miss on a keyword: ${sql}\n${r.err}`,
    );
  }
  console.log('ok (U) — an unnamed index fails closed with the unnamed-index reason (2 shapes)');

  // ── (S) statements separated ONLY by drizzle's marker are still separate statements ──────────
  // The migrator splits each file on `--> statement-breakpoint` whether or not a `;` is there, so
  // a chain without semicolons is several statements to it — and must be several here. This arm
  // is the ACCEPTING one on purpose: a conforming semicolon-free chain must pass AND be counted as
  // two statements, which nothing but the marker boundary can produce.
  {
    const dir = chain({
      '0000_breakpoints.sql': [
        'CREATE TABLE "fx_a" ("id" uuid PRIMARY KEY NOT NULL)',
        '--> statement-breakpoint',
        'CREATE INDEX "fx_a_id_idx" ON "fx_a" ("id")',
        '',
      ].join('\n'),
    });
    const r = runGate(dir, PREFIX);
    assert.equal(r.code, 0, `(S) a conforming semicolon-free chain must PASS; got: ${r.err}`);
    assert.match(
      r.out,
      /2 statement\(s\)/,
      '(S) the marker must END a statement — one merged statement means the boundary was missed',
    );
    console.log(`ok (S) — the statement-breakpoint marker is a boundary (2 statements read)`);

    // And the refusing side: a planted DROP behind the marker must be seen.
    const planted2 = chain({
      '0000_breakpoints.sql': [
        'CREATE TABLE "fx_a" ("id" uuid PRIMARY KEY NOT NULL)',
        '--> statement-breakpoint',
        'DROP TABLE "orgs"',
        '--> statement-breakpoint',
        'CREATE TABLE "sessions" ("id" uuid PRIMARY KEY NOT NULL)',
        '',
      ].join('\n'),
    });
    const r3 = runGate(planted2, PREFIX);
    assert.notEqual(r3.code, 0, '(S/planted) a DROP behind the marker must FAIL');
    assert.match(r3.err, /DROP TABLE "orgs"/, '(S/planted) the planted DROP must be seen');
    assert.match(
      r3.err,
      /CREATE TABLE "sessions" does not carry/,
      '(S/planted) the unprefixed table behind it must be seen on its own too',
    );
    console.log(`ok (S/planted) — a DROP behind the marker is refused (exit ${r3.code})`);

    // And with NO separator at all, the backstop: every decision is anchored at `^`, so a merged
    // statement would be judged on its opening keywords and the tail would go unread.
    const merged = chain({
      '0000_merged.sql': [
        'CREATE TABLE "fx_a" ("id" uuid PRIMARY KEY NOT NULL)',
        'CREATE TABLE "sessions" ("id" uuid PRIMARY KEY NOT NULL)',
        '',
      ].join('\n'),
    });
    const r2 = runGate(merged, PREFIX);
    assert.notEqual(r2.code, 0, '(S/merged) a statement holding a second top-level verb must FAIL');
    assert.match(
      r2.err,
      /more than one top-level statement verb/,
      '(S/merged) the fail-closed reason must be named',
    );
    console.log(
      `ok (S/merged) — a merged statement is refused, not read at its head (exit ${r2.code})`,
    );

    // And the marker with text AHEAD of it on the same line. `readMigrationFiles` splits the RAW
    // file text on the marker and the dialect executes every chunk; drizzle parses no comments at
    // all, so `-- x --> statement-breakpoint DROP TABLE "orgs";` is TWO statements to it and the
    // second one runs. A gate that stripped comments before looking for the marker read the whole
    // line as a comment and passed the file — the marker and the statement behind it both
    // swallowed. Every payload class is driven, because pinning only the destructive half would
    // leave the namespace escape uncovered.
    for (const [payload, expected] of [
      ['DROP TABLE "orgs";', /destructive statement in a pack migration chain \[drop-table\]/],
      ['TRUNCATE TABLE "orgs";', /destructive statement in a pack migration chain \[truncate\]/],
      [
        'CREATE TABLE "sessions" ("id" uuid PRIMARY KEY NOT NULL);',
        /CREATE TABLE "sessions" does not carry/,
      ],
      ['ALTER TABLE "orgs" ADD COLUMN "leak" text;', /ALTER TABLE "orgs" does not carry/],
    ]) {
      const hidden = chain({
        '0000_commented.sql': [
          'CREATE TABLE "fx_a" ("id" uuid PRIMARY KEY NOT NULL);',
          `-- x --> statement-breakpoint ${payload}`,
          '',
        ].join('\n'),
      });
      const r4 = runGate(hidden, PREFIX);
      assert.notEqual(
        r4.code,
        0,
        `(S/commented) a marker behind a \`--\` is still a boundary to the migrator: ${payload}`,
      );
      assert.match(
        r4.err,
        expected,
        `(S/commented) the statement the migrator would RUN must be seen: ${payload}\n${r4.err}`,
      );
    }
    console.log('ok (S/commented) — a marker behind a `--` is still a boundary (4 payloads)');

    // The accept control for that arm: the same line with NO marker in it is an ordinary comment
    // and must still pass. Without this, the arm above would stay green if the gate stopped
    // stripping comments altogether and started reading every one of them as SQL.
    const commentOnly = chain({
      '0000_comment.sql': [
        'CREATE TABLE "fx_a" ("id" uuid PRIMARY KEY NOT NULL);',
        '-- x statement-breakpoint DROP TABLE "orgs";',
        '',
      ].join('\n'),
    });
    const r5 = runGate(commentOnly, PREFIX);
    assert.equal(
      r5.code,
      0,
      `(S/commented-control) a comment naming a DROP but holding NO marker must still PASS; ` +
        `got: ${r5.err}`,
    );
    console.log('ok (S/commented-control) — a comment with no marker is still a comment');

    // A marker INSIDE a literal: the migrator cuts the literal in half and runs both halves, so
    // treating the literal as intact would scan text the migrator never runs and miss text it
    // does. Cutting in the same place leaves an unterminated literal, which fails closed.
    const inLiteral = chain({
      '0000_in_literal.sql':
        'CREATE TABLE "fx_a" ("n" text DEFAULT \'x --> statement-breakpoint y\');\n',
    });
    const r6 = runGate(inLiteral, PREFIX);
    assert.notEqual(r6.code, 0, '(S/in-literal) a marker inside a literal must fail CLOSED');
    assert.match(r6.err, /UNTERMINATED/, '(S/in-literal) the fail-closed reason must be named');
    console.log(`ok (S/in-literal) — a marker inside a literal fails closed (exit ${r6.code})`);
  }

  // ── (Q) a digit-tagged dollar quote, and an unterminated literal ─────────────────────────────
  // A dollar-quote tag may hold digits after the first character (`$tag1$`). A pattern that stops
  // at letters reads the INNER `$hi$` as an opener, finds no partner and blanks the rest of the
  // file away — so what follows the literal is planted here as a NAMESPACE violation, which only
  // this splitter can catch: the destructive scan sees a blanked file and passes it.
  {
    const dir = chain({
      '0000_dollar.sql': [
        'CREATE TABLE "fx_a" ("id" uuid PRIMARY KEY, "n" text DEFAULT $tag1$hi$tag1$);',
        'CREATE TABLE "sessions" ("id" uuid PRIMARY KEY NOT NULL);',
        '',
      ].join('\n'),
    });
    const r = runGate(dir, PREFIX);
    assert.notEqual(
      r.code,
      0,
      '(Q/tag) a digit-tagged literal must not swallow the rest of the file',
    );
    assert.match(
      r.err,
      /CREATE TABLE "sessions" does not carry/,
      '(Q/tag) the statement behind the literal must be scanned on its own',
    );
    console.log(`ok (Q/tag) — a $tag1$ literal does not swallow what follows (exit ${r.code})`);

    const open = chain({
      '0000_open.sql': 'CREATE TABLE "fx_a" ("n" text DEFAULT $t$oops);\nDROP TABLE "orgs";\n',
    });
    const r2 = runGate(open, PREFIX);
    assert.notEqual(r2.code, 0, '(Q/open) an unterminated literal must FAIL, not pass');
    assert.match(r2.err, /UNTERMINATED/, '(Q/open) the fail-closed reason must be named');
    console.log(`ok (Q/open) — an unterminated literal fails closed (exit ${r2.code})`);
  }

  // ── (G) a chain that reads nothing fails CLOSED ──────────────────────────────────────────────
  {
    const empty = chain({});
    const r = runGate(empty, PREFIX);
    assert.notEqual(r.code, 0, '(G/empty) a chain with no migration files must fail CLOSED');
    assert.match(r.err, /0 migration file\(s\)/, '(G/empty) the fail-closed reason must be named');
    assert.ok(r.err.includes(empty), `(G/empty) the unscanned chain must be named; got: ${r.err}`);
    console.log(`ok (G/empty) — an empty chain fails closed (exit ${r.code})`);

    const absent = join(empty, 'not-here');
    const r2 = runGate(absent, PREFIX);
    assert.notEqual(r2.code, 0, '(G/absent) a chain directory that is not there must fail CLOSED');
    assert.match(
      r2.err,
      /0 migration file\(s\)/,
      '(G/absent) the fail-closed reason must be named',
    );
    assert.ok(
      r2.err.includes(absent),
      `(G/absent) the missing chain must be named; got: ${r2.err}`,
    );
    console.log(`ok (G/absent) — an absent chain fails closed (exit ${r2.code})`);
  }

  // ── (G) the DECLARED-SET door — the mode CI runs, and the one an edit can retire ─────────────
  // Driving only the two-argument door leaves `pnpm gate:pack-migrations` unpinned: emptying
  // DECLARED_CHAINS would report a clean pass over zero chains while the committed chain rots.
  {
    const populated = declaredSetGate([{ dir: 'chain', tablePrefix: PREFIX }]);
    mkdirSync(join(populated.ws, 'chain'), { recursive: true });
    writeFileSync(join(populated.ws, 'chain', '0000_ledger.sql'), CONFORMING);
    const r = run([populated.script]);
    assert.equal(r.code, 0, `(G/declared) a populated declared set must PASS; got: ${r.err}`);
    assert.match(
      r.out,
      /1 chain\(s\), 1 migration file\(s\)/,
      '(G/declared) the pass line must count',
    );
    console.log('ok (G/declared) — the declared-set door passes over a real chain');

    const emptied = declaredSetGate([]);
    const r2 = run([emptied.script]);
    assert.notEqual(r2.code, 0, '(G/declared-empty) an EMPTY declared set must fail CLOSED');
    assert.match(r2.err, /empty scan/i, '(G/declared-empty) the fail-closed reason must be named');
    assert.match(
      r2.err,
      /DECLARED_CHAINS is EMPTY/,
      '(G/declared-empty) the empty declared set must be named',
    );
    console.log(`ok (G/declared-empty) — emptying the declared set fails closed (exit ${r2.code})`);
  }

  console.log('\npack-migrations gate regression: ALL CASES PASSED');
} finally {
  for (const d of created) rmSync(d, { recursive: true, force: true });
}
