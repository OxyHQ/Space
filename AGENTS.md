# Oxy Station — Project Conventions

Oxy Station is Oxy's document and database workspace. The monorepo contains
the Expo app in `apps/app/` and the Express API in `apps/api/`.

Universal standards live in `~/AGENTS.md`, and Oxy-wide gotchas live in
`~/Oxy/AGENTS.md`. Documentation belongs in `docs/`, history in git, and status
in issues. This file holds only rules, commands, and pointers. Budget: under
8 KB.

## Runtime boundaries

- PostgreSQL through Drizzle is the only application database. `DATABASE_URL`
  is required and the API verifies it before listening. Never add MongoDB,
  Mongoose, an in-memory database fallback, or a second persistence path.
- Station owns workspace documents, databases, collaboration, uploads,
  notifications, and feedback. It does not own inference routing, provider
  adapters, provider health, model catalogues, or provider credentials.
- Provider credentials live only in Kaana's encrypted PostgreSQL store. They
  must never enter Station source, environment variables, database tables,
  logs, bundles, or deploy configuration.
- Product agent flows use `Station -> Alia -> Oxy -> Kaana`. Kaana's canonical
  signed origin is exclusively `https://kaana.ai`.
- Do not add local chat-completion, Clarity compatibility, provider execution,
  or developer provider-key routes. Adding a new workspace feature must not
  weaken `inferenceBoundary.test.ts` or `inferenceBoundary.pgdb.test.ts`.

## Product vocabulary

Use page, block, database, view, workspace, member, and collaboration. Do not
reuse legacy chat vocabulary for workspace concepts.

## Commands

```bash
bun install
bun run --filter @oxystation/api lint
bun run --filter @oxystation/api test
STATION_TEST_DATABASE_URL=postgres://station:station@127.0.0.1:5439/postgres \
  bun run --filter @oxystation/api test:pgdb
bun run build:api
EXPO_PUBLIC_API_URL=http://localhost:4001 bun run build:app
```

Commit manifest and `bun.lock` changes together. The web build requires an
explicit `EXPO_PUBLIC_API_URL`; there is no implicit production API hostname.
Deployment state and migration commands are documented in `docs/deployment.md`.
