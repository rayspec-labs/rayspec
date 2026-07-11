/**
 * Product-YAML VIEW lint — the static, fail-closed validation of view declarations.
 *
 * Called by `lintProductSpec` (product-lint.ts) AND re-run by `@rayspec/views-runtime` at MOUNT time
 * (one source of truth — the runtime never re-implements these rules, so parse-time and mount-time
 * validation cannot drift; the runtime only ADDS mount-only checks such as store existence against
 * the injected read surface and column existence against the declared store columns).
 *
 * THE TWO SEPARATE VALIDATIONS (CL-BRIDGE-MINOR-1 resolved):
 *  1. SOURCE resolution (backing data) — KIND-AWARE:
 *     - `store`          → a Tier-A/B store NAME (safe identifier). NEVER resolved against contracts;
 *                          a contract-id-shaped ref (or the view's own response contract) is rejected.
 *     - `artifact_query` → a DECLARED artifact KIND or COLLECTION (`artifacts[]`). A ref that merely
 *                          names a contract is rejected with an explaining error.
 *     - `capability`     → a contract DECLARED ON a capability (`capabilities[].contracts[]`). A
 *                          top-level product contract does not satisfy it.
 *  2. RESPONSE-CONTRACT conformance (DTO shape) — the projected `read.shape` (and `read.absent`)
 *     must FIT the named contract: every projected field must be a declared contract property (when
 *     the contract closes its properties), every `required` property must be projected, and leaf
 *     types/defaults must be admitted by the property's declared types.
 *
 * Everything else is the CONTEXT-RULE table (the mode-dependent field vocabulary), param coverage,
 * pagination laws, absent-state laws, and the reserved-name (`__proto__`-class) denylist. EVERY
 * violation is an `invalid_view` (or `dangling_ref` where a plain cross-reference dangles) — never a
 * silent skip (the FAIL-OPEN lesson: reject loudly, never silently skip).
 */
import { type SpecError, specError } from './errors.js';
import { SafeIdentifier } from './grammar.js';
import type {
  ArtifactSpec,
  CapabilitySpec,
  ContractsSpec,
  ProductViewSpec,
} from './product-grammar.js';
import {
  VIEW_RESERVED_NAMES,
  type ViewAbsentShape,
  type ViewConstValue,
  type ViewField,
  type ViewFilterArg,
  type ViewItemShape,
  type ViewLeafType,
  type ViewMatchArg,
  type ViewObjectShape,
  type ViewSubRead,
} from './product-views.js';

/** The narrow structural slice of a ProductSpec the view lint needs (mount re-uses it). */
export interface ViewLintInput {
  views: readonly ProductViewSpec[];
  contracts: ContractsSpec;
  artifacts: readonly ArtifactSpec[];
  capabilities: readonly CapabilitySpec[];
}

