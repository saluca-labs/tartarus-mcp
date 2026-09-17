// ── Core types ────────────────────────────────────────────────────────────────

export interface Memory {
  id: number
  content: string
  topics: string[]   // max MAX_TOPICS_PER_MEMORY words
  created_at: string // ISO 8601
  /**
   * Salience weight in [0, 1]. Settable on remember(); used as a ranking boost
   * in hybridSearch(). Unset memories surface as the neutral 0.5.
   */
  importance: number
  /** How many times this memory has been returned by recall/search/hybridSearch. */
  access_count: number
  /** ISO 8601 expiry. Expired memories are excluded from recall/search/list and are reap-able. */
  expires_at: string | null
  /**
   * Tenant/persona scope. Memories with a persona_id are only returned when the
   * caller filters for that persona. This is the multi-tenant seam for higher layers.
   */
  persona_id: string | null
  /** Free-form JSON attached to the memory. */
  metadata: Record<string, unknown> | null
  /** ISO 8601 timestamp of the last recall/search hit, or null if never accessed. */
  last_accessed: string | null
  /**
   * Set to true when remember() detected the content is a duplicate (exact match,
   * or semantic near-duplicate when a hybrid provider is configured) and returned
   * the existing memory instead of inserting.
   */
  isDuplicate?: boolean
}

/** Memory enriched with a relevance score. Returned by hybridSearch(). */
export interface ScoredMemory extends Memory {
  /** Fused relevance score (higher = better). Not comparable across queries. */
  score: number
  /** @deprecated Alias of access_count, kept for v0.3 compatibility. */
  recall_count: number
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface HybridProvider {
  /** Embedding dimensions — must match the dimensions stored in the adapter schema. */
  readonly dims: number
  /** Embed text into a float vector. */
  embed(text: string): Promise<number[]>
  /**
   * Generate a hypothetical memory string for HyDE (Hypothetical Document Embeddings).
   * The returned text is embedded and used as an additional search signal.
   * If not provided, hyde: true in HybridSearchOptions is a no-op.
   */
  generate?(query: string): Promise<string>
  /**
   * Re-score top candidates after RRF fusion using a cross-encoder ranking model.
   * If not provided, rerank: true in HybridSearchOptions is a no-op.
   */
  rerank?(query: string, memories: ScoredMemory[]): Promise<ScoredMemory[]>
  /** Release model resources. */
  close?(): Promise<void>
}

export interface AsphodelConfig {
  /** Max topic words per memory. Default: 10 */
  maxTopicsPerMemory?: number
  /** Max memories stored per topic word. Default: 10 */
  maxMemoriesPerTopic?: number
  /**
   * Optional AI-powered topic extractor. Receives content, returns topic words.
   * Falls back to built-in heuristic if not provided.
   */
  extractTopics?: (content: string) => Promise<string[]> | string[]
  /**
   * Optional hybrid search provider (embeddings + optional reranker).
   * When set, remember() stores vector embeddings and hybridSearch() is enabled.
   * Without this, hybridSearch() falls back to BM25-only search.
   */
  hybrid?: HybridProvider
}

// ── Adapter interface ─────────────────────────────────────────────────────────

/** Extra first-class fields stored alongside a memory on insert. */
export interface MemoryInput {
  /** Salience weight in [0, 1]. Stored null when unspecified (surfaces as 0.5). */
  importance?: number | null
  /** Tenant/persona scope. */
  personaId?: string | null
  /** ISO 8601 expiry timestamp (computed by the core from a ttl). */
  expiresAt?: string | null
  /** Free-form JSON. */
  metadata?: Record<string, unknown> | null
}

/**
 * Persona scoping for reads.
 * - `personaId` omitted → no persona filter (all memories).
 * - `personaId: "x"`    → only memories scoped to persona "x".
 * - `personaId: null`   → only unscoped memories (persona_id IS NULL).
 */
export interface QueryFilter {
  personaId?: string | null
}

export interface Adapter {
  init(): Promise<void>
  insert(content: string, topics: string[], extras?: MemoryInput): Promise<number>
  recall(topic: string, limit: number, filter?: QueryFilter): Promise<Memory[]>
  search(query: string, limit: number, filter?: QueryFilter): Promise<Memory[]>
  forget(id: number): Promise<boolean>
  list(limit: number, offset: number, filter?: QueryFilter): Promise<Memory[]>
  close(): Promise<void>

  // ── Optional extensions ─────────────────────────────────────────────────────
  // Callers must check for existence before calling.

  /** Find a live (non-expired) memory with exactly this content, within the persona scope. */
  findByContent?(content: string, filter?: QueryFilter): Promise<Memory | null>

  /** Delete all memories whose expires_at is at or before nowIso. Returns count deleted. */
  reap?(nowIso: string): Promise<number>

  /** Store an L2-normalized embedding for a memory. */
  vectorInsert?(id: number, embedding: number[]): Promise<void>

  /**
   * Find the k nearest memories by vector similarity.
   * Returns ScoredMemory[] ordered by similarity (desc), with access counts populated.
   * score = approximate cosine similarity (1 - L2²/2 on normalized vectors).
   * Expired memories are excluded; the persona filter applies when given.
   */
  vectorSearch?(embedding: number[], limit: number, filter?: QueryFilter): Promise<ScoredMemory[]>

  /** Increment access_count and stamp last_accessed for a set of memory IDs. */
  bumpRecallCount?(ids: number[]): Promise<void>
}

// ── API types ─────────────────────────────────────────────────────────────────

export interface RememberOptions {
  topics?: string[]  // override auto-extraction
  /** Skip deduplication (both exact-content and semantic) on this write. */
  skipDedup?: boolean
  /** Salience weight in [0, 1] (clamped). Default: unset → surfaces as 0.5. */
  importance?: number
  /** Time-to-live in seconds. The memory expires (stops being returned) after this. */
  ttl?: number
  /** Tenant/persona scope for this memory. */
  personaId?: string
  /** Free-form JSON to attach. */
  metadata?: Record<string, unknown>
}

export interface RecallOptions {
  limit?: number
  /** Persona scope filter — see QueryFilter.personaId semantics. */
  personaId?: string | null
}

export interface SearchOptions {
  limit?: number
  /** Persona scope filter — see QueryFilter.personaId semantics. */
  personaId?: string | null
}

export interface HybridSearchOptions {
  limit?: number
  /** Persona scope filter — see QueryFilter.personaId semantics. */
  personaId?: string | null
  /**
   * Apply temporal decay × access-frequency boost to RRF scores.
   * (The importance boost is always applied, independent of this flag.)
   * Default: true (when hybrid provider is configured).
   */
  decay?: boolean
  /**
   * Generate a hypothetical memory via the provider's generate() method, embed it,
   * and add it as a third signal in RRF fusion (weight: 0.40).
   * Requires HybridProvider to implement generate().
   * Default: false.
   */
  hyde?: boolean
  /**
   * Run an LLM reranker pass on the top candidates after RRF fusion.
   * Requires HybridProvider to implement rerank().
   * Default: false.
   */
  rerank?: boolean
}

export interface ListOptions {
  /** Persona scope filter — see QueryFilter.personaId semantics. */
  personaId?: string | null
}
