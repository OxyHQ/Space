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
import { Check, ChevronDown, Plus, X } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import type {
  DatabaseProperty,
  PropertyValue,
  SelectColor,
  SelectOption,
} from "@/lib/types/databases";
import { SELECT_COLOR_CLASSES } from "./select-color";
import { centeredModalStyle } from "./centered-modal-style";

export interface PropertyCellProps {
  property: DatabaseProperty;
  value: PropertyValue;
  /** Renders compact for table rows; expanded for the row detail panel. */
  variant?: "table" | "panel" | "card";
  onChange: (next: PropertyValue) => void;
  /** Optional initial focus when becoming interactive (table double-click). */
  autoFocus?: boolean;
}

/**
 * PropertyCell — renders + edits a single typed property value.
 *
 * Variants:
 *   - `table`: dense, single-line, inline editor that opens on tap/click.
 *   - `panel`: expanded label + value, used inside a database row's
 *     property panel.
 *   - `card`: read-only chip used in board/gallery card previews.
 *
 * All editors store via the controlled `onChange` callback. The parent
 * (row mutation hook) is responsible for debouncing writes.
 */
export function PropertyCell({
  property,
  value,
  variant = "table",
  onChange,
  autoFocus,
}: PropertyCellProps) {
  switch (property.type) {
    case "text":
      return (
        <TextCell
          value={readText(value)}
          variant={variant}
          autoFocus={autoFocus}
          onChange={(text) => onChange({ text })}
        />
      );
    case "number":
      return (
        <NumberCell
          property={property}
          value={readNumber(value)}
          variant={variant}
          autoFocus={autoFocus}
          onChange={(n) => onChange({ number: n })}
        />
      );
    case "url":
    case "email":
    case "phone":
      return (
        <TextCell
          value={readScalarString(value)}
          variant={variant}
          autoFocus={autoFocus}
          keyboardType={
            property.type === "email"
              ? "email-address"
              : property.type === "phone"
                ? "phone-pad"
                : "url"
          }
          onChange={(v) => onChange({ value: v })}
        />
      );
    case "checkbox":
      return (
        <CheckboxCell
          value={readChecked(value)}
          onChange={(checked) => onChange({ checked })}
        />
      );
    case "select":
      return (
        <SelectCell
          property={property}
          variant={variant}
          value={readOptionId(value)}
          onChange={(id) => onChange({ optionId: id })}
        />
      );
    case "status":
      return (
        <SelectCell
          property={property}
          variant={variant}
          value={readOptionId(value)}
          onChange={(id) => onChange({ optionId: id })}
        />
      );
    case "multi_select":
      return (
        <MultiSelectCell
          property={property}
          variant={variant}
          value={readOptionIds(value)}
          onChange={(ids) => onChange({ optionIds: ids })}
        />
      );
    case "date":
      return (
        <DateCell
          variant={variant}
          value={readDateStart(value)}
          onChange={(start) =>
            onChange({ start, end: null, includeTime: false })
          }
        />
      );
    case "person":
      return <PersonCell value={readUserIds(value)} variant={variant} />;
    case "files":
      return <FilesCell value={readFiles(value)} variant={variant} />;
    case "relation":
      return <RelationCell value={readPageIds(value)} variant={variant} />;
    case "rollup":
    case "formula":
      return <DerivedCell value={value} variant={variant} />;
    case "created_time":
    case "last_edited_time":
      return (
        <DerivedCell
          value={value}
          variant={variant}
          format="date"
        />
      );
    case "created_by":
    case "last_edited_by":
      return <PersonCell value={readUserIds(value)} variant={variant} />;
  }
}

// --- typed readers ---------------------------------------------------------

