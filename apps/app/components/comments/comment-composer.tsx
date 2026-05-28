import * as React from "react";
import {
  ActivityIndicator,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  TextInput,
  TextInputKeyPressEventData,
  TextInputSelectionChangeEventData,
  View,
} from "react-native";
import { Send } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import { MentionPicker } from "./mention-picker";
import type {
  CommentSegment,
  MentionSegment,
} from "@/lib/types/comments";

interface CommentComposerProps {
  workspaceId: string;
  placeholder?: string;
  submitting?: boolean;
  autoFocus?: boolean;
  /**
   * Called when user submits the composer. Receives the typed segments —
   * mention chips are interleaved with text in caret order.
   */
  onSubmit: (segments: CommentSegment[]) => void | Promise<void>;
  onCancel?: () => void;
  initialSegments?: CommentSegment[];
}

/**
 * Internal composer model:
 *   - text: the raw editable string the user types
 *   - mentions: list of mention chips, each anchored to a [start, end) range
 *     in `text`. Each anchored mention's `originalText` lives in those bytes
 *     so the displayed text + final segments are kept in sync.
 *
 * At submit time we walk `text` left→right, splitting at mention ranges to
 * produce the final segment list.
 */
interface Anchored {
  start: number;
  end: number;
  mention: MentionSegment;
}

function segmentsToText(segments: CommentSegment[]): {
  text: string;
  anchored: Anchored[];
} {
  let cursor = 0;
  let text = "";
  const anchored: Anchored[] = [];
  for (const seg of segments) {
    if ("type" in seg && seg.type === "mention") {
      const start = cursor;
      text += seg.originalText;
      cursor += seg.originalText.length;
      anchored.push({ start, end: cursor, mention: seg });
    } else {
      text += seg.text;
      cursor += seg.text.length;
    }
  }
  return { text, anchored };
}

function buildSegmentsFromAnchored(
  text: string,
  anchored: Anchored[],
): CommentSegment[] {
  // Anchored ranges must not overlap and are sorted by start.
  const sorted = [...anchored].sort((a, b) => a.start - b.start);
  const out: CommentSegment[] = [];
  let cursor = 0;
  for (const a of sorted) {
    if (a.start > cursor) {
      out.push({ type: "text", text: text.slice(cursor, a.start) });
    }
    out.push(a.mention);
    cursor = a.end;
  }
  if (cursor < text.length) {
    out.push({ type: "text", text: text.slice(cursor) });
  }
  // Strip empty text segments.
  return out.filter(
    (s) => ("type" in s && s.type === "mention") || s.text.length > 0,
  );
}

/**
 * After a text edit we need to re-anchor mention ranges so they still point
 * at their `originalText`. If an edit overlaps a mention range, the mention
 * is dropped (the user typed through it).
 */
