import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Asphodel } from '../../../src/vendor/asphodel/store.js'
import { SQLiteAdapter } from '../../../src/vendor/asphodel/adapters/sqlite.js'

describe('Asphodel (SQLite adapter)', () => {
  let store: Asphodel

  beforeEach(async () => {
    const adapter = new SQLiteAdapter({ dbPath: ':memory:' })
    store = new Asphodel(adapter)
    await store.init()
  })

  afterEach(async () => {
    await store.close()
  })

  // ── remember ──────────────────────────────────────────────────────────────

  describe('remember', () => {
    it('stores a memory and returns id, content, topics, created_at', async () => {
      const mem = await store.remember('The sky is blue')
      expect(mem.id).toBeTypeOf('number')
      expect(mem.content).toBe('The sky is blue')
      expect(Array.isArray(mem.topics)).toBe(true)
      expect(mem.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    })

    it('auto-extracts topics from content', async () => {
      const mem = await store.remember('JavaScript is a programming language for the web')
      expect(mem.topics.length).toBeGreaterThan(0)
    })

    it('accepts explicit topic override', async () => {
      const mem = await store.remember('Some content', { topics: ['alpha', 'beta'] })
      expect(mem.topics).toContain('alpha')
      expect(mem.topics).toContain('beta')
    })

    it('normalises explicit topics to lowercase', async () => {
      const mem = await store.remember('Case test', { topics: ['MyTopic', 'UPPER'] })
      expect(mem.topics).toContain('mytopic')
      expect(mem.topics).toContain('upper')
    })

    it('assigns monotonically increasing ids', async () => {
      const a = await store.remember('First')
      const b = await store.remember('Second')
      expect(b.id).toBeGreaterThan(a.id)
    })
  })

  // ── recall ────────────────────────────────────────────────────────────────

  describe('recall', () => {
    it('returns memories stored under a topic', async () => {
      await store.remember('TypeScript is awesome', { topics: ['typescript'] })
      const results = await store.recall('typescript')
      expect(results.length).toBe(1)
      expect(results[0].content).toBe('TypeScript is awesome')
    })

    it('returns empty array for an unknown topic', async () => {
      const results = await store.recall('nonexistent-xyz-9999')
      expect(results).toEqual([])
    })

    it('is case-insensitive for the query', async () => {
      await store.remember('Case insensitive test', { topics: ['MyTopic'] })
      const results = await store.recall('MYTOPIC')
      expect(results.length).toBe(1)
    })

    it('respects the limit option', async () => {
      for (let i = 0; i < 5; i++) {
        await store.remember(`Memory ${i}`, { topics: ['paged'] })
      }
      const results = await store.recall('paged', { limit: 2 })
      expect(results.length).toBeLessThanOrEqual(2)
    })

    it('does not return a memory after it has been forgotten', async () => {
      const mem = await store.remember('Forget me', { topics: ['temp'] })
      await store.forget(mem.id)
      const results = await store.recall('temp')
      expect(results).toEqual([])
    })
  })

  // ── search ────────────────────────────────────────────────────────────────

  describe('search', () => {
    it('finds a memory by full-text match', async () => {
      await store.remember('The quick brown fox jumps over the lazy dog')
      const results = await store.search('quick fox')
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].content).toContain('fox')
    })

    it('returns empty array when there are no matches', async () => {
      await store.remember('Completely unrelated prose here')
      const results = await store.search('zzzyyyxxx')
      expect(results).toEqual([])
    })

    it('respects the limit option', async () => {
      for (let i = 0; i < 5; i++) {
        await store.remember(`Searchable item number ${i}`)
      }
      const results = await store.search('Searchable', { limit: 2 })
      expect(results.length).toBeLessThanOrEqual(2)
    })

    it('returns results with expected shape', async () => {
      await store.remember('Shape test memory')
      const results = await store.search('Shape')
      expect(results[0]).toMatchObject({
        id: expect.any(Number),
        content: expect.any(String),
        topics: expect.any(Array),
        created_at: expect.any(String),
      })
    })
  })

  // ── forget ────────────────────────────────────────────────────────────────

  describe('forget', () => {
    it('returns true and removes the memory', async () => {
      const mem = await store.remember('Delete me')
      expect(await store.forget(mem.id)).toBe(true)
      const listed = await store.list()
      expect(listed.find(m => m.id === mem.id)).toBeUndefined()
    })

    it('returns false for a non-existent id', async () => {
      expect(await store.forget(99999)).toBe(false)
    })

    it('removes the memory from the topic index', async () => {
      const mem = await store.remember('Topic-indexed entry', { topics: ['tobedeleted'] })
      await store.forget(mem.id)
      expect(await store.recall('tobedeleted')).toEqual([])
    })

    it('removes the memory from FTS so search no longer finds it', async () => {
      const mem = await store.remember('Unique phrase xylaphone')
      await store.forget(mem.id)
      expect(await store.search('xylaphone')).toEqual([])
    })
  })

  // ── list ──────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns empty array when store is empty', async () => {
      expect(await store.list()).toEqual([])
    })

    it('returns all inserted memories', async () => {
      const a = await store.remember('Alpha')
      const b = await store.remember('Beta')
      const listed = await store.list()
      const ids = listed.map(m => m.id)
      expect(ids).toContain(a.id)
      expect(ids).toContain(b.id)
    })

    it('orders results most-recent first', async () => {
      const a = await store.remember('First')
      const c = await store.remember('Third')
      const listed = await store.list()
      const ids = listed.map(m => m.id)
      expect(ids.indexOf(c.id)).toBeLessThan(ids.indexOf(a.id))
    })

    it('respects the limit parameter', async () => {
      for (let i = 0; i < 5; i++) await store.remember(`Item ${i}`)
      const listed = await store.list(3)
      expect(listed.length).toBe(3)
    })

    it('supports offset-based pagination without overlap', async () => {
      for (let i = 0; i < 6; i++) await store.remember(`Page item ${i}`)
      const page1 = await store.list(3, 0)
      const page2 = await store.list(3, 3)
      const ids1 = new Set(page1.map(m => m.id))
      const ids2 = page2.map(m => m.id)
      expect(ids2.every(id => !ids1.has(id))).toBe(true)
    })
  })
})
