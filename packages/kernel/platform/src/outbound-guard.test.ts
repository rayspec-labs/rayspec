/**
 * The outbound guard against real sockets: a local server stands in for every destination, and each
 * refusal is proven by the server never seeing the request. Loopback is admitted only where a test
 * says so (the `admits` seam), and only for the exact address `127.0.0.1`, so every other class stays
 * refused in every test.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AddressClass,
  classifyAddress,
  guardedFetch,
  type HostResolver,
  OutboundRequestRefused,
} from './outbound-guard.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

interface Seen {
  url: string;
  headers: IncomingMessage['headers'];
}

async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ base: string; port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, port, seen };
}

const ok = (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('reached');
};

/** The seam that admits exactly the loopback address the test servers listen on. */
const testServerOnly = (address: string, kind: AddressClass) =>
  kind === 'public' || address === '127.0.0.1';

/** A resolver that answers from a table, counting its calls. */
function table(answers: Record<string, string[] | (() => string[])>): HostResolver & {
  calls: string[];
} {
  const calls: string[] = [];
  const resolve = async (hostname: string) => {
    calls.push(hostname);
    const entry = answers[hostname];
    if (entry === undefined) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    const addresses = typeof entry === 'function' ? entry() : entry;
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return Object.assign(resolve, { calls });
}

async function refusal(promise: Promise<unknown>): Promise<OutboundRequestRefused> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof OutboundRequestRefused) return err;
    throw err;
  }
  throw new Error('the request was not refused');
}

describe('classifyAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'private'],
    ['169.254.169.254', 'metadata'],
    ['169.254.170.2', 'metadata'],
    ['100.100.100.200', 'metadata'],
    ['169.254.1.1', 'link-local'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['192.0.2.10', 'reserved'],
    ['172.32.0.1', 'public'],
    ['8.8.8.8', 'public'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:169.254.169.254', 'metadata'],
    ['::ffff:10.0.0.1', 'private'],
    ['64:ff9b::a9fe:a9fe', 'metadata'],
    ['2002:7f00:1::', 'loopback'],
    ['fc00::1', 'private'],
    ['fd12:3456::1', 'private'],
    ['fd00:ec2::254', 'metadata'],
    ['fe80::1', 'link-local'],
    ['fe80::1%lo0', 'link-local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'reserved'],
    ['2001:0:4136:e378::1', 'reserved'],
    // IPv4-translated: judged by the IPv4 address it carries.
    ['::ffff:0:127.0.0.1', 'loopback'],
    ['::ffff:0:a9fe:a9fe', 'metadata'],
    ['::ffff:0:10.0.0.1', 'private'],
    ['::ffff:0:8.8.8.8', 'public'],
    // The local-use NAT64 prefix: where it carries the IPv4 address is the operator's choice.
    ['64:ff9b:1::a9fe:a9fe', 'reserved'],
    ['64:ff9b:1::808:808', 'reserved'],
    // Benchmarking, the newer documentation prefix, and the rest of the protocol assignments.
    ['2001:2::1', 'reserved'],
    ['2001:10::1', 'reserved'],
    ['3fff::1', 'reserved'],
    ['3fff:fff:ffff::1', 'reserved'],
    ['3fff:1000::1', 'public'],
    // Outside global unicast.
    ['100::1', 'reserved'],
    ['5f00::1', 'reserved'],
    ['4000::1', 'reserved'],
    ['2001:200::1', 'public'],
    ['2606:4700:4700::1111', 'public'],
    ['not-an-address', 'reserved'],
  ])('%s is %s', (address, kind) => {
    expect(classifyAddress(address)).toBe(kind);
  });
});

describe('guardedFetch: what it refuses before connecting', () => {
  it.each([
    ['http://127.0.0.1:PORT/', 'loopback'],
    ['http://2130706433:PORT/', 'loopback'],
    ['http://0x7f.1:PORT/', 'loopback'],
    ['http://[::1]:PORT/', 'loopback'],
    ['http://[::ffff:127.0.0.1]:PORT/', 'loopback'],
    ['http://169.254.169.254/latest/meta-data/', 'metadata'],
    ['http://[fd00:ec2::254]/latest/meta-data/', 'metadata'],
    ['http://10.0.0.1/', 'private'],
    ['http://0.0.0.0:PORT/', 'unspecified'],
    ['http://[::ffff:0:a9fe:a9fe]/latest/meta-data/', 'metadata'],
    ['http://[64:ff9b:1::a9fe:a9fe]/latest/meta-data/', 'reserved'],
  ])('an IP literal: %s', async (template, kind) => {
    const target = await serve(ok);
    const err = await refusal(guardedFetch(template.replace('PORT', String(target.port))));
    expect(err.reason).toBe('address');
    expect(err.message).toContain(`a ${kind} address`);
    expect(target.seen).toEqual([]);
  });

  it('a name that resolves to 127.0.0.1, with the operating system resolver (localhost)', async () => {
    const target = await serve(ok);
    const err = await refusal(guardedFetch(`http://localhost:${target.port}/`));
    expect(err.reason).toBe('address');
    expect(err.message).toMatch(/localhost \((127\.0\.0\.1|::1)\)/);
    expect(target.seen).toEqual([]);
  });

  it('a public-looking name that resolves to 127.0.0.1', async () => {
    const target = await serve(ok);
    const resolve = table({ 'hooks.customer.example': ['127.0.0.1'] });
    const err = await refusal(
      guardedFetch(`http://hooks.customer.example:${target.port}/`, {}, { resolve }),
    );
    expect(err.reason).toBe('address');
    expect(err.message).toContain('hooks.customer.example (127.0.0.1)');
    expect(err.message).toContain('a loopback address');
    expect(target.seen).toEqual([]);
  });

  it('a name with one public and one private answer', async () => {
    const resolve = table({ 'mixed.example': ['93.184.216.34', '10.0.0.7'] });
    const err = await refusal(guardedFetch('http://mixed.example/', {}, { resolve }));
    expect(err.message).toContain('mixed.example (10.0.0.7)');
  });

  it('a name that does not resolve', async () => {
    const resolve = table({});
    const err = await refusal(guardedFetch('http://nowhere.example/', {}, { resolve }));
    expect(err.reason).toBe('resolution');
  });

  it.each([
    ['file:///etc/passwd', 'scheme'],
    ['ftp://files.example/x', 'scheme'],
    ['gopher://127.0.0.1:70/', 'scheme'],
    ['not a url', 'scheme'],
    ['http://user:secret@api.example/', 'credentials-in-url'],
  ])('%s (%s)', async (url, reason) => {
    const err = await refusal(guardedFetch(url));
    expect(err.reason).toBe(reason);
    expect(err.message).not.toContain('secret');
  });
});

