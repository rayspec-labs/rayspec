/**
 * The DETERMINISTIC handler renderers (the bounded-template catalog T1/T2/T3).
 *
 * Pure `holes -> module source` functions, rendered for one of two EMIT TARGETS (TypeScript source or
 * plain ESM JavaScript — see `EmitTarget`). The emitted code is byte-stable for fixed holes
 * (golden-gated), imports `@rayspec/handler-sdk` TYPE-ONLY, takes ZERO npm deps, reaches the DB ONLY
 * through the injected tenant-bound `init.db` facade, coerces every model arg as UNTRUSTED DATA (never throws —
 * returns `{status:'failed'}`, the fail-soft coercion pattern), never writes injected/server
 * columns, and (T1 upsert arm) tenant-NAMESPACES the natural key server-side. See `holes.ts` for the
 * trusted-author-NOT-sandboxed posture (the hardening isolate is the real boundary; this is authoring
 * discipline + a CI tripwire).
 *
 * SAFETY OF STRING-TEMPLATING: every name spliced below (`exportName`, `store`, `col`, …) has passed
 * `validateHoles` (strict `[a-z][a-z0-9_]*` / identifier charset), so a name can never carry a quote,
 * backtick, newline, or `${` — there is no injection vector through a name. Fixed-filter VALUES are
 * scalars; they are emitted via `JSON.stringify` (T3 `emitScalar`), so a string value is a safe quoted
 * literal regardless of content.
 */
import {
  type ColumnHole,
  type HandlerHoles,
  type LookupHandlerHoles,
  type PersistHandlerHoles,
  validateHoles,
} from './holes.js';

/**
 * The emit TARGET — annotated TypeScript source (`ts`, the default) or plain ESM JavaScript (`js`).
 *
 * The templates use TypeScript for ANNOTATIONS and for the TYPE-ONLY SDK import ONLY, so the two
 * targets render the SAME program: `js` drops exactly what a compiler would erase and nothing else.
 * That makes the `js` render deployable as it stands (production loads compiled JavaScript only),
 * while the `ts` render stays byte-for-byte what it has always been (the goldens gate precisely that).
 */
export type EmitTarget = 'ts' | 'js';

/** A type annotation `: T` — emitted for `ts`, erased for `js`. */
function ann(target: EmitTarget, type: string): string {
  return target === 'ts' ? `: ${type}` : '';
}

/** A type assertion `<expr> as T` — emitted for `ts`, reduced to the bare expression for `js`. */
function asType(target: EmitTarget, expr: string, type: string): string {
  return target === 'ts' ? `${expr} as ${type}` : expr;
}

/** The shared file header every rendered handler carries (the honest trusted-author-NOT-sandboxed note). */
const HEADER = (kind: 'persist' | 'lookup', target: EmitTarget): string =>
  `// AUTO-GENERATED ${kind === 'persist' ? 'persist-tool' : 'store-lookup'} handler ` +
  `(bounded template ${kind === 'persist' ? 'T1' : 'T2'}). Do NOT edit by hand —
// regenerate via \`rayspec gen-handler\`. TRUSTED-AUTHOR, NOT SANDBOXED: it runs in-process; the two
// CI gates (handler-imports / extension-capability) are TRIPWIRES, not a sandbox — the real per-tenant
// isolate is a later hardening milestone (deferred). ${
    target === 'ts'
      ? 'Imports @rayspec/handler-sdk TYPE-ONLY'
      : 'ZERO imports (the SDK types are compile-time only)'
  }; ZERO npm deps; reaches
// the DB ONLY through the injected, tenant-bound, declared-stores-only init.db facade.`;

/** Emit a JS scalar literal for a fixed-filter value (string/number/boolean) — JSON-safe quoting. */
function emitScalar(value: string | number | boolean): string {
  return JSON.stringify(value);
}

/**
 * Emit a member access `obj.col` (a validated snake_case col is always a safe JS identifier — see
 * `validateHoles`'s `[a-z][a-z0-9_]*` charset — so dot-access is safe + lint-clean [useLiteralKeys]).
 */
function member(obj: string, col: string): string {
  return `${obj}.${col}`;
}

/** Emit a fixed-filter object literal `{ a: 1, b: "x" }` (keys are validated snake names). */
function emitFixedFilter(filter: Readonly<Record<string, string | number | boolean>>): string {
  const parts = Object.entries(filter).map(([k, v]) => `${k}: ${emitScalar(v)}`);
  return `{ ${parts.join(', ')} }`;
}

