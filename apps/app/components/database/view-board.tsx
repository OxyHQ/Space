import * as React from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { Plus } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import type {
  Database,
  DatabaseProperty,
  DatabaseRow,
  DatabaseView,
  SelectOption,
} from "@/lib/types/databases";
import { useCreateRow, useUpdateRow } from "@/lib/hooks/use-database-rows";
import { PropertyCell } from "./property-cell";
import { SELECT_COLOR_CLASSES } from "./select-color";

interface ViewBoardProps {
  database: Database;
  view: DatabaseView;
  rows: DatabaseRow[];
  isLoading: boolean;
}

const COLUMN_WIDTH = 280;

/**
 * Board view — Kanban grouped by a select / status property. Each
 * column corresponds to one option of the group property; dragging a
 * card between columns updates the row's property value.
 *
 * Drag-and-drop runs on web via HTML5 DataTransfer. Native gets a
 * tap-to-move fallback (a "Move to…" affordance) — full DnD on native
 * is out of scope for Phase 4 (see spec).
 */
export function ViewBoard({
  database,
  view,
  rows,
  isLoading,
}: ViewBoardProps) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const createRow = useCreateRow();
  const updateRow = useUpdateRow();

  const groupByProperty = React.useMemo<DatabaseProperty | null>(() => {
    const target = view.groupBy?.propertyId;
    if (target) {
      const p = database.schema.properties.find((x) => x.id === target);
      if (p && (p.type === "select" || p.type === "status")) return p;
    }
    return (
      database.schema.properties.find(
        (p) => p.type === "status" || p.type === "select",
      ) ?? null
    );
  }, [database.schema.properties, view.groupBy?.propertyId]);

  const columns = React.useMemo(() => {
    const options = groupByProperty?.config?.options ?? [];
    const unassigned: DatabaseRow[] = [];
    const byOption = new Map<string, DatabaseRow[]>();
    for (const opt of options) byOption.set(opt.id, []);
    for (const row of rows) {
      if (!groupByProperty) {
        unassigned.push(row);
        continue;
      }
      const value = row.properties[groupByProperty.id];
      const optId =
        value && typeof value === "object" && "optionId" in value
          ? typeof value.optionId === "string"
            ? value.optionId
            : null
          : null;
      if (!optId) {
        unassigned.push(row);
        continue;
      }
      const bucket = byOption.get(optId);
      if (bucket) {
        bucket.push(row);
      } else {
        unassigned.push(row);
      }
    }
    return {
      options,
      byOption,
      unassigned,
    };
  }, [groupByProperty, rows]);

  const moveRow = React.useCallback(
    (rowId: string, optionId: string | null) => {
      if (!groupByProperty) return;
      updateRow.mutate({
        databaseId: database.id,
        rowId,
        properties: { [groupByProperty.id]: { optionId } },
      });
    },
    [database.id, groupByProperty, updateRow],
  );

  if (isLoading) {
    return (
      <View className="py-10 items-center">
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  }

  if (!groupByProperty) {
    return (
      <View className="px-6 py-10">
        <Text className="text-sm text-muted-foreground">
          Add a status or select property to use the board view.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator>
      <View className="flex-row gap-3 px-3 py-3">
        {columns.options.map((opt) => (
          <BoardColumn
            key={opt.id}
            option={opt}
            rows={columns.byOption.get(opt.id) ?? []}
            onAddRow={async () => {
              await createRow.mutateAsync({
                databaseId: database.id,
                properties: {
                  [groupByProperty.id]: { optionId: opt.id },
                },
              });
            }}
            onMoveTo={(rowId) => moveRow(rowId, opt.id)}
            renderCard={(row) => (
              <BoardCard
                row={row}
                database={database}
                onOpen={() => router.push(`/p/${row.id}`)}
              />
            )}
          />
        ))}
        <BoardColumn
          option={{
            id: "__unassigned__",
            name: "No status",
            color: "default",
          }}
          rows={columns.unassigned}
          onAddRow={async () => {
            await createRow.mutateAsync({ databaseId: database.id });
          }}
          onMoveTo={(rowId) => moveRow(rowId, null)}
          renderCard={(row) => (
            <BoardCard
              row={row}
              database={database}
              onOpen={() => router.push(`/p/${row.id}`)}
            />
          )}
        />
      </View>
    </ScrollView>
  );
}

interface BoardColumnProps {
  option: SelectOption;
  rows: DatabaseRow[];
  onAddRow: () => void;
  onMoveTo: (rowId: string) => void;
  renderCard: (row: DatabaseRow) => React.ReactNode;
}

function BoardColumn({
  option,
  rows,
  onAddRow,
  onMoveTo,
  renderCard,
}: BoardColumnProps) {
  const { colors } = useColorScheme();
  const palette = SELECT_COLOR_CLASSES[option.color] ?? SELECT_COLOR_CLASSES.default;

  // Web-only drag target — accept a row id payload from the dragged card.
  const dropHandlers =
    Platform.OS === "web"
      ? {
          onDragOver: (e: { preventDefault: () => void }) => e.preventDefault(),
          onDrop: (e: {
            preventDefault: () => void;
            dataTransfer: DataTransfer;
          }) => {
            e.preventDefault();
            const id = e.dataTransfer.getData("text/plain");
            if (id) onMoveTo(id);
          },
        }
      : {};

  return (
    <View
      className="bg-muted/40 rounded-lg p-2"
      style={{ width: COLUMN_WIDTH }}
      {...(dropHandlers as Record<string, unknown>)}
    >
      <View className="flex-row items-center justify-between mb-2 px-1">
        <View className="flex-row items-center gap-2">
          <View className={`px-2 py-0.5 rounded-md ${palette.bg}`}>
            <Text className={`text-xs ${palette.fg}`}>{option.name}</Text>
          </View>
          <Text className="text-xs text-muted-foreground">{rows.length}</Text>
        </View>
        <Pressable
          onPress={onAddRow}
          className="p-1 rounded hover:bg-muted"
        >
          <Plus size={14} color={colors.mutedForeground} />
        </Pressable>
      </View>
      <ScrollView style={{ maxHeight: 600 }}>
        <View className="gap-2">{rows.map((r) => renderCard(r))}</View>
      </ScrollView>
    </View>
  );
}

interface BoardCardProps {
  row: DatabaseRow;
  database: Database;
  onOpen: () => void;
}

function BoardCard({ row, database, onOpen }: BoardCardProps) {
  const visible = database.schema.properties.filter(
    (p) => p.id !== "name" && p.type !== "rollup" && p.type !== "formula",
  );

  const dragHandlers =
    Platform.OS === "web"
      ? {
          draggable: true,
          onDragStart: (e: { dataTransfer: DataTransfer }) => {
            e.dataTransfer.setData("text/plain", row.id);
            e.dataTransfer.effectAllowed = "move";
          },
        }
      : {};

  return (
    <Pressable
      onPress={onOpen}
      className="bg-card border border-border rounded-md px-3 py-2 shadow-sm"
      {...(dragHandlers as Record<string, unknown>)}
    >
      <Text
        className="text-sm font-medium text-foreground mb-1"
        numberOfLines={2}
      >
        {row.title || "Untitled"}
      </Text>
      <View className="gap-1">
        {visible.slice(0, 3).map((property) => (
          <View key={property.id} className="flex-row items-center gap-1">
            <PropertyCell
              property={property}
              value={row.properties[property.id] ?? null}
              variant="card"
              onChange={() => {
                // cards are not editable inline — opens row instead
                onOpen();
              }}
            />
          </View>
        ))}
      </View>
    </Pressable>
  );
}
