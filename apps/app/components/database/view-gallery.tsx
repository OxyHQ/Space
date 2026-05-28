import * as React from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { ImageIcon, Plus } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import type {
  Database,
  DatabaseRow,
  DatabaseView,
} from "@/lib/types/databases";
import { useCreateRow } from "@/lib/hooks/use-database-rows";
import { PropertyCell } from "./property-cell";

interface ViewGalleryProps {
  database: Database;
  view: DatabaseView;
  rows: DatabaseRow[];
  isLoading: boolean;
}

const CARD_WIDTH = 240;

/**
 * Gallery view — grid of cards. Each card shows the row's cover (or a
 * configured file property), title, and a few preview properties.
 */
export function ViewGallery({
  database,
  view,
  rows,
  isLoading,
}: ViewGalleryProps) {
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
      <View className="flex-row flex-wrap gap-3 p-3">
        {rows.map((row) => {
          const cover = readCover(row, view, database);
          return (
            <Pressable
              key={row.id}
              onPress={() => router.push(`/p/${row.id}`)}
              className="bg-card border border-border rounded-xl overflow-hidden"
              style={{ width: CARD_WIDTH }}
            >
              <View
                className="h-32 bg-muted items-center justify-center"
              >
                {cover ? (
                  // We render <img> on web; native shows the placeholder.
                  // Phase 4 keeps it light — no react-native Image to avoid
                  // remote-url permissions complications.
                  cover.kind === "url" && typeof window !== "undefined" ? (
                    <img
                      src={cover.url}
                      alt=""
                      style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "cover",
                      }}
                    />
                  ) : (
                    <ImageIcon size={28} color="#9ca3af" />
                  )
                ) : (
                  <ImageIcon size={24} color="#cbd5e1" />
                )}
              </View>
              <View className="p-3 gap-1">
                <Text
                  className="text-sm font-medium text-foreground"
                  numberOfLines={2}
                >
                  {row.title || "Untitled"}
                </Text>
                <View className="gap-1">
                  {visibleProperties.slice(0, 3).map((property) => (
                    <View
                      key={property.id}
                      className="flex-row items-center gap-2"
                    >
                      <PropertyCell
                        property={property}
                        value={row.properties[property.id] ?? null}
                        variant="card"
                        onChange={() => router.push(`/p/${row.id}`)}
                      />
                    </View>
                  ))}
                </View>
              </View>
            </Pressable>
          );
        })}

        <Pressable
          onPress={() => createRow.mutate({ databaseId: database.id })}
          className="border border-dashed border-border rounded-xl items-center justify-center"
          style={{ width: CARD_WIDTH, height: 200 }}
        >
          <Plus size={20} color={colors.mutedForeground} />
          <Text className="text-sm text-muted-foreground mt-1">
            {createRow.isPending ? "Adding…" : "New card"}
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

function readCover(
  row: DatabaseRow,
  view: DatabaseView,
  database: Database,
): { kind: "url"; url: string } | null {
  const source = view.config.coverSource ?? "pageCover";
  if (source === "pageCover" && row.cover) {
    return { kind: "url", url: row.cover };
  }
  if (source === "property" && view.config.coverPropertyId) {
    const property = database.schema.properties.find(
      (p) => p.id === view.config.coverPropertyId,
    );
    if (property?.type === "files") {
      const value = row.properties[property.id];
      if (value && typeof value === "object" && "files" in value) {
        const files = value.files;
        if (Array.isArray(files) && files.length > 0) {
          const first = files[0];
          if (
            first &&
            typeof first === "object" &&
            "url" in first &&
            typeof first.url === "string"
          ) {
            return { kind: "url", url: first.url };
          }
        }
      }
    }
  }
  return null;
}
