import React from "react";
import { View, Pressable, Platform } from "react-native";
import { ChevronDown, Plus, Check } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { useColorScheme } from "@/lib/useColorScheme";
import {
  useWorkspaces,
  type Workspace,
  type WorkspaceRole,
} from "@/lib/hooks/use-workspaces";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";
import { CreateWorkspaceModal } from "./create-workspace-modal";

interface WorkspaceSwitcherProps {
  /**
   * When true, render a compact icon-only trigger sized for the
   * collapsed sidebar (`width: 48`). Defaults to the full trigger.
   */
  collapsed?: boolean;
}

const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  editor: "Editor",
  commenter: "Commenter",
  viewer: "Viewer",
};

function getWorkspaceInitial(workspace: Pick<Workspace, "name">): string {
  return (workspace.name?.[0] ?? "W").toUpperCase();
}

function WorkspaceIcon({
  workspace,
  size = 24,
}: {
  workspace: Pick<Workspace, "name" | "icon">;
  size?: number;
}) {
  return (
    <View
      className="rounded-md bg-primary/10 items-center justify-center shrink-0 overflow-hidden"
      style={{ width: size, height: size }}
    >
      {workspace.icon ? (
        <Text
          className="text-foreground"
          style={{ fontSize: size * 0.65, lineHeight: size }}
        >
          {workspace.icon}
        </Text>
      ) : (
        <Text
          className="font-semibold text-primary"
          style={{ fontSize: size * 0.5 }}
        >
          {getWorkspaceInitial(workspace)}
        </Text>
      )}
    </View>
  );
}

