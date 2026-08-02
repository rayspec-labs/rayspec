/**
 * Pure-unit tests for the `<VAR>_FILE` boot-secret resolution in `loadServerConfig`. No DB.
 *
 * THE load-bearing assertion: a `<VAR>_FILE` mount takes PRECEDENCE over the plain variable and a
 * BROKEN mount (missing / unreadable / a directory / empty) ABORTS the boot — it must never silently
 * downgrade to the plain variable, because that is exactly the operator mistake that would put a
 * secret back into `docker inspect` / `/proc/<pid>/environ` while the boot still looks healthy.
 *
 * Every temp file is created INSIDE the test (never sourced from the ambient shell), so the suite is
 * self-contained under any task-runner environment filtering.
 */
import { constants as bufferConstants } from 'node:buffer';
import {
  chmodSync,
  closeSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BootConfigError,
  loadServerConfig,
  loadTenantProvisionSecrets,
} from './composition-root.js';

const DB_URL = 'postgres://u:p@localhost:5432/app';
const PEPPER = 'file-sourced-pepper-value';
// A MULTI-LINE stand-in for the signing key. `loadServerConfig` resolves this value without parsing
// it, and what these tests need from it is exactly that: that the real newlines inside a mounted
// file survive verbatim. A genuine key is generated at runtime by the DB-backed boot suite, which is
// where the value has to be a real importable key — so no key-shaped literal lives in the repo.
const SIGNING_KEY = 'signing-key-line-one\nsigning-key-line-two\nsigning-key-line-three';
// A distinctive value written to a file the resolver genuinely opens, so that "it is not in the
// abort message / not in the console output" is a statement about content that was really there.
const SENTINEL = 'sentinel-secret-value-that-must-never-leave-the-file';

/** A complete valid PLAIN env — each test overrides only the variable under test. */
const plainEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://env-user:env-pass@env-host:5432/env-db',
  RAYSPEC_JWT_SIGNING_KEY: 'env-sourced-signing-key-line-one\nenv-sourced-line-two',
  RAYSPEC_API_KEY_PEPPER: 'env-sourced-pepper-value',
};

let dir = '';
/** Write `content` to a fresh file in the suite temp dir and return its absolute path. */
function secretFile(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayspec-boot-secret-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadServerConfig — a <VAR>_FILE mount sources the secret', () => {
  it('resolves ALL THREE secrets from their _FILE variant with the plain variables unset', () => {
    const config = loadServerConfig({
      DATABASE_URL_FILE: secretFile('all-db', DB_URL),
      RAYSPEC_JWT_SIGNING_KEY_FILE: secretFile('all-key', SIGNING_KEY),
      RAYSPEC_API_KEY_PEPPER_FILE: secretFile('all-pepper', PEPPER),
    });
    expect(config.databaseUrl).toBe(DB_URL);
    expect(config.jwtSigningKeyPem).toBe(SIGNING_KEY);
    expect(config.apiKeyPepper).toBe(PEPPER);
  });

  it('resolves a secret projected through a symlink chain, as a secret mount presents it', () => {
    // A container secret projection does not hand the server a plain file: it presents
    // `<name> -> ..data/<name>` with `..data -> ..data-<version>/`, so the whole set can be
    // replaced atomically by re-pointing one link. The resolver's stat FOLLOWS symlinks, which is
    // what makes such a mount work — a guard built on lstat instead would abort the boot on every
    // one of them, and would contradict the read it gates, which follows symlinks unconditionally.
    // This arm exists to make that a pinned behaviour rather than an unexamined default.
    const mount = join(dir, 'projected-mount');
    const versioned = join(mount, '..data-01');
    mkdirSync(versioned, { recursive: true });
    writeFileSync(join(versioned, 'api-key-pepper'), `${PEPPER}\n`);
    symlinkSync('..data-01', join(mount, '..data'));
    symlinkSync(join('..data', 'api-key-pepper'), join(mount, 'api-key-pepper'));

    const path = join(mount, 'api-key-pepper');
    // The mount really is a symlink chain — otherwise this arm would prove nothing about symlinks.
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(mount, '..data')).isSymbolicLink()).toBe(true);

    const config = loadServerConfig({ ...plainEnv, RAYSPEC_API_KEY_PEPPER_FILE: path });
    expect(config.apiKeyPepper).toBe(PEPPER);
    expect(config.apiKeyPepper).not.toBe(plainEnv.RAYSPEC_API_KEY_PEPPER);
  });

  it('derives the durable-worker system database url from a _FILE-sourced connection string', () => {
    // The system db url is derived from the ALREADY-RESOLVED value, so a file mount must flow
    // through to the durable worker too (an unset DBOS_SYSTEM_DATABASE_URL derives `<db>_dbos_sys`).
    const config = loadServerConfig({
      ...plainEnv,
      DATABASE_URL_FILE: secretFile('dbos-db', DB_URL),
    });
    expect(config.dbosSystemDatabaseUrl).toBe('postgres://u:p@localhost:5432/app_dbos_sys');
    expect(config.dbosSystemDatabaseUrl).not.toContain('env-db');
  });
});

describe('loadServerConfig — the _FILE variant takes PRECEDENCE over the plain variable', () => {
  it('uses the file value and leaves NO trace of the plain value, for each secret', () => {
    const config = loadServerConfig({
      ...plainEnv,
      DATABASE_URL_FILE: secretFile('prec-db', DB_URL),
      RAYSPEC_JWT_SIGNING_KEY_FILE: secretFile('prec-key', SIGNING_KEY),
      RAYSPEC_API_KEY_PEPPER_FILE: secretFile('prec-pepper', PEPPER),
    });
    expect(config.databaseUrl).toBe(DB_URL);
    expect(config.jwtSigningKeyPem).toBe(SIGNING_KEY);
    expect(config.apiKeyPepper).toBe(PEPPER);
    // The plain values are IGNORED entirely — not merged, not preferred, not consulted.
    expect(config.databaseUrl).not.toContain('env-host');
    expect(config.jwtSigningKeyPem).not.toContain('env-sourced-signing-key');
    expect(config.apiKeyPepper).not.toContain('env-sourced');
  });

  it('honours precedence per-variable (one mounted secret alongside two plain ones)', () => {
    const config = loadServerConfig({
      ...plainEnv,
      RAYSPEC_API_KEY_PEPPER_FILE: secretFile('mixed-pepper', PEPPER),
    });
    expect(config.apiKeyPepper).toBe(PEPPER);
    // The two variables WITHOUT a _FILE mount still resolve from the plain environment, byte-exact.
    expect(config.databaseUrl).toBe(plainEnv.DATABASE_URL);
    expect(config.jwtSigningKeyPem).toBe(plainEnv.RAYSPEC_JWT_SIGNING_KEY);
  });
});

