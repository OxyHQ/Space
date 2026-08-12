import { defineConfig } from 'drizzle-kit';
import { DATABASE_CASING } from '@oxyhq/db';

/**
 * drizzle-kit GENERATES the SQL; it never applies it. `src/db/migrate.ts` is
 * the only migrator — drizzle-kit is a devDependency and cannot be reached from
 * the production image, so a deploy that relied on `drizzle-kit migrate` would
 * have no migrator at all.
 *
 * `casing` decides what the DDL CREATES; the same value passed to
 * `createDatabase()` decides what the queries REFERENCE. Both read
 * `DATABASE_CASING` from `@oxyhq/db` so the two cannot drift apart.
 */
export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './src/drizzle',
  dialect: 'postgresql',
  casing: DATABASE_CASING,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
