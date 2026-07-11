/**
 * The `rayspec gen-handler` HOLES CONTRACT (the deterministic layer).
 *
 * "Bounded, vetted templates" is realized as DETERMINISTIC RENDERER FUNCTIONS — pure
 * `holes -> .ts string` — NOT the LLM imitating reference patterns. The split:
 *   - the AUTHORING SKILL does PRD -> spec + HOLE DERIVATION (which store, which business
 *     columns + types, persist mode, tool names) — validated by `doctor`/`plan`;
 *   - the DETERMINISTIC RENDERER (here) produces the handler `.ts` from the holes, so the handler code
 *     that runs in-process is byte-stable, reviewed, and unit-gated, never LLM output.
 *
 * This module is the TYPED CONTRACT a skill (or a human, or a test) passes to the renderer. It is the
 * SINGLE SOURCE OF TRUTH for what a hole-set may contain; the renderers in `templates.ts` consume it
 * and the validator below (`validateHoles`) fail-closes on a malformed hole-set BEFORE any code is
 * emitted. The deployable `rayspec.yaml` stays STANDARD — there are NO codegen annotations in the
 * spec; the holes are derived FROM the spec by the skill and passed to the renderer out-of-band.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * TRUSTED-AUTHOR, NOT SANDBOXED (binding posture).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The handlers this renderer EMITS run IN OUR PROCESS. The capability scoping baked into every
 * rendered handler (type-only SDK import, the injected tenant-bound `init.db`, declared-store-only,
 * no npm deps, untrusted-arg coercion) is a SOUND DEFENSE-IN-DEPTH AUTHORING DISCIPLINE — but it is
 * NOT a sandbox. Real per-tenant isolation is the deferred hardening isolate (before external exposure). The two CI gates
 * (`gate:handler-imports`, `gate:extension-capability`) are TRIPWIRES, not a sandbox. No rendered
 * comment, doc, or skill line may imply a generated handler is sandboxed.
 */

/**
 * The closed `ColumnType` set the platform supports (mirrors `@rayspec/spec` `grammar.ts:93` — kept
 * as a local literal so the renderer takes NO `@rayspec/spec` dep beyond what the CLI already has;
 * `validateHoles` rejects any other type). Arrays/floats map to `jsonb` upstream, never a typed
 * scalar array — the renderer never sees them.
 */
export type ColumnType = 'text' | 'uuid' | 'timestamp' | 'integer' | 'boolean' | 'jsonb';

const COLUMN_TYPES: ReadonlySet<string> = new Set<ColumnType>([
  'text',
  'uuid',
  'timestamp',
  'integer',
  'boolean',
  'jsonb',
]);

/**
 * One persistable / projected business column. `col` is the snake_case DECLARED column name (the wire
 * shape the spec + the tool args speak). `jsonType` is its `ColumnType`. `required` (persist) means a
 * missing/ill-typed arg FAILS the coercion (returns `{status:'failed'}`, never throws). `enumValues`
 * constrains a text column to a closed literal set (e.g. `policy_flag: [ok, review, violation]`); a
 * value outside the set fails the coercion.
 *
 * INVARIANT: `col` is NEVER an injected/server column (`id`/`tenant_id`/`created_at`/`deleted_at`/
 * `retention_days`/`region`) — `validateHoles` rejects those (the facade rejects them too at runtime;
 * this is the authoring-time fence so the renderer never even emits a write to one).
 */
export interface ColumnHole {
  /** The snake_case declared column name (the args + spec wire shape). */
  readonly col: string;
  /** The declared `ColumnType`. */
  readonly jsonType: ColumnType;
  /** Whether a missing/ill-typed value FAILS the coercion (persist). Lookup projections ignore this. */
  readonly required: boolean;
  /** Whether the column is nullable (a missing optional value becomes `null` rather than being dropped). */
  readonly nullable: boolean;
  /** OPTIONAL closed literal set for a `text` column (a value outside the set fails the coercion). */
  readonly enumValues?: readonly string[];
}

