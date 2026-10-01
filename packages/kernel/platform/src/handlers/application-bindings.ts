/**
 * The application bindings a bundle deployment grants its handlers (`init.bindings`).
 *
 * A bundle deploy reads the manifest's declared binding names and the supplied values, and hands the
 * application's own ones — every declared name that is not a provider credential — to this process
 * with `setApplicationBindings`. Each handler init then carries a reader over exactly those. One
 * process serves one deployment, so the grant is process-scoped, like the boot secrets.
 *
 * The reader refuses, by throwing, any name it was not granted: a name the bundle does not declare,
 * and a provider credential even when the bundle declares it (the platform reads those for its model
 * and speech adapters; handler code is not the component that needs them). Nothing is answered with
 * `undefined` except a declared, optional binding nobody supplied.
 */
import { registerSecretValues } from '@rayspec/core';
import type { ApplicationBindings } from '@rayspec/handler-sdk';

/** The error the reader throws for a name that is not granted. */
export class BindingNotGrantedError extends Error {
  readonly binding: string;

  constructor(binding: string, why: string) {
    super(`init.bindings.get('${binding}') was refused: ${why}`);
    this.name = 'BindingNotGrantedError';
    this.binding = binding;
  }
}

/** What a bundle deployment grants: the declared application names, and the values supplied. */
export interface ApplicationBindingGrant {
  /** Every name the bundle declares, provider credentials included (they are refused by name). */
  readonly declared: readonly string[];
  /** The provider credential names, which a handler is never given. */
  readonly providerCredentials: readonly string[];
  /** The supplied values, by name. Values for names that are not granted are ignored. */
  readonly values: ReadonlyMap<string, string>;
}

let reader: ApplicationBindings | undefined;

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Build the reader for a grant. */
export function applicationBindingsReader(grant: ApplicationBindingGrant): ApplicationBindings {
  const providers = new Set(grant.providerCredentials);
  const names = [...new Set(grant.declared)]
    .filter((n) => !providers.has(n))
    .sort(compareCodePoints);
  const granted = new Set(names);
  const values = new Map<string, string>();
  for (const name of names) {
    const value = grant.values.get(name);
    if (value !== undefined) values.set(name, value);
  }
  return Object.freeze({
    names: Object.freeze([...names]),
    get(name: string): string | undefined {
      if (providers.has(name)) {
        throw new BindingNotGrantedError(
          name,
          'it is a provider credential, which only the platform reads, for the adapter that uses it',
        );
      }
      if (!granted.has(name)) {
        throw new BindingNotGrantedError(
          name,
          'the bundle does not declare it; a value reaches a handler only when the bundle declares ' +
            'its name in the manifest bindings',
        );
      }
      return values.get(name);
    },
  });
}

/** Grant this process's handlers the application bindings of the deployment it serves. */
export function setApplicationBindings(grant: ApplicationBindingGrant | undefined): void {
  // Every supplied value, of either kind, is redacted from whatever this process writes.
  if (grant !== undefined) registerSecretValues(grant.values.values());
  reader = grant === undefined ? undefined : applicationBindingsReader(grant);
}

/** The init fragment every handler builder spreads: `{ bindings }` when granted, else nothing. */
export function applicationBindingsInit(): { bindings?: ApplicationBindings } {
  return reader === undefined ? {} : { bindings: reader };
}
