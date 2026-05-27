import React from "react";
import { View, Pressable, Platform, ActivityIndicator } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Copy, Link2, Trash2, ChevronDown } from "lucide-react-native";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { toast } from "@/components/sonner";
import { useColorScheme } from "@/lib/useColorScheme";
import {
  useShareLinks,
  useCreateShareLink,
  useRevokeShareLink,
  SHARE_LINK_SCOPES,
  type ShareLink,
  type ShareLinkScope,
} from "@/lib/hooks/use-share-links";
import { buildShareUrl } from "./build-share-url";

const SCOPE_LABELS: Record<ShareLinkScope, string> = {
  read: "Can view",
  comment: "Can comment",
  edit: "Can edit",
};

const SCOPE_DESCRIPTIONS: Record<ShareLinkScope, string> = {
  read: "View page contents.",
  comment: "View and add comments.",
  edit: "View, comment, and edit.",
};

function isExpired(link: ShareLink): boolean {
  if (!link.expiresAt) return false;
  return new Date(link.expiresAt).getTime() < Date.now();
}

function formatExpiry(expiresAt: string | null): string {
  if (!expiresAt) return "Never expires";
  try {
    const date = new Date(expiresAt);
    return `Expires ${date.toLocaleString()}`;
  } catch {
    return "Has expiry";
  }
}

interface ExistingLinkRowProps {
  link: ShareLink;
  pageId: string;
}

function ExistingLinkRow({ link, pageId }: ExistingLinkRowProps) {
  const { colors } = useColorScheme();
  const { mutate: revoke, isPending: isRevoking } = useRevokeShareLink(pageId);
  const url = buildShareUrl(link.token);
  const expired = isExpired(link);

  const handleCopy = React.useCallback(async () => {
    await Clipboard.setStringAsync(url);
    toast.success("Link copied");
  }, [url]);

  const handleRevoke = React.useCallback(() => {
    revoke(link._id, {
      onSuccess: () => toast.success("Link revoked"),
      onError: (err) => {
        const message =
          err instanceof Error && err.message
            ? err.message
            : "Failed to revoke link";
        toast.error(message);
      },
    });
  }, [revoke, link._id]);

  return (
    <View className="flex-row items-center gap-2 px-2 py-2 rounded-lg">
      <Link2 size={14} color={colors.mutedForeground} />
      <View className="flex-1 min-w-0">
        <Text
          className="text-xs font-mono text-foreground"
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {url}
        </Text>
        <Text className="text-[11px] text-muted-foreground">
          {SCOPE_LABELS[link.scope]} · {formatExpiry(link.expiresAt)}
          {expired ? " · expired" : ""}
        </Text>
      </View>
      <Pressable
        onPress={handleCopy}
        className="h-8 w-8 items-center justify-center rounded-lg hover:bg-muted"
        accessibilityLabel="Copy share link"
        accessibilityRole="button"
      >
        <Copy size={14} color={colors.foreground} />
      </Pressable>
      <Pressable
        onPress={handleRevoke}
        disabled={isRevoking}
        className="h-8 w-8 items-center justify-center rounded-lg hover:bg-destructive/10"
        accessibilityLabel="Revoke share link"
        accessibilityRole="button"
      >
        {isRevoking ? (
          <ActivityIndicator size="small" />
        ) : (
          <Trash2 size={14} className="text-destructive" />
        )}
      </Pressable>
    </View>
  );
}

interface ShareModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pageId: string;
}

