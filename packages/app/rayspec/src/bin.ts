#!/usr/bin/env node
/**
 * The unscoped `rayspec` launcher.
 *
 * This is the thin bin behind `npx rayspec` and a global `npm i -g rayspec`. It does nothing but hand
 * control to the RaySpec CLI (`@rayspec/cli`): `run()` reads the process arguments, dispatches the
 * subcommand (init / doctor / plan / openapi / gen-handler / deploy / dev), sets `process.exitCode`,
 * and drains stdout before the process exits.
 *
 * All behavior lives in `@rayspec/cli`. Keeping this shim empty of logic means the bare `rayspec`
 * command and the scoped `@rayspec/cli` bin are the SAME program, argument-for-argument. Importing
 * `@rayspec/cli` does not auto-run it (its own entry guard compares the launched script path, which is
 * THIS file, not the CLI module), so the explicit `run()` call below is what starts the CLI.
 */
import { run } from '@rayspec/cli';

run();
