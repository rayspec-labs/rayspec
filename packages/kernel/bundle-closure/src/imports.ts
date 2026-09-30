/**
 * The imports of one ES module, read by a lexer and never by running the module.
 *
 * `es-module-lexer` finds every static `import`/`export … from`, every `import()` expression and
 * every `import.meta`, skipping strings, comments, template literals and regular expressions. A
 * dynamic import whose argument is one string literal is as good as a static one; any other
 * argument is a module name computed at run time, which no static closure can follow, so it is
 * reported for the caller to refuse.
 */
import { ImportType, init, parse } from 'es-module-lexer';

/** One import of a module. */
export type ModuleImport =
  | { kind: 'static' | 'dynamic'; specifier: string; line: number }
  | { kind: 'computed'; line: number };

/** Every import of `source`, in source order, or `undefined` when it is not a parseable module. */
export async function moduleImports(source: string): Promise<ModuleImport[] | undefined> {
  await init;
  let imports: ReturnType<typeof parse>[0];
  try {
    [imports] = parse(source);
  } catch {
    return undefined;
  }
  const result: ModuleImport[] = [];
  for (const entry of imports) {
    if (entry.t === ImportType.ImportMeta) continue;
    const line = lineOf(source, entry.ss);
    const dynamic =
      entry.t === ImportType.Dynamic ||
      entry.t === ImportType.DynamicSourcePhase ||
      entry.t === ImportType.DynamicDeferPhase;
    if (entry.n === undefined) {
      result.push({ kind: 'computed', line });
    } else if (dynamic && !isSingleStringLiteral(source.slice(entry.s, entry.e))) {
      // The lexer names a dynamic import's module when its argument starts with a string, even
      // when more follows (`import('./a' + x)` is named './a'); only a lone literal is static.
      result.push({ kind: 'computed', line });
    } else {
      result.push({ kind: dynamic ? 'dynamic' : 'static', specifier: entry.n, line });
    }
  }
  return result;
}

/** Whether the text of a dynamic import's argument is exactly one quoted string. */
function isSingleStringLiteral(text: string): boolean {
  const trimmed = text.trim();
  const quote = trimmed[0];
  if (quote !== "'" && quote !== '"' && quote !== '`') return false;
  if (quote === '`' && trimmed.includes('${')) return false;
  let i = 1;
  while (i < trimmed.length) {
    const c = trimmed[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i === trimmed.length - 1;
    i++;
  }
  return false;
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  const end = Math.max(0, Math.min(offset, source.length));
  for (let i = 0; i < end; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}
