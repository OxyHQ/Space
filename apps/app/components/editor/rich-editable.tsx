import * as React from "react";
import {
  NativeSyntheticEvent,
  Platform,
  TextInput,
  TextInputContentSizeChangeEventData,
  TextInputKeyPressEventData,
  TextInputSelectionChangeEventData,
  View,
} from "react-native";
import { cn } from "@/lib/utils";
import { useColorScheme } from "@/lib/useColorScheme";
import type { BlockColor, Segment } from "@/lib/types/pages";
import { coalesceSegments, segmentsToPlainText } from "./segments";

/**
 * Selection in caret-offset coordinates over the flattened plain text.
 * `start` always ≤ `end`; collapsed selection has start === end.
 */
export interface CaretRange {
  start: number;
  end: number;
}

export interface RichEditableHandle {
  /** Move focus into the editor. */
  focus(): void;
  /** Read the current caret range; null if not focused. */
  getSelection(): CaretRange | null;
  /** Set the caret range (web only — native ignores). */
  setSelection(range: CaretRange): void;
}

interface RichEditableProps {
  /**
   * Segments source-of-truth. Component is fully controlled — when this
   * changes, the DOM/TextInput is updated. Equal-by-reference segments are
   * a no-op (parent debounces writes already).
   */
  segments: Segment[];
  /** Fallback plain text when segments is empty — used to mirror legacy data. */
  fallbackText?: string;
  /** Emit on every text mutation. Plain-text mirror provided for callers. */
  onChange: (next: { segments: Segment[]; text: string }) => void;
  /** Emit on selection changes (web). Native fires on selection change events. */
  onSelectionChange?: (range: CaretRange) => void;
  /** Block-level Enter handler — return true to consume the event. */
  onSubmit?: () => boolean | void;
  /** Backspace at offset 0 with collapsed caret. */
  onBackspaceAtStart?: () => void;
  /** Tab / Shift+Tab on web. */
  onIndent?: (outdent: boolean) => void;
  /**
   * Web keydown for the editor — bubble-up so the parent can wire markdown
   * shortcuts, slash-menu triggering, multi-block selection, etc. Returning
   * true means the parent consumed it (the editor will not run its default).
   */
  onKeyDown?: (event: KeyboardEvent, range: CaretRange) => boolean | void;
  /** Placeholder text shown when the editor is empty. */
  placeholder?: string;
  /** Visual classes applied to the editing surface. */
  className?: string;
  /** Whether to focus on mount. */
  autoFocus?: boolean;
  /** Forwarded as a native TextInput ref for legacy callers. */
  textInputRef?: React.RefObject<TextInput | null>;
  /** Forwarded as the rich-editor imperative handle. */
  handleRef?: React.MutableRefObject<RichEditableHandle | null>;
  /** Render-time decorator — wraps the editing surface. */
  containerClassName?: string;
}

/** Color name → Tailwind class. Default returns empty string. */
const TEXT_COLOR_CLASS: Record<BlockColor, string> = {
  default: "",
  gray: "text-gray-500 dark:text-gray-400",
  brown: "text-amber-800 dark:text-amber-300",
  orange: "text-orange-600 dark:text-orange-400",
  yellow: "text-yellow-600 dark:text-yellow-400",
  green: "text-emerald-600 dark:text-emerald-400",
  blue: "text-blue-600 dark:text-blue-400",
  purple: "text-purple-600 dark:text-purple-400",
  pink: "text-pink-600 dark:text-pink-400",
  red: "text-red-600 dark:text-red-400",
};

const BG_COLOR_CLASS: Record<BlockColor, string> = {
  default: "",
  gray: "bg-gray-200/50 dark:bg-gray-700/50",
  brown: "bg-amber-100 dark:bg-amber-900/40",
  orange: "bg-orange-100 dark:bg-orange-900/40",
  yellow: "bg-yellow-100 dark:bg-yellow-900/40",
  green: "bg-emerald-100 dark:bg-emerald-900/40",
  blue: "bg-blue-100 dark:bg-blue-900/40",
  purple: "bg-purple-100 dark:bg-purple-900/40",
  pink: "bg-pink-100 dark:bg-pink-900/40",
  red: "bg-red-100 dark:bg-red-900/40",
};

export function segmentTextColorClass(color: BlockColor | undefined): string {
  if (!color || color === "default") return "";
  return TEXT_COLOR_CLASS[color];
}

export function segmentBgColorClass(color: BlockColor | undefined): string {
  if (!color || color === "default") return "";
  return BG_COLOR_CLASS[color];
}

