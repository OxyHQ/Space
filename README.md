# Oxy Space

Workspace for docs, databases, and AI. Part of the [Oxy](https://oxy.so) ecosystem.

**Live:** [space.oxy.so](https://space.oxy.so)

## Monorepo

```
apps/
  app/    # Expo cross-platform client (web + iOS + Android)
  api/    # Express backend API
```

## Stack

- **Frontend**: Expo 55, React Native 0.83, TypeScript, NativeWind (Tailwind), Reanimated v4, Zustand, TanStack Query
- **Backend**: Express, TypeScript, MongoDB/Mongoose, Socket.IO, Redis (Valkey)
- **Auth**: OxyHQ (`@oxyhq/services`)
- **Infra**: SST + DigitalOcean (App Platform, Spaces) + Cloudflare

## Development

Use `bun` (never npm or yarn). `bunx` instead of `npx`.

```bash
bun install
bun run dev:app    # Start frontend (Expo)
bun run dev:api    # Start backend (Express)
```

## Infrastructure

Infrastructure is defined as code in `sst.config.ts` using [SST](https://sst.dev) with DigitalOcean and Cloudflare providers.

```bash
# Set credentials
export DIGITALOCEAN_TOKEN=dop_v1_...
export SPACES_ACCESS_KEY_ID=...
export SPACES_SECRET_ACCESS_KEY=...
export CLOUDFLARE_API_TOKEN=...

# Deploy to a stage
bunx sst deploy --stage production

# Local dev (starts multiplexer)
bunx sst dev
```

### Resources managed by SST

| Resource | Provider | Notes |
|----------|----------|-------|
| API service | DO App Platform | Express backend |
| Static frontend | DO App Platform | Expo web build |
| File storage | DO Spaces | `bucket-oxyspace` in ams3 |
| Domains | space.oxy.so | api.space.oxy.so |

### Shared resources (external)

MongoDB and Valkey (Redis) are shared across all Oxy apps and referenced by cluster name in the App Platform spec. They are **not** created or destroyed by SST.

### Stages

- `production` — live at space.oxy.so, retains resources on removal
- Any other stage name — creates isolated environment, removes resources on cleanup

## Phase Roadmap

Oxy Space is being built in phases. See `~/.claude/plans/this-was-other-app-fancy-meteor.md` for the full plan. The current pass strips legacy chat-product UI and rebrands the shell. Pages, databases, blocks, and collab land in later phases.
