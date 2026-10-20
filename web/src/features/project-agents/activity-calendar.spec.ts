import { describe, expect, it } from 'vitest'
import type { ProjectAgentActivityDay } from '@/types'
import { activityWeeks } from './activity-calendar'

function range(from: string, count: number): ProjectAgentActivityDay[] {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(`${from}T00:00:00Z`)
    date.setUTCDate(date.getUTCDate() + index)
    return { date: date.toISOString().slice(0, 10), completed: 0, failed: 0, cancelled: 0, total: 0, tasks: [] }
  })
}

describe('activityWeeks', () => {
  it('lays days out oldest first in Monday-to-Sunday weeks, whatever order they come in', () => {
    // 2026-10-01 is a Thursday.
    const weeks = activityWeeks(range('2026-10-01', 10).reverse())
    expect(weeks).toHaveLength(2)
    expect(weeks[0]!.days.slice(0, 3)).toEqual([null, null, null])
    expect(weeks[0]!.days[3]!.date).toBe('2026-10-01')
    expect(weeks[1]!.days[0]!.date).toBe('2026-10-05')
    expect(weeks[1]!.days.slice(-1)).toEqual([null])
  })

  it('labels the week each month starts in, dropping a label too close to the next one', () => {
    // 2026-09-28 (Monday) to 2026-11-29: September's two days sit right before October.
    const months = activityWeeks(range('2026-09-28', 63)).map(({ month }) => month).filter(Boolean)
    expect(months).toEqual(['2026-10', '2026-11'])
  })

  it('has no weeks without days', () => {
    expect(activityWeeks([])).toEqual([])
  })
})
