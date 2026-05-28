import * as React from "react";
import { Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { Dice5, Trash2, X } from "lucide-react-native";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import {
  EMOJI_CATEGORIES,
  SKIN_TONES,
  applySkinTone,
  type EmojiEntry,
} from "./emoji-data";
import { LUCIDE_ICONS } from "./lucide-icons";
import {
  encodeEmoji,
  encodeIcon,
  encodeImage,
} from "./icon-value";

type Tab = "emoji" | "icon" | "upload";

interface IconPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Called with the new encoded icon string or `null` to clear it.
   * The caller (PageChrome) is responsible for persisting via useUpdatePage.
   */
  onSelect: (next: string | null) => void;
  /**
   * When the upload tab is enabled, used to lift an uploaded image URL into
   * the picker. Web-only for now; native renders a "coming soon" message.
   */
  onUploadImage?: (url: string) => void;
}

/**
 * Page icon picker. Tabs: Emoji (default) | Icon (lucide) | Upload (web).
 * Layout-wise the picker fits a 480px-wide popover-style dialog.
 */
export function IconPicker({
  open,
  onOpenChange,
  onSelect,
  onUploadImage,
}: IconPickerProps) {
  const [tab, setTab] = React.useState<Tab>("emoji");
  const [query, setQuery] = React.useState("");
  const [skinTone, setSkinTone] = React.useState<string>("");

  const handleSelect = React.useCallback(
    (next: string | null) => {
      onSelect(next);
      onOpenChange(false);
    },
    [onSelect, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-3 p-4" showCloseButton={false}>
        <View className="flex-row items-center justify-between">
          <DialogTitle>Choose an icon</DialogTitle>
          <Pressable
            onPress={() => onOpenChange(false)}
            className="h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
            accessibilityLabel="Close"
          >
            <X size={16} className="text-muted-foreground" />
          </Pressable>
        </View>

        {/* Tab bar + action buttons */}
        <View className="flex-row items-center gap-2">
          <PickerTabButton
            label="Emoji"
            active={tab === "emoji"}
            onPress={() => setTab("emoji")}
          />
          <PickerTabButton
            label="Icon"
            active={tab === "icon"}
            onPress={() => setTab("icon")}
          />
          <PickerTabButton
            label="Upload"
            active={tab === "upload"}
            onPress={() => setTab("upload")}
          />
          <View className="flex-1" />
          <RandomButton onPress={() => handleSelect(randomEmojiEncoded())} />
          <RemoveButton onPress={() => handleSelect(null)} />
        </View>

        {/* Search */}
        {tab !== "upload" ? (
          <View className="flex-row items-center gap-2 rounded-lg border border-border px-3 py-1.5">
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={
                tab === "emoji" ? "Search emojis…" : "Search icons…"
              }
              className="flex-1 text-sm text-foreground"
              style={
                Platform.OS === "web"
                  ? { outlineWidth: 0, borderWidth: 0, padding: 0 }
                  : undefined
              }
            />
          </View>
        ) : null}

        {/* Tab body */}
        {tab === "emoji" ? (
          <EmojiTab
            query={query}
            skinTone={skinTone}
            onChangeSkinTone={setSkinTone}
            onPickEmoji={(value) => handleSelect(encodeEmoji(value))}
          />
        ) : tab === "icon" ? (
          <IconTab
            query={query}
            onPickIcon={(name) => handleSelect(encodeIcon(name))}
          />
        ) : (
          <UploadTab
            onPickImage={(url) => {
              onUploadImage?.(url);
              handleSelect(encodeImage(url));
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- *
 * Tab bar pieces
 * ---------------------------------------------------------------- */

interface PickerTabButtonProps {
  label: string;
  active: boolean;
  onPress: () => void;
}
function PickerTabButton({ label, active, onPress }: PickerTabButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      className={
        active
          ? "rounded-md bg-muted px-3 py-1.5"
          : "rounded-md px-3 py-1.5 hover:bg-muted/60"
      }
    >
      <Text
        className={
          active
            ? "text-sm font-semibold text-foreground"
            : "text-sm text-muted-foreground"
        }
      >
        {label}
      </Text>
    </Pressable>
  );
}

function RandomButton({ onPress }: { onPress: () => void }) {
  const { colors } = useColorScheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel="Random emoji"
      className="h-8 flex-row items-center gap-1 rounded-md border border-border px-2 hover:bg-muted"
    >
      <Dice5 size={14} color={colors.foreground} />
      <Text className="text-xs font-medium text-foreground">Random</Text>
    </Pressable>
  );
}
function RemoveButton({ onPress }: { onPress: () => void }) {
  const { colors } = useColorScheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel="Remove icon"
      className="h-8 flex-row items-center gap-1 rounded-md border border-border px-2 hover:bg-destructive/10"
    >
      <Trash2 size={14} color={colors.foreground} />
      <Text className="text-xs font-medium text-foreground">Remove</Text>
    </Pressable>
  );
}

/* ---------------------------------------------------------------- *
 * Emoji tab
 * ---------------------------------------------------------------- */

interface EmojiTabProps {
  query: string;
  skinTone: string;
  onChangeSkinTone: (id: string) => void;
  onPickEmoji: (value: string) => void;
}
function EmojiTab({
  query,
  skinTone,
  onChangeSkinTone,
  onPickEmoji,
}: EmojiTabProps) {
  const normalized = query.trim().toLowerCase();
  const modifier =
    SKIN_TONES.find((tone) => tone.id === skinTone)?.modifier ?? "";

  const filtered = React.useMemo(() => {
    if (!normalized) return EMOJI_CATEGORIES;
    return EMOJI_CATEGORIES.map((cat) => ({
      ...cat,
      emojis: cat.emojis.filter((e) => e.keywords.includes(normalized)),
    })).filter((cat) => cat.emojis.length > 0);
  }, [normalized]);

  return (
    <View className="gap-2">
      {/* Skin tone row */}
      <View className="flex-row items-center gap-1">
        <Text className="text-xs text-muted-foreground">Skin tone:</Text>
        {SKIN_TONES.map((tone) => {
          const active = tone.id === skinTone || (!skinTone && tone.id === "default");
          return (
            <Pressable
              key={tone.id}
              onPress={() => onChangeSkinTone(tone.id)}
              accessibilityLabel={tone.label}
              className={
                active
                  ? "h-6 w-6 items-center justify-center rounded-full border-2 border-primary"
                  : "h-6 w-6 items-center justify-center rounded-full border border-border"
              }
            >
              <Text style={{ fontSize: 14 }}>
                {tone.modifier ? `👋${tone.modifier}` : "👋"}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <ScrollView
        className="max-h-80"
        showsVerticalScrollIndicator
        keyboardShouldPersistTaps="handled"
      >
        {filtered.length === 0 ? (
          <Text className="px-2 py-6 text-center text-sm text-muted-foreground">
            No emojis match “{query}”.
          </Text>
        ) : (
          filtered.map((cat) => (
            <View key={cat.id} className="pb-2">
              <Text className="px-1 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {cat.name}
              </Text>
              <View className="flex-row flex-wrap">
                {cat.emojis.map((entry) => (
                  <EmojiCell
                    key={entry.emoji}
                    entry={entry}
                    modifier={modifier}
                    onPress={onPickEmoji}
                  />
                ))}
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

interface EmojiCellProps {
  entry: EmojiEntry;
  modifier: string;
  onPress: (value: string) => void;
}
const EmojiCell = React.memo(function EmojiCell({
  entry,
  modifier,
  onPress,
}: EmojiCellProps) {
  const value = applySkinTone(entry, modifier);
  return (
    <Pressable
      onPress={() => onPress(value)}
      className="h-9 w-9 items-center justify-center rounded-md hover:bg-muted active:bg-muted"
      accessibilityLabel={`Emoji ${entry.keywords.split(" ")[0]}`}
    >
      <Text style={{ fontSize: 22, lineHeight: 26 }}>{value}</Text>
    </Pressable>
  );
});

/* ---------------------------------------------------------------- *
 * Icon tab (lucide)
 * ---------------------------------------------------------------- */

interface IconTabProps {
  query: string;
  onPickIcon: (name: string) => void;
}
function IconTab({ query, onPickIcon }: IconTabProps) {
  const { colors } = useColorScheme();
  const normalized = query.trim().toLowerCase();
  const filtered = React.useMemo(() => {
    if (!normalized) return LUCIDE_ICONS;
    return LUCIDE_ICONS.filter(
      (e) => e.name.includes(normalized) || e.keywords.includes(normalized),
    );
  }, [normalized]);

  return (
    <ScrollView
      className="max-h-80"
      showsVerticalScrollIndicator
      keyboardShouldPersistTaps="handled"
    >
      {filtered.length === 0 ? (
        <Text className="px-2 py-6 text-center text-sm text-muted-foreground">
          No icons match “{query}”.
        </Text>
      ) : (
        <View className="flex-row flex-wrap pb-2">
          {filtered.map((entry) => {
            const Icon = entry.Icon;
            return (
              <Pressable
                key={entry.name}
                onPress={() => onPickIcon(entry.name)}
                className="h-9 w-9 items-center justify-center rounded-md hover:bg-muted active:bg-muted"
                accessibilityLabel={entry.name}
              >
                <Icon size={18} color={colors.foreground} />
              </Pressable>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

/* ---------------------------------------------------------------- *
 * Upload tab
 * ---------------------------------------------------------------- */

interface UploadTabProps {
  onPickImage: (url: string) => void;
}
function UploadTab({ onPickImage }: UploadTabProps) {
  const [url, setUrl] = React.useState("");
  // Upload-to-S3 lives behind the More Block Types agent's infra work. Until
  // that ships, accept a direct URL on web and show a friendly message on
  // native so users at least have a path.
  return (
    <View className="gap-3 px-1 py-4">
      <Text className="text-sm text-foreground">
        Paste an image URL to use as your icon. Direct upload is rolling out
        soon.
      </Text>
      <View className="flex-row items-center gap-2 rounded-lg border border-border px-3 py-1.5">
        <TextInput
          value={url}
          onChangeText={setUrl}
          placeholder="https://example.com/icon.png"
          className="flex-1 text-sm text-foreground"
          autoCapitalize="none"
          autoCorrect={false}
          style={
            Platform.OS === "web"
              ? { outlineWidth: 0, borderWidth: 0, padding: 0 }
              : undefined
          }
        />
      </View>
      <Pressable
        onPress={() => {
          const trimmed = url.trim();
          if (!/^https?:\/\//u.test(trimmed)) return;
          onPickImage(trimmed);
        }}
        className="self-start rounded-md bg-primary px-4 py-2"
        accessibilityLabel="Use image"
      >
        <Text className="text-sm font-medium text-primary-foreground">
          Use image
        </Text>
      </Pressable>
    </View>
  );
}

/* ---------------------------------------------------------------- *
 * Random emoji helper
 * ---------------------------------------------------------------- */

function randomEmojiEncoded(): string {
  const pool = EMOJI_CATEGORIES.flatMap((c) => c.emojis);
  const entry = pool[Math.floor(Math.random() * pool.length)];
  return encodeEmoji(entry.emoji);
}
