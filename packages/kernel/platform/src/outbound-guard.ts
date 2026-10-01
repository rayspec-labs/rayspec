/**
 * The guard on an outbound request the platform makes to a URL it did not choose itself — one taken
 * from a spec, a bundle or a request — so that such a URL cannot be used to reach this host or its
 * network (server-side request forgery).
 *
 * WHAT IS REFUSED. A destination address that is loopback, private (RFC 1918, unique-local IPv6),
 * carrier-grade NAT, link-local (which holds the cloud metadata endpoints `169.254.169.254` and
 * `169.254.170.2`), unspecified, multicast, broadcast, reserved, or a documentation or benchmarking
 * range; an IPv4 address embedded in IPv6 (mapped, NAT64, 6to4) is judged by the IPv4 address it
 * carries. A scheme other than `http:` or `https:`, and a URL that carries a user name or password,
 * are refused before any address is looked at.
 *
 * AFTER RESOLUTION, NOT BEFORE. A host name is checked on the address the connection actually uses:
 * the guard is the connection's own `lookup`, so it judges every address the resolver returns and the
 * socket connects to one of those, with no second resolution in between. A name that resolves to
 * `127.0.0.1`, or that answers a public address to a first lookup and a private one to the next (DNS
 * rebinding), is refused. An IP literal in the URL (in any form the URL parser normalizes, such as
 * `http://2130706433/`) is checked directly.
 *
 * REDIRECTS. Followed by the guard itself, at most `maxRedirects` hops, each hop checked as above, so
 * a public URL that redirects to a metadata address is refused at the redirect. A redirect to another
 * origin drops the `authorization`, `cookie` and `proxy-authorization` headers, as `fetch` does.
 *
 * NO PROXY. A guarded request connects directly, never through an environment proxy: behind a proxy
 * the guard would judge the proxy's address instead of the destination's.
 *
 * WHAT IT DOES NOT COVER. Handlers and extensions run in the runtime process and can open any
 * connection they like; this guard binds only the requests the platform itself makes through it.
 * Containing custom code is the host network policy's job.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

/** Why an outbound request was refused. */
export type OutboundRefusalReason =
  | 'scheme'
  | 'credentials-in-url'
  | 'address'
  | 'resolution'
  | 'redirect-limit';

/** An outbound request the guard refused, before anything was sent to the refused destination. */
export class OutboundRequestRefused extends Error {
  readonly reason: OutboundRefusalReason;

  constructor(reason: OutboundRefusalReason, message: string) {
    super(message);
    this.name = 'OutboundRequestRefused';
    this.reason = reason;
  }
}

/** The class of an IP address, as far as the guard is concerned. */
export type AddressClass =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'metadata'
  | 'unspecified'
  | 'multicast'
  | 'reserved';

/** The cloud metadata endpoints, named separately so a refusal says what it protected. */
const METADATA_ADDRESSES = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
  'fd00:ec2::254',
]);

/** IPv4 ranges a guarded request never reaches, with their class: [first octets, prefix, class]. */
const IPV4_RANGES: readonly [number, number, AddressClass][] = [
  [ipv4ToInt('0.0.0.0'), 8, 'unspecified'],
  [ipv4ToInt('10.0.0.0'), 8, 'private'],
  [ipv4ToInt('100.64.0.0'), 10, 'private'],
  [ipv4ToInt('127.0.0.0'), 8, 'loopback'],
  [ipv4ToInt('169.254.0.0'), 16, 'link-local'],
  [ipv4ToInt('172.16.0.0'), 12, 'private'],
  [ipv4ToInt('192.0.0.0'), 24, 'reserved'],
  [ipv4ToInt('192.0.2.0'), 24, 'reserved'],
  [ipv4ToInt('192.88.99.0'), 24, 'reserved'],
  [ipv4ToInt('192.168.0.0'), 16, 'private'],
  [ipv4ToInt('198.18.0.0'), 15, 'reserved'],
  [ipv4ToInt('198.51.100.0'), 24, 'reserved'],
  [ipv4ToInt('203.0.113.0'), 24, 'reserved'],
  [ipv4ToInt('224.0.0.0'), 4, 'multicast'],
  [ipv4ToInt('240.0.0.0'), 4, 'reserved'],
];

function ipv4ToInt(address: string): number {
  return address.split('.').reduce((n, octet) => n * 256 + Number(octet), 0);
}

function classifyIpv4(address: string): AddressClass {
  if (METADATA_ADDRESSES.has(address)) return 'metadata';
  const value = ipv4ToInt(address);
  for (const [base, prefix, kind] of IPV4_RANGES) {
    const size = 2 ** (32 - prefix);
    if (value >= base && value < base + size) return kind;
  }
  return 'public';
}

