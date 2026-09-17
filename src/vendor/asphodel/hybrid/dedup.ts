/**
 * Semantic deduplication utilities.
 *
 * Used at insert time to prevent near-identical memories from being stored twice.
 * Works on L2-normalized embeddings, where L2 distance maps directly to cosine distance:
 *   cosine_similarity ≈ 1 - (L2_distance² / 2)
 */

/**
 * Cosine similarity between two equal-length float vectors.
 * Returns a value in [-1, 1], where 1 = identical direction.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot   += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

/**
 * L2-normalize a float vector in place (returns new array).
 * Storing normalized embeddings lets us use L2 distance as cosine distance.
 */
export function normalizeEmbedding(embedding: number[]): number[] {
  const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0))
  return norm === 0 ? embedding : embedding.map(v => v / norm)
}

/**
 * Convert L2 distance (between normalized vectors) to approximate cosine similarity.
 */
export function l2ToCosineSimilarity(l2Distance: number): number {
  return Math.max(0, 1 - (l2Distance * l2Distance) / 2)
}

/** Memories with cosine similarity above this threshold are considered duplicates. */
export const DEDUP_THRESHOLD = 0.95
