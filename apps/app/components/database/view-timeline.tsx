import * as React from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import type {
  Database,
  DatabaseRow,
  DatabaseView,
} from "@/lib/types/databases";

interface ViewTimelineProps {
  database: Database;
  view: DatabaseView;
  rows: DatabaseRow[];
  isLoading: boolean;
}

const DAY_WIDTH = 28; // px per day on web
const DAYS_WINDOW = 60;

/**
 * Timeline view — Gantt-style. Reads a `startPropertyId` (and optional
 * `endPropertyId`) date property and lays out a horizontal bar per row.
 * Web-only in Phase 4 — native shows a fallback list.
 */
export function ViewTimeline({
  database,
  view,
  rows,
  isLoading,
}: ViewTimelineProps) {
  const router = useRouter();
  const { colors } = useColorScheme();

  const startProperty = React.useMemo(() => {
    const id = view.config.startPropertyId;
    if (id) {
      const p = database.schema.properties.find((x) => x.id === id);
      if (p?.type === "date") return p;
    }
    return database.schema.properties.find((p) => p.type === "date") ?? null;
  }, [database.schema.properties, view.config.startPropertyId]);

  const endProperty = React.useMemo(() => {
    const id = view.config.endPropertyId;
    if (!id) return null;
    const p = database.schema.properties.find((x) => x.id === id);
    return p?.type === "date" ? p : null;
  }, [database.schema.properties, view.config.endPropertyId]);

  if (isLoading) {
    return (
      <View className="py-10 items-center">
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  }

  if (!startProperty) {
    return (
      <View className="px-6 py-10">
        <Text className="text-sm text-muted-foreground">
          Add a date property to enable the timeline view.
        </Text>
      </View>
    );
  }

  if (Platform.OS !== "web") {
    return (
      <View className="p-3">
        <Text className="text-sm text-muted-foreground">
          Timeline view is web-only in Phase 4. Open the table view on
          native to see your rows.
        </Text>
      </View>
    );
  }

  const today = startOfDay(new Date());
  const windowStart = new Date(today);
  windowStart.setDate(today.getDate() - 7);
  const windowEnd = new Date(windowStart);
  windowEnd.setDate(windowStart.getDate() + DAYS_WINDOW);

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator>
      <View>
        {/* date header */}
        <View
          className="flex-row border-b border-border bg-muted/30"
          style={{ height: 32, minWidth: DAY_WIDTH * DAYS_WINDOW + 240 }}
        >
          <View
            style={{ width: 240 }}
            className="px-3 py-1 justify-center border-r border-border"
          >
            <Text className="text-xs font-semibold uppercase text-muted-foreground">
              Row
            </Text>
          </View>
          {Array.from({ length: DAYS_WINDOW }).map((_, i) => {
            const day = new Date(windowStart);
            day.setDate(windowStart.getDate() + i);
            const isFirstOfMonth = day.getDate() === 1;
            return (
              <View
                key={i}
                style={{ width: DAY_WIDTH }}
                className="items-center justify-center border-r border-border/60"
              >
                <Text className="text-[10px] text-muted-foreground">
                  {isFirstOfMonth
                    ? day.toLocaleString(undefined, { month: "short" })
                    : day.getDate()}
                </Text>
              </View>
            );
          })}
        </View>

        {/* rows */}
        {rows.map((row) => {
          const startStr = readDateStart(row, startProperty.id);
          const endStr = endProperty
            ? readDateStart(row, endProperty.id)
            : null;
          if (!startStr) return null;
          const start = startOfDay(new Date(startStr));
          const end = endStr ? startOfDay(new Date(endStr)) : start;
          if (
            end.getTime() < windowStart.getTime() ||
            start.getTime() > windowEnd.getTime()
          ) {
            return null;
          }
          const offsetDays = Math.max(
            0,
            Math.round((start.getTime() - windowStart.getTime()) / 86_400_000),
          );
          const spanDays = Math.max(
            1,
            Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1,
          );
          return (
            <View
              key={row.id}
              className="flex-row border-b border-border/60"
              style={{ height: 36, minWidth: DAY_WIDTH * DAYS_WINDOW + 240 }}
            >
              <View
                style={{ width: 240 }}
                className="px-3 justify-center border-r border-border/60"
              >
                <Text className="text-sm text-foreground" numberOfLines={1}>
                  {row.title || "Untitled"}
                </Text>
              </View>
              <View style={{ position: "relative", flexDirection: "row" }}>
                <View
                  style={{
                    width: DAY_WIDTH * DAYS_WINDOW,
                    height: 36,
                    position: "relative",
                  }}
                />
                <Pressable
                  onPress={() => router.push(`/p/${row.id}`)}
                  style={{
                    position: "absolute",
                    left: offsetDays * DAY_WIDTH + 2,
                    top: 6,
                    width: spanDays * DAY_WIDTH - 4,
                    height: 24,
                  }}
                  className="bg-primary/20 border border-primary/50 rounded-md justify-center px-2"
                >
                  <Text
                    className="text-[11px] text-primary"
                    numberOfLines={1}
                  >
                    {row.title || "Untitled"}
                  </Text>
                </Pressable>
              </View>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function readDateStart(row: DatabaseRow, propertyId: string): string | null {
  const value = row.properties[propertyId];
  if (!value || typeof value !== "object" || !("start" in value)) return null;
  const start = value.start;
  return typeof start === "string" ? start : null;
}
