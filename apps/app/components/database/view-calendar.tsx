import * as React from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import type {
  Database,
  DatabaseRow,
  DatabaseView,
} from "@/lib/types/databases";

interface ViewCalendarProps {
  database: Database;
  view: DatabaseView;
  rows: DatabaseRow[];
  isLoading: boolean;
}

/**
 * Calendar view — month grid keyed on a date property. Web-first;
 * native rendering shows a list-style fallback per the Phase 4 spec.
 */
export function ViewCalendar({
  database,
  view,
  rows,
  isLoading,
}: ViewCalendarProps) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const [cursor, setCursor] = React.useState(() => startOfMonth(new Date()));

  const dateProperty = React.useMemo(() => {
    const id = view.config.datePropertyId;
    if (id) {
      const p = database.schema.properties.find((x) => x.id === id);
      if (p?.type === "date") return p;
    }
    return database.schema.properties.find((p) => p.type === "date") ?? null;
  }, [database.schema.properties, view.config.datePropertyId]);

  if (isLoading) {
    return (
      <View className="py-10 items-center">
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  }

  if (!dateProperty) {
    return (
      <View className="px-6 py-10">
        <Text className="text-sm text-muted-foreground">
          Add a date property to enable the calendar view.
        </Text>
      </View>
    );
  }

  if (Platform.OS !== "web") {
    // Native fallback — show rows grouped by month
    return (
      <View className="p-3">
        <Text className="text-sm text-muted-foreground">
          Calendar view is web-only in Phase 4. Open the table view on
          native to edit rows.
        </Text>
      </View>
    );
  }

  const days = buildMonthGrid(cursor);
  const rowsByDay = groupRowsByDay(rows, dateProperty.id);

  const monthLabel = cursor.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  return (
    <View className="p-3">
      <View className="flex-row items-center justify-between mb-3">
        <Text className="text-base font-semibold text-foreground">
          {monthLabel}
        </Text>
        <View className="flex-row gap-1">
          <Pressable
            onPress={() => setCursor(addMonths(cursor, -1))}
            className="p-1 rounded hover:bg-muted"
          >
            <ChevronLeft size={14} color={colors.foreground} />
          </Pressable>
          <Pressable
            onPress={() => setCursor(startOfMonth(new Date()))}
            className="px-2 py-1 rounded hover:bg-muted"
          >
            <Text className="text-xs text-foreground">Today</Text>
          </Pressable>
          <Pressable
            onPress={() => setCursor(addMonths(cursor, 1))}
            className="p-1 rounded hover:bg-muted"
          >
            <ChevronRight size={14} color={colors.foreground} />
          </Pressable>
        </View>
      </View>

      <View className="flex-row">
        {WEEKDAY_LABELS.map((label) => (
          <View
            key={label}
            className="flex-1 px-2 py-1 border-b border-border"
          >
            <Text className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {label}
            </Text>
          </View>
        ))}
      </View>

      <View>
        {chunk(days, 7).map((week, i) => (
          <View
            key={i}
            className="flex-row border-b border-border/60"
            style={{ minHeight: 100 }}
          >
            {week.map((day) => {
              const inMonth = day.getMonth() === cursor.getMonth();
              const key = day.toISOString().slice(0, 10);
              const dayRows = rowsByDay.get(key) ?? [];
              return (
                <View
                  key={day.toISOString()}
                  className={`flex-1 border-r border-border/60 p-1.5 ${
                    inMonth ? "" : "opacity-40"
                  }`}
                >
                  <Text className="text-xs text-foreground mb-1">
                    {day.getDate()}
                  </Text>
                  <View className="gap-1">
                    {dayRows.slice(0, 3).map((row) => (
                      <Pressable
                        key={row.id}
                        onPress={() => router.push(`/p/${row.id}`)}
                        className="bg-primary/10 rounded px-1.5 py-0.5"
                      >
                        <Text
                          className="text-xs text-foreground"
                          numberOfLines={1}
                        >
                          {row.title || "Untitled"}
                        </Text>
                      </Pressable>
                    ))}
                    {dayRows.length > 3 ? (
                      <Text className="text-[10px] text-muted-foreground">
                        +{dayRows.length - 3}
                      </Text>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </View>
        ))}
      </View>
    </View>
  );
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function buildMonthGrid(monthStart: Date): Date[] {
  const start = new Date(monthStart);
  start.setDate(start.getDate() - start.getDay());
  const result: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    result.push(d);
  }
  return result;
}

function groupRowsByDay(
  rows: DatabaseRow[],
  propertyId: string,
): Map<string, DatabaseRow[]> {
  const result = new Map<string, DatabaseRow[]>();
  for (const row of rows) {
    const value = row.properties[propertyId];
    if (!value || typeof value !== "object" || !("start" in value)) continue;
    const start = value.start;
    if (typeof start !== "string") continue;
    const d = new Date(start);
    if (Number.isNaN(d.getTime())) continue;
    const key = d.toISOString().slice(0, 10);
    const bucket = result.get(key) ?? [];
    bucket.push(row);
    result.set(key, bucket);
  }
  return result;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
