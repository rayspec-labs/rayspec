/**
 * `init.bindings`: a handler of a bundle deployment reads the application bindings its bundle
 * declares and the deploy supplied, through every handler kind's init; a name the bundle does not
 * declare, and a provider credential even when declared, is refused with an error rather than
 * answered with `undefined`. Without a grant (a YAML deployment) the field is absent.
 */
import type { TenantDb } from '@rayspec/db';
import type {
  RouteHandlerInit,
  StreamRouteHandlerInit,
  TriggerHandlerInit,
} from '@rayspec/handler-sdk';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applicationBindingsReader,
  BindingNotGrantedError,
  setApplicationBindings,
} from './application-bindings.js';
import type { ResolvedHandler } from './handler-runtime.js';
import { buildToolFactory } from './resolve-tools.js';
import {
  invokeRouteHandler,
  invokeStreamRouteHandler,
  invokeTriggerHandler,
} from './route-init.js';

const PROVIDERS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CODEX_API_KEY',
  'DEEPGRAM_API_KEY',
];

const GRANT = {
  declared: ['WEBHOOK_SIGNING_SECRET', 'OPENAI_API_KEY', 'REPORT_RECIPIENT', 'ALERT_CHANNEL'],
  providerCredentials: PROVIDERS,
  values: new Map([
    ['WEBHOOK_SIGNING_SECRET', 'whsec-canary'],
    ['OPENAI_API_KEY', 'sk-canary'],
    ['REPORT_RECIPIENT', 'ops@example.com'],
    // Supplied but never declared: ignored.
    ['UNDECLARED_TOKEN', 'never-granted'],
  ]),
};

afterEach(() => setApplicationBindings(undefined));

function refusal(read: () => unknown): BindingNotGrantedError {
  try {
    read();
  } catch (err) {
    if (err instanceof BindingNotGrantedError) return err;
    throw err;
  }
  throw new Error('the read was not refused');
}

describe('the reader', () => {
  const bindings = applicationBindingsReader(GRANT);

  it('answers a declared name with its value, and a declared optional one nobody supplied with undefined', () => {
    expect(bindings.get('WEBHOOK_SIGNING_SECRET')).toBe('whsec-canary');
    expect(bindings.get('ALERT_CHANNEL')).toBeUndefined();
    expect(bindings.names).toEqual(['ALERT_CHANNEL', 'REPORT_RECIPIENT', 'WEBHOOK_SIGNING_SECRET']);
  });

  it('refuses a name the bundle does not declare, even when a value was supplied for it', () => {
    for (const name of ['UNDECLARED_TOKEN', 'DATABASE_URL', 'RAYSPEC_API_KEY_PEPPER', 'PATH']) {
      const err = refusal(() => bindings.get(name));
      expect(err.binding).toBe(name);
      expect(err.message).toContain('does not declare');
      expect(err.message).not.toContain('never-granted');
    }
  });

  it('refuses a provider credential, declared or not: the platform reads those for its adapters', () => {
    for (const name of ['OPENAI_API_KEY', 'DEEPGRAM_API_KEY']) {
      const err = refusal(() => bindings.get(name));
      expect(err.message).toContain('provider credential');
      expect(err.message).not.toContain('sk-canary');
    }
  });

  it('cannot be widened by the handler', () => {
    expect(Object.isFrozen(bindings)).toBe(true);
    expect(Object.isFrozen(bindings.names)).toBe(true);
  });
});

/** A fake TenantDb whose transaction runs the callback on itself. */
function fakeTdb(): TenantDb {
  const handle: Record<string, unknown> = {
    tenantId: 'tenant-a',
    async transaction<R>(fn: (tx: TenantDb) => Promise<R>): Promise<R> {
      return fn(handle as unknown as TenantDb);
    },
  };
  return handle as unknown as TenantDb;
}

const NO_TABLES: ReadonlyMap<string, PgTable> = new Map();

describe('the handler inits', () => {
  it('carry the reader on every kind once a deployment granted bindings', async () => {
    setApplicationBindings(GRANT);
    let route: RouteHandlerInit | undefined;
    await invokeRouteHandler(
      async (init) => {
        route = init;
        return {};
      },
      fakeTdb(),
      NO_TABLES,
      {},
    );
    expect(route?.bindings?.get('REPORT_RECIPIENT')).toBe('ops@example.com');

    let trigger: TriggerHandlerInit | undefined;
    await invokeTriggerHandler(
      async (init) => {
        trigger = init;
      },
      fakeTdb(),
      NO_TABLES,
      'nightly',
    );
    expect(trigger?.bindings?.get('WEBHOOK_SIGNING_SECRET')).toBe('whsec-canary');

    let stream: StreamRouteHandlerInit | undefined;
    await invokeStreamRouteHandler(
      async (init) => {
        stream = init;
        return new Response(null, { status: 204 });
      },
      fakeTdb(),
      NO_TABLES,
      {},
      new Request('http://localhost/upload', { method: 'POST' }),
      () => ({}) as never,
    );
    expect(stream?.bindings?.names).toContain('WEBHOOK_SIGNING_SECRET');
    // A handler that reaches for a name it was not granted fails where it asks.
    expect(() => stream?.bindings?.get('UNDECLARED_TOKEN')).toThrow(BindingNotGrantedError);
  });

  it('carry it on a tool init too', async () => {
    setApplicationBindings(GRANT);
    let seen: string | undefined;
    const handlers = new Map<string, ResolvedHandler>([
      [
        'notify',
        {
          id: 'notify',
          kind: 'tool',
          fn: async (
            _args: unknown,
            init: { bindings?: { get(n: string): string | undefined } },
          ) => {
            seen = init.bindings?.get('REPORT_RECIPIENT');
            return {};
          },
        } as unknown as ResolvedHandler,
      ],
    ]);
    const spec = {
      tooling: [
        {
          id: 'notify',
          name: 'notify',
          description: 'notify',
          parameters: { type: 'object' },
          handler: 'notify',
          idempotent: true,
          timeoutMs: 1000,
        },
      ],
    } as never;
    const [tool] = buildToolFactory(spec, handlers, NO_TABLES, ['notify'])(fakeTdb());
    await tool?.handler({}, new AbortController().signal);
    expect(seen).toBe('ops@example.com');
  });

  it('leave the field absent when no bindings were granted', async () => {
    let route: RouteHandlerInit | undefined;
    await invokeRouteHandler(
      async (init) => {
        route = init;
        return {};
      },
      fakeTdb(),
      NO_TABLES,
      {},
    );
    expect(route !== undefined && 'bindings' in route).toBe(false);
  });
});
