import { currentLocale } from '@/i18n'

// Totals from here on read as 12万 / 123K: five digits and a separator still fit a
// capsule, six start to crowd it. The current number stays exact.
const COMPACT_FROM = 100_000

export interface ListPositionText {
  /** The current number, grouped for the locale (1,284). */
  current: string
  /** The total, grouped, or compact once it is very large. */
  total: string
  /**
   * The widest the current number can get (the total written in full). The capsule
   * reserves this width so it never changes size while the number runs.
   */
  widest: string
}

/** "第 1,284 条，共 25,000 条" without zero padding; numerals are grouped per locale. */
export function listPositionText(current: number, total: number, locale: string = currentLocale()): ListPositionText {
  const grouped = new Intl.NumberFormat(locale)
  const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
  return {
    current: grouped.format(current),
    total: (total >= COMPACT_FROM ? compact : grouped).format(total),
    widest: grouped.format(total),
  }
}
