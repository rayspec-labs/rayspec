/**
 * The part of `semver` the resolver uses. The package ships no type declarations of its own.
 */
declare module 'semver' {
  interface Options {
    loose?: boolean;
    includePrerelease?: boolean;
  }
  const semver: {
    validRange(range: string, options?: Options): string | null;
    satisfies(version: string, range: string, options?: Options): boolean;
  };
  export default semver;
}