/** The server-controlled / injected columns a handler may NEVER write (mirrors the runtime facade). */
export const INJECTED_COLUMNS: ReadonlySet<string> = new Set([
  'id',
  'tenant_id',
  'created_at',
  'deleted_at',
  'retention_days',
  'region',
]);

/**
 * An OPTIONAL foreign-key re-validation hole (T1): before writing, re-check a model-chosen code arg
 * against a fresh `init.db.select` on a LOOKUP store, so the model's choice is verified server-side and
 * never trusted. (The golden re-validates `category_code` against `expense_categories`.)
 */
export interface FkRevalidateHole {
  /** The snake_case arg/column whose value must be a real code in the lookup store. */
  readonly codeArg: string;
  /** The declared LOOKUP store to re-check the code against. */
  readonly lookupStore: string;
  /** The column in the lookup store the code must match (snake_case). */
  readonly lookupColumn: string;
  /** OPTIONAL fixed predicate AND-combined into the re-check (e.g. `{ active: true }`). */
  readonly lookupFixedFilter?: Readonly<Record<string, string | number | boolean>>;
}

/** The persist mode (T1): an UPDATE of an existing row by its id, OR an upsert by a natural key. */
export type PersistMode = 'update-by-id' | 'upsert-by-natural-key';

/** The holes for the auto-persist tool handler (Template T1). */
export interface PersistHandlerHoles {
  /** Discriminator. */
  readonly template: 'persist';
  /** The exported handler symbol name (camelCase; e.g. `codeClaim`). */
  readonly exportName: string;
  /** The DECLARED target store name (snake_case). The facade fail-closes on any other name. */
  readonly store: string;
  /** The persistable business columns (NEVER an injected column — `validateHoles` rejects those). */
  readonly columns: readonly ColumnHole[];
  /** The persist mode. */
  readonly mode: PersistMode;
  /**
   * For `update-by-id`: the snake_case ARG name carrying the row id to update (e.g. `claim_id`). The
   * value is validated as DATA (a non-empty string) and used ONLY as the `{ id }` filter.
   */
  readonly idArg?: string;
  /**
   * For `upsert-by-natural-key`: the snake_case business column that is the model-derivable natural
   * key. The renderer tenant-NAMESPACES it server-side (`${tenantId}:${value}`) so it is exactly-once
   * WITHIN the tenant and never collides cross-tenant. The key column MUST be
   * one of `columns` (it is written as the namespaced ref, not the raw value).
   */
  readonly naturalKeyCol?: string;
  /** OPTIONAL server-side FK re-validation before the write. */
  readonly fkRevalidate?: FkRevalidateHole;
  /**
   * OPTIONAL server-STAMPED fixed column values written ON TOP of the coerced args (e.g. set
   * `status: 'coded'` on a successful code). These are author-decided CONSTANTS — NOT model args — so
   * a model can never override them (they overwrite any same-named coerced value). Keys are declared
   * business columns (never injected); values are scalars. (The golden stamps `status: 'coded'`.)
   */
  readonly fixedValues?: Readonly<Record<string, string | number | boolean>>;
  /** The status string returned on a successful persist (e.g. `coded` / `persisted`). */
  readonly successStatus: string;
}

/** The holes for the store-lookup tool handler (Template T2). */
export interface LookupHandlerHoles {
  /** Discriminator. */
  readonly template: 'lookup';
  /** The exported handler symbol name (camelCase; e.g. `lookupCategories`). */
  readonly exportName: string;
  /** The DECLARED store to read (snake_case). */
  readonly store: string;
  /**
   * The CLOSED filter-column allowlist (snake_case): ONLY these args may build the equality filter. A
   * non-allowlisted arg key is DROPPED (it can never craft a filter over an unintended/injected
   * column). May be empty (the lookup then keys only on the fixed predicate).
   */
  readonly filterCols: readonly string[];
  /** OPTIONAL fixed predicate AND-combined into every lookup (e.g. `{ active: true }`). */
  readonly fixedFilter?: Readonly<Record<string, string | number | boolean>>;
  /** The columns to PROJECT into each returned row (snake_case). The injected cols are never projected. */
  readonly projectCols: readonly string[];
  /** The hard cap on rows returned to the model (bounds the context / unbounded-leak surface). */
  readonly maxRows: number;
  /**
   * OPTIONAL in-memory case-insensitive SUBSTRING filter: when the model passes `substringArg`, rows
   * whose `substringCol` contains it (case-insensitive) are kept. Applied AFTER the DB equality filter,
   * in memory, over the already-tenant-scoped + capped-candidate set. Both must be set together.
   */
  readonly substringArg?: string;
  readonly substringCol?: string;
}

