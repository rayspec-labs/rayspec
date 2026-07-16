/**
 * Home-grown destructive-migration SQL scan — the migration GATE.
 *
 * IMPORTANT: the gate is THIS custom scan, NOT `atlas migrate lint`. Atlas lint's hosted
 * destructive-policy report is Pro-gated since v0.38, so community Atlas
 * gives us diff + shadow-DB dry-run but NOT a destructive policy. This module is the
 * destructive policy: a deploy pipeline runs `scanMigrationSql()` on each generated migration
 * and BLOCKS unless every destructive statement is matched by an explicit reviewed allowlist
 * entry.
 *
 * The scan deliberately covers the FULL destructive vocabulary — DROP SCHEMA CASCADE, DROP
 * CONSTRAINT/INDEX, DELETE FROM, RENAME TO, newline-split DROP\nCOLUMN, and — critically for the
 * identity migration — a bare TRUNCATE in a multi-statement file and a column-type-change `USING`-cast —
 * not merely a narrow `DROP COLUMN|TABLE|TRUNCATE` match. It catches all of those AND specifically
 * TRUNCATE + the text→uuid USING-cast.
 *
 * Comment-strip + statement-split are LITERAL-AWARE (a small tokenizer): a `--` or a `;` that
 * appears INSIDE a single-quoted string or a dollar-quoted ($tag$...$tag$) body is NOT treated
 * as a comment / statement terminator. A naive per-line `--.*$` strip truncated the line at a
 * `--` inside a literal and silently dropped the rest of the statement (and any DROP/TRUNCATE
 * after it) before the destructive detectors ran. Genuine `--` line
 * comments and slash-star block comments are still removed.
 */

export type DestructiveKind =
  | 'truncate'
  | 'using-cast'
  | 'type-change-no-using'
  | 'drop-column'
  | 'drop-table'
  | 'drop-database'
  | 'drop-owned'
  | 'drop-schema'
  | 'drop-view'
  | 'drop-constraint'
  | 'drop-index'
  | 'delete-from'
  | 'delete-no-where'
  | 'update-no-where'
  | 'rename-table'
  | 'rename-column'
  // Adding a NOT NULL column with NO default, or SET NOT NULL on an existing
  // column — safe on an EMPTY table, but BREAKS on a populated one (a backfill is needed first).
  // Flag-for-review (not a hard block on an empty table), cleared by a reviewed allowlist entry.
  | 'add-column-not-null-no-default'
  | 'set-not-null';

export interface DestructiveFinding {
  kind: DestructiveKind;
  /** 1-based line number in the migration SQL. */
  line: number;
  /** The offending statement text (trimmed). */
  text: string;
  /** Whether an explicit allowlist entry cleared this finding. */
  allowed: boolean;
}

export interface ScanResult {
  findings: DestructiveFinding[];
  /** True if EVERY destructive finding is covered by an allowlist entry (safe to apply). */
  pass: boolean;
}

/**
 * A reviewed allowlist entry: clears one destructive finding. Matched by `kind` PLUS a `match`
 * that must equal the ENTIRE (whitespace-collapsed, trailing-`;`-stripped) offending statement —
 * so an entry is tied to the EXACT statement it reviewed, not a brittle line number that shifts
 * when the file is edited.
 *
 * The exact-equality rule: the match is anchored to the full statement (exact equality), NOT an unanchored
 * `.includes()` substring. A substring match meant a short, reviewed `match` could silently clear
 * a DIFFERENT, unreviewed statement that merely happened to contain those characters (e.g. a
 * `match` of `TRUNCATE TABLE "x"` clearing a later `TRUNCATE TABLE "x", "secrets"`). Full-statement
 * equality closes that: an entry clears one and only one specific statement.
 */
export interface AllowlistEntry {
  kind: DestructiveKind;
  /**
   * The FULL collapsed statement (trailing `;` optional) this entry clears. Must equal the
   * offending statement exactly (after collapsing whitespace + stripping a trailing `;`).
   */
  match: string;
  /** A human reason recorded in review (required — no silent passes). */
  reason: string;
}

/** Strip a single trailing `;` (and surrounding space) so allowlist match is `;`-insensitive. */
function stripTerminator(s: string): string {
  return s.replace(/\s*;\s*$/, '').trim();
}