/**
 * Render a segment list into DOM <span>s. Pure helper — no React state.
 * Used both for read-only rendering and for re-syncing contentEditable
 * content after a controlled-prop change.
 */
function segmentsToHtml(segments: Segment[], placeholderEmpty: boolean): string {
  if (segments.length === 0 || segmentsToPlainText(segments).length === 0) {
    // Browsers collapse empty contenteditable when no <br> — give them one.
    return placeholderEmpty ? "<br>" : "";
  }
  return segments.map(segmentToHtml).join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function segmentToHtml(seg: Segment): string {
  const classes: string[] = [];
  if (seg.bold) classes.push("font-bold");
  if (seg.italic) classes.push("italic");
  if (seg.underline) classes.push("underline");
  if (seg.strike) classes.push("line-through");
  if (seg.code)
    classes.push(
      "font-mono",
      "text-[0.875em]",
      "bg-muted",
      "rounded",
      "px-1",
      "py-[1px]",
    );
  const textClass = segmentTextColorClass(seg.color);
  if (textClass) classes.push(textClass);
  const bgClass = segmentBgColorClass(seg.background);
  if (bgClass) classes.push(bgClass);

  const dataAttrs = [
    seg.bold ? 'data-mark-bold="1"' : "",
    seg.italic ? 'data-mark-italic="1"' : "",
    seg.underline ? 'data-mark-underline="1"' : "",
    seg.strike ? 'data-mark-strike="1"' : "",
    seg.code ? 'data-mark-code="1"' : "",
    seg.color ? `data-mark-color="${escapeHtml(seg.color)}"` : "",
    seg.background ? `data-mark-bg="${escapeHtml(seg.background)}"` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const safeText = escapeHtml(seg.text).replace(/\n/g, "<br>");
  if (seg.link) {
    return `<a href="${escapeHtml(seg.link)}" data-segment="1" ${dataAttrs} class="${classes.concat(["text-primary", "underline"]).join(" ")}" target="_blank" rel="noopener noreferrer">${safeText}</a>`;
  }
  if (classes.length === 0 && !dataAttrs) {
    return `<span data-segment="1">${safeText}</span>`;
  }
  return `<span data-segment="1" ${dataAttrs} class="${classes.join(" ")}">${safeText}</span>`;
}

/**
 * Walk the DOM under `root` and reconstruct `Segment[]` from its current
 * contents. Each <span data-segment> or <a data-segment> contributes a
 * segment with annotations encoded in `data-mark-*` attributes. Plain text
 * nodes (e.g. typed text outside any annotated span) inherit no annotations.
 */
function parseSegmentsFromDom(root: HTMLElement): Segment[] {
  const out: Segment[] = [];
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    null,
  );
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    let text = textNode.data;
    // Preserve <br> as newlines — but only when explicitly inserted (Enter).
    // The block editor splits blocks on Enter anyway, so newlines inside a
    // single block are rare.
    text = text.replace(/ /g, " ");
    if (text.length > 0) {
      const seg: Segment = { text };
      let el: HTMLElement | null = textNode.parentElement;
      while (el && el !== root) {
        readMarksFromEl(el, seg);
        el = el.parentElement;
      }
      out.push(seg);
    }
    node = walker.nextNode();
  }
  return coalesceSegments(out);
}

function readMarksFromEl(el: HTMLElement, seg: Segment): void {
  if (el.tagName === "A") {
    const href = el.getAttribute("href");
    if (href) seg.link = href;
  }
  if (el.dataset.markBold === "1") seg.bold = true;
  if (el.dataset.markItalic === "1") seg.italic = true;
  if (el.dataset.markUnderline === "1") seg.underline = true;
  if (el.dataset.markStrike === "1") seg.strike = true;
  if (el.dataset.markCode === "1") seg.code = true;
  const color = el.dataset.markColor;
  if (color) seg.color = color as BlockColor;
  const bg = el.dataset.markBg;
  if (bg) seg.background = bg as BlockColor;
  // Older marks may have lived as classes — read those defensively.
  const cl = el.classList;
  if (cl.contains("font-bold")) seg.bold = true;
  if (cl.contains("italic")) seg.italic = true;
  if (cl.contains("underline")) seg.underline = true;
  if (cl.contains("line-through")) seg.strike = true;
}

/**
 * Compute the caret offset across the flat plain text of `root`. Counts text
 * characters only (HTML structure is ignored).
 */
