/**
 * The DETERMINISTIC handler renderers (the bounded-template catalog T1/T2/T3).
 *
 * Pure `holes -> .ts string` functions. The emitted code is byte-stable for fixed holes (golden-gated),
 * imports `@rayspec/handler-sdk` TYPE-ONLY, takes ZERO npm deps, reaches the DB ONLY through the
 * injected tenant-bound `init.db` facade, coerces every model arg as UNTRUSTED DATA (never throws —
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

/** The shared file header every rendered handler carries (the honest trusted-author-NOT-sandboxed note). */
const HEADER = (kind: 'persist' | 'lookup'): string =>
  `// AUTO-GENERATED ${kind === 'persist' ? 'persist-tool' : 'store-lookup'} handler ` +
  `(bounded template ${kind === 'persist' ? 'T1' : 'T2'}). Do NOT edit by hand —
// regenerate via \`rayspec gen-handler\`. TRUSTED-AUTHOR, NOT SANDBOXED: it runs in-process; the two
// CI gates (handler-imports / extension-capability) are TRIPWIRES, not a sandbox — the real per-tenant
// isolate is a later hardening milestone (deferred). Imports @rayspec/handler-sdk TYPE-ONLY; ZERO npm deps; reaches
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
function emitCoerceColumn(c: ColumnHole): string {
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
        return `  // ${col}: text (closed enum) — UNTRUSTED arg, membership-checked.
  {
    const val = ${v};
    if (typeof val === 'string' && (${set} as readonly string[]).includes(val)) {
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
function emitCoerceRow(holes: PersistHandlerHoles): string {
  const blocks = holes.columns.map(emitCoerceColumn).join('\n');
  return `/**
 * Coerce the UNTRUSTED model args into the row to persist (T3 shape-map + per-ColumnType coercion).
 * Drops any non-declared key (additionalProperties:false parity with the tool parameters), never
 * throws (returns a failed result on a required/enum violation), and never writes an injected column.
 */
function coerceRow(args: Record<string, unknown>): { ok: true; row: StoreRow } | { ok: false; status: 'failed'; detail: string } {
  const o = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
  const row: StoreRow = {};
${blocks}
  return { ok: true, row };
}`;
}

/** Render the auto-persist tool handler (Template T1). */
export function renderPersistHandler(holes: PersistHandlerHoles): string {
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
      const matches = await init.db.select(${emitScalar(fk.lookupStore)}, lookupFilter as Record<string, unknown>);
      if (matches.length === 0) {
        return { status: 'failed', detail: 'the chosen ${fk.codeArg} is not a valid code in ${fk.lookupStore}.' };
      }
    }`
    : '';

  let armBody: string;
  if (holes.mode === 'update-by-id') {
    const idArg = holes.idArg as string;
    armBody = `    // ── ARM A — update-by-id (the existing-row case). The id is a model arg, validated as DATA.
    const idRaw = (args as Record<string, unknown>)[${emitScalar(idArg)}];
    const id = typeof idRaw === 'string' ? idRaw : '';
    if (id.length === 0) return { status: 'failed', detail: '${idArg} missing or not a string.' };${fkBlock}${stampBlock}
    const updated = await init.db.update(STORE, { id }, coerced.row);
    if (updated.length === 0) return { status: 'failed', detail: 'no ${holes.store} row found for the given id.' };
    return { status: ${emitScalar(holes.successStatus)}, id };`;
  } else {
    const nk = holes.naturalKeyCol as string;
    armBody = `    // ── ARM B — upsert-by-natural-key (the create case). The natural key is tenant-NAMESPACED
    // server-side (\`\${init.tenantId}:\${value}\`) so it is exactly-once WITHIN the tenant and can NEVER
    // collide cross-tenant. The tenant is SERVER-DERIVED — never a model arg.
    const keyVal = ${member('coerced.row', nk)};
    if (typeof keyVal !== 'string' || keyVal.length === 0) {
      return { status: 'failed', detail: 'natural key ${nk} missing or not a string.' };
    }${fkBlock}${stampBlock}
    const ref = \`\${init.tenantId}:\${keyVal}\`;
    const rowWithRef: StoreRow = { ...coerced.row, ${nk}: ref };
    const existing = await init.db.select(STORE, { ${nk}: ref });
    if (existing[0]) {
      await init.db.update(STORE, { ${nk}: ref }, rowWithRef);
      return { status: ${emitScalar(holes.successStatus)}, id: typeof existing[0].id === 'string' ? existing[0].id : undefined };
    }
    // Last-writer-wins (a BOUNDED simplification vs a full re-read / human-edit
    // preservation — that is product-specific business logic, not template-derivable).
    const inserted = await init.db.insert(STORE, rowWithRef);
    return { status: ${emitScalar(holes.successStatus)}, id: typeof inserted.id === 'string' ? inserted.id : undefined };`;
  }

  return `${HEADER('persist')}
import type { StoreRow, ToolHandler, ToolHandlerInit } from '@rayspec/handler-sdk';

const STORE = ${emitScalar(holes.store)}; // a DECLARED store; init.db fail-closes on any other name.

${emitCoerceRow(holes)}

interface PersistResult {
  /** The success status (${emitScalar(holes.successStatus)}) or 'failed'. */
  status: string;
  /** The affected row id, when known. */
  id?: string;
  /** A human-readable detail on failure. */
  detail?: string;
}

export const ${holes.exportName}: ToolHandler<Record<string, unknown>, PersistResult> = async (
  args: Record<string, unknown>,
  init: ToolHandlerInit,
): Promise<PersistResult> => {
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
export function renderLookupHandler(holes: LookupHandlerHoles): string {
  const filterColsLit = `[${holes.filterCols.map((c) => emitScalar(c)).join(', ')}] as const`;
  const projectColsLit = `[${holes.projectCols.map((c) => emitScalar(c)).join(', ')}] as const`;
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

  return `${HEADER('lookup')}
import type { StoreFilter, StoreRow, ToolHandler, ToolHandlerInit } from '@rayspec/handler-sdk';

const STORE = ${emitScalar(holes.store)};
const FILTER_COLS = ${filterColsLit}; // CLOSED allowlist — ONLY these args may build the equality filter.
const PROJECT_COLS = ${projectColsLit}; // the columns projected into each returned row (drop the rest).
const BASE_FILTER: StoreFilter = ${baseFilterLit}; // the OPTIONAL fixed predicate.
const MAX_ROWS = ${holes.maxRows}; // hard cap on rows returned to the model (bounds the context).

interface LookupResult {
  /** The projected, capped rows (each restricted to PROJECT_COLS). */
  rows: StoreRow[];
  /** The number of rows returned (after the cap). */
  count: number;
}

/** Project a row to the declared PROJECT_COLS only (drop everything else — incl. injected columns). */
function project(row: StoreRow): StoreRow {
  const out: StoreRow = {};
  for (const col of PROJECT_COLS) {
    if (col in row) out[col] = row[col];
  }
  return out;
}

export const ${holes.exportName}: ToolHandler<Record<string, unknown>, LookupResult> = async (
  args: Record<string, unknown>,
  init: ToolHandlerInit,
): Promise<LookupResult> => {
  const o = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
  // Build the filter from the FIXED predicate + ONLY allowlisted arg keys (a non-allowlisted key can
  // never craft a filter over an unintended/injected column). Values are DATA (scalars only).
  const filter: StoreFilter = { ...BASE_FILTER };
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

/** Render one handler from its (already-validated) holes. */
export function renderHandler(holes: HandlerHoles): string {
  return holes.template === 'persist' ? renderPersistHandler(holes) : renderLookupHandler(holes);
}

/** Validate then render — the single entrypoint the CLI subcommand + the goldens call. */
export function genHandler(holes: unknown): string {
  validateHoles(holes);
  return renderHandler(holes);
}
