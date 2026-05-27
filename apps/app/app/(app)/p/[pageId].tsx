import * as React from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Text } from "@/components/ui/text";
import { Editor } from "@/components/editor/editor";
import { ShareButton } from "@/components/sharing";
import { useColorScheme } from "@/lib/useColorScheme";
import { usePage, useUpdatePage } from "@/lib/hooks/use-pages";

/**
 * Page detail route. Renders editable title + the block editor.
 *
 * Title saves on blur (web) / endEditing (native). Editor handles its own
 * block-level autosave debouncing.
 */
export default function PageDetailRoute() {
  const params = useLocalSearchParams<{ pageId?: string | string[] }>();
  const pageId = Array.isArray(params.pageId) ? params.pageId[0] : params.pageId;

  if (!pageId) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        <Text className="text-base text-muted-foreground">No page selected.</Text>
      </View>
    );
  }

  // Key by pageId so all child state (title draft, editor refs) resets when
  // the route param changes — no useEffect-based prop sync needed.
  return <PageDetail pageId={pageId} key={pageId} />;
}

function PageDetail({ pageId }: { pageId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { data, isLoading, isError, error } = usePage(pageId);
  const updatePage = useUpdatePage();

  const [titleDraft, setTitleDraft] = React.useState<string | null>(null);

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  }

  if (isError || !data?.page) {
    const message =
      error instanceof Error ? error.message : "We couldn’t load this page.";
    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        <View className="max-w-md items-center gap-3">
          <Text className="text-base text-foreground">{message}</Text>
          <Pressable
            onPress={() => router.replace("/(app)")}
            className="rounded-md bg-primary px-4 py-2"
          >
            <Text className="text-sm font-medium text-primary-foreground">
              Back to workspace
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const page = data.page;
  const title = titleDraft ?? page.title;

  const handleTitleBlur = () => {
    if (titleDraft === null) return;
    if (titleDraft === page.title) {
      setTitleDraft(null);
      return;
    }
    updatePage.mutate({ id: page._id, title: titleDraft });
    setTitleDraft(null);
  };

  return (
    <View className="flex-1 bg-background">
      {/* Top bar with Share button. Phase 2 frontend integration point. */}
      <View className="h-12 px-4 md:px-6 flex-row items-center justify-end border-b border-border/30">
        <ShareButton pageId={page._id} />
      </View>

      <ScrollView
        className="flex-1"
        contentContainerClassName="px-6 md:px-10 py-8 max-w-3xl w-full mx-auto"
        keyboardShouldPersistTaps="handled"
      >
        <View className="gap-2 pb-4">
          {page.icon ? (
            <Text className="text-5xl leading-none">{page.icon}</Text>
          ) : null}
          <TitleInput
            value={title}
            onChangeText={setTitleDraft}
            onBlur={handleTitleBlur}
          />
        </View>

        <Editor pageId={page._id} />
      </ScrollView>
    </View>
  );
}

interface TitleInputProps {
  value: string;
  onChangeText: (next: string) => void;
  onBlur: () => void;
}

function TitleInput({ value, onChangeText, onBlur }: TitleInputProps) {
  const { colors } = useColorScheme();
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      onBlur={onBlur}
      placeholder="Untitled"
      placeholderTextColor={colors.mutedForeground}
      className="text-4xl font-bold text-foreground"
      multiline
      scrollEnabled={false}
      style={
        Platform.OS === "web"
          ? { outlineWidth: 0, borderWidth: 0, padding: 0 }
          : undefined
      }
      underlineColorAndroid="transparent"
    />
  );
}
