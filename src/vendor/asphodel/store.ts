import type {
  Adapter,
  AsphodelConfig,
  HybridSearchOptions,
  ListOptions,
  Memory,
  MemoryInput,
  QueryFilter,
  RecallOptions,
  RememberOptions,
  ScoredMemory,
  SearchOptions,
} from './types.js'
import { extractTopicsLocal } from './topic.js'
import { reciprocalRankFusion } from './hybrid/rrf.js'
import { importanceBoost, scoreModifier } from './hybrid/decay.js'
import { normalizeEmbedding, DEDUP_THRESHOLD } from './hybrid/dedup.js'

const DEFAULT_MAX_TOPICS   = 10
const DEFAULT_RECALL_LIMIT = 10
const DEFAULT_SEARCH_LIMIT = 10
const DEFAULT_LIST_LIMIT   = 20

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

export class Asphodel {
  private readonly adapter: Adapter
  private readonly maxTopicsPerMemory: number
  private readonly extractTopics: (content: string) => Promise<string[]> | string[]
  private readonly hybrid: AsphodelConfig['hybrid']

  constructor(adapter: Adapter, config: AsphodelConfig = {}) {
    this.adapter = adapter
    this.maxTopicsPerMemory = config.maxTopicsPerMemory ?? DEFAULT_MAX_TOPICS
    this.extractTopics = config.extractTopics ??
      ((content: string) => extractTopicsLocal(content, this.maxTopicsPerMemory))
    this.hybrid = config.hybrid
  }

  async init(): Promise<void> {
    await this.adapter.init()
  }

  /**
   * Store a memory. First-class fields: importance (ranking boost), ttl (expiry,
   * seconds), personaId (tenant/persona scope), metadata (free-form JSON).
   *
   * Deduplication (skippable via options.skipDedup):
   * 1. Exact-content: if a live memory with identical content exists in the same
   *    persona scope, the insert is skipped and the existing memory is returned
   *    with isDuplicate: true.
   * 2. Semantic (requires a hybrid provider): the content is embedded and compared
   *    against the nearest existing memory in the same persona scope. If cosine
   *    similarity exceeds the dedup threshold the insert is skipped and the
   *    existing memory is returned with isDuplicate: true.
   *
   * If a HybridProvider is configured, also embeds the content and stores a
   * vector for future hybridSearch() calls.
   */
  async remember(content: string, options: RememberOptions = {}): Promise<Memory> {
    const topics = options.topics
      ? options.topics.slice(0, this.maxTopicsPerMemory).map(t => t.toLowerCase().trim())
      : await Promise.resolve(this.extractTopics(content))

    const importance = options.importance !== undefined ? clamp01(options.importance) : null
    const expiresAt  = options.ttl !== undefined
      ? new Date(Date.now() + options.ttl * 1000).toISOString()
      : null
    const personaId  = options.personaId ?? null
    const metadata   = options.metadata ?? null

    const extras: MemoryInput = { importance, expiresAt, personaId, metadata }
    // Dedup is scoped to the memory's own persona (a duplicate in another
    // tenant's scope is not a duplicate here).
    const dedupScope: QueryFilter = { personaId }

    // ── Dedup 1: exact content match (deterministic, no embeddings needed) ──
    if (!options.skipDedup && this.adapter.findByContent) {
      const existing = await this.adapter.findByContent(content, dedupScope)
      if (existing) {
        return { ...existing, isDuplicate: true }
      }
    }

    // ── Hybrid path: embed → semantic dedup → insert → vectorInsert ────────
    if (this.hybrid) {
      const rawEmbedding = await this.hybrid.embed(content)
      const embedding = normalizeEmbedding(rawEmbedding)

      // Dedup 2: semantic — check nearest neighbor before inserting
      if (!options.skipDedup && this.adapter.vectorSearch) {
        const nearest = await this.adapter.vectorSearch(embedding, 1, dedupScope)
        if (nearest[0] && nearest[0].score >= DEDUP_THRESHOLD) {
          return { ...nearest[0], isDuplicate: true }
        }
      }

      const id = await this.adapter.insert(content, topics, extras)
      await this.adapter.vectorInsert?.(id, embedding)
      return this.freshMemory(id, content, topics, extras)
    }

    // ── Standard path ──────────────────────────────────────────────────────
    const id = await this.adapter.insert(content, topics, extras)
    return this.freshMemory(id, content, topics, extras)
  }

  private freshMemory(id: number, content: string, topics: string[], extras: MemoryInput): Memory {
    return {
      id,
      content,
      topics,
      created_at:    new Date().toISOString(),
      importance:    extras.importance ?? 0.5,
      access_count:  0,
      expires_at:    extras.expiresAt ?? null,
      persona_id:    extras.personaId ?? null,
      metadata:      extras.metadata ?? null,
      last_accessed: null,
    }
  }

  async recall(topic: string, options: RecallOptions = {}): Promise<Memory[]> {
    const memories = await this.adapter.recall(
      topic.toLowerCase().trim(),
      options.limit ?? DEFAULT_RECALL_LIMIT,
      { personaId: options.personaId },
    )
    await this.bumpAccess(memories)
    return memories
  }

