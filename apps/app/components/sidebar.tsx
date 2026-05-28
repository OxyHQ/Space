import React from "react";
import {
  View,
  Pressable,
  Platform,
  Linking,
  ScrollView,
  useWindowDimensions,
} from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import {
  ChevronsLeft,
  ChevronsRight,
  LogIn,
  UserPlus,
  Plus,
} from "lucide-react-native";
import { useTranslation } from "@/hooks/useTranslation";
import { useUIStore } from "@/lib/stores/ui-store";
import { useRouter, usePathname } from "expo-router";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { UserAvatar } from "@/components/user-avatar";
import { useOxy, showSignInModal } from "@oxyhq/services";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { OxySpaceWordmark } from "@/components/ui/oxy-space-wordmark";
import { WorkspaceSwitcher } from "@/components/workspace/workspace-switcher";
import { useColorScheme } from "@/lib/useColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";
import { useCreatePage } from "@/lib/hooks/use-pages";
import { useUnreadCount } from "@/lib/hooks/use-notifications";
import {
  SidebarSearchButton,
  SidebarInboxButton,
  SidebarSettingsButton,
  SidebarTrashButton,
  RecentsSection,
  FavoritesSection,
  PrivateSection,
  SharedSection,
  TemplatesSection,
  DatabaseSection,
} from "@/components/sidebar-sections";

/* ================================================================
   Root Sidebar — routes to settings sidebar when on /settings
   ================================================================ */

export function Sidebar() {
  const pathname = usePathname();
  const isSettingsRoute = pathname.startsWith("/settings");
  if (isSettingsRoute) return <SettingsSidebar />;
  return <WorkspaceSidebar />;
}

/* ================================================================
   Workspace sidebar — Notion-style sections
   ================================================================ */

