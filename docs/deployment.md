# Deployment status

Last verified from source: 2026-09-02

Station is not deployable from the checked-in DigitalOcean specifications yet.
Do not apply `sst.config.ts` or `.do/app.yaml` until the blockers below are
resolved against the live DigitalOcean app.

## Confirmed source/runtime contract

- The API requires `DATABASE_URL` and executes `select 1` before listening.
- Schema and migrations are PostgreSQL/Drizzle under `apps/api/src/db/` and
  `apps/api/src/drizzle/`.
- Valkey is optional for local development and used for cache, rate limits and
  Socket.IO scale-out when present.
- The local AI provider bridge still reads `provider_keys` and existing
  provider environment variables. It is removed only after Hub AI routes
  through Alia -> Oxy -> Kaana.

## Blocking mismatches in both specifications

The checked-in `.do/app.yaml` and `sst.config.ts` are legacy declarations, not
an apply-ready source of truth:

1. They point production at branch `main`, but this repository's default and
   only release branch is `master`.
2. They inject a Mongo connection and do not bind the `DATABASE_URL` required
   by the current API process.
3. Replacing that entry with an empty `SECRET` declaration does not provision a
   PostgreSQL database or prove the secret already exists in App Platform.

Changing only the branch could activate `deploy_on_push` against a process that
cannot boot, so branch and database wiring must be reviewed as one production
change after the real app and database IDs are known.

## Required read-only discovery

Before the infrastructure PR:

1. Read the live App Platform app ID, spec and active deployment.
2. Resolve the PostgreSQL cluster, database, user and connection binding that
   Station will use; do not guess names.
3. Confirm how the current `DATABASE_URL` is stored and whether updating the
   spec preserves its secret value.
4. Compare live domains and Spaces resources with the checked-in names.
5. Produce the complete spec diff before applying anything.

This environment had no DigitalOcean MCP, token file, token environment
variable or `doctl`, so none of those live facts were available for this PR.

## Local verification

Run the API against PostgreSQL 17:

```bash
docker compose -f apps/api/docker-compose.postgres.yml up -d
STATION_TEST_DATABASE_URL=postgres://station:station@127.0.0.1:5439/postgres \
  bun run --filter @oxystation/api test:pgdb
docker compose -f apps/api/docker-compose.postgres.yml down
```

Normal repository gates:

```bash
bun install
git diff --exit-code -- bun.lock
bun run --filter @oxystation/api lint
bun run --filter @oxystation/api test
bun run build:api
```

No deploy or rollback command belongs in this guide until the production
binding has been discovered and the infrastructure mismatch is fixed.
