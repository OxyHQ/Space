import * as React from "react";
import { View } from "react-native";
import { cn } from "@/lib/utils";
import { OxySpaceWordmark } from "@/components/ui/oxy-space-wordmark";

export interface AuthLogoProps {
  className?: string;
}

export function AuthLogo({ className }: AuthLogoProps) {
  return (
    <View className={cn("items-center mb-6", className)}>
      <OxySpaceWordmark width={160} />
    </View>
  );
}
