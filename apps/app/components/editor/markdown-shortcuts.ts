/**
 * Markdown-style block shortcuts triggered while typing in a paragraph.
 *
 * Recognized patterns (prefix → block type):
 *   `# `           → heading_1
 *   `## `          → heading_2
 *   `### `         → heading_3
 *   `* ` or `- `   → bulleted_list_item
 *   `1. ` (any digit run) → numbered_list_item
 *   `[] ` or `[ ] `       → to_do
 *   `> `           → quote
 *   ```` ``` ````  → code (start fence)
 *   `---` on empty line → divider
 *
 * Each rule returns the residual text after stripping the trigger, plus the
 * new block type. The editor applies the type change and resets the block
 * content to the residual (empty for divider).
 */
import type { BlockType } from "@/lib/types/pages";

export interface MarkdownShortcut {
  type: BlockType;
  /** Plain-text residual after stripping the trigger. */
  remainder: string;
}

const RULES: ReadonlyArray<{
  pattern: RegExp;
  type: BlockType;
  /** Treat as a "block-replacement" shortcut even when remainder is empty. */
  allowEmptyResidual?: boolean;
}> = [
  { pattern: /^# (.*)$/, type: "heading_1" },
  { pattern: /^## (.*)$/, type: "heading_2" },
  { pattern: /^### (.*)$/, type: "heading_3" },
  { pattern: /^([*-]) (.*)$/, type: "bulleted_list_item" },
  { pattern: /^\d+\. (.*)$/, type: "numbered_list_item" },
  { pattern: /^\[ ?\] (.*)$/, type: "to_do" },
  { pattern: /^> (.*)$/, type: "quote" },
  { pattern: /^```(.*)$/, type: "code", allowEmptyResidual: true },
  { pattern: /^---$/, type: "divider", allowEmptyResidual: true },
];

/**
 * Detect a shortcut from the current paragraph text. Returns `null` if no
 * rule matches. Bulleted/numbered patterns return the body of the line as the
 * remainder (so "- foo" becomes a bulleted list with text "foo").
 */
export function detectShortcut(input: string): MarkdownShortcut | null {
  for (const rule of RULES) {
    const m = rule.pattern.exec(input);
    if (!m) continue;
    let remainder = "";
    if (rule.type === "divider" || rule.type === "code") {
      remainder = "";
    } else if (rule.type === "bulleted_list_item") {
      remainder = m[2] ?? "";
    } else {
      remainder = m[1] ?? "";
    }
    return { type: rule.type, remainder };
  }
  return null;
}

/**
 * Inline markdown shortcuts. Currently we recognise:
 *   `**text**`   → bold
 *   `*text*` or `_text_` → italic
 *   `~~text~~`   → strike
 *   `` `text` `` → code
 *
 * These are applied by the editor when the user just typed the closing
 * delimiter — i.e. immediately *after* the last character of the delimiter
 * has been added to the text. The function returns the run to convert and
 * the surrounding offsets so the editor can splice without re-typing.
 */
export interface InlineShortcut {
  /** Range to replace, inclusive of delimiters. */
  start: number;
  end: number;
  /** Plain text without delimiters. */
  inner: string;
  /** Mark to apply on the new run. */
  mark: "bold" | "italic" | "strike" | "code";
}

const INLINE_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  mark: InlineShortcut["mark"];
}> = [
  { pattern: /\*\*([^\s*][^*]*[^\s*]|[^\s*])\*\*$/, mark: "bold" },
  { pattern: /~~([^~]+)~~$/, mark: "strike" },
  { pattern: /(?:^|[^*])\*([^\s*][^*]*[^\s*]|[^\s*])\*$/, mark: "italic" },
  { pattern: /`([^`]+)`$/, mark: "code" },
];

/**
 * Look at the text immediately before the caret to find a closed inline
 * shortcut. Returns null if none is present.
 */
export function detectInlineShortcut(
  textBeforeCaret: string,
): InlineShortcut | null {
  for (const { pattern, mark } of INLINE_PATTERNS) {
    const m = pattern.exec(textBeforeCaret);
    if (!m) continue;
    const matched = m[0];
    const inner = m[1];
    if (typeof inner !== "string" || inner.length === 0) continue;
    // For the italic pattern the match may start with a non-`*` char (the
    // negative lookbehind alternative). Strip it.
    const matchStart = textBeforeCaret.length - matched.length;
    const start =
      mark === "italic" && matched[0] !== "*" ? matchStart + 1 : matchStart;
    const end = textBeforeCaret.length;
    return { start, end, inner, mark };
  }
  return null;
}
