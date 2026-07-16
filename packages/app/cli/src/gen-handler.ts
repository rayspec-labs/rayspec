/**
 * `rayspec gen-handler --holes <holes.json> --out <dir>` — the DETERMINISTIC handler RENDERER
 * (the bounded-template catalog T1/T2/T3).
 *
 * Reads a HOLES JSON file (the typed contract in `gen-handler/holes.ts`), validates it fail-closed,
 * renders ONE handler `.ts` from the bounded templates, and writes it under `--out` as
 * `<exportName-or-store>.ts` (or `--file <name.ts>` to override). The emitted code imports
 * `@rayspec/handler-sdk` TYPE-ONLY, takes ZERO npm deps, and reaches the DB ONLY through the injected
 * tenant-bound `init.db` — see `gen-handler/templates.ts`.
 *
 * GENERIC AUTHORING TOOLING (not product code): it renders ANY persist/lookup handler from holes. The
 * PRODUCT output lands in a pack repo; this subcommand only generates from holes the skill
 * derives. NO new platform mechanism — it emits TS against the SHIPPED handler runtime + dispatchTool.
 *
 * Output is a stable JSON envelope on stdout (`{ ok, file?, exportName?, template?, errors }`); exit
 * 0 ok / 1 not-ok. A usage/CLI error is raised as a CliError → exit 2 by the top-level (index.ts). NO
 * secrets ever appear (the only inputs are operator-supplied paths + the holes file content).
 *
 * FAIL-CLOSED FILESYSTEM SURFACE (defence-in-depth; internal/local, before external exposure): the `--holes` and
 * `--out` paths are resolved against the CWD and rejected if they ESCAPE it via `..` (a structural
 * jail, mirroring read-spec.ts). The holes file read is size-capped. The `--file` name must be a bare
 * filename (no path separators) so the output cannot be redirected outside `--out`.
 */
import { realpathSync, statSync } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { HolesError } from './gen-handler/holes.js';
import { genHandler } from './gen-handler/templates.js';

/** A holes file larger than this is rejected (a hole-set is small JSON; the cap bounds the read). */
export const MAX_HOLES_BYTES = 256 * 1024; // 256 KiB

/** The `gen-handler` JSON result envelope. */
export interface GenHandlerResult {
  readonly ok: boolean;
  /** The written file path (relative to the CWD) on success. */
  readonly file?: string;
  /** The exported handler symbol name on success. */
  readonly exportName?: string;
  /** The template that rendered it (`persist` | `lookup`) on success. */
  readonly template?: string;
  /** The fail-closed error list (a single entry today; an array for uniformity with doctor/plan). */
  readonly errors: { readonly code: string; readonly message: string }[];
}

/** A CLI/usage error (exit 2) — mirrors index.ts's CliError contract (it is re-thrown to the top level). */
export class GenHandlerCliError extends Error {}

/**
 * Resolve a path arg against the CWD, fail-closed on a `..`-escape (structural jail, like read-spec.ts).
 * Returns the resolved absolute path. `mustExist`+`mustBeFile` additionally stat (after symlink
 * resolution) so a symlink-to-elsewhere or a directory cannot slip past.
 */
function resolveJailed(
  arg: string,
  label: string,
  opts: { mustExist: boolean; mustBeFile: boolean },
): string {
  const cwd = process.cwd();
  const resolved = resolve(cwd, arg);
  const rel = relative(cwd, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new GenHandlerCliError(
      `${label} path ${JSON.stringify(arg)} escapes the working directory — pass a path inside it`,
    );
  }
  if (opts.mustExist) {
    let realPath: string;
    try {
      realPath = realpathSync(resolved);
    } catch {
      throw new GenHandlerCliError(`${label} not found: ${arg}`);
    }
    // Re-jail the symlink-resolved target (an in-CWD symlink can point outside — close that escape).
    const relReal = relative(cwd, realPath);
    if (relReal.startsWith('..') || isAbsolute(relReal)) {
      throw new GenHandlerCliError(
        `${label} ${arg} resolves to a target outside the working directory — pass a path inside it`,
      );
    }
    if (opts.mustBeFile && !statSync(realPath).isFile()) {
      throw new GenHandlerCliError(`${label} is not a regular file: ${arg}`);
    }
    return realPath;
  }
  return resolved;
}