const WorkspaceSidebar = React.memo(function WorkspaceSidebar() {
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const insets = useSafeAreaInsets();
  const dimensions = useWindowDimensions();
  const isLargeScreen = dimensions.width >= 768;

  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const toggleSidebarCollapsed = useUIStore((s) => s.toggleSidebarCollapsed);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const createPage = useCreatePage();

  const { user, isAuthenticated, logout, showBottomSheet } = useOxy();
  // Surface the Comments agent's unread count on the Inbox row.
  const { data: unreadData } = useUnreadCount();
  const unreadCount = unreadData?.count ?? 0;

  // Only allow collapse on large screens
  const isCollapsed = isLargeScreen && sidebarCollapsed;

  const handleHome = React.useCallback(
    () => router.replace("/(app)"),
    [router],
  );
  const handleSettings = React.useCallback(
    () => router.push("/(app)/settings"),
    [router],
  );
  const handleAccount = React.useCallback(
    () => showBottomSheet?.("AccountSettings"),
    [showBottomSheet],
  );
  const handleLogout = React.useCallback(() => {
    logout();
    router.replace("/(app)");
  }, [router, logout]);
  const handleLogin = React.useCallback(() => showSignInModal(), []);
  const handleUpgrade = React.useCallback(
    () => router.push("/(biglayout)/subscribe"),
    [router],
  );
  const handleBilling = React.useCallback(
    () => router.push("/(app)/settings/usage"),
    [router],
  );
  const handleNotifications = React.useCallback(
    () => router.push("/(app)/notifications"),
    [router],
  );
  const handleCreatePage = React.useCallback(async () => {
    if (!currentWorkspaceId) return;
    try {
      const page = await createPage.mutateAsync({
        workspaceId: currentWorkspaceId,
        parentId: null,
        title: "",
      });
      router.push(`/p/${page._id}`);
    } catch {
      /* mutation surfaces errors via state */
    }
  }, [createPage, currentWorkspaceId, router]);

  const displayName = React.useMemo(() => {
    if (!user) return t("common.user");
    if (user.name?.first)
      return user.name.last
        ? `${user.name.first} ${user.name.last}`
        : user.name.first;
    return user.username || t("common.user");
  }, [user, t]);

  /* ================================================================
     COLLAPSED LAYOUT
     ================================================================ */
  if (isCollapsed) {
    return (
      <View
        className="flex h-full flex-col bg-background border-r border-border items-center"
        style={{
          width: 48,
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
        }}
      >
        {/* Header: workspace switcher (auth) or logo (unauth) */}
        <View className="h-14 items-center justify-center shrink-0">
          {isAuthenticated ? (
            <WorkspaceSwitcher collapsed />
          ) : (
            <Pressable
              onPress={handleHome}
              className="h-14 items-center justify-center"
              accessibilityLabel="Home"
            >
              <OxySpaceWordmark width={20} color={colors.foreground} />
            </Pressable>
          )}
        </View>

        {/* Spacer */}
        <View className="flex-1" />

        {/* Footer: expand + avatar */}
        <View className="flex flex-col items-center gap-2 p-2 pt-1 shrink-0">
          <Pressable
            onPress={toggleSidebarCollapsed}
            accessibilityLabel="Expand sidebar"
            className="h-10 w-10 rounded-xl items-center justify-center hover:bg-muted"
          >
            <ChevronsRight size={18} color={colors.mutedForeground} />
          </Pressable>
          {isAuthenticated ? (
            <Pressable
              onPress={handleAccount}
              accessibilityLabel="Account"
              className="rounded-full h-10 w-10 flex p-1 items-center justify-center overflow-visible"
            >
              <UserAvatar size={32} />
            </Pressable>
          ) : (
            <Pressable
              onPress={handleLogin}
              accessibilityLabel="Sign in"
              className="rounded-full h-10 w-10 flex items-center justify-center bg-primary/10"
            >
              <Text className="text-sm font-bold text-primary">
                {(t("login.signInButton")[0] || "S").toUpperCase()}
              </Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }

  /* ================================================================
     EXPANDED LAYOUT
     ================================================================ */
  return (
    <View
      className="flex h-full w-full flex-col bg-background border-r border-border"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      {/* Header: workspace switcher (auth) or logo (unauth) + collapse button */}
      <View className="h-14 flex-row items-center shrink-0 px-2 gap-1">
        {isAuthenticated ? (
          <WorkspaceSwitcher />
        ) : (
          <Pressable
            onPress={handleHome}
            className="p-1 mx-0.5 shrink-0 rounded-xl hover:bg-muted"
            accessibilityLabel="Home"
          >
            <OxySpaceWordmark
              height={24}
              width={62}
              color={colors.foreground}
            />
          </Pressable>
        )}
        {isLargeScreen && (
          <View className="shrink-0">
            <Pressable
              onPress={toggleSidebarCollapsed}
              accessibilityLabel="Collapse sidebar"
              className="h-10 w-10 rounded-xl items-center justify-center hover:bg-muted"
            >
              <ChevronsLeft size={18} color={colors.mutedForeground} />
            </Pressable>
          </View>
        )}
      </View>

      {/* Scrollable middle: search + nav + sections */}
      <ScrollView
        className="min-h-0 flex-1"
        showsVerticalScrollIndicator={false}
      >
        {isAuthenticated ? (
          <View className="px-1 py-1 gap-0.5">
            <SidebarSearchButton />
            <SidebarInboxButton unreadCount={unreadCount} />
            <SidebarSettingsButton />
          </View>
        ) : null}

        {isAuthenticated && currentWorkspaceId ? (
          <View className="mt-2">
            <RecentsSection />
            <FavoritesSection />
            <PrivateSection />
            <SharedSection />
            <DatabaseSection />
            <TemplatesSection />
          </View>
        ) : null}

        {isAuthenticated ? (
          <View className="mt-2 px-1">
            <SidebarTrashButton />
          </View>
        ) : null}
      </ScrollView>

      {/* + New page (visible when authenticated) */}
      {isAuthenticated && currentWorkspaceId ? (
        <View className="px-2 pt-1">
          <Pressable
            onPress={handleCreatePage}
            accessibilityLabel="New page"
            accessibilityRole="button"
            disabled={createPage.isPending}
            className="flex-row items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60 active:bg-muted/60"
          >
            <Plus size={14} color={colors.mutedForeground} />
            <Text className="text-sm text-muted-foreground">New page</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Divider */}
      <View className="mx-2 border-t border-border/30 mt-2" />

      {/* Footer: user avatar / sign-in */}
      <View className="flex flex-col gap-2 mt-auto shrink-0 p-2 pt-1">
        {isAuthenticated ? (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <Pressable
                accessibilityLabel="Account menu"
                accessibilityRole="button"
                className="flex-row items-center gap-2 rounded-md px-1 py-1 hover:bg-muted/60"
              >
                <View className="rounded-full h-9 w-9 p-1 overflow-visible items-center justify-center">
                  <UserAvatar size={28} />
                </View>
                <Text
                  className="flex-1 text-sm font-medium text-foreground"
                  numberOfLines={1}
                >
                  {displayName}
                </Text>
              </Pressable>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content>
              {Platform.OS === "web" ? (
                <View className="flex-row items-center gap-2.5 px-2 py-2">
                  <UserAvatar size={36} />
                  <View>
                    <Text className="text-sm font-semibold text-foreground">
                      {displayName}
                    </Text>
                    {user?.username ? (
                      <Text className="text-xs text-muted-foreground">
                        {user.username}@oxy.so
                      </Text>
                    ) : null}
                  </View>
                </View>
              ) : (
                <DropdownMenu.Label>{displayName}</DropdownMenu.Label>
              )}
              <DropdownMenu.Separator />
              <DropdownMenu.Item key="upgrade" onSelect={handleUpgrade}>
                <DropdownMenu.ItemIcon ios={{ name: "sparkle" }} />
                <DropdownMenu.ItemTitle>
                  {t("sidebar.upgradeToPro")}
                </DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Item key="account" onSelect={handleAccount}>
                <DropdownMenu.ItemIcon ios={{ name: "person.circle" }} />
                <DropdownMenu.ItemTitle>
                  {t("sidebar.account")}
                </DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Item key="billing" onSelect={handleBilling}>
                <DropdownMenu.ItemIcon ios={{ name: "creditcard" }} />
                <DropdownMenu.ItemTitle>
                  {t("sidebar.billing")}
                </DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Item key="notifications" onSelect={handleNotifications}>
                <DropdownMenu.ItemIcon ios={{ name: "bell" }} />
                <DropdownMenu.ItemTitle>
                  {unreadCount > 0
                    ? `${t("sidebar.notifications")} (${unreadCount})`
                    : t("sidebar.notifications")}
                </DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Item key="settings" onSelect={handleSettings}>
                <DropdownMenu.ItemIcon ios={{ name: "gearshape" }} />
                <DropdownMenu.ItemTitle>
                  {t("sidebar.settings")}
                </DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                key="terms"
                onSelect={() =>
                  Linking.openURL(
                    "https://oxy.so/company/transparency/policies/terms-of-service",
                  )
                }
              >
                <DropdownMenu.ItemIcon ios={{ name: "doc.text" }} />
                <DropdownMenu.ItemTitle>
                  {t("sidebar.termsOfService")}
                </DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                key="privacy"
                onSelect={() =>
                  Linking.openURL(
                    "https://oxy.so/company/transparency/policies/privacy",
                  )
                }
              >
                <DropdownMenu.ItemIcon ios={{ name: "hand.raised" }} />
                <DropdownMenu.ItemTitle>
                  {t("sidebar.privacyPolicy")}
                </DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                key="logout"
                destructive
                onSelect={handleLogout}
              >
                <DropdownMenu.ItemIcon
                  ios={{ name: "rectangle.portrait.and.arrow.right" }}
                />
                <DropdownMenu.ItemTitle>
                  {t("sidebar.logOut")}
                </DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        ) : (
          <View className="gap-2">
            <Button
              onPress={handleLogin}
              className="h-11 md:h-9 rounded-full w-full"
            >
              <View className="flex-row items-center gap-2 md:gap-1.5">
                <LogIn size={16} className="text-primary-foreground" />
                <Text className="text-sm md:text-xs font-semibold text-primary-foreground">
                  {t("login.signInButton")}
                </Text>
              </View>
            </Button>
            <Button
              onPress={handleLogin}
              variant="outline"
              className="h-11 md:h-9 rounded-full w-full"
            >
              <View className="flex-row items-center gap-2 md:gap-1.5">
                <UserPlus size={16} className="text-foreground" />
                <Text className="text-sm md:text-xs font-medium">
                  {t("login.footerLink")}
                </Text>
              </View>
            </Button>
            <View className="flex-row items-center justify-center gap-1 mt-1">
              <Text
                className="text-[10px] text-muted-foreground underline"
                onPress={() =>
                  Linking.openURL(
                    "https://oxy.so/company/transparency/policies/privacy",
                  )
                }
              >
                {t("sidebar.privacyPolicy")}
              </Text>
              <Text className="text-[10px] text-muted-foreground">·</Text>
              <Text
                className="text-[10px] text-muted-foreground underline"
                onPress={() =>
                  Linking.openURL(
                    "https://oxy.so/company/transparency/policies/terms-of-service",
                  )
                }
              >
                {t("sidebar.termsOfService")}
              </Text>
            </View>
          </View>
        )}
      </View>
    </View>
  );
});
