/**
 * The model and speech provider credentials — the platform-grantable bindings (`OPENAI_API_KEY`,
 * `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_API_KEY`, `DEEPGRAM_API_KEY`) — read in one
 * place, by name, for the one component that uses each.
 *
 * THREE SOURCES, ONE ORDER. For each name:
 *  1. a value the bundle deploy granted from its bindings file (`grantProviderCredentials`), which
 *     never passes through the process environment;
 *  2. `<NAME>_FILE`, a file the operator names in the explicit process environment — a regular file,
 *     not a link, owned by the user the runtime runs as and closed to group and others (the checks the
 *     bindings file passes). A set `_FILE` wins outright over the plain variable and never falls back
 *     to it: a file that is missing, insecure, too large or empty refuses the boot, naming the variable
 *     and the path but nothing read from the file;
 *  3. the plain `<NAME>` variable.
 * A blank value counts as unset at every step. A value read from a file or granted from a bindings
 * file is never written to the process environment, so a child process does not inherit it.
 *
 * WHO GETS WHAT. Each credential is handed only to the component that uses it, by the code that builds
 * that component: the openai and pi agent backends and the OpenAI speech adapter `OPENAI_API_KEY`, the
 * anthropic backend its two, the Deepgram adapter `DEEPGRAM_API_KEY`. A backend has exactly one
 * credential source: there is no fallback to another name, another agent's key or another tenant's.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { PLATFORM_GRANTABLE_BINDINGS } from '@rayspec/bundle-contract';
import { registerSecretValues } from '@rayspec/core';
import { BootConfigError } from './boot-config-error.js';

/** A provider credential name (reserved-bindings.json `platformGrantable`). */
export type ProviderCredentialName = (typeof PLATFORM_GRANTABLE_BINDINGS)[number]['name'];

/** The provider credential names, in the contract's order. */
export const PROVIDER_CREDENTIAL_NAMES: readonly string[] = PLATFORM_GRANTABLE_BINDINGS.map(
  (b) => b.name,
);

/** The longest credential a file may hold: a binding value's limit in the bindings file schema. */
export const MAX_CREDENTIAL_FILE_BYTES = 65_536;

/** Where a credential came from; never the value. */
export type CredentialSource = 'bindings-file' | 'file' | 'environment';

const granted = new Map<string, string>();

/**
 * A credential file that cannot be used. A `BootConfigError`, so a boot prints it message-only;
 * `insecure` tells a link, a foreign owner or an open mode (what a bundle deploy reports as
 * `RAY_BINDINGS_FILE_INSECURE`) from a file that is missing, unreadable, too large or empty.
 */
export class CredentialFileError extends BootConfigError {
  readonly insecure: boolean;

  constructor(message: string, insecure: boolean) {
    super(message);
    this.name = 'CredentialFileError';
    this.insecure = insecure;
  }
}

/** Whether `name` is a provider credential name. */
export function isProviderCredentialName(name: string): boolean {
  return PROVIDER_CREDENTIAL_NAMES.includes(name);
}

/**
 * Hand this process the provider credentials a bundle deploy read from its bindings file. They are kept
 * here, not in the process environment, and take precedence over the operator's variables. A name
 * that is not a provider credential is refused: an application binding is not the platform's to read.
 */
export function grantProviderCredentials(values: ReadonlyMap<string, string>): void {
  for (const [name, value] of values) {
    if (!isProviderCredentialName(name)) {
      throw new Error(`${name} is not a provider credential and is never read by the platform`);
    }
    if (value.trim() !== '') {
      granted.set(name, value.trim());
      registerSecretValues([value]);
    }
  }
}

/** TEST-ONLY. Forget every granted credential. */
export function resetGrantedProviderCredentialsForTests(): void {
  granted.clear();
}

function fileVariantOf(name: string): string {
  return `${name}_FILE`;
}

function uid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/**
 * Read a credential from the file a `<NAME>_FILE` variable names, refusing anything that is not a
 * private regular file of the user the runtime runs as. Messages name the variable and the path, never
 * a byte of the file. `owner` is the user the file must belong to: the runtime's own, or none where
 * the platform has no user ids.
 */
