import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { reciprocalRankFusion } from '../../../src/vendor/asphodel/hybrid/rrf.js'
import { temporalDecay, accessBoost, importanceBoost, scoreModifier } from '../../../src/vendor/asphodel/hybrid/decay.js'
import { cosineSimilarity, normalizeEmbedding, l2ToCosineSimilarity, DEDUP_THRESHOLD } from '../../../src/vendor/asphodel/hybrid/dedup.js'
import { Asphodel } from '../../../src/vendor/asphodel/store.js'
import { SQLiteAdapter } from '../../../src/vendor/asphodel/adapters/sqlite.js'
import type { HybridProvider, ScoredMemory } from '../../../src/vendor/asphodel/types.js'

// ── RRF ────────────────────────────────────────────────────────────────────────

describe('reciprocalRankFusion', () => {
  it('scores a single list by rank with weight/(k + rank + 1)', () => {
    const fused = reciprocalRankFusion([
      { results: [{ id: 1 }, { id: 2 }], weight: 0.75 },
    ])
    expect(fused[0]).toEqual({ id: 1, score: 0.75 / 61 })
    expect(fused[1]).toEqual({ id: 2, score: 0.75 / 62 })
  })

  it('sums contributions when an id appears in multiple lists', () => {
    const fused = reciprocalRankFusion([
      { results: [{ id: 1 }, { id: 2 }], weight: 0.75 },
      { results: [{ id: 2 }, { id: 1 }], weight: 0.60 },
    ])
    const byId = new Map(fused.map(f => [f.id, f.score]))
    expect(byId.get(1)).toBeCloseTo(0.75 / 61 + 0.60 / 62, 10)
    expect(byId.get(2)).toBeCloseTo(0.75 / 62 + 0.60 / 61, 10)
  })

  it('an id present in both lists outranks single-list ids at the same rank', () => {
    const fused = reciprocalRankFusion([
      { results: [{ id: 1 }, { id: 3 }], weight: 0.75 },
      { results: [{ id: 3 }, { id: 2 }], weight: 0.60 },
    ])
    expect(fused[0].id).toBe(3)
  })

  it('returns results sorted by score descending', () => {
    const fused = reciprocalRankFusion([
      { results: [{ id: 5 }, { id: 6 }, { id: 7 }], weight: 1 },
    ])
    const scores = fused.map(f => f.score)
    expect([...scores].sort((a, b) => b - a)).toEqual(scores)
  })

  it('handles empty input', () => {
    expect(reciprocalRankFusion([])).toEqual([])
  })
})

// ── Decay / boosts ─────────────────────────────────────────────────────────────

describe('temporal decay and boosts', () => {
  it('temporalDecay is ~1 for a brand-new memory and decreases with age', () => {
    const now = new Date().toISOString()
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString()
    expect(temporalDecay(now)).toBeCloseTo(1, 2)
    expect(temporalDecay(tenDaysAgo)).toBeCloseTo(Math.exp(-0.5), 2) // λ=0.05 × 10d
    expect(temporalDecay(tenDaysAgo)).toBeLessThan(temporalDecay(now))
  })

  it('accessBoost follows the documented log2 curve', () => {
    expect(accessBoost(0)).toBe(1)
    expect(accessBoost(1)).toBeCloseTo(1.25, 10)
    expect(accessBoost(7)).toBeCloseTo(1.75, 10)
    expect(accessBoost(63)).toBeCloseTo(2.5, 10)
  })

  it('importanceBoost is linear around the neutral 0.5 and clamped', () => {
    expect(importanceBoost(0)).toBe(0.5)
    expect(importanceBoost(0.5)).toBe(1)
    expect(importanceBoost(1)).toBe(1.5)
    expect(importanceBoost(99)).toBe(1.5)
    expect(importanceBoost(-1)).toBe(0.5)
  })

  it('scoreModifier multiplies decay and access boost', () => {
    const now = new Date().toISOString()
    expect(scoreModifier(now, 7)).toBeCloseTo(temporalDecay(now) * 1.75, 10)
  })
})

// ── Dedup math ─────────────────────────────────────────────────────────────────

