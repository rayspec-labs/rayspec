/**
 * `rayspec dev gen-secrets` — mint the THREE platform boot secrets into a target `.env`, idempotently
 * and NEVER echoing a value (the load-bearing security property).
 *
 * LOCAL-DEV ONLY · MUTATING: this writes a secret file (default `./.env`, override `--out <path>`) and
 * `chmod 600`s it. It is NOT part of the read-only diagnostic floor (doctor/plan/gen-handler) — it is a
 * member of the clearly-separated, mutating `dev` group.
 *
 * The three secrets (kept on DISTINCT cryptographic chains):
 *   - RAYSPEC_JWT_SIGNING_KEY  : an RS256 private key as a PKCS#8 PEM, via node's BUILT-IN
 *     `node:crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type:
 *     'pkcs8', format: 'pem' } })`. Stored SINGLE-LINE with literal `\n` and QUOTED — the repo `.env`
 *     convention (`read-env.ts` strips the quotes + un-escapes `\n`; the platform's loaders do the
 *     same, then `jose.importPKCS8(pem, 'RS256')` accepts the resulting standard PKCS#8 PEM — verified
 *     doc-first against `packages/auth-core/src/tokens.ts`).
 *   - RAYSPEC_API_KEY_PEPPER   : `randomBytes(48).toString('base64')` (high-entropy HMAC pepper).
 *   - RAYSPEC_MEDIA_SIGNING_KEY: a DISTINCT `randomBytes(48).toString('base64')` (the HS256 media key
 *     — cryptographically separate from the RS256 chain; ≥ 32 utf8 bytes per media-token.ts).
 *
 * IDEMPOTENT / NEVER-CLOBBER: if a key is already present in the target file it is SKIPPED (never
 * overwritten); only the missing keys are appended. Output is a structured summary (which keys were
 * written vs already-present) — the secret VALUES are NEVER printed.
 *
 * NO new dependency: key/secret material comes from `node:crypto` (built-in), not `jose` (not a cli
 * dep), so `pnpm-lock.yaml` is unchanged.
 */

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DevCliError } from './errors.js';

/** The three boot secrets this command mints (DISTINCT chains — see the module doc). */
export const SECRET_KEYS = [
  'RAYSPEC_JWT_SIGNING_KEY',
  'RAYSPEC_API_KEY_PEPPER',
  'RAYSPEC_MEDIA_SIGNING_KEY',
] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

/** The default target file (relative to the CWD). */
const DEFAULT_OUT = '.env';

/** The structured result — NEVER contains a secret VALUE (only key names + a written/present status). */
export interface GenSecretsResult {
  readonly ok: boolean;
  readonly command: 'dev gen-secrets';
  /** The target path written to (an operator-chosen path — NOT a secret). */
  readonly out: string;
  /** The file mode enforced after a write (octal string). */
  readonly mode: '600';
  /** Per-key disposition. `written` = freshly minted + appended; `already-present` = left untouched. */
  readonly keys: Record<SecretKey, 'written' | 'already-present'>;
  readonly errors: { readonly code: string; readonly message: string }[];
}

/**
 * Mint an RS256 PKCS#8 PEM private key (node:crypto built-in) and collapse it to a single line with
 * literal `\n` (the repo `.env` convention). The platform un-escapes it and feeds it to
 * `jose.importPKCS8(pem, 'RS256')`, which accepts node:crypto's standard `-----BEGIN PRIVATE KEY-----`
 * PKCS#8 PEM (verified doc-first).
 */
function mintJwtSigningKeyLine(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const oneLine = privateKey.trimEnd().replace(/\n/g, '\\n');
  // QUOTED — the repo `.env` convention for the PEM (read-env.ts strips the quotes, then un-escapes).
  return `RAYSPEC_JWT_SIGNING_KEY="${oneLine}"`;
}

/** Mint one freshly-randomized line for a given key (`KEY=<base64>`). High-entropy, URL-free. */
function mintRandomLine(key: SecretKey): string {
  return `${key}=${randomBytes(48).toString('base64')}`;
}

/** Build the `KEY=value` line for a missing secret (the only place a value is materialized). */
function mintLine(key: SecretKey): string {
  return key === 'RAYSPEC_JWT_SIGNING_KEY' ? mintJwtSigningKeyLine() : mintRandomLine(key);
}

/**
 * Which of the target keys are ALREADY present in the file content. A key is "present" if any line
 * (ignoring leading whitespace, comments stripped by the caller) begins with `KEY=`. We never inspect
 * or echo the value — presence is all that gates the never-clobber behaviour.
 */
function presentKeys(content: string): Set<SecretKey> {
  const present = new Set<SecretKey>();
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if ((SECRET_KEYS as readonly string[]).includes(key)) present.add(key as SecretKey);
  }
  return present;
}

/**
 * `rayspec dev gen-secrets [--out <path>]` — mint+append the missing platform secrets, idempotently.
 * Returns a value-free summary; the caller (index.ts) emits it as JSON. Throws `DevCliError` on a
 * usage/argument problem (→ exit 2).
 */
export async function runGenSecrets(args: readonly string[]): Promise<GenSecretsResult> {
  let out: string;
  try {
    const { values } = parseArgs({
      args: [...args],
      allowPositionals: false,
      strict: true,
      options: { out: { type: 'string' } },
    });
    out = values.out ?? DEFAULT_OUT;
  } catch (e) {
    throw new DevCliError(`invalid arguments: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Operator-chosen target — resolve against the CWD (absolute paths pass through unchanged).
  const target = resolve(process.cwd(), out);

  // Single handle for the whole read-decide-append cycle — no check-then-open race. `a+` creates the
  // file when absent and opens it for reading + APPEND (every write lands at EOF regardless of any
  // position argument). An empty file (absent-just-created OR present-but-empty — indistinguishable from
  // a single open) is treated as fresh and gets the header; a file with existing content is appended to.
  const handle = await open(target, 'a+');
  try {
    const existing = await handle.readFile('utf8');
    const isFresh = existing.length === 0;
    const present = isFresh ? new Set<SecretKey>() : presentKeys(existing);

    const keys = {} as Record<SecretKey, 'written' | 'already-present'>;
    const newLines: string[] = [];
    for (const key of SECRET_KEYS) {
      if (present.has(key)) {
        keys[key] = 'already-present';
      } else {
        keys[key] = 'written';
        newLines.push(mintLine(key));
      }
    }

    if (newLines.length > 0) {
      let payload: string;
      if (isFresh) {
        const header = [
          '# RaySpec local-dev secrets — REAL secrets. chmod 600. KEEP GITIGNORED. NEVER commit.',
          '# Generated by `rayspec dev gen-secrets` (idempotent; existing keys are never overwritten).',
          '',
        ].join('\n');
        payload = `${header}${newLines.join('\n')}\n`;
      } else {
        // APPEND only the missing keys — never rewrite or reorder the operator's existing content.
        const sep = existing.endsWith('\n') ? '' : '\n';
        payload = `${sep}${newLines.join('\n')}\n`;
      }
      // O_APPEND (from the `a+` open) lands every write at EOF regardless of position — no explicit
      // offset needed (a fresh file's EOF is offset 0). Then tighten the SAME fd to owner-only.
      await handle.write(payload);
      await handle.chmod(0o600);
    }

    return {
      ok: true,
      command: 'dev gen-secrets',
      out,
      mode: '600',
      keys,
      errors: [],
    };
  } finally {
    await handle.close();
  }
}