function caretOffsetIn(root: HTMLElement, node: Node, offset: number): number {
  let count = 0;
  let found = false;
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    null,
  );
  let cursor: Node | null = walker.nextNode();
  while (cursor) {
    if (cursor === node) {
      if (cursor.nodeType === Node.TEXT_NODE) {
        count += offset;
      }
      found = true;
      break;
    }
    if (cursor.nodeType === Node.TEXT_NODE) {
      count += (cursor as Text).data.length;
    } else if ((cursor as HTMLElement).tagName === "BR") {
      // <br> contributes nothing — block-edit splits on Enter anyway.
    }
    cursor = walker.nextNode();
  }
  if (!found && node === root) {
    // Selection anchored on the root itself (e.g. before any children).
    return offset === 0 ? 0 : count;
  }
  return count;
}

/**
 * Walk to a (node, offset) pair within `root` corresponding to a flat caret
 * offset. Used to restore selection after re-rendering.
 */
function nodeOffsetFromCaret(
  root: HTMLElement,
  caret: number,
): { node: Node; offset: number } {
  let remaining = caret;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let lastTextNode: Text | null = null;
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    lastTextNode = textNode;
    if (remaining <= textNode.data.length) {
      return { node: textNode, offset: remaining };
    }
    remaining -= textNode.data.length;
    node = walker.nextNode();
  }
  if (lastTextNode) {
    return { node: lastTextNode, offset: lastTextNode.data.length };
  }
  return { node: root, offset: 0 };
}

/**
 * Web: contentEditable-backed rich text editor.
 * Native: falls back to a plain TextInput (rich inline arrives in later phase).
 */
