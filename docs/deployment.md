# Deployment Guide

Last updated: 2026-04-10

This guide covers production deployment for Oxy Station. Infrastructure is defined as code using [SST](https://sst.dev) with DigitalOcean and Cloudflare providers.

## Infrastructure as Code (SST)

All infrastructure is defined in `sst.config.ts` at the repo root. SST manages:

- **DO App Platform**: API service + static frontend
- **DO Spaces**: File storage bucket (`bucket-oxystation`)
- **Domains**: station.oxy.so, api.station.oxy.so

PostgreSQL is supplied as the `DATABASE_URL` App Platform secret. Valkey is
referenced by cluster name and managed externally.

### Prerequisites

```bash
bun add -d sst    # Already in devDependencies
```

Set credentials:

```bash
export DIGITALOCEAN_TOKEN=dop_v1_...
export SPACES_ACCESS_KEY_ID=...
export SPACES_SECRET_ACCESS_KEY=...
export CLOUDFLARE_API_TOKEN=...
```

### Deploy

```bash
# Deploy to production
bunx sst deploy --stage production

# Deploy a dev/preview environment
bunx sst deploy --stage dev

# Remove a non-production stage
bunx sst remove --stage dev
```

### Stages

| Stage | Behavior |
|-------|----------|
| `production` | 2x API instances, retains resources on removal, domains configured |
| Any other | 1x API instance, removes all resources on cleanup, no custom domains |

### Local Development

```bash
bunx sst dev    # Starts multiplexer with linked resources
```

## Preconditions

- PostgreSQL reachable through `DATABASE_URL`.
- Oxy auth service reachable.
- Valkey (Redis) available for caching and rate limiting.

## Database

The database name is part of `DATABASE_URL`. The API performs `select 1` before
opening the listener, so a missing or unreachable PostgreSQL database fails the
deployment loudly.

## Minimum Environment (API)

These are configured in `sst.config.ts` and injected via DO App Platform:

```bash
PORT=8080
NODE_ENV=production
WEB_URL=https://station.oxy.so
DATABASE_URL=<PostgreSQL connection string>
REDIS_URL=<from db-valkey cluster>
SERVICE_SECRET=<strong-secret>       # Set as SECRET in DO dashboard
```

## Optional but Recommended

```bash
# S3/Spaces (auto-configured by SST)
AWS_REGION=ams3
AWS_ACCESS_KEY_ID=<secret>
AWS_SECRET_ACCESS_KEY=<secret>
AWS_ENDPOINT_URL=https://ams3.digitaloceanspaces.com
AWS_S3_BUCKET=bucket-oxystation

# Stripe
STRIPE_SECRET_KEY=<secret>
STRIPE_WEBHOOK_SECRET=<secret>

# LiveKit
LIVEKIT_URL=wss://livekit.oxy.so
LIVEKIT_API_KEY=<secret>
LIVEKIT_API_SECRET=<secret>
```

## Startup Behavior

On API boot, the server automatically:

- Verifies PostgreSQL with a real query before listening.
- Initializes Socket.IO.
- Warms the transitional local AI provider caches. This is live migration debt,
  not the target Hub AI architecture; Station must move that path to
  Alia -> Oxy -> Kaana before the local provider runtime is removed.

## Health Checks

- `GET /health`

## Rollback Strategy

- Use `bunx sst deploy --stage production` to redeploy.
- For DO App Platform, rollback is also available via the DO dashboard.

## Legacy Reference

The `.do/app.yaml` file is kept as a reference for the DO App Platform spec but is no longer the source of truth. All infrastructure changes should go through `sst.config.ts`.
