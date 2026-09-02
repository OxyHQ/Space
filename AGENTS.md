# Oxy Station — Project Conventions

Oxy Station is a Notion-like workspace by Oxy: docs, databases, blocks, real-time collab, plus a native AI hub. It replaces the legacy Clarity AI chat product; the legacy chat UI has been stripped. Phase 1+ introduces pages, blocks, databases, collab, and Hub AI (Phase 5).

Roadmap reference: `~/.claude/plans/this-was-other-app-fancy-meteor.md`.

## Monorepo Structure

- `apps/app/` — Main Expo app (React Native + Web)
- `apps/api/` — Express backend API

## Tech Stack

- **Frontend**: Expo SDK 56, NativeWind 5, Reanimated v4, Zustand, TanStack Query, expo-router
- **Backend**: Express, TypeScript, PostgreSQL/Drizzle, Socket.IO, Redis (Valkey)
- **Auth**: `@oxyhq/core` (incl. `@oxyhq/core/server`), `@oxyhq/services`

## PostgreSQL

`DATABASE_URL` is required, and `apps/api/src/index.ts` issues a real query
before listening. Schema and migrations live under `apps/api/src/db/` and
`apps/api/src/drizzle/`. Do not introduce MongoDB, Mongoose, or a local database
fallback.

## Vocabulary

- **page** — a document; may contain blocks, sub-pages, or be a database row
- **block** — atomic content unit (paragraph, heading, todo, code, embed, etc.)
- **database** — typed collection of pages with columns and views
- **view** — rendering of a database (table, board, gallery, calendar)
- **workspace** — top-level container with members, settings, permissions
- **member** — a user with a role inside a workspace
- **collab** — real-time multi-cursor editing, presence, comments

Do NOT use legacy chat vocabulary (conversation, message, thread, role/persona, agent, skill, deep research, follow-up) in user-facing copy.

## AI boundary

Hub AI is an Alia agent flow; Alia reaches inference through Oxy and Kaana.
Station does not own provider routing or provider credentials. The existing
`apps/api/src/internal/providers/` tree is transition debt and must not be
expanded. Provider names must never reach UI, public API responses, errors,
SEO metadata, or docs.
