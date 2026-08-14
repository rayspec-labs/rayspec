/**
 * The port-collision boot refusal — the wording, the two entrypoint knobs, and the two-arm listener.
 *
 * `bindRefusalMessage` is pure, so the exact line an operator reads is pinned here by equality rather
 * than sampled through a boot. `attachBindRefusal` is driven with a bare EventEmitter: it registers an
 * `'error'` listener and needs nothing bound to prove which arm it takes.
 *
 * The listener has exactly two arms and both are asserted below:
 *   EADDRINUSE      → print the refusal under the caller's prefix and exit 1.
 *   anything else   → remove this listener and RE-EMIT, so the error reaches the handling it would
 *                     have reached had nothing been attached. With the listener gone, an EventEmitter
 *                     with no `'error'` listener THROWS the error — which at the top of a boot is the
 *                     `node:events` unhandled-`'error'` report Node prints today. A re-throw from
 *                     inside the listener would be a different error path, so re-emit is the arm that
 *                     leaves the non-EADDRINUSE behaviour alone.
 *
 * The actual bind is proven end-to-end, against an occupied port and the real `@hono/node-server`, in
 * packages/app/cli/src/deploy-bind-refusal.test.ts.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { attachBindRefusal, bindRefusalMessage } from './bind-refusal.js';

/** The refusal for the `rayspec-serve` bin, written out — the operator's line, not a re-derivation. */
const SERVE_REFUSAL =
  'Boot aborted — 127.0.0.1:8191 is already in use. Another process is listening on that address, ' +
  'so this boot cannot bind it: find the holder with `lsof -nP -iTCP:8191 -sTCP:LISTEN` ' +
  '(macOS/Linux) and stop it, or serve on a free port with PORT=<n> (RAYSPEC_HOST=<addr> moves the ' +
  'bind to another address). Fail-closed.';

/** The same refusal for `rayspec deploy`, whose operator has two more knobs: `--port` and `--host`. */
const DEPLOY_REFUSAL =
  'Boot aborted — 127.0.0.1:8191 is already in use. Another process is listening on that address, ' +
  'so this boot cannot bind it: find the holder with `lsof -nP -iTCP:8191 -sTCP:LISTEN` ' +
  '(macOS/Linux) and stop it, or serve on a free port with --port <n> or PORT=<n> (--host <addr> ' +
  'or RAYSPEC_HOST=<addr> moves the bind to another address). Fail-closed.';

describe('bindRefusalMessage — one wording, the knob of the entrypoint that refused', () => {
  it('names PORT for the rayspec-serve bin', () => {
    expect(bindRefusalMessage({ host: '127.0.0.1', port: 8191, prefix: '[rayspec-serve]' })).toBe(
      SERVE_REFUSAL,
    );
  });

  it('names --port (and PORT) for the rayspec deploy CLI', () => {
    expect(bindRefusalMessage({ host: '127.0.0.1', port: 8191, prefix: '[rayspec deploy]' })).toBe(
      DEPLOY_REFUSAL,
    );
  });

  it('carries the address, the remedy and a way to find the holder', () => {
    // Restated as the operator reads it, so a weakened equality above still REDs on the substance:
    // WHERE the collision is, WHO to look for, and WHAT to change.
    for (const prefix of ['[rayspec-serve]', '[rayspec deploy]'] as const) {
      const msg = bindRefusalMessage({ host: '127.0.0.1', port: 8191, prefix });
      expect(msg).toContain('127.0.0.1:8191');
      expect(msg).toContain('already in use');
      expect(msg).toContain('lsof -nP -iTCP:8191 -sTCP:LISTEN');
      expect(msg).toContain('PORT=<n>');
    }
  });

  it('brackets an IPv6 host so the address is unambiguous', () => {
    // `::1:8191` cannot be read; `[::1]:8191` can.
    expect(bindRefusalMessage({ host: '::1', port: 8191, prefix: '[rayspec-serve]' })).toContain(
      '[::1]:8191',
    );
  });
});

/** An EADDRINUSE as Node raises it for a listen, with the properties the listener may NOT read. */
function eaddrinuse(address: string, port: number): NodeJS.ErrnoException {
  return Object.assign(new Error(`listen EADDRINUSE: address already in use ${address}:${port}`), {
    code: 'EADDRINUSE',
    errno: -48,
    syscall: 'listen',
    address,
    port,
  });
}

/**
 * Emit `err` at a fresh emitter carrying the refusal for `opts`, and report what the listener did.
 *
 * The spies are recorded into LOCALS rather than asserted through the spy objects: `mockRestore()`
 * drops a spy's call record, so an `expect(spy).not.toHaveBeenCalled()` after the restore would pass
 * whatever happened — a false green on exactly the arm that must NOT print or exit.
 *
 * `errorEmits` counts the `('error', err)` calls the emitter SAW, this driver's own included. It is
 * the only reading that separates the re-emit arm from a remove-then-re-throw: both leave no listener
 * and the same error propagating out of `emit`, and only the re-emit puts a second call on the count.
 */
