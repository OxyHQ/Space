import React from "react";
import { View, ScrollView } from "react-native";
import { useOxy } from "@oxyhq/services";
import { useRouter } from "expo-router";
import { Text } from "@/components/ui/text";
import { SettingsHeader } from "@/components/settings/settings-header";
import { MembersSection } from "@/components/workspace/members-section";

export default function SettingsMembersScreen() {
  const router = useRouter();
  const { isAuthenticated } = useOxy();

  React.useEffect(() => {
    if (!isAuthenticated) {
      router.replace("/(app)");
    }
  }, [isAuthenticated, router]);

  if (!isAuthenticated) return null;

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title="Members" />
      <ScrollView
        className="flex-1"
        contentContainerClassName="p-5 max-w-3xl gap-6"
      >
        <View className="gap-1">
          <Text className="text-base font-semibold text-foreground">
            Workspace members
          </Text>
          <Text className="text-sm text-muted-foreground">
            Invite people to your workspace and manage their roles. Only
            workspace admins and owners can change roles or remove members.
          </Text>
        </View>
        <MembersSection />
      </ScrollView>
    </View>
  );
}
