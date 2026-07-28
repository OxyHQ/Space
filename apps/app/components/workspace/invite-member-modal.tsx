import React from "react";
import { View, Pressable, Platform } from "react-native";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react-native";
import axios from "axios";
import { toast } from "@oxyhq/bloom/toast";
import { useColorScheme } from "@/lib/useColorScheme";
import { useInviteMember } from "@/lib/hooks/use-workspace-members";
import { ROLE_LABELS, ROLE_DESCRIPTIONS } from "@/lib/hooks/workspace-roles";
import type { WorkspaceRole } from "@/lib/hooks/use-workspaces";

const ASSIGNABLE_ROLES: WorkspaceRole[] = [
  "viewer",
  "commenter",
  "editor",
  "admin",
];

// RFC-5322 compliant-ish minimum: localpart@domain.tld with no whitespace.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface InviteMemberModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as
      | { message?: string; error?: string }
      | undefined;
    if (data?.message) return data.message;
    if (data?.error) return data.error;
    if (err.response?.status === 404) {
      return "User not found. Ask them to sign up at oxy.so first.";
    }
    if (err.response?.status === 409) {
      return "That user is already a member of this workspace.";
    }
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export function InviteMemberModal({
  open,
  onOpenChange,
  workspaceId,
}: InviteMemberModalProps) {
  const { colors } = useColorScheme();
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<WorkspaceRole>("editor");
  const { mutate, isPending } = useInviteMember(workspaceId);

  React.useEffect(() => {
    if (!open) {
      setEmail("");
      setRole("editor");
    }
  }, [open]);

  const trimmedEmail = email.trim();
  const emailValid = EMAIL_REGEX.test(trimmedEmail);
  const canSubmit = emailValid && !isPending;

  const handleSubmit = React.useCallback(() => {
    if (!canSubmit) return;
    mutate(
      { email: trimmedEmail, role },
      {
        onSuccess: () => {
          toast.success(`Invited ${trimmedEmail} as ${ROLE_LABELS[role]}`);
          onOpenChange(false);
        },
        onError: (err) => {
          toast.error(extractErrorMessage(err, "Failed to invite member"));
        },
      },
    );
  }, [canSubmit, mutate, trimmedEmail, role, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a member</DialogTitle>
          <DialogDescription>
            Invite an existing Oxy user to this workspace. They must
            already have an account at oxy.so.
          </DialogDescription>
        </DialogHeader>

        <View className="gap-3">
          <View className="gap-1.5">
            <Text className="text-sm font-medium text-foreground">Email</Text>
            <Input
              value={email}
              onChangeText={setEmail}
              placeholder="teammate@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              onSubmitEditing={handleSubmit}
              returnKeyType="send"
            />
            {email.length > 0 && !emailValid ? (
              <Text className="text-xs text-destructive">
                Enter a valid email address.
              </Text>
            ) : null}
          </View>

          <View className="gap-1.5">
            <Text className="text-sm font-medium text-foreground">Role</Text>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                <Pressable
                  className="h-9 flex-row items-center justify-between rounded-xl border border-input bg-background px-3"
                  accessibilityRole="button"
                  accessibilityLabel={`Selected role ${ROLE_LABELS[role]}`}
                  disabled={isPending}
                >
                  <View className="flex-1 min-w-0">
                    <Text
                      className="text-sm text-foreground"
                      numberOfLines={1}
                    >
                      {ROLE_LABELS[role]}
                    </Text>
                  </View>
                  <ChevronDown size={14} color={colors.mutedForeground} />
                </Pressable>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content>
                {ASSIGNABLE_ROLES.map((option) => (
                  <DropdownMenu.Item
                    key={option}
                    onSelect={() => setRole(option)}
                  >
                    {Platform.OS === "web" ? (
                      <View className="gap-0.5">
                        <Text className="text-sm font-medium text-foreground">
                          {ROLE_LABELS[option]}
                        </Text>
                        <Text className="text-xs text-muted-foreground">
                          {ROLE_DESCRIPTIONS[option]}
                        </Text>
                      </View>
                    ) : (
                      <>
                        <DropdownMenu.ItemTitle>
                          {ROLE_LABELS[option]}
                        </DropdownMenu.ItemTitle>
                        <DropdownMenu.ItemSubtitle>
                          {ROLE_DESCRIPTIONS[option]}
                        </DropdownMenu.ItemSubtitle>
                      </>
                    )}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Root>
            <Text className="text-xs text-muted-foreground">
              {ROLE_DESCRIPTIONS[role]}
            </Text>
          </View>
        </View>

        <DialogFooter>
          <Button
            variant="outline"
            onPress={() => onOpenChange(false)}
            disabled={isPending}
          >
            <Text>Cancel</Text>
          </Button>
          <Button
            onPress={handleSubmit}
            disabled={!canSubmit}
            isLoading={isPending}
          >
            <Text>Send invite</Text>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
