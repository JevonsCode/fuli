import { describe, expect, it } from 'vitest'
import { formatRelativeTime } from './relative-time'

const now = Date.parse('2026-10-17T05:00:00Z')

describe('formatRelativeTime', () => {
  it('keeps missing or invalid instants unknown', () => {
    expect(formatRelativeTime(null, 'en-US', now)).toBeNull()
    expect(formatRelativeTime('not a time', 'en-US', now)).toBeNull()
  })

  it('describes recorded instants in the requested locale', () => {
    expect(formatRelativeTime('2026-10-17T04:55:00Z', 'en-US', now)).toBe('5 minutes ago')
    expect(formatRelativeTime('2026-10-17T02:00:00Z', 'zh-CN', now)).toBe('3小时前')
    expect(formatRelativeTime('2026-10-15T05:00:00Z', 'en-US', now)).toBe('2 days ago')
  })
})
