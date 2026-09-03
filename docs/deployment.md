# Deployment status

Last verified: 2026-09-03.

## Verified state

- `station.oxy.so` and `api.station.oxy.so` do not currently resolve.
- The repository workflow has deployed a frontend artifact to the Cloudflare
  Pages project at `oxystation.pages.dev`. Exact immutable deployment URLs are
  recorded by the corresponding GitHub Actions run.
- There is no public Station API deployment. The web artifact therefore is not
  evidence of a working end-to-end production service.
- The obsolete DigitalOcean and SST specifications were removed because they
  described a retired database/runtime and were not an apply-ready source of
  truth.

## Runtime contract

- The API requires `DATABASE_URL`, executes a real PostgreSQL query before
  listening, and uses only the Drizzle schema and migrations in this repo.
- The frontend export preflight requires an explicit HTTPS
  `EXPO_PUBLIC_API_URL`. The Cloudflare workflow reads it from the
  `STATION_API_URL` repository variable and fails before export when it is
  missing or is not a valid HTTPS origin; it never falls back to an invented
  production host.
- Station deployment configuration contains no provider credentials, provider
  runtime, inference route, or MongoDB binding.

## Before an API deployment

1. Provision or identify the intended PostgreSQL database and secret binding.
2. Choose the API hosting target and verify its release branch and health
   endpoint.
3. Apply migrations from zero and from the last production migration.
4. Set `STATION_API_URL` to the verified API origin.
5. Deploy the frontend and probe an authenticated workspace request through the
   public origin.

Do not create DNS or claim production readiness until those facts are verified.

## Local PostgreSQL verification

```bash
docker compose -f apps/api/docker-compose.postgres.yml up -d
STATION_TEST_DATABASE_URL=postgres://station:station@127.0.0.1:5439/postgres \
  bun run --filter @oxystation/api test:pgdb
docker compose -f apps/api/docker-compose.postgres.yml down
```
