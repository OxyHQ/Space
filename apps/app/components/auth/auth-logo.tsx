import * as React from "react";
import { View } from "react-native";
import { cn } from "@/lib/utils";
import { OxyStationWordmark } from "@/components/ui/oxy-station-wordmark";

export interface AuthLogoProps {
  className?: string;
}

export function AuthLogo({ className }: AuthLogoProps) {
  return (
    <View className={cn("items-center mb-6", className)}>
      <OxyStationWordmark width={160} />
    </View>
  );
}