describe('loadServerConfig — a BROKEN _FILE mount aborts and NEVER falls back', () => {
  // Each arm sets the PLAIN variable to a perfectly usable value at the same time. A fallback would
  // therefore boot happily — so "it threw" is here the proof that no silent downgrade happened.
  it('a MISSING path aborts (it does not fall back to the plain variable that IS set)', () => {
    const env = { ...plainEnv, RAYSPEC_API_KEY_PEPPER_FILE: join(dir, 'does-not-exist') };
    expect(() => loadServerConfig(env)).toThrow(BootConfigError);
    // Belt and braces: prove the SAME env minus the broken mount would have booted fine, i.e. the
    // abort is caused by the broken mount and not by anything else missing in this env.
    const { RAYSPEC_API_KEY_PEPPER_FILE: _dropped, ...withoutMount } = env;
    expect(loadServerConfig(withoutMount).apiKeyPepper).toBe(plainEnv.RAYSPEC_API_KEY_PEPPER);
  });

  it('a DIRECTORY aborts (no raw EISDIR escape, no fallback)', () => {
    const asDir = join(dir, 'a-directory');
    mkdirSync(asDir, { recursive: true });
    expect(() => loadServerConfig({ ...plainEnv, DATABASE_URL_FILE: asDir })).toThrow(
      BootConfigError,
    );
  });

  it('an EMPTY / whitespace-only file aborts (no fallback)', () => {
    expect(() =>
      loadServerConfig({ ...plainEnv, RAYSPEC_JWT_SIGNING_KEY_FILE: secretFile('empty', '') }),
    ).toThrow(BootConfigError);
    expect(() =>
      loadServerConfig({
        ...plainEnv,
        RAYSPEC_API_KEY_PEPPER_FILE: secretFile('blank', '  \n\t \n'),
      }),
    ).toThrow(BootConfigError);
  });

  it('an UNREADABLE file (mode 000) aborts (no fallback)', (ctx) => {
    const path = secretFile('unreadable', PEPPER);
    chmodSync(path, 0o000);
    // A process running as root can read a mode-000 file, which would make this arm vacuous.
    if (typeof process.getuid === 'function' && process.getuid() === 0) ctx.skip();
    expect(() => loadServerConfig({ ...plainEnv, RAYSPEC_API_KEY_PEPPER_FILE: path })).toThrow(
      BootConfigError,
    );
  });
});

