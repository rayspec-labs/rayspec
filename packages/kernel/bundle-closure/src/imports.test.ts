/**
 * The lexer-based import reader: static and literal dynamic imports are named, computed ones are
 * reported, and text inside strings, comments and templates is never mistaken for an import.
 */
import { describe, expect, it } from 'vitest';
import { moduleImports } from './imports.js';

describe('moduleImports', () => {
  it('names static imports, re-exports and literal dynamic imports, with their lines', async () => {
    const source = [
      "import a from './a.js';",
      "export * from 'pkg';",
      "export { b } from '@scope/b';",
      "const c = await import('./c.js');",
      'const d = await import("./d.js", { with: { type: "json" } });',
      'import.meta.url;',
    ].join('\n');
    expect(await moduleImports(source)).toEqual([
      { kind: 'static', specifier: './a.js', line: 1 },
      { kind: 'static', specifier: 'pkg', line: 2 },
      { kind: 'static', specifier: '@scope/b', line: 3 },
      { kind: 'dynamic', specifier: './c.js', line: 4 },
      { kind: 'dynamic', specifier: './d.js', line: 5 },
    ]);
  });

  it.each([
    'import(name)',
    "import('./x/' + name)",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the module source holds a template literal
    'import(`./x/${name}.js`)',
    'import(`./x.js`)',
    'import(await pick())',
  ])('reports %s as computed', async (expression) => {
    expect(await moduleImports(`const name = 'a';\nawait ${expression};\n`)).toEqual([
      { kind: 'computed', line: 2 },
    ]);
  });

  it('ignores import-like text in strings, comments and regular expressions', async () => {
    const source = [
      "// import 'a';",
      "/* import('b') */",
      'const s = "import \'c\'";',
      "const t = `import('d')`;",
      "const r = /import('e')/;",
    ].join('\n');
    expect(await moduleImports(source)).toEqual([]);
  });

  it('returns nothing it cannot parse', async () => {
    expect(await moduleImports("import { from 'x';")).toBeUndefined();
  });
});