function readText(v: PropertyValue): string {
  if (v && typeof v === "object" && "text" in v && typeof v.text === "string") {
    return v.text;
  }
  return "";
}
function readScalarString(v: PropertyValue): string {
  if (v && typeof v === "object" && "value" in v && typeof v.value === "string") {
    return v.value;
  }
  return "";
}
function readNumber(v: PropertyValue): number | null {
  if (
    v &&
    typeof v === "object" &&
    "number" in v &&
    (typeof v.number === "number" || v.number === null)
  ) {
    return v.number;
  }
  return null;
}
function readChecked(v: PropertyValue): boolean {
  if (v && typeof v === "object" && "checked" in v) {
    return Boolean(v.checked);
  }
  return false;
}
function readOptionId(v: PropertyValue): string | null {
  if (v && typeof v === "object" && "optionId" in v) {
    const id = v.optionId;
    return typeof id === "string" ? id : null;
  }
  return null;
}
function readOptionIds(v: PropertyValue): string[] {
  if (v && typeof v === "object" && "optionIds" in v) {
    const ids = v.optionIds;
    if (Array.isArray(ids)) {
      return ids.filter((id): id is string => typeof id === "string");
    }
  }
  return [];
}
function readDateStart(v: PropertyValue): string | null {
  if (v && typeof v === "object" && "start" in v) {
    const start = v.start;
    return typeof start === "string" ? start : null;
  }
  return null;
}
function readUserIds(v: PropertyValue): string[] {
  if (v && typeof v === "object" && "userIds" in v) {
    const ids = v.userIds;
    if (Array.isArray(ids)) {
      return ids.filter((id): id is string => typeof id === "string");
    }
  }
  return [];
}
function readFiles(v: PropertyValue): { name: string; url: string }[] {
  if (v && typeof v === "object" && "files" in v) {
    const files = v.files;
    if (Array.isArray(files)) {
      return files.filter(
        (f): f is { name: string; url: string } =>
          typeof f === "object" &&
          f !== null &&
          typeof (f as { name?: unknown }).name === "string" &&
          typeof (f as { url?: unknown }).url === "string",
      );
    }
  }
  return [];
}
function readPageIds(v: PropertyValue): string[] {
  if (v && typeof v === "object" && "pageIds" in v) {
    const ids = v.pageIds;
    if (Array.isArray(ids)) {
      return ids.filter((id): id is string => typeof id === "string");
    }
  }
  return [];
}

// --- individual cell editors ----------------------------------------------

interface CellVariantProps {
  variant: PropertyCellProps["variant"];
}

interface TextCellProps extends CellVariantProps {
  value: string;
  autoFocus?: boolean;
  keyboardType?: "default" | "email-address" | "phone-pad" | "url";
  onChange: (next: string) => void;
}

function TextCell({
  value,
  autoFocus,
  keyboardType,
  onChange,
  variant,
}: TextCellProps) {
  const { colors } = useColorScheme();
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = () => {
    if (draft !== value) onChange(draft);
  };

  return (
    <TextInput
      value={draft}
      onChangeText={setDraft}
      onBlur={commit}
      onSubmitEditing={commit}
      autoFocus={autoFocus}
      keyboardType={keyboardType ?? "default"}
      placeholder=""
      placeholderTextColor={colors.mutedForeground}
      className={
        variant === "panel"
          ? "text-sm text-foreground py-1"
          : "text-sm text-foreground"
      }
      style={
        Platform.OS === "web"
          ? { outlineWidth: 0, borderWidth: 0, padding: 0, minWidth: 60 }
          : undefined
      }
      underlineColorAndroid="transparent"
    />
  );
}

interface NumberCellProps extends CellVariantProps {
  property: DatabaseProperty;
  value: number | null;
  autoFocus?: boolean;
  onChange: (next: number | null) => void;
}

