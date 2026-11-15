export interface FusedItem {
  id: string;
  score: number;
  /** 1-based rank in each input list, or null when absent from that list. */
  ranks: (number | null)[];
}

/**
 * Reciprocal rank fusion: score(d) = Σ 1 / (k + rank_i(d)). Rank-based, so lists with incomparable scores
 * (ts_rank_cd vs cosine distance) fuse without normalisation. Ties keep first-seen order.
 */
export function rrfFuse(lists: readonly (readonly string[])[], k = 60): FusedItem[] {
  const byId = new Map<string, FusedItem & { order: number }>();
  let order = 0;
  lists.forEach((list, li) => {
    const seen = new Set<string>();
    list.forEach((id, idx) => {
      if (seen.has(id)) return;
      seen.add(id);
      let item = byId.get(id);
      if (!item) {
        item = { id, score: 0, ranks: lists.map(() => null), order: order++ };
        byId.set(id, item);
      }
      item.score += 1 / (k + idx + 1);
      item.ranks[li] = idx + 1;
    });
  });
  return [...byId.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ order: _order, ...rest }) => rest);
}