/**
 * Run `gen-handler` over the subcommand args. Parses `--holes`/`--out`/`--file`, reads + validates the
 * holes, renders the handler, and writes it. Returns the `{ ok, ... }` envelope. A bad hole-set is
 * `ok:false` (NOT a throw); a usage problem (missing flag, bad path) throws `GenHandlerCliError`.
 */
export async function runGenHandler(args: readonly string[]): Promise<GenHandlerResult> {
  let values: { holes?: string; out?: string; file?: string };
  try {
    ({ values } = parseArgs({
      args: [...args],
      allowPositionals: false,
      strict: true,
      options: {
        holes: { type: 'string' },
        out: { type: 'string' },
        file: { type: 'string' },
      },
    }));
  } catch (e) {
    throw new GenHandlerCliError(
      `invalid arguments: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!values.holes) throw new GenHandlerCliError('missing required --holes <holes.json>');
  if (!values.out) throw new GenHandlerCliError('missing required --out <dir>');

  const holesPath = resolveJailed(values.holes, '--holes', { mustExist: true, mustBeFile: true });

  // Read the holes JSON (size-capped — a hole-set is small JSON, an oversized file is a mistake/DoS).
  // Open ONCE and enforce the cap by fstat'ing the OPEN handle (then read through it) — no `statSync`
  // check-then-read race where the path could be swapped between the size check and the read.
  let text: string;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(holesPath, 'r');
    const st = await handle.stat();
    if (st.size > MAX_HOLES_BYTES) {
      return {
        ok: false,
        errors: [
          {
            code: 'holes_too_large',
            message: `holes file is ${st.size} bytes — exceeds the ${MAX_HOLES_BYTES}-byte cap`,
          },
        ],
      };
    }
    text = await handle.readFile('utf8');
  } catch {
    return {
      ok: false,
      errors: [
        { code: 'holes_read_failed', message: `failed to read holes: ${String(values.holes)}` },
      ],
    };
  } finally {
    await handle?.close();
  }

  let holes: unknown;
  try {
    holes = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      errors: [
        {
          code: 'holes_parse_error',
          message: `holes is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
        },
      ],
    };
  }

  let code: string;
  try {
    code = genHandler(holes);
  } catch (e) {
    if (e instanceof HolesError) {
      return { ok: false, errors: [{ code: 'invalid_holes', message: e.message }] };
    }
    throw e;
  }

  // Derive the output filename: `--file <name.ts>` (a BARE filename, no separators) or, by default,
  // the handler's snake-cased export name. The bare-filename rule keeps the write inside `--out`.
  const h = holes as { exportName: string };
  // Default to a `.gen.ts` suffix — it SIGNALS "generated, do not edit by hand" AND is excluded from
  // the biome formatter/linter (biome.json `!**/*.gen.ts`), so the committed file stays byte-identical
  // to the raw render (the golden) without a formatter pass mutating it. `--file` may override.
  const fileName = values.file ?? `${camelToKebab(h.exportName)}.gen.ts`;
  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
    throw new GenHandlerCliError(
      `--file must be a bare filename (no path separators / '..'), got ${JSON.stringify(fileName)}`,
    );
  }
  if (!fileName.endsWith('.ts')) {
    throw new GenHandlerCliError(`--file must end in .ts, got ${JSON.stringify(fileName)}`);
  }

  const outDir = resolveJailed(values.out, '--out', { mustExist: false, mustBeFile: false });
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, fileName);
  await writeFile(outPath, code, 'utf8');

  return {
    ok: true,
    file: relative(process.cwd(), outPath),
    exportName: h.exportName,
    template: (holes as { template: string }).template,
    errors: [],
  };
}

/** camelCase → kebab-case for the default output filename (`codeClaim` → `code-claim`). */
function camelToKebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}