/**
 * T3 — per-column coercion of ONE untrusted arg into the row, by `ColumnType` + required/nullable/enum.
 * Emits a block that reads `o['<col>']` and either assigns `row['<col>']`, sets `null`, drops the key,
 * or `return { ... failed }`. NEVER throws. `enumValues` constrains a text column to a closed set.
 */
function emitCoerceColumn(c: ColumnHole, target: EmitTarget): string {
  const col = c.col;
  const v = member('o', col);
  const rowCol = member('row', col);
  // The "missing/invalid" tail (emitted INSIDE coerceRow, so it returns the coerceRow failed shape):
  // required -> fail; nullable -> set null; else -> drop (leave the column unset).
  const onBad = c.required
    ? `return { ok: false, status: 'failed', detail: ${emitScalar(`arg ${col} missing or invalid.`)} };`
    : c.nullable
      ? `${rowCol} = null;`
      : '/* optional + non-nullable: drop a missing/invalid value (leave the column unset) */';

  switch (c.jsonType) {
    case 'text':
    case 'uuid': {
      if (c.enumValues && c.jsonType === 'text') {
        const set = `[${c.enumValues.map((e) => emitScalar(e)).join(', ')}]`;
        const members = target === 'ts' ? `(${set} as readonly string[])` : set;
        return `  // ${col}: text (closed enum) — UNTRUSTED arg, membership-checked.
  {
    const val = ${v};
    if (typeof val === 'string' && ${members}.includes(val)) {
      ${rowCol} = val;
    } else { ${onBad} }
  }`;
      }
      return `  // ${col}: ${c.jsonType} — UNTRUSTED arg, must be a string.
  {
    const val = ${v};
    if (typeof val === 'string') { ${rowCol} = val; }
    else { ${onBad} }
  }`;
    }
    case 'integer':
      return `  // ${col}: integer — UNTRUSTED arg, must be a safe integer.
  {
    const val = ${v};
    if (typeof val === 'number' && Number.isInteger(val)) { ${rowCol} = val; }
    else { ${onBad} }
  }`;
    case 'boolean':
      return `  // ${col}: boolean — UNTRUSTED arg, strict true/false (anything else is invalid).
  {
    const val = ${v};
    if (typeof val === 'boolean') { ${rowCol} = val; }
    else { ${onBad} }
  }`;
    case 'timestamp':
      return `  // ${col}: timestamp — UNTRUSTED arg, must be a parseable ISO date string.
  {
    const val = ${v};
    if (typeof val === 'string' && !Number.isNaN(Date.parse(val))) { ${rowCol} = val; }
    else { ${onBad} }
  }`;
    case 'jsonb':
      return `  // ${col}: jsonb — UNTRUSTED arg, must be a plain JSON object/array (not a function/class).
  {
    const val = ${v};
    if (val !== null && (Array.isArray(val) || (typeof val === 'object' && Object.getPrototypeOf(val) === Object.prototype))) {
      ${rowCol} = val;
    } else { ${onBad} }
  }`;
  }
}

/** Build the `coerceRow` helper body for a persist template (T1 + T3). */
function emitCoerceRow(holes: PersistHandlerHoles, target: EmitTarget): string {
  const blocks = holes.columns.map((c) => emitCoerceColumn(c, target)).join('\n');
  const coerceResult =
    "{ ok: true; row: StoreRow } | { ok: false; status: 'failed'; detail: string }";
  return `/**
 * Coerce the UNTRUSTED model args into the row to persist (T3 shape-map + per-ColumnType coercion).
 * Drops any non-declared key (additionalProperties:false parity with the tool parameters), never
 * throws (returns a failed result on a required/enum violation), and never writes an injected column.
 */
function coerceRow(args${ann(target, 'Record<string, unknown>')})${ann(target, coerceResult)} {
  const o = typeof args === 'object' && args !== null ? ${asArgsRecord(target)} : {};
  const row${ann(target, 'StoreRow')} = {};
${blocks}
  return { ok: true, row };
}`;
}

/** The `args`-as-a-record expression both templates open with (`ts` keeps the widening assertion). */
function asArgsRecord(target: EmitTarget): string {
  return target === 'ts' ? '(args as Record<string, unknown>)' : 'args';
}

/**
 * The TYPE-ONLY SDK import line plus its trailing blank line — emitted for `ts`, NOTHING for `js`
 * (the import carries no runtime value, so the JavaScript emission has no import at all).
 */
function typeImport(target: EmitTarget, names: string): string {
  return target === 'ts' ? `import type { ${names} } from '@rayspec/handler-sdk';\n` : '';
}

