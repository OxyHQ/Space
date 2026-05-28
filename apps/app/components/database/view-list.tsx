import * as React from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { ChevronRight, Plus } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import type {
  Database,
  DatabaseRow,
  DatabaseView,
} from "@/lib/types/databases";
import { useCreateRow } from "@/lib/hooks/use-database-rows";
import { PropertyCell } from "./property-cell";

interface ViewListProps {
  database: Database;
  view: DatabaseView;
  rows: DatabaseRow[];
  isLoading: boolean;
}

/**
 * List view — vertical, minimal density. Title + a few preview props,
 * one row per line. Tapping a row navigates to its detail page.
 */
export function ViewList({
  database,
  view,
  rows,
  isLoading,
}: ViewListProps) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const createRow = useCreateRow();

  const visibleProperties = React.useMemo(() => {
    return database.schema.properties.filter(
      (p) => !view.hiddenProperties.includes(p.id) && p.id !== "name",
    );
  }, [database.schema.properties, view.hiddenProperties]);

  if (isLoading) {
    return (
      <View className="py-10 items-center">
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  }

  return (
    <ScrollView>
      {rows.map((row) => (
        <Pressable
          key={row.id}
          onPress={() => router.push(`/p/${row.id}`)}
          className="flex-row items-center gap-3 px-4 py-2 border-b border-border/40 hover:bg-muted/40"
        >
          <View className="flex-1">
            <Text
              className="text-sm font-medium text-foreground"
              numberOfLines={1}
            >
              {row.title || "Untitled"}
            </Text>
          </View>
          <View className="flex-row items-center gap-3">
            {visibleProperties.slice(0, 3).map((property) => (
              <View key={property.id}>
                <PropertyCell
                  property={property}
                  value={row.properties[property.id] ?? null}
                  variant="card"
                  onChange={() => router.push(`/p/${row.id}`)}
                />
              </View>
            ))}
          </View>
          <ChevronRight size={14} color={colors.mutedForeground} />
        </Pressable>
      ))}
      <Pressable
        onPress={() => createRow.mutate({ databaseId: database.id })}
        className="flex-row items-center gap-2 px-4 py-2 hover:bg-muted/40"
      >
        <Plus size={14} color={colors.mutedForeground} />
        <Text className="text-sm text-muted-foreground">
          {createRow.isPending ? "Adding…" : "New"}
        </Text>
      </Pressable>
    </ScrollView>
  );
}
