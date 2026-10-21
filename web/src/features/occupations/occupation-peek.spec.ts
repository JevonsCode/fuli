import { describe, expect, it } from 'vitest'
import type { OccupationEntry } from './occupation-catalog'
import { occupationPeekState } from './occupation-peek'

const lead = { key: 'lead', name_zh: '负责人' } as OccupationEntry
const base = { item: { spaceId: 'space-a', id: 'lead' }, spaceId: 'space-a', entries: [lead], loaded: true, loading: false, error: '' }

describe('occupationPeekState', () => {
  it('finds the occupation by its exact key in this space', () => {
    expect(occupationPeekState(base)).toEqual({ kind: 'ready', entry: lead })
    expect(occupationPeekState({ ...base, item: { spaceId: 'space-a', id: 'Lead' } })).toEqual({ kind: 'missing' })
  })

  it('never calls a key missing from a pending or failed read', () => {
    const unread = { ...base, entries: [], loaded: false }
    expect(occupationPeekState({ ...unread, loading: true })).toEqual({ kind: 'loading' })
    expect(occupationPeekState({ ...unread, error: 'HTTP 500' })).toEqual({ kind: 'error', message: 'HTTP 500' })
    expect(occupationPeekState(unread)).toEqual({ kind: 'loading' })
    expect(occupationPeekState({ ...base, spaceId: '' })).toEqual({ kind: 'loading' })
  })

  it('says missing only after this space was read in full, or for another space', () => {
    expect(occupationPeekState({ ...base, entries: [] })).toEqual({ kind: 'missing' })
    expect(occupationPeekState({ ...base, item: { spaceId: 'space-b', id: 'lead' } })).toEqual({ kind: 'missing' })
    // A failed refresh keeps the occupation already read.
    expect(occupationPeekState({ ...base, error: 'HTTP 500' })).toEqual({ kind: 'ready', entry: lead })
  })
})
