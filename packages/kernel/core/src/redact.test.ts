/**
 * The one redaction path: registered values wherever they occur, and the shapes of a credential
 * whoever holds it; a JSON value at any depth; and the write path of a stream.
 */
import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installOutputRedaction,
  MIN_REGISTERED_LENGTH,
  REDACTED,
  redactText,
  redactValue,
  registerSecretValues,
  resetRegisteredSecretsForTests,
} from './redact.js';

afterEach(() => resetRegisteredSecretsForTests());

describe('registered values', () => {
  it('are replaced wherever they occur, the longest first', () => {
    registerSecretValues(['canary-value-123', 'canary-value-123-and-more']);
    expect(redactText('a canary-value-123-and-more b canary-value-123 c')).toBe(
      `a ${REDACTED} b ${REDACTED} c`,
    );
  });

  it('are trimmed when registered, and blank, missing or short values are ignored', () => {
    registerSecretValues(['  padded-canary-value\n', '', undefined, null, 'short']);
    expect(redactText('x padded-canary-value y')).toBe(`x ${REDACTED} y`);
    expect('short'.length).toBeLessThan(MIN_REGISTERED_LENGTH);
    expect(redactText('a short word')).toBe('a short word');
  });

  it('register a multi-line value line by line, so one line of it is redacted too', () => {
    const pem = [
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7',
      'second-line-of-the-key-material-0123456789',
      '-----END PRIVATE KEY-----',
    ].join('\n');
    registerSecretValues([pem]);
    expect(redactText('line: second-line-of-the-key-material-0123456789')).toBe(
      `line: ${REDACTED}`,
    );
  });
});

describe('credential shapes', () => {
  it.each([
    ['a bearer token', 'Authorization: Bearer abc.def.ghi', 'abc.def'],
    ['a bearer token in prose', 'sent bearer eyJ0eXAiOiJK.something', 'eyJ0eXAiOiJK'],
    ['a cookie header', 'cookie: sid=12345; theme=dark', 'sid=12345'],
    ['a set-cookie header', 'Set-Cookie: __Host-rayspec_refresh=s3cr3t; Path=/', 's3cr3t'],
    ['an x-api-key header', 'x-api-key: rk_abc.deadbeef', 'deadbeef'],
    ['a JSON authorization header', '{"authorization":"Basic dXNlcjpwYXNz"}', 'dXNlcjpwYXNz'],
    ['a URL password', 'postgres://app:hunter2-secret@db.internal:5432/app', 'hunter2-secret'],
    ['a JSON web token', 'token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl', 'c2lnbmF0dXJl'],
    ['a RaySpec API key', 'key rk_AbCdEf.0123456789abcdefghijklmnop used', '0123456789abcdefghij'],
    ['a provider key', 'OPENAI said sk-proj-0123456789abcdefABCDEF', '0123456789abcdef'],
    [
      'a PEM private key',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA',
    ],
  ])('%s', (_what, text, secret) => {
    const out = redactText(text);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it('leaves ordinary text alone', () => {
    const line = '[api-auth] 5xx status=500 requestId=abc code=INTERNAL: the database refused';
    expect(redactText(line)).toBe(line);
  });

  it('keeps the header name and the user name, and redacts only the value', () => {
    expect(redactText('Authorization: Bearer abc')).toBe(`Authorization: ${REDACTED}`);
    expect(redactText('postgres://app:pw-123@db/x')).toBe(`postgres://app:${REDACTED}@db/x`);
  });
});

describe('redactValue', () => {
  it('redacts every string at any depth, and the value of a secret-named property', () => {
    registerSecretValues(['nested-canary-value']);
    const input = {
      message: 'failed with nested-canary-value',
      headers: { authorization: 'Bearer abc', accept: 'application/json' },
      list: ['ok', { password: 'p', token: 'tkn-value', tokens: 12 }],
    };
    expect(redactValue(input)).toEqual({
      message: `failed with ${REDACTED}`,
      headers: { authorization: REDACTED, accept: 'application/json' },
      list: ['ok', { password: REDACTED, token: REDACTED, tokens: 12 }],
    });
    // The input is not changed.
    expect(input.headers.authorization).toBe('Bearer abc');
  });

  it('replaces a cycle instead of following it', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(redactValue(a)).toEqual({ name: 'a', self: REDACTED });
  });
});

describe('installOutputRedaction', () => {
  it('redacts every write to the stream, string or bytes, whoever writes it', () => {
    registerSecretValues(['stream-canary-value']);
    const written: Buffer[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        written.push(Buffer.from(chunk));
        callback();
      },
    });
    installOutputRedaction([stream]);
    installOutputRedaction([stream]); // idempotent
    const log = new Console({ stdout: stream, stderr: stream });
    log.log('value: stream-canary-value');
    log.error(new Error('Authorization: Bearer zzz'));
    stream.write(Buffer.from('bytes stream-canary-value'));
    const text = Buffer.concat(written).toString('utf8');
    expect(text).not.toContain('stream-canary-value');
    expect(text).not.toContain('zzz');
    expect(text).toContain(REDACTED);
  });
});
