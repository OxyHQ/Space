import * as React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { SidebarSection } from './sidebar-section';

/**
 * Templates — placeholder until Phase 5 ships the template gallery. Section
 * defaults to collapsed so it doesn't take up space in normal use.
 */
export function TemplatesSection() {
  return (
    <SidebarSection sectionKey="templates" title="Templates">
      <View className="px-4 py-1.5">
        <Text className="text-xs text-muted-foreground">
          Save a page as a template to reuse it later.
        </Text>
      </View>
    </SidebarSection>
  );
}
