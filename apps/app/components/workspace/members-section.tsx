import React from "react";
import { View, Pressable, Platform, ActivityIndicator } from "react-native";
import { useOxy } from "@oxyhq/services";
import { Image } from "expo-image";
import { UserPlus, Trash2, MoreHorizontal } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { toast } from "@/components/sonner";
import { useColorScheme } from "@/lib/useColorScheme";
import { useWorkspaces } from "@/lib/hooks/use-workspaces";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";
import {
  useWorkspaceMembers,
  useRemoveMember,
  useUpdateMemberRole,
  type WorkspaceMember,
} from "@/lib/hooks/use-workspace-members";
import type { WorkspaceRole } from "@/lib/hooks/use-workspaces";
import {
  ROLE_LABELS,
  WORKSPACE_ROLES,
  hasRole,
} from "@/lib/hooks/workspace-roles";
import { InviteMemberModal } from "./invite-member-modal";

const ASSIGNABLE_ROLES: WorkspaceRole[] = [
  "viewer",
  "commenter",
  "editor",
  "admin",
];

function memberDisplayName(member: WorkspaceMember): string {
  const profile = member.user;
  if (!profile) return member.userId;
  if (profile.name?.first) {
    return profile.name.last
      ? `${profile.name.first} ${profile.name.last}`
      : profile.name.first;
  }
  return profile.username ?? profile.email ?? member.userId;
}

function memberInitial(member: WorkspaceMember): string {
  const profile = member.user;
  const source =
    profile?.name?.first?.[0] ??
    profile?.username?.[0] ??
    profile?.email?.[0] ??
    "?";
  return source.toUpperCase();
}

function MemberAvatar({ member }: { member: WorkspaceMember }) {
  const { oxyServices } = useOxy();
  const avatarUrl = member.user?.avatar
    ? oxyServices.getFileDownloadUrl(member.user.avatar, "thumb")
    : null;

  return (
    <View
      className="rounded-full bg-muted items-center justify-center overflow-hidden"
      style={{ width: 36, height: 36 }}
    >
      {avatarUrl ? (
        <Image
          source={{ uri: avatarUrl }}
          style={{ width: 36, height: 36 }}
          contentFit="cover"
          transition={150}
        />
      ) : (
        <Text className="text-sm font-bold text-foreground">
          {memberInitial(member)}
        </Text>
      )}
    </View>
  );
}

interface MemberRowProps {
  member: WorkspaceMember;
  workspaceId: string;
  /** Role of the viewer for this workspace. Drives action permissions. */
  callerRole: WorkspaceRole | undefined;
  /** Oxy user id of the viewer. Disables self-removal. */
  callerUserId: string | undefined;
}

