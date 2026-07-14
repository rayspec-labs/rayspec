/**
 * Minimal .env parsing for the api-auth test setup (no dotenv dependency in the runtime path).
 *
 * `vitest.setup.ts` loads the repo-root .env so DATABASE_URL etc. reach the DB-backed suites. Real
 * .env values are commonly wrapped in quotes (`DATABASE_URL="postgres://…"`); a naive trim-only parse
 * would assign the literal-WITH-quotes and postgres.js then throws `Invalid URL`. These pure helpers
 * strip a matching surrounding quote pair, so a quoted value loads identically to an unquoted one.
 */

/**
 * Strip a MATCHING surrounding pair of single or double quotes from an (already-trimmed) .env value.
 * An unquoted value, an unterminated quote (`"abc`), a lone quote, or a mismatched pair (`"a'`) is
 * returned unchanged.
 */
export function dequoteEnvValue(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && last === first) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Parse .env file CONTENT into KEY/VALUE pairs (in file order), skipping blank / comment / malformed
 * (`no '='` or `'=' at index 0`) lines and dequoting each value. Pure — no filesystem, no process.env
 * mutation — so the caller owns the do-not-overwrite-existing policy and a unit test can drive it with
 * a synthetic string.
 */
export function parseDotenv(content: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    pairs.push([key, dequoteEnvValue(trimmed.slice(eq + 1).trim())]);
  }
  return pairs;
}