/**
 * OPTIONAL server-side CLAMP block(s) — the classification analogue of the FK re-check. Each declared
 * enum column is capped at its author bound, RANKED by that column's own `enumValues` order, between
 * the coercion and the write. Nothing here reads a model arg: the order, the bound and its rank are
 * all render-time constants, so the cap is deterministic and indifferent to how the untrusted input is
 * worded. A clamp that FIRES is pushed onto `clamped` and returned on the result — the object
 * `dispatchTool` journals — so the run journal keeps BOTH the model's original choice and the bound
 * written in its place.
 */
function emitClampBlock(holes: PersistHandlerHoles, target: EmitTarget): string {
  const clamps = holes.clampValues;
  if (!clamps || Object.keys(clamps).length === 0) return '';
  const byCol = new Map(holes.columns.map((c) => [c.col, c]));
  const blocks = Object.entries(clamps).map(([col, rule]) => {
    // validateHoles has already proven the column exists, declares enumValues, and contains `max` —
    // so the rank below is always a real index. Enum values reach the emission ONLY through
    // `emitScalar` (never a comment), so a value's content can never break out of a literal.
    const order = (byCol.get(col) as ColumnHole).enumValues as readonly string[];
    return `
    {
      // ${col}: RANK is the position in ORDER (its DECLARED enumValues). Anything ranked above the
      // bound is rewritten DOWN to it, and the model's original choice is kept for the journal.
      const ORDER = [${order.map((v) => emitScalar(v)).join(', ')}];
      const proposed = ${member('coerced.row', col)};
      if (typeof proposed === 'string' && ORDER.indexOf(proposed) > ${order.indexOf(rule.max)}) {
        ${member('coerced.row', col)} = ${emitScalar(rule.max)};
        clamped.push({ column: ${emitScalar(col)}, proposed, applied: ${emitScalar(rule.max)} });
      }
    }`;
  });
  return `
    // Server-side CLAMP: the model PROPOSES, the author's declared bound CAPS. Applied after the
    // coercion and before the write, so no wording of the untrusted input can raise what is persisted
    // past the bound. A clamp that fires is reported on the result (and so journaled).
    const clamped${ann(target, 'ClampRecord[]')} = [];${blocks.join('')}`;
}

