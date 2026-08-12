/**
 * The ONLY thing that applies migrations for this service.
 *
 *   bun run db:migrate -- --target-database=<name> --phase=pre|post|all
 *
 * Never `drizzle-kit migrate`: drizzle-kit is a devDependency and is not
 * installed in the production image (`bun install --production`), so a deploy
 * that relied on it would have no migrator at all.
 *
 * ## Runs under `node`, not just `bun`
 *
 * The runtime image is `node:22-bookworm-slim` and this package is
 * `"type": "module"`, so `__dirname` is not defined here and would throw at
 * IMPORT time — before a single statement runs, and invisible to every local
 * gate, because every local path goes through bun, which shims it. Paths come
 * from `fileURLToPath(import.meta.url)` for that reason. `tsc` accepts either,
 * since `@types/node` declares `__dirname` globally; only executing the built
 * artefact under `node` tells the two apart.
 *
 * ## Phases
 *
 * Every generated `.sql` carries exactly one `-- oxy:deploy-phase=pre`
 * (additive) or `-- oxy:deploy-phase=post` (drops, renames, narrows) marker.
 * There is no default: the migrator refuses a file that does not say which side
 * of a rollout it belongs to, because guessing wrong takes production down in
 * the direction that is hardest to reverse.
 *
 * `--phase=all` is for a journal whose phases cannot be applied in order — a
 * queued `pre` sitting behind an unapplied `post`. It is NOT "the mode you use
 * starting from zero": a from-zero genesis marked `pre` is applied by the
 * ordinary push-triggered step.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIGRATION_RUNS,
  type MigrationRun,
  readTargetDatabase,
  runMigrations,
} from '@oxyhq/db/migrate';
import { log } from '../lib/logger.js';

/**
 * Locate the generated migrations folder — ONE candidate, never a search.
 *
 * `drizzle.config.ts` writes to `src/drizzle` and `build.ts` copies it to
 * `dist/drizzle`, so the folder always sits beside this module's parent:
 * `src/db/migrate.ts` finds `src/drizzle`, `dist/db/migrate.js` finds
 * `dist/drizzle`. One rule, identical in both layouts.
 *
 * That parity is the whole point, and it was not the first design. Searching
 * two candidates — package-root `drizzle/` and `dist/drizzle` — is ambiguous in
 * the development tree, where BOTH exist, so the built artefact could not be
 * run locally at all. Which mattered, because running the built artefact under
 * `node` is the only gate that catches an ESM `__dirname` and it would have
 * been the first thing dropped as "it works under bun".
 */
function resolveMigrationsFolder(): string {
  const folder = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
  if (!existsSync(join(folder, 'meta', '_journal.json'))) {
    throw new Error(
      `No migrations journal at ${join(folder, 'meta', '_journal.json')}. ` +
        'In the image this means build.ts did not copy src/drizzle into dist/drizzle.',
    );
  }
  return folder;
}

/** `--dry-run` reports what WOULD be applied and writes nothing, not even the ledger. */
function isDryRun(argv: readonly string[]): boolean {
  return argv.includes('--dry-run');
}

/**
 * Read `--phase=<pre|post|all>`, with NO default.
 *
 * An unrecognised value throws instead of falling back: silently running `all`
 * for someone who typed `--phase=pre-deploy` is exactly the
 * drop-applied-too-early outage the phases exist to prevent. There is no
 * default either, because `all` is the one value that is wrong on a live
 * database and so must be typed on purpose.
 */
function readPhase(argv: readonly string[]): MigrationRun {
  const prefix = '--phase=';
  const flag = argv.find((arg) => arg.startsWith(prefix));
  if (!flag) {
    throw new Error(`--phase is required. Use one of: ${MIGRATION_RUNS.join(', ')}.`);
  }

  const value = flag.slice(prefix.length).trim();
  if (!(MIGRATION_RUNS as readonly string[]).includes(value)) {
    throw new Error(
      `Unrecognised --phase=${JSON.stringify(value)}. Use one of: ${MIGRATION_RUNS.join(', ')}.`,
    );
  }
  return value as MigrationRun;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required.');
  }

  // Required here, not optional as `@oxyhq/db` allows: this service adopts the
  // guard from day one, so there is no legacy invocation to protect. A
  // DATABASE_URL pointing somewhere unexpected must fail loudly rather than
  // migrate another tenant's database on the shared instance.
  const expectedDatabase = readTargetDatabase(argv);
  if (!expectedDatabase) {
    throw new Error('--target-database=<name> is required.');
  }

  await runMigrations({
    databaseUrl,
    migrationsFolder: resolveMigrationsFolder(),
    // No PostGIS, no pgvector, no pg_trgm. Adding one here is a privileged
    // operation on RDS — see the note in docker-compose.postgres.yml.
    extensions: [],
    run: readPhase(argv),
    expectedDatabase,
    dryRun: isDryRun(argv),
    logger: {
      info: (message) => log.general.info(message),
      debug: (message) => log.general.debug(message),
    },
  });
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    log.general.error({ err: error }, 'Migration run failed');
    process.exit(1);
  },
);
