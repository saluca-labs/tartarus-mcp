import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { createRequire } from 'module'
import type { Adapter, Memory, MemoryInput, QueryFilter, ScoredMemory } from '../types.js'
import { l2ToCosineSimilarity } from '../hybrid/dedup.js'

export interface SQLiteAdapterOptions {
  /** Path to the SQLite database file. Defaults to ASPHODEL_DB env or ~/.asphodel/memory.db */
  dbPath?: string
  /** Max memories per topic before oldest is evicted. Default: 10 */
  maxMemoriesPerTopic?: number
  /**
   * Embedding dimensions for vector search.
   * Required to enable the memories_vec table (sqlite-vec extension).
   * Must match the dimensions produced by your HybridProvider.
   * Default: 0 (vector search disabled).
   */
  vectorDims?: number
}

/** Raw row shape shared by every memory SELECT in this adapter. */
interface MemoryRow {
  id: number
  content: string
  topics: string
  created_at: string
  recall_count: number       // physical column name kept for pre-0.4 DBs
  importance: number | null
  expires_at: string | null
  persona_id: string | null
  metadata: string | null
  last_accessed: string | null
}

const MEMORY_COLUMNS = (a: string): string =>
  `${a}.id, ${a}.content, ${a}.topics, ${a}.created_at, ${a}.recall_count,
   ${a}.importance, ${a}.expires_at, ${a}.persona_id, ${a}.metadata, ${a}.last_accessed`

export class SQLiteAdapter implements Adapter {
  private db!: Database.Database
  private readonly path: string
  private readonly maxMemoriesPerTopic: number
  private readonly vectorDims: number
  private vecLoaded = false

  constructor(opts: SQLiteAdapterOptions | string = {}) {
    // Accept legacy string argument for backward compat
    if (typeof opts === 'string') {
      opts = { dbPath: opts }
    }
    this.path = opts.dbPath ?? process.env.ASPHODEL_DB ?? join(homedir(), '.asphodel', 'memory.db')
    this.maxMemoriesPerTopic = opts.maxMemoriesPerTopic ?? 10
    this.vectorDims = opts.vectorDims ?? 0
  }

