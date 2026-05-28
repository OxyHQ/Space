/**
 * Tiny fuzzy matcher tuned for the Cmd+K command palette.
 *
 * Why not pull in a dep:
 * - We're constrained on cross-platform code; smaller bundle is better.
 * - `cmdk` already does its own filtering, but we use this layer for
 *   ranking the Page/Member/Command groups before handing them to cmdk
 *   so groups stay in stable order even when scores tie.
 *
 * Algorithm: subsequence match (case-insensitive) with score:
 *  - Higher when the query matches consecutive characters
 *  - Higher when the first match starts at the beginning of the string
 *  - Penalty for gaps between matches
 */

export interface FuzzyResult<T> {
  item: T;
  score: number;
}

function scoreMatch(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let lastMatchIndex = -1;
  let consecutive = 0;
  let score = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] === q[qi]) {
      // Boost: matched at start of string.
      if (ti === 0) score += 5;
      // Boost: matched right after the last hit (consecutive).
      if (lastMatchIndex === ti - 1) {
        consecutive += 1;
        score += 2 + consecutive;
      } else {
        consecutive = 0;
        // Boost: matched at word boundary.
        const prev = t[ti - 1];
        if (prev === ' ' || prev === '-' || prev === '_' || prev === '/') {
          score += 3;
        }
      }
      lastMatchIndex = ti;
      qi += 1;
    }
  }
  // Did the query match in full?
  if (qi < q.length) return 0;
  // Penalize long strings vs short queries — shorter is closer.
  score -= Math.max(0, t.length - q.length) * 0.05;
  return Math.max(0.1, score);
}

/**
 * Returns items that match the query, sorted by score descending. Items
 * with zero score (no match) are excluded.
 *
 * `keys` is a list of field accessors; the highest field score wins per item.
 */
export function fuzzyFilter<T>(
  items: T[],
  query: string,
  keys: ReadonlyArray<(item: T) => string | null | undefined>,
): FuzzyResult<T>[] {
  if (!query.trim()) {
    return items.map((item) => ({ item, score: 1 }));
  }
  const results: FuzzyResult<T>[] = [];
  for (const item of items) {
    let best = 0;
    for (const key of keys) {
      const v = key(item);
      if (!v) continue;
      const s = scoreMatch(query, v);
      if (s > best) best = s;
    }
    if (best > 0) results.push({ item, score: best });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}
