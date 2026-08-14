/**
 * The port-collision boot refusal, in a LEAF module (it imports nothing).
 *
 * WHY A LISTENER AND NOT A `try`/`catch`. `serve()` (@hono/node-server) returns while the bind is
 * still PENDING — immediately after the call the listener's `listening` is false and its `address()`
 * is null — so a taken port never reaches the call site as a thrown error. It arrives a tick later as
 * an `'error'` event, and with nothing listening for it Node's default handling prints the raw
 * `node:events` unhandled-`'error'` report and exits 1. That is why a port collision was the one boot
 * failure this product did not refuse in the deliberate one-line form every other one uses — and why
 * the fix has to be an `'error'` listener registered by the entrypoint that resolved the address.
 *
 * The message is built HERE, by a pure function, so the line an operator reads is unit-testable
 * without binding anything (the same reason the composition root keeps its longer refusals as
 * standalone constants).
 */

/**
 * The entrypoints that can refuse a bind, named by the prefix each already stamps on its own lines.
 * A CLOSED union rather than a free string: the remedy below names the knob THAT entrypoint's
 * operator turns, and an entrypoint left out of the table would otherwise silently inherit another
 * one's knob — the compiler refuses the call instead.
 */
export type BindRefusalPrefix = '[rayspec-serve]' | '[rayspec deploy]';

/** The address an entrypoint RESOLVED for its listener, plus which entrypoint is refusing. */
export interface BindRefusalOpts {
  /** The resolved listen host (`config.host` — RAYSPEC_HOST, else the loopback default). */
  readonly host: string;
  /** The resolved listen port (`config.port` — PORT / `--port`, else the default). */
  readonly port: number;
  readonly prefix: BindRefusalPrefix;
}

/**
 * How each entrypoint's operator moves the bind. `rayspec deploy --port` WRITES `process.env.PORT`
 * (and `--host` writes `RAYSPEC_HOST`), so on that path both spellings are true and both are offered.
 */
const MOVE_THE_BIND: Record<BindRefusalPrefix, string> = {
  '[rayspec-serve]': 'PORT=<n> (RAYSPEC_HOST=<addr> moves the bind to another address)',
  '[rayspec deploy]':
    '--port <n> or PORT=<n> (--host <addr> or RAYSPEC_HOST=<addr> moves the bind to another address)',
};

/**
 * The refusal line for a listen address that is already taken: WHERE the collision is, HOW to find
 * the process holding it, and WHAT to change.
 *
 * Composed from the RESOLVED host/port the entrypoint already holds, never from the error object: a
 * listen error carries `address`/`port` for some codes only (a `getaddrinfo ENOTFOUND` carries
 * neither), and a refusal naming `undefined:undefined` would be worse than the stack it replaces.
 */
export function bindRefusalMessage(opts: BindRefusalOpts): string {
  // An IPv6 literal is bracketed so the address can be read at all (`::1:8080` cannot be).
  const address = opts.host.includes(':')
    ? `[${opts.host}]:${opts.port}`
    : `${opts.host}:${opts.port}`;
  return (
    `Boot aborted — ${address} is already in use. Another process is listening on that address, so ` +
    `this boot cannot bind it: find the holder with \`lsof -nP -iTCP:${opts.port} -sTCP:LISTEN\` ` +
    `(macOS/Linux) and stop it, or serve on a free port with ${MOVE_THE_BIND[opts.prefix]}. ` +
    'Fail-closed.'
  );
}

/**
 * The `'error'`-event surface `attachBindRefusal` needs, typed structurally so this module imports
 * nothing. `serve()` returns `Server | Http2Server | Http2SecureServer`; all three satisfy it.
 */
export interface BindErrorEmitter {
  on(event: 'error', listener: (err: NodeJS.ErrnoException) => void): unknown;
  removeListener(event: 'error', listener: (err: NodeJS.ErrnoException) => void): unknown;
  emit(event: 'error', err: unknown): unknown;
}

/**
 * Refuse the boot when `httpServer` cannot take the address it was given. Call it IMMEDIATELY after
 * `serve()` returns: that return is in the same synchronous block, and the bind error is emitted on a
 * later tick, so the listener is always registered before it can fire.
 *
 * EADDRINUSE prints the refusal and exits 1. EVERY OTHER code keeps the behaviour it has today: this
 * listener removes ITSELF and RE-EMITS, so the error continues to whatever would have handled it had
 * nothing been attached — at a boot, nothing is, and Node's default `'error'` handling prints its
 * unhandled-`'error'` report and exits 1. Re-emitting rather than re-throwing is what preserves that
 * report: a throw from inside a listener is reported as a plain exception at the throw site instead,
 * losing both the `node:events` header and the `Emitted 'error' event on Server instance at:` section.
 */
export function attachBindRefusal(httpServer: BindErrorEmitter, opts: BindRefusalOpts): void {
  const onError = (err: NodeJS.ErrnoException): void => {
    if (err.code === 'EADDRINUSE') {
      console.error(`${opts.prefix} ${bindRefusalMessage(opts)}`);
      process.exit(1);
      return; // unreachable in production; keeps a test that stubs process.exit from re-emitting on.
    }
    // Not ours. Remove FIRST — the re-emit would otherwise re-enter this listener.
    httpServer.removeListener('error', onError);
    httpServer.emit('error', err);
  };
  httpServer.on('error', onError);
}
