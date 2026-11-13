import { beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '@/i18n'
import {
  addDays, calendarRange, calendarWeeks, cellLabel, intensityLevels, localToday, mondayOf, monthLabels, statementWeekOf, weekdayHints,
} from './calendar'

beforeEach(() => setLocale('zh-CN', { persist: false }))

describe('the statement calendar grid', () => {
  // A Friday.
  const today = '2026-11-13'

  it('has 53 week columns, oldest first, each starting on a Monday, and no day after today', () => {
    const weeks = calendarWeeks(today)
    expect(weeks).toHaveLength(53)
    expect(weeks.at(-1)!.monday).toBe('2026-11-09')
    expect(weeks[0].monday).toBe(addDays('2026-11-09', -7 * 52))
    for (const week of weeks) expect(new Date(`${week.monday}T00:00:00Z`).getUTCDay()).toBe(1)
    expect(weeks.at(-1)!.days.map(cell => cell?.day ?? null)).toEqual(['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', null, null])
    expect(weeks[3].days.every(Boolean)).toBe(true)
  })

  it('names each month over the first week whose Monday is in it, and leaves out a month cut off at the left', () => {
    const weeks = calendarWeeks(today)
    const labels = monthLabels(weeks)
    // The first column's Monday is 2025-11-10, past the first week of November.
    expect(labels[0]).toEqual({ week: 3, label: '12月' })
    expect(labels.map(label => label.label)).toHaveLength(12)
    expect(labels.at(-1)).toEqual({ week: 51, label: '11月' })
    expect(weeks[51].monday).toBe('2026-11-02')
  })

  it('hints Monday, Wednesday and Friday at the side', () => {
    expect(weekdayHints().map(row => row.hint)).toEqual(['周一', '', '周三', '', '周五', '', ''])
    expect(weekdayHints().map(row => row.name)).toEqual(['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'])
  })

  it('puts a Sunday in the week that began six days before', () => {
    expect(mondayOf('2026-11-15')).toBe('2026-11-09')
    expect(mondayOf('2026-11-09')).toBe('2026-11-09')
  })
})

describe('intensity', () => {
  it('leaves every day pale when nothing happened', () => {
    const level = intensityLevels([0, 0, 0])
    expect([0, 1, 5].map(level)).toEqual([0, 0, 0])
  })

  it('gives one outlier the darkest step without washing out the other days', () => {
    const level = intensityLevels([1, 1, 2, 3, 2, 1, 40])
    expect(level(40)).toBe(4)
    expect(level(1)).toBe(1)
    expect(level(2)).toBe(2)
    expect(level(3)).toBe(3)
    expect(level(0)).toBe(0)
  })

  it('spreads even counts over the four steps, and equal days share the darkest', () => {
    const level = intensityLevels([1, 2, 3, 4])
    expect([1, 2, 3, 4].map(level)).toEqual([1, 2, 3, 4])
    expect(intensityLevels([5, 5, 5])(5)).toBe(4)
  })
})

describe('the range and the names', () => {
  it('sends 53 weeks of local days with the offset the person has now', () => {
    const now = new Date(2026, 10, 13, 10, 0)
    const offset = -now.getTimezoneOffset()
    const zone = `${offset < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`
    expect(localToday(now)).toBe('2026-11-13')
    expect(calendarRange(now)).toEqual({ from: `2025-11-10T00:00:00${zone}`, to: `2026-11-16T00:00:00${zone}` })
  })

  it('reads a week from its Monday as the weekly statement does', () => {
    expect(statementWeekOf('2026-11-09')).toEqual({ from: new Date(2026, 10, 9).toISOString(), to: new Date(2026, 10, 16).toISOString() })
  })

  it('names a cell by its date and number', () => {
    expect(cellLabel('2026-11-12', 'learned', 3)).toBe('11月12日：新学到 3 条')
    setLocale('en-US', { persist: false })
    expect(cellLabel('2026-11-12', 'carried', 2)).toBe('Nov 12: 2 with your habits')
  })
})
