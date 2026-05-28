import * as React from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { ChevronDown, Plus, Trash2 } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import type {
  Database,
  DatabaseProperty,
  DatabaseView,
  Filter,
  FilterCondition,
  FilterGroup,
} from "@/lib/types/databases";
import { useUpdateView } from "@/lib/hooks/use-database-views";
import { centeredModalStyle } from "./centered-modal-style";

interface FilterBuilderProps {
  open: boolean;
  onClose: () => void;
  database: Database;
  view: DatabaseView;
}

const OPERATORS_BY_TYPE: Record<string, { value: string; label: string }[]> = {
  text: [
    { value: "contains", label: "contains" },
    { value: "equals", label: "equals" },
    { value: "starts_with", label: "starts with" },
    { value: "ends_with", label: "ends with" },
    { value: "is_empty", label: "is empty" },
    { value: "is_not_empty", label: "is not empty" },
  ],
  number: [
    { value: "=", label: "=" },
    { value: "!=", label: "≠" },
    { value: ">", label: ">" },
    { value: "<", label: "<" },
    { value: ">=", label: "≥" },
    { value: "<=", label: "≤" },
    { value: "is_empty", label: "is empty" },
  ],
  select: [
    { value: "is", label: "is" },
    { value: "is_not", label: "is not" },
    { value: "is_empty", label: "is empty" },
  ],
  status: [
    { value: "is", label: "is" },
    { value: "is_not", label: "is not" },
    { value: "is_empty", label: "is empty" },
  ],
  multi_select: [
    { value: "contains", label: "contains" },
    { value: "does_not_contain", label: "does not contain" },
    { value: "is_empty", label: "is empty" },
  ],
  date: [
    { value: "before", label: "before" },
    { value: "after", label: "after" },
    { value: "on_or_before", label: "on or before" },
    { value: "on_or_after", label: "on or after" },
    { value: "equals", label: "equals" },
    { value: "is_empty", label: "is empty" },
  ],
  checkbox: [
    { value: "is", label: "is" },
    { value: "is_not", label: "is not" },
  ],
  url: [
    { value: "contains", label: "contains" },
    { value: "equals", label: "equals" },
    { value: "is_empty", label: "is empty" },
  ],
  email: [
    { value: "contains", label: "contains" },
    { value: "equals", label: "equals" },
    { value: "is_empty", label: "is empty" },
  ],
  phone: [
    { value: "contains", label: "contains" },
    { value: "equals", label: "equals" },
    { value: "is_empty", label: "is empty" },
  ],
  person: [
    { value: "contains", label: "contains" },
    { value: "does_not_contain", label: "does not contain" },
    { value: "is_empty", label: "is empty" },
  ],
  relation: [
    { value: "contains", label: "contains" },
    { value: "does_not_contain", label: "does not contain" },
    { value: "is_empty", label: "is empty" },
  ],
  files: [
    { value: "is_empty", label: "is empty" },
    { value: "is_not_empty", label: "is not empty" },
  ],
};

function operatorsFor(type: string): { value: string; label: string }[] {
  return OPERATORS_BY_TYPE[type] ?? [
    { value: "is_empty", label: "is empty" },
    { value: "is_not_empty", label: "is not empty" },
  ];
}

/**
 * Filter builder modal — render the AND/OR tree as a flat list of
 * conditions (groups inside groups exist in the data model but aren't
 * exposed in the MVP UI to keep things simple).
 */
