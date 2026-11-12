import { i18n, t } from '@/i18n'
import { formatRelativeTime } from '@/lib/relative-time'
import type { ModelRoleHealth } from './model'

// Whether a connection works now, in one line (src/model-backends/port.js
// health): its latest call answered, failed (with the reason in plain words),
// or it was never called. Cards, the connection list and the failure lines
// share these sentences. A failure of the role's own call that is not about
// the connection (rec issue 122) says so: it is the role's task, not the connection.

/** A reason FULI knows reads as words; any other stays as the provider gave it. */
export function failureReason(reason: string | null | undefined): string {
  if (!reason) return t('modelSettings.check.reasons.unknown')
  const key = `modelSettings.check.reasons.${reason}`
  return i18n.global.te(key) ? t(key) : reason
}

export const isFailing = (health: ModelRoleHealth | null | undefined) => health?.status === 'failing'

const isRoleFailure = (health: ModelRoleHealth | null | undefined) => isFailing(health) && health?.scope === 'role'

/** The short state of a failing use: the connection does not answer, or the role's own task failed. */
export const failingState = (health: ModelRoleHealth | null | undefined) =>
  t(isRoleFailure(health) ? 'modelSettings.health.roleFailingState' : 'modelSettings.health.failingState')

export function healthLine(health: ModelRoleHealth | null | undefined, locale: string): string {
  if (!health || health.status === 'unknown') return t('modelSettings.health.unknown')
  const when = formatRelativeTime(health.at, locale) ?? ''
  if (health.status === 'ok') return t('modelSettings.health.ok', { when })
  return t(isRoleFailure(health) ? 'modelSettings.health.roleFailing' : 'modelSettings.health.failing',
    { reason: failureReason(health.reason), when })
}

/**
 * The health of a connection several roles use. What any of them says about
 * the connection itself is the same record, so the latest of those; without
 * one, a failure of any role first, else the latest answer.
 */
export function latestHealth(all: readonly (ModelRoleHealth | null | undefined)[]): ModelRoleHealth | null {
  const known = all.filter((health): health is ModelRoleHealth => Boolean(health))
  const newest = (list: ModelRoleHealth[]) => [...list].sort((left, right) => Date.parse(right.at ?? '') - Date.parse(left.at ?? ''))[0]
  const latest = (status: ModelRoleHealth['status']) => newest(known.filter(health => health.status === status))
  return newest(known.filter(health => health.scope === 'connection')) ?? latest('failing') ?? latest('ok') ?? known[0] ?? null
}
