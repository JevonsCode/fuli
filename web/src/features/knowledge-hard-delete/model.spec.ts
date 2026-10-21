import { describe, expect, it } from 'vitest'

import { ApiError } from '@/api/client'
import { confirmationMatches, hardDeletedFrom, ledgerDamage, recordCounts, refusedByGraph, stalePreview, type HardDeleteCounts } from './model'

const zero = { items: 0, versions: 0, relationships: 0, episodes: 0, kept_episodes: 0, dependents: 0, mentions: 0,
  revisions: 0, feedback: 0, usage: 0, change_audits: 0, tags: 0, assignments: 0, references: 0, review_decisions: 0,
  conflicts: 0, promotions: 0, decision_snapshots: 0 } satisfies HardDeleteCounts

describe('hard delete model (rec#5 C9)', () => {
  it('confirms with 删除, delete or the exact title, never with anything else', () => {
    const preview = { title: 'Deploy with a synthetic key' }
    expect(confirmationMatches(preview, ' 删除 ')).toBe(true)
    expect(confirmationMatches(preview, 'delete')).toBe(true)
    expect(confirmationMatches(preview, 'Deploy with a synthetic key')).toBe(true)
    for (const typed of ['', '  ', 'ok', 'Delete', 'Deploy']) expect(confirmationMatches(preview, typed)).toBe(false)
  })

  it('lists only the record counts that are not zero, in a stable order', () => {
    expect(recordCounts({ ...zero, usage: 2, mentions: 3, tags: 1 })).toEqual([
      { key: 'mentions', count: 3 }, { key: 'usage', count: 2 }, { key: 'tags', count: 1 }])
    expect(recordCounts(zero)).toEqual([])
  })

  it('reads a 410 as permanently deleted with its time, and a 409 stale preview apart from other conflicts', () => {
    const gone = new ApiError('gone', 410, JSON.stringify({ code: 'hard_deleted', deletedAt: '2026-10-22T01:02:03Z' }))
    expect(hardDeletedFrom(gone)).toEqual({ outcome: 'gone', deletedAt: '2026-10-22T01:02:03Z' })
    expect(hardDeletedFrom(new ApiError('missing', 404, '{"error":"not found"}'))).toBeNull()
    expect(hardDeletedFrom(new Error('offline'))).toBeNull()
    expect(stalePreview(new ApiError('stale', 409, JSON.stringify({ code: 'hard_delete_preview_stale' })))).toBe(true)
    expect(stalePreview(new ApiError('other', 409, JSON.stringify({ code: 'stale_version' })))).toBe(false)
    // Only a 4xx with the graph's code proves nothing was deleted.
    expect(refusedByGraph(new ApiError('refused', 422, JSON.stringify({ code: 'hard_delete_unconfirmed' })))).toBe(true)
    expect(refusedByGraph(new ApiError('down', 503, JSON.stringify({ code: 'provider_http_5xx' })))).toBe(false)
    expect(refusedByGraph(new ApiError('odd', 400, 'plain text'))).toBe(false)
    expect(refusedByGraph(new TypeError('Failed to fetch'))).toBe(false)
    expect(ledgerDamage(new ApiError('unavailable', 503, JSON.stringify({ code: 'data_format_damaged', error: 'repair it' })))).toBe('repair it')
    expect(ledgerDamage(new ApiError('unavailable', 503, JSON.stringify({ code: 'provider_http_5xx', error: 'x' })))).toBeNull()
  })
})
