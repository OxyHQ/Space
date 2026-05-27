import React from "react";
import {
  View,
  ScrollView,
  Pressable,
  Platform,
  Linking,
  ActivityIndicator,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import axios from "axios";
import { Text } from "@/components/ui/text";
import { OxySpaceWordmark } from "@/components/ui/oxy-space-wordmark";
import { useColorScheme } from "@/lib/useColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  useSharedPage,
  type SharedPage,
} from "@/lib/hooks/use-share-links";
import { SharedBlockRenderer } from "@/components/sharing/shared-block-renderer";

interface ShareLoadStateProps {
  title: string;
  body: string;
}

function ShareLoadState({ title, body }: ShareLoadStateProps) {
  return (
    <View className="flex-1 items-center justify-center px-6 gap-3">
      <Text className="text-xl font-semibold text-foreground text-center">
        {title}
      </Text>
      <Text className="text-sm text-muted-foreground text-center max-w-md">
        {body}
      </Text>
    </View>
  );
}

function ShareFooter() {
  const handlePress = React.useCallback(() => {
    const url = "https://space.oxy.so";
    if (Platform.OS === "web") {
      if (typeof window !== "undefined") {
        window.open(url, "_blank", "noopener");
      }
      return;
    }
    Linking.openURL(url).catch(() => {
      /* user-driven, ignore failure */
    });
  }, []);

  return (
    <Pressable
      onPress={handlePress}
      className="flex-row items-center justify-center gap-2 py-4"
      accessibilityRole="link"
      accessibilityLabel="Made with Oxy Space"
    >
      <Text className="text-xs text-muted-foreground">Made with</Text>
      <OxySpaceWordmark width={70} />
    </Pressable>
  );
}

export default function PublicSharePage() {
  const insets = useSafeAreaInsets();
  const { colors } = useColorScheme();
  const params = useLocalSearchParams<{ token: string }>();
  const token = typeof params.token === "string" ? params.token : null;

  const { data, isLoading, isError, error } = useSharedPage(token);

  if (!token) {
    return (
      <View
        className="flex-1 bg-background"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <ShareLoadState
          title="Invalid share link"
          body="This URL is missing its share token. Double-check the link you opened."
        />
        <ShareFooter />
      </View>
    );
  }

  if (isLoading) {
    return (
      <View
        className="flex-1 bg-background items-center justify-center"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <ActivityIndicator color={colors.foreground} />
      </View>
    );
  }

  if (isError || !data) {
    const status = axios.isAxiosError(error) ? error.response?.status : null;
    let title = "Link unavailable";
    let body = "We couldn't load this shared page.";
    if (status === 404) {
      title = "Link not found";
      body =
        "This share link has been revoked or never existed. Ask the page owner for a new link.";
    } else if (status === 410) {
      title = "Link expired";
      body = "This share link has expired. Ask the page owner for a new link.";
    } else if (error instanceof Error && error.message) {
      body = error.message;
    }
    return (
      <View
        className="flex-1 bg-background"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <ShareLoadState title={title} body={body} />
        <ShareFooter />
      </View>
    );
  }

  return (
    <View
      className="flex-1 bg-background"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-5 py-8 sm:px-8 sm:py-12 md:px-12"
      >
        <View className="w-full max-w-3xl mx-auto gap-4">
          <SharedPageHeader page={data.page} />
          <View className="gap-1.5">
            {data.blocks.length === 0 ? (
              <Text className="text-sm text-muted-foreground">
                This page is empty.
              </Text>
            ) : (
              data.blocks.map((block) => (
                <SharedBlockRenderer key={block._id} block={block} />
              ))
            )}
          </View>
        </View>
      </ScrollView>
      <ShareFooter />
    </View>
  );
}

function SharedPageHeader({ page }: { page: SharedPage["page"] }) {
  return (
    <View className="gap-2">
      {page.icon ? (
        <Text className="text-4xl" style={{ lineHeight: 48 }}>
          {page.icon}
        </Text>
      ) : null}
      <Text className="text-3xl font-bold text-foreground sm:text-4xl">
        {page.title?.trim() ? page.title : "Untitled"}
      </Text>
    </View>
  );
}
