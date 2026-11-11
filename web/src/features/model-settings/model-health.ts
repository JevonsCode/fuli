import { i18n, t } from '@/i18n'
import { formatRelativeTime } from '@/lib/relative-time'
import type { ModelRoleHealth } from './model'

// Whether a connection works now, in one line (src/model-backends/port.js
// health): its latest call answered, failed (with the reason in plain words),
// or it was never called. Cards, the connection list and the failure lines
// share these sentences.

/** A reason FULI knows reads as words; any other stays as the provider gave it. */
export function failureReason(reason: string | null | undefined): string {
  if (!reason) return t('modelSettings.check.reasons.unknown')
  const key = `modelSettings.check.reasons.${reason}`
  return i18n.global.te(key) ? t(key) : reason
}

export const isFailing = (health: ModelRoleHealth | null | undefined) => health?.status === 'failing'

export function healthLine(health: ModelRoleHealth | null | undefined, locale: string): string {
  if (!health || health.status === 'unknown') return t('modelSettings.health.unknown')
  const when = formatRelativeTime(health.at, locale) ?? ''
  return health.status === 'failing'
    ? t('modelSettings.health.failing', { reason: failureReason(health.reason), when })
    : t('modelSettings.health.ok', { when })
}

/** The health of a connection several roles use: a failure first, else the latest answer. */
export function latestHealth(all: readonly (ModelRoleHealth | null | undefined)[]): ModelRoleHealth | null {
  const known = all.filter((health): health is ModelRoleHealth => Boolean(health))
  const latest = (status: ModelRoleHealth['status']) => known.filter(health => health.status === status)
    .sort((left, right) => Date.parse(right.at ?? '') - Date.parse(left.at ?? ''))[0]
  return latest('failing') ?? latest('ok') ?? known[0] ?? null
}
