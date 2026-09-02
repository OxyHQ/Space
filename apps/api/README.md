# Oxy Station API

Express + TypeScript backend for Oxy Station.

## Tech

- Express + TypeScript
- PostgreSQL + Drizzle
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

Use `apps/api/.env.example` as the baseline.

Key groups:

- Server and CORS (`PORT`, `WEB_URL`, `API_BASE_URL`)
- PostgreSQL (`DATABASE_URL`, required)
- Auth secrets (`JWT_SECRET`, `SERVICE_SECRET`)
- Queue/async execution (`REDIS_URL`)
- Integrations and channels (`INTEGRATIONS_SERVICE_URL`, channel secrets)
- Optional sandbox runtime (`DOCKER_HOST_URL`, `DOCKER_HOST_SECRET`)
- Transitional provider-key fallback (documented in `.env.example`; do not expand)

## Notes

- All user-facing errors must be sanitized via `apps/api/src/lib/errors/sanitize.ts`.
- Internal model-routing details (provider names, provider model IDs) must never leak in public responses or logs.
- The legacy `/clarity/search` and `/v1/chat/completions` chat endpoints remain mounted while Phase 5 (Hub AI) is internal-only; they are not surfaced in the Oxy Station UI.
- Hub AI's target route is Alia -> Oxy -> Kaana. The local provider-key table
  and environment fallback remain live until that route replaces every caller.
