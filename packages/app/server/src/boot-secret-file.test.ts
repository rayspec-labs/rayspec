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
import { BootConfigError, loadServerConfig } from './composition-root.js';

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