export function FilterBuilder({
  open,
  onClose,
  database,
  view,
}: FilterBuilderProps) {
  const updateView = useUpdateView();
  const [draft, setDraft] = React.useState<FilterGroup>(() =>
    cloneFilterGroup(view.filters),
  );

  React.useEffect(() => {
    if (open) setDraft(cloneFilterGroup(view.filters));
  }, [open, view.filters]);

  const apply = async () => {
    await updateView.mutateAsync({
      databaseId: database.id,
      viewId: view.id,
      filters: draft,
    });
    onClose();
  };

  const reset = async () => {
    const empty: FilterGroup = {
      kind: "group",
      combinator: "and",
      filters: [],
    };
    setDraft(empty);
    await updateView.mutateAsync({
      databaseId: database.id,
      viewId: view.id,
      filters: empty,
    });
    onClose();
  };

  const addCondition = (property: DatabaseProperty) => {
    const operator = operatorsFor(property.type)[0]?.value ?? "is_empty";
    setDraft((prev) => ({
      ...prev,
      filters: [
        ...prev.filters,
        {
          kind: "condition",
          propertyId: property.id,
          operator,
          value: "",
        } satisfies FilterCondition,
      ],
    }));
  };

  const updateCondition = (
    index: number,
    patch: Partial<FilterCondition>,
  ) => {
    setDraft((prev) => {
      const next = [...prev.filters];
      const target = next[index];
      if (!target || target.kind !== "condition") return prev;
      next[index] = { ...target, ...patch };
      return { ...prev, filters: next };
    });
  };

  const removeCondition = (index: number) => {
    setDraft((prev) => ({
      ...prev,
      filters: prev.filters.filter((_, i) => i !== index),
    }));
  };

  const setCombinator = (combinator: "and" | "or") => {
    setDraft((prev) => ({ ...prev, combinator }));
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
        style={centeredModalStyle(520, 480)}
      >
        <View className="bg-popover border border-border rounded-2xl shadow-xl p-4 m-3 web:m-0 gap-3">
          <View className="flex-row items-center justify-between">
            <Text className="text-base font-semibold text-foreground">
              Filters
            </Text>
            <CombinatorPicker
              value={draft.combinator}
              onChange={setCombinator}
            />
          </View>

          <ScrollView style={{ maxHeight: 360 }} className="gap-2">
            {draft.filters.length === 0 ? (
              <View className="py-4">
                <Text className="text-sm text-muted-foreground">
                  No filters yet. Add one below.
                </Text>
              </View>
            ) : (
              draft.filters.map((filter, idx) =>
                filter.kind === "condition" ? (
                  <ConditionRow
                    key={idx}
                    database={database}
                    filter={filter}
                    onChange={(patch) => updateCondition(idx, patch)}
                    onRemove={() => removeCondition(idx)}
                  />
                ) : null,
              )
            )}
          </ScrollView>

          <AddConditionButton
            database={database}
            onPick={addCondition}
          />

          <View className="flex-row justify-end gap-2 mt-2">
            <Pressable
              onPress={reset}
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

interface CombinatorPickerProps {
  value: "and" | "or";
  onChange: (next: "and" | "or") => void;
}

function CombinatorPicker({ value, onChange }: CombinatorPickerProps) {
  return (
    <View className="flex-row rounded-md border border-border overflow-hidden">
      {(["and", "or"] as const).map((option) => (
        <Pressable
          key={option}
          onPress={() => onChange(option)}
          className={`px-2 py-1 ${
            value === option ? "bg-primary" : "bg-muted"
          }`}
        >
          <Text
            className={`text-xs uppercase ${
              value === option
                ? "text-primary-foreground"
                : "text-foreground"
            }`}
          >
            {option}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

interface ConditionRowProps {
  database: Database;
  filter: FilterCondition;
  onChange: (patch: Partial<FilterCondition>) => void;
  onRemove: () => void;
}

function ConditionRow({
  database,
  filter,
  onChange,
  onRemove,
}: ConditionRowProps) {
  const { colors } = useColorScheme();
  const [propertyOpen, setPropertyOpen] = React.useState(false);
  const [operatorOpen, setOperatorOpen] = React.useState(false);

  const property = database.schema.properties.find(
    (p) => p.id === filter.propertyId,
  );
  const operators = property ? operatorsFor(property.type) : [];

  return (
    <View className="flex-row items-center gap-2 py-1">
      <PickerButton
        label={property?.name ?? "Property"}
        onPress={() => setPropertyOpen((s) => !s)}
      />
      <PickerButton
        label={
          operators.find((o) => o.value === filter.operator)?.label ??
          filter.operator
        }
        onPress={() => setOperatorOpen((s) => !s)}
      />
      <View className="flex-1">
        <ConditionValueInput
          property={property ?? null}
          operator={filter.operator}
          value={filter.value}
          onChange={(value) => onChange({ value })}
        />
      </View>
      <Pressable
        onPress={onRemove}
        className="p-1.5 rounded hover:bg-muted"
      >
        <Trash2 size={12} color={colors.mutedForeground} />
      </Pressable>

      {propertyOpen ? (
        <ListPopover
          onClose={() => setPropertyOpen(false)}
          options={database.schema.properties.map((p) => ({
            value: p.id,
            label: p.name,
          }))}
          onSelect={(id) => {
            const next = database.schema.properties.find((p) => p.id === id);
            if (!next) return;
            onChange({
              propertyId: id,
              operator: operatorsFor(next.type)[0]?.value ?? "is_empty",
              value: "",
            });
            setPropertyOpen(false);
          }}
        />
      ) : null}

      {operatorOpen ? (
        <ListPopover
          onClose={() => setOperatorOpen(false)}
          options={operators.map((o) => ({ value: o.value, label: o.label }))}
          onSelect={(op) => {
            onChange({ operator: op });
            setOperatorOpen(false);
          }}
        />
      ) : null}
    </View>
  );
}

interface PickerButtonProps {
  label: string;
  onPress: () => void;
}

function PickerButton({ label, onPress }: PickerButtonProps) {
  const { colors } = useColorScheme();
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-1 px-2 py-1 rounded-md bg-muted/60"
    >
      <Text className="text-xs text-foreground">{label}</Text>
      <ChevronDown size={10} color={colors.mutedForeground} />
    </Pressable>
  );
}

interface ListPopoverProps {
  onClose: () => void;
  options: { value: string; label: string }[];
  onSelect: (value: string) => void;
}

function ListPopover({ onClose, options, onSelect }: ListPopoverProps) {
  // Renders inline below the trigger as an absolute box. Pressing
  // outside dismisses.
  return (
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
        onPress={onClose}
        className="-inset-screen"
      />
      <View className="bg-popover border border-border rounded-md shadow-xl p-1 min-w-[160px]">
        <ScrollView style={{ maxHeight: 220 }}>
          {options.map((o) => (
            <Pressable
              key={o.value}
              onPress={() => onSelect(o.value)}
              className="px-2 py-1.5 rounded hover:bg-muted"
            >
              <Text className="text-xs text-foreground">{o.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </View>
  );
}

interface ConditionValueInputProps {
  property: DatabaseProperty | null;
  operator: string;
  value: unknown;
  onChange: (next: unknown) => void;
}

function ConditionValueInput({
  property,
  operator,
  value,
  onChange,
}: ConditionValueInputProps) {
  const { colors } = useColorScheme();
  // Operators that don't take a value
  if (operator === "is_empty" || operator === "is_not_empty") {
    return <View />;
  }

  if (property?.type === "checkbox") {
    return (
      <View className="flex-row items-center gap-2">
        <Pressable
          onPress={() => onChange(true)}
          className={`px-2 py-1 rounded-md ${
            value === true ? "bg-primary" : "bg-muted"
          }`}
        >
          <Text
            className={`text-xs ${
              value === true ? "text-primary-foreground" : "text-foreground"
            }`}
          >
            Checked
          </Text>
        </Pressable>
        <Pressable
          onPress={() => onChange(false)}
          className={`px-2 py-1 rounded-md ${
            value === false ? "bg-primary" : "bg-muted"
          }`}
        >
          <Text
            className={`text-xs ${
              value === false ? "text-primary-foreground" : "text-foreground"
            }`}
          >
            Unchecked
          </Text>
        </Pressable>
      </View>
    );
  }

  if (property?.type === "select" || property?.type === "status") {
    const opts = property.config?.options ?? [];
    return (
      <View className="flex-row flex-wrap gap-1">
        {opts.map((o) => (
          <Pressable
            key={o.id}
            onPress={() => onChange(o.id)}
            className={`px-2 py-1 rounded-md ${
              value === o.id ? "bg-primary" : "bg-muted"
            }`}
          >
            <Text
              className={`text-xs ${
                value === o.id ? "text-primary-foreground" : "text-foreground"
              }`}
            >
              {o.name}
            </Text>
          </Pressable>
        ))}
      </View>
    );
  }

  const text = typeof value === "string" ? value : String(value ?? "");
  return (
    <TextInput
      value={text}
      onChangeText={onChange}
      placeholder="Value"
      placeholderTextColor={colors.mutedForeground}
      className="text-sm text-foreground border border-border rounded-md px-2 py-1"
      style={Platform.OS === "web" ? { outlineWidth: 0 } : undefined}
      underlineColorAndroid="transparent"
    />
  );
}

interface AddConditionButtonProps {
  database: Database;
  onPick: (property: DatabaseProperty) => void;
}

function AddConditionButton({ database, onPick }: AddConditionButtonProps) {
  const { colors } = useColorScheme();
  const [open, setOpen] = React.useState(false);

  return (
    <View>
      <Pressable
        onPress={() => setOpen((s) => !s)}
        className="flex-row items-center gap-1 self-start px-2 py-1 rounded hover:bg-muted"
      >
        <Plus size={12} color={colors.mutedForeground} />
        <Text className="text-xs text-muted-foreground">Add filter</Text>
      </Pressable>
      {open ? (
        <ListPopover
          onClose={() => setOpen(false)}
          options={database.schema.properties.map((p) => ({
            value: p.id,
            label: p.name,
          }))}
          onSelect={(id) => {
            const target = database.schema.properties.find((p) => p.id === id);
            if (target) onPick(target);
            setOpen(false);
          }}
        />
      ) : null}
    </View>
  );
}

function cloneFilterGroup(group: FilterGroup): FilterGroup {
  return {
    kind: "group",
    combinator: group.combinator,
    filters: group.filters.map((f) =>
      f.kind === "condition"
        ? { ...f }
        : cloneFilterGroup(f),
    ),
  };
}