  async search(query: string, options: SearchOptions = {}): Promise<Memory[]> {
    const memories = await this.adapter.search(
      query,
      options.limit ?? DEFAULT_SEARCH_LIMIT,
      { personaId: options.personaId },
    )
    await this.bumpAccess(memories)
    return memories
  }

  /**
   * Access accounting is unified here: every memory returned to the caller by
   * recall/search/hybridSearch counts as exactly one access (feeds the
   * access-frequency boost in hybridSearch scoring).
   */
  private async bumpAccess(memories: Memory[]): Promise<void> {
    if (memories.length === 0) return
    await this.adapter.bumpRecallCount?.(memories.map(m => m.id))
  }

  /**
   * Hybrid search: BM25 + vector cosine → RRF fusion → importance boost ×
   * temporal decay × access-frequency boost → optional LLM rerank.
   *
   * Falls back to BM25-only search if no HybridProvider is configured or the
   * adapter does not support vectorSearch. The importance boost is applied in
   * both paths.
   */
  async hybridSearch(
    query: string,
    options: HybridSearchOptions = {},
  ): Promise<ScoredMemory[]> {
    const limit    = options.limit ?? DEFAULT_SEARCH_LIMIT
    const decay    = options.decay ?? true
    const doHyde   = options.hyde   ?? false
    const doRerank = options.rerank ?? false
    const filter: QueryFilter = { personaId: options.personaId }

    // ── Fallback: BM25 only ───────────────────────────────────────────────
    if (!this.hybrid || !this.adapter.vectorSearch) {
      const results = await this.adapter.search(query, limit, filter)
      const scored = results
        .map((m, i) => ({
          ...m,
          recall_count: m.access_count,
          score: (1 / (60 + i + 1)) * importanceBoost(m.importance),  // synthetic RRF-like score
        }))
        .sort((a, b) => b.score - a.score)
      await this.bumpAccess(scored)
      return scored
    }

    // ── Phase 1: Candidate generation (parallel) ──────────────────────────
    const candidateLimit = Math.max(limit * 3, 20)

    // Phase 1a: BM25 + query embedding (parallel)
    const [bm25Results, queryEmbedding] = await Promise.all([
      this.adapter.search(query, candidateLimit, filter),
      this.hybrid.embed(query).then(normalizeEmbedding),
    ])

    const vecResults = await this.adapter.vectorSearch(queryEmbedding, candidateLimit, filter)

    // Phase 1b: HyDE — generate a hypothetical memory, embed it, search with it
    // Runs after the base searches so it doesn't block them.
    let hydeResults: ScoredMemory[] = []
    if (doHyde && this.hybrid.generate) {
      try {
        const hydeText      = await this.hybrid.generate(query)
        const hydeEmbedding = normalizeEmbedding(await this.hybrid.embed(hydeText))
        hydeResults         = await this.adapter.vectorSearch(hydeEmbedding, candidateLimit, filter)
      } catch {
        // HyDE generation failure is non-fatal — proceed without it
      }
    }

    // ── Phase 2: RRF fusion ───────────────────────────────────────────────
    const rrfLists = [
      { results: bm25Results, weight: 0.75 },
      { results: vecResults,  weight: 0.60 },
      ...(hydeResults.length > 0 ? [{ results: hydeResults, weight: 0.40 }] : []),
    ]
    const fused = reciprocalRankFusion(rrfLists)

    // ── Phase 3: Hydrate fused IDs with full memory data ─────────────────
    const byId = new Map<number, Memory & { recall_count: number }>()
    for (const m of bm25Results) {
      byId.set(m.id, { ...m, recall_count: m.access_count })
    }
    for (const m of vecResults) {
      if (!byId.has(m.id)) byId.set(m.id, m)
    }

    let scored: ScoredMemory[] = fused
      .filter(({ id }) => byId.has(id))
      .map(({ id, score }) => {
        const mem = byId.get(id)!
        return { ...mem, score, recall_count: mem.recall_count }
      })

    // ── Phase 4: Importance boost × temporal decay × access-frequency ────
    scored = scored.map(m => ({
      ...m,
      score: m.score
        * importanceBoost(m.importance)
        * (decay ? scoreModifier(m.created_at, m.access_count) : 1),
    }))
    scored.sort((a, b) => b.score - a.score)

    // ── Phase 5: Optional LLM rerank ─────────────────────────────────────
    if (doRerank && this.hybrid.rerank) {
      const candidates = scored.slice(0, 40)
      scored = await this.hybrid.rerank(query, candidates)
    }

    // Bump access_count for the results we're returning
    const returnSlice = scored.slice(0, limit)
    await this.bumpAccess(returnSlice)

    return returnSlice
  }

  async forget(id: number): Promise<boolean> {
    return this.adapter.forget(id)
  }

  async list(limit = DEFAULT_LIST_LIMIT, offset = 0, options: ListOptions = {}): Promise<Memory[]> {
    return this.adapter.list(limit, offset, { personaId: options.personaId })
  }

  /**
   * Delete expired memories (ttl elapsed). Expired memories are already excluded
   * from recall/search/list; reap() reclaims the storage. Returns count deleted.
   */
  async reap(): Promise<number> {
    if (!this.adapter.reap) return 0
    return this.adapter.reap(new Date().toISOString())
  }

  async close(): Promise<void> {
    await this.adapter.close()
    await this.hybrid?.close?.()
  }
}
