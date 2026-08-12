# Oxy Station App

Expo client for Oxy Station — web, iOS, and Android.

## Tech

- Expo 55 / React Native 0.83
- expo-router (file-based routing)
- NativeWind (Tailwind for RN)
- Zustand, TanStack Query
- OxyHQ auth (`@oxyhq/services`)

## Development

```bash
# from repo root
bun run dev:app

# from apps/app
bun start
```

Platform targets:

```bash
bun run web
bun run ios
bun run android
```

## API Config

Configured in `apps/app/lib/config.ts`.

Expected production API: `https://api.station.oxy.so`

## Notes

- This pass is the brand pivot from the legacy chat product to a Notion-like workspace shell. Pages, databases, and blocks land in later phases.
- Internal AI provider routing remains (Phase 5, internal only) and is not exposed in the UI.
