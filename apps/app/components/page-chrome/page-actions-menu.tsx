import * as React from "react";
import { Platform, Pressable } from "react-native";
import * as Clipboard from "expo-clipboard";
import { MoreHorizontal } from "lucide-react-native";
import { useRouter } from "expo-router";
import { useOxy } from "@oxyhq/services";
import { toast } from "@oxyhq/bloom/toast";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { useColorScheme } from "@/lib/useColorScheme";
import {
  useDeletePage,
  useDuplicatePage,
  useUpdatePage,
} from "@/lib/hooks/use-pages";
import apiClient from "@/lib/api/client";
import { API_ROUTES } from "@/lib/api/routes";
import type { Page } from "@/lib/types/pages";
import { MoveToDialog } from "./move-to-dialog";

interface PageActionsMenuProps {
  page: Page;
}

/**
 * Three-dot menu in the page header. Wires together the existing mutations
 * and dialogs that the actions list expects (duplicate, move, favorite,
 * trash). Renders different items when the page is already archived.
 */
export function PageActionsMenu({ page }: PageActionsMenuProps) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { user } = useOxy();
  const duplicatePage = useDuplicatePage();
  const updatePage = useUpdatePage();
  const deletePage = useDeletePage();

  const [moveOpen, setMoveOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  const isOwner = user?.id === page.ownerId;

  const handleDuplicate = React.useCallback(() => {
    duplicatePage.mutate(
      { id: page._id, workspaceId: page.workspaceId },
      {
        onSuccess: (created) => {
          toast.success("Page duplicated");
          router.push(`/p/${created._id}`);
        },
        onError: (err) => {
          toast.error(err.message || "Failed to duplicate page");
        },
      },
    );
  }, [duplicatePage, page._id, page.workspaceId, router]);

  const handleFavorite = React.useCallback(() => {
    updatePage.mutate({ id: page._id, favorited: !page.favorited });
  }, [updatePage, page._id, page.favorited]);

  const handleCopyLink = React.useCallback(async () => {
    const origin =
      Platform.OS === "web" && typeof window !== "undefined"
        ? window.location.origin
        : "https://space.oxy.so";
    const url = `${origin}/p/${page._id}`;
    await Clipboard.setStringAsync(url);
    toast.success("Link copied");
  }, [page._id]);

  const handleExportMarkdown = React.useCallback(async () => {
    try {
      const res = await apiClient.get<string>(
        API_ROUTES.pages.export(page._id),
        {
          params: { format: "md" },
          responseType: "text",
          transformResponse: [(d: string) => d],
        },
      );
      const markdown = typeof res.data === "string" ? res.data : "";
      if (Platform.OS === "web" && typeof window !== "undefined") {
        const blob = new Blob([markdown], {
          type: "text/markdown;charset=utf-8",
        });
        const href = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = href;
        link.download = `${(page.title || "untitled").replace(/[^a-zA-Z0-9-_]+/gu, "-")}.md`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(href);
        toast.success("Markdown downloaded");
      } else {
        await Clipboard.setStringAsync(markdown);
        toast.success("Markdown copied to clipboard");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Export failed";
      toast.error(msg);
    }
  }, [page._id, page.title]);

  const handleMoveToTrash = React.useCallback(() => {
    deletePage.mutate(
      { id: page._id, workspaceId: page.workspaceId },
      {
        onSuccess: () => {
          toast.success("Moved to trash");
          router.replace("/(app)");
        },
        onError: (err) => {
          toast.error(err.message || "Failed to move to trash");
        },
      },
    );
  }, [deletePage, page._id, page.workspaceId, router]);

  const handleRestore = React.useCallback(() => {
    updatePage.mutate(
      { id: page._id, archived: false },
      {
        onSuccess: () => {
          toast.success("Page restored");
        },
      },
    );
  }, [updatePage, page._id]);

  const handleHardDelete = React.useCallback(() => {
    deletePage.mutate(
      { id: page._id, workspaceId: page.workspaceId, hard: true },
      {
        onSuccess: () => {
          toast.success("Page deleted permanently");
          router.replace("/trash");
        },
        onError: (err) => {
          toast.error(err.message || "Failed to delete page");
        },
      },
    );
  }, [deletePage, page._id, page.workspaceId, router]);

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          <Pressable
            accessibilityLabel="Page actions"
            accessibilityRole="button"
            className="h-9 w-9 items-center justify-center rounded-lg hover:bg-muted"
          >
            <MoreHorizontal size={16} color={colors.foreground} />
          </Pressable>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content>
          {!page.archived ? (
            <>
              <DropdownMenu.Item key="duplicate" onSelect={handleDuplicate}>
                <DropdownMenu.ItemIcon ios={{ name: "doc.on.doc" }} />
                <DropdownMenu.ItemTitle>Duplicate</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Item key="favorite" onSelect={handleFavorite}>
                <DropdownMenu.ItemIcon
                  ios={{ name: page.favorited ? "star.slash" : "star" }}
                />
                <DropdownMenu.ItemTitle>
                  {page.favorited ? "Remove from favorites" : "Add to favorites"}
                </DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                key="move"
                onSelect={() => setMoveOpen(true)}
              >
                <DropdownMenu.ItemIcon ios={{ name: "folder" }} />
                <DropdownMenu.ItemTitle>Move to…</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Item key="copy-link" onSelect={handleCopyLink}>
                <DropdownMenu.ItemIcon ios={{ name: "link" }} />
                <DropdownMenu.ItemTitle>Copy link</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                key="export-md"
                onSelect={handleExportMarkdown}
              >
                <DropdownMenu.ItemIcon ios={{ name: "arrow.down.doc" }} />
                <DropdownMenu.ItemTitle>Export as Markdown</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                key="trash"
                destructive
                onSelect={handleMoveToTrash}
              >
                <DropdownMenu.ItemIcon ios={{ name: "trash" }} />
                <DropdownMenu.ItemTitle>Move to trash</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
            </>
          ) : (
            <>
              <DropdownMenu.Item key="restore" onSelect={handleRestore}>
                <DropdownMenu.ItemIcon ios={{ name: "arrow.uturn.backward" }} />
                <DropdownMenu.ItemTitle>Restore from trash</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
              {isOwner ? (
                <>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item
                    key="hard-delete"
                    destructive
                    onSelect={() => setDeleteOpen(true)}
                  >
                    <DropdownMenu.ItemIcon ios={{ name: "trash.slash" }} />
                    <DropdownMenu.ItemTitle>Delete permanently</DropdownMenu.ItemTitle>
                  </DropdownMenu.Item>
                </>
              ) : null}
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Root>

      <MoveToDialog open={moveOpen} onOpenChange={setMoveOpen} page={page} />

      <ConfirmationDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete permanently?"
        description={`“${page.title || "Untitled"}” and all its blocks will be removed forever. This can't be undone.`}
        confirmText="Delete"
        confirmVariant="destructive"
        onConfirm={handleHardDelete}
      />
    </>
  );
}
