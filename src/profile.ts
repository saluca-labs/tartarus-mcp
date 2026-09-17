/**
 * Agent profile - a document the agent starts with EMPTY and fills in over time.
 *
 * Memory answers "what happened". A profile answers "who am I working with, and how do we
 * work" - the standing facts an agent would otherwise re-derive every session, or worse,
 * re-ask about. It is deliberately NOT a memory row: memories accumulate, decay and compete
 * for recall, while a profile is a single small document that should be read in full at the
 * start of a session and updated rarely.
 *
 * WHY A SEPARATE TABLE AND NOT A RESERVED TOPIC. Storing the profile as memories means every
 * recall competes with it, `memory_forget` can delete half an identity by id, and decay can
 * quietly age out a working agreement. One row, one JSON document, no decay.
 *
 * WHY NOT IN THE VENDORED CORE. src/vendor/asphodel is an upstream Apache-2.0 copy carried
 * verbatim so it can be re-vendored. Profile is a tartarus-mcp feature, so it lives here and
 * touches the same SQLite file through its own connection rather than forking the core.
 *
 * MERGE SEMANTICS, stated because they are the part people get wrong:
 *   - objects merge recursively, so updating one field keeps its siblings
 *   - null DELETES a key, which is the only way to remove one
 *   - arrays REPLACE wholesale: merging them positionally is never what a caller means
 *   - `replace: true` swaps the whole document, for a deliberate reset
 */

import Database from 'better-sqlite3'

export interface ProfileResult {
  profile: Record<string, unknown>
  updated_at: string | null
  /** Number of updates applied since the profile was created. 0 means untouched. */
  revision: number
}

type Json = Record<string, unknown>

function isPlainObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Recursive merge. `null` removes a key; arrays and scalars replace; objects merge.
 * Returns a new object - the inputs are not mutated.
 */
export function mergeProfile(base: Json, patch: Json): Json {
  const out: Json = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key]
      continue
    }
    const current = out[key]
    out[key] = isPlainObject(value) && isPlainObject(current)
      ? mergeProfile(current, value)
      : value
  }
  return out
}

export class ProfileStore {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    // Single row, enforced by the CHECK: a profile that can have two rows will eventually
    // have two rows, and then "the profile" is a question rather than a value.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_profile (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        json       TEXT    NOT NULL,
        revision   INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT
      )
    `)
  }

  /** The profile, or an empty object on a fresh install. Never throws on missing. */
  get(): ProfileResult {
    const row = this.db
      .prepare('SELECT json, revision, updated_at FROM agent_profile WHERE id = 1')
      .get() as { json: string; revision: number; updated_at: string | null } | undefined
    if (!row) return { profile: {}, updated_at: null, revision: 0 }
    let parsed: Json = {}
    try {
      parsed = JSON.parse(row.json) as Json
    } catch {
      // A corrupt document must not make the server unusable: report empty, keep the row so
      // a human can inspect it, and let the next update overwrite it.
      return { profile: {}, updated_at: row.updated_at, revision: row.revision }
    }
    return { profile: parsed, updated_at: row.updated_at, revision: row.revision }
  }

  /** Merge a patch (or replace the document) and return the result. */
  update(patch: Json, opts: { replace?: boolean } = {}): ProfileResult {
    const current = this.get()
    const next = opts.replace ? patch : mergeProfile(current.profile, patch)
    const now = new Date().toISOString()
    const revision = current.revision + 1
    this.db
      .prepare(`
        INSERT INTO agent_profile (id, json, revision, updated_at) VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET json = excluded.json,
                                      revision = excluded.revision,
                                      updated_at = excluded.updated_at
      `)
      .run(JSON.stringify(next), revision, now)
    return { profile: next, updated_at: now, revision }
  }

  close(): void {
    this.db.close()
  }
}
