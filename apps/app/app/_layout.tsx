import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useMemo, useState } from 'react';
import { OxyProvider, useOxy } from '@oxyhq/services';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Linking from 'expo-linking';
import { Platform, View } from 'react-native';
import { vars } from 'nativewind';

import { AppErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/sonner';
import { KeyboardProvider } from '@/lib/keyboard';
import { useColorScheme } from '@/lib/useColorScheme';
import { useThemeStore } from '@/lib/stores/theme-store';
import { getAppColorVars, applyAppColorToDocument } from '@/lib/app-color-presets';
import { setTokenGetter } from '@/lib/api/client';
import 'react-native-reanimated';
import '../global.css';
import '@/lib/i18n';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(app)',
};

SplashScreen.preventAutoHideAsync();

const OXY_API_URL = process.env.EXPO_PUBLIC_OXY_API_URL || 'https://api.oxy.so';
const AUTH_REDIRECT_URI = Linking.createURL('/');

function AuthSetup({ children }: { children: React.ReactNode }) {
  const { oxyServices } = useOxy();

  // Set synchronously so token is available before child queries fire
  setTokenGetter(() => oxyServices.getAccessToken() || null);

  return <>{children}</>;
}

function AppContent() {
  const { colors, colorScheme } = useColorScheme();
  const appColor = useThemeStore((s) => s.appColor);

  // Web: apply app color CSS variables to document
  useEffect(() => {
    applyAppColorToDocument(appColor, colorScheme);
  }, [appColor, colorScheme]);

  // Native: cascade app color CSS variables via NativeWind vars()
  const colorVars = useMemo(() => {
    return vars(getAppColorVars(appColor, colorScheme));
  }, [appColor, colorScheme]);

  const stack = (
    <Stack
      screenOptions={{
        contentStyle: {
          backgroundColor: colors.background,
        },
      }}
    >
      <Stack.Screen name="(app)" options={{ headerShown: false }} />
      <Stack.Screen name="(biglayout)" options={{ headerShown: false }} />
      <Stack.Screen name="share/[token]" options={{ headerShown: false }} />
    </Stack>
  );

  return (
    <AuthSetup>
      <View style={[{ flex: 1 }, colorVars]}>
        <KeyboardProvider>{stack}</KeyboardProvider>
        <Toaster />
      </View>
    </AuthSetup>
  );
}

function RootLayout() {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  }));

  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
    Inter: require('../assets/fonts/Inter-VariableFont_opsz,wght.ttf'),
    'Inter-Italic': require('../assets/fonts/Inter-Italic-VariableFont_opsz,wght.ttf'),
    ...FontAwesome.font,
  });

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) SplashScreen.hideAsync();
  }, [loaded]);

  if (!loaded) return null;

  return (
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <OxyProvider
          baseURL={OXY_API_URL}
          authRedirectUri={Platform.OS !== 'web' ? AUTH_REDIRECT_URI : undefined}
        >
          <AppContent />
        </OxyProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}

export default RootLayout;
