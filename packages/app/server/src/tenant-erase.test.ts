/**
 * `redactBootSecrets` — the last thing between a driver's error text and an operator's terminal.
 *
 * WHY THIS IS A UNIT SUITE AND NOT AN ARM ON THE DB ONE. `eraseTenantData` boots the real composition
 * root, so the natural way to reach its failure path is to point `DATABASE_URL` at a refused address.
 * That was tried, and it is a TRAP: postgres reports `connect ECONNREFUSED host:port` and nothing
 * else, so an arm asserting "the password is absent from the message" passes identically whether or
 * not the stripping happens. Removing the redaction left that arm green — which is the definition of
 * a test that proves nothing. The function is pure, so it is proven directly here, where a mutation
 * to it cannot hide.
 *
 * The fixture messages are deliberately shaped like real library output — the secret embedded in a
 * sentence, not standing alone — because a `String.includes` on a whole-value match would pass
 * against an implementation that only handled the exact-equality case.
 */
import { describe, expect, it } from 'vitest';
import type { ServerConfig } from './composition-root.js';
import { redactBootSecrets } from './tenant-erase.js';

const DB_URL = 'postgres://erase-user:erase-secret-pass@erase-host:5432/erase-db';
const PEPPER = 'tenant-erase-suite-pepper-value-never-printed';
const PEM =
  '-----BEGIN PRIVATE KEY-----\nMIItenant-erase-suite-fake-key\n-----END PRIVATE KEY-----';

/** Only the three fields the redactor reads; the rest of `ServerConfig` is irrelevant to it. */
const config = {
  databaseUrl: DB_URL,
  apiKeyPepper: PEPPER,
  jwtSigningKeyPem: PEM,
} as ServerConfig;

describe('redactBootSecrets', () => {
  it('strips the connection string, password and all, wherever a library embedded it', () => {
    const message = `connection to ${DB_URL} failed during migration; retrying against ${DB_URL}`;
    const out = redactBootSecrets(message, config);
    expect(out).not.toContain(DB_URL);
    expect(out).not.toContain('erase-secret-pass');
    // Both occurrences, not just the first — a `.replace(str, …)` with a non-global needle leaks the
    // second one, and one leak is a leak.
    expect(out).toBe(
      'connection to <DATABASE_URL> failed during migration; retrying against <DATABASE_URL>',
    );
  });

  it('strips the api-key pepper', () => {
    const out = redactBootSecrets(`hmac key rejected: ${PEPPER} (length 44)`, config);
    expect(out).not.toContain(PEPPER);
    expect(out).toContain('<RAYSPEC_API_KEY_PEPPER>');
  });

  it('strips the JWT signing key PEM', () => {
    const out = redactBootSecrets(`could not parse key material: ${PEM}`, config);
    expect(out).not.toContain(PEM);
    expect(out).not.toContain('MIItenant-erase-suite-fake-key');
    expect(out).toContain('<RAYSPEC_JWT_SIGNING_KEY>');
  });

  it('ACCEPT CONTROL — a message carrying no secret is returned unchanged', () => {
    // Without this, an implementation that returned a constant would satisfy every arm above.
    const message = 'connect ECONNREFUSED 127.0.0.1:1';
    expect(redactBootSecrets(message, config)).toBe(message);
  });
});
