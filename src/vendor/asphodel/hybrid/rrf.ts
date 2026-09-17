/**
 * Reciprocal Rank Fusion (RRF)
 *
 * Fuses multiple ranked result lists into a single score.
 * Approach inspired by QMD (github.com/tobi/qmd) and the original paper:
 *   Cormack, Clarke & Buettcher — "Reciprocal Rank Fusion outperforms Condorcet
 *   and individual rank learning methods", SIGIR 2009.
 *
 * Adapted for agent memory: results carry integer memory IDs rather than file paths,
 * and weights are tuned for the BM25 / vector / HyDE signal mix.
 */

export interface RankedItem {
  id: number
}

export interface RRFList {
  results: RankedItem[]
  /**
   * Position-aware weight multiplier.
   * Typical values: 0.75 (BM25), 0.60 (vector), 0.40 (HyDE).
   */
  weight: number
}

/** Standard RRF constant. Dampens the impact of rank differences. */
const RRF_K = 60

/**
 * Fuse multiple ranked lists and return memory IDs sorted by fused score (desc).
 */
export function reciprocalRankFusion(
  lists: RRFList[],
): Array<{ id: number; score: number }> {
  const scores = new Map<number, number>()

  for (const { results, weight } of lists) {
    for (let rank = 0; rank < results.length; rank++) {
      const { id } = results[rank]
      const contribution = weight / (RRF_K + rank + 1)
      scores.set(id, (scores.get(id) ?? 0) + contribution)
    }
  }

  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
}
