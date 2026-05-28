import * as React from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import {
  AlignLeft,
  ChevronRight,
  Code2,
  CheckSquare,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Megaphone,
  Minus,
  Quote,
  ToggleRight,
} from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import type { BlockType } from "@/lib/types/pages";

export type SlashMenuSection =
  | "basic"
  | "media"
  | "advanced"
  | "embeds"
  | "database";

export interface SlashMenuOption {
  /** Stable id — `${section}:${type}:${suffix?}` so extensions can dedupe. */
  id: string;
  /**
   * Optional block type the option converts the current block into. Omitted
   * for "actions" (e.g. inline-database insert) that other agents own. The
   * editor only honors options with a `type`; the rest stay no-op.
   */
  type?: BlockType;
  label: string;
  description: string;
  /** Keywords improve fuzzy matching ("h1", "todo", "tasks"). */
  keywords?: readonly string[];
  section: SlashMenuSection;
  Icon: React.ComponentType<{ size?: number; color?: string }>;
  /** Web-only: optional override for the click path (e.g. open a sub-page picker). */
  onSelect?: () => void;
}

const SECTION_LABEL: Record<SlashMenuSection, string> = {
  basic: "Basic blocks",
  media: "Media",
  advanced: "Advanced",
  embeds: "Embeds",
  database: "Database",
};

const SECTION_ORDER: readonly SlashMenuSection[] = [
  "basic",
  "media",
  "advanced",
  "embeds",
  "database",
];

/**
 * Default registry shipped by the editor framework. Other Phase 2 agents
 * extend this list via `registerSlashMenuOptions` so they don't have to fork
 * the file. The editor never mutates this array directly — it composes the
 * default + every registered batch on render.
 */
const DEFAULT_OPTIONS: readonly SlashMenuOption[] = [
  {
    id: "basic:paragraph",
    type: "paragraph",
    label: "Text",
    description: "Plain text paragraph.",
    keywords: ["text", "paragraph", "p"],
    section: "basic",
    Icon: AlignLeft,
  },
  {
    id: "basic:heading_1",
    type: "heading_1",
    label: "Heading 1",
    description: "Large section heading.",
    keywords: ["h1", "title"],
    section: "basic",
    Icon: Heading1,
  },
  {
    id: "basic:heading_2",
    type: "heading_2",
    label: "Heading 2",
    description: "Medium section heading.",
    keywords: ["h2"],
    section: "basic",
    Icon: Heading2,
  },
  {
    id: "basic:heading_3",
    type: "heading_3",
    label: "Heading 3",
    description: "Small section heading.",
    keywords: ["h3"],
    section: "basic",
    Icon: Heading3,
  },
  {
    id: "basic:bulleted_list_item",
    type: "bulleted_list_item",
    label: "Bulleted list",
    description: "Create a simple bulleted list.",
    keywords: ["bullet", "ul", "list"],
    section: "basic",
    Icon: List,
  },
  {
    id: "basic:numbered_list_item",
    type: "numbered_list_item",
    label: "Numbered list",
    description: "Create a list with numbering.",
    keywords: ["ol", "1.", "ordered"],
    section: "basic",
    Icon: ListOrdered,
  },
  {
    id: "basic:to_do",
    type: "to_do",
    label: "To-do list",
    description: "Track tasks with checkboxes.",
    keywords: ["todo", "task", "checkbox"],
    section: "basic",
    Icon: CheckSquare,
  },
  {
    id: "basic:quote",
    type: "quote",
    label: "Quote",
    description: "Capture a quote.",
    keywords: ["blockquote"],
    section: "basic",
    Icon: Quote,
  },
  {
    id: "basic:divider",
    type: "divider",
    label: "Divider",
    description: "Visually divide blocks.",
    keywords: ["hr", "line"],
    section: "basic",
    Icon: Minus,
  },
  {
    id: "advanced:code",
    type: "code",
    label: "Code",
    description: "Monospace code block.",
    keywords: ["snippet", "monospace"],
    section: "advanced",
    Icon: Code2,
  },
  {
    id: "advanced:callout",
    type: "callout",
    label: "Callout",
    description: "Highlight important info.",
    keywords: ["note", "info"],
    section: "advanced",
    Icon: Megaphone,
  },
  {
    id: "advanced:toggle",
    type: "toggle",
    label: "Toggle",
    description: "Click to expand or collapse content.",
    keywords: ["dropdown", "collapsible", "details"],
    section: "advanced",
    Icon: ToggleRight,
  },
];

/**
 * Extensions registry. Other Phase 2 agents call `registerSlashMenuOptions`
 * (e.g. from a module top-level) to attach their items without touching this
 * file. The registration is global — fine for an in-memory editor session,
 * and idempotent by `id`.
 */
const extensionsById = new Map<string, SlashMenuOption>();

/**
 * Register one or more extension options. Idempotent — re-registering an id
 * overwrites the previous entry. Other agents (databases, media, embeds) call
 * this from their module entry-point.
 */
export function registerSlashMenuOptions(
  options: readonly SlashMenuOption[],
): void {
  for (const opt of options) {
    extensionsById.set(opt.id, opt);
  }
}

