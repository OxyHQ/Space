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
  PropertyValue,
} from "@/lib/types/databases";
import { useCreateRow, useUpdateRow } from "@/lib/hooks/use-database-rows";
import { PropertyCell } from "./property-cell";
import { PropertyHeaderMenu } from "./property-config-modal";

interface ViewTableProps {
  database: Database;
  view: DatabaseView;
  rows: DatabaseRow[];
  isLoading: boolean;
}

const DEFAULT_COL_WIDTH = 200;
const TITLE_COL_WIDTH = 280;

/**
 * Table view — spreadsheet-style. Renders the row's title in a fixed
 * first column, then one column per visible property. Each cell uses the
 * shared `PropertyCell` so editing is consistent across views.
 */
export function ViewTable({ database, view, rows, isLoading }: ViewTableProps) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const createRow = useCreateRow();
  const updateRow = useUpdateRow();

  const visibleProperties = React.useMemo(() => {
    return database.schema.properties.filter(
      (p) => !view.hiddenProperties.includes(p.id) && p.id !== "name",
    );
  }, [database.schema.properties, view.hiddenProperties]);

  const handleNewRow = React.useCallback(async () => {
    await createRow.mutateAsync({ databaseId: database.id });
  }, [createRow, database.id]);

  const handleCellChange = React.useCallback(
    (rowId: string, propertyId: string, value: PropertyValue) => {
      updateRow.mutate({
        databaseId: database.id,
        rowId,
        properties: { [propertyId]: value },
      });
    },
    [database.id, updateRow],
  );

  const handleTitleChange = React.useCallback(
    (rowId: string, title: string) => {
      updateRow.mutate({
        databaseId: database.id,
        rowId,
        title,
      });
    },
    [database.id, updateRow],
  );

  if (isLoading) {
    return (
      <View className="py-10 items-center">
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  }

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator>
      <View>
        {/* header row */}
        <View
          className="flex-row border-y border-border bg-muted/30"
          style={{ minWidth: TITLE_COL_WIDTH + visibleProperties.length * DEFAULT_COL_WIDTH + 60 }}
        >
          <View
            className="px-3 py-2 border-r border-border"
            style={{ width: TITLE_COL_WIDTH }}
          >
            <Text className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Name
            </Text>
          </View>
          {visibleProperties.map((property) => (
            <ColumnHeader
              key={property.id}
              database={database}
              view={view}
              property={property}
            />
          ))}
          <View
            className="px-3 py-2 items-center justify-center"
            style={{ width: 60 }}
          />
        </View>

        {/* rows */}
        {rows.length === 0 ? (
          <View className="py-10 items-center w-full">
            <Text className="text-sm text-muted-foreground">No rows yet</Text>
          </View>
        ) : (
          rows.map((row) => (
            <View
              key={row.id}
              className="flex-row border-b border-border/60"
            >
              <Pressable
                className="px-3 py-2 border-r border-border/60 flex-row items-center"
                style={{ width: TITLE_COL_WIDTH }}
                onPress={() => router.push(`/p/${row.id}`)}
              >
                <TitleCell
                  initial={row.title}
                  onChange={(next) => handleTitleChange(row.id, next)}
                />
              </Pressable>
              {visibleProperties.map((property) => (
                <View
                  key={property.id}
                  className="px-3 py-2 border-r border-border/60 justify-center"
                  style={{ width: DEFAULT_COL_WIDTH }}
                >
                  <PropertyCell
                    property={property}
                    value={row.properties[property.id] ?? null}
                    variant="table"
                    onChange={(value) =>
                      handleCellChange(row.id, property.id, value)
                    }
                  />
                </View>
              ))}
              <View style={{ width: 60 }} />
            </View>
          ))
        )}

        {/* new row */}
        <Pressable
          onPress={handleNewRow}
          className="flex-row items-center gap-2 px-3 py-2 border-b border-border/60 hover:bg-muted/40"
        >
          <Plus size={14} color={colors.mutedForeground} />
          <Text className="text-sm text-muted-foreground">
            {createRow.isPending ? "Adding…" : "New"}
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

interface ColumnHeaderProps {
  database: Database;
  view: DatabaseView;
  property: DatabaseProperty;
}

function ColumnHeader({ database, view, property }: ColumnHeaderProps) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  return (
    <View
      className="px-3 py-2 border-r border-border flex-row items-center justify-between"
      style={{ width: DEFAULT_COL_WIDTH }}
    >
      <Pressable
        onPress={() => setMenuOpen(true)}
        className="flex-1"
      >
        <Text className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {property.name}
        </Text>
      </Pressable>
      <PropertyHeaderMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        database={database}
        view={view}
        property={property}
      />
    </View>
  );
}

interface TitleCellProps {
  initial: string;
  onChange: (next: string) => void;
}

function TitleCell({ initial, onChange }: TitleCellProps) {
  const { colors } = useColorScheme();
  const [draft, setDraft] = React.useState(initial);
  React.useEffect(() => {
    setDraft(initial);
  }, [initial]);

  const commit = () => {
    if (draft !== initial) onChange(draft);
  };

  if (Platform.OS === "web") {
    return (
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder="Untitled"
        style={{
          background: "transparent",
          border: "none",
          outline: "none",
          color: colors.foreground,
          fontSize: 14,
          width: "100%",
        }}
      />
    );
  }
  // Native: simple read-only label that opens the row on tap.
  return (
    <Text className="text-sm text-foreground" numberOfLines={1}>
      {draft || "Untitled"}
    </Text>
  );
}