/** Render the auto-persist tool handler (Template T1). */
export function renderPersistHandler(
  holes: PersistHandlerHoles,
  target: EmitTarget = 'ts',
): string {
  const fk = holes.fkRevalidate;
  // Server-STAMPED fixed values merged onto the coerced row before the write (author constants — a
  // model can never override them; they overwrite any same-named coerced value). Emitted as a literal
  // so the reviewer sees exactly what is stamped.
  const stampBlock =
    holes.fixedValues && Object.keys(holes.fixedValues).length > 0
      ? `
    // Server-stamped fixed values (author constants — never a model arg; overwrite any coerced value).
    Object.assign(coerced.row, ${emitFixedFilter(holes.fixedValues)});`
      : '';
  const fkBlock = fk
    ? `
    // OPTIONAL server-side FK re-validation: re-check the model-chosen code against the lookup store —
    // NEVER trust the model's choice. The code value is the coerced (DATA) business column.
    {
      const code = ${member('coerced.row', fk.codeArg)};
      const lookupFilter${fk.lookupFixedFilter ? ` = { ...${emitFixedFilter(fk.lookupFixedFilter)}, ${fk.lookupColumn}: code }` : ` = { ${fk.lookupColumn}: code }`};
      const matches = await init.db.select(${emitScalar(fk.lookupStore)}, ${asType(target, 'lookupFilter', 'Record<string, unknown>')});
      if (matches.length === 0) {
        return { status: 'failed', detail: 'the chosen ${fk.codeArg} is not a valid code in ${fk.lookupStore}.' };
      }
    }`
    : '';
  const clampBlock = emitClampBlock(holes, target);
  // A clamp that fired travels back on the result (and thence into the journaled step); a run where
  // none fired returns exactly the shape it always did — the key is absent, never an empty array.
  const clampReturn = clampBlock === '' ? '' : ', ...(clamped.length > 0 ? { clamped } : {})';

  let armBody: string;
  if (holes.mode === 'update-by-id') {
    const idArg = holes.idArg as string;
    armBody = `    // ── ARM A — update-by-id (the existing-row case). The id is a model arg, validated as DATA.
    const idRaw = ${asArgsRecord(target)}[${emitScalar(idArg)}];
    const id = typeof idRaw === 'string' ? idRaw : '';
    if (id.length === 0) return { status: 'failed', detail: '${idArg} missing or not a string.' };${fkBlock}${clampBlock}${stampBlock}
    const updated = await init.db.update(STORE, { id }, coerced.row);
    if (updated.length === 0) return { status: 'failed', detail: 'no ${holes.store} row found for the given id.' };
    return { status: ${emitScalar(holes.successStatus)}, id${clampReturn} };`;
  } else {
    const nk = holes.naturalKeyCol as string;
    armBody = `    // ── ARM B — upsert-by-natural-key (the create case). The natural key is tenant-NAMESPACED
    // server-side (\`\${init.tenantId}:\${value}\`) so it is exactly-once WITHIN the tenant and can NEVER
    // collide cross-tenant. The tenant is SERVER-DERIVED — never a model arg.
    const keyVal = ${member('coerced.row', nk)};
    if (typeof keyVal !== 'string' || keyVal.length === 0) {
      return { status: 'failed', detail: 'natural key ${nk} missing or not a string.' };
    }${fkBlock}${clampBlock}${stampBlock}
    const ref = \`\${init.tenantId}:\${keyVal}\`;
    const rowWithRef${ann(target, 'StoreRow')} = { ...coerced.row, ${nk}: ref };
    const existing = await init.db.select(STORE, { ${nk}: ref });
    if (existing[0]) {
      await init.db.update(STORE, { ${nk}: ref }, rowWithRef);
      return { status: ${emitScalar(holes.successStatus)}, id: typeof existing[0].id === 'string' ? existing[0].id : undefined${clampReturn} };
    }
    // Last-writer-wins (a BOUNDED simplification vs a full re-read / human-edit
    // preservation — that is product-specific business logic, not template-derivable).
    const inserted = await init.db.insert(STORE, rowWithRef);
    return { status: ${emitScalar(holes.successStatus)}, id: typeof inserted.id === 'string' ? inserted.id : undefined${clampReturn} };`;
  }

  // The CLAMP RECORD contract — emitted ONLY for a clamp-bearing hole-set, so a hole-set that declares
  // no clamp renders byte-for-byte what it always did. A tool's `outputSchema` must declare `clamped`
  // alongside status/id/detail, or dispatchTool rejects the result the first time a bound fires.
  const clampShape =
    clampBlock === ''
      ? ''
      : target === 'ts'
        ? `interface ClampRecord {
  /** The bounded column. */
  column: string;
  /** The value the MODEL chose, before the bound was applied. */
  proposed: string;
  /** The author-declared bound written in its place. */
  applied: string;
}

`
        : `/**
 * @typedef {object} ClampRecord
 * @property {string} column The bounded column.
 * @property {string} proposed The value the MODEL chose, before the bound was applied.
 * @property {string} applied The author-declared bound written in its place.
 */

`;
  const clampResultField =
    clampBlock === ''
      ? ''
      : target === 'ts'
        ? `
  /** The bounds that FIRED on this write (present only when at least one did). */
  clamped?: ClampRecord[];`
        : `
 * @property {ClampRecord[]} [clamped] The bounds that FIRED on this write (present only when at least one did).`;

  // The RESULT SHAPE: a declared interface for `ts`, the same contract as a JSDoc typedef for `js`
  // (documentation either way — it carries no runtime weight, exactly like the annotations it replaces).
  const resultShape =
    target === 'ts'
      ? `${clampShape}interface PersistResult {
  /** The success status (${emitScalar(holes.successStatus)}) or 'failed'. */
  status: string;
  /** The affected row id, when known. */
  id?: string;
  /** A human-readable detail on failure. */
  detail?: string;${clampResultField}
}`
      : `${clampShape}/**
 * @typedef {object} PersistResult
 * @property {string} status The success status (${emitScalar(holes.successStatus)}) or 'failed'.
 * @property {string} [id] The affected row id, when known.
 * @property {string} [detail] A human-readable detail on failure.${clampResultField}
 */`;
  const signature =
    target === 'ts'
      ? `export const ${holes.exportName}: ToolHandler<Record<string, unknown>, PersistResult> = async (
  args: Record<string, unknown>,
  init: ToolHandlerInit,
): Promise<PersistResult> => {`
      : `export const ${holes.exportName} = async (args, init) => {`;

  return `${HEADER('persist', target)}
${typeImport(target, 'StoreRow, ToolHandler, ToolHandlerInit')}
const STORE = ${emitScalar(holes.store)}; // a DECLARED store; init.db fail-closes on any other name.

${emitCoerceRow(holes, target)}

${resultShape}

${signature}
  const coerced = coerceRow(args);
  if (!coerced.ok) return { status: 'failed', detail: coerced.detail };
  try {
${armBody}
  } catch (err) {
    const detail = err instanceof Error ? \`\${err.name}: \${err.message}\` : 'persist failed.';
    return { status: 'failed', detail };
  }
};
`;
}

