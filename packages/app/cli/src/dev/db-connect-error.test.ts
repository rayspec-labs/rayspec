/**
 * `rayspec dev db` — an unreachable/dead database surfaces an ACTIONABLE connect reason (no DB needed).
 *
 * The failure being guarded: postgres.js rejects with the raw Node socket error, and when the host
 * resolves to several addresses — which the DEFAULT `localhost` does (`::1` + `127.0.0.1`) — Node
 * throws an `AggregateError` whose top-level `.message` is EMPTY, with the syscall on `.code` and the
 * per-address failures in `.errors[]`. Surfacing only `.message` therefore printed a BLANK reason for
 * a dead/wrong port on the default connection URL. `describeConnectError` composes the detail from
 * `.message` / `.code` / `.errors[]` / `.cause`, still redacted by the caller.
 *
 * `describeConnectError` is unit-tested with synthetic error shapes (platform-independent), and
 * `runDevDb` is driven end-to-end against a real, momentarily-allocated-then-closed local port.
 */
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { describeConnectError, runDevDb } from './db.js';

/** Any recognizable connect signal — the syscall code or the `connect ` prefix Node emits. */
const CONNECT_SIGNAL = /E(CONN(REFUSED|RESET)?|PERM|TIMEDOUT|HOSTUNREACH)|connect/;

/** Allocate a port by binding :0, then close it — so a connect to it is refused, not hanging. */
function allocateDeadPort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => res(port));
    });
  });
}

describe('describeConnectError — composes the underlying connect detail', () => {
  it('passes a plain top-level connect message through unchanged', () => {
    const e = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5433'), {
      code: 'ECONNREFUSED',
    });
    // The code is already named in the message → not appended twice.
    expect(describeConnectError(e)).toBe('connect ECONNREFUSED 127.0.0.1:5433');
  });

  it('surfaces the code + per-address failures of an EMPTY-message AggregateError', () => {
    // The exact shape Node throws for `localhost:<dead>` — the fix's whole reason to exist. A naive
    // `e.message` reader would return '' here.
    const e = Object.assign(new Error(''), {
      name: 'AggregateError',
      code: 'ECONNREFUSED',
      errors: [
        Object.assign(new Error('connect ECONNREFUSED ::1:5433'), { code: 'ECONNREFUSED' }),
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5433'), { code: 'ECONNREFUSED' }),
      ],
    });
    const out = describeConnectError(e);
    expect(out).not.toBe('');
    expect(out).toMatch(CONNECT_SIGNAL);
    expect(out).toContain('ECONNREFUSED');
    expect(out).toContain('::1:5433');
    expect(out).toContain('127.0.0.1:5433');
  });

  it('surfaces a nested cause when the top-level message lacks the detail', () => {
    const e = Object.assign(new Error('database boot failed'), {
      cause: Object.assign(new Error('connect ETIMEDOUT 10.0.0.5:5432'), { code: 'ETIMEDOUT' }),
    });
    const out = describeConnectError(e);
    expect(out).toContain('database boot failed');
    expect(out).toContain('ETIMEDOUT');
  });

  it('returns String(e) for a non-Error throwable', () => {
    expect(describeConnectError('boom')).toBe('boom');
  });
});

describe('runDevDb — an unreachable database returns an actionable, redacted reason', () => {
  it('reports the connect failure (not a blank line) and never echoes the connection URL', async () => {
    const deadPort = await allocateDeadPort();
    const result = await runDevDb([
      '--database-url',
      // The DEFAULT host form (`localhost`) — the one that triggers the empty-message AggregateError.
      `postgres://rayspec:rayspec@localhost:${deadPort}/postgres`,
      '--name',
      'rayspec_dev_db_deadport_probe',
    ]);

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    const { code, message } = result.errors[0];
    expect(code).toBe('DB_ERROR');
    // Fail-the-fix: before the fix this message was EMPTY for `localhost` (AggregateError.message === '').
    expect(message.length).toBeGreaterThan(0);
    expect(message).toMatch(CONNECT_SIGNAL);
    // Redaction still holds — no connection string / password leaks into the summary.
    expect(message).not.toMatch(/postgres(?:ql)?:\/\//i);
    expect(message).not.toContain('rayspec:rayspec');
  });
});
