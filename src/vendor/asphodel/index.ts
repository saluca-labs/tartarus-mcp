// Vendored subset of @saluca/asphodel 0.4.0 (salucallc/asphodel af7ed62), Apache-2.0.
// See ./NOTICE and ./LICENSE. This file is a modified version of upstream src/index.ts:
// it re-exports only the SQLite core that tartarus-mcp uses. The Postgres adapter,
// AsphodelStore and LocalHybridProvider were not vendored.
export { Asphodel } from './store.js'
export { SQLiteAdapter } from './adapters/sqlite.js'
export type { SQLiteAdapterOptions } from './adapters/sqlite.js'
export type {
  Memory,
  ScoredMemory,
  Adapter,
  HybridProvider,
  AsphodelConfig,
  MemoryInput,
  QueryFilter,
  RememberOptions,
  RecallOptions,
  SearchOptions,
  HybridSearchOptions,
  ListOptions,
} from './types.js'
