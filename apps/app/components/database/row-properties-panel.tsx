import * as React from "react";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
import type {
  Database,
  DatabaseRow,
  PropertyValue,
} from "@/lib/types/databases";
import { useUpdateRow } from "@/lib/hooks/use-database-rows";
import { PropertyCell } from "./property-cell";

interface RowPropertiesPanelProps {
  database: Database;
  row: DatabaseRow;
}

/**
 * Property panel rendered above the block editor on a row's detail page.
 * Mirrors Notion's "row open in side peek" UX — every property is
 * editable inline.
 */
export function RowPropertiesPanel({ database, row }: RowPropertiesPanelProps) {
  const updateRow = useUpdateRow();

  const onChange = React.useCallback(
    (propertyId: string, value: PropertyValue) => {
      updateRow.mutate({
        databaseId: database.id,
        rowId: row.id,
        properties: { [propertyId]: value },
      });
    },
    [database.id, row.id, updateRow],
  );

  // Skip the Name property (it's the title above this panel) and any
  // hidden-by-default derived rollups that aren't ready in Phase 4 MVP.
  const properties = database.schema.properties.filter(
    (p) => p.id !== "name",
  );

  return (
    <View className="gap-2">
      {properties.map((property) => (
        <View key={property.id} className="flex-row items-start gap-3">
          <View className="w-36">
            <Text className="text-xs text-muted-foreground py-1">
              {property.name}
            </Text>
          </View>
          <View className="flex-1">
            <PropertyCell
              property={property}
              value={row.properties[property.id] ?? null}
              variant="panel"
              onChange={(value) => onChange(property.id, value)}
            />
          </View>
        </View>
      ))}
    </View>
  );
}
