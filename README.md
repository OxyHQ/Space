<p align="center">
  <b>Oxy Station</b> is a workspace for documents and databases by <a href="https://oxy.so">Oxy</a>.<br>
  Pages made of blocks, typed databases with views, comments and sharing, on every platform.
</p>

<p align="center">
  <a href="https://station.oxy.so">station.oxy.so</a>
</p>

<p align="center">
  <img alt="Expo SDK 56" src="https://img.shields.io/badge/Expo-SDK%2056-440151?style=flat-square&logo=expo&logoColor=white">
  <img alt="React Native 0.85" src="https://img.shields.io/badge/React%20Native-0.85-440151?style=flat-square&logo=react&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-440151?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Bun" src="https://img.shields.io/badge/bun-1.3-440151?style=flat-square&logo=bun&logoColor=white">
  <img alt="Express" src="https://img.shields.io/badge/Express-4-440151?style=flat-square&logo=express&logoColor=white">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-Drizzle-440151?style=flat-square&logo=postgresql&logoColor=white">
</p>

---

<table>
<tr>
<td valign="top" width="50%">

### 📄 One document model

A page is a tree of blocks. A database is a typed collection of pages with its own columns and views, so a row in a table and a document you can open are the same object seen two ways.

Workspaces hold members, settings and permissions. Comments, share links and a trash live on top of that model rather than beside it.

</td>
<td valign="top" width="50%">

### 🔑 Identity comes from Oxy

There is no Station account. Sign in is the device first Oxy session, handled end to end by [`@oxyhq/services`](https://www.npmjs.com/package/@oxyhq/services) on the client and [`@oxyhq/core`](https://www.npmjs.com/package/@oxyhq/core) on the server.

On top of that, Station carries its own authorize screen: a registered developer app can ask a signed in person for access over a PKCE flow. See the [Oxy platform repo](https://github.com/OxyHQ/oxy).

</td>
</tr>
</table>

## Workspaces

| Workspace | Path | What it is |
|---|---|---|
| `@oxystation/app` | [`apps/app/`](apps/app/) | Expo client for web, iOS and Android: editor, database views, command palette, sharing |
| `@oxystation/api` | [`apps/api/`](apps/api/) | Express API: TypeScript, PostgreSQL via Drizzle, Socket.IO |

The client is expo-router with NativeWind and Reanimated, rendering [`@oxyhq/bloom`](https://www.npmjs.com/package/@oxyhq/bloom) primitives, with Zustand for state, TanStack Query for data, and shared API schemas from [`@oxyhq/contracts`](https://www.npmjs.com/package/@oxyhq/contracts).

## Quick start

```bash
bun install
cp apps/api/.env.example apps/api/.env
bun run dev:api
bun run dev:app
```

Bun 1.3.14. Use `bun` and `bunx`, never npm, yarn or npx.

<details>
<summary><b>All the commands</b></summary>

<br>

```bash
bun run dev         # both workspaces at once
bun run dev:app     # Expo client
bun run dev:api     # API
bun run build       # both workspaces
bun run build:app   # Expo web export
bun run build:api   # API bundle
bun run lint        # both workspaces

bun run --filter @oxystation/api test   # Vitest
```

`bun run android`, `bun run ios` and `bun run web` target the client.

</details>

<details>
<summary><b>What the API models</b></summary>

<br>

| Model | What it holds |
|---|---|
| `Workspace` and `WorkspaceMember` | The container, its members and their roles |
| `Page` | A document, which may be a sub page or a database row |
| `Block` | The atomic unit of content inside a page |
| `Database` and `DatabaseView` | A typed collection of pages, and how it is rendered |
| `Comment` | Discussion anchored in a document |
| `ShareLink` | Public or scoped access to a page |
| `Subscription`, `Transaction`, `UserCredits` | Billing |

Routes live under [`apps/api/src/routes/`](apps/api/src/routes/).

</details>

<details>
<summary><b>Vocabulary</b></summary>

<br>

Getting these words right in code and in copy is the difference between a coherent product and a pile of features.

| Word | Meaning |
|---|---|
| page | A document, which may hold blocks, sub pages, or be a row in a database |
| block | An atomic content unit: paragraph, heading, todo, code, embed |
| database | A typed collection of pages with columns and views |
| view | One rendering of a database: table, board, gallery, calendar |
| workspace | The top level container, with members, settings and permissions |
| member | A person with a role inside a workspace |
| collab | Real time multi cursor editing, presence and comments |

</details>

<details>
<summary><b>Deploy</b></summary>

<br>

| Workflow | Target |
|---|---|
| [`ci.yml`](.github/workflows/ci.yml) | Lint, API tests and API build on every push and pull request |
| [`deploy.yml`](.github/workflows/deploy.yml) | Web build to Cloudflare Pages |

The API requires PostgreSQL through `DATABASE_URL`, but the checked-in
DigitalOcean specifications still describe the retired Mongo binding and are
not deployable. Do not apply them until the live PostgreSQL binding and the
`master` release branch are wired together; see the
[`deployment status`](docs/deployment.md). Valkey remains a shared service.

</details>

## Conventions

TypeScript first, with no `as any`, no `@ts-ignore` and no non null assertions. Styling is NativeWind classes rather than inline styles. Backend auth is `@oxyhq/core/server` middleware and is never hand rolled.

Longer form docs live in [`docs/`](docs/), and the full working agreement in [`AGENTS.md`](AGENTS.md). Setup details are in [`CONTRIBUTING.md`](CONTRIBUTING.md).

<br>

<div align="center">
<sub>Part of the <a href="https://github.com/OxyHQ">Oxy</a> ecosystem</sub>
</div>
