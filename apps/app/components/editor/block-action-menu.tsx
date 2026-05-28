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
  ChevronRight,
  Copy,
  Link,
  Move,
  Palette,
  Trash2,
  Wand2,
} from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import type { BlockColor, BlockType } from "@/lib/types/pages";
import { BLOCK_COLORS } from "@/lib/types/pages";
import { getSlashMenuOptions, type SlashMenuOption } from "./slash-menu";

export interface BlockActionMenuProps {
  open: boolean;
  /** Anchor in viewport coordinates (web). Native ignores. */
  anchor?: { top: number; left: number } | null;
  /** The block's current type — drives the "Turn into" highlight. */
  currentType: BlockType;
  onClose: () => void;
  onTurnInto: (type: BlockType) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onSetColor: (color: BlockColor) => void;
  onSetBackground: (color: BlockColor) => void;
  onCopyLink: () => void;
}

type Submenu = "turn-into" | "color" | "background" | null;

/**
 * Block-level action menu, opened from the drag handle (or Cmd+/).
 * Native renders a bottom-sheet style modal; web positions next to the
 * drag handle.
 */
export function BlockActionMenu(props: BlockActionMenuProps) {
  const { open, onClose } = props;
  if (!open) return null;
  if (Platform.OS === "web") {
    return <BlockActionMenuWeb {...props} />;
  }
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={StyleSheet.absoluteFill}
        className="bg-black/50"
        onPress={onClose}
      />
      <View className="absolute bottom-0 left-0 right-0 p-3">
        <View className="rounded-2xl border border-border bg-popover py-1 shadow-lg">
          <BlockActionMenuItems {...props} />
        </View>
      </View>
    </Modal>
  );
}

