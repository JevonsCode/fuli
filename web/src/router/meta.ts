import { i18n, t } from '@/i18n'

export function routeMetaText(value: unknown, fallbackKey = '') {
  const text = typeof value === 'string' && value ? value : fallbackKey
  // Any catalog key is translated; plain legacy titles pass through unchanged.
  return text && i18n.global.te(text) ? t(text) : text
}

export function updateDocumentTitle(value: unknown) {
  if (typeof document === 'undefined') return
  const title = routeMetaText(value, 'routes.overview.title')
  document.title = `${title} · ${t('common.brand')}`
}
