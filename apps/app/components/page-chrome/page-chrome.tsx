import * as React from "react";
import {
  Platform,
  Pressable,
  TextInput,
  View,
  type GestureResponderEvent,
} from "react-native";
import { ImageIcon, Move, Smile } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import { useUpdatePage } from "@/lib/hooks/use-pages";
import type { Page } from "@/lib/types/pages";
import { Breadcrumb } from "./breadcrumb";
import { CoverDisplay } from "./cover-display";
import { CoverPicker } from "./cover-picker";
import { FavoriteButton } from "./favorite-button";
import { IconDisplay } from "./icon-display";
import { IconPicker } from "./icon-picker";
import { PageActionsMenu } from "./page-actions-menu";

interface PageChromeProps {
  page: Page;
  /** Editor (or any body content) rendered below the page header. */
  children?: React.ReactNode;
  /** Right-side header content (ShareButton lives here in the page route). */
  rightHeader?: React.ReactNode;
}

interface PageChromeState {
  setIconOpen: (open: boolean) => void;
  setCoverOpen: (open: boolean) => void;
  setRepositioning: (next: boolean | ((prev: boolean) => boolean)) => void;
}
const StateContext = React.createContext<PageChromeState | null>(null);

/**
 * Page-level chrome.
 *
 * Layers:
 *   1. Sticky top bar — breadcrumb + favorite + actions.
 *   2. Children — the page route renders its own ScrollView containing the
 *      `PageHeader` component (cover + icon + title) and the editor. That
 *      keeps the cover/title scrolling with the content, while the top bar
 *      stays pinned.
 *
 * The icon and cover pickers are mounted here as portals — the children
 * can open them via `usePageChrome()`.
 */
export function PageChrome({ page, children, rightHeader }: PageChromeProps) {
  const updatePage = useUpdatePage();
  const [iconOpen, setIconOpen] = React.useState(false);
  const [coverOpen, setCoverOpen] = React.useState(false);
  const [repositioning, setRepositioning] = React.useState(false);

  const handleIconSelect = React.useCallback(
    (next: string | null) => {
      updatePage.mutate({ id: page._id, icon: next });
    },
    [page._id, updatePage],
  );
  const handleCoverSelect = React.useCallback(
    (next: string | null) => {
      updatePage.mutate({ id: page._id, cover: next, coverPosition: 50 });
    },
    [page._id, updatePage],
  );

  const stateValue = React.useMemo<PageChromeState>(
    () => ({ setIconOpen, setCoverOpen, setRepositioning }),
    [],
  );

  return (
    <StateContext.Provider value={stateValue}>
      <View className="flex-1 bg-background">
        {/* Sticky top bar (always visible above the scroll). */}
        <View className="h-12 flex-row items-center justify-between border-b border-border/30 px-4 md:px-6">
          <View className="flex-1 min-w-0">
            <Breadcrumb pageId={page._id} workspaceId={page.workspaceId} />
          </View>
          <View className="flex-row items-center gap-1">
            <FavoriteButton
              pageId={page._id}
              favorited={page.favorited ?? false}
            />
            {rightHeader}
            <PageActionsMenu page={page} />
          </View>
        </View>

        <RepositioningContext.Provider value={repositioning}>
          {children}
        </RepositioningContext.Provider>

        <IconPicker
          open={iconOpen}
          onOpenChange={setIconOpen}
          onSelect={handleIconSelect}
        />
        <CoverPicker
          open={coverOpen}
          onOpenChange={setCoverOpen}
          onSelect={handleCoverSelect}
        />
      </View>
    </StateContext.Provider>
  );
}

const RepositioningContext = React.createContext<boolean>(false);

/**
 * `PageHeader` — cover + icon + title. Designed to live INSIDE the route's
 * ScrollView so it scrolls with the page content. Reads picker state from
 * the surrounding `<PageChrome>` via context.
 */
