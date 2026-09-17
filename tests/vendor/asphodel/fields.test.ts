import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Asphodel } from '../../../src/vendor/asphodel/store.js'
import { SQLiteAdapter } from '../../../src/vendor/asphodel/adapters/sqlite.js'

describe('First-class memory fields (SQLite adapter)', () => {
  let store: Asphodel

  beforeEach(async () => {
    store = new Asphodel(new SQLiteAdapter({ dbPath: ':memory:' }))
    await store.init()
  })

  afterEach(async () => {
    await store.close()
    vi.useRealTimers()
  })

  // ── importance ─────────────────────────────────────────────────────────────

  describe('importance', () => {
    it('defaults to the neutral 0.5 when unset', async () => {
      const mem = await store.remember('No importance given')
      expect(mem.importance).toBe(0.5)
      const [listed] = await store.list()
      expect(listed.importance).toBe(0.5)
    })

    it('persists and round-trips through recall', async () => {
      await store.remember('Critical fact', { topics: ['critical'], importance: 0.9 })
      const [mem] = await store.recall('critical')
      expect(mem.importance).toBe(0.9)
    })

    it('is clamped to [0, 1]', async () => {
      const high = await store.remember('Too high', { importance: 7 })
      const low  = await store.remember('Too low', { importance: -3 })
      expect(high.importance).toBe(1)
      expect(low.importance).toBe(0)
    })

    it('boosts ranking in hybridSearch (BM25 fallback path)', async () => {
      // Same textual relevance, different importance — the boost must reorder.
      await store.remember('shared token alpha variant one', { importance: 0.1 })
      await store.remember('shared token alpha variant two', { importance: 1.0 })
      const results = await store.hybridSearch('shared token alpha')
      expect(results.length).toBe(2)
      expect(results[0].importance).toBe(1.0)
      expect(results[0].score).toBeGreaterThan(results[1].score)
    })
  })

  // ── access_count ───────────────────────────────────────────────────────────

  describe('access_count', () => {
    it('starts at 0 and increments on each recall hit', async () => {
      await store.remember('Counted memory', { topics: ['counted'] })
      const [before] = await store.list()
      expect(before.access_count).toBe(0)

      await store.recall('counted')
      await store.recall('counted')
      const [after] = await store.list()
      expect(after.access_count).toBe(2)
    })

    it('increments on search hits', async () => {
      await store.remember('Searchable zanzibar entry')
      await store.search('zanzibar')
      const [after] = await store.list()
      expect(after.access_count).toBe(1)
    })

    it('does not increment on list()', async () => {
      await store.remember('Listed only')
      await store.list()
      await store.list()
      const [mem] = await store.list()
      expect(mem.access_count).toBe(0)
    })

    it('stamps last_accessed on a hit', async () => {
      await store.remember('Stamped memory', { topics: ['stamped'] })
      const [before] = await store.list()
      expect(before.last_accessed).toBeNull()

      await store.recall('stamped')
      const [after] = await store.list()
      expect(after.last_accessed).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('increments on hybridSearch hits (unified accounting)', async () => {
      await store.remember('Hybrid counted quokka')
      await store.hybridSearch('quokka')
      const [after] = await store.list()
      expect(after.access_count).toBe(1)
    })
  })

  // ── ttl / expiry ───────────────────────────────────────────────────────────

  describe('ttl', () => {
    it('sets expires_at from ttl seconds', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      const mem = await store.remember('Expiring memory', { ttl: 3600 })
      expect(mem.expires_at).toBe('2026-01-01T01:00:00.000Z')
    })

    it('excludes expired memories from recall, search, and list', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      await store.remember('Ephemeral xylograph note', { topics: ['ephemeral'], ttl: 60 })

      // Still live at +30s
      vi.setSystemTime(new Date('2026-01-01T00:00:30.000Z'))
      expect((await store.recall('ephemeral')).length).toBe(1)

      // Expired at +2min
      vi.setSystemTime(new Date('2026-01-01T00:02:00.000Z'))
      expect(await store.recall('ephemeral')).toEqual([])
      expect(await store.search('xylograph')).toEqual([])
      expect(await store.list()).toEqual([])
    })

    it('memories without ttl never expire', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      await store.remember('Permanent memory', { topics: ['permanent'] })
      vi.setSystemTime(new Date('2036-01-01T00:00:00.000Z'))
      expect((await store.recall('permanent')).length).toBe(1)
    })

    it('reap() deletes expired memories and returns the count', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      await store.remember('Reap me one', { ttl: 10 })
      await store.remember('Reap me two', { ttl: 20 })
      await store.remember('Keep me')

      vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'))
      expect(await store.reap()).toBe(2)
      expect(await store.reap()).toBe(0) // idempotent

      vi.useRealTimers()
      const remaining = await store.list()
      expect(remaining.length).toBe(1)
      expect(remaining[0].content).toBe('Keep me')
    })
  })

  // ── persona_id ─────────────────────────────────────────────────────────────

  describe('persona_id', () => {
    beforeEach(async () => {
      await store.remember('Alfred remembers the manor', { topics: ['manor'], personaId: 'alfred' })
      await store.remember('Oracle remembers the manor', { topics: ['manor'], personaId: 'oracle' })
      await store.remember('Unscoped manor note', { topics: ['manor'] })
    })

    it('round-trips on the returned memory', async () => {
      const mem = await store.remember('Scoped', { personaId: 'alfred' })
      expect(mem.persona_id).toBe('alfred')
    })

    it('no filter returns memories from all scopes', async () => {
      expect((await store.recall('manor')).length).toBe(3)
    })

    it('filters recall to one persona', async () => {
      const results = await store.recall('manor', { personaId: 'alfred' })
      expect(results.length).toBe(1)
      expect(results[0].persona_id).toBe('alfred')
    })

    it('personaId: null filters to unscoped memories only', async () => {
      const results = await store.recall('manor', { personaId: null })
      expect(results.length).toBe(1)
      expect(results[0].persona_id).toBeNull()
    })

    it('filters search and list the same way', async () => {
      expect((await store.search('manor', { personaId: 'oracle' })).length).toBe(1)
      expect((await store.list(20, 0, { personaId: 'oracle' })).length).toBe(1)
      expect((await store.list(20, 0, { personaId: null })).length).toBe(1)
      expect((await store.list()).length).toBe(3)
    })

    it('filters hybridSearch (fallback path)', async () => {
      const results = await store.hybridSearch('manor', { personaId: 'alfred' })
      expect(results.length).toBe(1)
      expect(results[0].persona_id).toBe('alfred')
    })
  })

  // ── metadata ───────────────────────────────────────────────────────────────

  describe('metadata', () => {
    it('round-trips free-form JSON', async () => {
      const metadata = { source: 'unit-test', nested: { a: [1, 2, 3] }, flag: true }
      await store.remember('Memory with metadata', { topics: ['meta'], metadata })
      const [mem] = await store.recall('meta')
      expect(mem.metadata).toEqual(metadata)
    })

    it('defaults to null', async () => {
      const mem = await store.remember('No metadata')
      expect(mem.metadata).toBeNull()
    })
  })

  // ── is_duplicate (exact-content dedup) ─────────────────────────────────────

  describe('deduplication (isDuplicate)', () => {
    it('returns the existing memory with isDuplicate on exact re-remember', async () => {
      const first = await store.remember('The cave is under the manor')
      const dup   = await store.remember('The cave is under the manor')
      expect(dup.isDuplicate).toBe(true)
      expect(dup.id).toBe(first.id)
      expect(first.isDuplicate).toBeUndefined()
      expect((await store.list()).length).toBe(1)
    })

    it('dedup is persona-scoped — same content in another scope is not a duplicate', async () => {
      const a = await store.remember('Shared fact', { personaId: 'alfred' })
      const b = await store.remember('Shared fact', { personaId: 'oracle' })
      const c = await store.remember('Shared fact')
      expect(b.isDuplicate).toBeUndefined()
      expect(c.isDuplicate).toBeUndefined()
      expect(new Set([a.id, b.id, c.id]).size).toBe(3)
    })

    it('skipDedup forces a fresh insert', async () => {
      const first = await store.remember('Duplicate on purpose')
      const dup   = await store.remember('Duplicate on purpose', { skipDedup: true })
      expect(dup.isDuplicate).toBeUndefined()
      expect(dup.id).not.toBe(first.id)
    })

    it('an expired duplicate does not block a re-remember', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      const first = await store.remember('Short-lived fact', { ttl: 10 })
      vi.setSystemTime(new Date('2026-01-01T01:00:00.000Z'))
      const again = await store.remember('Short-lived fact')
      expect(again.isDuplicate).toBeUndefined()
      expect(again.id).not.toBe(first.id)
    })
  })
})

