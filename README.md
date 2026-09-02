# Oxy Station

Oxy Station is Oxy's cross-platform workspace for pages, blocks, typed
databases, comments, sharing, and real-time collaboration.

## Workspaces

| Package | Path | Responsibility |
|---|---|---|
| `@oxystation/app` | `apps/app/` | Expo client for web, iOS, and Android |
| `@oxystation/api` | `apps/api/` | Express API backed by PostgreSQL/Drizzle |

Oxy sessions are handled by `@oxyhq/services` on the client and
`@oxyhq/core/server` on the API. Station does not store provider credentials or
run inference providers. Future workspace agent flows use
`Station -> Alia -> Oxy -> Kaana`; provider credentials remain solely in
Kaana's encrypted PostgreSQL store.

## Quick start

```bash
bun install
cp apps/api/.env.example apps/api/.env
cp apps/app/.env.example apps/app/.env
bun run dev:api
bun run dev:app
```

Use Bun for dependency and script execution.

## Verification

```bash
bun run --filter @oxystation/api lint
bun run --filter @oxystation/api test
STATION_TEST_DATABASE_URL=postgres://station:station@127.0.0.1:5439/postgres \
  bun run --filter @oxystation/api test:pgdb
bun run build:api
EXPO_PUBLIC_API_URL=http://localhost:4001 bun run build:app
```

The API requires `DATABASE_URL` and proves connectivity before listening. The
app requires an explicit `EXPO_PUBLIC_API_URL`; no production API hostname is
checked into the bundle.

Current deployment facts and blockers are recorded in
[`docs/deployment.md`](docs/deployment.md). Repository rules live in
[`AGENTS.md`](AGENTS.md).