/** Render the store-lookup tool handler (Template T2). */
export function renderLookupHandler(holes: LookupHandlerHoles, target: EmitTarget = 'ts'): string {
  const cols = (list: readonly string[]): string =>
    asType(target, `[${list.map((c) => emitScalar(c)).join(', ')}]`, 'const');
  const filterColsLit = cols(holes.filterCols);
  const projectColsLit = cols(holes.projectCols);
  const baseFilterLit = holes.fixedFilter ? emitFixedFilter(holes.fixedFilter) : '{}';
  const substringBlock =
    holes.substringArg && holes.substringCol
      ? `
  // OPTIONAL in-memory case-insensitive substring filter on the model's \`${holes.substringArg}\` arg
  // (applied AFTER the tenant-scoped DB equality filter; the facade is equality-only by design).
  let candidates = rows;
  {
    const q = ${member('o', holes.substringArg)};
    if (typeof q === 'string' && q.length > 0) {
      const needle = q.toLowerCase();
      candidates = rows.filter((r) => {
        const field = ${member('r', holes.substringCol)};
        return typeof field === 'string' && field.toLowerCase().includes(needle);
      });
    }
  }`
      : `
  const candidates = rows;`;

  // The RESULT SHAPE: a declared interface for `ts`, the same contract as a JSDoc typedef for `js`.
  const resultShape =
    target === 'ts'
      ? `interface LookupResult {
  /** The projected, capped rows (each restricted to PROJECT_COLS). */
  rows: StoreRow[];
  /** The number of rows returned (after the cap). */
  count: number;
}`
      : `/**
 * @typedef {object} LookupResult
 * @property {object[]} rows The projected, capped rows (each restricted to PROJECT_COLS).
 * @property {number} count The number of rows returned (after the cap).
 */`;
  const signature =
    target === 'ts'
      ? `export const ${holes.exportName}: ToolHandler<Record<string, unknown>, LookupResult> = async (
  args: Record<string, unknown>,
  init: ToolHandlerInit,
): Promise<LookupResult> => {`
      : `export const ${holes.exportName} = async (args, init) => {`;

  return `${HEADER('lookup', target)}
${typeImport(target, 'StoreFilter, StoreRow, ToolHandler, ToolHandlerInit')}
const STORE = ${emitScalar(holes.store)};
const FILTER_COLS = ${filterColsLit}; // CLOSED allowlist — ONLY these args may build the equality filter.
const PROJECT_COLS = ${projectColsLit}; // the columns projected into each returned row (drop the rest).
const BASE_FILTER${ann(target, 'StoreFilter')} = ${baseFilterLit}; // the OPTIONAL fixed predicate.
const MAX_ROWS = ${holes.maxRows}; // hard cap on rows returned to the model (bounds the context).

${resultShape}

/** Project a row to the declared PROJECT_COLS only (drop everything else — incl. injected columns). */
function project(row${ann(target, 'StoreRow')})${ann(target, 'StoreRow')} {
  const out${ann(target, 'StoreRow')} = {};
  for (const col of PROJECT_COLS) {
    if (col in row) out[col] = row[col];
  }
  return out;
}

${signature}
  const o = typeof args === 'object' && args !== null ? ${asArgsRecord(target)} : {};
  // Build the filter from the FIXED predicate + ONLY allowlisted arg keys (a non-allowlisted key can
  // never craft a filter over an unintended/injected column). Values are DATA (scalars only).
  const filter${ann(target, 'StoreFilter')} = { ...BASE_FILTER };
  for (const col of FILTER_COLS) {
    const v = o[col];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') filter[col] = v;
  }
  const rows = await init.db.select(STORE, filter); // tenant predicate auto-injected by the facade.
${substringBlock}
  const capped = candidates.slice(0, MAX_ROWS).map(project);
  return { rows: capped, count: capped.length };
};
`;
}

/** Render one handler from its (already-validated) holes, for the given emit target. */
export function renderHandler(holes: HandlerHoles, target: EmitTarget = 'ts'): string {
  return holes.template === 'persist'
    ? renderPersistHandler(holes, target)
    : renderLookupHandler(holes, target);
}

/** Validate then render — the single entrypoint the CLI subcommand + the goldens call. */
export function genHandler(holes: unknown, target: EmitTarget = 'ts'): string {
  validateHoles(holes);
  return renderHandler(holes, target);
}
