/**
 * Temporal decay and access-frequency boost for hybrid search scoring.
 *
 * Agent memories are unlike static documents — they lose salience over time
 * but gain importance through repeated access. These two signals combine
 * into a score modifier applied after RRF fusion.
 *
 * Decay follows an exponential curve (like radioactive half-life).
 * Boost follows a logarithmic scale (like spaced repetition).
 * Together they approximate the "activation strength" model from ACT-R cognitive
 * architecture.
 */

/** Controls how fast memories decay. 0.05 ≈ 60% weight remaining after 10 days. */
const DECAY_LAMBDA = 0.05

/**
 * Exponential temporal decay based on memory age.
 * Returns a multiplier in (0, 1].
 */
export function temporalDecay(createdAt: string): number {
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86_400_000
  return Math.exp(-DECAY_LAMBDA * Math.max(0, ageDays))
}

/**
 * Access-frequency boost using log2 scale.
 * Returns a multiplier >= 1.0.
 *
 * recall_count:  0 → 1.00x
 *                1 → 1.25x
 *                7 → 1.75x
 *               63 → 2.50x
 */
export function accessBoost(recallCount: number): number {
  return 1 + Math.log2(1 + recallCount) / 4
}

/**
 * Combined score modifier: temporalDecay × accessBoost.
 * Apply to RRF scores before final ranking.
 */
export function scoreModifier(createdAt: string, recallCount: number): number {
  return temporalDecay(createdAt) * accessBoost(recallCount)
}

/**
 * Importance boost from the memory's stored importance weight (0..1).
 * Linear around the neutral midpoint:
 *
 * importance: 0.0 → 0.50x
 *             0.5 → 1.00x (neutral / unset)
 *             1.0 → 1.50x
 */
export function importanceBoost(importance: number): number {
  return 0.5 + Math.min(1, Math.max(0, importance))
}
