# Oxy Station App

Expo client for the Station workspace on web, iOS, and Android.

## Development

```bash
cp .env.example .env
bun start
bun run web
bun run ios
bun run android
```

`EXPO_PUBLIC_API_URL` is required and must name the API origin for the build.
There is no checked-in production fallback because no public Station API is
currently deployed.

The app contains workspace pages, databases, comments, sharing, notifications,
and settings. It does not contain provider SDKs, provider credentials, billing
credits, or legacy chat/Clarity surfaces.