function NumberCell({
  property,
  value,
  autoFocus,
  onChange,
  variant,
}: NumberCellProps) {
  const { colors } = useColorScheme();
  const [draft, setDraft] = React.useState(value === null ? "" : String(value));
  React.useEffect(() => {
    setDraft(value === null ? "" : String(value));
  }, [value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      if (value !== null) onChange(null);
      return;
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      if (parsed !== value) onChange(parsed);
    } else {
      setDraft(value === null ? "" : String(value));
    }
  };

  const displayValue = formatNumber(value, property);

  return (
    <View className="flex-row items-center">
      {variant === "table" ? (
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onBlur={commit}
          onSubmitEditing={commit}
          autoFocus={autoFocus}
          keyboardType="numeric"
          inputMode="decimal"
          placeholder=""
          placeholderTextColor={colors.mutedForeground}
          className="text-sm text-foreground text-right flex-1"
          style={
            Platform.OS === "web"
              ? { outlineWidth: 0, borderWidth: 0, padding: 0, minWidth: 40 }
              : undefined
          }
          underlineColorAndroid="transparent"
        />
      ) : (
        <View className="flex-row items-center">
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onBlur={commit}
            onSubmitEditing={commit}
            autoFocus={autoFocus}
            keyboardType="numeric"
            inputMode="decimal"
            placeholder="—"
            placeholderTextColor={colors.mutedForeground}
            className="text-sm text-foreground py-1"
            style={
              Platform.OS === "web"
                ? { outlineWidth: 0, borderWidth: 0, padding: 0, minWidth: 60 }
                : undefined
            }
          />
          {displayValue !== draft && draft.length > 0 ? (
            <Text className="text-xs text-muted-foreground ml-2">
              {displayValue}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

function formatNumber(value: number | null, property: DatabaseProperty): string {
  if (value === null) return "";
  const format = property.config?.format ?? "number";
  const precision = property.config?.precision ?? 2;
  if (format === "percent") {
    return `${(value * 100).toFixed(precision)}%`;
  }
  if (format.startsWith("currency:")) {
    const currency = format.slice("currency:".length);
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        maximumFractionDigits: precision,
      }).format(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

interface CheckboxCellProps {
  value: boolean;
  onChange: (next: boolean) => void;
}

function CheckboxCell({ value, onChange }: CheckboxCellProps) {
  return (
    <Pressable
      onPress={() => onChange(!value)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: value }}
      className={`h-5 w-5 items-center justify-center rounded border ${
        value
          ? "bg-primary border-primary"
          : "border-border bg-background"
      }`}
    >
      {value ? <Check size={14} color="#ffffff" /> : null}
    </Pressable>
  );
}

interface SelectCellProps extends CellVariantProps {
  property: DatabaseProperty;
  value: string | null;
  onChange: (next: string | null) => void;
}

function SelectCell({ property, value, onChange, variant }: SelectCellProps) {
  const [open, setOpen] = React.useState(false);
  const options = property.config?.options ?? [];
  const selected = options.find((o) => o.id === value) ?? null;

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        className={`flex-row items-center ${
          variant === "table" ? "py-0.5" : "py-1"
        }`}
      >
        {selected ? <SelectChip option={selected} /> : (
          <Text className="text-sm text-muted-foreground">—</Text>
        )}
        {variant !== "card" ? (
          <ChevronDown
            size={12}
            color="#9ca3af"
            style={{ marginLeft: 4 }}
          />
        ) : null}
      </Pressable>
      <SelectPicker
        open={open}
        onClose={() => setOpen(false)}
        options={options}
        selectedIds={selected ? [selected.id] : []}
        multi={false}
        onSelect={(id) => {
          onChange(id);
          setOpen(false);
        }}
        onClear={() => {
          onChange(null);
          setOpen(false);
        }}
      />
    </>
  );
}

interface MultiSelectCellProps extends CellVariantProps {
  property: DatabaseProperty;
  value: string[];
  onChange: (next: string[]) => void;
}

function MultiSelectCell({
  property,
  value,
  onChange,
  variant,
}: MultiSelectCellProps) {
  const [open, setOpen] = React.useState(false);
  const options = property.config?.options ?? [];
  const selected = options.filter((o) => value.includes(o.id));

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        className={`flex-row flex-wrap items-center gap-1 ${
          variant === "table" ? "py-0.5" : "py-1"
        }`}
      >
        {selected.length === 0 ? (
          <Text className="text-sm text-muted-foreground">—</Text>
        ) : (
          selected.map((o) => <SelectChip key={o.id} option={o} />)
        )}
      </Pressable>
      <SelectPicker
        open={open}
        onClose={() => setOpen(false)}
        options={options}
        selectedIds={value}
        multi
        onSelect={(id) => {
          const next = value.includes(id)
            ? value.filter((x) => x !== id)
            : [...value, id];
          onChange(next);
        }}
        onClear={() => onChange([])}
      />
    </>
  );
}

function SelectChip({ option }: { option: SelectOption }) {
  const palette = SELECT_COLOR_CLASSES[option.color] ?? SELECT_COLOR_CLASSES.default;
  return (
    <View
      className={`px-2 py-0.5 rounded-md ${palette.bg}`}
    >
      <Text className={`text-xs ${palette.fg}`}>{option.name}</Text>
    </View>
  );
}

interface SelectPickerProps {
  open: boolean;
  onClose: () => void;
  options: SelectOption[];
  selectedIds: string[];
  multi: boolean;
  onSelect: (id: string) => void;
  onClear: () => void;
}

function SelectPicker({
  open,
  onClose,
  options,
  selectedIds,
  multi,
  onSelect,
  onClear,
}: SelectPickerProps) {
  const [query, setQuery] = React.useState("");
  const { colors } = useColorScheme();

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.name.toLowerCase().includes(q));
  }, [options, query]);

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        style={StyleSheet.absoluteFill}
        className="bg-black/40"
        onPress={onClose}
      />
      <View className="absolute left-0 right-0 bottom-0 web:bottom-auto web:top-1/2 web:left-1/2 max-w-md">
        <View
          className="bg-popover border border-border rounded-2xl shadow-xl p-3 m-3 web:m-0"
          style={centeredModalStyle(360, 360)}
        >
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search options"
            placeholderTextColor={colors.mutedForeground}
            className="text-sm text-foreground border border-border rounded-md px-2 py-1 mb-2"
            style={
              Platform.OS === "web" ? { outlineWidth: 0 } : undefined
            }
            underlineColorAndroid="transparent"
          />
          <ScrollView style={{ maxHeight: 280 }}>
            {filtered.length === 0 ? (
              <View className="px-3 py-3">
                <Text className="text-sm text-muted-foreground">
                  No options
                </Text>
              </View>
            ) : (
              filtered.map((o) => {
                const selected = selectedIds.includes(o.id);
                return (
                  <Pressable
                    key={o.id}
                    onPress={() => onSelect(o.id)}
                    className="flex-row items-center justify-between px-2 py-1.5 rounded hover:bg-muted"
                  >
                    <SelectChip option={o} />
                    {selected ? (
                      <Check size={14} color={colors.foreground} />
                    ) : null}
                  </Pressable>
                );
              })
            )}
          </ScrollView>
          {selectedIds.length > 0 ? (
            <Pressable
              onPress={onClear}
              className="mt-2 flex-row items-center gap-2 px-2 py-1 rounded hover:bg-muted"
            >
              <X size={12} color={colors.mutedForeground} />
              <Text className="text-xs text-muted-foreground">
                {multi ? "Clear all" : "Clear"}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

interface DateCellProps extends CellVariantProps {
  value: string | null;
  onChange: (next: string | null) => void;
}

function DateCell({ value, onChange, variant }: DateCellProps) {
  const { colors } = useColorScheme();
  const display = value ? new Date(value).toLocaleDateString() : "—";
  // On web, use a native date input. On native, render the date as text
  // and allow clearing — full picker is a Phase 4.5 stretch goal.
  if (Platform.OS === "web") {
    const [draft, setDraft] = React.useState<string>(
      value ? toDateInput(value) : "",
    );
    React.useEffect(() => {
      setDraft(value ? toDateInput(value) : "");
    }, [value]);

    return (
      <View className="flex-row items-center gap-2">
        <input
          type="date"
          value={draft}
          onChange={(e) => {
            const next = e.target.value;
            setDraft(next);
          }}
          onBlur={() => {
            if (!draft) {
              if (value) onChange(null);
              return;
            }
            const iso = new Date(draft).toISOString();
            if (iso !== value) onChange(iso);
          }}
          style={{
            background: "transparent",
            border: "none",
            outline: "none",
            color: colors.foreground,
            fontSize: 13,
            padding: 0,
          }}
        />
      </View>
    );
  }
  // Native fallback
  return (
    <View className={variant === "panel" ? "py-1" : ""}>
      <Text className="text-sm text-foreground">{display}</Text>
    </View>
  );
}

function toDateInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface ReadOnlyArrayCellProps extends CellVariantProps {
  value: string[];
}

function PersonCell({ value, variant }: ReadOnlyArrayCellProps) {
  if (value.length === 0) {
    return <Text className="text-sm text-muted-foreground">—</Text>;
  }
  return (
    <View className={`flex-row flex-wrap gap-1 ${variant === "panel" ? "py-1" : ""}`}>
      {value.map((id) => (
        <View
          key={id}
          className="px-2 py-0.5 rounded-md bg-muted"
        >
          <Text className="text-xs text-foreground">{shortenUserId(id)}</Text>
        </View>
      ))}
    </View>
  );
}

function shortenUserId(id: string): string {
  if (id.length <= 8) return id;
  return `${id.slice(0, 4)}…${id.slice(-3)}`;
}

interface FilesCellProps extends CellVariantProps {
  value: { name: string; url: string }[];
}

function FilesCell({ value }: FilesCellProps) {
  if (value.length === 0) {
    return <Text className="text-sm text-muted-foreground">—</Text>;
  }
  return (
    <View className="flex-row flex-wrap gap-1">
      {value.slice(0, 3).map((f) => (
        <View key={f.url} className="px-2 py-0.5 rounded-md bg-muted">
          <Text className="text-xs text-foreground" numberOfLines={1}>
            {f.name}
          </Text>
        </View>
      ))}
      {value.length > 3 ? (
        <Text className="text-xs text-muted-foreground">
          +{value.length - 3}
        </Text>
      ) : null}
    </View>
  );
}

function RelationCell({ value }: ReadOnlyArrayCellProps) {
  if (value.length === 0) {
    return <Text className="text-sm text-muted-foreground">—</Text>;
  }
  return (
    <View className="flex-row items-center gap-1">
      <Text className="text-sm text-foreground">
        {value.length} {value.length === 1 ? "page" : "pages"}
      </Text>
    </View>
  );
}

interface DerivedCellProps extends CellVariantProps {
  value: PropertyValue;
  format?: "date";
}

function DerivedCell({ value, format }: DerivedCellProps) {
  if (!value || typeof value !== "object") {
    return <Text className="text-sm text-muted-foreground">—</Text>;
  }
  if ("number" in value && typeof value.number === "number") {
    return <Text className="text-sm text-foreground">{value.number}</Text>;
  }
  if ("text" in value && typeof value.text === "string") {
    return (
      <Text className="text-sm text-foreground" numberOfLines={1}>
        {value.text || "—"}
      </Text>
    );
  }
  if ("start" in value && typeof value.start === "string") {
    const d = new Date(value.start);
    if (format === "date" && !Number.isNaN(d.getTime())) {
      return (
        <Text className="text-sm text-foreground">
          {d.toLocaleDateString()}
        </Text>
      );
    }
  }
  return <Text className="text-sm text-muted-foreground">—</Text>;
}

/**
 * "+ Add option" button for property menus.
 */
export function AddOptionButton({
  onPress,
  label,
}: {
  onPress: () => void;
  label: string;
}) {
  const { colors } = useColorScheme();
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-1 px-2 py-1 rounded hover:bg-muted"
    >
      <Plus size={12} color={colors.mutedForeground} />
      <Text className="text-xs text-muted-foreground">{label}</Text>
    </Pressable>
  );
}
