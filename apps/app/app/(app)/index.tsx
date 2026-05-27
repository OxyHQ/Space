import { View } from "react-native";
import { Text } from "@/components/ui/text";

export default function HomePage() {
  return (
    <View className="flex-1 items-center justify-center bg-background px-6">
      <View className="max-w-md items-center gap-3">
        <Text className="text-3xl font-semibold text-foreground text-center">
          Oxy Space
        </Text>
        <Text className="text-base text-muted-foreground text-center">
          Your workspace is empty. Pages and databases land in Phase 1.
        </Text>
      </View>
    </View>
  );
}
