# Oxy Space API

Express + TypeScript backend for Oxy Space.

## Tech

- Express + TypeScript
- MongoDB + Mongoose (shared `db-oxy` cluster, app database `oxyspace-{NODE_ENV}`)
- Redis (Valkey) for rate limits, caching, Socket.IO scale-out
- Socket.IO for real-time events
- BullMQ for async jobs
- DigitalOcean Spaces (S3-compatible) for file uploads
- Stripe for billing
- Internal AI provider routing (Phase 5, not user-visible)

## Development

```bash
# from repo root
bun run dev:api

# from apps/api
bun run dev
```

## Build

```bash
bun run build
bun run start
```

## Environment

Use `apps/api/example.env` as the baseline.

Key groups:

- Server and CORS (`PORT`, `WEB_URL`, `API_BASE_URL`)
- MongoDB (`MONGODB_URI`)
- Auth secrets (`JWT_SECRET`, `SERVICE_SECRET`)
- Queue/async execution (`REDIS_URL`)
- Integrations and channels (`INTEGRATIONS_SERVICE_URL`, channel secrets)
- Optional sandbox runtime (`DOCKER_HOST_URL`, `DOCKER_HOST_SECRET`)

## Notes

- All user-facing errors must be sanitized via `apps/api/src/lib/errors/sanitize.ts`.
- Internal model-routing details (provider names, provider model IDs) must never leak in public responses or logs.
- The legacy `/clarity/search` and `/v1/chat/completions` chat endpoints remain mounted while Phase 5 (Hub AI) is internal-only; they are not surfaced in the Oxy Space UI.
