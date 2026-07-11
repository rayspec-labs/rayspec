#!/usr/bin/env node
/**
 * Adapter-no-handlers CI gate — the trust-boundary chokepoint.
 *
 * The ONLY sanctioned tool path is the central `ctx.dispatchTool` (validate-in -> idempotency ->
 * timeout -> validate-out -> opaque-wrap -> one journaled step). An adapter that holds a tool
 * handler, invokes a handler directly, re-introduces a handler-map option, or constructs a
 * side-effecting SDK tool factory BYPASSES the re-validation + opaque-wrapping (the
 * trust-boundary regression risk). This gate FAILS THE BUILD on any such pattern in a
 * non-test adapter `src` file.
 *
 * This MIRRORS scripts/check-tenant-chokepoint.mjs: a greppable TRIPWIRE (no AST), with source that
 * is COMMENT-stripped AND STRING-LITERAL-stripped before analysis, an explicit reviewed shrinking
 * ALLOWLIST, and a SELF-TEST proving the detector fires on every confirmed bypass vector.
 *
 * The forbid-list tokens (handler maps + side-effecting SDK factories) are UNBYPASSABLE greps. The
 * dispatch-compliance check is a require-a-CALL check (`dispatchTool(`), which alone is bypassable —
 * so it is PAIRED with the forbid-list for the non-dispatch handler entry points (`execute`/`invoke`
 * bodies that don't call the dispatcher). Both `execute:` (the neutral declaration key) AND `invoke:`
 * (the SDK's REAL runtime handler key — FunctionTool.invoke) bodies must route through dispatchTool.
 *
 * SCOPE: every adapter is dispatch-only — the allowlist is EMPTY. The gate enforces the tool
 * chokepoint across every adapter: anthropic routes tools through an in-proc MCP `tool()` handler
 * that calls ctx.dispatchTool; pi routes through a `defineTool({execute})` host-tool that calls
 * ctx.dispatchTool. Neither holds a handler.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const ADAPTER_ROOTS = [
  'packages/adapters/openai/src',
  'packages/adapters/anthropic/src',
  'packages/adapters/pi/src',
  // The Codex adapter routes its in-proc MCP tool path through ctx.dispatchTool — it MUST be
  // scanned, else the chokepoint gate is BLIND to it (a real hole). Its tools use the MCP-SDK
  // `registerTool(name, config, handler)` POSITIONAL-handler form (matched by TOOL_BUILDER_CALL_RE).
  'packages/adapters/codex/src',
];

// EMPTY: every adapter routes every tool path through ctx.dispatchTool, so the gate enforces the
// chokepoint across ALL of them with no exceptions.
const INLINE_TOOLPATH_ALLOWLIST = [];

// Exclude test code + test-support helpers + throwaway capture scripts (not shipped adapter code).
function isExcluded(relPath) {
  return (
    relPath.includes('/test-support/') ||
    relPath.includes('/__fixtures__/') ||
    relPath.includes('/scripts/') ||
    relPath.endsWith('.test.ts') ||
    relPath.endsWith('.test.tsx')
  );
}

function isAllowlisted(relPath) {
  return INLINE_TOOLPATH_ALLOWLIST.some((prefix) => relPath.startsWith(prefix));
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

// ---- forbidden tokens (UNBYPASSABLE greps) --------------------------------------------------

/**
 * Handler-MAP identifiers used as a tool registry. Broadened beyond
 * the exact `toolHandlers` token to also catch `tool_handlers`, `toolFns`, and a bare `handlers`
 * map. A tool registry that maps names -> handler functions lets the adapter call a handler
 * directly, bypassing the dispatcher.
 */
const HANDLER_MAP_RES = [/\btoolHandlers\b/, /\btool_handlers\b/, /\btoolFns\b/, /\bhandlers\b/];

/**
 * Side-effecting SDK tool FACTORIES — these construct tools whose effects run OUTSIDE the
 * dispatcher (shell exec, computer use, patch application, hosted MCP), so they can never honor the
 * dispatch chokepoint. Forbidden in adapter src entirely.
 */