/** The discriminated hole-set the renderer accepts. (T3 shape-map is an internal helper, not a top-level template.) */
export type HandlerHoles = PersistHandlerHoles | LookupHandlerHoles;

/** A fail-closed holes-validation error (a malformed hole-set never reaches a renderer). */
export class HolesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HolesError';
  }
}

/** A valid TS identifier (an export name / used as a `const` symbol) — letters/_/$ then word chars. */
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** A valid snake_case column/store name (lowercase letters, digits, underscore; must start a letter). */
const SNAKE_RE = /^[a-z][a-z0-9_]*$/;
/**
 * A comment-safe status label (e.g. `coded` / `persisted` / `re-coded`): letters/digits/space/_/-. It
 * is spliced into a JSDoc comment in the rendered handler, so this charset guarantees no comment-closing
 * sequence, backtick, newline, or template-interpolation start can survive — the renderer can splice it
 * without escaping.
 */
const STATUS_LABEL_RE = /^[A-Za-z0-9 _-]+$/;

/** Assert a string is a safe TS identifier (export symbol). */
function assertIdent(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !IDENT_RE.test(value)) {
    throw new HolesError(`${what} must be a valid identifier, got ${JSON.stringify(value)}`);
  }
}

/** Assert a string is a safe snake_case name (store/column). This is what makes string-templating safe. */
function assertSnake(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !SNAKE_RE.test(value)) {
    throw new HolesError(
      `${what} must be a snake_case name ([a-z][a-z0-9_]*), got ${JSON.stringify(value)}`,
    );
  }
}

/** Assert a fixed-filter map is a plain map of snake_case keys → scalar values (no SQL/object/etc.). */
function assertFixedFilter(
  filter: Readonly<Record<string, unknown>> | undefined,
  what: string,
): void {
  if (filter === undefined) return;
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
    throw new HolesError(`${what} must be a plain object of column → scalar`);
  }
  for (const [k, v] of Object.entries(filter)) {
    assertSnake(k, `${what} key`);
    const t = typeof v;
    if (t !== 'string' && t !== 'number' && t !== 'boolean') {
      throw new HolesError(`${what}.${k} must be a string/number/boolean scalar, got ${t}`);
    }
  }
}

/** Assert one column hole is well-formed (snake name, known type, business-not-injected). */
function assertColumnHole(c: unknown, what: string): asserts c is ColumnHole {
  if (typeof c !== 'object' || c === null) throw new HolesError(`${what} must be an object`);
  const o = c as Record<string, unknown>;
  assertSnake(o.col, `${what}.col`);
  if (INJECTED_COLUMNS.has(o.col as string)) {
    throw new HolesError(
      `${what}.col '${String(o.col)}' is a server-controlled/injected column — a handler may never ` +
        'write id/tenant_id/created_at/deleted_at/retention_days/region (fail-closed).',
    );
  }
  if (typeof o.jsonType !== 'string' || !COLUMN_TYPES.has(o.jsonType)) {
    throw new HolesError(
      `${what}.jsonType must be one of text|uuid|timestamp|integer|boolean|jsonb, got ` +
        JSON.stringify(o.jsonType),
    );
  }
  if (typeof o.required !== 'boolean') throw new HolesError(`${what}.required must be a boolean`);
  if (typeof o.nullable !== 'boolean') throw new HolesError(`${what}.nullable must be a boolean`);
  if (o.enumValues !== undefined) {
    if (
      !Array.isArray(o.enumValues) ||
      o.enumValues.length === 0 ||
      !o.enumValues.every((v) => typeof v === 'string')
    ) {
      throw new HolesError(`${what}.enumValues must be a non-empty array of strings when present`);
    }
    if (o.jsonType !== 'text') {
      throw new HolesError(`${what}.enumValues is only valid on a 'text' column`);
    }
  }
}