function reanchor(
  prevText: string,
  prevAnchored: Anchored[],
  nextText: string,
): Anchored[] {
  // Common-prefix / common-suffix diff to localize the edit.
  let prefix = 0;
  const prevLen = prevText.length;
  const nextLen = nextText.length;
  const minLen = Math.min(prevLen, nextLen);
  while (prefix < minLen && prevText[prefix] === nextText[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    prevText[prevLen - 1 - suffix] === nextText[nextLen - 1 - suffix]
  ) {
    suffix++;
  }
  const editStart = prefix;
  const editEndPrev = prevLen - suffix;
  const delta = nextLen - prevLen;

  const result: Anchored[] = [];
  for (const a of prevAnchored) {
    // Mention entirely before the edit — unchanged.
    if (a.end <= editStart) {
      result.push(a);
      continue;
    }
    // Mention entirely after the edit — shift.
    if (a.start >= editEndPrev) {
      result.push({ ...a, start: a.start + delta, end: a.end + delta });
      continue;
    }
    // Otherwise the edit overlaps this mention — drop it.
  }
  return result;
}

const MENTION_TRIGGER = "@";

interface DraftMentionState {
  /** Index in `text` where the `@` lives. */
  triggerIndex: number;
  /** Query string between `@` and the caret. */
  query: string;
}

/**
 * Comment composer with inline mention autocomplete. Tracks `@` triggers,
 * surfaces the mention picker, and inserts a chip at the trigger location on
 * selection. Submit is Ctrl/Cmd+Enter (web) or the inline send button.
 */
export function CommentComposer({
  workspaceId,
  placeholder = "Add a comment…",
  submitting,
  autoFocus,
  onSubmit,
  onCancel,
  initialSegments,
}: CommentComposerProps) {
  const { colors } = useColorScheme();
  const inputRef = React.useRef<TextInput>(null);
  const initial = React.useMemo(
    () => (initialSegments ? segmentsToText(initialSegments) : { text: "", anchored: [] }),
    [initialSegments],
  );
  const [text, setText] = React.useState<string>(initial.text);
  const [anchored, setAnchored] = React.useState<Anchored[]>(initial.anchored);
  const selectionRef = React.useRef<{ start: number; end: number }>({
    start: initial.text.length,
    end: initial.text.length,
  });
  const [mentionDraft, setMentionDraft] = React.useState<DraftMentionState | null>(null);

  const isEmpty =
    text.trim().length === 0 && anchored.length === 0;

  const handleSelectionChange = (
    e: NativeSyntheticEvent<TextInputSelectionChangeEventData>,
  ) => {
    selectionRef.current = e.nativeEvent.selection;
    // Recompute mention draft state from caret position.
    if (mentionDraft) {
      const caret = e.nativeEvent.selection.start;
      const triggerStillThere = text[mentionDraft.triggerIndex] === MENTION_TRIGGER;
      if (!triggerStillThere || caret <= mentionDraft.triggerIndex) {
        setMentionDraft(null);
        return;
      }
      const next = text.slice(mentionDraft.triggerIndex + 1, caret);
      if (next.includes(" ") || next.includes("\n")) {
        setMentionDraft(null);
        return;
      }
      setMentionDraft({ triggerIndex: mentionDraft.triggerIndex, query: next });
    }
  };

  const handleChangeText = (nextText: string) => {
    const nextAnchored = reanchor(text, anchored, nextText);
    setText(nextText);
    setAnchored(nextAnchored);

    // Detect mention trigger relative to caret.
    const caret = selectionRef.current.start;
    if (mentionDraft) {
      const triggerStillThere = nextText[mentionDraft.triggerIndex] === MENTION_TRIGGER;
      if (!triggerStillThere || caret <= mentionDraft.triggerIndex) {
        setMentionDraft(null);
        return;
      }
      const q = nextText.slice(mentionDraft.triggerIndex + 1, caret);
      if (q.includes(" ") || q.includes("\n")) {
        setMentionDraft(null);
        return;
      }
      setMentionDraft({ triggerIndex: mentionDraft.triggerIndex, query: q });
      return;
    }
    // Start a new mention draft when the last typed char is `@` and the char
    // before it is start-of-input or whitespace.
    const idx = caret - 1;
    if (idx >= 0 && nextText[idx] === MENTION_TRIGGER) {
      const prev = idx > 0 ? nextText[idx - 1] : "";
      if (idx === 0 || prev === " " || prev === "\n") {
        setMentionDraft({ triggerIndex: idx, query: "" });
      }
    }
  };

  const handleKeyPress = (
    e: NativeSyntheticEvent<TextInputKeyPressEventData>,
  ) => {
    const key = e.nativeEvent.key;
    if (key === "Escape" && mentionDraft) {
      setMentionDraft(null);
    }
  };

  const handlePickMention = (mention: MentionSegment) => {
    if (!mentionDraft) return;
    const caret = selectionRef.current.start;
    const before = text.slice(0, mentionDraft.triggerIndex);
    const after = text.slice(caret);
    const insertedText = mention.originalText;
    const nextText = `${before}${insertedText} ${after}`;
    const insertStart = mentionDraft.triggerIndex;
    const insertEnd = insertStart + insertedText.length;

    // Re-anchor existing mentions around the inserted slice, then add the new one.
    const shifted: Anchored[] = anchored
      .filter((a) => a.end <= mentionDraft.triggerIndex || a.start >= caret)
      .map((a) => {
        if (a.start >= caret) {
          const delta = insertedText.length + 1 - (caret - mentionDraft.triggerIndex);
          return { ...a, start: a.start + delta, end: a.end + delta };
        }
        return a;
      });
    const next = [...shifted, { start: insertStart, end: insertEnd, mention }];
    setText(nextText);
    setAnchored(next);
    setMentionDraft(null);
    // Move caret to right after the chip + space.
    const newCaret = insertEnd + 1;
    selectionRef.current = { start: newCaret, end: newCaret };
    // Defer focus / setSelection until the next tick so the new value is applied.
    requestAnimationFrame(() => {
      inputRef.current?.setNativeProps({ selection: { start: newCaret, end: newCaret } });
      inputRef.current?.focus();
    });
  };

  const handleSubmit = async () => {
    if (isEmpty || submitting) return;
    const segments = buildSegmentsFromAnchored(text, anchored);
    if (segments.length === 0) return;
    await onSubmit(segments);
    setText("");
    setAnchored([]);
    setMentionDraft(null);
  };

  // Web: intercept Cmd/Ctrl+Enter to submit, Esc to cancel.
  React.useEffect(() => {
    if (Platform.OS !== "web") return;
    const node = inputRef.current as unknown as HTMLElement | null;
    if (!node || typeof node.addEventListener !== "function") return;
    const handler = (ev: Event) => {
      const e = ev as KeyboardEvent;
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSubmit();
      }
      if (e.key === "Escape") {
        if (mentionDraft) {
          e.preventDefault();
          setMentionDraft(null);
          return;
        }
        if (onCancel) {
          e.preventDefault();
          onCancel();
        }
      }
    };
    node.addEventListener("keydown", handler);
    return () => node.removeEventListener("keydown", handler);
    // We intentionally don't include handleSubmit in deps — it closes over
    // refs and state via the React tree; rebuilding the handler on every
    // keystroke is wasteful and not required for correctness.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionDraft, onCancel]);

  return (
    <View className="gap-2">
      <View className="rounded-xl border border-input bg-background px-3 py-2">
        <TextInput
          ref={inputRef}
          value={text}
          onChangeText={handleChangeText}
          onKeyPress={handleKeyPress}
          onSelectionChange={handleSelectionChange}
          placeholder={placeholder}
          placeholderTextColor={colors.mutedForeground}
          multiline
          autoFocus={autoFocus}
          className="text-sm text-foreground"
          style={
            Platform.OS === "web"
              ? { outlineWidth: 0, borderWidth: 0, minHeight: 36 }
              : { minHeight: 36 }
          }
        />
        {mentionDraft ? (
          <View className="relative">
            <MentionPicker
              open
              workspaceId={workspaceId}
              query={mentionDraft.query}
              onSelect={handlePickMention}
              onClose={() => setMentionDraft(null)}
            />
          </View>
        ) : null}
      </View>
      <View className="flex-row items-center justify-between">
        <Text className="text-[10px] text-muted-foreground">
          {Platform.OS === "web"
            ? "@ to mention · Cmd/Ctrl+Enter to send"
            : "@ to mention"}
        </Text>
        <View className="flex-row items-center gap-2">
          {onCancel ? (
            <Pressable
              onPress={onCancel}
              className="rounded-md px-3 py-1.5 hover:bg-muted"
              disabled={submitting}
              accessibilityLabel="Cancel"
            >
              <Text className="text-xs text-muted-foreground">Cancel</Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={handleSubmit}
            disabled={isEmpty || submitting}
            className={
              isEmpty || submitting
                ? "flex-row items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 opacity-60"
                : "flex-row items-center gap-1.5 rounded-md bg-primary px-3 py-1.5"
            }
            accessibilityLabel="Send comment"
          >
            {submitting ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <Send
                size={12}
                color={
                  isEmpty
                    ? colors.mutedForeground
                    : colors.primaryForeground
                }
              />
            )}
            <Text
              className={
                isEmpty || submitting
                  ? "text-xs font-medium text-muted-foreground"
                  : "text-xs font-medium text-primary-foreground"
              }
            >
              {submitting ? "Posting…" : "Comment"}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