function RichEditableWeb(props: RichEditableProps, ref: React.Ref<unknown>) {
  const {
    segments,
    fallbackText,
    onChange,
    onSelectionChange,
    onSubmit,
    onBackspaceAtStart,
    onIndent,
    onKeyDown,
    placeholder,
    className,
    autoFocus,
    handleRef,
    containerClassName,
  } = props;

  const elRef = React.useRef<HTMLDivElement | null>(null);
  // Track last rendered text so we know when to overwrite DOM. Without this,
  // every controlled-prop update would blow away the caret position even when
  // the props originated from this very component's onChange.
  const lastRenderedRef = React.useRef<string>("");
  const lastRenderedSegments = React.useRef<Segment[] | null>(null);

  const initialSegments = segments.length > 0
    ? segments
    : fallbackText
      ? [{ text: fallbackText }]
      : [];

  // Imperative handle (focus + selection control).
  const getSelectionRange = React.useCallback((): CaretRange | null => {
    const el = elRef.current;
    if (!el) return null;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0);
    if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) {
      return null;
    }
    const start = caretOffsetIn(el, r.startContainer, r.startOffset);
    const end = caretOffsetIn(el, r.endContainer, r.endOffset);
    return start <= end ? { start, end } : { start: end, end: start };
  }, []);

  const setSelectionRange = React.useCallback((range: CaretRange) => {
    const el = elRef.current;
    if (!el) return;
    const sel = window.getSelection();
    if (!sel) return;
    const startPos = nodeOffsetFromCaret(el, range.start);
    const endPos = nodeOffsetFromCaret(el, range.end);
    const r = document.createRange();
    r.setStart(startPos.node, startPos.offset);
    r.setEnd(endPos.node, endPos.offset);
    sel.removeAllRanges();
    sel.addRange(r);
  }, []);

  // Surface the imperative handle to consumers.
  React.useImperativeHandle(
    ref,
    () => ({
      focus: () => elRef.current?.focus(),
      getSelection: getSelectionRange,
      setSelection: setSelectionRange,
    }),
    [getSelectionRange, setSelectionRange],
  );

  // Also write into handleRef for callers that prefer mutable refs.
  React.useImperativeHandle(
    handleRef,
    () => ({
      focus: () => elRef.current?.focus(),
      getSelection: getSelectionRange,
      setSelection: setSelectionRange,
    }),
    [getSelectionRange, setSelectionRange, handleRef],
  );

  // Initial DOM render — runs once because lastRenderedRef is empty.
  // After mount we only re-write the DOM if the incoming text differs from
  // what we last emitted.
  const renderToDom = React.useCallback(
    (segs: Segment[], opts: { preserveCaret: boolean }) => {
      const el = elRef.current;
      if (!el) return;
      const text = segmentsToPlainText(segs);
      const range = opts.preserveCaret ? getSelectionRange() : null;
      el.innerHTML = segmentsToHtml(segs, false);
      lastRenderedRef.current = text;
      lastRenderedSegments.current = segs;
      if (range) {
        const safe: CaretRange = {
          start: Math.min(range.start, text.length),
          end: Math.min(range.end, text.length),
        };
        setSelectionRange(safe);
      }
    },
    [getSelectionRange, setSelectionRange],
  );

  // First mount: paint initial segments. Auto-focus if requested.
  React.useEffect(() => {
    renderToDom(initialSegments, { preserveCaret: false });
    if (autoFocus) elRef.current?.focus();
    // Run once per element instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync prop changes back into the DOM only when the parent's text differs
  // from what we last emitted (i.e. the change came from outside this editor).
  React.useEffect(() => {
    const incomingText = segmentsToPlainText(segments);
    if (incomingText === lastRenderedRef.current) {
      // Even if the text matches, the segment annotations may have changed
      // (e.g. toolbar bolded text). Only re-paint when reference differs
      // and the annotations actually changed shape.
      const lastSegs = lastRenderedSegments.current;
      if (lastSegs !== segments) {
        // Determine if annotations actually differ by length + per-segment flags.
        const sameAnnotations =
          !!lastSegs &&
          lastSegs.length === segments.length &&
          lastSegs.every((s, i) => {
            const t = segments[i];
            return (
              !!t &&
              s.text === t.text &&
              s.bold === t.bold &&
              s.italic === t.italic &&
              s.underline === t.underline &&
              s.strike === t.strike &&
              s.code === t.code &&
              s.color === t.color &&
              s.background === t.background &&
              s.link === t.link
            );
          });
        if (!sameAnnotations) {
          renderToDom(segments, { preserveCaret: true });
        }
      }
      return;
    }
    renderToDom(segments, { preserveCaret: true });
  }, [segments, renderToDom]);

  // Input handler — re-parse DOM into segments and emit.
  React.useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const handler = () => {
      const newSegs = parseSegmentsFromDom(el);
      const text = segmentsToPlainText(newSegs);
      lastRenderedRef.current = text;
      lastRenderedSegments.current = newSegs;
      onChange({ segments: newSegs, text });
    };
    el.addEventListener("input", handler);
    return () => el.removeEventListener("input", handler);
  }, [onChange]);

  // Selection change observer — selectionchange fires globally so we filter.
  React.useEffect(() => {
    if (!onSelectionChange) return;
    const handler = () => {
      const el = elRef.current;
      if (!el || document.activeElement !== el) return;
      const range = getSelectionRange();
      if (range) onSelectionChange(range);
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, [getSelectionRange, onSelectionChange]);

  // Keydown — own Enter/Tab/Backspace defaults, then pass through to parent.
  React.useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const handler = (ev: KeyboardEvent) => {
      const range = getSelectionRange() ?? { start: 0, end: 0 };
      if (onKeyDown) {
        const consumed = onKeyDown(ev, range);
        if (consumed === true) return;
        if (ev.defaultPrevented) return;
      }
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        if (onSubmit) onSubmit();
        return;
      }
      if (ev.key === "Tab") {
        ev.preventDefault();
        onIndent?.(ev.shiftKey);
        return;
      }
      if (ev.key === "Backspace" && range.start === 0 && range.end === 0) {
        ev.preventDefault();
        onBackspaceAtStart?.();
        return;
      }
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [getSelectionRange, onBackspaceAtStart, onIndent, onKeyDown, onSubmit]);

  // Paste — sanitize to plain text segments to avoid foreign markup.
  React.useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const handler = (ev: ClipboardEvent) => {
      ev.preventDefault();
      const data = ev.clipboardData?.getData("text/plain") ?? "";
      // Insert as plain text at the caret. The browser doesn't reliably do
      // this for us in contenteditable=true once we override paste.
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      sel.deleteFromDocument();
      const range = sel.getRangeAt(0);
      const text = document.createTextNode(data);
      range.insertNode(text);
      range.setStartAfter(text);
      range.setEndAfter(text);
      sel.removeAllRanges();
      sel.addRange(range);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    el.addEventListener("paste", handler);
    return () => el.removeEventListener("paste", handler);
  }, []);

  const empty = segmentsToPlainText(segments).length === 0;

  return (
    <View className={cn("relative", containerClassName)}>
      {empty && placeholder ? (
        <View
          pointerEvents="none"
          className="absolute inset-0 px-0 py-0"
        >
          <View className={cn("opacity-50", className)}>
            {placeholder ? <PlaceholderText>{placeholder}</PlaceholderText> : null}
          </View>
        </View>
      ) : null}
      <div
        ref={elRef}
        contentEditable
        suppressContentEditableWarning
        spellCheck
        data-rich-editable
        className={cn("outline-none whitespace-pre-wrap break-words", className)}
        style={{
          minHeight: "1.5em",
          caretColor: "currentColor",
        }}
      />
    </View>
  );
}