export const WorkspaceSwitcher = React.memo(function WorkspaceSwitcher({
  collapsed = false,
}: WorkspaceSwitcherProps) {
  const { colors } = useColorScheme();
  const [createOpen, setCreateOpen] = React.useState(false);

  const { data: workspaces, isLoading } = useWorkspaces();
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const setCurrentWorkspaceId = useWorkspaceStore(
    (s) => s.setCurrentWorkspaceId,
  );

  // Resolve the active workspace: prefer the persisted id; otherwise
  // default to the personal workspace, then the first available.
  const activeWorkspace = React.useMemo<Workspace | null>(() => {
    if (!workspaces || workspaces.length === 0) return null;
    const byId = workspaces.find((w) => w._id === currentWorkspaceId);
    if (byId) return byId;
    const personal = workspaces.find((w) => w.isPersonal);
    return personal ?? workspaces[0] ?? null;
  }, [workspaces, currentWorkspaceId]);

  // Sync persisted selection to a real workspace once the list loads.
  // If the persisted id doesn't appear in the response (deleted /
  // unauthorized / first load) we fall back to the personal workspace
  // so downstream consumers (page tree, page detail) always have a
  // valid `currentWorkspaceId`.
  React.useEffect(() => {
    if (!activeWorkspace) return;
    if (currentWorkspaceId === activeWorkspace._id) return;
    setCurrentWorkspaceId(activeWorkspace._id);
  }, [activeWorkspace, currentWorkspaceId, setCurrentWorkspaceId]);

  const handleSelect = React.useCallback(
    (id: string) => {
      setCurrentWorkspaceId(id);
    },
    [setCurrentWorkspaceId],
  );

  const handleCreate = React.useCallback(() => {
    setCreateOpen(true);
  }, []);

  const handleCreated = React.useCallback(
    (workspace: Workspace) => {
      setCurrentWorkspaceId(workspace._id);
      setCreateOpen(false);
    },
    [setCurrentWorkspaceId],
  );

  // Empty state: no workspaces (shouldn't happen, backend auto-creates).
  if (!isLoading && (!workspaces || workspaces.length === 0)) {
    return (
      <View className={collapsed ? "" : "flex-1"}>
        <Pressable
          onPress={handleCreate}
          className="h-9 flex-row items-center gap-2 px-2 rounded-lg hover:bg-muted"
          accessibilityLabel="Create your first workspace"
          accessibilityRole="button"
        >
          <Plus size={16} color={colors.mutedForeground} />
          {!collapsed && (
            <Text className="text-sm text-muted-foreground">
              Create workspace
            </Text>
          )}
        </Pressable>
        <CreateWorkspaceModal
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={handleCreated}
        />
      </View>
    );
  }

  const triggerLabel = activeWorkspace?.name ?? "Workspace";

  return (
    <View className={collapsed ? "" : "flex-1 min-w-0"}>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          <Pressable
            className={
              collapsed
                ? "h-10 w-10 items-center justify-center rounded-xl hover:bg-muted"
                : "h-9 flex-row items-center gap-2 px-1.5 rounded-lg hover:bg-muted"
            }
            accessibilityLabel={`Switch workspace, current ${triggerLabel}`}
            accessibilityRole="button"
          >
            {activeWorkspace ? (
              <WorkspaceIcon
                workspace={activeWorkspace}
                size={collapsed ? 28 : 24}
              />
            ) : (
              <View
                className="rounded-md bg-muted"
                style={{
                  width: collapsed ? 28 : 24,
                  height: collapsed ? 28 : 24,
                }}
              />
            )}
            {!collapsed && (
              <>
                <Text
                  className="text-sm font-semibold text-foreground flex-1"
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {triggerLabel}
                </Text>
                <ChevronDown
                  size={14}
                  color={colors.mutedForeground}
                  style={{ flexShrink: 0 }}
                />
              </>
            )}
          </Pressable>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content>
          {Platform.OS === "web" ? (
            <View className="px-2 pt-2 pb-1">
              <Text className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                Your workspaces
              </Text>
            </View>
          ) : (
            <DropdownMenu.Label>Your workspaces</DropdownMenu.Label>
          )}
          {(workspaces ?? []).map((workspace) => {
            const isActive = workspace._id === activeWorkspace?._id;
            const role = workspace.role;
            return (
              <DropdownMenu.Item
                key={workspace._id}
                onSelect={() => handleSelect(workspace._id)}
              >
                {Platform.OS === "web" ? (
                  <View className="flex-row items-center gap-2 w-full">
                    <WorkspaceIcon workspace={workspace} size={24} />
                    <View className="flex-1 min-w-0">
                      <Text
                        className="text-sm font-medium text-foreground"
                        numberOfLines={1}
                      >
                        {workspace.name}
                      </Text>
                      {role ? (
                        <Text className="text-[11px] text-muted-foreground">
                          {ROLE_LABELS[role]}
                        </Text>
                      ) : null}
                    </View>
                    {isActive ? (
                      <Check
                        size={16}
                        color={colors.foreground}
                        style={{ flexShrink: 0 }}
                      />
                    ) : null}
                  </View>
                ) : (
                  <>
                    <DropdownMenu.ItemTitle>
                      {workspace.name}
                    </DropdownMenu.ItemTitle>
                    {role ? (
                      <DropdownMenu.ItemSubtitle>
                        {ROLE_LABELS[role]}
                      </DropdownMenu.ItemSubtitle>
                    ) : null}
                  </>
                )}
              </DropdownMenu.Item>
            );
          })}
          <DropdownMenu.Separator />
          <DropdownMenu.Item key="create" onSelect={handleCreate}>
            {Platform.OS === "web" ? (
              <View className="flex-row items-center gap-2">
                <Plus size={14} color={colors.foreground} />
                <Text className="text-sm font-medium text-foreground">
                  New workspace
                </Text>
              </View>
            ) : (
              <>
                <DropdownMenu.ItemIcon ios={{ name: "plus" }} />
                <DropdownMenu.ItemTitle>New workspace</DropdownMenu.ItemTitle>
              </>
            )}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      <CreateWorkspaceModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
      />
    </View>
  );
});
