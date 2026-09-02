# Oxy Station API reference

Last verified against the mounted Express routers: 2026-09-02.

## Base URL

`https://api.station.oxy.so`

## Authentication

Protected routes accept an Oxy session JWT in
`Authorization: Bearer <token>`. Server-to-server routes use a separately
provisioned Oxy service credential. Station does not expose a developer API-key
management route.

`GET /health/live`, the billing catalogue, feedback submission and the public
share-token route are examples of routes that do not require a user session.
Individual route middleware remains the source of truth for authentication.

## Mounted route groups

The API currently mounts these public groups:

- `/health`
- `/auth`
- `/conversations`
- `/credits`
- `/clarity/search`
- `/v1`
- `/billing`
- `/feedback`
- `/models`
- `/analytics`
- `/notifications`
- `/workspaces`
- `/pages`, `/blocks`, `/comments` and `/databases`
- `/uploads` and `/embed`
- `/share-links` and `/share/:token`

`/internal` is service-authenticated and is not a public client API.

There is no mounted `/triggers` group and no external `/webhooks/oxy` route.
The old catch-all webhook router was removed because it returned `404` for
every request.

## Models

### `GET /v1/models`

Lists the virtual models exposed by Station. This route is public. Optional
query parameters are `category` and `chat=true`.

### `GET /v1/models/:modelId`

Returns one virtual-model descriptor or `404`.

The response deliberately omits the underlying provider mapping.

## Chat completions

### `POST /v1/chat/completions`

Authenticated OpenAI-compatible chat completion. Standard JSON and streaming
responses are supported. See [Chat API](./chat-api.mdx) for the verified
request and event contract.

### `POST /clarity/search`

Compatibility mount of the same handler with optional Oxy authentication.

## Removed model-routing endpoints

The following compatibility endpoints are still mounted only to return
`410 Gone`:

- `POST /v1/resolve-model`
- `POST /v1/report-usage`

Provider resolution and usage accounting are internal runtime concerns.

## Notifications

The `/notifications` router exposes list, unread count, read/dismiss actions,
Expo push-token registration and browser push-subscription registration. Except
for `GET /notifications/vapid-public-key`, these routes require an Oxy session.

## Errors

User-facing AI errors are sanitized before they leave the API. Once an SSE
response has started, failures are sent as an OpenAI-shaped error frame followed
by `data: [DONE]`.
