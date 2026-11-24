import { currentLocale, t } from '@/i18n'
import { formatRelativeTime } from '@/lib/relative-time'
import type { LastProgress } from './work-freshness'

const JUST_NOW_MS = 60_000

/** The last recorded change in words: 最近进展 3 天前, 刚刚有进展, or 没有记下最近进展. */
export function lastProgressText(progress: LastProgress, now: number): string {
  if (!progress.at) return t('teamWork.progress.none')
  if (now - Date.parse(progress.at) < JUST_NOW_MS) return t('teamWork.progress.justNow')
  return t('teamWork.progress.at', { time: formatRelativeTime(progress.at, currentLocale(), now) ?? '' })
}
