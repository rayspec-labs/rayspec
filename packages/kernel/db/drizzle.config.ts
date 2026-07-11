import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// Drizzle Kit config. Schema-as-TS-code -> SQL migrations under ./drizzle.
// The home-grown migration gate (migration-scan + shadow-dryrun) is THE destructive policy; Atlas is
// deferred. The generated PRODUCT-schema module is listed alongside the core
// schema so `drizzle-kit generate` diffs BOTH (the cross-check half of the diff step). The
// platform main line ships a PRODUCT-EMPTY generated module (zero tables -> no platform migration);
// a deployment populates its OWN generated module and diffs it here.
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/schema.ts', './src/generated/product-schema.ts'],
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://rayspec:rayspec@localhost:5433/rayspec',
  },
  strict: true,
  verbose: true,
});