function PlaceholderText({ children }: { children: string }) {
  // Avoid pulling in @/components/ui/text inside the placeholder absolute
  // overlay — it adds line-height that misaligns. Plain span is enough.
  return (
    <span className="text-muted-foreground" data-placeholder>
      {children}
    </span>
  );
}

/**
 * Native fallback — plain TextInput (no inline rich text). Phase 2 keeps the
 * contract identical to web but only emits a single plain segment so the
 * parent's update path is uniform.
 */
function RichEditableNative(props: RichEditableProps, ref: React.Ref<unknown>) {
  const {
    segments,
    fallbackText,
    onChange,
    onSelectionChange,
    onSubmit,
    onBackspaceAtStart,
    onIndent,
    placeholder,
    className,
    autoFocus,
    textInputRef,
    handleRef,
  } = props;
  const { colors } = useColorScheme();
  const text = React.useMemo(() => {
    const fromSegs = segmentsToPlainText(segments);
    if (fromSegs.length > 0) return fromSegs;
    return fallbackText ?? "";
  }, [segments, fallbackText]);

  const localRef = React.useRef<TextInput | null>(null);
  const selectionRef = React.useRef<CaretRange>({ start: 0, end: 0 });
  const [contentHeight, setContentHeight] = React.useState<number | undefined>(
    undefined,
  );

  React.useImperativeHandle(
    ref,
    () => ({
      focus: () => localRef.current?.focus(),
      getSelection: () => selectionRef.current,
      setSelection: (range: CaretRange) => {
        selectionRef.current = range;
      },
    }),
    [],
  );
  React.useImperativeHandle(
    handleRef,
    () => ({
      focus: () => localRef.current?.focus(),
      getSelection: () => selectionRef.current,
      setSelection: (range: CaretRange) => {
        selectionRef.current = range;
      },
    }),
    [handleRef],
  );

  const setRef = (i: TextInput | null) => {
    localRef.current = i;
    if (textInputRef) {
      (textInputRef as React.MutableRefObject<TextInput | null>).current = i;
    }
  };

  const handleChange = (next: string) => {
    const seg: Segment = { text: next };
    onChange({ segments: next.length > 0 ? [seg] : [], text: next });
  };

  const handleKey = (
    e: NativeSyntheticEvent<TextInputKeyPressEventData>,
  ) => {
    const key = e.nativeEvent.key;
    const { start, end } = selectionRef.current;
    if (key === "Backspace" && start === 0 && end === 0) {
      onBackspaceAtStart?.();
      return;
    }
    if (key === "Tab") onIndent?.(false);
  };

  const handleSelection = (
    e: NativeSyntheticEvent<TextInputSelectionChangeEventData>,
  ) => {
    selectionRef.current = e.nativeEvent.selection;
    onSelectionChange?.(e.nativeEvent.selection);
  };

  const handleContentSize = (
    e: NativeSyntheticEvent<TextInputContentSizeChangeEventData>,
  ) => {
    setContentHeight(e.nativeEvent.contentSize.height);
  };

  return (
    <TextInput
      ref={setRef}
      value={text}
      onChangeText={handleChange}
      onKeyPress={handleKey}
      onSelectionChange={handleSelection}
      onContentSizeChange={handleContentSize}
      onSubmitEditing={() => onSubmit?.()}
      blurOnSubmit={false}
      placeholder={placeholder}
      placeholderTextColor={colors.mutedForeground}
      autoFocus={autoFocus}
      multiline
      scrollEnabled={false}
      textAlignVertical="top"
      className={cn("p-0 text-base text-foreground", className)}
      style={contentHeight ? { minHeight: contentHeight } : undefined}
      underlineColorAndroid="transparent"
    />
  );
}

const Forwarded = Platform.OS === "web"
  ? React.forwardRef<unknown, RichEditableProps>(RichEditableWeb)
  : React.forwardRef<unknown, RichEditableProps>(RichEditableNative);

Forwarded.displayName = "RichEditable";

export const RichEditable = Forwarded;