const SDK_SIDE_EFFECT_FACTORY_RE = /\b(shellTool|computerTool|applyPatchTool|hostedMcpTool)\s*\(/;

// An execute/invoke body is COMPLIANT iff it routes through the central dispatcher AS A CALL ON THE
// `ctx` RECEIVER. Hardened (review B4): require the `ctx.dispatchTool(` receiver form, NOT any
// `dispatchTool(` — a LOCAL SHADOW `const dispatchTool = (...) => runInline(...)` would otherwise
// satisfy a bare `dispatchTool(` while never reaching the dispatch chokepoint. All real call sites use
// the receiver form (anthropic:~440, pi:~190, openai:~340). A bare `dispatchTool` token, a dead
// `"dispatchTool"` literal (string literals are blanked before this runs), and a local-shadow call
// all FAIL this check.
const DISPATCH_CALL_RE = /\bctx\.dispatchTool\s*\(/;

/**
 * Strip `//` line comments, slash-star block comments, AND string/template literals so the checks
 * skip prose AND dead string literals (a `"dispatchTool"` literal must NOT satisfy the dispatch
 * check). Replaces a string literal's BODY with spaces (preserving the quotes so token boundaries
 * are intact) — defeats the dead-string-literal bypass (#16) while leaving real code intact.
 */
function stripCommentsAndStrings(src) {
  let s = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (avoid matching `://` in urls)
  // Blank the bodies of '...', "...", `...` string/template literals (keep the delimiters).
  s = s.replace(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g, (m) => {
    const q = m[0];
    return q + ' '.repeat(Math.max(0, m.length - 2)) + q;
  });
  return s;
}

/**
 * Find every `execute:` OR `invoke:` handler body inside adapter src and return the brace-balanced
 * (or concise-arrow, bounded to the enclosing call) slice for each, so we can check it routes
 * through dispatchTool. Greppable + brace-matched (no AST). Returns an array of body strings.
 *
 * Both keys are checked: `execute` is the neutral tool() declaration key; `invoke` is the SDK's
 * REAL runtime handler key (FunctionTool.invoke) — an `invoke:` handler that runs product logic
 * bypasses the chokepoint exactly like an `execute:` one (#4/#15/#18).
 */
function extractHandlerBodies(code) {
  const bodies = [];
  const re = /\b(execute|invoke)\s*:/g;
  let m;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop.
  while ((m = re.exec(code)) !== null) {
    const after = code.slice(m.index + m[0].length);
    bodies.push(captureBody(after));
  }
  // POSITIONAL handler form (the Anthropic in-proc MCP bridge): the Anthropic SDK helper
  // `tool(name, description, inputSchema, handler)` passes the handler as a POSITIONAL argument, NOT
  // an `execute:`/`invoke:` keyed property — so the keyed scan above misses it. Capture the handler
  // FUNCTION argument of every `tool(`/`createTool(`/`registerTool(` call (the arg that is an arrow
  // or `function`), so a positional handler that does NOT call dispatchTool is still flagged.
  bodies.push(...extractPositionalHandlerBodies(code));
  return bodies;
}

/** Tool-builder calls whose POSITIONAL function argument is the handler (Anthropic MCP tool()). */
const TOOL_BUILDER_CALL_RE = /\b(?:tool|createTool|registerTool)\s*\(/g;

/**
 * Find every tool-builder CALL and, for each, return the handler-body string of its POSITIONAL
 * handler argument (the LAST top-level argument of `tool(name, desc, schema, handler)`). Hardened
 * (review B4) to flag a handler passed BY NAME or WRAPPED, not just an inline literal:
 *   - inline arrow `(...) =>` / `function (...)`  -> capture its body (checked for ctx.dispatchTool).
 *   - bare identifier  `namedHandler`             -> the gate cannot inspect the referenced function,
 *                                                    so it CANNOT prove dispatch-compliance -> FLAG.
 *   - call-expression  `wrap(handler)`            -> a wrapped/returned handler, likewise opaque ->
 *                                                    FLAG.
 *   - object literal `{ ... }`                    -> NOT a positional handler (the OpenAI/Pi
 *                                                    `tool({execute})` form) -> ignore (keyed scan).
 * A FLAGGED non-inline handler yields a synthetic body with NO ctx.dispatchTool call, so the
 * dispatch-compliance check downstream reports it. Returns an array of handler-body strings.
 */
function extractPositionalHandlerBodies(code) {
  const bodies = [];
  let m;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop.
  while ((m = TOOL_BUILDER_CALL_RE.exec(code)) !== null) {
    const argsStart = m.index + m[0].length; // just after the opening '('
    const argsSlice = captureCallArgs(code, argsStart);
    const args = splitTopLevelArgs(argsSlice);
    if (args.length === 0) continue;
    // The handler is the LAST positional argument. Single-arg object form (tool({...})) is the keyed
    // form — skip it here. Multi-arg form (tool(name, desc, schema, handler)) -> last arg is the
    // handler.
    const last = args[args.length - 1].trim();
    if (args.length === 1) {
      // tool({ execute }) object form OR tool(inlineArrow) single-arg form. An object literal is the
      // keyed form (skip); a bare inline arrow/function single arg is still a positional handler.
      if (last.startsWith('{')) continue;
    }
    bodies.push(positionalHandlerBody(last));
  }
  return bodies;
}

/**
 * Classify a positional handler argument and return a body string to dispatch-check:
 *  - inline arrow/function literal -> its captured body (real code, may contain ctx.dispatchTool).
 *  - anything else (bare identifier `foo`, call-expr `wrap(foo)`, member `obj.foo`) -> a synthetic
 *    NON-COMPLIANT body (no ctx.dispatchTool call) so it is flagged: the gate cannot prove an
 *    indirected handler routes through the chokepoint.
 */
function positionalHandlerBody(arg) {
  const a = arg.trim();
  const isInlineFn =
    /^(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(a) ||
    // an inline arrow whose single param list is destructured/typed and spans parens is handled by
    // captureBody; the leading-token test above covers `(args) =>`, `async (args) =>`, `x =>`.
    false;
  if (isInlineFn) return captureBody(a);
  // Non-inline positional handler (named reference / wrapped / member): opaque to the gate -> FLAG.
  return `__NON_INLINE_POSITIONAL_HANDLER__(${a})`;
}

/**
 * Split a call's argument list (the text between its parens) into TOP-LEVEL argument strings,
 * respecting nested parens/braces/brackets and string literals (already blanked by the caller's
 * stripCommentsAndStrings, so quotes here are empty). Commas at depth 0 separate arguments.
 */
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

/**
 * Capture a function/arrow body starting at `s` (skips a leading async/arrow/params header).
 *  - block body `{ ... }`  -> brace-balanced slice.
 *  - concise arrow `=> expr` (no block) -> slice up to the matching close of the ENCLOSING call
 *    (paren-balanced from `=>`), NOT a flat char window (#3) — so a long concise body is fully
 *    captured and an inline early-return fast-path before a dispatchTool call is still seen.
 */
function captureBody(s) {
  const braceIdx = s.indexOf('{');
  const arrowIdx = s.indexOf('=>');
  if (
    braceIdx === -1 ||
    (arrowIdx !== -1 && arrowIdx < braceIdx && !looksLikeBlockArrow(s, arrowIdx, braceIdx))
  ) {
    // concise arrow: capture from `=>` up to the close of the enclosing call (paren-balanced).
    return arrowIdx !== -1 ? captureConciseArrow(s, arrowIdx + 2) : s;
  }
  // brace-balanced block body
  let depth = 0;
  for (let i = braceIdx; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(braceIdx, i + 1);
    }
  }
  return s.slice(braceIdx); // unbalanced (defensive)
}

/**
 * Capture a concise-arrow body from `start` up to the close of the enclosing call: balance parens
 * (and braces, for an object-returning arrow) and stop at the first point where the depth drops
 * below zero (the enclosing tool(...) close paren) or a top-level comma. Bounded by brace/paren
 * balance, not a fixed window.
 */
function captureConciseArrow(s, start) {
  let paren = 0;
  let brace = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') paren++;
    else if (ch === ')') {
      if (paren === 0 && brace === 0) return s.slice(start, i); // closes the enclosing call
      paren--;
    } else if (ch === '{') brace++;
    else if (ch === '}') brace--;
    else if (ch === ',' && paren === 0 && brace === 0) {
      return s.slice(start, i); // next property of the tool({...}) object literal
    }
  }
  return s.slice(start);
}

/** True if the `=>` at arrowIdx is followed (before braceIdx) only by whitespace → a block body. */
function looksLikeBlockArrow(s, arrowIdx, braceIdx) {
  return s.slice(arrowIdx + 2, braceIdx).trim() === '';
}

/**
 * Detect adapter-handler violations in one file's source. Pure (no I/O) so the self-test exercises
 * the exact logic. `rel` is used only for the allowlist + message. Returns violation strings.
 */
export function detectViolations(rel, src) {
  const found = [];
  if (isAllowlisted(rel)) return found; // not-yet-converted adapter (the allowlist is empty)
  const code = stripCommentsAndStrings(src);

  for (const re of HANDLER_MAP_RES) {
    if (re.test(code)) {
      found.push(
        `${rel}: declares a handler-map identifier (${re.source}) — adapters must hold NO tool ` +
          'handler registry; route every tool call through ctx.dispatchTool.',
      );
      break; // one handler-map finding per file is enough signal.
    }
  }

  if (SDK_SIDE_EFFECT_FACTORY_RE.test(code)) {
    found.push(
      `${rel}: constructs a side-effecting SDK tool factory ` +
        '(shellTool/computerTool/applyPatchTool/hostedMcpTool) — these bypass the ctx.dispatchTool ' +
        'chokepoint and are forbidden in adapter src.',
    );
  }

  for (const body of extractHandlerBodies(code)) {
    if (!DISPATCH_CALL_RE.test(body)) {
      found.push(
        `${rel}: a tool() execute/invoke body does NOT CALL ctx.dispatchTool(...) — an inline tool ` +
          'handler bypasses the security validate/opaque-wrap/journal chokepoint. Marshal args to ' +
          'ctx.dispatchTool(name, args, callId) and return its opaque result into the tool-result ' +
          'channel.',
      );
    }
  }
  return found;
}

// --- self-test: prove the detector fires for EVERY confirmed bypass vector + passes the clean one -
function selfTest() {
  const cases = [
    // ---- handler-map registries (broadened beyond the exact toolHandlers token) ----
    {
      rel: 'packages/adapters/openai/src/x.ts',
      src: 'toolHandlers?: Record<string, Fn>;',
      expect: true,
    },
    {
      rel: 'packages/adapters/openai/src/x.ts',
      src: 'this.toolHandlers = opts.toolHandlers ?? {};',
      expect: true,
    },
    {
      rel: 'packages/adapters/openai/src/x.ts',
      src: 'const tool_handlers = { send } as const;',
      expect: true,
    },
    {
      rel: 'packages/adapters/openai/src/x.ts',
      src: 'private toolFns: Record<string, Fn> = {};',
      expect: true,
    },
    {
      rel: 'packages/adapters/openai/src/x.ts',
      src: 'const handlers = { lookup }; return handlers[name](args);',
      expect: true,
    },
    // ---- side-effecting SDK tool factories ----
    {
      rel: 'packages/adapters/openai/src/x.ts',
      src: 'const t = shellTool({ exec: true });',
      expect: true,
    },
    {
      rel: 'packages/adapters/openai/src/x.ts',
      src: 'tools.push(computerTool({}));',
      expect: true,
    },
    { rel: 'packages/adapters/openai/src/x.ts', src: 'applyPatchTool({ root });', expect: true },
    { rel: 'packages/adapters/openai/src/x.ts', src: 'hostedMcpTool({ url });', expect: true },
    // ---- inline execute handler (no dispatchTool) ----
    {
      rel: 'packages/adapters/openai/src/x.ts',
      src: 'tool({ name, execute: async (args) => { const out = handler(args); return JSON.stringify(out); } })',
      expect: true,
    },
    // ---- inline INVOKE handler (the SDK's real runtime key) — must be caught too (#4/#15/#18) ----
    {
      rel: 'packages/adapters/openai/src/x.ts',
      src: 'const t = { name, invoke: async (ctx, input) => { return runHandler(input); } };',
      expect: true,
    },
    // ---- concise-arrow inline handler ----
    {
      rel: 'packages/adapters/openai/src/x.ts',
      src: 'tool({ name, execute: (args) => handler(args) })',
      expect: true,
    },
    // ---- DEAD STRING LITERAL "dispatchTool" must NOT satisfy the check (#16) ----
    {
      rel: 'packages/adapters/openai/src/x.ts',
      src: 'tool({ name, execute: (args) => { const _ = "dispatchTool"; return handler(args); } })',
      expect: true,
    },
    // ---- bare `dispatchTool` token (not a call) must NOT satisfy the check (#16) ----
    {
      rel: 'packages/adapters/openai/src/x.ts',
      src: 'tool({ name, execute: (args) => { const ref = dispatchTool; return handler(args); } })',
      expect: true,
    },
    // ---- inline EARLY-RETURN fast-path that returns product logic before a real dispatchTool() ----
    // The early `return` runs product logic; the trailing dispatchTool() never executes. With the
    // call form required AND the body fully captured, this is still flagged because the body DOES
    // contain a dispatchTool( call — so to make this a TRUE positive we use a fast-path with NO
    // dispatchTool call at all (the realistic bypass: short-circuit before ever reaching it).
    {
      rel: 'packages/adapters/openai/src/x.ts',
      src: 'tool({ name, execute: async (args) => { if (fast(args)) return inline(args); return other(args); } })',
      expect: true,
    },
    // ---- a concise-arrow body that MENTIONS dispatchTool only inside the OLD 400-char window but
    //      whose ACTUAL inline handler runs first (the #3 window bypass): no dispatchTool CALL ----
    {
      rel: 'packages/adapters/openai/src/x.ts',
      src: `tool({ name, execute: (args) => inlineRun(args) }); const note = "${'x'.repeat(50)} dispatchTool(here)";`,
      expect: true,
    },
    // ---- the COMPLIANT dispatch-only execute passes (real call form) ----
    {
      rel: 'packages/adapters/openai/src/x.ts',
      src: 'tool({ name, execute: async (args, c, d) => { const r = await ctx.dispatchTool(t.name, args, d?.toolCall?.callId); return JSON.stringify(r); } })',
      expect: false,
    },
    // ---- a compliant INVOKE that routes through dispatchTool passes ----
    {
      rel: 'packages/adapters/openai/src/x.ts',
      src: 'const t = { invoke: async (c, input, d) => JSON.stringify(await ctx.dispatchTool(name, input, d.callId)) };',
      expect: false,
    },
    // ---- the allowlist is EMPTY, so pi + anthropic are ENFORCED like openai ----
    {
      rel: 'packages/adapters/pi/src/index.ts',
      src: 'tool({ name, execute: (args) => handler(args) })',
      expect: true,
    },
    {
      rel: 'packages/adapters/anthropic/src/index.ts',
      src: 'toolHandlers?: Record<string, Fn>;',
      expect: true,
    },
    { rel: 'packages/adapters/pi/src/index.ts', src: 'shellTool({});', expect: true },
    // ---- POSITIONAL Anthropic MCP tool() handler that BYPASSES dispatchTool (must be caught) ----
    {
      rel: 'packages/adapters/anthropic/src/index.ts',
      src: 'tool(t.name, t.description, { args: z.unknown() }, async (rawArgs, extra) => { return runInline(rawArgs); })',
      expect: true,
    },
    // ---- POSITIONAL Anthropic MCP tool() handler that ROUTES through dispatchTool (compliant) ----
    {
      rel: 'packages/adapters/anthropic/src/index.ts',
      src: 'tool(t.name, t.description, { args: z.unknown() }, async (rawArgs, extra) => { const r = await ctx.dispatchTool(t.name, rawArgs, id); return asMcp(mcpText(JSON.stringify(r))); })',
      expect: false,
    },
    // ---- Pi defineTool({ execute }) host-tool that BYPASSES dispatchTool (must be caught) ----
    {
      rel: 'packages/adapters/pi/src/index.ts',
      src: 'defineTool({ name, label, description, parameters, execute: async (toolCallId, params) => ({ content: [{ type: "text", text: runInline(params) }] }) })',
      expect: true,
    },
    // ---- Pi defineTool({ execute }) host-tool that ROUTES through dispatchTool (compliant) ----
    {
      rel: 'packages/adapters/pi/src/index.ts',
      src: 'defineTool({ name, label, description, parameters, execute: async (toolCallId, params) => { const r = await ctx.dispatchTool(name, params, toolCallId); return { content: [{ type: "text", text: JSON.stringify(r) }] }; } })',
      expect: false,
    },
    // ---- B4: a POSITIONAL handler passed BY NAME (a reference the gate can't inspect) -> FLAG ----
    {
      rel: 'packages/adapters/anthropic/src/index.ts',
      src: 'tool(t.name, t.description, { args: z.unknown() }, namedHandler)',
      expect: true,
    },
    // ---- B4: a POSITIONAL handler WRAPPED in a call (wrap(handler)) -> opaque to the gate -> FLAG ----
    {
      rel: 'packages/adapters/anthropic/src/index.ts',
      src: 'tool(t.name, t.description, { args: z.unknown() }, wrap(handler))',
      expect: true,
    },
    // ---- B4: a POSITIONAL handler that is a member reference (this.run) -> FLAG ----
    {
      rel: 'packages/adapters/anthropic/src/index.ts',
      src: 'tool(t.name, t.description, { args: z.unknown() }, this.runTool)',
      expect: true,
    },
    // ---- B4: a SHADOWED-LOCAL dispatchTool (NOT ctx.dispatchTool) must NOT satisfy compliance ----
    // A local `const dispatchTool = (...) => runInline(...)` would satisfy a bare `dispatchTool(`
    // check while never reaching the dispatch chokepoint — the receiver-form requirement flags it.
    {
      rel: 'packages/adapters/anthropic/src/index.ts',
      src: 'tool(t.name, t.description, { args: z.unknown() }, async (rawArgs, extra) => { const dispatchTool = (n, a) => runInline(a); return dispatchTool(t.name, rawArgs); })',
      expect: true,
    },
    {
      rel: 'packages/adapters/pi/src/index.ts',
      src: 'defineTool({ name, execute: async (id, params) => { const dispatchTool = (n, a) => runInline(a); return dispatchTool(name, params); } })',
      expect: true,
    },
    // ---- M2: Codex MCP registerTool() POSITIONAL handler that BYPASSES dispatchTool (must be caught) ----
    {
      rel: 'packages/adapters/codex/src/index.ts',
      src: 'mcp.registerTool(t.name, { description: t.description, inputSchema: shape }, async (rawArgs, extra) => { return mcpResult(JSON.stringify(runInline(rawArgs)), false); })',
      expect: true,
    },
    // ---- M2: Codex MCP registerTool() POSITIONAL handler that ROUTES through dispatchTool (compliant) ----
    {
      rel: 'packages/adapters/codex/src/index.ts',
      src: 'mcp.registerTool(t.name, { description: t.description, inputSchema: shape }, async (rawArgs, extra) => { const r = await ctx.dispatchTool(t.name, rawArgs, id); return mcpResult(JSON.stringify(r), r.kind === "tool_error"); })',
      expect: false,
    },
    // ---- M2: a Codex registerTool handler passed BY NAME (the gate can't inspect it) -> FLAG ----
    {
      rel: 'packages/adapters/codex/src/index.ts',
      src: 'mcp.registerTool(t.name, { description: t.description, inputSchema: shape }, namedHandler)',
      expect: true,
    },
    // ---- M2: a Codex SHADOWED-LOCAL dispatchTool (NOT ctx.dispatchTool) must NOT satisfy compliance ----
    {
      rel: 'packages/adapters/codex/src/index.ts',
      src: 'mcp.registerTool(t.name, { description: t.description, inputSchema: shape }, async (rawArgs, extra) => { const dispatchTool = (n, a) => runInline(a); return mcpResult(JSON.stringify(dispatchTool(t.name, rawArgs)), false); })',
      expect: true,
    },
  ];
  for (const { rel, src, expect } of cases) {
    const hit = detectViolations(rel, src).length > 0;
    if (hit !== expect) {
      console.error(
        `adapter-no-handlers gate SELF-TEST FAILED: detector returned ${hit} (expected ${expect}) ` +
          `for [${rel}]: ${src}`,
      );
      process.exit(2);
    }
  }
}

selfTest();

const violations = [];
for (const root of ADAPTER_ROOTS) {
  for (const file of walk(join(repoRoot, root))) {
    const rel = relative(repoRoot, file).split('\\').join('/');
    if (isExcluded(rel)) continue;
    const src = readFileSync(file, 'utf8');
    violations.push(...detectViolations(rel, src));
  }
}

if (violations.length > 0) {
  console.error('adapter-no-handlers gate FAILED:');
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    '\nAdapters are anti-corruption layers that hold NO tool handlers. The ONLY tool path is ' +
      'ctx.dispatchTool (the security validate/opaque-wrap/journal chokepoint).',
  );
  process.exit(1);
}

console.log(
  'adapter-no-handlers gate PASSED: no handler maps, side-effecting tool factories, or ' +
    'non-dispatch tool handler bodies (keyed OR positional) in ANY adapter src — openai + ' +
    'anthropic + pi + codex all route every tool path through ctx.dispatchTool (allowlist empty).',
);