// Each detector is whitespace-tolerant (collapses runs of whitespace incl. newlines) and
// case-insensitive. Statements are scanned on the COLLAPSED text so a newline-split
// `DROP\nCOLUMN` is caught. Order matters only for which `kind` is reported first; every
// matching detector emits a finding.
//
// The high-blast forms an earlier scan missed are added here — DROP DATABASE,
// DROP OWNED BY, a mass UPDATE/DELETE with no WHERE, a RENAME COLUMN, a column type change with
// NO USING (which Postgres rewrites/can fail on incompatible data), and a plain DROP VIEW.
const DETECTORS: { kind: DestructiveKind; re: RegExp }[] = [
  { kind: 'truncate', re: /\bTRUNCATE\b/i },
  // A column type change with a USING expression rewrites/casts existing data (the text→uuid
  // case): ALTER ... ALTER COLUMN ... TYPE ... USING ...
  { kind: 'using-cast', re: /\bALTER\s+COLUMN\b[\s\S]*?\bTYPE\b[\s\S]*?\bUSING\b/i },
  // A type change with NO USING: Postgres still rewrites the column and FAILS on data it cannot
  // implicitly cast — a silent break on a populated table. Flagged unless reviewed.
  {
    kind: 'type-change-no-using',
    re: /\bALTER\s+COLUMN\b(?:(?!\bUSING\b)[\s\S])*?\b(?:SET\s+DATA\s+)?TYPE\b(?:(?!\bUSING\b)[\s\S])*$/i,
  },
  { kind: 'drop-database', re: /\bDROP\s+DATABASE\b/i },
  { kind: 'drop-owned', re: /\bDROP\s+OWNED\b/i },
  { kind: 'drop-schema', re: /\bDROP\s+SCHEMA\b/i },
  { kind: 'drop-table', re: /\bDROP\s+TABLE\b/i },
  { kind: 'drop-view', re: /\bDROP\s+(?:MATERIALIZED\s+)?VIEW\b/i },
  { kind: 'drop-column', re: /\bDROP\s+COLUMN\b/i },
  // bare `DROP "col"` (no COLUMN keyword) inside an ALTER TABLE.
  { kind: 'drop-column', re: /\bALTER\s+TABLE\b[\s\S]*?\bDROP\s+"[^"]+"/i },
  { kind: 'drop-constraint', re: /\bDROP\s+CONSTRAINT\b/i },
  { kind: 'drop-index', re: /\bDROP\s+INDEX\b/i },
  // A mass mutation with no row predicate rewrites/erases an entire table. We only flag the
  // top-level statement form (UPDATE/DELETE whose collapsed text contains no WHERE keyword).
  { kind: 'delete-no-where', re: /^\s*DELETE\s+FROM\b(?:(?!\bWHERE\b)[\s\S])*$/i },
  { kind: 'update-no-where', re: /^\s*UPDATE\b(?:(?!\bWHERE\b)[\s\S])*$/i },
  // A DELETE FROM that DOES carry a WHERE is still destructive (row removal) — flag it too so a
  // reviewer must allowlist it; the no-where variant above is the higher-blast subset.
  { kind: 'delete-from', re: /\bDELETE\s+FROM\b[\s\S]*?\bWHERE\b/i },
  { kind: 'rename-table', re: /\bRENAME\s+(?:TABLE\b|TO\b)/i },
  { kind: 'rename-column', re: /\bRENAME\s+COLUMN\b/i },
  // ADD COLUMN ... NOT NULL with NO DEFAULT — safe on an empty table, but
  // Postgres rejects it on a populated one (existing rows would violate NOT NULL). Flag-for-review.
  // The negative lookahead ensures NO `DEFAULT` appears in the ADD COLUMN clause.
  {
    kind: 'add-column-not-null-no-default',
    re: /\bADD\s+(?:COLUMN\s+)?(?:(?!\bDEFAULT\b)[\s\S])*?\bNOT\s+NULL\b(?:(?!\bDEFAULT\b)[\s\S])*$/i,
  },
  // SET NOT NULL on an existing column — fails if any existing row holds NULL. Flag-for-review.
  { kind: 'set-not-null', re: /\bSET\s+NOT\s+NULL\b/i },
];

/** Collapse a statement's internal whitespace (incl. newlines) to single spaces. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

interface RawStatement {
  /** 1-based starting line number of the statement in the original SQL. */
  line: number;
  /** The statement text with comments stripped (literals preserved verbatim). */
  text: string;
}

/**
 * Split SQL into statements, LITERAL-AWARE. Walks the source char-by-char tracking lexer state
 * so that line comments, slash-star block comments, and `;` terminators inside a single-quoted string ('...', with
 * '' as the escaped quote) or a dollar-quoted body ($tag$...$tag$) are NOT mistaken for
 * structure. Comments are dropped from the emitted text; string/dollar-quote bodies are kept
 * verbatim. Statement start-line is the first non-blank line of each statement.
 */