/** Read the merged registry — defaults plus all extensions, deduped by id. */
export function getSlashMenuOptions(): readonly SlashMenuOption[] {
  const byId = new Map<string, SlashMenuOption>();
  for (const o of DEFAULT_OPTIONS) byId.set(o.id, o);
  for (const [id, o] of extensionsById) byId.set(id, o);
  return [...byId.values()];
}

/**
 * Kept for backward compatibility with imports from earlier code. Prefer
 * `getSlashMenuOptions()` when reading the registry dynamically.
 */
export const SLASH_MENU_OPTIONS: readonly SlashMenuOption[] = DEFAULT_OPTIONS;

interface SlashMenuProps {
  open: boolean;
  query: string;
  onSelect: (type: BlockType, option: SlashMenuOption) => void;
  onClose: () => void;
}

/**
 * Score query against an option — lightweight fuzzy match.
 * Prefix matches on label/keywords win over substring matches.
 */
function scoreOption(opt: SlashMenuOption, q: string): number {
  if (!q) return 0;
  const lq = q.toLowerCase();
  const label = opt.label.toLowerCase();
  const type = opt.type ?? "";
  if (label.startsWith(lq)) return 100;
  if (type.startsWith(lq)) return 90;
  if (opt.keywords?.some((k) => k.toLowerCase().startsWith(lq))) return 80;
  if (label.includes(lq)) return 60;
  if (type.includes(lq)) return 50;
  if (opt.keywords?.some((k) => k.toLowerCase().includes(lq))) return 40;
  return -1;
}

export function SlashMenu({ open, query, onSelect, onClose }: SlashMenuProps) {
  const { colors } = useColorScheme();
  const all = React.useMemo(() => getSlashMenuOptions(), []);
  const filtered = React.useMemo(() => {
    const q = query.trim();
    if (!q) return all;
    return all
      .map((opt) => ({ opt, score: scoreOption(opt, q) }))
      .filter((row) => row.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((row) => row.opt);
  }, [all, query]);

  const grouped = React.useMemo(() => {
    const buckets = new Map<SlashMenuSection, SlashMenuOption[]>();
    for (const opt of filtered) {
      const arr = buckets.get(opt.section) ?? [];
      arr.push(opt);
      buckets.set(opt.section, arr);
    }
    const out: { section: SlashMenuSection; options: SlashMenuOption[] }[] = [];
    for (const section of SECTION_ORDER) {
      const options = buckets.get(section);
      if (options && options.length > 0) out.push({ section, options });
    }
    return out;
  }, [filtered]);

  const [activeIndex, setActiveIndex] = React.useState(0);
  React.useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Keyboard nav (web only). Native: tap-to-select via Modal list.
  React.useEffect(() => {
    if (!open) return;
    if (Platform.OS !== "web") return;
    const handler = (ev: KeyboardEvent) => {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
      } else if (ev.key === "Enter") {
        const target = filtered[activeIndex];
        if (target) {
          ev.preventDefault();
          handleSelect(target);
        }
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  });

  const handleSelect = (opt: SlashMenuOption) => {
    if (opt.onSelect) {
      opt.onSelect();
      return;
    }
    if (opt.type) {
      onSelect(opt.type, opt);
    }
  };

  if (!open) return null;

  const renderRow = (opt: SlashMenuOption, flatIndex: number) => {
    const isActive = flatIndex === activeIndex;
    return (
      <Pressable
        key={opt.id}
        onPress={() => handleSelect(opt)}
        onHoverIn={Platform.OS === "web" ? () => setActiveIndex(flatIndex) : undefined}
        className={
          isActive
            ? "flex-row items-center gap-3 px-3 py-2 bg-muted"
            : "flex-row items-center gap-3 px-3 py-2 hover:bg-muted"
        }
      >
        <View className="h-8 w-8 items-center justify-center rounded-md bg-muted">
          <opt.Icon size={16} color={colors.foreground} />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-medium text-foreground">
            {opt.label}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {opt.description}
          </Text>
        </View>
        {isActive ? (
          <ChevronRight size={14} color={colors.mutedForeground} />
        ) : null}
      </Pressable>
    );
  };

  let flatIndex = 0;
  const list = (
    <View className="w-80 rounded-2xl border border-border bg-popover py-1 shadow-lg">
      <ScrollView className="max-h-80" contentContainerClassName="py-1">
        {filtered.length === 0 ? (
          <View className="px-3 py-3">
            <Text className="text-sm text-muted-foreground">
              No matches for “{query}”
            </Text>
          </View>
        ) : (
          grouped.map(({ section, options }) => (
            <View key={section}>
              <View className="px-3 pt-2 pb-1">
                <Text className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {SECTION_LABEL[section]}
                </Text>
              </View>
              {options.map((opt) => {
                const row = renderRow(opt, flatIndex);
                flatIndex += 1;
                return row;
              })}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );

  // Web: absolute-positioned popover just below the current block's input.
  // The parent renders this inside a `relative` container so 0,0 ≈ caret row.
  if (Platform.OS === "web") {
    return (
      <View style={styles.webPopover} pointerEvents="box-none">
        <View style={styles.webPopoverInner} pointerEvents="auto">
          {list}
        </View>
      </View>
    );
  }

  // Native: bottom sheet via Modal — simple, no positional math.
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
      <View className="absolute bottom-0 left-0 right-0 p-3">{list}</View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  webPopover: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 50,
  },
  webPopoverInner: {
    position: "absolute",
    top: 0,
    left: 0,
  },
});
