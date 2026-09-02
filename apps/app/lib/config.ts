/**
 * Centralized API configuration. Station has no implicit production API:
 * every build must name the backend it is intended to call.
 */
const apiUrl = process.env.EXPO_PUBLIC_API_URL;

if (!apiUrl) {
  throw new Error('EXPO_PUBLIC_API_URL is required');
}

const parsedApiUrl = new URL(apiUrl);

if (
  !['http:', 'https:'].includes(parsedApiUrl.protocol) ||
  parsedApiUrl.pathname !== '/' ||
  parsedApiUrl.username ||
  parsedApiUrl.password ||
  parsedApiUrl.search ||
  parsedApiUrl.hash
) {
  throw new Error('EXPO_PUBLIC_API_URL must be an HTTP(S) origin without path, credentials, query, or fragment');
}

export default {
  apiUrl: parsedApiUrl.origin,
};
