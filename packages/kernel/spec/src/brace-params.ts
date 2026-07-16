/**
 * `{param}` extraction/rewriting for declared route paths — a single forward character scan, with NO
 * regular expression, so the work is strictly linear in the input length for EVERY input (no
 * backtracking, no quantifier, and no length cap on the param name).
 *
 * The two helpers are the shared, byte-exact equivalent of iterating the pattern `\{([^}/]+)\}`
 * globally over a path — the form the route/view emitters and the Hono-path rewrite historically used.
 * They preserve that pattern's EXACT semantics for every input, including its edges:
 *   - `{}`        → NOT a param (the run needs at least one character);
 *   - `{a/b}`     → NOT a param (a `/` ends the run before a `}` can close it);
 *   - `{a}{b}`    → two params (`a`, `b`);
 *   - `{a{b}`     → one param whose name is `a{b` (an inner `{` is an ordinary name character);
 *   - `{unclosed` → no param (no closing `}`);
 *   - names of ANY length (1, 128, 129, thousands) and ANY code points (ASCII, emoji, astral).
 *
 * A `{param}` here is `{`, then a maximal run of ≥1 characters that are neither `}` nor `/`, then a
 * `}`. Because the run stops at the first `}` or `/`, a match exists at a `{` iff that first stopping
 * character is a `}` (a `/` or end-of-input means no match at this `{`); on a non-match the scan
 * advances by a single character, exactly as a global regex retries at the next position.
 */

/**
 * Locate the `{param}` span starting at `open` (where `path[open] === '{'`). Returns the closing-brace
 * index and the param name when a valid `{name}` (name length ≥ 1, first stopping char is `}`) begins
 * there, or `undefined` when this `{` does not open a param. Shared by both public helpers so the
 * extract and rewrite paths can never drift.
 */
function braceSpanAt(path: string, open: number): { close: number; name: string } | undefined {
  // Walk to the first `}` or `/` after the `{` (or the end of the string).
  let j = open + 1;
  while (j < path.length && path[j] !== '}' && path[j] !== '/') j++;
  // A param exists iff that stopping char is a `}` AND at least one name char preceded it.
  if (j < path.length && path[j] === '}' && j > open + 1) {
    return { close: j, name: path.slice(open + 1, j) };
  }
  return undefined;
}

/**
 * Extract the `{param}` names from a declared route path in order (e.g. `/meetings/{id}/x` → `['id']`).
 * Byte-exact equivalent of collecting capture group 1 of a global `\{([^}/]+)\}` scan.
 */
export function braceParamNames(path: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < path.length) {
    if (path[i] !== '{') {
      i++;
      continue;
    }
    const span = braceSpanAt(path, i);
    if (span) {
      out.push(span.name);
      i = span.close + 1; // continue after the closing `}`
    } else {
      i++; // not a param — advance one char and retry (a global regex does the same)
    }
  }
  return out;
}

/**
 * Rewrite each `{param}` in a declared route path via `replace(name)`, copying every other character
 * verbatim (e.g. `toHonoPath` uses `(name) => ':' + name`; the operationId slug uses
 * `(name) => '_by_' + name + '_'`). Byte-exact equivalent of `path.replace(/\{([^}/]+)\}/g, cb)`.
 */
export function rewriteBraceParams(path: string, replace: (name: string) => string): string {
  let out = '';
  let last = 0; // start of the not-yet-copied verbatim region
  let i = 0;
  while (i < path.length) {
    if (path[i] !== '{') {
      i++;
      continue;
    }
    const span = braceSpanAt(path, i);
    if (span) {
      out += path.slice(last, i); // verbatim text before this `{param}`
      out += replace(span.name);
      i = span.close + 1;
      last = i;
    } else {
      i++;
    }
  }
  out += path.slice(last); // trailing verbatim text
  return out;
}
