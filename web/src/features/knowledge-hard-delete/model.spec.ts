import { describe, expect, it } from 'vitest'

import { ApiError } from '@/api/client'
import { deletionExport, hardDeletedFrom, ledgerDamage, recordCounts, refusedByGraph, stalePreview, type HardDeleteCounts,
  type HardDeletePreview } from './model'

const zero = { items: 0, versions: 0, relationships: 0, episodes: 0, kept_episodes: 0, dependents: 0, mentions: 0,
  revisions: 0, feedback: 0, usage: 0, change_audits: 0, tags: 0, assignments: 0, references: 0, review_decisions: 0,
  conflicts: 0, promotions: 0, decision_snapshots: 0 } satisfies HardDeleteCounts

describe('hard delete model (rec#5 C9)', () => {
  it('exports what the dialog listed, without the preview id, under a safe dated name (D-88)', () => {
    const preview = { preview_id: 'p-1', item_kind: 'entity', item_id: 'syn-1', title: 'Deploy: with a/synthetic key',
      items: [{ item_kind: 'entity', item_id: 'syn-1', role: 'item', title: 'Deploy', content: 'Use the staging key', status: 'current' }],
      removed_episodes: [{ episode_id: 'ep-1', excerpt: 'User: use the staging key', other_items: 0 }],
      kept_episodes: [], dependents: [], counts: zero } as unknown as HardDeletePreview
    const { filename, json } = deletionExport(preview, 'space-1', new Date('2026-11-01T03:04:05Z'))
    expect(filename).toBe('fuli-deleted-Deploy-with-a-synthetic-key-20261101-030405.json')
    const value = JSON.parse(json)
    expect(value).toMatchObject({ format: 'fuli-deleted-knowledge', version: 1, personal_space_id: 'space-1',
      source_text: 'excerpts', item_id: 'syn-1', items: preview.items, removed_episodes: preview.removed_episodes })
    expect(value).not.toHaveProperty('preview_id')
    expect(deletionExport({ ...preview, title: '  ' }, 's', new Date(0)).filename).toBe('fuli-deleted-entity-19700101-000000.json')
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
