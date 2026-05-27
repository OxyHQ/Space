# Oxy Space - Project Conventions

(Mirrored from `CLAUDE.md` for AI coding assistants.)

## Product

Oxy Space is a Notion-like workspace by Oxy: docs, databases, blocks, real-time collab, plus a native AI hub. It replaces the legacy "Clarity" AI chat product. The legacy chat runtime is in the process of being stripped from the user-facing surface.

Roadmap reference: `~/.claude/plans/this-was-other-app-fancy-meteor.md`. Phase 0 (strip) and the brand pivot are complete in this pass. Phase 1 onwards introduces:

- **Pages** — hierarchical, block-structured documents
- **Blocks** — text, headings, lists, todos, embeds, code, callouts, databases, etc.
- **Databases** — typed columns, views (table, board, gallery, calendar), filters, sorts
- **Collab** — real-time multi-user editing, presence, comments, mentions
- **Hub AI** (Phase 5) — internal AI assistance over workspace content (not a public chat product)

## Internal AI provider routing (internal only)

There is no end-user model picker in Oxy Space. The legacy provider-routing layer is preserved under `apps/api/src/internal/providers/*` for Hub AI in Phase 5 and is **internal-only**:

- Internal calls map an abstract model identifier to one or more concrete provider models with automatic fallback.
- Internal providers (OpenAI, Anthropic, Google, Groq, DeepSeek, xAI, Mistral, etc.) must never be exposed to the end user — not in UI, API responses, errors, SEO metadata, or docs.
- Use `sanitizeMessage()` from `apps/api/src/lib/errors/sanitize.ts` for any user-facing error path that touches provider code.

The internal-only API is CORS-restricted to known Oxy origins and is not part of the public Oxy Space surface.

## MongoDB Database Naming

All Oxy ecosystem apps share the same MongoDB cluster on DigitalOcean. Each app uses its own database named `{appName}-{NODE_ENV}` (e.g., `oxyspace-production`). The `dbName` is passed to `mongoose.connect()`, not embedded in `MONGODB_URI`.

## Monorepo Structure

- `apps/app/` - Main Expo app (React Native + Web)
- `apps/api/` - Express backend API

## Tech Stack

- **Frontend**: Expo 55, React Native 0.83, TypeScript, NativeWind (Tailwind), Reanimated v4, Zustand, TanStack Query
- **Backend**: Express, TypeScript, MongoDB/Mongoose, Socket.IO, Redis (Valkey)
- **Auth**: @oxyhq/services (OxyProvider, useAuth, OxySignInButton)
- **Routing**: expo-router (file-based)
- **Infra**: SST + DigitalOcean (App Platform, Spaces) + Cloudflare

## Vocabulary

When designing or describing features, prefer this vocabulary:

- **page** — a document. May contain blocks, sub-pages, or be a database row.
- **block** — atomic content unit inside a page (paragraph, heading, todo, code, embed, etc.).
- **database** — a typed collection of pages with columns and views.
- **view** — a way of rendering a database (table, board, gallery, calendar).
- **workspace** — a top-level container with members, settings, permissions.
- **member** — a user with a role inside a workspace.
- **collab** — real-time multi-cursor editing, presence, comments.

Do **not** use legacy chat-product vocabulary (conversation, message, thread, role/persona, agent, skill, deep research, follow-up) in user-facing copy for Oxy Space surfaces.

## Oxy Service Connector Protocol (internal / Phase 5)

The backend integrates with Oxy ecosystem apps via the **Oxy Service Connector** — a manifest-driven protocol where apps register tool definitions that the internal AI runtime auto-discovers. This is reserved for Phase 5 (Hub AI) and is **not** exposed in the Oxy Space user surface.

### Key files

- `apps/api/src/models/oxy-service.ts` - OxyService Mongoose model (manifest schema)
- `apps/api/src/lib/tools/oxy-services.ts` - Tool builder
- `apps/api/src/routes/oxy-service-events.ts` - Event webhook endpoint
