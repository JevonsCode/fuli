import { describe, expect, it } from 'vitest'
import { formatElapsed } from './elapsed-time'

const now = Date.parse('2026-10-17T12:00:00Z')

describe('formatElapsed', () => {
  it('uses one whole unit from the recorded start', () => {
    expect(formatElapsed('2026-10-17T11:35:00Z', 'en', now)).toBe('25 minutes')
    expect(formatElapsed('2026-10-17T11:59:40Z', 'en', now)).toBe('1 minute')
    expect(formatElapsed('2026-10-17T09:10:00Z', 'en', now)).toBe('2 hours')
    expect(formatElapsed('2026-10-14T12:00:00Z', 'en', now)).toBe('3 days')
    expect(formatElapsed('2026-10-17T11:35:00Z', 'zh-CN', now)).toBe('25分钟')
  })

  it('keeps unknown and future starts unknown', () => {
    expect(formatElapsed(null, 'en', now)).toBeNull()
    expect(formatElapsed('not a time', 'en', now)).toBeNull()
    expect(formatElapsed('2026-10-17T12:05:00Z', 'en', now)).toBeNull()
  })
})
