# Oxy Station API

Express and TypeScript API for the Station workspace.

## Runtime

- PostgreSQL/Drizzle is the only database and `DATABASE_URL` is required.
- Socket.IO provides real-time workspace updates.
- Redis/Valkey is optional for Socket.IO scale-out.
- S3-compatible storage and browser push are optional.
- Oxy session verification comes from `@oxyhq/core/server`.

Station has no provider runtime, provider-key storage, model routing, billing
credits, or chat-completion endpoints. Provider credentials belong only to
Kaana's encrypted PostgreSQL database.

## Commands

```bash
bun run dev
bun run lint
bun run test
STATION_TEST_DATABASE_URL=postgres://station:station@127.0.0.1:5439/postgres \
  bun run test:pgdb
bun run build
```

Start from `.env.example`. The only required secret-bearing runtime binding is
the PostgreSQL `DATABASE_URL`; optional service credentials belong to their
own non-inference integrations.
