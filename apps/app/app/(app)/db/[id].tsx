import * as React from "react";
import {
  ActivityIndicator,
  Pressable,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import { useDatabase } from "@/lib/hooks/use-databases";
import { useDatabaseRows } from "@/lib/hooks/use-database-rows";
import { DatabaseHeader } from "@/components/database/database-header";
import { DatabaseViewContainer } from "@/components/database/database-view";

/**
 * Full-page database route. Renders the header (name + cover + view tabs)
 * and the active view body. The view selection persists in-component
 * state — refresh shows the default view.
 */
export default function DatabaseRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  if (!id) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        <Text className="text-base text-muted-foreground">
          No database selected.
        </Text>
      </View>
    );
  }
  return <DatabasePage id={id} key={id} />;
}

function DatabasePage({ id }: { id: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { data, isLoading, isError, error } = useDatabase(id);

  const [activeViewId, setActiveViewId] = React.useState<string | null>(null);

  // Pick the default view once the database loads.
  const views = data?.views ?? [];
  const defaultViewId = React.useMemo(
    () => views.find((v) => v.isDefault)?.id ?? views[0]?.id ?? null,
    [views],
  );
  const selectedViewId = activeViewId ?? defaultViewId;

  const selectedView = views.find((v) => v.id === selectedViewId) ?? null;
  const { data: rowsData, isLoading: isLoadingRows } = useDatabaseRows(
    id,
    selectedViewId,
  );

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  }

  if (isError || !data?.database) {
    const message =
      error instanceof Error ? error.message : "We couldn’t load this database.";
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

  return (
    <View className="flex-1 bg-background">
      <DatabaseHeader
        database={data.database}
        views={views}
        activeViewId={selectedViewId}
        onSelectView={setActiveViewId}
      />
      {selectedView ? (
        <DatabaseViewContainer
          database={data.database}
          view={selectedView}
          rows={rowsData?.rows ?? []}
          isLoading={isLoadingRows}
        />
      ) : (
        <View className="flex-1 items-center justify-center">
          <Text className="text-sm text-muted-foreground">
            No views configured yet.
          </Text>
        </View>
      )}
    </View>
  );
}