describe('guardedFetch: the address judged is the address used', () => {
  it('connects to the address the guard admitted, resolving once per hop', async () => {
    const target = await serve(ok);
    const resolve = table({ 'app.customer.example': ['127.0.0.1'] });
    const res = await guardedFetch(
      `http://app.customer.example:${target.port}/hello`,
      {},
      { resolve, admits: testServerOnly },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('reached');
    expect(resolve.calls).toEqual(['app.customer.example']);
    expect(target.seen.map((s) => [s.url, s.headers.host])).toEqual([
      ['/hello', `app.customer.example:${target.port}`],
    ]);
  });

  it('refuses a name that answers an admitted address first and a private one next (rebinding)', async () => {
    const target = await serve(ok);
    let answer = '127.0.0.1';
    const resolve = table({ 'rebind.example': () => [answer] });
    const first = await guardedFetch(
      `http://rebind.example:${target.port}/`,
      {},
      { resolve, admits: testServerOnly },
    );
    expect(first.status).toBe(200);
    await first.text();
    answer = '10.0.0.9';
    const err = await refusal(
      guardedFetch(
        `http://rebind.example:${target.port}/`,
        {},
        { resolve, admits: testServerOnly },
      ),
    );
    expect(err.message).toContain('rebind.example (10.0.0.9)');
    expect(target.seen).toHaveLength(1);
  });
});

describe('guardedFetch: redirects', () => {
  it('refuses a redirect to the metadata address, after the first hop answered', async () => {
    const start = await serve((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/iam/' });
      res.end();
    });
    const err = await refusal(guardedFetch(`${start.base}/hook`, {}, { admits: testServerOnly }));
    expect(err.reason).toBe('address');
    expect(err.message).toContain('a metadata address');
    expect(start.seen).toHaveLength(1);
  });

  it('refuses a redirect to a name that resolves to the metadata address', async () => {
    const start = await serve((_req, res) => {
      res.writeHead(307, { location: 'http://instance-data.example/latest/meta-data/' });
      res.end();
    });
    const resolve = table({ 'instance-data.example': ['169.254.169.254'] });
    const err = await refusal(
      guardedFetch(`${start.base}/hook`, {}, { resolve, admits: testServerOnly }),
    );
    expect(err.message).toContain('instance-data.example (169.254.169.254)');
  });

  it('refuses a redirect to loopback on another port, and to a file: URL', async () => {
    const victim = await serve(ok);
    const toLocalhost = await serve((_req, res) => {
      res.writeHead(301, { location: `http://localhost:${victim.port}/admin` });
      res.end();
    });
    const err = await refusal(
      guardedFetch(
        toLocalhost.base,
        {},
        {
          admits: (address, kind) => kind === 'public' || address === '127.0.0.1',
          resolve: table({ localhost: ['::1'] }),
        },
      ),
    );
    expect(err.message).toContain('a loopback address');
    expect(victim.seen).toEqual([]);

    const toFile = await serve((_req, res) => {
      res.writeHead(302, { location: 'file:///etc/passwd' });
      res.end();
    });
    expect((await refusal(guardedFetch(toFile.base, {}, { admits: testServerOnly }))).reason).toBe(
      'scheme',
    );
  });

  it('follows a redirect to an admitted host, and drops the credentials across origins', async () => {
    const end = await serve(ok);
    const start = await serve((_req, res) => {
      res.writeHead(303, { location: `${end.base}/landing` });
      res.end();
    });
    const res = await guardedFetch(
      `${start.base}/begin`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer abc',
          cookie: 'sid=1',
          'content-type': 'application/json',
          'x-trace': 'kept',
        },
        body: '{}',
      },
      { admits: testServerOnly },
    );
    expect(res.status).toBe(200);
    expect(start.seen[0]?.headers.authorization).toBe('Bearer abc');
    const landed = end.seen[0];
    expect(landed?.url).toBe('/landing');
    expect(landed?.headers.authorization).toBeUndefined();
    expect(landed?.headers.cookie).toBeUndefined();
    expect(landed?.headers['content-type']).toBeUndefined();
    expect(landed?.headers['x-trace']).toBe('kept');
  });

  it('stops after the redirect limit', async () => {
    const loop = await serve((req, res) => {
      res.writeHead(302, { location: `${req.url}x` });
      res.end();
    });
    const err = await refusal(
      guardedFetch(`${loop.base}/`, {}, { admits: testServerOnly, maxRedirects: 2 }),
    );
    expect(err.reason).toBe('redirect-limit');
    expect(loop.seen).toHaveLength(3);
  });
});
