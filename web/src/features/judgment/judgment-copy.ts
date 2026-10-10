import { currentLocale, i18n, t } from '@/i18n'

import { judgmentMessages } from '@/i18n/messages/judgment'

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