describe('loadServerConfig — an abort message carries the variable, the path, the code, nothing else', () => {
  // Asserted by EQUALITY, not by the absence of a sentinel. Equality is what has teeth here: any
  // extra interpolation at all breaks it — a slice of the file, the errno string, a byte count, a
  // length — including the leak nobody thought to write an absence check for. It is also the only
  // check that means anything on the one branch that reads content and THEN aborts: a file that is
  // empty after trimming has, by definition, no distinctive content left to look for.
  //
  // Each expected message is spelled out here in full rather than imported from the resolver, so
  // the two have to be changed together and a change to either one shows up as a failure.
  const missingMessage = (v: string, p: string) =>
    `Boot aborted — ${v} points at '${p}', which is missing or not a regular file. Point it at a ` +
    'readable file holding the secret. Refusing to start (fail-closed) — a secret file that cannot ' +
    'be read NEVER falls back to the plain environment variable.';
  const unreadableMessage = (v: string, p: string, code: string) =>
    `Boot aborted — ${v} points at '${p}', which could not be read (${code}). Check ownership and ` +
    'file mode; the server process must be able to read it. Refusing to start (fail-closed) — an ' +
    'unreadable secret file NEVER falls back to the plain environment variable.';
  const emptyMessage = (v: string, p: string) =>
    `Boot aborted — ${v} points at '${p}', which is empty. Refusing to start (fail-closed) — an ` +
    'empty secret file NEVER falls back to the plain environment variable.';

  /** Load with `env`, expecting an abort, and hand back the message it aborted with. */
  function abortMessage(env: NodeJS.ProcessEnv): string {
    try {
      loadServerConfig(env);
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error('expected a broken secret mount to abort the boot, but it returned a config');
  }

  it('a MISSING path aborts with exactly the variable and the path', () => {
    const path = join(dir, 'exact-missing');
    expect(abortMessage({ ...plainEnv, RAYSPEC_API_KEY_PEPPER_FILE: path })).toBe(
      missingMessage('RAYSPEC_API_KEY_PEPPER_FILE', path),
    );
  });

  it('a DIRECTORY aborts with exactly the variable and the path', () => {
    const path = join(dir, 'exact-directory');
    mkdirSync(path, { recursive: true });
    expect(abortMessage({ ...plainEnv, DATABASE_URL_FILE: path })).toBe(
      missingMessage('DATABASE_URL_FILE', path),
    );
  });

  it('an UNREADABLE file holding real content aborts with the OS code and no trace of it', (ctx) => {
    // The one broken-mount arm where a real secret genuinely sits at the path the resolver opens
    // and fails on — so an implementation that reached for the content on the way to the error
    // would have something to leak here.
    const path = secretFile('exact-unreadable', `${SENTINEL}\n`);
    chmodSync(path, 0o000);
    // A process running as root reads a mode-000 file happily, which would make this arm vacuous.
    if (typeof process.getuid === 'function' && process.getuid() === 0) ctx.skip();
    const message = abortMessage({ ...plainEnv, RAYSPEC_JWT_SIGNING_KEY_FILE: path });
    expect(message).toBe(unreadableMessage('RAYSPEC_JWT_SIGNING_KEY_FILE', path, 'EACCES'));
    // Belt and braces on top of the equality: the sentinel is nowhere in the message.
    expect(message).not.toContain(SENTINEL);
  });

  it('a file too large to read carries the runtime code VERBATIM, underscores and all', () => {
    // Not every read failure is an errno. A regular file one byte past the maximum string length
    // reads into a buffer and then fails on the way to a string, with the runtime's own
    // `ERR_STRING_TOO_LONG` — the shape a mount pointed at a log or a data dump by mistake takes.
    // Those names carry underscores, so a code guard written for errno names only would swallow
    // this one and report `unknown`, i.e. drop the single detail that says "this is not a
    // permission problem" on exactly the case an operator cannot guess.
    //
    // The file is created by truncation with no bytes written, so it is sparse: it costs its length
    // in neither disk nor write time. It does cost MEMORY, though — `readFileSync(path, 'utf8')`
    // materializes the whole buffer before the conversion to a string fails, so this one arm drives
    // the worker's peak resident set to roughly a gigabyte and accounts for nearly all of this
    // file's test time (measured: ~0.33 GB peak running one other arm, ~1.0 GB running this one).
    // That is affordable on an ordinary uncapped runner; on a memory-capped one, this is the arm to
    // look at first. The code is spelled out rather than read back from the
    // failure so that this arm keeps its point — if a runtime ever raised something else here, it
    // says so loudly instead of passing vacuously.
    const path = join(dir, 'too-large-to-read-as-a-string');
    const fd = openSync(path, 'w');
    try {
      ftruncateSync(fd, bufferConstants.MAX_STRING_LENGTH + 1);
    } finally {
      closeSync(fd);
    }
    try {
      const message = abortMessage({ ...plainEnv, DATABASE_URL_FILE: path });
      expect(message).toBe(unreadableMessage('DATABASE_URL_FILE', path, 'ERR_STRING_TOO_LONG'));
      expect(message).not.toContain('unknown');
    } finally {
      // Released here rather than in afterAll: the suite temp dir outlives this arm.
      rmSync(path, { force: true });
    }
  });

  it('an EMPTY file aborts with exactly the variable and the path', () => {
    const path = secretFile('exact-empty', '');
    expect(abortMessage({ ...plainEnv, RAYSPEC_API_KEY_PEPPER_FILE: path })).toBe(
      emptyMessage('RAYSPEC_API_KEY_PEPPER_FILE', path),
    );
  });

  it('a WHITESPACE-ONLY file aborts with the same message — the content it read is not in it', () => {
    // The content here is whitespace by construction, so nothing but equality can catch a leak of
    // it: an implementation that appended the raw bytes would still pass every absence check.
    const path = secretFile('exact-whitespace', '  \n\t \n');
    expect(abortMessage({ ...plainEnv, RAYSPEC_API_KEY_PEPPER_FILE: path })).toBe(
      emptyMessage('RAYSPEC_API_KEY_PEPPER_FILE', path),
    );
  });
});

describe('loadServerConfig — resolving a mounted secret writes nothing to the output', () => {
  // The other half of "never leaks the secret": an abort message is one channel, a stray log line
  // is the other, and nothing else in either suite watches that channel. Captured across a
  // SUCCESSFUL resolution and across each abort, and restored afterwards.
  //
  // `console.log` and its siblings are not the whole channel. Every gap that can CARRY output was
  // confirmed by injecting a leak on that exact channel and watching this suite stay green:
  //   - `process.stdout.write` / `process.stderr.write` — where an ad-hoc debug print most often
  //     goes, and the floor a direct write reaches without touching `console` at all;
  //   - `console.dir` / `console.dirxml` — both emit, and neither routes through `console.log`, so
  //     a spy on the usual six never sees them.
  // `console.groupEnd` is the one exception, and that experiment does NOT back it: it takes no
  // arguments and writes nothing on any channel (it only trims the group indent), so no leak can be
  // injected on it. It is spied because a superset costs nothing, not because a gap was shown.
  const methods = [
    'log',
    'info',
    'warn',
    'error',
    'debug',
    'trace',
    'dir',
    'dirxml',
    'groupEnd',
  ] as const;
  const streams = ['stdout', 'stderr'] as const;

  function captureConsole(run: () => void): { calls: unknown[][]; text: string } {
    const calls: unknown[][] = [];
    const spies = [
      ...methods.map((method) =>
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          calls.push(args);
        }),
      ),
      ...streams.map((stream) =>
        vi.spyOn(process[stream], 'write').mockImplementation(((chunk: unknown) => {
          calls.push([chunk]);
          return true;
        }) as typeof process.stdout.write),
      ),
    ];
    try {
      run();
    } catch {
      // An abort is expected in most arms; what is under test is what was written on the way there.
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    return { calls, text: calls.flat().map(String).join('\n') };
  }

  it('writes nothing while resolving all three secrets successfully', () => {
    const files = {
      DATABASE_URL_FILE: secretFile('quiet-db', DB_URL),
      RAYSPEC_JWT_SIGNING_KEY_FILE: secretFile('quiet-key', SIGNING_KEY),
      RAYSPEC_API_KEY_PEPPER_FILE: secretFile('quiet-pepper', SENTINEL),
    };
    let resolved: ReturnType<typeof loadServerConfig> | undefined;
    const { calls, text } = captureConsole(() => {
      resolved = loadServerConfig(files);
    });
    // The resolution really happened — otherwise "nothing was logged" would be free.
    expect(resolved?.apiKeyPepper).toBe(SENTINEL);
    expect(calls).toEqual([]);
    for (const secret of [DB_URL, SIGNING_KEY, SENTINEL]) expect(text).not.toContain(secret);
  });

  it('writes nothing while aborting on a broken mount', () => {
    const unreadable = secretFile('quiet-unreadable', `${SENTINEL}\n`);
    chmodSync(unreadable, 0o000);
    const root = typeof process.getuid === 'function' && process.getuid() === 0;
    const broken: NodeJS.ProcessEnv[] = [
      { ...plainEnv, RAYSPEC_API_KEY_PEPPER_FILE: join(dir, 'quiet-missing') },
      { ...plainEnv, RAYSPEC_API_KEY_PEPPER_FILE: secretFile('quiet-empty', '  \n') },
      ...(root ? [] : [{ ...plainEnv, RAYSPEC_API_KEY_PEPPER_FILE: unreadable }]),
    ];
    for (const env of broken) {
      const { calls, text } = captureConsole(() => loadServerConfig(env));
      expect(calls).toEqual([]);
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain(plainEnv.RAYSPEC_API_KEY_PEPPER);
    }
  });
});

