import { t } from '@/i18n'

// What is wrong with a settings field, in the page's language. The browser's
// own validation bubble is off-system, vanishes on the next click and follows
// the browser's language, so the page says it under the field instead.
type ValidatedField = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement

export function fieldErrorMessage(field: ValidatedField): string {
  const { validity } = field
  if (validity.valueMissing) return t('settings.fieldErrors.required')
  if (field instanceof HTMLInputElement && field.type === 'number') return t('settings.fieldErrors.range', { min: field.min, max: field.max })
  if (field instanceof HTMLInputElement && field.type === 'url' && validity.typeMismatch) return t('settings.fieldErrors.url')
  return t('settings.fieldErrors.invalid')
}