// ── Backward compatibility: pre-0.4 databases ─────────────────────────────────

describe('schema migration (pre-0.4 database)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'asphodel-migrate-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('opens a v0.3 database and surfaces defaults for the new fields', async () => {
    const dbPath = join(dir, 'old.db')

    // Build a database with the exact v0.3 schema (no new columns)
    const raw = new Database(dbPath)
    raw.exec(`
      CREATE TABLE memories (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        content      TEXT NOT NULL,
        topics       TEXT NOT NULL DEFAULT '[]',
        created_at   TEXT NOT NULL,
        recall_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE topic_index (
        word      TEXT NOT NULL,
        memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        PRIMARY KEY (word, memory_id)
      );
      CREATE VIRTUAL TABLE memories_fts USING fts5(content, content=memories, content_rowid=id);
      CREATE TRIGGER mem_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
      END;
      INSERT INTO memories (content, topics, created_at, recall_count)
        VALUES ('Legacy memory', '["legacy"]', '2026-01-01T00:00:00.000Z', 3);
      INSERT INTO topic_index (word, memory_id) VALUES ('legacy', 1);
    `)
    raw.close()

    const store = new Asphodel(new SQLiteAdapter({ dbPath }))
    await store.init()  // runs the additive migration

    const [mem] = await store.recall('legacy')
    expect(mem.content).toBe('Legacy memory')
    expect(mem.importance).toBe(0.5)      // NULL column → neutral default
    expect(mem.access_count).toBe(3)      // legacy recall_count preserved
    expect(mem.expires_at).toBeNull()
    expect(mem.persona_id).toBeNull()
    expect(mem.metadata).toBeNull()

    // And the new fields are writable after migration
    const fresh = await store.remember('Post-migration memory', {
      importance: 0.8, personaId: 'p1', metadata: { ok: true },
    })
    expect(fresh.importance).toBe(0.8)
    await store.close()
  })
})
