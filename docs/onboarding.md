# Oxy Station developer onboarding

Station is a Bun monorepo with an Expo client and an Express API.

```text
apps/app  -> HTTPS and Socket.IO -> apps/api -> PostgreSQL
```

Redis/Valkey is optional and supports Socket.IO scale-out. S3-compatible
storage is optional for uploads. Neither service replaces PostgreSQL.

## Boundaries

Station owns workspace data and collaboration. It does not execute providers,
store provider keys, expose chat completions, or maintain a model catalogue.
Workspace agent flows use `Station -> Alia -> Oxy -> Kaana`; provider
credentials exist only in Kaana's encrypted PostgreSQL database.

The inference-boundary tests deliberately include positive fixtures. If one of
the forbidden constructs is introduced, the detector must name it rather than
passing because it scanned nothing.

## Important paths

| Path | Purpose |
|---|---|
| `apps/api/src/index.ts` | API boot and route mounts |
| `apps/api/src/db/schema/` | current PostgreSQL schema |
| `apps/api/src/drizzle/` | immutable migration history |
| `apps/app/lib/api/` | authenticated API client and route constants |
| `apps/app/app/` | Expo Router screens |

## Setup

```bash
bun install
cp apps/api/.env.example apps/api/.env
cp apps/app/.env.example apps/app/.env
bun run dev:api
bun run dev:app
```

## Gates

```bash
bun run --filter @oxystation/api lint
bun run --filter @oxystation/api test
STATION_TEST_DATABASE_URL=postgres://station:station@127.0.0.1:5439/postgres \
  bun run --filter @oxystation/api test:pgdb
bun run build:api
EXPO_PUBLIC_API_URL=http://localhost:4001 bun run build:app
```

See [deployment status](deployment.md) before changing a release workflow.