describe('dedup utilities', () => {
  it('cosineSimilarity: identical, orthogonal, and zero vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0)
  })

  it('normalizeEmbedding produces a unit vector (and passes zero through)', () => {
    const n = normalizeEmbedding([3, 4])
    expect(n[0]).toBeCloseTo(0.6, 10)
    expect(n[1]).toBeCloseTo(0.8, 10)
    expect(Math.hypot(...normalizeEmbedding([7, -2, 5]))).toBeCloseTo(1, 10)
    expect(normalizeEmbedding([0, 0])).toEqual([0, 0])
  })

  it('l2ToCosineSimilarity inverts distance on unit vectors', () => {
    expect(l2ToCosineSimilarity(0)).toBe(1)
    // orthogonal unit vectors are √2 apart → similarity 0
    expect(l2ToCosineSimilarity(Math.SQRT2)).toBeCloseTo(0, 10)
    expect(l2ToCosineSimilarity(10)).toBe(0) // floored at 0
  })

  it('exposes the dedup threshold', () => {
    expect(DEDUP_THRESHOLD).toBeGreaterThan(0.9)
    expect(DEDUP_THRESHOLD).toBeLessThanOrEqual(1)
  })
})

// ── hybridSearch integration (sqlite-vec + controllable fake provider) ─────────

/**
 * Deterministic provider: known texts map to fixed unit vectors; unknown texts
 * fall back to a stable hash-derived vector. No models, no network.
 */
class FakeProvider implements HybridProvider {
  readonly dims = 4
  generate?: (query: string) => Promise<string>
  rerank?: (query: string, memories: ScoredMemory[]) => Promise<ScoredMemory[]>
  private readonly vectors = new Map<string, number[]>()

  set(text: string, vec: number[]): void {
    this.vectors.set(text, normalizeEmbedding(vec))
  }

  async embed(text: string): Promise<number[]> {
    const known = this.vectors.get(text)
    if (known) return known
    // Stable fallback so unregistered texts don't collide with registered axes
    let h = 2166136261
    for (const ch of text) { h = Math.imul(h ^ ch.charCodeAt(0), 16777619) }
    const v = [0, 0, 0, 1 + (h >>> 28) / 16]
    return normalizeEmbedding(v)
  }
}

function vecAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    require('sqlite-vec').load(db)
    db.close()
    return true
  } catch {
    return false
  }
}

