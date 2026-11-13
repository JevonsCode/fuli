import { z } from 'zod'
import { getJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import type { StatementWeek } from '@/features/today/statement'
import { currentLocale, t } from '@/i18n'

// 复利账单, day by day: GET /api/statement/days for the last 53 weeks, drawn
// like a contribution calendar. A day is a calendar date (YYYY-MM-DD) of the
// person's UTC offset now; the range is sent with that one offset, so the
// server cuts days at the same midnights the grid shows.
export const CALENDAR_WEEKS = 53
export const MEASURES = ['learned', 'confirmed', 'carried', 'used'] as const
export type Measure = typeof MEASURES[number]
// Darkest step; 0 is a day with nothing.
const TOP_LEVEL = 4

const count = z.number().nullish()
const daysSchema = z.looseObject({
  days: z.array(z.looseObject({ day: z.string(), learned: count, confirmed: count, carried: count, used: count })),
  unavailable: z.array(z.string()).nullish(),
})
export type StatementDays = z.infer<typeof daysSchema>
export type StatementDay = StatementDays['days'][number]

/** A day key's calendar date, computed in UTC so no daylight-saving shift can move it. */
const dateOf = (day: string) => new Date(`${day}T00:00:00Z`)
const keyOf = (date: Date) => date.toISOString().slice(0, 10)
/** The day `days` after (or before) a day key. */
export function addDays(day: string, days: number) {
  const date = dateOf(day)
  date.setUTCDate(date.getUTCDate() + days)
  return keyOf(date)
}
/** The Monday of the week a day key falls in: the statement's weeks start on Monday. */
export function mondayOf(day: string) {
  return addDays(day, -((dateOf(day).getUTCDay() + 6) % 7))
}
/** The person's local date now, as a day key. */
export function localToday(now: Date) {
  return keyOf(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())))
}
export const isDayKey = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && keyOf(dateOf(value)) === value

/** The calendar's range, Monday 53 weeks back to the Monday after this week, as instants with the offset `now` has. */
export function calendarRange(now: Date) {
  const offset = -now.getTimezoneOffset()
  const zone = `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  const thisMonday = mondayOf(localToday(now))
  return { from: `${addDays(thisMonday, -7 * (CALENDAR_WEEKS - 1))}T00:00:00${zone}`, to: `${addDays(thisMonday, 7)}T00:00:00${zone}` }
}
const pad = (value: number) => String(value).padStart(2, '0')

/** The days that have anything, or null when the server cannot give them. */
export async function readStatementDays(now: Date, signal?: AbortSignal): Promise<StatementDays | null> {
  try {
    return await getJson(`/api/statement/days?${new URLSearchParams(calendarRange(now))}`, shapeOf(daysSchema), { signal })
  } catch {
    return null
  }
}

/** The local week that starts on a Monday day key, as the weekly statement reads it. */
export function statementWeekOf(monday: string): StatementWeek {
  const [year, month, day] = monday.split('-').map(Number)
  return { from: new Date(year, month - 1, day).toISOString(), to: new Date(year, month - 1, day + 7).toISOString() }
}

export interface CalendarCell { day: string; weekday: number }
export interface CalendarWeek { monday: string; days: Array<CalendarCell | null> }
export interface MonthLabel { week: number; label: string }

/** Weeks as columns, oldest first, Monday on top; days after today are holes. */
export function calendarWeeks(today: string, weeks = CALENDAR_WEEKS): CalendarWeek[] {
  const first = addDays(mondayOf(today), -7 * (weeks - 1))
  return Array.from({ length: weeks }, (_, column) => {
    const monday = addDays(first, 7 * column)
    return { monday, days: Array.from({ length: 7 }, (_, weekday) => {
      const day = addDays(monday, weekday)
      return day > today ? null : { day, weekday }
    }) }
  })
}

/** A month's short name over the first week whose Monday falls in it; a month cut off at the left edge is not named. */
export function monthLabels(weeks: CalendarWeek[]): MonthLabel[] {
  const format = new Intl.DateTimeFormat(currentLocale(), { month: 'short', timeZone: 'UTC' })
  return weeks.flatMap(({ monday }, week) => (dateOf(monday).getUTCDate() <= 7 ? [{ week, label: format.format(dateOf(monday)) }] : []))
}

/** The rows' names, Monday first; the side hint shows only Monday, Wednesday and Friday, as in a contribution calendar. */
export function weekdayHints() {
  const short = new Intl.DateTimeFormat(currentLocale(), { weekday: 'short', timeZone: 'UTC' })
  const long = new Intl.DateTimeFormat(currentLocale(), { weekday: 'long', timeZone: 'UTC' })
  // 2024-01-01 was a Monday.
  return Array.from({ length: 7 }, (_, weekday) => {
    const date = dateOf(addDays('2024-01-01', weekday))
    return { hint: weekday % 2 === 0 && weekday < 6 ? short.format(date) : '', name: long.format(date) }
  })
}

/** A measure's value on a day; a measure the server could not read is null. */
export function measureOf(entry: StatementDay | undefined, measure: Measure): number {
  const value = entry?.[measure]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Five steps, 0 for a day with nothing. The steps follow the spread of the
 * days that have something (their quartiles), so one outlier gets the darkest
 * step without pushing every other day into the palest.
 */
export function intensityLevels(values: readonly number[]): (value: number) => number {
  const present = values.filter(value => value > 0).sort((left, right) => left - right)
  if (!present.length) return () => 0
  const top = present.at(-1)!
  const cuts = [0.25, 0.5, 0.75].map(share => present[Math.max(0, Math.ceil(share * present.length) - 1)])
  return value => {
    if (value <= 0) return 0
    if (value >= top) return TOP_LEVEL
    return Math.min(TOP_LEVEL - 1, 1 + cuts.filter(cut => value > cut).length)
  }
}

/** A day's date as people read it: 「11月12日」, "Nov 12". */
export function dayLabel(day: string) {
  return new Intl.DateTimeFormat(currentLocale(), { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(dateOf(day))
}

/** The cell's name and tooltip: 「11月12日：新学到 3 条」. */
export function cellLabel(day: string, measure: Measure, value: number) {
  return t('statementCalendar.cell', { date: dayLabel(day), text: t(`statementCalendar.measures.${measure}.count`, { count: value }) })
}
