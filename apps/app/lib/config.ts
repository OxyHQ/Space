import { validateApiOrigin } from './api-origin';

export default {
  apiUrl: validateApiOrigin(
    process.env.EXPO_PUBLIC_API_URL,
    process.env.NODE_ENV === 'production',
  ),
};
