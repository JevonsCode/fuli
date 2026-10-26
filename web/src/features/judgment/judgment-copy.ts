import { currentLocale, i18n, t } from '@/i18n'

import { judgmentMessages } from '@/i18n/messages/judgment'

import type { JudgmentPolicySelection } from './judgment-types'

function readPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (
    value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
  ), source)
}

export function judgmentText(path: string, fallback = '') {
  const key = `judgment.${path}`
  if (i18n.global.te(key)) return t(key)
  const localized = readPath(judgmentMessages[currentLocale()], path)
  return typeof localized === 'string' ? localized : fallback || key
}

// A policy in one line: mode · quality · client, each part it names.
export function policySummary(policy: Partial<JudgmentPolicySelection> | null | undefined) {
  if (!policy) return '—'
  return [
    policy.mode ? judgmentText(`mode.${policy.mode}`) : '',
    policy.quality ? judgmentText(`quality.${policy.quality}`) : '',
    policy.client ? judgmentText(`client.${policy.client}`) : '',
  ].filter(Boolean).join(' · ')
}