function BlockActionMenuWeb(props: BlockActionMenuProps) {
  const { anchor, onClose } = props;
  const top = anchor?.top ?? 0;
  const left = anchor?.left ?? 0;

  // Close on outside click — listen at the document level once.
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const handler = (ev: MouseEvent) => {
      const node = ref.current;
      if (!node) return;
      if (!node.contains(ev.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Close on Escape.
  React.useEffect(() => {
    const handler = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <View style={[styles.popover, { top, left }]}>
      <div
        ref={ref}
        style={{ display: "contents" }}
      >
        <View className="w-72 rounded-2xl border border-border bg-popover py-1 shadow-lg">
          <BlockActionMenuItems {...props} />
        </View>
      </div>
    </View>
  );
}

function BlockActionMenuItems({
  currentType,
  onClose,
  onTurnInto,
  onDuplicate,
  onDelete,
  onSetColor,
  onSetBackground,
  onCopyLink,
}: BlockActionMenuProps) {
  const { colors } = useColorScheme();
  const [submenu, setSubmenu] = React.useState<Submenu>(null);

  const select = (cb: () => void) => () => {
    cb();
    onClose();
  };

  if (submenu === "turn-into") {
    return (
      <TurnIntoSubmenu
        currentType={currentType}
        onSelect={(t) => {
          onTurnInto(t);
          onClose();
        }}
        onBack={() => setSubmenu(null)}
      />
    );
  }
  if (submenu === "color") {
    return (
      <ColorSubmenu
        label="Text color"
        onPick={(c) => {
          onSetColor(c);
          onClose();
        }}
        onBack={() => setSubmenu(null)}
      />
    );
  }
  if (submenu === "background") {
    return (
      <ColorSubmenu
        label="Background"
        onPick={(c) => {
          onSetBackground(c);
          onClose();
        }}
        onBack={() => setSubmenu(null)}
      />
    );
  }

  return (
    <View>
      <Row
        Icon={Wand2}
        label="Turn into"
        accessory={<ChevronRight size={14} color={colors.mutedForeground} />}
        onPress={() => setSubmenu("turn-into")}
      />
      <Row Icon={Copy} label="Duplicate" onPress={select(onDuplicate)} />
      <Row
        Icon={Trash2}
        label="Delete"
        tone="danger"
        onPress={select(onDelete)}
      />
      <Divider />
      <Row
        Icon={Palette}
        label="Color"
        accessory={<ChevronRight size={14} color={colors.mutedForeground} />}
        onPress={() => setSubmenu("color")}
      />
      <Row
        Icon={Palette}
        label="Background"
        accessory={<ChevronRight size={14} color={colors.mutedForeground} />}
        onPress={() => setSubmenu("background")}
      />
      <Divider />
      <Row Icon={Link} label="Copy link to block" onPress={select(onCopyLink)} />
      <Row
        Icon={Move}
        label="Move to"
        disabled
        accessory={
          <Text className="text-[10px] uppercase text-muted-foreground">
            Phase 5
          </Text>
        }
      />
    </View>
  );
}

function TurnIntoSubmenu({
  currentType,
  onSelect,
  onBack,
}: {
  currentType: BlockType;
  onSelect: (type: BlockType) => void;
  onBack: () => void;
}) {
  const { colors } = useColorScheme();
  const options = React.useMemo(
    () => getSlashMenuOptions().filter((o): o is SlashMenuOption & { type: BlockType } => Boolean(o.type)),
    [],
  );
  return (
    <View>
      <Pressable
        onPress={onBack}
        className="flex-row items-center gap-2 px-3 py-2 hover:bg-muted"
      >
        <ChevronRight
          size={14}
          color={colors.mutedForeground}
          style={{ transform: [{ rotate: "180deg" }] }}
        />
        <Text className="text-sm font-medium text-foreground">Turn into</Text>
      </Pressable>
      <Divider />
      <ScrollView className="max-h-80">
        {options.map((opt) => (
          <Pressable
            key={opt.id}
            onPress={() => onSelect(opt.type)}
            className={
              opt.type === currentType
                ? "flex-row items-center gap-2 px-3 py-2 bg-muted"
                : "flex-row items-center gap-2 px-3 py-2 hover:bg-muted"
            }
          >
            <View className="h-7 w-7 items-center justify-center rounded-md bg-muted">
              <opt.Icon size={14} color={colors.foreground} />
            </View>
            <Text className="text-sm text-foreground">{opt.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

function ColorSubmenu({
  label,
  onPick,
  onBack,
}: {
  label: string;
  onPick: (color: BlockColor) => void;
  onBack: () => void;
}) {
  const { colors } = useColorScheme();
  return (
    <View>
      <Pressable
        onPress={onBack}
        className="flex-row items-center gap-2 px-3 py-2 hover:bg-muted"
      >
        <ChevronRight
          size={14}
          color={colors.mutedForeground}
          style={{ transform: [{ rotate: "180deg" }] }}
        />
        <Text className="text-sm font-medium text-foreground">{label}</Text>
      </Pressable>
      <Divider />
      <View className="p-2">
        <View className="flex-row flex-wrap gap-1">
          {BLOCK_COLORS.map((c) => (
            <Pressable
              key={c}
              onPress={() => onPick(c)}
              className="h-9 w-9 items-center justify-center rounded-md border border-border hover:bg-muted"
              accessibilityLabel={c}
            >
              <View
                className="h-4 w-4 rounded-sm"
                style={{ backgroundColor: SWATCH[c] ?? "transparent", borderWidth: c === "default" ? 1 : 0, borderColor: "#cbd5e1" }}
              />
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}

const SWATCH: Record<BlockColor, string | undefined> = {
  default: undefined,
  gray: "#9CA3AF",
  brown: "#92400E",
  orange: "#F97316",
  yellow: "#EAB308",
  green: "#10B981",
  blue: "#3B82F6",
  purple: "#A855F7",
  pink: "#EC4899",
  red: "#EF4444",
};

function Row({
  Icon,
  label,
  accessory,
  onPress,
  disabled,
  tone,
}: {
  Icon: React.ComponentType<{ size?: number; color?: string }>;
  label: string;
  accessory?: React.ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  tone?: "default" | "danger";
}) {
  const { colors } = useColorScheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className={
        disabled
          ? "flex-row items-center gap-2 px-3 py-2 opacity-50"
          : "flex-row items-center gap-2 px-3 py-2 hover:bg-muted"
      }
    >
      <Icon
        size={14}
        color={
          tone === "danger" ? "#ef4444" : colors.mutedForeground
        }
      />
      <Text
        className={
          tone === "danger"
            ? "flex-1 text-sm text-red-500"
            : "flex-1 text-sm text-foreground"
        }
      >
        {label}
      </Text>
      {accessory}
    </Pressable>
  );
}

function Divider() {
  return <View className="my-1 h-px w-full bg-border" />;
}

const styles = StyleSheet.create({
  popover: {
    position: "absolute",
    zIndex: 70,
  },
});
