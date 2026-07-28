import React from "react";
import { View, Pressable } from "react-native";
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
import { useCreateWorkspace, type Workspace } from "@/lib/hooks/use-workspaces";
import { toast } from "@oxyhq/bloom/toast";

/**
 * Curated set of safe, cross-platform emoji glyphs for the icon picker.
 * Kept small intentionally — the field accepts any emoji typed manually,
 * the grid is just convenience.
 */
const EMOJI_OPTIONS = [
  "🚀",
  "📚",
  "💡",
  "🎯",
  "🌱",
  "🎨",
  "🧠",
  "💼",
  "📦",
  "🛠️",
  "🪐",
  "✨",
  "🔥",
  "🌊",
  "🌍",
  "📝",
];

interface CreateWorkspaceModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the freshly-created workspace on success. */
  onCreated?: (workspace: Workspace) => void;
}

export function CreateWorkspaceModal({
  open,
  onOpenChange,
  onCreated,
}: CreateWorkspaceModalProps) {
  const [name, setName] = React.useState("");
  const [icon, setIcon] = React.useState<string>(EMOJI_OPTIONS[0] ?? "");
  const { mutate, isPending } = useCreateWorkspace();

  // Reset form whenever the modal is dismissed.
  React.useEffect(() => {
    if (!open) {
      setName("");
      setIcon(EMOJI_OPTIONS[0] ?? "");
    }
  }, [open]);

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && !isPending;

  const handleSubmit = React.useCallback(() => {
    if (!canSubmit) return;
    mutate(
      { name: trimmed, icon: icon || null },
      {
        onSuccess: (workspace) => {
          toast.success(`Workspace "${workspace.name}" created`);
          onCreated?.(workspace);
        },
        onError: (error) => {
          const message =
            error instanceof Error && error.message
              ? error.message
              : "Failed to create workspace";
          toast.error(message);
        },
      },
    );
  }, [canSubmit, mutate, trimmed, icon, onCreated]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New workspace</DialogTitle>
          <DialogDescription>
            Workspaces are containers for pages, databases, and team
            members.
          </DialogDescription>
        </DialogHeader>

        <View className="gap-3">
          <View className="gap-1.5">
            <Text className="text-sm font-medium text-foreground">Name</Text>
            <Input
              value={name}
              onChangeText={setName}
              placeholder="e.g. Acme Co."
              autoCapitalize="words"
              autoFocus
              maxLength={80}
              onSubmitEditing={handleSubmit}
              returnKeyType="done"
            />
          </View>

          <View className="gap-1.5">
            <Text className="text-sm font-medium text-foreground">Icon</Text>
            <View className="flex-row flex-wrap gap-1.5">
              {EMOJI_OPTIONS.map((emoji) => {
                const selected = emoji === icon;
                return (
                  <Pressable
                    key={emoji}
                    onPress={() => setIcon(emoji)}
                    className={`h-9 w-9 items-center justify-center rounded-lg border ${
                      selected
                        ? "border-primary bg-primary/10"
                        : "border-border bg-background hover:bg-muted"
                    }`}
                    accessibilityRole="button"
                    accessibilityLabel={`Use ${emoji} as icon`}
                  >
                    <Text className="text-lg" style={{ lineHeight: 22 }}>
                      {emoji}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
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
            <Text>Create workspace</Text>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
