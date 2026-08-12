# Oxy Station Developer Onboarding

Last updated: 2026-05-25

Welcome to Oxy Station — the workspace for docs, databases, and AI. This guide gets you productive on day 1.

> The codebase is mid-pivot from a legacy AI chat product to a Notion-like workspace. Many backend modules (chat runtime, internal AI provider routing) remain in place but are not exposed in the Oxy Station UI. The roadmap delivers pages, blocks, databases, and real-time collab in upcoming phases.

## Monorepo

```
apps/
  app/    # Expo cross-platform client (web + iOS + Android)
  api/    # Express backend API
```

## Architecture Overview

```
                            +-------------------+
                            |   Expo App (Web,  |
     User  ───────────────> |   iOS, Android)   |
                            +--------+----------+
                                     |
                                  HTTPS / SSE / WS
                                     |
                            +--------v----------+
                            |  Express API      |
                            |  (apps/api)       |
                            +--+---------+------+
                               |         |
               +---------------+         +----------------+
               |                                          |
      +--------v---------+                  +-------------v-----------+
      |  MongoDB         |                  |  Internal AI providers  |
      |  (Mongoose,      |                  |  (Phase 5, internal     |
      |   db-oxy cluster)|                  |   routing, not user-    |
      +--------+---------+                  |   visible)              |
               |                            +-------------------------+
      +--------v---------+
      |  Redis (Valkey)  |     Socket.IO real-time events
      |  rate limits,    |
      |  caching         |
      +-----------------+
```

## Key Directories and Files

### API (`apps/api/src/`)

| Path | What it does | When you touch it |
|------|-------------|-------------------|
| `index.ts` | Express boot: DB connect, route mounting, Socket.IO setup | Adding a new top-level route |
| `lib/db.ts` | MongoDB connection (passes `dbName` to `mongoose.connect()`) | DB config changes |
| `lib/redis.ts` | Shared Redis/Valkey client | Caching, rate limiting |
| `middleware/auth.ts` | JWT verification via OxyHQ, sets `req.userId` | Auth changes |
| `models/` | Mongoose models | Schema changes |
| `internal/providers/` | Internal AI provider routing (Phase 5, CORS-restricted, never exposed) | Internal model config |

### App (`apps/app/`)

| Path | What it does | When you touch it |
|------|-------------|-------------------|
| `app/_layout.tsx` | Root layout: OxyProvider, fonts, theme, auth setup | App-wide providers |
| `app/(app)/_layout.tsx` | Main layout: sidebar, screens, store hydration | Adding a new screen |
| `lib/stores/` | Zustand stores | Client state changes |
| `lib/api/client.ts` | API client with auth token injection | API communication |
| `lib/api/routes.ts` | All API route constants | Adding/renaming endpoints |
| `lib/config.ts` | API base URL configuration | API endpoint changes |

## State Management Patterns

### Zustand Stores (client-side, synchronous)

Use for UI state and data that needs to persist across screens.

### TanStack Query (server state, async)

Use for data fetched from the API that needs caching, refetching, and stale management. API calls go through `lib/api/client.ts` which auto-attaches the OxyHQ JWT.

**Rule of thumb**: if the data comes from the server, use TanStack Query. If it is purely UI state or needs synchronous access, use a Zustand store.

## Common Tasks

### Adding a new API route

1. Create `apps/api/src/routes/my-route.ts` with an Express Router
2. Import and mount it in `apps/api/src/index.ts`
3. If it needs auth, apply the `auth` middleware — check existing routes for the pattern

### Adding a new screen in the app

1. Create a file in `apps/app/app/(app)/` — expo-router uses file-based routing
2. Register navigation if needed
3. Add the route constant to `apps/app/lib/api/routes.ts` if it needs an API endpoint

### Running tests

```bash
bun test --filter @oxystation/api      # Run all API tests
bun run lint                         # Lint the API
```

## Useful Commands

```bash
bun install                       # Install all workspace dependencies
bun run dev                       # Start all apps in dev mode
bun run dev:api                   # API only (Express + hot reload)
bun run dev:app                   # Expo app only (web + tunnel)
bun test --filter @oxystation/api   # API tests (vitest)
bun run lint                      # Lint API code
bunx sst dev                      # Start SST dev multiplexer
bunx sst deploy --stage dev       # Deploy to a stage
```

Environment: copy `apps/api/example.env` to `apps/api/.env` and fill in your MongoDB URI, Redis URL, and provider secrets. The database name is computed automatically as `oxystation-{NODE_ENV}` — do not embed it in the URI.

## Links to Deep Docs

| Topic | File |
|-------|------|
| API reference | [docs/api-reference.md](api-reference.md) |
| OxyHQ authentication | [docs/oxyhq-auth.md](oxyhq-auth.md) |
| Deployment (SST + DigitalOcean) | [docs/deployment.md](deployment.md) |
| Project conventions | [CLAUDE.md](../CLAUDE.md) (also read by AI coding assistants) |