export function ShareModal({ open, onOpenChange, pageId }: ShareModalProps) {
  const { colors } = useColorScheme();
  const [scope, setScope] = React.useState<ShareLinkScope>("read");
  const {
    data: links,
    isLoading: isListLoading,
    isError,
    error,
  } = useShareLinks(pageId, { enabled: open && Boolean(pageId) });
  const { mutate: createLink, isPending: isCreating } =
    useCreateShareLink(pageId);

  const activeLinks = React.useMemo(
    () => (links ?? []).filter((l) => !l.revokedAt),
    [links],
  );
  const matchingLink = React.useMemo(
    () =>
      activeLinks.find((l) => l.scope === scope && !isExpired(l)) ?? null,
    [activeLinks, scope],
  );

  const isPublic = matchingLink !== null;

  const handleTogglePublic = React.useCallback(
    (next: boolean) => {
      if (next) {
        if (matchingLink) return;
        createLink(
          { scope, expiresAt: null },
          {
            onSuccess: async (link) => {
              const url = buildShareUrl(link.token);
              await Clipboard.setStringAsync(url);
              toast.success("Public link created — copied to clipboard");
            },
            onError: (err) => {
              const message =
                err instanceof Error && err.message
                  ? err.message
                  : "Failed to create share link";
              toast.error(message);
            },
          },
        );
      } else {
        toast("Use the revoke button next to a link to disable it.");
      }
    },
    [createLink, matchingLink, scope],
  );

  const handleCopyActive = React.useCallback(async () => {
    if (!matchingLink) return;
    await Clipboard.setStringAsync(buildShareUrl(matchingLink.token));
    toast.success("Link copied");
  }, [matchingLink]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share this page</DialogTitle>
          <DialogDescription>
            Create a public link to share this page with anyone — even
            people without an Oxy account.
          </DialogDescription>
        </DialogHeader>

        <View className="gap-3">
          <View className="rounded-xl border border-border p-3 gap-2">
            <View className="flex-row items-center justify-between gap-3">
              <View className="flex-1 min-w-0">
                <Text className="text-sm font-semibold text-foreground">
                  Anyone with the link
                </Text>
                <Text className="text-xs text-muted-foreground">
                  {isPublic
                    ? `${SCOPE_LABELS[scope]} — no sign-in required`
                    : "No public link is active"}
                </Text>
              </View>
              <Switch
                value={isPublic}
                onValueChange={handleTogglePublic}
                disabled={isCreating}
              />
            </View>

            <View className="flex-row items-center gap-2">
              <Text className="text-xs text-muted-foreground">Access:</Text>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  <Pressable
                    className="h-8 px-2 flex-row items-center gap-1 rounded-lg border border-border hover:bg-muted"
                    accessibilityRole="button"
                    accessibilityLabel={`Selected scope ${SCOPE_LABELS[scope]}`}
                  >
                    <Text className="text-xs font-medium text-foreground">
                      {SCOPE_LABELS[scope]}
                    </Text>
                    <ChevronDown size={12} color={colors.mutedForeground} />
                  </Pressable>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content>
                  {SHARE_LINK_SCOPES.map((option) => (
                    <DropdownMenu.Item
                      key={option}
                      onSelect={() => setScope(option)}
                    >
                      {Platform.OS === "web" ? (
                        <View className="gap-0.5">
                          <Text className="text-sm font-medium text-foreground">
                            {SCOPE_LABELS[option]}
                          </Text>
                          <Text className="text-xs text-muted-foreground">
                            {SCOPE_DESCRIPTIONS[option]}
                          </Text>
                        </View>
                      ) : (
                        <>
                          <DropdownMenu.ItemTitle>
                            {SCOPE_LABELS[option]}
                          </DropdownMenu.ItemTitle>
                          <DropdownMenu.ItemSubtitle>
                            {SCOPE_DESCRIPTIONS[option]}
                          </DropdownMenu.ItemSubtitle>
                        </>
                      )}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </View>

            {isPublic && matchingLink ? (
              <View className="flex-row items-center gap-2 mt-1">
                <View className="flex-1 min-w-0 rounded-lg border border-border bg-muted/30 px-2 py-1.5">
                  <Text
                    className="text-xs font-mono text-foreground"
                    numberOfLines={1}
                    ellipsizeMode="middle"
                  >
                    {buildShareUrl(matchingLink.token)}
                  </Text>
                </View>
                <Button size="sm" onPress={handleCopyActive}>
                  <View className="flex-row items-center gap-1">
                    <Copy size={12} className="text-primary-foreground" />
                    <Text className="text-xs font-semibold text-primary-foreground">
                      Copy
                    </Text>
                  </View>
                </Button>
              </View>
            ) : null}
          </View>

          <View className="gap-1">
            <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Existing links
            </Text>
            {isListLoading ? (
              <View className="py-4 items-center">
                <ActivityIndicator />
              </View>
            ) : isError ? (
              <Text className="text-sm text-destructive">
                {error instanceof Error
                  ? error.message
                  : "Failed to load share links"}
              </Text>
            ) : activeLinks.length === 0 ? (
              <Text className="text-xs text-muted-foreground">
                No share links yet.
              </Text>
            ) : (
              <View className="rounded-lg border border-border bg-card overflow-hidden">
                {activeLinks.map((link, idx) => (
                  <View key={link._id}>
                    {idx > 0 ? (
                      <View className="h-px bg-border/50 mx-2" />
                    ) : null}
                    <ExistingLinkRow link={link} pageId={pageId} />
                  </View>
                ))}
              </View>
            )}
          </View>
        </View>
      </DialogContent>
    </Dialog>
  );
}
