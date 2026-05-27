
declare module '*.svg' {
  import * as React from 'react';
  import { SvgProps } from 'react-native-svg';
  const content: React.FC<SvgProps>;
  export default content;
}

/**
 * Web-only CSS properties we use through RN style props. RN-Web forwards
 * unknown style keys directly to the DOM, so declaring them here keeps
 * editor auto-sizing typed without `as any`. The `export {}` below marks
 * this file as a module so the `declare module` blocks are treated as
 * augmentations rather than replacements.
 */
import 'react-native';
declare module 'react-native' {
  interface TextStyle {
    fieldSizing?: 'content' | 'fixed';
    outlineStyle?: 'none' | 'solid' | 'dotted' | 'dashed';
    caretColor?: string;
  }
  interface ViewStyle {
    cursor?: 'pointer' | 'default' | 'text' | 'not-allowed' | 'grab';
  }
}
export {};
