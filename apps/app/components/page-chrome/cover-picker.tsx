import * as React from "react";
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Trash2, X } from "lucide-react-native";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import {
  COVER_COLORS,
  COVER_GRADIENTS,
  encodeColor,
  encodeCoverImage,
  encodeGradient,
  encodeUnsplash,
} from "./cover-value";
import { CoverDisplay } from "./cover-display";

type Tab = "gradient" | "color" | "unsplash" | "upload" | "link";

interface CoverPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new encoded cover string or null to remove. */
  onSelect: (next: string | null) => void;
}

/**
 * Cover image picker. Gradient (default) | Color | Unsplash | Upload | Link.
 * Unsplash tab is gated behind `EXPO_PUBLIC_UNSPLASH_ACCESS_KEY`; without
 * one we show a friendly disabled state.
 */
export function CoverPicker({ open, onOpenChange, onSelect }: CoverPickerProps) {
  const [tab, setTab] = React.useState<Tab>("gradient");

  const handleSelect = React.useCallback(
    (next: string | null) => {
      onSelect(next);
      onOpenChange(false);
    },
    [onSelect, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl gap-3 p-4" showCloseButton={false}>
        <View className="flex-row items-center justify-between">
          <DialogTitle>Choose a cover</DialogTitle>
          <Pressable
            onPress={() => onOpenChange(false)}
            className="h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
            accessibilityLabel="Close"
          >
            <X size={16} className="text-muted-foreground" />
          </Pressable>
        </View>

        <View className="flex-row items-center gap-2">
          <CoverTabButton
            label="Gallery"
            active={tab === "gradient"}
            onPress={() => setTab("gradient")}
          />
          <CoverTabButton
            label="Colors"
            active={tab === "color"}
            onPress={() => setTab("color")}
          />
          <CoverTabButton
            label="Unsplash"
            active={tab === "unsplash"}
            onPress={() => setTab("unsplash")}
          />
          <CoverTabButton
            label="Link"
            active={tab === "link"}
            onPress={() => setTab("link")}
          />
          <CoverTabButton
            label="Upload"
            active={tab === "upload"}
            onPress={() => setTab("upload")}
          />
          <View className="flex-1" />
          <RemoveCoverButton onPress={() => handleSelect(null)} />
        </View>

        {tab === "gradient" ? (
          <GradientGrid
            onSelect={(idx) => handleSelect(encodeGradient(idx))}
          />
        ) : tab === "color" ? (
          <ColorGrid onSelect={(hex) => handleSelect(encodeColor(hex))} />
        ) : tab === "unsplash" ? (
          <UnsplashTab onSelect={(url) => handleSelect(encodeUnsplash(url))} />
        ) : tab === "link" ? (
          <LinkTab onSelect={(url) => handleSelect(encodeCoverImage(url))} />
        ) : (
          <UploadTab onSelect={(url) => handleSelect(encodeCoverImage(url))} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- *
 * Tab pieces
 * ---------------------------------------------------------------- */

interface CoverTabButtonProps {
  label: string;
  active: boolean;
  onPress: () => void;
}
function CoverTabButton({ label, active, onPress }: CoverTabButtonProps) {
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

function RemoveCoverButton({ onPress }: { onPress: () => void }) {
  const { colors } = useColorScheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel="Remove cover"
      className="h-8 flex-row items-center gap-1 rounded-md border border-border px-2 hover:bg-destructive/10"
    >
      <Trash2 size={14} color={colors.foreground} />
      <Text className="text-xs font-medium text-foreground">Remove</Text>
    </Pressable>
  );
}

/* ---------------------------------------------------------------- *
 * Gradient tab
 * ---------------------------------------------------------------- */

function GradientGrid({ onSelect }: { onSelect: (idx: number) => void }) {
  return (
    <ScrollView className="max-h-96">
      <View className="flex-row flex-wrap gap-2 pb-2">
        {COVER_GRADIENTS.map((g, idx) => (
          <Pressable
            key={g.name}
            onPress={() => onSelect(idx)}
            className="w-40 overflow-hidden rounded-md border border-border hover:opacity-90"
            accessibilityLabel={`${g.name} gradient`}
          >
            <CoverDisplay
              value={`gradient:${idx}`}
              height={70}
              preview
            />
            <View className="px-2 py-1">
              <Text className="text-xs text-muted-foreground">{g.name}</Text>
            </View>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

/* ---------------------------------------------------------------- *
 * Color tab
 * ---------------------------------------------------------------- */

function ColorGrid({ onSelect }: { onSelect: (hex: string) => void }) {
  return (
    <ScrollView className="max-h-96">
      <View className="flex-row flex-wrap gap-2 pb-2">
        {COVER_COLORS.map((c) => (
          <Pressable
            key={c.hex}
            onPress={() => onSelect(c.hex)}
            className="w-40 overflow-hidden rounded-md border border-border hover:opacity-90"
            accessibilityLabel={`${c.name} color`}
          >
            <CoverDisplay value={`color:${c.hex}`} height={70} preview />
            <View className="px-2 py-1">
              <Text className="text-xs text-muted-foreground">{c.name}</Text>
            </View>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

/* ---------------------------------------------------------------- *
 * Unsplash tab
 * ---------------------------------------------------------------- */

interface UnsplashImage {
  id: string;
  url: string;
  thumb: string;
  author: string;
}

async function searchUnsplash(
  query: string,
  accessKey: string,
): Promise<UnsplashImage[]> {
  const url = new URL("https://api.unsplash.com/search/photos");
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", "24");
  url.searchParams.set("orientation", "landscape");
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Client-ID ${accessKey}` },
  });
  if (!res.ok) throw new Error(`Unsplash ${res.status}`);
  const data: {
    results: Array<{
      id: string;
      urls: { regular: string; thumb: string };
      user: { name: string };
    }>;
  } = await res.json();
  return data.results.map((r) => ({
    id: r.id,
    url: r.urls.regular,
    thumb: r.urls.thumb,
    author: r.user.name,
  }));
}

function UnsplashTab({ onSelect }: { onSelect: (url: string) => void }) {
  const accessKey = process.env.EXPO_PUBLIC_UNSPLASH_ACCESS_KEY;
  const [query, setQuery] = React.useState("");
  const [submitted, setSubmitted] = React.useState("nature");

  const { data, isLoading, error } = useQuery<UnsplashImage[]>({
    queryKey: ["unsplash", submitted],
    queryFn: () => {
      if (!accessKey) throw new Error("Unsplash key not configured");
      return searchUnsplash(submitted, accessKey);
    },
    enabled: Boolean(accessKey),
    staleTime: 1000 * 60 * 5,
  });

  if (!accessKey) {
    return (
      <View className="items-center justify-center px-2 py-12">
        <Text className="text-sm text-muted-foreground">
          Unsplash key not configured.
        </Text>
      </View>
    );
  }

  const handleSubmit = () => setSubmitted(query.trim() || "nature");
  const errorMessage =
    error instanceof Error ? error.message : error ? "Failed to search" : null;

  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-2 rounded-lg border border-border px-3 py-1.5">
        <TextInput
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={handleSubmit}
          placeholder="Search Unsplash"
          className="flex-1 text-sm text-foreground"
          autoCapitalize="none"
          style={
            Platform.OS === "web"
              ? { outlineWidth: 0, borderWidth: 0, padding: 0 }
              : undefined
          }
        />
        <Pressable
          onPress={handleSubmit}
          className="rounded-md bg-primary px-3 py-1.5"
          accessibilityLabel="Search Unsplash"
        >
          <Text className="text-xs font-semibold text-primary-foreground">
            Search
          </Text>
        </Pressable>
      </View>
      {isLoading ? (
        <View className="items-center py-6">
          <ActivityIndicator />
        </View>
      ) : errorMessage ? (
        <Text className="px-2 py-6 text-center text-sm text-destructive">
          {errorMessage}
        </Text>
      ) : (
        <ScrollView className="max-h-80">
          <View className="flex-row flex-wrap gap-2 pb-2">
            {(data ?? []).map((img) => (
              <Pressable
                key={img.id}
                onPress={() => onSelect(img.url)}
                className="w-40 overflow-hidden rounded-md border border-border hover:opacity-90"
                accessibilityLabel={`Photo by ${img.author}`}
              >
                <Image
                  source={{ uri: img.thumb }}
                  style={{ width: "100%", height: 70 }}
                  resizeMode="cover"
                />
                <View className="px-2 py-1">
                  <Text className="text-xs text-muted-foreground">
                    {img.author}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

/* ---------------------------------------------------------------- *
 * Link tab
 * ---------------------------------------------------------------- */

function LinkTab({ onSelect }: { onSelect: (url: string) => void }) {
  const [url, setUrl] = React.useState("");
  return (
    <View className="gap-3 px-1 py-4">
      <Text className="text-sm text-foreground">
        Paste an image URL to use as the cover.
      </Text>
      <View className="flex-row items-center gap-2 rounded-lg border border-border px-3 py-1.5">
        <TextInput
          value={url}
          onChangeText={setUrl}
          placeholder="https://example.com/photo.jpg"
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
          onSelect(trimmed);
        }}
        className="self-start rounded-md bg-primary px-4 py-2"
        accessibilityLabel="Use image link"
      >
        <Text className="text-sm font-medium text-primary-foreground">
          Use image
        </Text>
      </Pressable>
    </View>
  );
}

/* ---------------------------------------------------------------- *
 * Upload tab
 * ---------------------------------------------------------------- */

function UploadTab({ onSelect }: { onSelect: (url: string) => void }) {
  // Direct upload to Spaces lives behind the More Block Types agent's infra
  // work. Until then, accept a URL through the same TextInput as Link. We
  // surface the message clearly so users know to use Link in the interim.
  return (
    <View className="items-center gap-2 px-2 py-12">
      <Text className="text-sm text-foreground">
        Direct upload is rolling out soon.
      </Text>
      <Text className="text-xs text-muted-foreground">
        Until then, use the Link tab to paste an image URL.
      </Text>
      <Pressable
        onPress={() => {
          // No-op; tab acts as messaging. Provide an explicit handler so the
          // `onSelect` prop's purpose stays clear if someone wires a button
          // later.
          onSelect("");
        }}
        accessibilityLabel="Acknowledge upload limitation"
        className="h-0 w-0 opacity-0"
      />
    </View>
  );
}