describe('loadServerConfig — a BLANK _FILE value counts as NOT SET', () => {
  it('falls back to the plain variable for an empty / whitespace-only _FILE value', () => {
    // Container orchestrators routinely materialize an unset variable as "". Treating that as a
    // broken mount would abort every such boot, so blank ⇒ unset ⇒ the plain variable is used.
    for (const blank of ['', '   ', '\t\n']) {
      const config = loadServerConfig({
        ...plainEnv,
        DATABASE_URL_FILE: blank,
        RAYSPEC_JWT_SIGNING_KEY_FILE: blank,
        RAYSPEC_API_KEY_PEPPER_FILE: blank,
      });
      expect(config.databaseUrl).toBe(plainEnv.DATABASE_URL);
      expect(config.jwtSigningKeyPem).toBe(plainEnv.RAYSPEC_JWT_SIGNING_KEY);
      expect(config.apiKeyPepper).toBe(plainEnv.RAYSPEC_API_KEY_PEPPER);
    }
  });
});

describe('loadServerConfig — resolution reads the INJECTED env, not the ambient one', () => {
  it('ignores an ambient _FILE variable when an explicit env is passed', () => {
    // A caller that passes an explicit env must get exactly what it passed. An ambient _FILE would
    // otherwise outrank it and silently redirect the boot at a file the caller never named — and
    // because it would still produce a valid-looking config, nothing downstream would notice.
    const ambient = secretFile('ambient-pepper', 'ambient-pepper-that-must-not-win');
    const saved = process.env.RAYSPEC_API_KEY_PEPPER_FILE;
    process.env.RAYSPEC_API_KEY_PEPPER_FILE = ambient;
    try {
      const config = loadServerConfig({ ...plainEnv });
      expect(config.apiKeyPepper).toBe(plainEnv.RAYSPEC_API_KEY_PEPPER);
      expect(config.apiKeyPepper).not.toContain('ambient');
    } finally {
      if (saved === undefined) delete process.env.RAYSPEC_API_KEY_PEPPER_FILE;
      else process.env.RAYSPEC_API_KEY_PEPPER_FILE = saved;
    }
  });
});

describe('loadServerConfig — file content is trimmed to the byte-equivalent of the env form', () => {
  it('strips the trailing newline `echo`/`printf`/a secret projection appends', () => {
    const config = loadServerConfig({
      DATABASE_URL_FILE: secretFile('trim-db', `${DB_URL}\n`),
      RAYSPEC_JWT_SIGNING_KEY_FILE: secretFile('trim-key', `${SIGNING_KEY}\n`),
      RAYSPEC_API_KEY_PEPPER_FILE: secretFile('trim-pepper', `${PEPPER}\n`),
    });
    // Byte-equal to the value the plain-env form carries — the pepper especially: it IS the HMAC
    // key, so a surviving trailing newline would silently change every api-key hash.
    expect(config.apiKeyPepper).toBe(PEPPER);
    expect(config.databaseUrl).toBe(DB_URL);
    expect(config.jwtSigningKeyPem).toBe(SIGNING_KEY);
    // The real newlines INSIDE the value survive — only the surrounding whitespace is stripped,
    // and no `\n`-unescaping is applied (a file mount carries the real bytes).
    expect(config.jwtSigningKeyPem.split('\n')).toHaveLength(3);
    expect(config.jwtSigningKeyPem).not.toContain('\\n');
  });

  it('trims leading whitespace and a CRLF ending too', () => {
    const config = loadServerConfig({
      ...plainEnv,
      RAYSPEC_API_KEY_PEPPER_FILE: secretFile('trim-crlf', `  ${PEPPER}\r\n`),
    });
    expect(config.apiKeyPepper).toBe(PEPPER);
  });

  it('strips a leading byte-order mark and a leading newline', () => {
    // An editor or a `--from-file` round-trip leaves these routinely. For the signing key they are
    // the expensive kind of typo: a PKCS#8 import needs the PEM header at offset 0, so an untrimmed
    // value fails at signer construction — long after the database handle is open.
    const config = loadServerConfig({
      ...plainEnv,
      RAYSPEC_JWT_SIGNING_KEY_FILE: secretFile('trim-bom', `﻿\n${SIGNING_KEY}\n`),
    });
    expect(config.jwtSigningKeyPem).toBe(SIGNING_KEY);
    expect(config.jwtSigningKeyPem.startsWith('signing-key-line-one')).toBe(true);
  });
});

