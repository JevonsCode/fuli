import type { ProjectAgentActivityDay } from '@/types'

const DAYS_PER_WEEK = 7
/** Month labels closer than this many weeks would overlap; the earlier one is dropped. */
const MIN_WEEKS_BETWEEN_MONTH_LABELS = 3

export interface ActivityWeek {
  key: string
  /** The month that starts in this week, as `YYYY-MM`, or '' for no label. */
  month: string
  /** Monday to Sunday; null outside the reported range. */
  days: Array<ProjectAgentActivityDay | null>
}

function weekdayFromMonday(date: string) {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + DAYS_PER_WEEK - 1) % DAYS_PER_WEEK
}

/**
 * Activity days as calendar weeks, oldest first, each running Monday to
 * Sunday (UTC dates, as the Provider reports them). A week where a new month
 * begins carries that month for the label row above the grid.
 */
export function activityWeeks(days: ProjectAgentActivityDay[]): ActivityWeek[] {
  const ordered = [...days].sort((left, right) => left.date.localeCompare(right.date))
  if (!ordered.length) return []
  const slots: Array<ProjectAgentActivityDay | null> = [
    ...Array.from({ length: weekdayFromMonday(ordered[0]!.date) }, () => null),
    ...ordered,
  ]
  const weeks: ActivityWeek[] = []
  for (let start = 0; start < slots.length; start += DAYS_PER_WEEK) {
    const week = slots.slice(start, start + DAYS_PER_WEEK)
    while (week.length < DAYS_PER_WEEK) week.push(null)
    const reported = week.filter((day): day is ProjectAgentActivityDay => day !== null)
    // The week holding a month's first day; the first week names the month the range starts in.
    const monthStart = reported.find((day) => day.date.endsWith('-01')) ?? (weeks.length ? undefined : reported[0])
    weeks.push({ key: reported[0]!.date, month: monthStart?.date.slice(0, 7) ?? '', days: week })
  }
  // Too close to the next label (the partial first month, say): no label.
  let nextLabel = Number.POSITIVE_INFINITY
  for (let index = weeks.length - 1; index >= 0; index -= 1) {
    if (!weeks[index]!.month) continue
    if (nextLabel - index < MIN_WEEKS_BETWEEN_MONTH_LABELS) weeks[index]!.month = ''
    else nextLabel = index
  }
  return weeks
}
