/**
 * The application's own bindings, as a handler reads them.
 *
 * A bundle declares the names of the values its application needs (`bindings` in the manifest); the
 * operator or customer supplies the values at deploy time. `init.bindings` hands a handler exactly
 * those: a name the bundle declares that is not a provider credential. Asking for any other name — one
 * the bundle does not declare, a provider credential the platform reads for its model and speech
 * adapters, a platform setting — is refused with an error, never answered with `undefined`, so a
 * handler that reaches for a value it was not granted fails where it asks.
 *
 * The values never enter the process environment on a bundle deployment, so they do not reach a child
 * process or code that enumerates the environment. This is not a sandbox: handler code runs in the
 * runtime process.
 */
export interface ApplicationBindings {
  /**
   * The value of a binding the bundle declares, or `undefined` when an optional one was not supplied.
   * Throws a {@link BindingNotGrantedError} for a name the bundle does not declare, and for a provider
   * credential.
   */
  get(name: string): string | undefined;
  /** The names the bundle declares, in code-point order (provider credentials excluded). */
  readonly names: readonly string[];
}

/**
 * The error `ApplicationBindings.get` throws for a name that is not granted. A TYPE, like
 * `TtsAdapterError`: test `err.name === 'BindingNotGrantedError'`, and read `binding` for the name.
 */
export interface BindingNotGrantedError extends Error {
  readonly name: 'BindingNotGrantedError';
  /** The name that was asked for. */
  readonly binding: string;
}
