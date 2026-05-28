import * as React from "react";
import { Pressable, View } from "react-native";
import {
  ArrowUpDown,
  Filter as FilterIcon,
  Plus,
  Settings2,
} from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import type {
  Database,
  DatabaseRow,
  DatabaseView,
} from "@/lib/types/databases";
import { useCreateRow } from "@/lib/hooks/use-database-rows";
import { ViewTable } from "./view-table";
import { ViewBoard } from "./view-board";
import { ViewGallery } from "./view-gallery";
import { ViewList } from "./view-list";
import { ViewCalendar } from "./view-calendar";
import { ViewTimeline } from "./view-timeline";
import { FilterBuilder } from "./filter-builder";
import { SortBuilder } from "./sort-builder";
import { AddPropertyButton } from "./property-config-modal";

interface DatabaseViewContainerProps {
  database: Database;
  view: DatabaseView;
  rows: DatabaseRow[];
  isLoading: boolean;
}

/**
 * Wraps the active view with the shared "tools" bar — filter, sort,
 * add-property — and delegates rendering to the matching view component.
 */
export function DatabaseViewContainer({
  database,
  view,
  rows,
  isLoading,
}: DatabaseViewContainerProps) {
  const { colors } = useColorScheme();
  const [filterOpen, setFilterOpen] = React.useState(false);
  const [sortOpen, setSortOpen] = React.useState(false);
  const createRow = useCreateRow();

  const filterCount = countFilters(view.filters);
  const sortCount = view.sorts.length;

  return (
    <View className="flex-1">
      <View className="flex-row items-center justify-between px-6 py-2 border-b border-border/30">
        <View className="flex-row items-center gap-1">
          <ToolButton
            onPress={() => setFilterOpen(true)}
            active={filterCount > 0}
            icon={FilterIcon}
            label={
              filterCount > 0 ? `Filter (${filterCount})` : "Filter"
            }
          />
          <ToolButton
            onPress={() => setSortOpen(true)}
            active={sortCount > 0}
            icon={ArrowUpDown}
            label={sortCount > 0 ? `Sort (${sortCount})` : "Sort"}
          />
          <AddPropertyButton database={database} />
        </View>
        <View className="flex-row items-center gap-1">
          <Pressable
            onPress={() => createRow.mutate({ databaseId: database.id })}
            className="flex-row items-center gap-1 px-2 py-1 rounded bg-primary"
          >
            <Plus size={12} color="#ffffff" />
            <Text className="text-xs text-primary-foreground">
              {createRow.isPending ? "Adding…" : "New"}
            </Text>
          </Pressable>
        </View>
      </View>

      <View className="flex-1">
        {view.type === "table" ? (
          <ViewTable
            database={database}
            view={view}
            rows={rows}
            isLoading={isLoading}
          />
        ) : null}
        {view.type === "board" ? (
          <ViewBoard
            database={database}
            view={view}
            rows={rows}
            isLoading={isLoading}
          />
        ) : null}
        {view.type === "gallery" ? (
          <ViewGallery
            database={database}
            view={view}
            rows={rows}
            isLoading={isLoading}
          />
        ) : null}
        {view.type === "list" ? (
          <ViewList
            database={database}
            view={view}
            rows={rows}
            isLoading={isLoading}
          />
        ) : null}
        {view.type === "calendar" ? (
          <ViewCalendar
            database={database}
            view={view}
            rows={rows}
            isLoading={isLoading}
          />
        ) : null}
        {view.type === "timeline" ? (
          <ViewTimeline
            database={database}
            view={view}
            rows={rows}
            isLoading={isLoading}
          />
        ) : null}
      </View>

      <FilterBuilder
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        database={database}
        view={view}
      />
      <SortBuilder
        open={sortOpen}
        onClose={() => setSortOpen(false)}
        database={database}
        view={view}
      />
    </View>
  );
}

interface ToolButtonProps {
  onPress: () => void;
  active?: boolean;
  icon: React.ComponentType<{ size?: number; color?: string }>;
  label: string;
}

function ToolButton({ onPress, active, icon: Icon, label }: ToolButtonProps) {
  const { colors } = useColorScheme();
  return (
    <Pressable
      onPress={onPress}
      className={`flex-row items-center gap-1 px-2 py-1 rounded ${
        active ? "bg-primary/15" : "hover:bg-muted"
      }`}
    >
      <Icon size={12} color={active ? colors.primary : colors.mutedForeground} />
      <Text
        className={`text-xs ${
          active ? "text-primary" : "text-muted-foreground"
        }`}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function countFilters(group: DatabaseView["filters"]): number {
  let count = 0;
  for (const f of group.filters) {
    if (f.kind === "condition") count += 1;
    else count += countFilters(f);
  }
  return count;
}
