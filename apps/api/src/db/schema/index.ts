/**
 * The schema drizzle-kit reads and `createDatabase()` is typed against.
 *
 * One file per domain, each exporting its own `pgTable`s. This module only
 * aggregates them — it is what `drizzle.config.ts` points at, and what
 * `createDatabase({ schema })` needs in order to type relations, so it is a
 * required entry point rather than a convenience barrel. Nothing may be
 * declared here.
 *
 * A table that is not reachable from this file does not exist as far as
 * drizzle-kit is concerned: it will not appear in a generated migration and
 * its absence produces no error. `db:generate` is therefore always paired with
 * the table-count assertion in `src/db/__tests__/schema-census.test.ts` —
 * `drizzle-kit generate` exits 0 and leaves `drizzle/` byte-identical both when
 * there is genuinely nothing to do AND when the schema failed to load
 * entirely, and only the count tells those apart.
 */

export * from './workspaces.js';
export * from './providers.js';
