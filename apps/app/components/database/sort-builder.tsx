import * as React from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  ChevronDown,
  Plus,
  Trash2,
} from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import type {
  Database,
  DatabaseView,
  ViewSort,
} from "@/lib/types/databases";
import { useUpdateView } from "@/lib/hooks/use-database-views";
import { centeredModalStyle } from "./centered-modal-style";

interface SortBuilderProps {
  open: boolean;
  onClose: () => void;
  database: Database;
  view: DatabaseView;
}

export function SortBuilder({
  open,
  onClose,
  database,
  view,
}: SortBuilderProps) {
  const updateView = useUpdateView();
  const [draft, setDraft] = React.useState<ViewSort[]>(view.sorts);

  React.useEffect(() => {
    if (open) setDraft(view.sorts);
  }, [open, view.sorts]);

  const apply = async () => {
    await updateView.mutateAsync({
      databaseId: database.id,
      viewId: view.id,
      sorts: draft,
    });
    onClose();
  };

  const clearAll = async () => {
    setDraft([]);
    await updateView.mutateAsync({
      databaseId: database.id,
      viewId: view.id,
      sorts: [],
    });
    onClose();
  };

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        style={StyleSheet.absoluteFill}
        className="bg-black/50"
        onPress={onClose}
      />
      <View
        className="absolute left-0 right-0 bottom-0 web:bottom-auto web:top-1/2 web:left-1/2"
        style={centeredModalStyle(460, 420)}
      >
        <View className="bg-popover border border-border rounded-2xl shadow-xl p-4 m-3 web:m-0 gap-3">
          <Text className="text-base font-semibold text-foreground">Sort</Text>

          <ScrollView style={{ maxHeight: 300 }} className="gap-2">
            {draft.length === 0 ? (
              <Text className="text-sm text-muted-foreground py-2">
                No sorts yet. Add a property below.
              </Text>
            ) : (
              draft.map((sort, idx) => (
                <SortRow
                  key={`${sort.propertyId}-${idx}`}
                  database={database}
                  sort={sort}
                  onChange={(patch) =>
                    setDraft((prev) => {
                      const next = [...prev];
                      next[idx] = { ...next[idx], ...patch };
                      return next;
                    })
                  }
                  onRemove={() =>
                    setDraft((prev) => prev.filter((_, i) => i !== idx))
                  }
                />
              ))
            )}
          </ScrollView>

          <AddSortButton
            database={database}
            existing={draft.map((s) => s.propertyId)}
            onPick={(propertyId) =>
              setDraft((prev) => [
                ...prev,
                { propertyId, direction: "asc" } satisfies ViewSort,
              ])
            }
          />

          <View className="flex-row justify-end gap-2 mt-2">
            <Pressable
              onPress={clearAll}
              className="px-3 py-1.5 rounded-md bg-muted"
            >
              <Text className="text-sm text-foreground">Clear all</Text>
            </Pressable>
            <Pressable
              onPress={onClose}
              className="px-3 py-1.5 rounded-md bg-muted"
            >
              <Text className="text-sm text-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={apply}
              className="px-3 py-1.5 rounded-md bg-primary"
            >
              <Text className="text-sm text-primary-foreground">Apply</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

interface SortRowProps {
  database: Database;
  sort: ViewSort;
  onChange: (patch: Partial<ViewSort>) => void;
  onRemove: () => void;
}

function SortRow({ database, sort, onChange, onRemove }: SortRowProps) {
  const { colors } = useColorScheme();
  const [open, setOpen] = React.useState(false);
  const property = database.schema.properties.find(
    (p) => p.id === sort.propertyId,
  );

  return (
    <View className="flex-row items-center gap-2 py-1">
      <Pressable
        onPress={() => setOpen((s) => !s)}
        className="flex-row items-center gap-1 px-2 py-1 rounded-md bg-muted/60"
      >
        <Text className="text-xs text-foreground">
          {property?.name ?? "Property"}
        </Text>
        <ChevronDown size={10} color={colors.mutedForeground} />
      </Pressable>

      <View className="flex-row rounded-md border border-border overflow-hidden">
        {(["asc", "desc"] as const).map((dir) => {
          const Icon = dir === "asc" ? ArrowUpAZ : ArrowDownAZ;
          return (
            <Pressable
              key={dir}
              onPress={() => onChange({ direction: dir })}
              className={`px-2 py-1 ${
                sort.direction === dir ? "bg-primary" : "bg-muted"
              }`}
            >
              <Icon
                size={12}
                color={
                  sort.direction === dir ? "#ffffff" : colors.foreground
                }
              />
            </Pressable>
          );
        })}
      </View>

      <View className="flex-1" />
      <Pressable
        onPress={onRemove}
        className="p-1.5 rounded hover:bg-muted"
      >
        <Trash2 size={12} color={colors.mutedForeground} />
      </Pressable>

      {open ? (
        <View
          style={{
            position: "absolute",
            top: 32,
            left: 0,
            zIndex: 50,
          }}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setOpen(false)}
          />
          <View className="bg-popover border border-border rounded-md shadow-xl p-1 min-w-[160px]">
            <ScrollView style={{ maxHeight: 220 }}>
              {database.schema.properties.map((p) => (
                <Pressable
                  key={p.id}
                  onPress={() => {
                    onChange({ propertyId: p.id });
                    setOpen(false);
                  }}
                  className="px-2 py-1.5 rounded hover:bg-muted"
                >
                  <Text className="text-xs text-foreground">{p.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      ) : null}
    </View>
  );
}

interface AddSortButtonProps {
  database: Database;
  existing: string[];
  onPick: (propertyId: string) => void;
}

function AddSortButton({ database, existing, onPick }: AddSortButtonProps) {
  const { colors } = useColorScheme();
  const [open, setOpen] = React.useState(false);
  const available = database.schema.properties.filter(
    (p) => !existing.includes(p.id),
  );

  return (
    <View>
      <Pressable
        onPress={() => setOpen((s) => !s)}
        className="flex-row items-center gap-1 self-start px-2 py-1 rounded hover:bg-muted"
      >
        <Plus size={12} color={colors.mutedForeground} />
        <Text className="text-xs text-muted-foreground">Add sort</Text>
      </Pressable>
      {open ? (
        <View
          style={{
            position: "absolute",
            top: 32,
            left: 0,
            zIndex: 50,
          }}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setOpen(false)}
          />
          <View className="bg-popover border border-border rounded-md shadow-xl p-1 min-w-[180px]">
            <ScrollView style={{ maxHeight: 220 }}>
              {available.length === 0 ? (
                <Text className="text-xs text-muted-foreground px-2 py-1.5">
                  All properties added
                </Text>
              ) : (
                available.map((p) => (
                  <Pressable
                    key={p.id}
                    onPress={() => {
                      onPick(p.id);
                      setOpen(false);
                    }}
                    className="px-2 py-1.5 rounded hover:bg-muted"
                  >
                    <Text className="text-xs text-foreground">{p.name}</Text>
                  </Pressable>
                ))
              )}
            </ScrollView>
          </View>
        </View>
      ) : null}
    </View>
  );
}