function splitStatements(sql: string): RawStatement[] {
  const statements: RawStatement[] = [];
  let buf = '';
  let line = 1; // current line in the source
  let stmtStartLine = 0; // start line of the statement currently accumulating (0 = none yet)
  const n = sql.length;
  let i = 0;

  const pushChar = (ch: string) => {
    if (stmtStartLine === 0 && ch.trim().length > 0) stmtStartLine = line;
    buf += ch;
  };
  const endStatement = () => {
    if (buf.trim().length > 0) {
      statements.push({ line: stmtStartLine || line, text: collapse(buf) });
    }
    buf = '';
    stmtStartLine = 0;
  };

  while (i < n) {
    const ch = sql[i] as string;
    const next = i + 1 < n ? sql[i + 1] : '';

    // -- line comment (outside any literal): skip to end of line, do NOT emit.
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue; // leave the '\n' to be handled below (keeps line numbering)
    }

    // /* ... */ block comment (outside any literal): skip, counting newlines.
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) {
        if (sql[i] === '\n') line++;
        i++;
      }
      i += 2; // consume the closing */
      continue;
    }

    // Single-quoted string: copy verbatim (incl. any -- or ; inside) until the closing quote.
    // '' inside a string is an escaped quote, not a terminator.
    if (ch === "'") {
      pushChar(ch);
      i++;
      while (i < n) {
        const c = sql[i] as string;
        if (c === '\n') line++;
        if (c === "'") {
          if (sql[i + 1] === "'") {
            pushChar("'");
            pushChar("'");
            i += 2;
            continue;
          }
          pushChar("'");
          i++;
          break;
        }
        pushChar(c);
        i++;
      }
      continue;
    }

    // Dollar-quoted string $tag$ ... $tag$ (tag may be empty: $$ ... $$). Copy verbatim.
    if (ch === '$') {
      const tagMatch = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        for (const c of tag) pushChar(c);
        i += tag.length;
        const close = sql.indexOf(tag, i);
        const bodyEnd = close === -1 ? n : close;
        for (let j = i; j < bodyEnd; j++) {
          const c = sql[j] as string;
          if (c === '\n') line++;
          pushChar(c);
        }
        if (close === -1) {
          i = n;
        } else {
          for (const c of tag) pushChar(c);
          i = close + tag.length;
        }
        continue;
      }
    }

    // Statement terminator (outside any literal).
    if (ch === ';') {
      pushChar(ch);
      endStatement();
      i++;
      continue;
    }

    if (ch === '\n') line++;
    pushChar(ch);
    i++;
  }
  endStatement(); // trailing statement with no terminating ';'
  return statements;
}

/**
 * Replace the BODY of every single-quoted string literal + dollar-quoted body with spaces, so a
 * destructive KEYWORD appearing inside a literal (e.g. `INSERT INTO t (s) VALUES ('DROP TABLE x')`)
 * is NOT mistaken for a statement (the literal-stripping guard against false positives). The splitter already preserves
 * literal boundaries; here we blank only the CONTENT so the surrounding structure (and line count)
 * is intact. `''` is the escaped quote inside a string. Length is preserved (space-for-char) so any
 * positional reasoning stays valid.
 */
function stripStringLiteralBodies(s: string): string {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i] as string;
    if (ch === "'") {
      out += "'";
      i++;
      while (i < n) {
        if (s[i] === "'") {
          if (s[i + 1] === "'") {
            out += '  '; // escaped quote inside the body -> blank it
            i += 2;
            continue;
          }
          out += "'";
          i++;
          break;
        }
        out += s[i] === '\n' ? '\n' : ' '; // blank the body char (keep newlines for line counting)
        i++;
      }
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(s.slice(i))?.[0];
      if (tag) {
        out += tag;
        i += tag.length;
        const close = s.indexOf(tag, i);
        const end = close === -1 ? n : close;
        for (let j = i; j < end; j++) out += s[j] === '\n' ? '\n' : ' ';
        if (close === -1) {
          i = n;
        } else {
          out += tag;
          i = close + tag.length;
        }
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Scan migration SQL for destructive statements. Uses the literal-aware `splitStatements`
 * tokenizer (comments + `;` terminators inside string/dollar-quote literals are NOT mistaken
 * for structure), maps each statement back to its starting line, runs every detector on a
 * literal-stripped copy (the literal-stripping guard: a destructive keyword inside a string literal is NOT flagged), and
 * marks a finding `allowed` only if a matching allowlist entry (same kind + full-statement
 * equality) exists. `pass` is true iff no UN-allowlisted destructive finding remains.
 */
export function scanMigrationSql(sql: string, allowlist: AllowlistEntry[] = []): ScanResult {
  const findings: DestructiveFinding[] = [];
  const statements = splitStatements(sql);

  for (const stmt of statements) {
    const collapsedStmt = stripTerminator(stmt.text);
    // The literal-stripping guard: detectors run on the literal-stripped text so a destructive keyword inside a string
    // literal is not a false positive; the finding TEXT + allowlist match use the ORIGINAL stmt.
    const detectText = stripStringLiteralBodies(stmt.text);
    for (const det of DETECTORS) {
      if (det.re.test(detectText)) {
        // The exact-equality rule: the allowlist entry must match the ENTIRE statement (exact equality after
        // collapsing whitespace + stripping a trailing `;`), not be a contained substring.
        const allowed = allowlist.some(
          (a) => a.kind === det.kind && stripTerminator(a.match) === collapsedStmt,
        );
        findings.push({ kind: det.kind, line: stmt.line, text: stmt.text, allowed });
      }
    }
  }

  const pass = findings.every((f) => f.allowed);
  return { findings, pass };
}

/** Pretty one-line summary per finding for CI logs. */
export function formatFindings(result: ScanResult): string {
  if (result.findings.length === 0) return 'destructive-scan: no destructive statements.';
  return result.findings
    .map(
      (f) =>
        `  [${f.allowed ? 'ALLOWED' : 'BLOCKED'}] ${f.kind} @ line ${f.line}: ${f.text.slice(0, 100)}`,
    )
    .join('\n');
}