/** Extract `{param}` names from a declared route path. */
export function viewPathParams(path: string): string[] {
  const out: string[] = [];
  const re = /\{([^}/]+)\}/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard global-regex exec loop.
  while ((m = re.exec(path)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/** The shape contexts a field can appear in (each with its own allowed-kind set). */
type ShapeContext = 'list_envelope' | 'single_row' | 'collect_top' | 'row';

/** The CLOSED allowed-kind table per context (an out-of-context kind is rejected, never skipped). */
const ALLOWED_KINDS: Record<ShapeContext, ReadonlySet<ViewField['kind']>> = {
  // list mode top level: the pagination ENVELOPE (no row context exists here).
  list_envelope: new Set(['page_items', 'page_total', 'page_next_offset', 'param', 'const']),
  // single mode top level: THE row's projection.
  single_row: new Set(['column', 'json', 'param', 'const', 'items', 'list', 'lookup', 'counts']),
  // collect mode top level: aggregation over ALL collected rows (no single-row context).
  collect_top: new Set(['param', 'const', 'group', 'counts']),
  // any NESTED row shape (a page item, a list child row, a group row projection).
  row: new Set(['column', 'json', 'param', 'const', 'items', 'list', 'lookup', 'counts']),
};

// ---------------------------------------------------------------------------------------
// contract-conformance helpers (the closed contract vocabulary → admitted-type sets)
// ---------------------------------------------------------------------------------------

/** A contract schema node (already vetted by product-lint's closed-vocabulary pass). */
type ContractNode = Record<string, unknown>;

/**
 * Resolve a contract node's ADMITTED TYPE SET (e.g. `{integer, null}`), following top-level `ref`s
 * with a cycle guard. `undefined` = OPEN (the node declares no type — anything conforms).
 */
function admittedTypes(
  node: ContractNode | undefined,
  contracts: ContractsSpec,
  seen: Set<string>,
): Set<string> | undefined {
  if (!node) return undefined;
  const out = new Set<string>();
  const t = node.type;
  if (typeof t === 'string') out.add(t);
  else if (Array.isArray(t)) for (const one of t) if (typeof one === 'string') out.add(one);
  if (node.nullable === true) out.add('null');
  if (typeof node.ref === 'string' && !seen.has(node.ref)) {
    seen.add(node.ref);
    const target = contracts[node.ref] as ContractNode | undefined;
    const refTypes = admittedTypes(target, contracts, seen);
    if (refTypes) for (const one of refTypes) out.add(one);
    else if (out.size === 0) return undefined; // an unresolvable/typeless ref keeps the node OPEN
  }
  return out.size > 0 ? out : undefined;
}

/** Does the admitted-type set accept a projected LEAF of declared type `t`? (integer ⊆ number.) */
function typesAdmit(admitted: Set<string> | undefined, t: ViewLeafType | 'null'): boolean {
  if (!admitted) return true; // open node — anything conforms
  if (admitted.has(t)) return true;
  if (t === 'integer' && admitted.has('number')) return true;
  return false;
}

/** The contract-type name of a literal default/const value. */
function constTypeNames(value: ViewConstValue): Array<ViewLeafType | 'null'> {
  if (value === null) return ['null'];
  if (Array.isArray(value)) return ['array'];
  if (typeof value === 'object') return ['object'];
  if (typeof value === 'boolean') return ['boolean'];
  if (typeof value === 'string') return ['string'];
  // a number: an integer literal satisfies BOTH integer and number properties
  return Number.isInteger(value) ? ['integer', 'number'] : ['number'];
}

/**
 * Resolve a node's `properties` map, following a `ref` to a top-level contract (cycle-guarded).
 *
 * OPEN vs CLOSED (SEP-2): a node is OPEN (anything conforms) only when it declares NEITHER
 * `properties` NOR `additional_properties: false`. A `{type: object, additional_properties: false}`
 * node with NO properties is CLOSED-EMPTY — it declares "no keys at all", so EVERY projected field
 * is rejected (previously such a node was mis-read as open, making conformance a no-op on it).
 */
function nodeProperties(
  node: ContractNode | undefined,
  contracts: ContractsSpec,
  seen: Set<string>,
): { properties?: Record<string, ContractNode>; required: string[]; open: boolean } {
  if (!node) return { required: [], open: true };
  // SEP-2: an explicit additional_properties:false CLOSES the node even with no declared properties.
  const declaresClosed = node.additional_properties === false;
  if (typeof node.ref === 'string') {
    const target = contracts[node.ref] as ContractNode | undefined;
    if (target && !seen.has(node.ref)) {
      seen.add(node.ref);
      const inner = nodeProperties(target, contracts, seen);
      // The referring node may ALSO declare properties/required — merge (outer wins per key).
      const props = { ...(inner.properties ?? {}), ...(asProps(node.properties) ?? {}) };
      const required = [...inner.required, ...asRequired(node.required)];
      return {
        ...(Object.keys(props).length > 0 ? { properties: props } : {}),
        required,
        open: inner.open && node.properties === undefined && !declaresClosed,
      };
    }
    // A capability-contract ref (no top-level body) → OPEN unless this node itself closes.
    return {
      ...(asProps(node.properties) ? { properties: asProps(node.properties) } : {}),
      required: asRequired(node.required),
      open: node.properties === undefined && !declaresClosed,
    };
  }
  const props = asProps(node.properties);
  return {
    ...(props ? { properties: props } : {}),
    required: asRequired(node.required),
    open: props === undefined && !declaresClosed,
  };
}

function asProps(v: unknown): Record<string, ContractNode> | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  return v as Record<string, ContractNode>;
}
function asRequired(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((r): r is string => typeof r === 'string') : [];
}

// ---------------------------------------------------------------------------------------
// the lint pass
// ---------------------------------------------------------------------------------------

/** Validate every view declaration. Returns the FULL violation list (never the first). */
export function lintProductViews(input: ViewLintInput): SpecError[] {
  const errors: SpecError[] = [];
  const contractIds = new Set(Object.keys(input.contracts));
  const artifactKinds = new Set(input.artifacts.map((a) => a.kind));
  const artifactCollections = new Set(
    input.artifacts.map((a) => a.collection).filter((c): c is string => typeof c === 'string'),
  );
  const capabilityContractRefs = new Set<string>();
  for (const cap of input.capabilities)
    for (const c of cap.contracts) capabilityContractRefs.add(c);

  const invalid = (message: string, path: string): void => {
    errors.push(specError('invalid_view', message, path));
  };

  input.views.forEach((view, vi) => {
    const base = `views[${vi}]`;
    const params = view.params ?? {};
    const paramNames = new Set(Object.keys(params));

    // ---- reserved names in the params map -------------------------------------------------
    for (const name of Object.keys(params)) {
      if (VIEW_RESERVED_NAMES.has(name)) {
        invalid(
          `view '${view.id}' declares reserved param name '${name}' (prototype-pollution guard)`,
          `${base}.params.${name}`,
        );
      }
    }

    // ---- source: KIND-AWARE resolution (CL-BRIDGE-MINOR-1) --------------------------------
    if (view.source) {
      const ref = view.source.ref;
      const srcPath = `${base}.source.ref`;
      switch (view.source.kind) {
        case 'store': {
          if (ref === view.response_contract) {
            invalid(
              `view '${view.id}' store source ref '${ref}' names the view's own response contract — ` +
                'a source declares BACKING DATA (a store name), not the DTO shape (CL-BRIDGE-MINOR-1)',
              srcPath,
            );
          } else if (!SafeIdentifier.safeParse(ref).success) {
            invalid(
              `view '${view.id}' store source ref '${ref}' is not a store name (a safe identifier); ` +
                'a store source is NEVER a contract id — declare the backing store, not the DTO contract',
              srcPath,
            );
          }
          break;
        }
        case 'artifact_query': {
          if (!artifactKinds.has(ref) && !artifactCollections.has(ref)) {
            const conflated = contractIds.has(ref) || ref === view.response_contract;
            if (view.read) {
              // An INTERPRETED view is strictly kind-aware: its source names the backing artifacts.
              invalid(
                `view '${view.id}' artifact_query source ref '${ref}' does not resolve to a declared ` +
                  `artifact kind or collection${
                    conflated
                      ? ' — it names a CONTRACT; a source declares BACKING DATA (what the view reads), not the DTO shape it returns (CL-BRIDGE-MINOR-1)'
                      : ''
                  }`,
                srcPath,
              );
            } else if (contractIds.has(ref)) {
              // LEGACY carve-out (documented judgment call, TIGHTENED): a
              // DECLARATION-ONLY view (no `read`) may still ref a TOP-LEVEL CONTRACT ID — EXACTLY
              // the class a frozen legacy donor fixture declares (byte-synced to the committed
              // fixture: its read-less artifact_query views ref top-level response contracts,
              // never capability contracts). Frozen artifacts are not rewritten. Such a view is
              // INERT: it can never mount (@rayspec/views-runtime requires `read`, where the
              // separation is STRICT), so the conflation cannot reach the runtime. NOTHING ELSE
              // passes silently.
            } else if (capabilityContractRefs.has(ref)) {
              // OUTSIDE the carve-out: a capability-contract ref on an artifact_query source has no
              // legacy precedent (the donor never declares it) and no execution path — the view is
              // dead-on-arrival. Rejected loudly, never silently accepted.
              invalid(
                `view '${view.id}' artifact_query source ref '${ref}' names a CAPABILITY contract — ` +
                  'outside the legacy carve-out (which admits top-level contract ids only, the ' +
                  'frozen legacy donor class); this view is dead-on-arrival: declare an artifact ' +
                  'kind/collection, or use a capability source for a delegated view',
                srcPath,
              );
            } else {
              errors.push(
                specError(
                  'dangling_ref',
                  `unresolved view source reference '${ref}' at ${srcPath}; declare it as an artifact ` +
                    'kind/collection (preferred) or a top-level contract (legacy, declaration-only)',
                  srcPath,
                ),
              );
            }
          }
          break;
        }
        case 'capability': {
          if (!capabilityContractRefs.has(ref)) {
            invalid(
              `view '${view.id}' capability source ref '${ref}' does not resolve to a contract ` +
                'declared on a capability (capabilities[].contracts[]); a top-level product contract ' +
                'does not satisfy a capability source',
              srcPath,
            );
          }
          break;
        }
      }
    }

    // ---- response_contract resolution ------------------------------------------------------
    const rcPath = `${base}.response_contract`;
    if (view.read) {
      // An INTERPRETED view's DTO contract must be a TOP-LEVEL product contract (conformance below
      // needs its body); a capability contract has no in-document schema to conform against.
      if (!contractIds.has(view.response_contract)) {
        invalid(
          `view '${view.id}' response_contract '${view.response_contract}' must be a top-level ` +
            'product contract (contracts[]) for an interpreted view (its shape is conformance-checked)',
          rcPath,
        );
      }
    } else if (
      !contractIds.has(view.response_contract) &&
      !capabilityContractRefs.has(view.response_contract)
    ) {
      errors.push(
        specError(
          'dangling_ref',
          `unresolved contract/capability reference '${view.response_contract}' at ${rcPath}; declare ` +
            'it in contracts[] or reference a declared capability contract',
          rcPath,
        ),
      );
    }

    // ---- conditional_read: GET only ---------------------------------------------------------
    if (view.conditional_read && view.route.method !== 'GET') {
      invalid(
        `view '${view.id}' declares conditional_read '${view.conditional_read}' on a ` +
          `${view.route.method} route — conditional reads apply to GET views only`,
        `${base}.conditional_read`,
      );
    }

    // ---- params ↔ path coverage -------------------------------------------------------------
    const pathParams = viewPathParams(view.route.path);
    for (const [name, p] of Object.entries(params)) {
      if (p.in === 'path') {
        if (!pathParams.includes(name)) {
          invalid(
            `view '${view.id}' declares path param '${name}' which does not appear in route path ` +
              `'${view.route.path}'`,
            `${base}.params.${name}`,
          );
        }
        if (p.required === false) {
          invalid(
            `view '${view.id}' path param '${name}' cannot be optional (a path segment is always present)`,
            `${base}.params.${name}.required`,
          );
        }
      }
      // A param must not collide with the pagination params (single owner: the pagination engine).
      if (
        view.pagination &&
        (name === view.pagination.limit_param || name === view.pagination.offset_param)
      ) {
        invalid(
          `view '${view.id}' param '${name}' collides with a pagination param — pagination params ` +
            'are owned by the pagination declaration, not params',
          `${base}.params.${name}`,
        );
      }
    }

    // ---- the read declaration ----------------------------------------------------------------
    const read = view.read;
    if (!read) {
      // Declaration-only view (legacy-compatible). Pagination/absent_state stay as declared.
      return;
    }
    const readPath = `${base}.read`;

    // An interpreted view must declare WHAT it reads — and a capability source is DELEGATED to the
    // capability's own mount surface, never interpreted (its handler is capability code, not data).
    if (!view.source) {
      invalid(`view '${view.id}' declares read but no source (what does it read?)`, readPath);
    } else if (view.source.kind === 'capability') {
      invalid(
        `view '${view.id}' declares read on a capability source — capability views are delegated to ` +
          'the capability mount (their behavior is capability code), never interpreted from YAML',
        readPath,
      );
    }

    // Every {param} in the route path must be a declared path param (full coverage — an undeclared
    // path param would reach the read unvalidated).
    for (const name of pathParams) {
      if (!paramNames.has(name)) {
        invalid(
          `view '${view.id}' route path param '{${name}}' is not declared in params (an interpreted ` +
            'view validates EVERY input; declare it with a shape preset)',
          `${base}.route.path`,
        );
      }
    }

    // ---- pagination laws ---------------------------------------------------------------------
    if (read.mode === 'list') {
      const pg = view.pagination;
      if (!pg?.limit_param || !pg.offset_param || pg.max_limit === undefined) {
        invalid(
          `view '${view.id}' is a list view and must declare bounded pagination ` +
            '(limit_param + offset_param + max_limit) — an unbounded list response is fail-open',
          `${base}.pagination`,
        );
      } else if (pg.default_limit !== undefined && pg.default_limit > pg.max_limit) {
        invalid(
          `view '${view.id}' pagination default_limit ${pg.default_limit} exceeds max_limit ${pg.max_limit}`,
          `${base}.pagination.default_limit`,
        );
      }
    } else if (view.pagination) {
      invalid(
        `view '${view.id}' declares pagination on a '${read.mode}' read — pagination applies to list views only`,
        `${base}.pagination`,
      );
    }

    // ---- absent-state laws -------------------------------------------------------------------
    if (read.mode === 'single') {
      if (view.absent_state === undefined) {
        invalid(
          `view '${view.id}' is a single-row view and must declare absent_state ` +
            "('empty_200' with read.absent, or 'not_ready_409')",
          `${base}.absent_state`,
        );
      } else if (view.absent_state === 'empty_200' && !read.absent) {
        invalid(
          `view '${view.id}' declares absent_state 'empty_200' but no read.absent shape — the ` +
            'absent-row 200 DTO must be DECLARED, never improvised',
          `${readPath}.absent`,
        );
      } else if (view.absent_state === 'not_ready_409' && read.absent) {
        invalid(
          `view '${view.id}' declares BOTH absent_state 'not_ready_409' and a read.absent shape — ` +
            'a 409 has a fixed error body; declare exactly one absent behavior',
          `${readPath}.absent`,
        );
      }
    } else {
      if (view.absent_state === 'not_ready_409') {
        invalid(
          `view '${view.id}' declares absent_state 'not_ready_409' on a '${read.mode}' read — ` +
            'readiness gating applies to single-row views only (a list/collect read is empty, not un-ready)',
          `${base}.absent_state`,
        );
      }
      if (read.absent) {
        invalid(
          `view '${view.id}' declares read.absent on a '${read.mode}' read — an absent shape applies ` +
            'to single-row views only',
          `${readPath}.absent`,
        );
      }
    }

    // ---- filter / order_by / exclude param refs + reserved names ------------------------------
    const checkParamRef = (param: string, path: string): void => {
      if (!paramNames.has(param)) {
        invalid(
          `view '${view.id}' references undeclared param '${param}' (declare it in params)`,
          path,
        );
      }
    };
    for (const [col, arg] of Object.entries(read.filter ?? {})) {
      if (VIEW_RESERVED_NAMES.has(col)) {
        invalid(
          `view '${view.id}' filter uses reserved column name '${col}'`,
          `${readPath}.filter.${col}`,
        );
      }
      checkFilterArg(arg, `${readPath}.filter.${col}`, checkParamRef);
      // A view-level filter param must be REQUIRED (a path param, or required:true) — an absent
      // optional param would make the read's meaning ambiguous (unfiltered vs empty); fail-closed
      // at declaration time instead of picking a runtime interpretation.
      if ('param' in arg) {
        const p = params[arg.param];
        if (p && p.in !== 'path' && p.required !== true) {
          invalid(
            `view '${view.id}' read.filter.${col} references OPTIONAL param '${arg.param}' — a ` +
              'filter param must be required (a path param or required:true), so the read is never ambiguous',
            `${readPath}.filter.${col}`,
          );
        }
      }
    }

    // ---- the shape context walk ----------------------------------------------------------------
    const topContext: ShapeContext =
      read.mode === 'list'
        ? 'list_envelope'
        : read.mode === 'single'
          ? 'single_row'
          : 'collect_top';
    const pageItemsCount = walkShape(read.shape, topContext, `${readPath}.shape`, {
      viewId: view.id,
      invalid,
      checkParamRef,
      collectTop: read.mode === 'collect',
    });
    if (read.mode === 'list' && pageItemsCount !== 1) {
      invalid(
        `view '${view.id}' list envelope must contain exactly one page_items field (found ${pageItemsCount})`,
        `${readPath}.shape`,
      );
    }

    // absent shape (param/const only — zod-enforced): reserved names + param resolution.
    if (read.absent) {
      for (const [name, field] of Object.entries(read.absent.fields)) {
        if (VIEW_RESERVED_NAMES.has(name)) {
          invalid(
            `view '${view.id}' absent shape uses reserved field name '${name}'`,
            `${readPath}.absent.fields.${name}`,
          );
        }
        if (field.kind === 'param') checkParamRef(field.param, `${readPath}.absent.fields.${name}`);
      }
    }

    // ---- response-contract CONFORMANCE (the DTO half of CL-BRIDGE-MINOR-1) ---------------------
    const contract = input.contracts[view.response_contract] as ContractNode | undefined;
    if (contract) {
      conformShape(read.shape, contract, `${readPath}.shape`, {
        viewId: view.id,
        contracts: input.contracts,
        invalid,
      });
      if (read.absent) {
        conformAbsent(read.absent, contract, `${readPath}.absent`, {
          viewId: view.id,
          contracts: input.contracts,
          invalid,
        });
      }
    }
  });

  return errors;
}

// ---------------------------------------------------------------------------------------
// shape context walk
// ---------------------------------------------------------------------------------------

interface WalkCtx {
  viewId: string;
  invalid: (message: string, path: string) => void;
  checkParamRef: (param: string, path: string) => void;
  /** True when the view's read mode is collect (self-counts / groups are only legal at its top). */
  collectTop: boolean;
}

/** Validate a sub-read's match refs + reserved names. */
function checkSubRead(sub: ViewSubRead, path: string, ctx: WalkCtx): void {
  const entries = Object.entries(sub.match);
  if (entries.length === 0) {
    ctx.invalid(
      `view '${ctx.viewId}' sub-read on store '${sub.store}' declares an EMPTY match — a sub-read ` +
        'must be keyed (an unmatched sub-read would read the whole tenant table per parent row)',
      `${path}.match`,
    );
  }
  for (const [col, arg] of entries) {
    if (VIEW_RESERVED_NAMES.has(col)) {
      ctx.invalid(
        `view '${ctx.viewId}' match uses reserved column name '${col}'`,
        `${path}.match.${col}`,
      );
    }
    checkMatchArg(arg, `${path}.match.${col}`, ctx.checkParamRef);
  }
}

function checkFilterArg(
  arg: ViewFilterArg,
  path: string,
  checkParamRef: (param: string, path: string) => void,
): void {
  if ('param' in arg) checkParamRef(arg.param, path);
}
function checkMatchArg(
  arg: ViewMatchArg,
  path: string,
  checkParamRef: (param: string, path: string) => void,
): void {
  if ('param' in arg) checkParamRef(arg.param, path);
}

/** Walk one object shape in a context; returns the count of page_items fields seen at THIS level. */
function walkShape(
  shape: ViewObjectShape,
  context: ShapeContext,
  path: string,
  ctx: WalkCtx,
): number {
  let pageItems = 0;
  const allowed = ALLOWED_KINDS[context];
  for (const [name, field] of Object.entries(shape.fields)) {
    const fpath = `${path}.fields.${name}`;
    if (VIEW_RESERVED_NAMES.has(name)) {
      ctx.invalid(`view '${ctx.viewId}' shape uses reserved field name '${name}'`, fpath);
    }
    if (!allowed.has(field.kind)) {
      ctx.invalid(
        `view '${ctx.viewId}' field '${name}' of kind '${field.kind}' is not allowed in this ` +
          `context ('${context}') — the mode-dependent field vocabulary is closed`,
        fpath,
      );
      continue; // the kind is out of context; deeper checks would mislead
    }
    switch (field.kind) {
      case 'param':
        ctx.checkParamRef(field.param, fpath);
        break;
      case 'items':
        checkItemShape(field.shape, `${fpath}.shape`, ctx);
        break;
      case 'list':
        checkSubRead(field.source, `${fpath}.source`, ctx);
        walkShape(field.shape, 'row', `${fpath}.shape`, ctx);
        break;
      case 'lookup':
        checkSubRead(field.source, `${fpath}.source`, ctx);
        break;
      case 'counts':
        if (field.of) {
          checkSubRead(field.of, `${fpath}.of`, ctx);
        } else if (context !== 'collect_top') {
          ctx.invalid(
            `view '${ctx.viewId}' counts field '${name}' has no 'of' sub-read — self-counts (over ` +
              "the view's own collected rows) are only legal at the top level of a collect view",
            fpath,
          );
        }
        for (const bucket of field.buckets) {
          if (VIEW_RESERVED_NAMES.has(bucket)) {
            ctx.invalid(`view '${ctx.viewId}' counts bucket '${bucket}' is a reserved name`, fpath);
          }
          // FCY-3: the tally emits the grand total under the hardcoded `total` key — a bucket of the
          // same name would silently double-count into it. Reserved at declaration time, fail-closed.
          if (bucket === 'total') {
            ctx.invalid(
              `view '${ctx.viewId}' counts bucket 'total' is reserved — the tally emits the grand ` +
                "total under 'total', so a bucket of that name would double-count into it",
              fpath,
            );
          }
        }
        break;
      case 'group': {
        const hasValue = field.value !== undefined;
        const hasShape = field.shape !== undefined;
        if (hasValue === hasShape) {
          ctx.invalid(
            `view '${ctx.viewId}' group field '${name}' must declare exactly ONE of value|shape ` +
              `(got ${hasValue ? 'both' : 'neither'})`,
            fpath,
          );
        }
        if (field.mode === 'list' && field.absent !== undefined) {
          ctx.invalid(
            `view '${ctx.viewId}' group field '${name}' declares 'absent' with mode 'list' — a list ` +
              'bucket is empty when nothing matches, never absent',
            fpath,
          );
        }
        if (field.shape) walkShape(field.shape, 'row', `${fpath}.shape`, ctx);
        break;
      }
      case 'page_items':
        pageItems += 1;
        walkShape(field.shape, 'row', `${fpath}.shape`, ctx);
        break;
      default:
        break; // column/json/const/page_total/page_next_offset: no deeper structure to walk
    }
  }
  return pageItems;
}

function checkItemShape(shape: ViewItemShape, path: string, ctx: WalkCtx): void {
  for (const name of Object.keys(shape.fields)) {
    if (VIEW_RESERVED_NAMES.has(name)) {
      ctx.invalid(
        `view '${ctx.viewId}' item shape uses reserved field name '${name}'`,
        `${path}.fields.${name}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------
// contract conformance
// ---------------------------------------------------------------------------------------

interface ConformCtx {
  viewId: string;
  contracts: ContractsSpec;
  invalid: (message: string, path: string) => void;
}

/** The leaf type(s) a shape field PRODUCES (undefined = not a leaf / not statically known). */
function fieldProducedTypes(field: ViewField): Array<ViewLeafType | 'null'> | undefined {
  switch (field.kind) {
    case 'column':
    case 'json':
      return leafTypes(field.type, field.default);
    case 'lookup':
      return leafTypes(field.type, field.default);
    case 'param':
      return ['string'];
    case 'const':
      return constTypeNames(field.value);
    case 'items':
    case 'list':
      return ['array'];
    case 'counts':
      return ['object'];
    case 'group':
      if (field.mode === 'list') return ['array'];
      if (field.value) {
        const base = leafTypes(field.value.type, field.value.default);
        return withAbsent(base, field.absent);
      }
      return withAbsent(['object'], field.absent);
    case 'page_items':
      return ['array'];
    case 'page_total':
      return ['integer', 'number'];
    case 'page_next_offset':
      return ['integer', 'number', 'null'];
    default:
      return undefined;
  }
}

/** A typed leaf produces its declared type OR its default's type (default null when omitted). */
function leafTypes(
  type: ViewLeafType,
  deflt: ViewConstValue | undefined,
): Array<ViewLeafType | 'null'> {
  const defaultTypes = deflt === undefined ? (['null'] as const) : constTypeNames(deflt);
  const out = new Set<ViewLeafType | 'null'>([type, ...defaultTypes]);
  return [...out];
}

function withAbsent(
  base: Array<ViewLeafType | 'null'>,
  absent: ViewConstValue | undefined,
): Array<ViewLeafType | 'null'> {
  const absentTypes = absent === undefined ? (['null'] as const) : constTypeNames(absent);
  return [...new Set([...base, ...absentTypes])];
}

/**
 * Conformance: every PRODUCIBLE type of the field must be admitted by the property's declared types.
 * For an integer/number pair produced by an int literal, ONE admitted member suffices (an integer
 * literal conforms to a `number` property).
 */
function checkProducedTypes(
  produced: Array<ViewLeafType | 'null'>,
  admitted: Set<string> | undefined,
  fieldName: string,
  path: string,
  ctx: ConformCtx,
): void {
  if (!admitted) return;
  // Partition: the null member is checked separately; an integer/number literal-pair counts as one.
  const nonNull = produced.filter((t) => t !== 'null');
  const hasNull = produced.includes('null');
  if (hasNull && !admitted.has('null')) {
    ctx.invalid(
      `view '${ctx.viewId}' field '${fieldName}' can produce null but the response contract property ` +
        'does not admit \'null\' (declare nullable/[…, "null"] or give the field a non-null default)',
      path,
    );
  }
  // An int-literal default reports ['integer','number'] — one admitted member suffices for THAT value.
  if (nonNull.length > 0) {
    const intPair =
      nonNull.length === 2 && nonNull.includes('integer') && nonNull.includes('number');
    const ok = intPair
      ? typesAdmit(admitted, 'integer') || typesAdmit(admitted, 'number')
      : nonNull.every((t) => typesAdmit(admitted, t as ViewLeafType));
    if (!ok) {
      ctx.invalid(
        `view '${ctx.viewId}' field '${fieldName}' produces type(s) [${nonNull.join(', ')}] not ` +
          `admitted by the response contract property (admitted: [${[...admitted].join(', ')}])`,
        path,
      );
    }
  }
}

/** Conform one object shape against one contract node (recursing where both sides declare). */
function conformShape(
  shape: ViewObjectShape,
  node: ContractNode,
  path: string,
  ctx: ConformCtx,
): void {
  const { properties, required, open } = nodeProperties(node, ctx.contracts, new Set());
  const additional = node.additional_properties === true;
  for (const [name, field] of Object.entries(shape.fields)) {
    const fpath = `${path}.fields.${name}`;
    const prop = properties?.[name];
    if (!prop && !open && !additional) {
      ctx.invalid(
        `view '${ctx.viewId}' projects field '${name}' which the response contract does not declare ` +
          '(the DTO contract is the closed client-facing shape — declare the property or drop the field)',
        fpath,
      );
      continue;
    }
    const produced = fieldProducedTypes(field);
    if (produced && prop) {
      checkProducedTypes(produced, admittedTypes(prop, ctx.contracts, new Set()), name, fpath, ctx);
    }
    // Recurse into array-producing composites where the contract declares items with properties.
    if (prop) {
      const propItems =
        prop.items !== null && typeof prop.items === 'object' && !Array.isArray(prop.items)
          ? (prop.items as ContractNode)
          : undefined;
      if (field.kind === 'list' && propItems) {
        conformShape(field.shape, propItems, `${fpath}.shape`, ctx);
      }
      if (field.kind === 'page_items' && propItems) {
        conformShape(field.shape, propItems, `${fpath}.shape`, ctx);
      }
      if (field.kind === 'group' && field.mode === 'list' && field.shape && propItems) {
        conformShape(field.shape, propItems, `${fpath}.shape`, ctx);
      }
      if (field.kind === 'group' && field.mode !== 'list' && field.shape) {
        conformShape(field.shape, prop, `${fpath}.shape`, ctx);
      }
      if (field.kind === 'items' && propItems) {
        conformItemShape(field.shape, propItems, `${fpath}.shape`, ctx);
      }
    }
  }
  for (const r of required) {
    if (!(r in shape.fields)) {
      ctx.invalid(
        `view '${ctx.viewId}' response contract requires property '${r}' but the shape does not ` +
          'project it (every required DTO property must be produced)',
        path,
      );
    }
  }
}

/** Conform an ITEM shape (item/const leaves) against a contract items node. */
function conformItemShape(
  shape: ViewItemShape,
  node: ContractNode,
  path: string,
  ctx: ConformCtx,
): void {
  const { properties, required, open } = nodeProperties(node, ctx.contracts, new Set());
  const additional = node.additional_properties === true;
  for (const [name, field] of Object.entries(shape.fields)) {
    const fpath = `${path}.fields.${name}`;
    const prop = properties?.[name];
    if (!prop && !open && !additional) {
      ctx.invalid(
        `view '${ctx.viewId}' item shape projects field '${name}' which the contract's items node does not declare`,
        fpath,
      );
      continue;
    }
    const produced =
      field.kind === 'item' ? leafTypes(field.type, field.default) : constTypeNames(field.value);
    if (prop) {
      checkProducedTypes(produced, admittedTypes(prop, ctx.contracts, new Set()), name, fpath, ctx);
    }
  }
  for (const r of required) {
    if (!(r in shape.fields)) {
      ctx.invalid(
        `view '${ctx.viewId}' contract items node requires property '${r}' but the item shape does not project it`,
        path,
      );
    }
  }
}

/** Conform the absent shape: required coverage + const/param types vs contract properties. */
function conformAbsent(
  absent: ViewAbsentShape,
  node: ContractNode,
  path: string,
  ctx: ConformCtx,
): void {
  const { properties, required, open } = nodeProperties(node, ctx.contracts, new Set());
  const additional = node.additional_properties === true;
  for (const [name, field] of Object.entries(absent.fields)) {
    const fpath = `${path}.fields.${name}`;
    const prop = properties?.[name];
    if (!prop && !open && !additional) {
      ctx.invalid(
        `view '${ctx.viewId}' absent shape projects field '${name}' which the response contract does not declare`,
        fpath,
      );
      continue;
    }
    const produced = field.kind === 'param' ? (['string'] as const) : constTypeNames(field.value);
    if (prop) {
      checkProducedTypes(
        [...produced],
        admittedTypes(prop, ctx.contracts, new Set()),
        name,
        fpath,
        ctx,
      );
    }
  }
  for (const r of required) {
    if (!(r in absent.fields)) {
      ctx.invalid(
        `view '${ctx.viewId}' response contract requires property '${r}' but the absent shape does ` +
          'not produce it (the absent-row 200 must satisfy the same contract)',
        path,
      );
    }
  }
}