export function PageHeader({ page }: { page: Page }) {
  const state = React.useContext(StateContext);
  const repositioning = React.useContext(RepositioningContext);
  const updatePage = useUpdatePage();
  const [titleDraft, setTitleDraft] = React.useState<string | null>(null);

  const title = titleDraft ?? page.title;

  const handleTitleBlur = React.useCallback(() => {
    if (titleDraft === null) return;
    if (titleDraft === page.title) {
      setTitleDraft(null);
      return;
    }
    updatePage.mutate({ id: page._id, title: titleDraft });
    setTitleDraft(null);
  }, [titleDraft, page.title, page._id, updatePage]);

  const handleCommitReposition = React.useCallback(
    (nextPosition: number) => {
      const clamped = Math.min(100, Math.max(0, Math.round(nextPosition)));
      if (clamped === (page.coverPosition ?? 50)) return;
      updatePage.mutate({ id: page._id, coverPosition: clamped });
    },
    [page._id, page.coverPosition, updatePage],
  );

  return (
    <View>
      <CoverArea
        cover={page.cover ?? null}
        position={page.coverPosition ?? 50}
        onOpenPicker={() => state?.setCoverOpen(true)}
        repositioning={repositioning}
        onToggleReposition={() => state?.setRepositioning((v) => !v)}
        onCommitPosition={handleCommitReposition}
      />
      <View
        className="px-6 md:px-10 max-w-3xl w-full mx-auto"
        style={{ marginTop: page.cover ? -32 : 24 }}
      >
        <IconArea
          icon={page.icon ?? null}
          onOpenPicker={() => state?.setIconOpen(true)}
        />
        <AddChromeRow
          hasIcon={Boolean(page.icon)}
          hasCover={Boolean(page.cover)}
          onAddIcon={() => state?.setIconOpen(true)}
          onAddCover={() => state?.setCoverOpen(true)}
        />
        <TitleInput
          value={title}
          onChangeText={setTitleDraft}
          onBlur={handleTitleBlur}
        />
      </View>
    </View>
  );
}

/* ---------------------------------------------------------------- *
 * Cover area
 * ---------------------------------------------------------------- */

