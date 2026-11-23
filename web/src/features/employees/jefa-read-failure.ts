import { t } from '@/i18n'
import { DENIED_STATUSES } from './useJefaBoardLoad'

/** Why one project's board could not be read, in the person's words; `category` stays the machine value. */
export function jefaReadFailureReason(category: string): string {
  const status = Number(/^HTTP (\d{3})$/.exec(category)?.[1] ?? NaN)
  if (status === 404) return t('employees.read.reasons.notFound')
  if (DENIED_STATUSES.includes(status)) return t('employees.read.reasons.notAllowed')
  if (status >= 500) return t('employees.read.reasons.unavailable')
  if (category === 'TimeoutError' || category === 'AbortError') return t('employees.read.reasons.timeout')
  return t('employees.read.reasons.failed')
}
