import { currentLocale } from '@/i18n'

/** A section of the README in the console's language, for a section's 「?」 link. */
export function readmeHelpUrl(fragment: string) {
  const file = currentLocale() === 'zh-CN' ? 'README.zh-CN.md' : 'README.md'
  return `https://github.com/JevonsCode/fuli/blob/main/${file}#${fragment}`
}