describe.skipIf(!vecAvailable())('hybridSearch (full path, sqlite-vec)', () => {
  let store: Asphodel
  let provider: FakeProvider

  beforeEach(async () => {
    provider = new FakeProvider()
    store = new Asphodel(
      new SQLiteAdapter({ dbPath: ':memory:', vectorDims: provider.dims }),
      { hybrid: provider },
    )
    await store.init()
  })

  afterEach(async () => {
    await store.close()
    vi.useRealTimers()
  })

  it('finds a memory by vector similarity with zero lexical overlap', async () => {
    provider.set('felines purr softly', [1, 0, 0, 0])
    provider.set('canines bark loudly', [0, 1, 0, 0])
    provider.set('kitty', [0.95, 0.05, 0, 0])

    await store.remember('felines purr softly')
    await store.remember('canines bark loudly')

    const results = await store.hybridSearch('kitty')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].content).toBe('felines purr softly')
    expect(results[0].score).toBeGreaterThan(0)
  })

  it('semantic dedup: near-duplicate content returns the original with isDuplicate', async () => {
    provider.set('cats meow at dawn', [1, 0, 0, 0])
    provider.set('felines vocalize at sunrise', [0.999, 0.0447, 0, 0]) // cos ≈ 0.999

    const original = await store.remember('cats meow at dawn')
    const dup = await store.remember('felines vocalize at sunrise')

    expect(dup.isDuplicate).toBe(true)
    expect(dup.id).toBe(original.id)
    expect((await store.list()).length).toBe(1)
  })

  it('distinct vectors below the threshold insert normally', async () => {
    provider.set('cats meow', [1, 0, 0, 0])
    provider.set('dogs bark', [0, 1, 0, 0])
    await store.remember('cats meow')
    const second = await store.remember('dogs bark')
    expect(second.isDuplicate).toBeUndefined()
    expect((await store.list()).length).toBe(2)
  })

  it('importance boost reorders equally-relevant results', async () => {
    provider.set('zebra fact one', [1, 0, 0, 0])
    provider.set('zebra fact two', [0, 1, 0, 0])
    provider.set('zebra', [Math.SQRT1_2, Math.SQRT1_2, 0, 0]) // equidistant query

    await store.remember('zebra fact one', { importance: 0.0 })
    await store.remember('zebra fact two', { importance: 1.0 })

    const results = await store.hybridSearch('zebra')
    expect(results.length).toBe(2)
    expect(results[0].content).toBe('zebra fact two')
    expect(results[0].score).toBeGreaterThan(results[1].score)
  })

  it('expired memories are excluded from the vector path', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    provider.set('temporary vector note', [1, 0, 0, 0])
    provider.set('temporary', [0.98, 0.02, 0, 0])

    await store.remember('temporary vector note', { ttl: 60 })
    vi.setSystemTime(new Date('2026-01-01T01:00:00.000Z'))
    expect(await store.hybridSearch('temporary')).toEqual([])
  })

  it('persona filter applies to the hybrid path', async () => {
    provider.set('gadget blueprint alpha', [1, 0, 0, 0])
    provider.set('gadget blueprint beta', [0.6, 0.8, 0, 0])
    provider.set('gadget', [0.9, 0.1, 0, 0])

    await store.remember('gadget blueprint alpha', { personaId: 'lucius' })
    await store.remember('gadget blueprint beta', { personaId: 'oracle' })

    const scoped = await store.hybridSearch('gadget', { personaId: 'lucius' })
    expect(scoped.length).toBe(1)
    expect(scoped[0].persona_id).toBe('lucius')
  })

  it('bumps access_count for returned hits and feeds the frequency boost', async () => {
    provider.set('walrus migration data', [1, 0, 0, 0])
    provider.set('walrus', [0.97, 0.03, 0, 0])

    await store.remember('walrus migration data')
    await store.hybridSearch('walrus')
    await store.hybridSearch('walrus')
    const [mem] = await store.list()
    expect(mem.access_count).toBe(2)
    expect(mem.last_accessed).not.toBeNull()
  })

  it('forgotten memories stop appearing in vector results', async () => {
    provider.set('obsolete plan', [1, 0, 0, 0])
    provider.set('obsolete', [0.99, 0.01, 0, 0])

    const mem = await store.remember('obsolete plan')
    await store.forget(mem.id)
    expect(await store.hybridSearch('obsolete')).toEqual([])
  })

  it('HyDE adds a third signal when the provider implements generate()', async () => {
    const hydeProvider = new FakeProvider() as FakeProvider & HybridProvider
    hydeProvider.set('the launch code rotates weekly', [1, 0, 0, 0])
    hydeProvider.set('hypothetical: launch codes', [0.99, 0.01, 0, 0])
    hydeProvider.set('security question', [0, 0, 1, 0]) // raw query far away
    hydeProvider.generate = async () => 'hypothetical: launch codes'

    const hydeStore = new Asphodel(
      new SQLiteAdapter({ dbPath: ':memory:', vectorDims: 4 }),
      { hybrid: hydeProvider },
    )
    await hydeStore.init()
    await hydeStore.remember('the launch code rotates weekly')

    const without = await hydeStore.hybridSearch('security question', { hyde: false, decay: false })
    const withHyde = await hydeStore.hybridSearch('security question', { hyde: true, decay: false })
    // The raw query's vector is far away; the HyDE embedding is a strong third
    // signal, so the fused score must strictly increase.
    expect(withHyde.length).toBe(1)
    expect(withHyde[0].content).toBe('the launch code rotates weekly')
    expect(withHyde[0].score).toBeGreaterThan(without[0]?.score ?? 0)
    await hydeStore.close()
  })

  it('rerank pass reorders via the provider when requested', async () => {
    provider.set('quartz sample A', [1, 0, 0, 0])
    provider.set('quartz sample B', [0, 1, 0, 0])
    provider.set('quartz', [0.9, 0.1, 0, 0]) // vector favors A
    provider.rerank = async (_q, memories) =>
      [...memories].sort((a, b) => (a.content > b.content ? -1 : 1)) // force B first

    await store.remember('quartz sample A')
    await store.remember('quartz sample B')
    const results = await store.hybridSearch('quartz', { rerank: true })
    expect(results[0].content).toBe('quartz sample B')
  })
})