/** The eight 16-bit groups of an IPv6 address (`isIP` has already said it is one). */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  // A trailing dotted IPv4 part stands for the last two groups.
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted !== null) {
    const v4 = ipv4ToInt(dotted[2] as string);
    text = `${dotted[1]}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const fill =
    tail === undefined ? [] : new Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((g) => Number.parseInt(g, 16));
}

function embeddedIpv4(groups: readonly number[], from: number): string {
  const high = groups[from] as number;
  const low = groups[from + 1] as number;
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function classifyIpv6(address: string): AddressClass {
  const groups = ipv6Groups(address);
  const canonical = groups.map((g) => g.toString(16)).join(':');
  if (canonical === 'fd00:ec2:0:0:0:0:0:254') return 'metadata';
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const zeroToFive = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (zeroToFive && g5 === 0 && g6 === 0 && g7 === 0) return 'unspecified';
  if (zeroToFive && g5 === 0 && g6 === 0 && g7 === 1) return 'loopback';
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) addresses.
  if (zeroToFive && (g5 === 0xffff || g5 === 0)) return classifyIpv4(embeddedIpv4(groups, 6));
  // NAT64 (64:ff9b::/96) carries the IPv4 address in its last 32 bits.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return classifyIpv4(embeddedIpv4(groups, 6));
  }
  // 6to4 (2002::/16) carries it in bits 16 to 47.
  if (g0 === 0x2002) return classifyIpv4(embeddedIpv4(groups, 1));
  if ((g0 & 0xfe00) === 0xfc00) return 'private';
  if ((g0 & 0xffc0) === 0xfe80) return 'link-local';
  if ((g0 & 0xffc0) === 0xfec0) return 'private';
  if ((g0 & 0xff00) === 0xff00) return 'multicast';
  if (g0 === 0x2001 && g1 === 0x0db8) return 'reserved';
  // Teredo (2001::/32) tunnels to an address the guard cannot see.
  if (g0 === 0x2001 && g1 === 0) return 'reserved';
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return 'reserved';
  return 'public';
}

/** Classify an IP address (IPv4 or IPv6, including IPv4 embedded in IPv6). */
export function classifyAddress(address: string): AddressClass {
  const version = isIP(address.split('%')[0] as string);
  if (version === 4) return classifyIpv4(address);
  if (version === 6) return classifyIpv6(address);
  return 'reserved';
}

/** Resolve a host name to every address it has. */
export type HostResolver = (hostname: string) => Promise<LookupAddress[]>;

const systemResolver: HostResolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });

/** Options of {@link guardedFetch}. */
export interface OutboundGuardOptions {
  /** How many redirects are followed. Default 5; 0 refuses any redirect. */
  maxRedirects?: number;
  /** Ends the request, the redirects included, when it fires. */
  signal?: AbortSignal;
  /** The resolver; the operating system's by default. A test seam. */
  resolve?: HostResolver;
  /**
   * Whether an address of this class may be reached. Only `public` by default. A test seam: a test
   * that serves on loopback admits exactly that, and every other class stays refused.
   */
  admits?: (address: string, kind: AddressClass) => boolean;
}

const defaultAdmits = (_address: string, kind: AddressClass) => kind === 'public';

const CROSS_ORIGIN_DROPPED_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function refusedAddress(host: string, address: string, kind: AddressClass): OutboundRequestRefused {
  const what = host === address ? address : `${host} (${address})`;
  return new OutboundRequestRefused(
    'address',
    `the outbound request to ${what} was refused: a ${kind} address is never reached on a ` +
      'URL the platform did not choose; the destination must be a public host',
  );
}

/** Check the scheme and the user information of a URL; returns it parsed. */
function checkUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new OutboundRequestRefused('scheme', 'the outbound request URL is not an absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OutboundRequestRefused(
      'scheme',
      `the outbound request was refused: the scheme ${url.protocol} is not http: or https:`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new OutboundRequestRefused(
      'credentials-in-url',
      'the outbound request was refused: the URL carries a user name or password',
    );
  }
  return url;
}

/** The host of a URL without the brackets of an IPv6 literal. */
function bareHost(url: URL): string {
  return url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * The connection's `lookup`: resolve, judge every address, and hand the socket only addresses that
 * passed. Called once per connection, so the address judged is the address used.
 */
function guardedLookup(
  resolve: HostResolver,
  admits: NonNullable<OutboundGuardOptions['admits']>,
  onRefused: (err: OutboundRequestRefused) => void,
) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          const err = new OutboundRequestRefused(
            'resolution',
            `the outbound request was refused: ${hostname} did not resolve to any address`,
          );
          onRefused(err);
          callback(err as NodeJS.ErrnoException, '', 0);
          return;
        }
        for (const entry of addresses) {
          const kind = classifyAddress(entry.address);
          if (!admits(entry.address, kind)) {
            const err = refusedAddress(hostname, entry.address, kind);
            onRefused(err);
            callback(err as NodeJS.ErrnoException, '', 0);
            return;
          }
        }
        if (options.all === true) callback(null, addresses);
        else {
          const first = addresses[0] as LookupAddress;
          callback(null, first.address, first.family);
        }
      },
      () => {
        const refused = new OutboundRequestRefused(
          'resolution',
          `the outbound request was refused: ${hostname} could not be resolved`,
        );
        onRefused(refused);
        callback(refused as NodeJS.ErrnoException, '', 0);
      },
    );
  };
}

/** The request parts a guarded request takes. */
export interface GuardedRequestInit {
  method?: string;
  headers?: Record<string, string>;
  /** A body that can be sent again on a 307 or 308 redirect. */
  body?: string | Uint8Array;
}

/** Send one hop; resolves on the response head. */
function sendOnce(
  url: URL,
  init: GuardedRequestInit,
  options: Required<Pick<OutboundGuardOptions, 'resolve' | 'admits'>> & { signal?: AbortSignal },
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    let refusal: OutboundRequestRefused | undefined;
    const lookup = guardedLookup(options.resolve, options.admits, (err) => {
      refusal = err;
    });
    const secure = url.protocol === 'https:';
    const send = secure ? httpsRequest : httpRequest;
    // A fresh agent per hop: never the global one, which an environment proxy may have replaced.
    const agent = secure
      ? new HttpsAgent({ keepAlive: false })
      : new HttpAgent({ keepAlive: false });
    const req = send(url, {
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      agent,
      lookup: lookup as never,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    req.on('response', resolve);
    req.on('error', (err) => {
      agent.destroy();
      reject(refusal ?? err);
    });
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/**
 * Make an outbound request to a URL the platform did not choose, through the guard. Resolves with a
 * standard `Response` of the final hop; rejects with {@link OutboundRequestRefused} when a hop's
 * scheme, user information or address is refused, before anything is sent to it.
 */
export async function guardedFetch(
  input: string | URL,
  init: GuardedRequestInit = {},
  options: OutboundGuardOptions = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? 5;
  const resolve = options.resolve ?? systemResolver;
  const admits = options.admits ?? defaultAdmits;
  let url = checkUrl(input);
  let current: GuardedRequestInit = { ...init, headers: { ...(init.headers ?? {}) } };
  for (let hop = 0; ; hop++) {
    // An IP literal is never looked up, so it is judged here.
    const host = bareHost(url);
    if (isIP(host) !== 0) {
      const kind = classifyAddress(host);
      if (!admits(host, kind)) throw refusedAddress(host, host, kind);
    }
    const response = await sendOnce(url, current, {
      resolve,
      admits,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (!REDIRECT_STATUSES.has(status) || location === undefined) {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
      }
      const head = (current.method ?? 'GET').toUpperCase() === 'HEAD';
      const nullBody = status === 204 || status === 304 || head;
      if (nullBody) response.resume();
      return new Response(
        nullBody ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>),
        { status, statusText: response.statusMessage ?? '', headers },
      );
    }
    response.resume();
    if (hop >= maxRedirects) {
      throw new OutboundRequestRefused(
        'redirect-limit',
        `the outbound request was refused: more than ${maxRedirects} redirects`,
      );
    }
    const next = checkUrl(new URL(location, url));
    const method = (current.method ?? 'GET').toUpperCase();
    let nextInit: GuardedRequestInit;
    if (status === 307 || status === 308) {
      nextInit = { ...current };
    } else {
      // 301, 302 and 303 turn a request with a body into a GET without one, as fetch does.
      const keep = method === 'GET' || method === 'HEAD';
      const headers = { ...(current.headers ?? {}) };
      for (const name of Object.keys(headers)) {
        const lower = name.toLowerCase();
        if (lower === 'content-type' || lower === 'content-length') delete headers[name];
      }
      nextInit = { method: keep ? method : 'GET', headers };
    }
    if (next.origin !== url.origin) {
      const headers = { ...(nextInit.headers ?? {}) };
      for (const name of Object.keys(headers)) {
        if (CROSS_ORIGIN_DROPPED_HEADERS.includes(name.toLowerCase())) delete headers[name];
      }
      nextInit = { ...nextInit, headers };
    }
    url = next;
    current = nextInit;
  }
}
