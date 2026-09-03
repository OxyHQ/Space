import { validateApiOrigin } from '../lib/api-origin';

validateApiOrigin(process.env.EXPO_PUBLIC_API_URL, true);