function drive(
  opts: Parameters<typeof bindRefusalMessage>[0],
  err: unknown,
): {
  readonly written: string[];
  readonly exitCode: number | undefined;
  readonly exits: number;
  readonly listenersLeft: number;
  readonly rethrown: unknown;
  readonly errorEmits: number;
} {
  const emitter = new EventEmitter();
  const written: string[] = [];
  let exitCode: number | undefined;
  let exits = 0;
  const errSpy = vi
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => void written.push(args.join(' ')));
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    exits += 1;
  }) as never);
  const emitSpy = vi.spyOn(emitter, 'emit');
  let rethrown: unknown;
  let errorEmits = 0;
  try {
    attachBindRefusal(emitter, opts);
    expect(emitter.listenerCount('error')).toBe(1);
    try {
      emitter.emit('error', err);
    } catch (e) {
      rethrown = e;
    }
  } finally {
    // Read the record BEFORE the restore drops it, for the same reason as the two spies above.
    errorEmits = emitSpy.mock.calls.filter((c) => c[0] === 'error' && c[1] === err).length;
    emitSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return {
    written,
    exitCode,
    exits,
    listenersLeft: emitter.listenerCount('error'),
    rethrown,
    errorEmits,
  };
}

describe('attachBindRefusal — EADDRINUSE refuses the boot', () => {
  it('prints the prefixed refusal and exits 1', () => {
    const r = drive(
      { host: '127.0.0.1', port: 8191, prefix: '[rayspec-serve]' },
      eaddrinuse('127.0.0.1', 8191),
    );
    expect(r.written).toEqual([`[rayspec-serve] ${SERVE_REFUSAL}`]);
    expect(r.exitCode).toBe(1);
    expect(r.rethrown).toBeUndefined();
    // Only this driver's own emit: the refusing arm hands the error on to nobody.
    expect(r.errorEmits).toBe(1);
  });

  it('builds the address from the RESOLVED host/port, never from the error object', () => {
    // `err.address`/`err.port` are absent on some listen errors (a `getaddrinfo ENOTFOUND` carries
    // neither), so the refusal is composed from what the entrypoint already resolved. Handing the
    // listener an error that disagrees is how that stays true: the message must follow the opts.
    const r = drive(
      { host: '127.0.0.1', port: 8191, prefix: '[rayspec-serve]' },
      eaddrinuse('10.0.0.9', 65000),
    );
    expect(r.written).toEqual([`[rayspec-serve] ${SERVE_REFUSAL}`]);
    expect(r.written[0]).not.toContain('10.0.0.9');
    expect(r.written[0]).not.toContain('65000');
  });
});

describe('attachBindRefusal — every other listen error keeps its current behaviour', () => {
  it('removes the listener and re-emits, so the error reaches the default handling', () => {
    const eacces = Object.assign(new Error('listen EACCES: permission denied 127.0.0.1:80'), {
      code: 'EACCES',
      syscall: 'listen',
    });
    const r = drive({ host: '127.0.0.1', port: 80, prefix: '[rayspec-serve]' }, eacces);
    // Two readings, because the error propagating out of `drive` proves only that the listener did not
    // SWALLOW it: a remove-then-re-throw would propagate the same error and leave the same zero
    // listeners. The second `('error', eacces)` call on the emitter is what says re-EMIT — and with no
    // listener left, an EventEmitter answers an `'error'` by throwing it, which is the default handling
    // that runs when nothing was ever attached. A re-throw arm leaves the count at 1 and REDs here.
    expect(r.errorEmits).toBe(2);
    expect(r.rethrown).toBe(eacces);
    expect(r.listenersLeft).toBe(0);
    expect(r.written).toEqual([]);
    expect(r.exits).toBe(0);
  });

  it('leaves an error with no code alone too (the arm is keyed on EADDRINUSE, not on absence)', () => {
    const bare = new Error('something the listener never planned for');
    const r = drive({ host: '127.0.0.1', port: 8191, prefix: '[rayspec deploy]' }, bare);
    expect(r.errorEmits).toBe(2);
    expect(r.rethrown).toBe(bare);
    expect(r.listenersLeft).toBe(0);
    expect(r.written).toEqual([]);
    expect(r.exits).toBe(0);
  });
});

// A source-level guard for the WIRING, in the shape serve-bind.test.ts already uses on this file: a
// unit test of the helper cannot notice a listener that was never attached, and a boot test cannot
// either (a successful bind never emits `'error'`). Assert instead, against the entrypoint source,
// that EVERY listener rayspec-serve creates gets a refusal attached — the static-profile boot and the
// normal boot alike. Deleting either call, or adding a third `serve()` without one, REDs here.
describe('serve.ts — every listener it creates carries the bind refusal', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'serve.ts'), 'utf8');
  // Strip comments so the counts read the CODE, not prose that merely names the wiring.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('attaches one attachBindRefusal per serve() call, on both boot paths', () => {
    const listeners = code.match(/=\s*serve\(/g) ?? [];
    const refusals = code.match(/attachBindRefusal\(/g) ?? [];
    expect(listeners).toHaveLength(2); // the static-profile boot + the normal boot
    expect(refusals).toHaveLength(listeners.length);
  });
});
