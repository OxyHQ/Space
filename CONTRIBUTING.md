# Contributing to Oxy Space

## Prerequisites

- **Bun** (https://bun.sh — use `bun`, not npm or yarn)
- **MongoDB** (local or Atlas)
- **Redis / Valkey** (optional, falls back gracefully)

## Getting Started

```bash
git clone <repo-url> && cd Clarity
bun install                                # installs all workspaces
cp apps/api/example.env apps/api/.env      # fill in your values
bun run dev                                # starts all services
```

Focused commands:

```bash
bun run dev:api          # API only
bun run dev:app          # Expo app only
```

## Monorepo Structure

This is a **Bun workspaces** monorepo.

| App | Stack | Purpose |
| --- | --- | --- |
| `apps/api` | Express + TypeScript | Core API runtime |
| `apps/app` | Expo 55 (React Native + Web) | Main app (web + iOS + Android) |

## Branch Naming

```
feat/short-description
fix/short-description
refactor/short-description
```

Always branch from `master`.

## Commit Messages

Use [conventional commits](https://www.conventionalcommits.org/):

```
feat: add workspace page tree
fix: correct token refresh race condition
refactor: extract sidebar into shared module
docs: update deployment guide
test: add integration tests
chore: bump dependencies
```

## Pull Request Process

1. Create a branch from `master` with the naming convention above.
2. Keep PRs focused — one feature or fix per PR.
3. Write a descriptive PR summary (what changed and why).
4. Ensure CI passes before requesting review.
5. Request review from at least one team member.

## Code Style

- **TypeScript strict mode**. Never use `as any`, `@ts-ignore`, or `!` non-null assertions — fix the actual type.
- **Frontend styling**: NativeWind (Tailwind). No inline style objects unless necessary.
- **State management**: Zustand for client state. TanStack Query for server state.
- **Routing**: expo-router (file-based) in `apps/app`.
- Avoid `useEffect` where derived state, event handlers, or query hooks fit better.
- Follow existing patterns in the codebase.

## Testing

Run API tests before submitting:

```bash
bun test --filter @oxyspace/api
```

Tests use **Vitest**. Place test files next to source as `*.test.ts`.

## Key Conventions

### Internal AI provider routing

The legacy AI provider routing layer is internal-only (Phase 5, not exposed to end users). Never expose provider names or provider model IDs (OpenAI, Anthropic, `gpt-4o`, `claude-sonnet-4`, etc.) in UI text, error messages, API responses, documentation, or marketing copy.

### Error Handling

Use `sanitizeMessage()` from `apps/api/src/lib/errors/sanitize.ts` for all user-facing error messages. This strips any leaked provider names.

### Database

MongoDB with Mongoose. Database name follows `oxyspace-{NODE_ENV}` convention. Connection URI is shared across the Oxy ecosystem — the `dbName` is passed to `mongoose.connect()`, not embedded in the URI.