function MemberRow({
  member,
  workspaceId,
  callerRole,
  callerUserId,
}: MemberRowProps) {
  const { colors } = useColorScheme();
  const { mutate: updateRole, isPending: isUpdating } =
    useUpdateMemberRole(workspaceId);
  const { mutate: removeMember, isPending: isRemoving } =
    useRemoveMember(workspaceId);

  const isOwner = member.role === "owner";
  const isSelf = callerUserId === member.userId;
  // Only admin+ can manage members. Owners can't be demoted via this UI.
  const canManage = hasRole(callerRole, "admin") && !isOwner && !isSelf;

  const handleChangeRole = React.useCallback(
    (role: WorkspaceRole) => {
      if (role === member.role) return;
      updateRole(
        { memberId: member._id, role },
        {
          onSuccess: () => {
            toast.success(
              `Role updated to ${ROLE_LABELS[role]} for ${memberDisplayName(member)}`,
            );
          },
          onError: (error) => {
            const message =
              error instanceof Error && error.message
                ? error.message
                : "Failed to update role";
            toast.error(message);
          },
        },
      );
    },
    [updateRole, member],
  );

  const handleRemove = React.useCallback(() => {
    removeMember(member._id, {
      onSuccess: () => {
        toast.success(`Removed ${memberDisplayName(member)}`);
      },
      onError: (error) => {
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Failed to remove member";
        toast.error(message);
      },
    });
  }, [removeMember, member]);

  return (
    <View className="flex-row items-center gap-3 py-3 px-2 rounded-lg">
      <MemberAvatar member={member} />
      <View className="flex-1 min-w-0">
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {memberDisplayName(member)}
          {isSelf ? (
            <Text className="text-xs text-muted-foreground"> (you)</Text>
          ) : null}
        </Text>
        {member.user?.email ? (
          <Text
            className="text-xs text-muted-foreground"
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {member.user.email}
          </Text>
        ) : null}
      </View>

      {canManage ? (
        <View className="flex-row items-center gap-1 shrink-0">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <Pressable
                className="h-8 px-2 flex-row items-center gap-1 rounded-lg border border-border hover:bg-muted"
                accessibilityRole="button"
                accessibilityLabel={`Change role for ${memberDisplayName(member)}`}
                disabled={isUpdating || isRemoving}
              >
                <Text className="text-xs font-medium text-foreground">
                  {ROLE_LABELS[member.role]}
                </Text>
              </Pressable>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content>
              {ASSIGNABLE_ROLES.map((role) => (
                <DropdownMenu.Item
                  key={role}
                  onSelect={() => handleChangeRole(role)}
                >
                  <DropdownMenu.ItemTitle>
                    {ROLE_LABELS[role]}
                  </DropdownMenu.ItemTitle>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Root>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <Pressable
                className="h-8 w-8 items-center justify-center rounded-lg hover:bg-muted"
                accessibilityRole="button"
                accessibilityLabel={`More actions for ${memberDisplayName(member)}`}
                disabled={isUpdating || isRemoving}
              >
                <MoreHorizontal size={16} color={colors.mutedForeground} />
              </Pressable>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content>
              <DropdownMenu.Item
                key="remove"
                destructive
                onSelect={handleRemove}
              >
                <DropdownMenu.ItemIcon ios={{ name: "trash" }} />
                <DropdownMenu.ItemTitle>Remove from workspace</DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </View>
      ) : (
        <View className="h-8 px-2 items-center justify-center shrink-0">
          <Text className="text-xs font-medium text-muted-foreground">
            {ROLE_LABELS[member.role]}
          </Text>
        </View>
      )}
    </View>
  );
}

export function MembersSection() {
  const { user } = useOxy();
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);

  const { data: workspaces } = useWorkspaces();
  const currentWorkspace = React.useMemo(
    () => workspaces?.find((w) => w._id === currentWorkspaceId) ?? null,
    [workspaces, currentWorkspaceId],
  );

  const {
    data: members,
    isLoading,
    isError,
    error,
  } = useWorkspaceMembers(currentWorkspaceId);

  const callerRole = currentWorkspace?.role;
  const canInvite = hasRole(callerRole, "admin");

  // Sort: owners first, then by role rank (desc), then by joinedAt asc.
  const sortedMembers = React.useMemo(() => {
    if (!members) return [];
    return [...members].sort((a, b) => {
      const roleDelta =
        WORKSPACE_ROLES.indexOf(b.role) - WORKSPACE_ROLES.indexOf(a.role);
      if (roleDelta !== 0) return roleDelta;
      return (
        new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime()
      );
    });
  }, [members]);

  return (
    <View className="gap-3">
      <View className="flex-row items-center justify-between">
        <View className="flex-1 min-w-0">
          <Text className="text-sm font-medium text-foreground">
            {currentWorkspace?.name ?? "Workspace"}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {members?.length ?? 0} member
            {(members?.length ?? 0) === 1 ? "" : "s"}
          </Text>
        </View>
        {canInvite && currentWorkspaceId ? (
          <Button onPress={() => setInviteOpen(true)} size="sm">
            <View className="flex-row items-center gap-1.5">
              <UserPlus
                size={14}
                className="text-primary-foreground"
              />
              <Text className="text-xs font-semibold text-primary-foreground">
                Invite member
              </Text>
            </View>
          </Button>
        ) : null}
      </View>

      <View className="rounded-xl border border-border bg-card overflow-hidden">
        {isLoading ? (
          <View className="py-10 items-center justify-center">
            <ActivityIndicator />
          </View>
        ) : isError ? (
          <View className="py-6 px-4">
            <Text className="text-sm text-destructive">
              {error instanceof Error
                ? error.message
                : "Failed to load members"}
            </Text>
          </View>
        ) : sortedMembers.length === 0 ? (
          <View className="py-10 items-center justify-center px-4">
            <Text className="text-sm text-muted-foreground text-center">
              No members yet.
            </Text>
          </View>
        ) : (
          <View className="px-1 py-1">
            {sortedMembers.map((member, idx) => (
              <View key={member._id}>
                {idx > 0 ? (
                  <View className="h-px bg-border/50 mx-2" />
                ) : null}
                <MemberRow
                  member={member}
                  workspaceId={currentWorkspaceId ?? ""}
                  callerRole={callerRole}
                  callerUserId={user?.id}
                />
              </View>
            ))}
          </View>
        )}
      </View>

      {currentWorkspaceId ? (
        <InviteMemberModal
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          workspaceId={currentWorkspaceId}
        />
      ) : null}

      {!canInvite && currentWorkspace ? (
        <View
          className={
            Platform.OS === "web"
              ? "rounded-lg bg-muted/40 px-3 py-2"
              : "rounded-lg bg-muted px-3 py-2"
          }
        >
          <Text className="text-xs text-muted-foreground">
            Only admins and owners can invite members or change roles.
          </Text>
        </View>
      ) : null}
    </View>
  );
}
