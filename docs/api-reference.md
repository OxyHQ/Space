# Oxy Station API reference

Last verified against `apps/api/src/index.ts`: 2026-09-02.

There is currently no public production base URL. Clients receive the intended
origin through `EXPO_PUBLIC_API_URL`.

Protected routes accept an Oxy session in `Authorization: Bearer <token>`.
Public exceptions are limited to liveness/readiness, public share tokens,
embed previews, and the browser-push public key. Individual route middleware
is the source of truth.

## Mounted route groups

- `/health`
- `/feedback`
- `/notifications`
- `/workspaces`
- `/pages`
- `/blocks`
- `/comments`
- `/databases`
- `/uploads`
- `/embed`
- `/share-links`
- `/share/:token`

There is no local provider administration, provider-key, billing/credits,
Clarity compatibility, conversation, model catalogue, or chat-completion
route. Station is a workspace API, not an inference data plane.

## Health

- `GET /health/live` reports process liveness.
- `GET /health/ready` verifies PostgreSQL readiness.
- `GET /health` returns the current PostgreSQL-backed health snapshot.

## Notifications

Notifications are limited to workspace mentions and comment replies. The
router supports list/count, read/dismiss, Expo push tokens, and browser push
subscriptions.
