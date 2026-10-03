/**
 * Manual card ordering: sparse/fractional ranks for a flat YAML `order`
 * frontmatter key, shared with the Android sibling.
 *
 * The grid sorts ascending by a card's rank, where rank = `order` when present,
 * else the negative filename timestamp (so new, unranked captures land on top). Ranks are
 * finite numbers; `betweenRank` picks the midpoint between two neighbors so a
 * single drag writes a minimal fractional order to only the moved card.
 */

/** Step between freshly respaced ranks. Matches the Android sibling's `NoteOrder`
 * (edge insertion ±1, renumber 0..n), so both platforms write the same kind of
 * finite ascending `order` values. Fractional midpoints between neighbors carry
 * the sparse ordering; integer respace fires only when a float gap runs out. */
export const RANK_SPACING = 1;

export function rankForManualOrder(order: number | null, filename: string): number {
  if (order != null) return order;
  const stamp = filename.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{6})/);
  return stamp ? -Number(stamp.slice(1).join("")) : 0;
}

/**
 * Rank to assign a card inserted between `prev` and `next` (both ascending, or
 * null at an edge). Returns null when there is no representable gap between the
 * two neighbors (their floats are exhausted or equal) — the caller must respace.
 */
export function betweenRank(prev: number | null, next: number | null): number | null {
  if (prev == null) {
    return next == null ? 0 : next - RANK_SPACING;
  }
  if (next == null) return prev + RANK_SPACING;
  const mid = prev + (next - prev) / 2;
  return mid > prev && mid < next ? mid : null;
}

/** Fresh evenly spaced ranks for `count` cards, starting at `origin`. */
export function respaceRanks(count: number, origin = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(origin + i * RANK_SPACING);
  return out;
}