export function readCredentialFile(
  variable: string,
  path: string,
  owner: number | undefined = uid(),
): string {
  const refuse = (why: string, insecure = false) =>
    new CredentialFileError(
      `Boot aborted — ${variable} points at '${path}', which ${why}. A credential file must be a ` +
        'regular file (not a link), owned by the user the runtime runs as, and closed to group and ' +
        'others (chmod 600). Refusing to start (fail-closed) — a credential file that cannot be used ' +
        'NEVER falls back to the plain environment variable.',
      insecure,
    );
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'ELOOP' || code === 'EMLINK') throw refuse('is a symbolic link', true);
    if (code === 'ENOENT' || code === 'ENOTDIR') throw refuse('does not exist');
    throw refuse('cannot be opened');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw refuse('is not a regular file', true);
    if (owner !== undefined && stat.uid !== owner) {
      throw refuse('is not owned by the user the runtime runs as', true);
    }
    if ((stat.mode & 0o077) !== 0) {
      throw refuse('is readable or writable by group or others', true);
    }
    if (stat.size > MAX_CREDENTIAL_FILE_BYTES) {
      throw refuse(`is larger than ${MAX_CREDENTIAL_FILE_BYTES} bytes`);
    }
    const buffer = Buffer.alloc(MAX_CREDENTIAL_FILE_BYTES + 1);
    let filled = 0;
    for (;;) {
      const n = readSync(fd, buffer, filled, buffer.length - filled, null);
      if (n === 0) break;
      filled += n;
      if (filled > MAX_CREDENTIAL_FILE_BYTES) {
        throw refuse(`is larger than ${MAX_CREDENTIAL_FILE_BYTES} bytes`);
      }
    }
    const value = buffer.subarray(0, filled).toString('utf8').trim();
    if (value === '') throw refuse('is empty');
    return value;
  } finally {
    closeSync(fd);
  }
}

/** The value of one provider credential and where it came from, or `undefined` when none is set. */
export function providerCredentialWithSource(
  env: NodeJS.ProcessEnv,
  name: ProviderCredentialName,
): { value: string; source: CredentialSource } | undefined {
  const resolved = resolveCredential(env, name);
  // A credential read for use is redacted from whatever this process writes from now on.
  if (resolved !== undefined) registerSecretValues([resolved.value]);
  return resolved;
}

function resolveCredential(
  env: NodeJS.ProcessEnv,
  name: ProviderCredentialName,
): { value: string; source: CredentialSource } | undefined {
  const fromBindings = granted.get(name);
  if (fromBindings !== undefined) return { value: fromBindings, source: 'bindings-file' };
  const variable = fileVariantOf(name);
  const path = env[variable]?.trim();
  if (path) return { value: readCredentialFile(variable, path), source: 'file' };
  const plain = env[name]?.trim();
  return plain ? { value: plain, source: 'environment' } : undefined;
}

/** The value of one provider credential, or `undefined` when none is set. */
export function providerCredential(
  env: NodeJS.ProcessEnv,
  name: ProviderCredentialName,
): string | undefined {
  return providerCredentialWithSource(env, name)?.value;
}

/**
 * Whether a provider credential is supplied, without reading it: granted, or a non-blank `_FILE` or
 * plain variable. A `_FILE` that names an unusable file still counts as supplied here; reading it is
 * what refuses.
 */
export function providerCredentialSupplied(env: NodeJS.ProcessEnv, name: string): boolean {
  if (granted.has(name)) return true;
  return Boolean(env[fileVariantOf(name)]?.trim() || env[name]?.trim());
}

/** The source of each supplied provider credential, by name; no value. */
export function providerCredentialSources(
  env: NodeJS.ProcessEnv,
): Partial<Record<ProviderCredentialName, CredentialSource>> {
  const out: Partial<Record<ProviderCredentialName, CredentialSource>> = {};
  for (const name of PROVIDER_CREDENTIAL_NAMES as ProviderCredentialName[]) {
    if (granted.has(name)) out[name] = 'bindings-file';
    else if (env[fileVariantOf(name)]?.trim()) out[name] = 'file';
    else if (env[name]?.trim()) out[name] = 'environment';
  }
  return out;
}