/**
 * Fail-closed validate a hole-set BEFORE rendering. Every name that gets string-templated into the
 * emitted source is checked against a strict charset here, so the renderer can splice them without an
 * injection risk (no escaping needed: a name that passed `assertSnake`/`assertIdent` contains only
 * `[A-Za-z0-9_$]`). Throws `HolesError` on the FIRST problem (the skill's self-correction loop re-derives).
 */
export function validateHoles(holes: unknown): asserts holes is HandlerHoles {
  if (typeof holes !== 'object' || holes === null) {
    throw new HolesError('holes must be an object');
  }
  const h = holes as Record<string, unknown>;
  if (h.template !== 'persist' && h.template !== 'lookup') {
    throw new HolesError(
      `holes.template must be 'persist' or 'lookup', got ${JSON.stringify(h.template)}`,
    );
  }
  assertIdent(h.exportName, 'holes.exportName');
  assertSnake(h.store, 'holes.store');

  if (h.template === 'persist') {
    if (!Array.isArray(h.columns) || h.columns.length === 0) {
      throw new HolesError('persist holes.columns must be a non-empty array');
    }
    (h.columns as unknown[]).forEach((c, i) => {
      assertColumnHole(c, `holes.columns[${i}]`);
    });
    const colNames = new Set((h.columns as ColumnHole[]).map((c) => c.col));
    if (colNames.size !== (h.columns as ColumnHole[]).length) {
      throw new HolesError('persist holes.columns has duplicate column names');
    }
    if (h.mode !== 'update-by-id' && h.mode !== 'upsert-by-natural-key') {
      throw new HolesError(`persist holes.mode must be 'update-by-id' or 'upsert-by-natural-key'`);
    }
    // successStatus is spliced into BOTH a string literal (emitScalar-quoted — always safe) AND a JSDoc
    // comment (`/** The success status (…) */`), so an unescaped `*/` would close the comment early and
    // emit a non-compiling file. Fence it to a comment-safe label charset (letters/digits/space/_/-) so
    // it can never carry `*/`, a backtick, a newline, or `${` — no escaping needed at the splice sites.
    if (
      typeof h.successStatus !== 'string' ||
      h.successStatus.length === 0 ||
      !STATUS_LABEL_RE.test(h.successStatus)
    ) {
      throw new HolesError(
        'persist holes.successStatus must be a non-empty status label ([A-Za-z0-9 _-]+, e.g. ' +
          `'coded' / 'persisted'), got ${JSON.stringify(h.successStatus)}`,
      );
    }
    if (h.mode === 'update-by-id') {
      assertSnake(h.idArg, 'persist holes.idArg (required for update-by-id)');
    } else {
      assertSnake(
        h.naturalKeyCol,
        'persist holes.naturalKeyCol (required for upsert-by-natural-key)',
      );
      if (!colNames.has(h.naturalKeyCol as string)) {
        throw new HolesError(
          `persist holes.naturalKeyCol '${String(h.naturalKeyCol)}' must be one of holes.columns`,
        );
      }
    }
    if (h.fkRevalidate !== undefined) {
      const fk = h.fkRevalidate as Record<string, unknown>;
      assertSnake(fk.codeArg, 'holes.fkRevalidate.codeArg');
      assertSnake(fk.lookupStore, 'holes.fkRevalidate.lookupStore');
      assertSnake(fk.lookupColumn, 'holes.fkRevalidate.lookupColumn');
      assertFixedFilter(
        fk.lookupFixedFilter as Record<string, unknown> | undefined,
        'holes.fkRevalidate.lookupFixedFilter',
      );
      if (!colNames.has(fk.codeArg as string)) {
        throw new HolesError(
          `holes.fkRevalidate.codeArg '${String(fk.codeArg)}' must be one of holes.columns ` +
            '(the re-validated code is a persisted business column)',
        );
      }
      // A lookupFixedFilter key equal to lookupColumn emits a duplicate object key in the FK re-check
      // filter literal (`{ <lookupColumn>: <fixed>, <lookupColumn>: code }`) — last-wins silently drops
      // the fixed predicate AND signals an incoherent hole-set (the author both pins that column to a
      // constant AND matches the model code against it). Fail closed (mirrors the other incoherence
      // rejections); the author should pin a DIFFERENT column (e.g. `active:true`) in lookupFixedFilter.
      if (
        fk.lookupFixedFilter !== undefined &&
        Object.hasOwn(fk.lookupFixedFilter as Record<string, unknown>, fk.lookupColumn as string)
      ) {
        throw new HolesError(
          `holes.fkRevalidate.lookupFixedFilter must not contain the lookupColumn ` +
            `'${String(fk.lookupColumn)}' — that column is matched against the model code, so a fixed ` +
            'predicate on it would collide (a duplicate filter key, last-wins). Pin a different column.',
        );
      }
    }
    if (h.fixedValues !== undefined) {
      assertFixedFilter(h.fixedValues as Record<string, unknown> | undefined, 'holes.fixedValues');
      const fixedKeys = Object.keys(h.fixedValues as Record<string, unknown>);
      for (const k of fixedKeys) {
        if (INJECTED_COLUMNS.has(k)) {
          throw new HolesError(
            `holes.fixedValues key '${k}' is a server-controlled/injected column — a handler may never ` +
              'write id/tenant_id/created_at/deleted_at/retention_days/region (fail-closed).',
          );
        }
      }
      // A fixedValues key that overlaps fkRevalidate.codeArg silently NO-OPS the FK re-validation: the
      // renderer FK-validates the model's coerced value, then Object.assign overwrites it with the
      // author constant as the LAST mutation before the write — so a non-FK-validated constant is what
      // persists. Fail closed on the incoherent overlap (mirrors the codeArg-not-in-columns /
      // injected-col-in-fixedValues / duplicate-column rejections already enforced above).
      const fkCodeArg =
        h.fkRevalidate !== undefined
          ? (h.fkRevalidate as Record<string, unknown>).codeArg
          : undefined;
      if (typeof fkCodeArg === 'string' && fixedKeys.includes(fkCodeArg)) {
        throw new HolesError(
          `holes.fixedValues key '${fkCodeArg}' overlaps holes.fkRevalidate.codeArg — the author ` +
            'constant would overwrite the FK-re-validated model value as the last write, silently ' +
            'no-op-ing the FK safety. Remove it from fixedValues (let the FK-validated arg persist) or ' +
            'pick a different FK code column.',
        );
      }
    }
    return;
  }

  // lookup
  if (!Array.isArray(h.filterCols) || !h.filterCols.every((c) => typeof c === 'string')) {
    throw new HolesError('lookup holes.filterCols must be an array of strings');
  }
  h.filterCols.forEach((c, i) => {
    assertSnake(c, `holes.filterCols[${i}]`);
  });
  assertFixedFilter(h.fixedFilter as Record<string, unknown> | undefined, 'holes.fixedFilter');
  if (!Array.isArray(h.projectCols) || h.projectCols.length === 0) {
    throw new HolesError('lookup holes.projectCols must be a non-empty array');
  }
  h.projectCols.forEach((c, i) => {
    assertSnake(c, `holes.projectCols[${i}]`);
  });
  if (
    typeof h.maxRows !== 'number' ||
    !Number.isInteger(h.maxRows) ||
    h.maxRows <= 0 ||
    h.maxRows > 10000
  ) {
    throw new HolesError('lookup holes.maxRows must be an integer in 1..10000');
  }
  if ((h.substringArg === undefined) !== (h.substringCol === undefined)) {
    throw new HolesError('lookup holes.substringArg and holes.substringCol must be set together');
  }
  if (h.substringArg !== undefined) {
    assertSnake(h.substringArg, 'holes.substringArg');
    assertSnake(h.substringCol, 'holes.substringCol');
  }
}
