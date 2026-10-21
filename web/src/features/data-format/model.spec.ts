import { describe, expect, it } from 'vitest'

import { ApiError } from '@/api/client'
import { moreRecords, refusalCode, refusalMessage, sampleChips, shortDigest } from './model'

const step = (sampleIds: string[], count = sampleIds.length) => ({ id: 's/2-x', summary: 'x', kind: 'backfill',
  fromVersion: 1, toVersion: 2, count, sampleIds })

describe('data format model', () => {
  it('shortens sample IDs to a unique prefix and keeps the full ID', () => {
    const chips = sampleChips(step(['short', 'schedule-alpha-0001#1', 'task-bravo-0002#2']))
    expect(chips[0]).toEqual({ id: 'short', text: 'short', cut: false })
    expect(chips.slice(1).every(chip => chip.cut && chip.id.startsWith(chip.text))).toBe(true)
    expect(new Set(chips.map(chip => chip.text)).size).toBe(3)
    expect(moreRecords(step(['a', 'b'], 12))).toBe(10)
    expect(shortDigest('0123456789abcdef')).toBe('0123456789ab')
  })

  it('reads the code and message of a refused confirmation', () => {
    const stale = new ApiError('x', 409, JSON.stringify({ code: 'data_format_stale_preview', error: 'changed since' }))
    expect(refusalCode(stale)).toBe('data_format_stale_preview')
    expect(refusalMessage(stale)).toBe('changed since')
    expect(refusalCode(new ApiError('x', 503, '{}'))).toBeNull()
    expect(refusalMessage(new Error('offline'))).toBe('offline')
  })
})