describe('loadServerConfig — the plain-env source is normalized to the same contract as a file mount', () => {
  // A boot secret carries the same whitespace-trim CONTRACT whichever source it comes from: leading
  // and trailing whitespace (spaces, tabs, CR/LF, a leading byte-order mark) is stripped, interior
  // bytes are untouched. The file-mount arms above pin that for the file source; these pin the SAME
  // guarantee for the plain variable, which used to flow through byte-raw.
  it('strips a trailing newline off a plain-env pepper — the HMAC-key regression', () => {
    // The pepper IS the api-key HMAC key. A plain-env value like `abc\n` (the `echo >>`/env-file
    // classic) surviving un-trimmed silently changes every api-key hash. It must resolve to `abc`.
    const config = loadServerConfig({ ...plainEnv, RAYSPEC_API_KEY_PEPPER: `${PEPPER}\n` });
    expect(config.apiKeyPepper).toBe(PEPPER);
    expect(config.apiKeyPepper).not.toContain('\n');
  });

  it('strips a leading BOM+newline off a plain-env signing key and keeps its interior newlines', () => {
    // A PKCS#8 import needs the PEM header at offset 0, so a leading BOM/newline breaks it — the same
    // failure the file form guards against, now guarded for the plain variable too.
    const config = loadServerConfig({
      ...plainEnv,
      RAYSPEC_JWT_SIGNING_KEY: `﻿\n${SIGNING_KEY}\n`,
    });
    expect(config.jwtSigningKeyPem).toBe(SIGNING_KEY);
    // The edges are gone but the interior newlines survive — a multi-line PEM stays a multi-line PEM.
    expect(config.jwtSigningKeyPem.split('\n')).toHaveLength(3);
    expect(config.jwtSigningKeyPem.startsWith('signing-key-line-one')).toBe(true);
  });

  it('strips leading spaces and a trailing CRLF off a plain-env value', () => {
    const config = loadServerConfig({ ...plainEnv, RAYSPEC_API_KEY_PEPPER: `  ${PEPPER}\r\n` });
    expect(config.apiKeyPepper).toBe(PEPPER);
  });

  it('treats a whitespace-only plain-env value as empty → the aggregated missing-variable abort', () => {
    // Fail-closed, exactly as an empty value does today: a value that is nothing but whitespace is
    // not a usable secret, so the boot aborts naming the variable rather than booting on blank bytes.
    let message = '';
    try {
      loadServerConfig({ ...plainEnv, RAYSPEC_API_KEY_PEPPER: '   ' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('missing: RAYSPEC_API_KEY_PEPPER');
  });
});

describe('loadServerConfig — normalization that CHANGED a secret warns, naming the variable only', () => {
  // The operator-visible failure this guards: a secret with edge whitespace that worked before is
  // now trimmed, every request starts rejecting, and nothing says why — the cause is an invisible
  // character. The warning is the runtime signal. It names the VARIABLE the secret was resolved
  // from and the KIND of change, and NOTHING else: the value is the secret, and a warning reaches
  // every log the process writes to.
  //
  // A distinctive sentinel with edge whitespace on a MULTI-LINE value (the signing key is a PEM in
  // production). Every line is a random alphanumeric run carrying no word of English, so a window
  // of it cannot pass the leak probe below by colliding with ordinary prose in the message.
  //
  // The two sentinel CORES are drawn from DISJOINT alphabets — this one from the FIRST half of
  // each case plus the digits 0-4, the control from the SECOND half plus 5-9 — so no character of
  // the one core occurs anywhere in the other. That is what makes the counterproof below a proof:
  // with the alphabets disjoint, NO excerpt of either CORE can equal an excerpt of the other, down
  // to a SINGLE character, at any position. Disjointness is not left to inspection — the arm
  // asserts it outright before it relies on it, so editing a sentinel into an overlap fails loudly
  // instead of silently weakening the counterproof. It is a statement about the CORES, not about
  // the RAW values: both of those are wrapped in edge bytes that include a byte-order mark and end
  // in a newline, so the raw values do share those two characters — U+FEFF and LF, and nothing
  // else. The rest of the two wrappers is deliberately DIFFERENT bytes (see the control below).
  //
  // Disjointness alone only separates the VERBATIM shapes. The two sentinels are therefore also
  // made to disagree on the scalar facts a leak could report ABOUT the value instead of quoting it:
  // the raw length, how many edge bytes normalization removed and the parity of that count, the
  // parity of the core length, and whether the core holds a digit at all. Issue #138: "The warning
  // names the variable name and the kind of change (...), nothing else." A length or a count is
  // neither, so it has to be separated as much as an excerpt does. Each disequality is asserted
  // below. Wrap both sentinels in the SAME edge bytes and every fact about the trimmed-away part
  // becomes identical by construction, and so invisible to a byte-identity check — which is exactly
  // the hole these close. Digit-presence is why the control spends only the LETTERS of its
  // alphabet: its half of the digits stays unused so that one sentinel carries digits and the other
  // carries none.
  const BOM = '\uFEFF'; // U+FEFF, as an escape so the assertions below stay readable
  const LEAK_ALPHABET = 'ABCDEFGHIJKLMabcdefghijklm01234';
  const OTHER_ALPHABET = 'NOPQRSTUVWXYZnopqrstuvwxyz56789';
  const LEAK_CLEAN = [
    'iCiiJlcAgf0Mli2hjab4MKLgGc1bajJCBaBiEcHf',
    'HkcBeM4eGbgBDd4hml4fjkGe4KlEhEL0C33EJaHi',
    'EJddjgAmE24MhJmJ3j01BiA1JhIBgkkjILCddGjE',
  ].join('\n');
  // Edge whitespace on BOTH sides plus a leading byte-order mark — every kind at once. The removed
  // bytes are exactly: U+FEFF, spaces, CR, LF — seven of them, wrapped around an even-length core
  // that carries digits.
  const LEAK_RAW = `  ${BOM}${LEAK_CLEAN}  \r\n`;
  // A SECOND secret — the control for the counterproof. No shared character, a different raw
  // length, an ODD-length core, and no digit anywhere in it (letters only, still inside the
  // disjoint alphabet above). Its wrapper produces the SAME THREE KINDS of change — a leading
  // byte-order mark, leading whitespace, trailing whitespace — out of DIFFERENT bytes: U+FEFF, tab,
  // tab, LF, four of them against seven, so the count differs and so does its PARITY. Same kinds,
  // so the two messages stay comparable and the byte-identity check keeps its meaning; different in
  // each of the scalars pinned below, so none of THOSE can come out the same for both. Both halves
  // are asserted below — a future edit that breaks either one fails.
  const OTHER_CLEAN = 'yzVqRVqtxYzNtYYuNWqruXpNpzTswvXwN';
  const OTHER_RAW = `${BOM}\t${OTHER_CLEAN}\t\n`;
  /** How many bytes normalization removes from the edges of `raw` — a COUNT, never in any message. */
  const removedEdgeBytes = (raw: string): number => raw.length - raw.trim().length;
  /** Every substring of `value` of length `size` — the "any substring long enough to matter" probe. */
  function windows(value: string, size: number): string[] {
    const out: string[] = [];
    for (let i = 0; i + size <= value.length; i += 1) out.push(value.slice(i, i + size));
    return out;
  }
  /** Run a boot with a captured warning sink; returns the config (or undefined on abort) + warnings. */
  function boot(env: NodeJS.ProcessEnv): {
    config?: ReturnType<typeof loadServerConfig>;
    warnings: string[];
  } {
    const warnings: string[] = [];
    let config: ReturnType<typeof loadServerConfig> | undefined;
    try {
      config = loadServerConfig(env, (m) => warnings.push(m));
    } catch {
      // Several arms boot on an aborting env; what is under test is what was warned on the way.
    }
    return { config, warnings };
  }

  it('warns once per changed secret, naming the variable and the kinds of change', () => {
    const { config, warnings } = boot({ ...plainEnv, RAYSPEC_API_KEY_PEPPER: `  ${PEPPER}\r\n` });
    expect(config?.apiKeyPepper).toBe(PEPPER);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('RAYSPEC_API_KEY_PEPPER');
    expect(warnings[0]).toContain('leading whitespace removed');
    expect(warnings[0]).toContain('trailing whitespace removed');
  });

  it('warns for EACH of the three boot secrets, under its own variable name', () => {
    for (const name of ['DATABASE_URL', 'RAYSPEC_JWT_SIGNING_KEY', 'RAYSPEC_API_KEY_PEPPER']) {
      const { warnings } = boot({ ...plainEnv, [name]: `  ${plainEnv[name]}\n` });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(name);
    }
  });

  it('names a leading byte-order mark as its own kind of change', () => {
    const { config, warnings } = boot({
      ...plainEnv,
      RAYSPEC_JWT_SIGNING_KEY: `${BOM}${SIGNING_KEY}`,
    });
    expect(config?.jwtSigningKeyPem).toBe(SIGNING_KEY);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('byte-order mark');
  });

  it('warns for a _FILE-sourced secret too, naming the _FILE variable it was resolved from', () => {
    const { config, warnings } = boot({
      ...plainEnv,
      RAYSPEC_API_KEY_PEPPER_FILE: secretFile('warn-pepper', `${PEPPER}\n`),
    });
    expect(config?.apiKeyPepper).toBe(PEPPER);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('RAYSPEC_API_KEY_PEPPER_FILE');
    expect(warnings[0]).toContain('trailing whitespace removed');
    expect(warnings[0]).not.toContain('leading whitespace removed');
  });

  it('a CLEAN secret boots SILENTLY — from either source', () => {
    const { config: fromEnv, warnings: envWarnings } = boot({ ...plainEnv });
    expect(fromEnv?.apiKeyPepper).toBe(plainEnv.RAYSPEC_API_KEY_PEPPER);
    expect(envWarnings).toEqual([]);

    const { config: fromFile, warnings: fileWarnings } = boot({
      DATABASE_URL_FILE: secretFile('silent-db', DB_URL),
      RAYSPEC_JWT_SIGNING_KEY_FILE: secretFile('silent-key', SIGNING_KEY),
      RAYSPEC_API_KEY_PEPPER_FILE: secretFile('silent-pepper', PEPPER),
    });
    expect(fromFile?.apiKeyPepper).toBe(PEPPER);
    expect(fileWarnings).toEqual([]);
  });

  it('NO PART of the value reaches the output — the message is IDENTICAL for a different secret', () => {
    const { config, warnings } = boot({ ...plainEnv, RAYSPEC_JWT_SIGNING_KEY: LEAK_RAW });
    // The change really happened — otherwise "nothing leaked" would be free.
    expect(config?.jwtSigningKeyPem).toBe(LEAK_CLEAN);
    expect(config?.jwtSigningKeyPem).not.toBe(LEAK_RAW);
    // A multi-line value survives with its INTERIOR bytes untouched.
    expect(config?.jwtSigningKeyPem.split('\n')).toHaveLength(3);
    expect(warnings).toHaveLength(1);
    const warning = warnings[0] ?? '';
    // It really is the warning for this variable — so the assertions below are about a message that
    // was actually emitted for the leaking value.
    expect(warning).toContain('RAYSPEC_JWT_SIGNING_KEY');

    // The named shapes, pinned individually so a leak in one of them reports as itself rather than
    // as a generic mismatch.
    expect(warning).not.toContain(Buffer.from(LEAK_RAW).toString('base64')); // not encoded
    expect(warning).not.toContain(Buffer.from(LEAK_CLEAN).toString('base64'));
    expect(warning).not.toMatch(/[0-9a-f]{16,}/); // not hashed — no hex digest of any length
    expect(warning).not.toMatch(/\d/); // no length, no count, no digit at all
    // Neither the raw value, nor the normalized one, nor a single line of either.
    expect(warning).not.toContain(LEAK_RAW);
    expect(warning).not.toContain(LEAK_CLEAN);
    for (const line of LEAK_CLEAN.split('\n')) expect(warning).not.toContain(line);
    // The TRIMMED-AWAY part on its own: the removed bytes were exactly U+FEFF, spaces, CR and LF.
    // A single-line, whitespace-collapsed message carries none of them.
    expect(warning).not.toContain(BOM);
    expect(warning).not.toContain('\r');
    expect(warning).not.toContain('\n');
    expect(warning).not.toMatch(/ {2}/);
    // And no verbatim excerpt: every 4-character window of the raw value. Four is the floor at
    // which a random sentinel cannot collide with the message's fixed English vocabulary, so the
    // probe stays a leak detector rather than a source of false reds.
    for (const window of windows(LEAK_RAW, 4)) expect(warning).not.toContain(window);

    // THE general counterproof, which closes the space the enumeration above cannot: a SECOND boot,
    // same variable, same kinds of change, and the SAME message, byte for byte.
    //
    // First the properties the counterproof RESTS on, checked rather than asserted. Without them a
    // leak whose output happens to COINCIDE between the two values would keep the messages
    // identical and pass unseen — a one-character excerpt taken at a position where the two
    // sentinels agree is exactly such a leak, and so is any scalar the two sentinels reduce to the
    // same way. Pinning them here means a future edit to either sentinel cannot silently reopen
    // that hole.
    //
    // (1) VERBATIM shapes, closed by disjointness. The construction: each sentinel stays inside its
    // own alphabet, and the alphabets are disjoint.
    expect([...LEAK_CLEAN.replaceAll('\n', '')].filter((c) => !LEAK_ALPHABET.includes(c))).toEqual(
      [],
    );
    expect([...OTHER_CLEAN].filter((c) => !OTHER_ALPHABET.includes(c))).toEqual([]);
    expect([...LEAK_ALPHABET].filter((c) => OTHER_ALPHABET.includes(c))).toEqual([]);
    // The properties that follow from it, asserted on the sentinels themselves so they hold even if
    // the alphabets above are ever rewritten: no shared character, no coinciding position, and not
    // even a shared length.
    const leakChars = new Set(LEAK_CLEAN);
    expect([...OTHER_CLEAN].filter((c) => leakChars.has(c))).toEqual([]);
    expect([...OTHER_CLEAN].filter((c, i) => LEAK_CLEAN[i] === c)).toEqual([]);
    expect(OTHER_CLEAN.length).not.toBe(LEAK_CLEAN.length);

    // (2) The SCALAR facts a leak could report about the value instead of quoting it. Disjointness
    // says nothing about these: wrap the two sentinels in the same edge bytes and the removed-byte
    // count is identical by construction, invisible to the byte-identity check no matter how
    // different the values are. So the two are deliberately built to disagree on each — the raw
    // length, the count of removed edge bytes AND its parity, the parity of the core length, and
    // whether the core holds a digit.
    expect(OTHER_RAW.length).not.toBe(LEAK_RAW.length);
    expect(removedEdgeBytes(OTHER_RAW)).not.toBe(removedEdgeBytes(LEAK_RAW));
    expect(removedEdgeBytes(OTHER_RAW) % 2).not.toBe(removedEdgeBytes(LEAK_RAW) % 2);
    expect(OTHER_CLEAN.length % 2).not.toBe(LEAK_CLEAN.length % 2);
    expect(/\d/.test(OTHER_CLEAN)).not.toBe(/\d/.test(LEAK_CLEAN));

    // (3) And the property that keeps the check COMPARABLE while (1) and (2) drive the two apart:
    // both sentinels still trigger the SAME THREE KINDS of change. If they ever diverge, the two
    // messages differ for a reason that is not a leak and the control silently becomes vacuous. So
    // it is checked on the two EMITTED messages rather than on a copy of the kind derivation — a
    // divergence, whatever caused it, fails here naming the kind that went missing, before the
    // byte-identity check below can report it as a generic mismatch.
    const { warnings: otherWarnings } = boot({ ...plainEnv, RAYSPEC_JWT_SIGNING_KEY: OTHER_RAW });
    expect(otherWarnings).toHaveLength(1);
    const otherWarning = otherWarnings[0] ?? '';
    for (const kind of ['byte-order mark', 'leading whitespace', 'trailing whitespace']) {
      expect(warning).toContain(kind);
      expect(otherWarning).toContain(kind);
    }

    // WHAT THE CHECK BELOW THEN PROVES, and what it does not. It proves that the message carries no
    // excerpt of either core — any position, any length, down to a single character — and none of
    // the scalars pinned above: the raw length, the removed-edge-byte count and its parity, the
    // core length parity, digit-presence. Together with the enumerated assertions (no base64, no
    // hex digest, no digit, no verbatim removed bytes) that is the covered surface.
    //
    // CONTRACT LIMIT (honest): two sentinels cannot rule out EVERY lossy function of the value. A
    // derived fact coarse enough to land on the same output for both — a one-bit predicate collides
    // half the time by chance — would still pass. The disequalities above shrink that residue to
    // functions that agree on two values built to disagree everywhere it was practical to make them,
    // and the closed, value-free kind vocabulary in `bootSecretNormalizationWarning` is what
    // actually rules the rest out by construction. This arm is the check on that construction, not
    // a substitute for it.
    expect(otherWarning).toBe(warning);
  });

  it('emits NOTHING on the abort path — a broken mount aborts without a normalization warning', () => {
    // `readBootSecretFile` normalizes the raw bytes purely to decide EMPTINESS before its
    // fail-closed abort. That is not the trim point, so it must not warn: warning there would fire
    // on the abort path and could double-warn for the same variable.
    const { config, warnings } = boot({
      ...plainEnv,
      RAYSPEC_API_KEY_PEPPER_FILE: secretFile('warn-empty', '  \n'),
    });
    expect(config).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('a whitespace-only PLAIN value aborts as missing, without a normalization warning', () => {
    // Nothing survives normalization, so there is no secret in use to warn about — and the abort
    // already names the variable. A second message here would be noise on a failing boot.
    const { config, warnings } = boot({ ...plainEnv, RAYSPEC_API_KEY_PEPPER: '   ' });
    expect(config).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('the warning changes NO returned value — the config is byte-identical either way', () => {
    // The whole point: this is a warning, not a behaviour change. A boot with a captured sink and
    // one with none resolve exactly the same config.
    const env = {
      ...plainEnv,
      DATABASE_URL: `  ${DB_URL}\n`,
      RAYSPEC_JWT_SIGNING_KEY: `${BOM}${SIGNING_KEY}\r\n`,
      RAYSPEC_API_KEY_PEPPER: `${PEPPER}  `,
    };
    const captured = boot(env).config;
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let byDefault: ReturnType<typeof loadServerConfig> | undefined;
    let defaultSinkCalls: unknown[][] = [];
    try {
      byDefault = loadServerConfig(env);
      // Snapshot the calls BEFORE restoring — `mockRestore` also resets the recorded ones.
      defaultSinkCalls = spy.mock.calls.map((args) => [...args]);
    } finally {
      spy.mockRestore();
    }
    expect(byDefault).toEqual(captured);
    expect(byDefault?.databaseUrl).toBe(DB_URL);
    expect(byDefault?.jwtSigningKeyPem).toBe(SIGNING_KEY);
    expect(byDefault?.apiKeyPepper).toBe(PEPPER);
    // The DEFAULT sink is `console.warn` — one call per changed secret, and nothing leaked there
    // either.
    expect(defaultSinkCalls).toHaveLength(3);
    const text = defaultSinkCalls.flat().map(String).join('\n');
    for (const secret of [DB_URL, SIGNING_KEY, PEPPER]) expect(text).not.toContain(secret);
  });
});

describe('loadServerConfig — neither variant set', () => {
  it('throws the aggregated missing-variable abort listing all three PLAIN names', () => {
    let message = '';
    expect(() => {
      try {
        loadServerConfig({});
      } catch (err) {
        message = (err as Error).message;
        throw err;
      }
    }).toThrow(BootConfigError);
    expect(message).toContain(
      'missing: DATABASE_URL, RAYSPEC_JWT_SIGNING_KEY, RAYSPEC_API_KEY_PEPPER',
    );
    // and it points the operator at the file variants they may not know exist.
    expect(message).toContain('DATABASE_URL_FILE');
    expect(message).toContain('RAYSPEC_JWT_SIGNING_KEY_FILE');
    expect(message).toContain('RAYSPEC_API_KEY_PEPPER_FILE');
  });

  it('a blank _FILE with no plain variable is still the missing-variable abort, not a file error', () => {
    let message = '';
    try {
      loadServerConfig({ ...plainEnv, DATABASE_URL: '', DATABASE_URL_FILE: '  ' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('missing: DATABASE_URL');
  });
});

/**
 * The OPERATOR-PROVISIONING secret pair — `loadTenantProvisionSecrets`, which resolves only the two
 * secrets `rayspec tenant ensure` actually uses.
 *
 * It shares `resolveBootSecret` with `loadServerConfig`, so the `<VAR>_FILE` precedence, the single
 * trim contract and the fail-closed abort on a broken mount are the SAME behaviour rather than a
 * lookalike — that is what these arms pin. The load-bearing difference is what it does NOT demand:
 * `RAYSPEC_JWT_SIGNING_KEY`. The provisioning path mints no JWT, so requiring the platform signing key
 * would force a CI provisioning job to carry the one secret it never uses.
 */
describe('loadTenantProvisionSecrets — the two secrets the provisioning path uses', () => {
  it('a _FILE mount wins over the plain variable for BOTH, and the trailing newline is trimmed', () => {
    const secrets = loadTenantProvisionSecrets({
      ...plainEnv,
      DATABASE_URL_FILE: secretFile('prov-db', `${DB_URL}\n`),
      RAYSPEC_API_KEY_PEPPER_FILE: secretFile('prov-pepper', `${PEPPER}\n`),
    });
    expect(secrets.databaseUrl).toBe(DB_URL);
    expect(secrets.apiKeyPepper).toBe(PEPPER);
    // Not the plain values that were also present — the mount takes precedence outright.
    expect(secrets.databaseUrl).not.toBe(plainEnv.DATABASE_URL);
    expect(secrets.apiKeyPepper).not.toBe(plainEnv.RAYSPEC_API_KEY_PEPPER);
  });

  it('an environment with NO signing key at all still resolves — the command mints no JWT', () => {
    const secrets = loadTenantProvisionSecrets({
      DATABASE_URL: DB_URL,
      RAYSPEC_API_KEY_PEPPER: PEPPER,
    });
    expect(secrets).toEqual({ databaseUrl: DB_URL, apiKeyPepper: PEPPER });
    // The same environment is NOT enough for a server boot, which is exactly why the provisioning
    // path has its own loader rather than reusing loadServerConfig.
    expect(() =>
      loadServerConfig({ DATABASE_URL: DB_URL, RAYSPEC_API_KEY_PEPPER: PEPPER }),
    ).toThrow(/RAYSPEC_JWT_SIGNING_KEY/);
  });

  it('a non-blank _FILE naming a missing path ABORTS — it never downgrades to the plain variable', () => {
    const missing = join(dir, 'prov-absent-secret');
    let message = '';
    expect(() => {
      try {
        loadTenantProvisionSecrets({ ...plainEnv, DATABASE_URL_FILE: missing });
      } catch (err) {
        message = (err as Error).message;
        throw err;
      }
    }).toThrow(BootConfigError);
    expect(message).toContain('DATABASE_URL_FILE');
    expect(message).toContain(missing);
    expect(message).not.toContain(plainEnv.DATABASE_URL as string);
  });

  it('neither variant set: a BootConfigError naming the missing variables, not a partial result', () => {
    let message = '';
    try {
      loadTenantProvisionSecrets({});
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('RAYSPEC_API_KEY_PEPPER');
    // It must not tell an operator to set a key it will never read.
    expect(message).not.toContain('RAYSPEC_JWT_SIGNING_KEY');
  });

  it('does not leak a mounted value into the normalization warning it emits', () => {
    const warnings: string[] = [];
    const secrets = loadTenantProvisionSecrets(
      {
        DATABASE_URL_FILE: secretFile('prov-warn-db', `  ${DB_URL}  `),
        RAYSPEC_API_KEY_PEPPER: PEPPER,
      },
      (m) => warnings.push(m),
    );
    expect(secrets.databaseUrl).toBe(DB_URL);
    expect(warnings.join('\n')).toContain('DATABASE_URL_FILE');
    expect(warnings.join('\n')).not.toContain(DB_URL);
  });
});
