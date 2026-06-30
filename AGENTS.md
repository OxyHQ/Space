# Oxy Space — Project Conventions

Oxy Space is a Notion-like workspace by Oxy: docs, databases, blocks, real-time collab, plus a native AI hub. It replaces the legacy Clarity AI chat product; the legacy chat UI has been stripped. Phase 1+ introduces pages, blocks, databases, collab, and Hub AI (Phase 5).

Roadmap reference: `~/.claude/plans/this-was-other-app-fancy-meteor.md`.

## Monorepo Structure

- `apps/app/` — Main Expo app (React Native + Web)
- `apps/api/` — Express backend API

## Tech Stack

- **Frontend**: Expo SDK 56, NativeWind 5, Reanimated v4, Zustand, TanStack Query, expo-router
- **Backend**: Express, TypeScript, MongoDB/Mongoose, Socket.IO, Redis (Valkey)
- **Auth**: `@oxyhq/core` (incl. `@oxyhq/core/server`), `@oxyhq/services`

## MongoDB

Database: `oxyspace-production` (passed to `mongoose.connect()` via `dbName`, NOT embedded in `MONGODB_URI`).

## Vocabulary

- **page** — a document; may contain blocks, sub-pages, or be a database row
- **block** — atomic content unit (paragraph, heading, todo, code, embed, etc.)
- **database** — typed collection of pages with columns and views
- **view** — rendering of a database (table, board, gallery, calendar)
- **workspace** — top-level container with members, settings, permissions
- **member** — a user with a role inside a workspace
- **collab** — real-time multi-cursor editing, presence, comments

Do NOT use legacy chat vocabulary (conversation, message, thread, role/persona, agent, skill, deep research, follow-up) in user-facing copy.

## Internal AI Provider Routing (internal only, Phase 5)

No end-user model picker in Oxy Space. The provider-routing layer (`apps/api/src/internal/providers/*`) is preserved for Hub AI (Phase 5):
- Internal calls map an abstract model identifier to concrete provider models with automatic fallback.
- Internal providers (OpenAI, Anthropic, Google, Groq, DeepSeek, xAI, Mistral, etc.) must NEVER be exposed in UI, API responses, errors, SEO metadata, or docs.
- Use `sanitizeMessage()` from `apps/api/src/lib/errors/sanitize.ts` for any user-facing error path touching provider code.
- The internal-only API is CORS-restricted to known Oxy origins.

## Oxy Service Connector (internal, Phase 5)

A manifest-driven protocol where apps register tool definitions that the internal AI runtime auto-discovers. Not part of the Oxy Space user surface.

Key files:
- `apps/api/src/models/oxy-service.ts` — OxyService Mongoose model (manifest schema)
- `apps/api/src/lib/tools/oxy-services.ts` — Tool builder
- `apps/api/src/routes/oxy-service-events.ts` — Event webhook endpoint