interface CoverAreaProps {
  cover: string | null;
  position: number;
  onOpenPicker: () => void;
  repositioning: boolean;
  onToggleReposition: () => void;
  onCommitPosition: (next: number) => void;
}
function CoverArea({
  cover,
  position,
  onOpenPicker,
  repositioning,
  onToggleReposition,
  onCommitPosition,
}: CoverAreaProps) {
  const [localPosition, setLocalPosition] = React.useState<number | null>(null);
  const startY = React.useRef<number | null>(null);
  const startPos = React.useRef<number>(position);

  const effectivePosition = localPosition ?? position;

  const handleStart = React.useCallback(
    (e: GestureResponderEvent) => {
      if (!repositioning) return;
      startY.current = e.nativeEvent.pageY;
      startPos.current = effectivePosition;
    },
    [repositioning, effectivePosition],
  );
  const handleMove = React.useCallback(
    (e: GestureResponderEvent) => {
      if (!repositioning || startY.current === null) return;
      const delta = e.nativeEvent.pageY - startY.current;
      // 200px cover height → roughly 100% range. ~2px per percent.
      const next = startPos.current + delta / 2;
      setLocalPosition(Math.min(100, Math.max(0, next)));
    },
    [repositioning],
  );
  const handleEnd = React.useCallback(() => {
    if (!repositioning) return;
    if (localPosition !== null) onCommitPosition(localPosition);
    setLocalPosition(null);
    startY.current = null;
    onToggleReposition();
  }, [repositioning, localPosition, onCommitPosition, onToggleReposition]);

  if (!cover) return <View className="h-2" />;

  return (
    <View className="relative">
      <View
        onStartShouldSetResponder={() => repositioning}
        onMoveShouldSetResponder={() => repositioning}
        onResponderGrant={handleStart}
        onResponderMove={handleMove}
        onResponderRelease={handleEnd}
        onResponderTerminate={handleEnd}
        accessibilityLabel="Cover"
      >
        <CoverDisplay value={cover} position={effectivePosition} height={192} />
      </View>
      <View className="absolute right-3 top-3 flex-row gap-2">
        <Pressable
          onPress={onToggleReposition}
          className={
            repositioning
              ? "h-8 flex-row items-center gap-1 rounded-md bg-primary px-3"
              : "h-8 flex-row items-center gap-1 rounded-md bg-card/90 px-3 hover:bg-card"
          }
          accessibilityLabel="Reposition cover"
        >
          <Move
            size={14}
            color={repositioning ? "white" : undefined}
            className={repositioning ? undefined : "text-foreground"}
          />
          <Text
            className={
              repositioning
                ? "text-xs font-medium text-primary-foreground"
                : "text-xs font-medium text-foreground"
            }
          >
            {repositioning ? "Save position" : "Reposition"}
          </Text>
        </Pressable>
        <Pressable
          onPress={onOpenPicker}
          className="h-8 flex-row items-center gap-1 rounded-md bg-card/90 px-3 hover:bg-card"
          accessibilityLabel="Change cover"
        >
          <ImageIcon size={14} className="text-foreground" />
          <Text className="text-xs font-medium text-foreground">
            Change cover
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/* ---------------------------------------------------------------- *
 * Icon area
 * ---------------------------------------------------------------- */

interface IconAreaProps {
  icon: string | null;
  onOpenPicker: () => void;
}
function IconArea({ icon, onOpenPicker }: IconAreaProps) {
  if (!icon) return null;
  return (
    <Pressable
      onPress={onOpenPicker}
      className="self-start rounded-md p-1 hover:bg-muted"
      accessibilityLabel="Change icon"
    >
      <IconDisplay value={icon} size={64} />
    </Pressable>
  );
}

/* ---------------------------------------------------------------- *
 * Add-chrome row
 * ---------------------------------------------------------------- */

interface AddChromeRowProps {
  hasIcon: boolean;
  hasCover: boolean;
  onAddIcon: () => void;
  onAddCover: () => void;
}
function AddChromeRow({
  hasIcon,
  hasCover,
  onAddIcon,
  onAddCover,
}: AddChromeRowProps) {
  if (hasIcon && hasCover) return null;
  return (
    <View className="flex-row gap-2 pb-3">
      {!hasIcon ? (
        <AddChromeButton icon="emoji" onPress={onAddIcon} label="Add icon" />
      ) : null}
      {!hasCover ? (
        <AddChromeButton icon="cover" onPress={onAddCover} label="Add cover" />
      ) : null}
    </View>
  );
}

interface AddChromeButtonProps {
  icon: "emoji" | "cover";
  label: string;
  onPress: () => void;
}
function AddChromeButton({ icon, label, onPress }: AddChromeButtonProps) {
  const { colors } = useColorScheme();
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-1.5 rounded-md px-2 py-1 hover:bg-muted"
      accessibilityLabel={label}
    >
      {icon === "emoji" ? (
        <Smile size={14} color={colors.mutedForeground} />
      ) : (
        <ImageIcon size={14} color={colors.mutedForeground} />
      )}
      <Text className="text-xs text-muted-foreground">{label}</Text>
    </Pressable>
  );
}

/* ---------------------------------------------------------------- *
 * Title input
 * ---------------------------------------------------------------- */

interface TitleInputProps {
  value: string;
  onChangeText: (next: string) => void;
  onBlur: () => void;
}
function TitleInput({ value, onChangeText, onBlur }: TitleInputProps) {
  const { colors } = useColorScheme();
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      onBlur={onBlur}
      placeholder="Untitled"
      placeholderTextColor={colors.mutedForeground}
      className="text-4xl font-bold text-foreground"
      multiline
      scrollEnabled={false}
      style={
        Platform.OS === "web"
          ? { outlineWidth: 0, borderWidth: 0, padding: 0 }
          : undefined
      }
      underlineColorAndroid="transparent"
    />
  );
}
