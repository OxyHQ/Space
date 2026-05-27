import * as React from "react";
import {
  NativeSyntheticEvent,
  Platform,
  TextInput,
  TextInputContentSizeChangeEventData,
  TextInputKeyPressEventData,
  TextInputSelectionChangeEventData,
} from "react-native";
import { cn } from "@/lib/utils";
import { useColorScheme } from "@/lib/useColorScheme";

interface EditableTextProps {
  value: string;
  onChangeText: (text: string) => void;
  onSubmitEditing?: () => void;
  /** Emitted when caret hits backspace at offset 0 with no selection. */
  onBackspaceAtStart?: () => void;
  /** Web-only — emitted on Tab (false) / Shift+Tab (true). */
  onIndent?: (outdent: boolean) => void;
  /** Emitted with raw char + caret index for slash menu triggering. */
  onChangeMeta?: (meta: { value: string; selection: number }) => void;
  placeholder?: string;
  className?: string;
  multiline?: boolean;
  autoFocus?: boolean;
  numberOfLines?: number;
  /** Imperative ref for programmatic focus. */
  inputRef?: React.RefObject<TextInput | null>;
}

/**
 * Block-content TextInput that:
 *   - auto-grows to fit content (web via fieldSizing CSS, native via
 *     onContentSizeChange).
 *   - tracks caret position so the parent can detect slash menu triggers.
 *   - reports backspace-at-start so the parent can merge/delete the block.
 *   - reports Tab / Shift+Tab on web for indent/outdent.
 *
 * No `as any` — fieldSizing is set via a typed style assertion limited to web.
 */
export const EditableText = React.forwardRef<TextInput, EditableTextProps>(
  function EditableText(props, forwardedRef) {
    const {
      value,
      onChangeText,
      onSubmitEditing,
      onBackspaceAtStart,
      onIndent,
      onChangeMeta,
      placeholder,
      className,
      multiline = true,
      autoFocus,
      numberOfLines,
      inputRef,
    } = props;

    const { colors } = useColorScheme();
    const localRef = React.useRef<TextInput>(null);
    const setRef = (instance: TextInput | null) => {
      localRef.current = instance;
      if (inputRef) {
        (inputRef as React.MutableRefObject<TextInput | null>).current =
          instance;
      }
      if (typeof forwardedRef === "function") {
        forwardedRef(instance);
      } else if (forwardedRef) {
        (
          forwardedRef as React.MutableRefObject<TextInput | null>
        ).current = instance;
      }
    };

    const selectionRef = React.useRef<{ start: number; end: number }>({
      start: value.length,
      end: value.length,
    });

    const [contentHeight, setContentHeight] = React.useState<
      number | undefined
    >(undefined);

    const handleSelectionChange = (
      e: NativeSyntheticEvent<TextInputSelectionChangeEventData>,
    ) => {
      selectionRef.current = e.nativeEvent.selection;
    };

    const handleKeyPress = (
      e: NativeSyntheticEvent<TextInputKeyPressEventData>,
    ) => {
      const key = e.nativeEvent.key;
      const { start, end } = selectionRef.current;
      if (key === "Backspace" && start === 0 && end === 0) {
        onBackspaceAtStart?.();
        return;
      }
      if (key === "Tab" && Platform.OS === "web") {
        // We can't fully prevent default through RN's KeyPress event without
        // patching the underlying DOM event — see web overlay below.
        onIndent?.(false);
      }
    };

    const handleChange = (text: string) => {
      onChangeText(text);
      onChangeMeta?.({
        value: text,
        selection: selectionRef.current.start,
      });
    };

    const handleContentSizeChange = (
      e: NativeSyntheticEvent<TextInputContentSizeChangeEventData>,
    ) => {
      if (Platform.OS !== "web") {
        setContentHeight(e.nativeEvent.contentSize.height);
      }
    };

    // Web: capture Tab + Shift+Tab + Enter on the raw DOM input. RN-Web's
    // `onKeyPress` doesn't expose modifiers reliably.
    React.useEffect(() => {
      if (Platform.OS !== "web") return;
      const node = localRef.current as unknown as
        | (HTMLElement & { value?: string })
        | null;
      if (!node || typeof node.addEventListener !== "function") return;

      const handler = (ev: Event) => {
        const e = ev as KeyboardEvent;
        if (e.key === "Tab") {
          e.preventDefault();
          onIndent?.(e.shiftKey);
        } else if (e.key === "Enter" && !e.shiftKey && onSubmitEditing) {
          e.preventDefault();
          onSubmitEditing();
        }
      };

      node.addEventListener("keydown", handler);
      return () => node.removeEventListener("keydown", handler);
    }, [onIndent, onSubmitEditing]);

    return (
      <TextInput
        ref={setRef}
        value={value}
        onChangeText={handleChange}
        onKeyPress={handleKeyPress}
        onSelectionChange={handleSelectionChange}
        onContentSizeChange={handleContentSizeChange}
        onSubmitEditing={
          Platform.OS === "web" ? undefined : onSubmitEditing
        }
        blurOnSubmit={false}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        autoFocus={autoFocus}
        multiline={multiline}
        numberOfLines={numberOfLines}
        scrollEnabled={false}
        textAlignVertical="top"
        className={cn("p-0 text-base text-foreground", className)}
        style={
          Platform.OS === "web"
            ? webFieldSizingStyle
            : contentHeight
              ? { minHeight: contentHeight }
              : undefined
        }
        underlineColorAndroid="transparent"
      />
    );
  },
);

/**
 * `fieldSizing: 'content'` lets the textarea auto-grow on modern
 * Chromium/Firefox. The property is declared as part of RN's TextStyle via
 * `app.d.ts` module augmentation.
 */
const webFieldSizingStyle = {
  outlineWidth: 0,
  borderWidth: 0,
  padding: 0,
  fieldSizing: "content",
} as const;
