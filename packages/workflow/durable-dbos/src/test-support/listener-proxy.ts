/**
 * Test-support: a TCP proxy in front of Postgres that can put the engine's notification listener in a
 * chosen state.
 *
 * DBOS keeps one pooled connection LISTENing on the workflow system database and reconnects it after an
 * outage: it checks out a client, sends the three LISTEN statements, sends a self-test NOTIFY over the
 * pool and waits up to three seconds for it to arrive, and only then publishes the client as its
 * listener. The proxy can drop that connection the way a failover or a restart of the database does,
 * and it can hold the bytes the server sends to a listener connection, so the reconnect is still in
 * flight at an exact point: after its self-test NOTIFY went out (`after: 'self-test'`) or after its
 * first LISTEN (`after: 'listen'`). It can also answer a listener's Terminate with the FATAL error a
 * server sends when it ends that session first (a failover, `DROP DATABASE … WITH (FORCE)`), which then
 * reaches the client while it closes. Byte-level, so it needs no privilege in the database and works
 * for the superuser and for the runtime role alike. Excluded from the package build.
 */
import net from 'node:net';

interface Link {
  readonly down: net.Socket;
  readonly up: net.Socket;
  listener: boolean;
  held: boolean;
  readonly pending: Buffer[];
}

export interface ListenerProxy {
  /** `url` with its host and port pointed at the proxy. */
  route(url: string): string;
  /** Connections the proxy currently carries. */
  open(): number;
  /** Connections accepted since the proxy started. */
  accepted(): number;
  /** Close every listener connection, as a failover does. */
  dropListeners(): void;
  /**
   * Hold what the server sends to the next listener connection, from the point named: once its
   * first LISTEN went out, or once the pool sent the self-test NOTIFY. Resolves when the hold starts.
   */
  holdNextListener(after: 'listen' | 'self-test'): Promise<void>;
  /** Stop holding and pass on what was held. */
  release(): void;
  /** From now on, answer a listener connection's Terminate with a FATAL error before it closes. */
  failListenersOnClose(): void;
  close(): Promise<void>;
}

/** The frontend Terminate message's type byte. */
const TERMINATE = 0x58;

/** A backend ErrorResponse: FATAL 57P01, what a session the server terminated receives. */
const ADMIN_SHUTDOWN = (() => {
  const fields = Buffer.from(
    'SFATAL\0VFATAL\0C57P01\0Mterminating connection due to administrator command\0\0',
    'latin1',
  );
  const head = Buffer.alloc(5);
  head.write('E', 0, 'latin1');
  head.writeInt32BE(fields.length + 4, 1);
  return Buffer.concat([head, fields]);
})();

export async function startListenerProxy(target: string): Promise<ListenerProxy> {
  const t = new URL(target);
  const targetHost = t.hostname;
  const targetPort = Number(t.port || 5432);
  const links = new Set<Link>();
  let accepted = 0;
  let arm: { after: 'listen' | 'self-test'; resolve: () => void } | undefined;
  let failOnClose = false;

  const hold = (link: Link) => {
    if (!arm) return;
    link.held = true;
    const { resolve } = arm;
    arm = undefined;
    resolve();
  };

  const server = net.createServer((down) => {
    accepted += 1;
    const up = net.connect(targetPort, targetHost);
    const link: Link = { down, up, listener: false, held: false, pending: [] };
    links.add(link);
    const end = () => {
      links.delete(link);
      down.destroy();
      up.destroy();
    };
    down.on('data', (chunk: Buffer) => {
      const text = chunk.toString('latin1');
      if (text.includes('LISTEN dbos_')) {
        const first = !link.listener;
        link.listener = true;
        if (first && arm?.after === 'listen') hold(link);
      }
      if (failOnClose && link.listener && chunk[0] === TERMINATE) down.write(ADMIN_SHUTDOWN);
      if (text.includes('dbos_listen_selftest') && arm?.after === 'self-test') {
        const listener = [...links].find((l) => l.listener && !l.held);
        if (listener) hold(listener);
      }
      up.write(chunk);
    });
    up.on('data', (chunk: Buffer) => {
      if (link.held) link.pending.push(chunk);
      else down.write(chunk);
    });
    down.on('end', end);
    up.on('end', end);
    down.on('error', end);
    up.on('error', end);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;

  return {
    route(url) {
      const u = new URL(url);
      u.hostname = '127.0.0.1';
      u.port = String(port);
      return u.toString();
    },
    open: () => links.size,
    accepted: () => accepted,
    dropListeners() {
      for (const link of links) {
        if (!link.listener) continue;
        links.delete(link);
        link.down.destroy();
        link.up.destroy();
      }
    },
    holdNextListener(after) {
      return new Promise<void>((resolve) => {
        arm = { after, resolve };
      });
    },
    failListenersOnClose() {
      failOnClose = true;
    },
    release() {
      for (const link of links) {
        if (!link.held) continue;
        link.held = false;
        for (const chunk of link.pending.splice(0)) link.down.write(chunk);
      }
    },
    async close() {
      for (const link of links) {
        link.down.destroy();
        link.up.destroy();
      }
      links.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
