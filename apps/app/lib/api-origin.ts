export function validateApiOrigin(value: string | undefined, requireHttps: boolean): string {
  if (!value || value.trim() !== value) {
    throw new Error('EXPO_PUBLIC_API_URL is required and must not contain surrounding whitespace');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (_error: unknown) {
    throw new Error('EXPO_PUBLIC_API_URL must be a valid HTTP(S) origin');
  }

  const allowedProtocol = requireHttps
    ? parsed.protocol === 'https:'
    : parsed.protocol === 'http:' || parsed.protocol === 'https:';

  if (
    !allowedProtocol ||
    parsed.pathname !== '/' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      requireHttps
        ? 'EXPO_PUBLIC_API_URL must be an HTTPS origin without path, credentials, query, or fragment'
        : 'EXPO_PUBLIC_API_URL must be an HTTP(S) origin without path, credentials, query, or fragment',
    );
  }

  return parsed.origin;
}
