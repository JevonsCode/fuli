import { t } from '@/i18n'

const TRANSLATION_KEY_PREFIXES = ['routes.', 'common.']

export function routeMetaText(value: unknown, fallbackKey = '') {
  const text = typeof value === 'string' && value ? value : fallbackKey
  return TRANSLATION_KEY_PREFIXES.some((prefix) => text.startsWith(prefix))
    ? t(text)
    : text
}

export function updateDocumentTitle(value: unknown) {
  if (typeof document === 'undefined') return
  const title = routeMetaText(value, 'routes.overview.title')
  document.title = `${title} · ${t('common.brand')}`
}
