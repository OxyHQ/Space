import { Drawer } from 'expo-router/drawer';
import { Sidebar } from '@/components/sidebar';
import { AppErrorBoundary } from '@/components/error-boundary';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { View, Platform, useWindowDimensions } from 'react-native';
import { useCallback } from 'react';
import { useColorScheme } from '@/lib/useColorScheme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUIStore } from '@/lib/stores/ui-store';
import i18n from '@/lib/i18n';
import { useNotificationSetup } from '@/lib/hooks/use-notification-setup';

// Routes that handle their own top safe area insets
const SELF_INSET_ROUTES = new Set(['index', 'settings']);

const SIDEBAR_WIDTH_EXPANDED = 256;
const SIDEBAR_WIDTH_COLLAPSED = 48;

export default function AppLayout() {
  const dimensions = useWindowDimensions();
  const isLargeScreen = dimensions.width >= 768;
  const { colors } = useColorScheme();
  const insets = useSafeAreaInsets();
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);

  // Push notification registration, tap handling, and real-time subscription
  useNotificationSetup();

  const renderDrawerContent = useCallback(() => <Sidebar />, []);

  // On large screens, use collapsed width when collapsed; on mobile always expanded
  const drawerWidth = isLargeScreen && sidebarCollapsed
    ? SIDEBAR_WIDTH_COLLAPSED
    : SIDEBAR_WIDTH_EXPANDED;

  const screenOptions = useCallback(({ route }: { route: { name: string } }) => ({
    headerShown: false,
    sceneContainerStyle: {
      paddingTop: SELF_INSET_ROUTES.has(route.name) || route.name.startsWith('settings/') ? 0 : insets.top,
    },
    drawerStyle: {
      width: drawerWidth,
      backgroundColor: colors.background,
      borderRightWidth: 0,
      boxShadow: 'none' as const,
      elevation: 0,
      // Smooth collapse/expand transition on web (desktop only)
      ...(Platform.OS === 'web' && isLargeScreen && {
        transitionProperty: 'width',
        transitionDuration: '200ms',
        transitionTimingFunction: 'ease-out',
      }),
    },
    drawerType: isLargeScreen ? ('permanent' as const) : ('front' as const),
    swipeEnabled: !isLargeScreen,
    overlayColor: isLargeScreen ? 'transparent' : 'rgba(0, 0, 0, 0.5)',
    // Hide all built-in drawer items; the custom Sidebar renders its own navigation
    drawerItemStyle: { display: 'none' as const },
  }), [insets.top, colors.background, isLargeScreen, drawerWidth]);

  return (
    <AppErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        {/* root: isolate flex h-screen */}
        <View className="isolate flex h-screen flex-row">
          {/* main: isolate flex h-auto max-h-screen min-w-0 grow flex-col */}
          <View className="isolate flex h-auto max-h-screen min-w-0 grow flex-col">
            {/* content-area: relative isolate min-h-0 flex-1 overflow-hidden bg-background */}
            <View className="relative isolate min-h-0 flex-1 overflow-hidden bg-background">
              <Drawer
                drawerContent={renderDrawerContent}
                screenOptions={screenOptions}
              >
                <Drawer.Screen
                  name="settings/index"
                  options={{
                    drawerLabel: i18n.t('nav.settings'),
                    title: i18n.t('nav.settings'),
                  }}
                />
              </Drawer>
            </View>
          </View>
        </View>
      </GestureHandlerRootView>
    </AppErrorBoundary>
  );
}
