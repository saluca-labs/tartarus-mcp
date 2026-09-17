import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ProfileStore, mergeProfile } from '../src/profile.js'

describe('mergeProfile', () => {
  it('merges objects recursively, keeping siblings', () => {
    const base = { user: { name: 'Ada', city: 'London' }, tone: 'terse' }
    expect(mergeProfile(base, { user: { city: 'Cambridge' } })).toEqual({
      user: { name: 'Ada', city: 'Cambridge' },
      tone: 'terse',
    })
  })

  it('deletes a key when the patch value is null', () => {
    expect(mergeProfile({ a: 1, b: 2 }, { b: null })).toEqual({ a: 1 })
  })

  it('REPLACES arrays rather than concatenating or merging positionally', () => {
    // Deliberate: a caller writing ['x'] means the list is now ['x']. Positional merge would
    // turn ['a','b'] + ['x'] into ['x','b'], which nobody has ever wanted.
    expect(mergeProfile({ langs: ['ts', 'py'] }, { langs: ['go'] })).toEqual({ langs: ['go'] })
  })

  it('does not mutate its inputs', () => {
    const base = { user: { name: 'Ada' } }
    const patch = { user: { name: 'Grace' } }
    mergeProfile(base, patch)
    expect(base).toEqual({ user: { name: 'Ada' } })
    expect(patch).toEqual({ user: { name: 'Grace' } })
  })

  it('replaces a scalar with an object and an object with a scalar', () => {
    expect(mergeProfile({ x: 1 }, { x: { deep: true } })).toEqual({ x: { deep: true } })
    expect(mergeProfile({ x: { deep: true } }, { x: 1 })).toEqual({ x: 1 })
  })
})

describe('ProfileStore', () => {
  let dir: string
  let store: ProfileStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tartarus-profile-'))
    store = new ProfileStore(join(dir, 'memory.db'))
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('STARTS EMPTY on a fresh install', () => {
    const r = store.get()
    expect(r.profile).toEqual({})
    expect(r.revision).toBe(0)
    expect(r.updated_at).toBeNull()
  })

  it('persists an update and bumps the revision', () => {
    store.update({ user: { name: 'Ada' } })
    const r = store.get()
    expect(r.profile).toEqual({ user: { name: 'Ada' } })
    expect(r.revision).toBe(1)
    expect(r.updated_at).not.toBeNull()
  })

  it('merges across updates instead of clobbering', () => {
    store.update({ user: { name: 'Ada' }, tone: 'terse' })
    store.update({ user: { role: 'engineer' } })
    expect(store.get().profile).toEqual({
      user: { name: 'Ada', role: 'engineer' },
      tone: 'terse',
    })
  })

  it('replaces the whole document when asked', () => {
    store.update({ a: 1, b: 2 })
    store.update({ c: 3 }, { replace: true })
    expect(store.get().profile).toEqual({ c: 3 })
    expect(store.get().revision).toBe(2)
  })

  it('survives reopening the database', () => {
    store.update({ kept: true })
    store.close()
    store = new ProfileStore(join(dir, 'memory.db'))
    expect(store.get().profile).toEqual({ kept: true })
    expect(store.get().revision).toBe(1)
  })

  it('cannot hold two profiles', () => {
    // The CHECK(id = 1) is the guard; without it "the profile" becomes a question.
    store.update({ a: 1 })
    store.update({ b: 2 })
    expect(store.get().profile).toEqual({ a: 1, b: 2 })
  })
})
