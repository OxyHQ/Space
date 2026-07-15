import { useEffect } from 'react';
import { useRouter, useLocalSearchParams } from 'expo-router';

export default function AuthorizeCodeaScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();

  useEffect(() => {
    // Redirect to unified authorize screen with app=codea
    const forwarded: Record<string, string> = { app: 'codea' };
    Object.entries(params).forEach(([key, value]) => {
      if (!value) return;
      forwarded[key] = Array.isArray(value) ? value.join(',') : value;
    });

    router.replace({ pathname: '/authorize', params: forwarded });
  }, [params, router]);

  return null;
}
