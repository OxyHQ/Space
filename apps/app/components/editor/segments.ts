/**
 * Segment utilities — the editor stores rich text as a flat array of
 * `Segment`s. Each Segment is a single run of text plus optional
 * annotations (bold/italic/etc + colors + link). Compared to a true
 * tree-based document model this loses nothing for inline formatting and
 * keeps the diff/save logic trivial.
 *
 * Web-only: serialization to/from `contentEditable` DOM happens in
 * `rich-editable.tsx`. These helpers are framework-free.
 */
import type { BlockColor, Segment } from "@/lib/types/pages";

/** Segment with no annotations — a plain run of text. */
export function plainSegment(text: string): Segment {
  return { text };
}

/** Concatenated plain text of every segment. */
export function segmentsToPlainText(segments: Segment[] | undefined): string {
  if (!segments) return "";
  return segments.map((s) => s.text).join("");
}

/**
 * If a block currently stores only `text`, promote it to a single plain
 * segment. Callers can then apply annotations against a uniform `Segment[]`.
 */
export function ensureSegments(
  segments: Segment[] | undefined,
  fallbackText: string,
): Segment[] {
  if (segments && segments.length > 0) return segments;
  if (fallbackText.length === 0) return [];
  return [plainSegment(fallbackText)];
}

type Mark = Exclude<keyof Segment, "text" | "link">;

const BOOL_MARKS: readonly Mark[] = [
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
  "color",
  "background",
];

function annotationsEqual(a: Segment, b: Segment): boolean {
  if (a.link !== b.link) return false;
  for (const m of BOOL_MARKS) {
    if (a[m] !== b[m]) return false;
  }
  return true;
}

/** Merge neighboring segments with identical annotations. */
export function coalesceSegments(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    if (seg.text.length === 0) continue;
    const last = out[out.length - 1];
    if (last && annotationsEqual(last, seg)) {
      last.text += seg.text;
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

/**
 * Split segments at a character offset, returning [left, right]. Offset is a
 * codepoint count across the flattened text. Used to apply formatting to a
 * sub-range.
 */
export function splitSegmentsAt(
  segments: Segment[],
  offset: number,
): [Segment[], Segment[]] {
  const left: Segment[] = [];
  const right: Segment[] = [];
  let consumed = 0;
  for (const seg of segments) {
    const len = seg.text.length;
    if (offset <= consumed) {
      right.push({ ...seg });
    } else if (offset >= consumed + len) {
      left.push({ ...seg });
    } else {
      const cut = offset - consumed;
      left.push({ ...seg, text: seg.text.slice(0, cut) });
      right.push({ ...seg, text: seg.text.slice(cut) });
    }
    consumed += len;
  }
  return [left, right];
}

export type AnnotationPatch = Partial<{
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
  color: BlockColor;
  background: BlockColor;
  link: string | undefined;
}>;

/**
 * Apply an annotation patch to every segment that overlaps [start, end).
 * Annotations specified as `false` (or `undefined` for link) are removed.
 *
 * Returns a fresh coalesced segment list.
 */
export function applyAnnotationRange(
  segments: Segment[],
  start: number,
  end: number,
  patch: AnnotationPatch,
): Segment[] {
  if (start === end) return segments;
  const [headFirst, restA] = splitSegmentsAt(segments, start);
  const [middle, tail] = splitSegmentsAt(restA, end - start);
  const patched = middle.map((seg) => applyPatch(seg, patch));
  return coalesceSegments([...headFirst, ...patched, ...tail]);
}

function applyPatch(seg: Segment, patch: AnnotationPatch): Segment {
  const out: Segment = { ...seg };
  for (const key of [
    "bold",
    "italic",
    "underline",
    "strike",
    "code",
  ] as const) {
    if (key in patch) {
      const val = patch[key];
      if (val) out[key] = true;
      else delete out[key];
    }
  }
  if ("color" in patch) {
    if (patch.color && patch.color !== "default") out.color = patch.color;
    else delete out.color;
  }
  if ("background" in patch) {
    if (patch.background && patch.background !== "default") out.background = patch.background;
    else delete out.background;
  }
  if ("link" in patch) {
    if (patch.link) out.link = patch.link;
    else delete out.link;
  }
  return out;
}

/**
 * Check whether every segment fully inside [start, end) has a mark set.
 * Used by the formatting toolbar to display the "active" state.
 */
export function rangeHasMark(
  segments: Segment[],
  start: number,
  end: number,
  mark: Mark,
): boolean {
  if (start === end) return false;
  const [, rest] = splitSegmentsAt(segments, start);
  const [middle] = splitSegmentsAt(rest, end - start);
  if (middle.length === 0) return false;
  return middle.every((seg) => Boolean(seg[mark]));
}

/** Apply a single character insertion to the segments at the given offset. */
export function insertText(
  segments: Segment[],
  offset: number,
  text: string,
): Segment[] {
  if (text.length === 0) return segments;
  if (segments.length === 0) {
    return [{ text }];
  }
  const [left, right] = splitSegmentsAt(segments, offset);
  // Inherit the annotations of the segment immediately to the left, falling
  // back to the right neighbor (so insertions at offset 0 keep their style).
  const inheritFrom = left[left.length - 1] ?? right[0];
  const inherited = inheritFrom
    ? { ...inheritFrom, text }
    : { text };
  return coalesceSegments([...left, inherited, ...right]);
}

/** Delete the [start, end) range. */
export function deleteRange(
  segments: Segment[],
  start: number,
  end: number,
): Segment[] {
  if (start === end) return segments;
  const [left, rest] = splitSegmentsAt(segments, start);
  const [, tail] = splitSegmentsAt(rest, end - start);
  return coalesceSegments([...left, ...tail]);
}
