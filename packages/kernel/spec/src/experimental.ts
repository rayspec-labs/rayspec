/**
 * The ONE shared derivation from environment to `ParseSpecOptions` — every entry point (doctor,
 * plan, deploy, the server boot) calls this instead of hand-reading the variable, so the
 * truthiness rule cannot drift between surfaces. PURE over an env RECORD: this package reads no
 * process state; callers pass `process.env` (or their injected env argument).
 */
import type { ParseSpecOptions } from './parse.js';

export const WORKFORCE_EXPERIMENT_ENV = 'RAYSPEC_EXPERIMENTAL_WORKFORCE';

/** The accepted truthy spellings, trimmed and case-insensitive; anything else is OFF. */
const TRUTHY = new Set(['1', 'true', 'yes']);

export function experimentalSpecOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ParseSpecOptions {
  const raw = env[WORKFORCE_EXPERIMENT_ENV];
  const enabled = raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
  return enabled ? { experimentalWorkforce: true } : {};
}