  async init(): Promise<void> {
    if (this.path !== ':memory:') {
      mkdirSync(dirname(this.path), { recursive: true })
    }
    this.db = new Database(this.path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
  }

  private migrate(): void {
    // Migration 001: core schema
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        content    TEXT NOT NULL,
        topics     TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS topic_index (
        word      TEXT NOT NULL,
        memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        PRIMARY KEY (word, memory_id)
      );

      CREATE INDEX IF NOT EXISTS idx_topic_word ON topic_index(word);

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        content=memories,
        content_rowid=id
      );

      CREATE TRIGGER IF NOT EXISTS mem_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS mem_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
      END;
    `)

    // Migration 002: recall_count for access-frequency boost.
    // (Physical column name kept as recall_count so pre-0.4 databases open unchanged;
    //  surfaced through the API as access_count.)
    this.ensureColumn('recall_count', `INTEGER NOT NULL DEFAULT 0`)

    // Migration 003: vector search via sqlite-vec (optional — skipped if not installed
    // or vectorDims is 0)
    if (this.vectorDims > 0) {
      this.vecLoaded = this.tryLoadSqliteVec()
      if (this.vecLoaded) {
        // vec0 uses implicit rowid as the memory ID.
        // We insert with BigInt(memory_id) as rowid so the join
        // "memories m ON m.id = CAST(v.rowid AS INTEGER)" works correctly.
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
            embedding float[${this.vectorDims}]
          );
        `)
      }
    }

    // Migration 004: first-class memory fields — importance, ttl (expires_at),
    // persona scoping, free-form metadata, last-access stamp.
    // All additive with NULL defaults, so pre-0.4 databases open unchanged.
    this.ensureColumn('importance',    `REAL`)
    this.ensureColumn('expires_at',    `TEXT`)
    this.ensureColumn('persona_id',    `TEXT`)
    this.ensureColumn('metadata',      `TEXT`)
    this.ensureColumn('last_accessed', `TEXT`)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_persona ON memories(persona_id);
      CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at);
    `)
  }

  /** Add a column to memories if it does not exist yet (additive migration). */
  private ensureColumn(name: string, ddl: string): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(memories)`)
      .all() as Array<{ name: string }>
    if (!cols.some(c => c.name === name)) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${ddl}`)
    }
  }

  /**
   * Attempt to load the sqlite-vec extension.
   * Returns true if loaded successfully, false if not installed.
   */
  private tryLoadSqliteVec(): boolean {
    try {
      // Modified for tartarus-mcp (ESM): upstream used the CommonJS global `require`,
      // which does not exist in an ES module, so the optional extension could never load.
      const require = createRequire(import.meta.url)
      const sqliteVec = require('sqlite-vec') as { load: (db: Database.Database) => void }
      sqliteVec.load(this.db)
      return true
    } catch {
      return false
    }
  }

  // ── Query fragment helpers ──────────────────────────────────────────────────

  /** "not expired" WHERE fragment. Push nowIso onto params. */
  private liveClause(alias: string, params: unknown[]): string {
    params.push(new Date().toISOString())
    return `(${alias}.expires_at IS NULL OR ${alias}.expires_at > ?)`
  }

  /** Persona-filter WHERE fragment ('' when unfiltered). Pushes params as needed. */
  private personaClause(alias: string, filter: QueryFilter | undefined, params: unknown[]): string {
    if (!filter || filter.personaId === undefined) return ''
    if (filter.personaId === null) return ` AND ${alias}.persona_id IS NULL`
    params.push(filter.personaId)
    return ` AND ${alias}.persona_id = ?`
  }

  private rowToMemory(r: MemoryRow): Memory {
    return {
      id:            r.id,
      content:       r.content,
      topics:        JSON.parse(r.topics) as string[],
      created_at:    r.created_at,
      importance:    r.importance ?? 0.5,
      access_count:  r.recall_count ?? 0,
      expires_at:    r.expires_at ?? null,
      persona_id:    r.persona_id ?? null,
      metadata:      r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
      last_accessed: r.last_accessed ?? null,
    }
  }

  // ── Writes ──────────────────────────────────────────────────────────────────

  async insert(content: string, topics: string[], extras: MemoryInput = {}): Promise<number> {
    const now = new Date().toISOString()

    const { lastInsertRowid } = this.db
      .prepare(`
        INSERT INTO memories (content, topics, created_at, importance, expires_at, persona_id, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        content,
        JSON.stringify(topics),
        now,
        extras.importance ?? null,
        extras.expiresAt ?? null,
        extras.personaId ?? null,
        extras.metadata != null ? JSON.stringify(extras.metadata) : null,
      )

    const id = Number(lastInsertRowid)

    const insertIndex = this.db.prepare(
      `INSERT OR IGNORE INTO topic_index (word, memory_id) VALUES (?, ?)`
    )
    const countForWord = this.db.prepare(
      `SELECT COUNT(*) as n FROM topic_index WHERE word = ?`
    )
    const deleteOldest = this.db.prepare(`
      DELETE FROM topic_index
      WHERE word = ? AND memory_id = (
        SELECT ti.memory_id FROM topic_index ti
        JOIN memories m ON m.id = ti.memory_id
        WHERE ti.word = ?
        ORDER BY m.created_at ASC
        LIMIT 1
      )
    `)

    for (const word of topics) {
      const { n } = countForWord.get(word) as { n: number }
      if (n >= this.maxMemoriesPerTopic) {
        deleteOldest.run(word, word)
      }
      insertIndex.run(word, id)
    }

    return id
  }

  // ── Reads ───────────────────────────────────────────────────────────────────

  async recall(topic: string, limit: number, filter?: QueryFilter): Promise<Memory[]> {
    const params: unknown[] = [topic.toLowerCase().trim()]
    const live    = this.liveClause('m', params)
    const persona = this.personaClause('m', filter, params)
    params.push(limit)

    const rows = this.db.prepare(`
      SELECT ${MEMORY_COLUMNS('m')}
      FROM memories m
      JOIN topic_index ti ON ti.memory_id = m.id
      WHERE ti.word = ? AND ${live}${persona}
      ORDER BY m.id DESC
      LIMIT ?
    `).all(...params) as MemoryRow[]

    return rows.map(r => this.rowToMemory(r))
  }

  async search(query: string, limit: number, filter?: QueryFilter): Promise<Memory[]> {
    const params: unknown[] = [query]
    const live    = this.liveClause('m', params)
    const persona = this.personaClause('m', filter, params)
    params.push(limit)

    const rows = this.db.prepare(`
      SELECT ${MEMORY_COLUMNS('m')}
      FROM memories_fts f
      JOIN memories m ON m.id = f.rowid
      WHERE memories_fts MATCH ? AND ${live}${persona}
      ORDER BY rank
      LIMIT ?
    `).all(...params) as MemoryRow[]

    return rows.map(r => this.rowToMemory(r))
  }

  /** Exact-content lookup used by remember() for deterministic deduplication. */
  async findByContent(content: string, filter?: QueryFilter): Promise<Memory | null> {
    const params: unknown[] = [content]
    const live    = this.liveClause('m', params)
    const persona = this.personaClause('m', filter, params)

    const row = this.db.prepare(`
      SELECT ${MEMORY_COLUMNS('m')}
      FROM memories m
      WHERE m.content = ? AND ${live}${persona}
      ORDER BY m.id DESC
      LIMIT 1
    `).get(...params) as MemoryRow | undefined

    return row ? this.rowToMemory(row) : null
  }

  // ── Hybrid search extensions ───────────────────────────────────────────────

  /**
   * Store an L2-normalized float embedding alongside a memory.
   * Uses sqlite-vec's vec0 virtual table with rowid = memory_id.
   *
   * Note: sqlite-vec alpha (0.1.x) requires the rowid to be passed as BigInt —
   * regular JS numbers are sent as float64 by better-sqlite3 and rejected.
   * Embeddings are serialized as JSON arrays and deserialized by vec_f32().
   */
  async vectorInsert(id: number, embedding: number[]): Promise<void> {
    if (!this.vecLoaded) return
    this.db
      .prepare(`INSERT OR REPLACE INTO memories_vec(rowid, embedding) VALUES (?, vec_f32(?))`)
      .run(BigInt(id), JSON.stringify(embedding))
  }

  /**
   * K-nearest-neighbor search using sqlite-vec.
   * Embeddings must be L2-normalized before calling; scores are approximate
   * cosine similarities derived from L2 distance (1 - d²/2 on unit vectors).
   * Expired memories are excluded; the persona filter applies post-KNN, so the
   * returned count can be below the requested limit.
   */
  async vectorSearch(embedding: number[], limit: number, filter?: QueryFilter): Promise<ScoredMemory[]> {
    if (!this.vecLoaded) return []

    const params: unknown[] = [JSON.stringify(embedding), limit]
    const live    = this.liveClause('m', params)
    const persona = this.personaClause('m', filter, params)

    const rows = this.db.prepare(`
      SELECT ${MEMORY_COLUMNS('m')}, v.distance
      FROM memories_vec v
      JOIN memories m ON m.id = CAST(v.rowid AS INTEGER)
      WHERE v.embedding MATCH vec_f32(?)
        AND k = ?
        AND ${live}${persona}
      ORDER BY v.distance
    `).all(...params) as Array<MemoryRow & { distance: number }>

    return rows.map(r => ({
      ...this.rowToMemory(r),
      recall_count: r.recall_count ?? 0,
      score:        l2ToCosineSimilarity(r.distance),
    }))
  }

  /** Increment access_count (and stamp last_accessed) for a list of memory IDs. */
  async bumpRecallCount(ids: number[]): Promise<void> {
    if (ids.length === 0) return
    const now = new Date().toISOString()
    const stmt = this.db.prepare(
      `UPDATE memories SET recall_count = recall_count + 1, last_accessed = ? WHERE id = ?`
    )
    const updateAll = this.db.transaction((ids: number[]) => {
      for (const id of ids) stmt.run(now, id)
    })
    updateAll(ids)
  }

  // ── Standard operations ────────────────────────────────────────────────────

  async forget(id: number): Promise<boolean> {
    const { changes } = this.db
      .prepare(`DELETE FROM memories WHERE id = ?`)
      .run(id)
    if (changes > 0 && this.vecLoaded) {
      this.db.prepare(`DELETE FROM memories_vec WHERE rowid = ?`).run(BigInt(id))
    }
    return changes > 0
  }

  /** Delete expired memories (expires_at at or before nowIso). Returns count deleted. */
  async reap(nowIso: string): Promise<number> {
    if (this.vecLoaded) {
      this.db.prepare(`
        DELETE FROM memories_vec WHERE rowid IN (
          SELECT id FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?
        )
      `).run(nowIso)
    }
    const { changes } = this.db
      .prepare(`DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?`)
      .run(nowIso)
    return changes
  }

  async list(limit: number, offset: number, filter?: QueryFilter): Promise<Memory[]> {
    const params: unknown[] = []
    const live    = this.liveClause('m', params)
    const persona = this.personaClause('m', filter, params)
    params.push(limit, offset)

    const rows = this.db.prepare(`
      SELECT ${MEMORY_COLUMNS('m')}
      FROM memories m
      WHERE ${live}${persona}
      ORDER BY m.id DESC
      LIMIT ? OFFSET ?
    `).all(...params) as MemoryRow[]

    return rows.map(r => this.rowToMemory(r))
  }

  async close(): Promise<void> {
    this.db.close()
  }
}
